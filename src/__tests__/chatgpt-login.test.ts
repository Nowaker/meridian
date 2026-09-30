/**
 * Signing a ChatGPT seat into the owned store (chatgpt/login.ts): the
 * authorize URL, both ways a sign-in finishes, and every refusal that must
 * leave the store untouched.
 */
import { describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { createChatGptLogin, parseCallbackInput, type LoopbackHandler } from "../proxy/chatgpt/login"
import type { ChatGptConnectedAccount } from "../proxy/chatgpt/source"

const NOW = 1_800_000_000_000

function jwt(payload: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
  return `${part({ alg: "none" })}.${part(payload)}.sig`
}

const ACCESS = jwt({
  exp: NOW / 1000 + 3600,
  "https://api.openai.com/auth": { chatgpt_account_id: "ws-1", chatgpt_account_user_id: "user-1__ws-1", chatgpt_plan_type: "pro" },
})
const ID_TOKEN = jwt({ email: "seat@example.test" })

interface TokenCall { url: string; body: URLSearchParams }

function harness(tokenResponse: () => Response = () => Response.json({ access_token: ACCESS, refresh_token: "rt-new", id_token: ID_TOKEN, expires_in: 3600 })) {
  const connected: ChatGptConnectedAccount[] = []
  const tokenCalls: TokenCall[] = []
  let handler: LoopbackHandler | undefined
  let closed = 0
  const login = createChatGptLogin({
    connect: account => { connected.push(account) },
    renderPage: result => (result.ok ? `ok ${result.email} ${result.returnTo}` : `err ${result.message}`),
    fetchImpl: async (url, init) => {
      tokenCalls.push({ url, body: new URLSearchParams(String(init.body)) })
      return tokenResponse()
    },
    now: () => NOW,
    listen: async h => { handler = h; return { close: () => { closed++ } } },
    log: () => {},
  })
  return { login, connected, tokenCalls, callback: () => handler!, closed: () => closed }
}

describe("ChatGPT sign-in", () => {
  it("asks for the Codex client's scopes, PKCE S256 and its fixed loopback redirect", async () => {
    const { login } = harness()
    const started = await login.start()
    const url = new URL(started.authorizeUrl)
    expect(url.origin + url.pathname).toBe("https://auth.openai.com/oauth/authorize")
    expect(url.searchParams.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann")
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:1455/auth/callback")
    expect(url.searchParams.get("scope")).toBe("openid profile email offline_access")
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(url.searchParams.get("codex_cli_simplified_flow")).toBe("true")
    expect(url.searchParams.get("state")).toBeTruthy()
    expect(started.loopback).toBe(true)
  })

  it("finishes from the loopback redirect: exchanges the code with the verifier and files the seat", async () => {
    const { login, connected, tokenCalls, callback, closed } = harness()
    const started = await login.start({ returnTo: "https://meridian.example/profiles" })
    const state = new URL(started.authorizeUrl).searchParams.get("state")!
    const page = await callback()(new URLSearchParams({ code: "code-1", state }))

    expect(page.status).toBe(200)
    expect(page.html).toBe("ok seat@example.test https://meridian.example/profiles")
    expect(tokenCalls).toHaveLength(1)
    const body = tokenCalls[0]!.body
    expect(body.get("grant_type")).toBe("authorization_code")
    expect(body.get("code")).toBe("code-1")
    const challenge = new URL(started.authorizeUrl).searchParams.get("code_challenge")
    expect(createHash("sha256").update(body.get("code_verifier")!).digest("base64url")).toBe(challenge!)
    expect(connected).toEqual([{
      accountUserId: "user-1__ws-1", accountId: "ws-1", email: "seat@example.test",
      refreshToken: "rt-new", accessToken: ACCESS, expiresAt: NOW + 3_600_000,
    }])
    expect(login.status(started.connectId)).toEqual({ status: "completed", accountUserId: "user-1__ws-1", email: "seat@example.test" })
    // Nothing is waiting any more, so the redirect listener is closed.
    await Promise.resolve()
    expect(closed()).toBe(1)
  })

  it("finishes from a pasted callback address, and the code is spent only once", async () => {
    const { login, connected, tokenCalls } = harness()
    const started = await login.start()
    const state = new URL(started.authorizeUrl).searchParams.get("state")!
    const pasted = `http://localhost:1455/auth/callback?code=code-2&state=${state}`
    expect(await login.complete(started.connectId, pasted)).toEqual({ ok: true, accountUserId: "user-1__ws-1", email: "seat@example.test" })
    expect((await login.complete(started.connectId, pasted)).ok).toBe(false)
    expect(tokenCalls).toHaveLength(1)
    expect(connected).toHaveLength(1)
  })

  it("refuses an address from another sign-in without spending anything, and lets the paste be retried", async () => {
    const { login, connected, tokenCalls } = harness()
    const started = await login.start()
    const result = await login.complete(started.connectId, "http://localhost:1455/auth/callback?code=x&state=someone-else")
    expect(result).toMatchObject({ ok: false, code: "state_mismatch", retryable: true })
    expect(await login.complete(started.connectId, "not an address")).toMatchObject({ ok: false, code: "invalid_request", retryable: true })
    expect(tokenCalls).toHaveLength(0)
    expect(connected).toHaveLength(0)
    expect(login.status(started.connectId)?.status).toBe("waiting")
  })

  it("files nothing when the token endpoint refuses the code or answers without a refresh token", async () => {
    for (const answer of [
      () => new Response("{}", { status: 400 }),
      () => Response.json({ access_token: ACCESS, expires_in: 3600 }),
      () => Response.json({ access_token: "not-a-jwt", refresh_token: "rt", expires_in: 3600 }),
    ]) {
      const { login, connected } = harness(answer)
      const started = await login.start()
      const state = new URL(started.authorizeUrl).searchParams.get("state")!
      const result = await login.complete(started.connectId, `?code=c&state=${state}`)
      expect(result.ok).toBe(false)
      expect(connected).toHaveLength(0)
      expect(login.status(started.connectId)?.status).toBe("failed")
    }
  })

  it("reports a store that could not be written as a failed sign-in", async () => {
    const login = createChatGptLogin({
      connect: () => { throw new Error("no writer lease") },
      renderPage: () => "",
      fetchImpl: async () => Response.json({ access_token: ACCESS, refresh_token: "rt", expires_in: 3600 }),
      now: () => NOW,
      listen: async () => null,
      log: () => {},
    })
    const started = await login.start()
    expect(started.loopback).toBe(false)
    const state = new URL(started.authorizeUrl).searchParams.get("state")!
    expect(await login.complete(started.connectId, `?code=c&state=${state}`)).toMatchObject({ ok: false, code: "store_write_failed" })
  })

  it("answers a redirect for a sign-in it does not know without exchanging anything", async () => {
    const { login, tokenCalls, callback } = harness()
    await login.start()
    const page = await callback()(new URLSearchParams({ code: "c", state: "unknown" }))
    expect(page.status).toBe(400)
    expect(tokenCalls).toHaveLength(0)
  })

  it("reads code and state from a full address or a bare query", () => {
    expect(parseCallbackInput("http://localhost:1455/auth/callback?code=a&state=b")?.get("code")).toBe("a")
    expect(parseCallbackInput("code=a&state=b")?.get("state")).toBe("b")
    expect(parseCallbackInput("?error=access_denied")?.get("error")).toBe("access_denied")
    expect(parseCallbackInput("   ")).toBeNull()
    expect(parseCallbackInput("http://localhost:1455/auth/callback")).toBeNull()
  })
})
