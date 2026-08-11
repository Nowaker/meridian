import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  LOGIN_TTL_MS,
  completeProfileLogin,
  pendingLoginCount,
  resetPendingLogins,
  startProfileLogin,
} from "../proxy/profileLogin"
import type { ProfileConfig } from "../proxy/profiles"

const TOKEN_RESPONSE = {
  access_token: "web-login-access-token",
  refresh_token: "web-login-refresh-token",
  expires_in: 3600,
  scope: "user:inference user:profile",
}

interface TokenRequest {
  code?: string
  state?: string
  code_verifier?: string
  redirect_uri?: string
  grant_type?: string
}

/** Records the token requests it is handed, so tests can assert what was sent
 *  (and, for the failure paths, that nothing was sent at all). */
function stubTokenFetch(makeResponse: () => Response) {
  const requests: TokenRequest[] = []
  const fetchFn: typeof fetch = Object.assign(
    async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      requests.push(JSON.parse(String(init?.body ?? "{}")) as TokenRequest)
      return makeResponse()
    },
    { preconnect: globalThis.fetch.preconnect },
  )
  return { fetchFn, requests }
}

function okTokenFetch() {
  return stubTokenFetch(() => new Response(JSON.stringify(TOKEN_RESPONSE), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  }))
}

function credentialsAt(dir: string): { accessToken: string; refreshToken: string; scopes: string[] } {
  return JSON.parse(readFileSync(join(dir, ".credentials.json"), "utf-8")).claudeAiOauth
}

// Credential writes go to the Keychain on darwin, so the assertions that read a
// .credentials.json file (and any path that writes at all) are Linux/Windows
// only — same reason profile-token-refresh-route.test.ts skips there.
const skipOnDarwin = process.platform === "darwin"

