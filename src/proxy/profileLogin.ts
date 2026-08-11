/**
 * Browser-completable OAuth login for claude-max profiles.
 *
 * Backs `POST /profiles/login/start` and `POST /profiles/login/complete`, so
 * re-authenticating an account does not require a terminal on the box Meridian
 * runs on. The browser gets an opaque login id and the authorize URL; the PKCE
 * verifier stays here.
 *
 * Why the user pastes a code instead of being redirected back: Anthropic's
 * client id has exactly one registered redirect URI —
 * `https://platform.claude.com/oauth/code/callback`, a page Anthropic hosts.
 * There is no `http://localhost:<port>/callback` variant registered, and a
 * redirect_uri Meridian controls would be rejected at the authorize step. So
 * the callback page shows the user a code, and they bring it back here.
 * `parseAuthorizationCodeInput` accepts that page's whole URL as well as a bare
 * code, which is the closest thing to an automatic hand-off available.
 *
 * This is a leaf module — no imports from server.ts or session/.
 */

import { randomBytes } from "node:crypto"
import { envBool } from "../env"
import {
  createManualOAuthSession,
  exchangeAuthorizationCodeForCredentials,
  parseAuthorizationCodeInput,
  profileConfigDirFor,
} from "./profileCli"
import { getEffectiveProfiles, resolveProfile, type ProfileConfig } from "./profiles"

/**
 * How long a started login stays completable.
 *
 * Bounded because an unfinished login holds a PKCE verifier and a `state` this
 * process would otherwise accept forever. Ten minutes covers a human signing
 * in — including a password manager and a 2FA prompt — and Anthropic's
 * authorization code expires well before it anyway.
 */
export const LOGIN_TTL_MS = 10 * 60_000

interface PendingLogin {
  profileId: string
  claudeConfigDir: string
  codeVerifier: string
  state: string
  expiresAt: number
}

/**
 * Started-but-unfinished logins, keyed by the opaque id handed to the browser.
 *
 * Server-side because the verifier is half of the PKCE proof: sending it to the
 * browser would put both halves in one place that is not the one that started
 * the flow. Two logins for different profiles are two entries and cannot
 * interfere — each carries its own verifier, state and target directory.
 */
const pendingLogins = new Map<string, PendingLogin>()

export type LoginErrorCode =
  | "credentials_readonly"
  | "no_profiles"
  | "unknown_profile"
  | "unsupported_profile_type"
  | "invalid_request"
  | "expired_login"
  | "no_code"
  | "state_mismatch"
  | "exchange_failed"
  | "write_failed"

export interface LoginFailure {
  ok: false
  code: LoginErrorCode
  status: number
  message: string
  /**
   * The login is still open — paste again, no second sign-in.
   *
   * Set exactly when the paste was rejected locally, before any code reached
   * Anthropic. The client reads this instead of matching on `code`, because
   * only this module knows whether the session survived the attempt; a client
   * re-deriving it from the code list would drift the moment a code is added.
   */
  retryable?: boolean
}

export interface StartLoginSuccess {
  ok: true
  profileId: string
  loginId: string
  authorizeUrl: string
  expiresAt: number
}

export interface CompleteLoginSuccess {
  ok: true
  profileId: string
}

export interface StartLoginParams {
  profiles: ProfileConfig[] | undefined
  profileId: string
  now?: number
}

export interface CompleteLoginParams {
  loginId: string
  input: string
  now?: number
  fetchFn?: typeof fetch
}

function prune(now: number): void {
  for (const [id, login] of pendingLogins) {
    if (login.expiresAt <= now) pendingLogins.delete(id)
  }
}

/**
 * Refuse when this instance must not write credential files.
 *
 * `MERIDIAN_CREDENTIALS_READONLY=1` marks an instance that shares another
 * instance's credential files — a development build beside a production one.
 * Such an instance can still serve this page, so the button is there to be
 * clicked; refusing at the START is the whole point. A user who signs in and is
 * refused afterwards has burned a one-time authorization code for nothing.
 */
function readonlyRefusal(profileId: string): LoginFailure | null {
  if (!envBool("CREDENTIALS_READONLY")) return null
  return {
    ok: false,
    code: "credentials_readonly",
    status: 409,
    message:
      "This Meridian instance runs with MERIDIAN_CREDENTIALS_READONLY=1 and must not write credential files, "
      + "so it cannot complete a login. Use the instance that owns these credentials, "
      + `or a terminal on the box that holds them: meridian profile login ${profileId}`,
  }
}

/**
 * Create a login: resolve the profile, mint PKCE, and return the authorize URL
 * with an opaque id. Every refusal happens here, before the user is sent to
 * Anthropic to sign in.
 */
