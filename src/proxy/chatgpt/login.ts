/**
 * Signing a ChatGPT seat into Meridian's own store, from the web UI.
 *
 * The same OAuth authorization-code + PKCE flow the Codex CLI runs, with its
 * client id and its ONE registered redirect, `http://localhost:1455/auth/callback`.
 * That redirect is fixed by OpenAI, not chosen here, so while a sign-in is open
 * this process listens on 127.0.0.1:1455 and nowhere else, and stops listening
 * once no sign-in is waiting. A browser on another machine cannot reach that
 * loopback, so the address the browser lands on can also be pasted back into
 * the page: it carries the one-time code and the state that binds it to the
 * sign-in that asked for it.
 *
 * WHY THE SERVER, AND NOT A CLI. The store is written only under the writer
 * lease, and the running instance holds that lease for as long as it runs. A
 * separate login command could only write while the instance is stopped, and
 * one that wrote anyway would be the second writer this whole design forbids.
 *
 * Nothing here logs or returns a code, a verifier or a token. The exchange's
 * result goes straight into `connect`, which commits it under the lease.
 */

import { createHash, randomBytes } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { decodeCodexToken } from "../codex/token"
import { CHATGPT_OAUTH_CLIENT_ID, CHATGPT_TOKEN_URL, type TokenExchangeFetch } from "./refresh"
import type { ChatGptConnectedAccount } from "./source"

const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize"
export const CHATGPT_LOGIN_CALLBACK_PORT = 1455
export const CHATGPT_LOGIN_CALLBACK_PATH = "/auth/callback"
const REDIRECT_URI = `http://localhost:${CHATGPT_LOGIN_CALLBACK_PORT}${CHATGPT_LOGIN_CALLBACK_PATH}`
const SCOPE = "openid profile email offline_access"
const ORIGINATOR = "codex_cli_rs"
const LOGIN_TTL_MS = 10 * 60_000
const MAX_OPEN_LOGINS = 4
const EXCHANGE_TIMEOUT_MS = 15_000

export type ChatGptLoginState =
  | { status: "waiting"; expiresAt: number }
  | { status: "exchanging"; expiresAt: number }
  | { status: "completed"; accountUserId: string; email: string | null }
  | { status: "failed"; message: string }

export type ChatGptLoginCompletion =
  | { ok: true; accountUserId: string; email: string | null }
  | { ok: false; status: number; code: string; message: string; retryable?: boolean }

export interface ChatGptLoginStart {
  connectId: string
  authorizeUrl: string
  /** Whether this process is listening for the redirect; false means the address must be pasted back. */
  loopback: boolean
  expiresAt: number
}

/** A started loopback listener. */
export interface LoopbackListener {
  close(): void
}

export type LoopbackHandler = (query: URLSearchParams) => Promise<{ status: number; html: string }>

export interface ChatGptLoginOptions {
  /** Commits the seat under the writer lease; throws when that is impossible. */
  connect(account: ChatGptConnectedAccount): void
  /** Renders the page the loopback redirect lands on. */
  renderPage(result: { ok: true; email: string | null; returnTo: string | null } | { ok: false; message: string; returnTo: string | null }): string
  fetchImpl?: TokenExchangeFetch
  now?: () => number
  /** Binds the redirect listener. Resolves null when the port cannot be bound. */
  listen?: (handler: LoopbackHandler) => Promise<LoopbackListener | null>
  log?: (line: string) => void
}

export interface ChatGptLogin {
  start(options?: { returnTo?: string | null }): Promise<ChatGptLoginStart>
  status(connectId: string): ChatGptLoginState | undefined
  /** Finish from the address the browser landed on, pasted into the page. */
  complete(connectId: string, pasted: string): Promise<ChatGptLoginCompletion>
  close(): void
}

interface PendingLogin {
  id: string
  state: string
  verifier: string
  expiresAt: number
  returnTo: string | null
  outcome: ChatGptLoginState
}

function base64url(bytes: Buffer): string {
  return bytes.toString("base64url")
}

/** The listener the real server uses: loopback only, and only the callback path. */
export function listenOnLoopback(handler: LoopbackHandler): Promise<LoopbackListener | null> {
  return new Promise(resolve => {
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      const url = new URL(request.url ?? "/", "http://localhost")
      if (request.method !== "GET" || url.pathname !== CHATGPT_LOGIN_CALLBACK_PATH) {
        response.writeHead(404, { "content-type": "text/plain" }).end("Not found")
        return
      }
      handler(url.searchParams).then(
        page => { response.writeHead(page.status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(page.html) },
        (error: unknown) => {
          console.error("[chatgpt] sign-in callback failed:", (error as Error).message)
          response.writeHead(500, { "content-type": "text/plain" }).end("Sign-in failed")
        },
      )
    })
    server.once("error", (error: Error) => {
      console.error(`[chatgpt] cannot listen for the sign-in redirect on 127.0.0.1:${CHATGPT_LOGIN_CALLBACK_PORT} (${(error as NodeJS.ErrnoException).code ?? error.message}); the address must be pasted back`)
      resolve(null)
    })
    server.listen(CHATGPT_LOGIN_CALLBACK_PORT, "127.0.0.1", () => {
      server.unref()
      resolve({ close: () => { server.close() } })
    })
  })
}