describe("profileLogin", () => {
  let tempDir: string
  let profiles: ProfileConfig[]

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "meridian-web-login-"))
    mkdirSync(join(tempDir, "personal"), { recursive: true })
    mkdirSync(join(tempDir, "work"), { recursive: true })
    profiles = [
      { id: "personal", claudeConfigDir: join(tempDir, "personal") },
      { id: "work", claudeConfigDir: join(tempDir, "work") },
      { id: "ci", type: "oauth-token", oauthToken: "sk-ant-oat01-test" },
      { id: "direct", type: "api", apiKey: "sk-ant-api-test" },
    ]
    resetPendingLogins()
    delete process.env.MERIDIAN_CREDENTIALS_READONLY
    delete process.env.CLAUDE_PROXY_CREDENTIALS_READONLY
  })

  afterEach(() => {
    resetPendingLogins()
    delete process.env.MERIDIAN_CREDENTIALS_READONLY
    delete process.env.CLAUDE_PROXY_CREDENTIALS_READONLY
    rmSync(tempDir, { recursive: true, force: true })
  })

  describe("startProfileLogin", () => {
    it("returns an authorize URL and an opaque login id, and never the PKCE verifier", () => {
      const result = startProfileLogin({ profiles, profileId: "personal" })
      if (!result.ok) throw new Error(`expected success, got ${result.code}`)

      expect(result.profileId).toBe("personal")
      expect(result.loginId.length).toBeGreaterThan(16)
      expect(result.expiresAt).toBeGreaterThan(Date.now())

      const url = new URL(result.authorizeUrl)
      expect(url.origin + url.pathname).toBe("https://claude.com/cai/oauth/authorize")
      expect(url.searchParams.get("code_challenge_method")).toBe("S256")
      expect(url.searchParams.get("code_challenge")).toBeTruthy()
      expect(url.searchParams.get("state")).toBeTruthy()
      expect(url.searchParams.get("redirect_uri")).toBe("https://platform.claude.com/oauth/code/callback")

      // The whole point of the server-side map: neither half of the PKCE pair
      // that the browser must not hold may appear in the response.
      const serialized = JSON.stringify(result)
      expect(serialized).not.toContain("codeVerifier")
      expect(serialized).not.toContain("code_verifier")
      expect(pendingLoginCount()).toBe(1)
    })

    it("refuses an unknown profile instead of creating one", () => {
      const result = startProfileLogin({ profiles, profileId: "nope" })
      expect(result).toMatchObject({ ok: false, code: "unknown_profile", status: 404 })
      if (result.ok) throw new Error("expected refusal")
      expect(result.message).toContain("personal")
      expect(pendingLoginCount()).toBe(0)
    })

    it("refuses when no profiles are configured", () => {
      const result = startProfileLogin({ profiles: [], profileId: "personal" })
      expect(result).toMatchObject({ ok: false, code: "no_profiles", status: 400 })
    })

    it("refuses a blank profile id", () => {
      const result = startProfileLogin({ profiles, profileId: "  " })
      expect(result).toMatchObject({ ok: false, code: "invalid_request", status: 400 })
    })

    it("refuses an oauth-token profile and names the replacement path", () => {
      const result = startProfileLogin({ profiles, profileId: "ci" })
      expect(result).toMatchObject({ ok: false, code: "unsupported_profile_type", status: 400 })
      if (result.ok) throw new Error("expected refusal")
      expect(result.message).toContain("oauth-token")
      expect(result.message).toContain("--oauth-token")
      expect(pendingLoginCount()).toBe(0)
    })

    it("refuses an api profile", () => {
      const result = startProfileLogin({ profiles, profileId: "direct" })
      expect(result).toMatchObject({ ok: false, code: "unsupported_profile_type", status: 400 })
      if (result.ok) throw new Error("expected refusal")
      expect(result.message).toContain("api")
    })

    it("refuses on a read-only instance before any login is started", () => {
      process.env.MERIDIAN_CREDENTIALS_READONLY = "1"
      const result = startProfileLogin({ profiles, profileId: "personal" })
      expect(result).toMatchObject({ ok: false, code: "credentials_readonly", status: 409 })
      if (result.ok) throw new Error("expected refusal")
      expect(result.message).toContain("MERIDIAN_CREDENTIALS_READONLY")
      expect(result.message).toContain("meridian profile login personal")
      // Nothing was minted, so no authorization code can be burned against it.
      expect(pendingLoginCount()).toBe(0)
    })

    it("honours the legacy CLAUDE_PROXY_ alias for the read-only flag", () => {
      process.env.CLAUDE_PROXY_CREDENTIALS_READONLY = "1"
      expect(startProfileLogin({ profiles, profileId: "personal" })).toMatchObject({
        ok: false,
        code: "credentials_readonly",
      })
    })

    it("keeps two logins for different profiles independent", () => {
      const first = startProfileLogin({ profiles, profileId: "personal" })
      const second = startProfileLogin({ profiles, profileId: "work" })
      if (!first.ok || !second.ok) throw new Error("expected both to start")

      expect(first.loginId).not.toBe(second.loginId)
      expect(new URL(first.authorizeUrl).searchParams.get("state"))
        .not.toBe(new URL(second.authorizeUrl).searchParams.get("state"))
      expect(pendingLoginCount()).toBe(2)
    })
  })

  describe("completeProfileLogin", () => {
    it("rejects an unknown login id", async () => {
      const { fetchFn, requests } = okTokenFetch()
      const result = await completeProfileLogin({ loginId: "never-issued", input: "abc123", fetchFn })
      expect(result).toMatchObject({ ok: false, code: "expired_login", status: 410 })
      expect(requests).toHaveLength(0)
    })

    it("rejects a login past its TTL", async () => {
      const started = startProfileLogin({ profiles, profileId: "personal" })
      if (!started.ok) throw new Error("expected success")

      const { fetchFn, requests } = okTokenFetch()
      const result = await completeProfileLogin({
        loginId: started.loginId,
        input: "abc123",
        now: Date.now() + LOGIN_TTL_MS + 1,
        fetchFn,
      })
      expect(result).toMatchObject({ ok: false, code: "expired_login", status: 410 })
      expect(requests).toHaveLength(0)
      expect(pendingLoginCount()).toBe(0)
    })

    it("rejects a state that does not match the login, without sending the code", async () => {
      const started = startProfileLogin({ profiles, profileId: "personal" })
      if (!started.ok) throw new Error("expected success")

      const { fetchFn, requests } = okTokenFetch()
      const result = await completeProfileLogin({
        loginId: started.loginId,
        input: "https://platform.claude.com/oauth/code/callback?code=abc123&state=not-my-state",
        fetchFn,
      })
      expect(result).toMatchObject({ ok: false, code: "state_mismatch", status: 400, retryable: true })
      expect(requests).toHaveLength(0)
      expect(existsSync(join(tempDir, "personal", ".credentials.json"))).toBe(false)
      // Nothing was spent, so the login survives — see the next test.
      expect(pendingLoginCount()).toBe(1)
    })

    it.skipIf(skipOnDarwin)("still accepts the right paste after a state mismatch", async () => {
      const started = startProfileLogin({ profiles, profileId: "personal" })
      if (!started.ok) throw new Error("expected success")
      const state = new URL(started.authorizeUrl).searchParams.get("state")

      const { fetchFn, requests } = okTokenFetch()
      const wrongTab = await completeProfileLogin({
        loginId: started.loginId,
        input: "https://platform.claude.com/oauth/code/callback?code=other-flow&state=not-my-state",
        fetchFn,
      })
      expect(wrongTab).toMatchObject({ ok: false, code: "state_mismatch" })

      const rightTab = await completeProfileLogin({
        loginId: started.loginId,
        input: `https://platform.claude.com/oauth/code/callback?code=real-code&state=${state}`,
        fetchFn,
      })
      expect(rightTab).toMatchObject({ ok: true, profileId: "personal" })
      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({ code: "real-code" })
      expect(pendingLoginCount()).toBe(0)
    })

    it("keeps the login open when the paste carries no code", async () => {
      const started = startProfileLogin({ profiles, profileId: "personal" })
      if (!started.ok) throw new Error("expected success")

      const { fetchFn, requests } = okTokenFetch()
      const result = await completeProfileLogin({ loginId: started.loginId, input: "   ", fetchFn })
      expect(result).toMatchObject({ ok: false, code: "no_code", status: 400, retryable: true })
      expect(requests).toHaveLength(0)
      // A mistyped paste must not cost the user another trip through sign-in.
      expect(pendingLoginCount()).toBe(1)
    })

    it("reports an upstream rejection without echoing the token endpoint's body", async () => {
      const started = startProfileLogin({ profiles, profileId: "personal" })
      if (!started.ok) throw new Error("expected success")

      const { fetchFn } = stubTokenFetch(() => new Response(
        JSON.stringify({ error: "invalid_grant", error_description: "code already redeemed" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ))
      const result = await completeProfileLogin({ loginId: started.loginId, input: "expired-code", fetchFn })
      expect(result).toMatchObject({ ok: false, code: "exchange_failed", status: 502 })
      if (result.ok) throw new Error("expected refusal")
      // The code reached Anthropic and is spent — never invite a retry with it.
      expect(result.retryable).toBeUndefined()
      expect(pendingLoginCount()).toBe(0)
      expect(result.message).toContain("400")
      expect(result.message).not.toContain("invalid_grant")
      expect(result.message).not.toContain("already redeemed")
    })

    it("reports a transport failure", async () => {
      const started = startProfileLogin({ profiles, profileId: "personal" })
      if (!started.ok) throw new Error("expected success")

      const fetchFn: typeof fetch = Object.assign(
        async () => { throw new Error("getaddrinfo ENOTFOUND platform.claude.com") },
        { preconnect: globalThis.fetch.preconnect },
      )
      const result = await completeProfileLogin({ loginId: started.loginId, input: "abc123", fetchFn })
      expect(result).toMatchObject({ ok: false, code: "exchange_failed", status: 502 })
    })

    it.skipIf(skipOnDarwin)("accepts a bare code and writes the profile's credentials", async () => {
      const started = startProfileLogin({ profiles, profileId: "personal" })
      if (!started.ok) throw new Error("expected success")

      const { fetchFn, requests } = okTokenFetch()
      const result = await completeProfileLogin({ loginId: started.loginId, input: "  abc123  ", fetchFn })
      expect(result).toMatchObject({ ok: true, profileId: "personal" })

      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({
        grant_type: "authorization_code",
        code: "abc123",
        redirect_uri: "https://platform.claude.com/oauth/code/callback",
      })

      const stored = credentialsAt(join(tempDir, "personal"))
      expect(stored.accessToken).toBe("web-login-access-token")
      expect(stored.refreshToken).toBe("web-login-refresh-token")
      expect(stored.scopes).toEqual(["user:inference", "user:profile"])
      expect(existsSync(join(tempDir, "work", ".credentials.json"))).toBe(false)
    })

    it.skipIf(skipOnDarwin)("accepts the whole callback URL, matching its state", async () => {
      const started = startProfileLogin({ profiles, profileId: "work" })
      if (!started.ok) throw new Error("expected success")
      const state = new URL(started.authorizeUrl).searchParams.get("state")

      const { fetchFn, requests } = okTokenFetch()
      const result = await completeProfileLogin({
        loginId: started.loginId,
        input: `https://platform.claude.com/oauth/code/callback?code=url-code&state=${state}`,
        fetchFn,
      })
      expect(result).toMatchObject({ ok: true, profileId: "work" })
      expect(requests[0]).toMatchObject({ code: "url-code", state })
      expect(credentialsAt(join(tempDir, "work")).accessToken).toBe("web-login-access-token")
    })

    it.skipIf(skipOnDarwin)("sends the verifier that matches the challenge the browser was given", async () => {
      const started = startProfileLogin({ profiles, profileId: "personal" })
      if (!started.ok) throw new Error("expected success")
      const challenge = new URL(started.authorizeUrl).searchParams.get("code_challenge") ?? ""

      const { fetchFn, requests } = okTokenFetch()
      await completeProfileLogin({ loginId: started.loginId, input: "abc123", fetchFn })

      const sent = requests[0]?.code_verifier
      expect(sent).toBeTruthy()
      expect(createHash("sha256").update(String(sent)).digest("base64url")).toBe(challenge)
    })

    it.skipIf(skipOnDarwin)("is single-use — a replayed login id is gone", async () => {
      const started = startProfileLogin({ profiles, profileId: "personal" })
      if (!started.ok) throw new Error("expected success")

      const { fetchFn, requests } = okTokenFetch()
      expect(await completeProfileLogin({ loginId: started.loginId, input: "abc123", fetchFn }))
        .toMatchObject({ ok: true })
      expect(await completeProfileLogin({ loginId: started.loginId, input: "abc123", fetchFn }))
        .toMatchObject({ ok: false, code: "expired_login", status: 410 })
      expect(requests).toHaveLength(1)
      expect(pendingLoginCount()).toBe(0)
    })

    it.skipIf(skipOnDarwin)("consumes the login even when the exchange fails, since the code was sent", async () => {
      const started = startProfileLogin({ profiles, profileId: "personal" })
      if (!started.ok) throw new Error("expected success")

      const { fetchFn } = stubTokenFetch(() => new Response("{}", { status: 400 }))
      await completeProfileLogin({ loginId: started.loginId, input: "abc123", fetchFn })
      expect(pendingLoginCount()).toBe(0)
    })

    it.skipIf(skipOnDarwin)("refuses a token response that omits the refresh token", async () => {
      const started = startProfileLogin({ profiles, profileId: "personal" })
      if (!started.ok) throw new Error("expected success")

      const { fetchFn } = stubTokenFetch(() => new Response(
        JSON.stringify({ access_token: "only-access", expires_in: 3600 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ))
      const result = await completeProfileLogin({ loginId: started.loginId, input: "abc123", fetchFn })
      expect(result).toMatchObject({ ok: false, code: "exchange_failed" })
      expect(existsSync(join(tempDir, "personal", ".credentials.json"))).toBe(false)
    })

    it.skipIf(skipOnDarwin)("routes two concurrent logins to their own profiles", async () => {
      const first = startProfileLogin({ profiles, profileId: "personal" })
      const second = startProfileLogin({ profiles, profileId: "work" })
      if (!first.ok || !second.ok) throw new Error("expected both to start")

      const personalFetch = stubTokenFetch(() => new Response(
        JSON.stringify({ ...TOKEN_RESPONSE, access_token: "personal-token" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ))
      const workFetch = stubTokenFetch(() => new Response(
        JSON.stringify({ ...TOKEN_RESPONSE, access_token: "work-token" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ))

      const [personalResult, workResult] = await Promise.all([
        completeProfileLogin({ loginId: first.loginId, input: "code-a", fetchFn: personalFetch.fetchFn }),
        completeProfileLogin({ loginId: second.loginId, input: "code-b", fetchFn: workFetch.fetchFn }),
      ])

      expect(personalResult).toMatchObject({ ok: true, profileId: "personal" })
      expect(workResult).toMatchObject({ ok: true, profileId: "work" })
      expect(credentialsAt(join(tempDir, "personal")).accessToken).toBe("personal-token")
      expect(credentialsAt(join(tempDir, "work")).accessToken).toBe("work-token")
    })
  })
})