export function startProfileLogin(params: StartLoginParams): StartLoginSuccess | LoginFailure {
  const now = params.now ?? Date.now()
  const profileId = params.profileId.trim()
  if (!profileId) {
    return { ok: false, code: "invalid_request", status: 400, message: "Missing 'profile' in request body" }
  }

  const readonly = readonlyRefusal(profileId)
  if (readonly) return readonly

  const effective = getEffectiveProfiles(params.profiles)
  if (effective.length === 0) {
    return { ok: false, code: "no_profiles", status: 400, message: "No profiles configured" }
  }

  // Unknown ids are refused rather than created. `meridian profile add` is the
  // one place a profile comes into existence, and this surface is reachable by
  // anyone who can reach the page — creating an account slot from it is a
  // different decision than re-authenticating one that exists.
  if (!effective.some(p => p.id === profileId)) {
    return {
      ok: false,
      code: "unknown_profile",
      status: 404,
      message: `Unknown profile: ${profileId}. Available: ${effective.map(p => p.id).join(", ")}`,
    }
  }

  // Reuse the request-path resolver so the type inference and the config-dir
  // choice are the ones every request already gets, not a second reading of
  // the same fields.
  const resolved = resolveProfile(params.profiles, undefined, profileId)
  if (resolved.type !== "claude-max") {
    return {
      ok: false,
      code: "unsupported_profile_type",
      status: 400,
      message: `Profile "${profileId}" is an ${resolved.type} profile, which has no OAuth login flow. `
        + (resolved.type === "oauth-token"
          ? `Replace its token instead: meridian profile remove ${profileId} && meridian profile add ${profileId} --oauth-token`
          : "Edit its API key in ~/.config/meridian/profiles.json instead."),
    }
  }

  const session = createManualOAuthSession()
  const loginId = randomBytes(16).toString("base64url")
  const expiresAt = now + LOGIN_TTL_MS
  prune(now)
  pendingLogins.set(loginId, {
    profileId,
    claudeConfigDir: resolved.env.CLAUDE_CONFIG_DIR ?? profileConfigDirFor(profileId),
    codeVerifier: session.codeVerifier,
    state: session.state,
    expiresAt,
  })

  return { ok: true, profileId, loginId, authorizeUrl: session.authorizeUrl, expiresAt }
}

/**
 * Finish a login from what the user pasted — a bare code, or the whole callback
 * URL from the browser's address bar.
 */
export async function completeProfileLogin(params: CompleteLoginParams): Promise<CompleteLoginSuccess | LoginFailure> {
  const now = params.now ?? Date.now()
  prune(now)

  const pending = pendingLogins.get(params.loginId)
  if (!pending) {
    return {
      ok: false,
      code: "expired_login",
      status: 410,
      message: "This login is no longer open — it expired, or it was already completed. Start it again.",
    }
  }

  // Parsed before the session is consumed: a mistyped paste should not force
  // the user back through Anthropic's sign-in. The session is single-use from
  // the moment a code is actually sent, which is the exchange below.
  const parsed = parseAuthorizationCodeInput(params.input)
  if (!parsed) {
    return {
      ok: false,
      code: "no_code",
      status: 400,
      message: "No authorization code found in that paste. Paste the code Claude showed you, or the whole callback URL.",
      retryable: true,
    }
  }

  // Consumed BEFORE the exchange, not after: deleting first is what makes
  // single-use hold against two completions racing the same login id.
  pendingLogins.delete(params.loginId)

  const result = await exchangeAuthorizationCodeForCredentials({
    code: parsed.code,
    returnedState: parsed.state,
    sessionState: pending.state,
    codeVerifier: pending.codeVerifier,
    claudeConfigDir: pending.claudeConfigDir,
    fetchFn: params.fetchFn,
  })

  if (result.ok) return { ok: true, profileId: pending.profileId }

  if (result.reason === "state_mismatch") {
    // Rejected locally — the code never reached Anthropic, so nothing was
    // spent and this login is still good. Put it back: pasting the wrong
    // browser tab should cost a second paste, not a second sign-in.
    pendingLogins.set(params.loginId, pending)
    return {
      ok: false,
      code: "state_mismatch",
      status: 400,
      message: "OAuth state did not match this login. Paste the code from the tab this login opened.",
      retryable: true,
    }
  }
  if (result.reason === "write_failed") {
    return {
      ok: false,
      code: "write_failed",
      status: 500,
      message: `Signed in, but the credentials for "${pending.profileId}" could not be written.`,
    }
  }
  // The token endpoint's own error body is deliberately not forwarded — it is
  // one-time-credential-adjacent and belongs nowhere near a rendered page.
  return {
    ok: false,
    code: "exchange_failed",
    status: 502,
    message: result.status
      ? `Anthropic rejected the authorization code (HTTP ${result.status}). Codes expire quickly — start the login again.`
      : "Could not reach Anthropic to exchange the authorization code. Start the login again.",
  }
}

export function pendingLoginCount(): number {
  return pendingLogins.size
}

/** Drop all pending logins — for testing only. */
export function resetPendingLogins(): void {
  pendingLogins.clear()
}