/** The `code` and `state` from a pasted callback address, or from its query string alone. */
export function parseCallbackInput(pasted: string): URLSearchParams | null {
  const text = pasted.trim()
  if (!text) return null
  let query: URLSearchParams
  try {
    query = text.includes("://") ? new URL(text).searchParams : new URLSearchParams(text.replace(/^[^?]*\?/, ""))
  } catch {
    return null
  }
  return query.has("code") || query.has("error") ? query : null
}

function emailFrom(idToken: string | undefined, accessToken: string): string | null {
  for (const token of [idToken, accessToken]) {
    const payload = token?.split(".")[1]
    if (!payload) continue
    try {
      const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>
      const profile = claims["https://api.openai.com/profile"] as Record<string, unknown> | undefined
      const email = typeof claims.email === "string" ? claims.email : profile?.email
      if (typeof email === "string" && email) return email
    } catch {
      continue
    }
  }
  return null
}

let listenOverride: ((handler: LoopbackHandler) => Promise<LoopbackListener | null>) | null = null

/** Tests only: stand in for the real 127.0.0.1:1455 listener, which a test must never bind. */
export function __setChatGptLoginListenOverride(listen: typeof listenOverride): void {
  listenOverride = listen
}

export function createChatGptLogin(options: ChatGptLoginOptions): ChatGptLogin {
  const now = options.now ?? Date.now
  const exchangeFetch: TokenExchangeFetch = options.fetchImpl ?? ((url, init) => fetch(url, init))
  const listen = options.listen ?? ((handler: LoopbackHandler) => (listenOverride ?? listenOnLoopback)(handler))
  const log = options.log ?? ((line: string) => console.log(line))
  const logins = new Map<string, PendingLogin>()
  let listener: Promise<LoopbackListener | null> | undefined

  const waiting = (login: PendingLogin) => login.outcome.status === "waiting" || login.outcome.status === "exchanging"

  const sweep = () => {
    const at = now()
    for (const [id, login] of logins) {
      if (waiting(login) && login.expiresAt <= at) login.outcome = { status: "failed", message: "This sign-in expired. Start it again." }
      // A finished login is kept long enough for the page's poll to read it.
      if (!waiting(login) && login.expiresAt + LOGIN_TTL_MS <= at) logins.delete(id)
    }
    if (listener && ![...logins.values()].some(waiting)) {
      const closing = listener
      listener = undefined
      void closing.then(open => open?.close())
    }
  }

  const exchange = async (login: PendingLogin, code: string): Promise<ChatGptLoginCompletion> => {
    login.outcome = { status: "exchanging", expiresAt: login.expiresAt }
    const fail = (status: number, codeName: string, message: string): ChatGptLoginCompletion => {
      login.outcome = { status: "failed", message }
      log(`[chatgpt] sign-in failed: ${codeName}`)
      return { ok: false, status, code: codeName, message }
    }
    let response: Response
    try {
      response = await exchangeFetch(CHATGPT_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: REDIRECT_URI,
          client_id: CHATGPT_OAUTH_CLIENT_ID,
          code_verifier: login.verifier,
        }).toString(),
        redirect: "error",
        signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
      })
    } catch {
      return fail(502, "exchange_unreachable", "Could not reach auth.openai.com to finish the sign-in. Start it again.")
    }
    let body: Record<string, unknown> | undefined
    try {
      const parsed: unknown = await response.json()
      body = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined
    } catch {
      body = undefined
    }
    if (!response.ok) return fail(400, "exchange_refused", `ChatGPT refused the sign-in code (HTTP ${response.status}). Start the sign-in again.`)
    const accessToken = typeof body?.access_token === "string" ? body.access_token : ""
    const refreshToken = typeof body?.refresh_token === "string" ? body.refresh_token : ""
    const idToken = typeof body?.id_token === "string" ? body.id_token : undefined
    if (!accessToken || !refreshToken) return fail(502, "exchange_incomplete", "ChatGPT's answer carried no refresh token, so Meridian could not keep this seat signed in.")
    const claims = decodeCodexToken(accessToken)
    const idClaims = decodeCodexToken(idToken)
    const accountUserId = claims?.accountUserId ?? idClaims?.accountUserId
    const accountId = claims?.accountId ?? idClaims?.accountId
    if (!accountUserId || !accountId) return fail(502, "no_chatgpt_seat", "This sign-in carries no ChatGPT workspace seat. Sign in with an account that has a ChatGPT plan.")
    const expiresIn = typeof body?.expires_in === "number" && Number.isFinite(body.expires_in) ? body.expires_in : null
    const email = emailFrom(idToken, accessToken)
    try {
      options.connect({
        accountUserId,
        accountId,
        email,
        refreshToken,
        accessToken,
        expiresAt: claims?.expiresAt ?? (expiresIn === null ? null : now() + expiresIn * 1000),
      })
    } catch (error) {
      console.error("[chatgpt] could not save a signed-in seat:", (error as Error).message)
      return fail(500, "store_write_failed", `Meridian could not save the sign-in: ${(error as Error).message}`)
    }
    login.outcome = { status: "completed", accountUserId, email }
    log(`[chatgpt] account ${accountUserId} signed in${email ? ` as ${email}` : ""}`)
    return { ok: true, accountUserId, email }
  }

  const finish = async (login: PendingLogin, query: URLSearchParams): Promise<ChatGptLoginCompletion> => {
    if (login.outcome.status !== "waiting") {
      return { ok: false, status: 409, code: "already_used", message: "This sign-in has already been finished or has failed. Start it again." }
    }
    const error = query.get("error")
    if (error) {
      login.outcome = { status: "failed", message: `ChatGPT did not complete the sign-in (${error}). Start it again.` }
      return { ok: false, status: 400, code: "authorization_denied", message: login.outcome.message }
    }
    const code = query.get("code")
    if (!code) return { ok: false, status: 400, code: "invalid_request", message: "That address carries no sign-in code.", retryable: true }
    return exchange(login, code)
  }

  const handleCallback: LoopbackHandler = async query => {
    sweep()
    const state = query.get("state")
    const login = state ? [...logins.values()].find(entry => entry.state === state) : undefined
    if (!login) {
      return { status: 400, html: options.renderPage({ ok: false, message: "This sign-in is not open any more. Start it again from Meridian's Profiles page.", returnTo: null }) }
    }
    const result = await finish(login, query)
    sweep()
    return result.ok
      ? { status: 200, html: options.renderPage({ ok: true, email: result.email, returnTo: login.returnTo }) }
      : { status: result.status, html: options.renderPage({ ok: false, message: result.message, returnTo: login.returnTo }) }
  }

  return {
    async start(startOptions) {
      sweep()
      const open = [...logins.values()].filter(waiting)
      for (const stale of open.slice(0, Math.max(0, open.length - MAX_OPEN_LOGINS + 1))) {
        stale.outcome = { status: "failed", message: "A newer sign-in replaced this one." }
      }
      const verifier = base64url(randomBytes(32))
      const login: PendingLogin = {
        id: base64url(randomBytes(16)),
        state: base64url(randomBytes(32)),
        verifier,
        expiresAt: now() + LOGIN_TTL_MS,
        returnTo: startOptions?.returnTo ?? null,
        outcome: { status: "waiting", expiresAt: 0 },
      }
      login.outcome = { status: "waiting", expiresAt: login.expiresAt }
      logins.set(login.id, login)
      listener ??= listen(handleCallback)
      const loopback = (await listener) !== null
      if (!loopback) listener = undefined
      const authorize = new URL(AUTHORIZE_URL)
      authorize.search = new URLSearchParams({
        response_type: "code",
        client_id: CHATGPT_OAUTH_CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        scope: SCOPE,
        code_challenge: base64url(createHash("sha256").update(verifier).digest()),
        code_challenge_method: "S256",
        id_token_add_organizations: "true",
        codex_cli_simplified_flow: "true",
        state: login.state,
        originator: ORIGINATOR,
      }).toString()
      return { connectId: login.id, authorizeUrl: authorize.toString(), loopback, expiresAt: login.expiresAt }
    },

    status(connectId) {
      sweep()
      return logins.get(connectId)?.outcome
    },

    async complete(connectId, pasted) {
      sweep()
      const login = logins.get(connectId)
      if (!login) return { ok: false, status: 410, code: "expired_login", message: "This sign-in is no longer open. Start it again." }
      const query = parseCallbackInput(pasted)
      if (!query) {
        return { ok: false, status: 400, code: "invalid_request", message: "Paste the whole address the sign-in tab ended on (it starts with http://localhost:1455/auth/callback?code=).", retryable: true }
      }
      if (query.get("state") !== login.state) {
        return { ok: false, status: 400, code: "state_mismatch", message: "That address belongs to a different sign-in. Paste the one from the tab this sign-in opened.", retryable: true }
      }
      const result = await finish(login, query)
      sweep()
      return result
    },

    close() {
      logins.clear()
      const closing = listener
      listener = undefined
      void closing?.then(open => open?.close())
    },
  }
}
