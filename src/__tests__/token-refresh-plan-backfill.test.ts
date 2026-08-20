/**
 * Unit tests for the plan backfill a token refresh performs.
 *
 * The plan is written at login and never again, so a credential file created
 * before Meridian persisted it stays plan-blind for the life of the login. A
 * refresh is the only other moment holding a valid access token, so it is the
 * only place the gap can be closed without an interactive re-login.
 *
 * The reading also EXPIRES, because a plan is not immutable: an account
 * upgraded from Max 5x to Max 20x keeps the same credential file, so a gate
 * that only fired on an absent field reported the superseded plan for the life
 * of the login. So a fresh reading outranks the stored one, and the date of the
 * last reading is what decides whether one is taken at all.
 *
 * Both endpoints are reached through `globalThis.fetch`, so the mock dispatches
 * on URL: the token endpoint returns rotated tokens, the profile endpoint
 * returns the plan. Profile-endpoint calls are counted, because "does not ask
 * while the reading is still fresh" is the assertion that bounds this to one
 * GET per recheck window rather than one per refresh attempt.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import type { CredentialStore } from "../proxy/tokenRefresh"
import { planFieldsMissing } from "../proxy/oauthPlan"

const TOKEN_URL = "https://platform.claude.com/v1/oauth/token"
const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile"

function jsonResponse(body: object) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}

const ROTATED_TOKENS = {
  access_token: "rotated-access-token",
  refresh_token: "rotated-refresh-token",
  expires_in: 3600,
}

const MAX_20X_PROFILE = {
  organization: {
    organization_type: "claude_max",
    rate_limit_tier: "default_claude_max_20x",
  },
}

/**
 * Route the two endpoints and count profile hits.
 *
 * `profileResponse` returning null stands for a profile lookup that fails —
 * the case that must leave the refresh itself successful.
 */
function stubEndpoints(profileResponse: () => Response | null) {
  let tokenCalls = 0
  let profileCalls = 0
  let profileAuthorization: string | undefined
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const href = String(url)
    if (href === TOKEN_URL) {
      tokenCalls++
      return jsonResponse(ROTATED_TOKENS)
    }
    if (href === PROFILE_URL) {
      profileCalls++
      profileAuthorization = (init?.headers as Record<string, string> | undefined)?.Authorization
      const res = profileResponse()
      if (!res) throw new Error("profile endpoint unreachable")
      return res
    }
    throw new Error(`unexpected fetch: ${href}`)
  }) as typeof fetch

  return {
    tokenCalls: () => tokenCalls,
    profileCalls: () => profileCalls,
    profileAuthorization: () => profileAuthorization,
  }
}

/** A store seeded with tokens plus whatever plan fields the case is about. */
function makeStore(plan: Record<string, unknown>) {
  let stored: Record<string, unknown> = {
    claudeAiOauth: {
      accessToken: "old-access-token",
      refreshToken: "the-refresh-token",
      expiresAt: Date.now() - 1000,
      scopes: ["user:profile", "user:inference"],
      ...plan,
    },
  }
  const store: CredentialStore = {
    async read() { return JSON.parse(JSON.stringify(stored)) as never },
    async write(credentials) { stored = credentials as never; return true },
  }
  return {
    store,
    oauth: () => (stored.claudeAiOauth as Record<string, unknown>),
  }
}

describe("planFieldsMissing", () => {
  it("is true while either field is absent", () => {
    expect(planFieldsMissing({})).toBe(true)
    expect(planFieldsMissing({ subscriptionType: "max" })).toBe(true)
    expect(planFieldsMissing({ rateLimitTier: "default_claude_max_20x" })).toBe(true)
    expect(planFieldsMissing(null)).toBe(true)
    expect(planFieldsMissing(undefined)).toBe(true)
  })

  it("is false only once both are present", () => {
    expect(planFieldsMissing({ subscriptionType: "max", rateLimitTier: "default_claude_max_20x" })).toBe(false)
  })
})

describe("a token refresh backfills a plan-blind credential", () => {
  let originalFetch: typeof globalThis.fetch
  let originalWarn: typeof console.warn

  beforeEach(() => {
    originalFetch = globalThis.fetch
    originalWarn = console.warn
    console.warn = () => {}
  })

  afterEach(async () => {
    globalThis.fetch = originalFetch
    console.warn = originalWarn
    const { resetInflightRefresh } = await import("../proxy/tokenRefresh")
    resetInflightRefresh()
  })

  it("writes both fields when the credential has neither", async () => {
    const { refreshOAuthToken } = await import("../proxy/tokenRefresh")
    const { store, oauth } = makeStore({})
    const stub = stubEndpoints(() => jsonResponse(MAX_20X_PROFILE))

    expect(await refreshOAuthToken(store)).toBe(true)
    expect(oauth().subscriptionType).toBe("max")
    expect(oauth().rateLimitTier).toBe("default_claude_max_20x")
    expect(stub.profileCalls()).toBe(1)
  })

  it("completes a credential the CLI filled only halfway", async () => {
    const { refreshOAuthToken } = await import("../proxy/tokenRefresh")
    // `claude login` records subscriptionType without always recording the
    // tier, and the tier is the half that separates Max 5x from Max 20x.
    const { store, oauth } = makeStore({ subscriptionType: "max" })
    stubEndpoints(() => jsonResponse(MAX_20X_PROFILE))

    expect(await refreshOAuthToken(store)).toBe(true)
    expect(oauth().rateLimitTier).toBe("default_claude_max_20x")
  })

  it("presents the freshly rotated access token to the profile endpoint", async () => {
    const { refreshOAuthToken } = await import("../proxy/tokenRefresh")
    const { store } = makeStore({})
    const stub = stubEndpoints(() => jsonResponse(MAX_20X_PROFILE))

    await refreshOAuthToken(store)

    // The old token may already be rejected — that is why the refresh ran.
    expect(stub.profileAuthorization()).toBe("Bearer rotated-access-token")
  })

  it("does not ask again while the last reading is still fresh", async () => {
    const { refreshOAuthToken } = await import("../proxy/tokenRefresh")
    const { store } = makeStore({
      subscriptionType: "max",
      rateLimitTier: "default_claude_max_20x",
      planCheckedAt: Date.now(),
    })
    const stub = stubEndpoints(() => jsonResponse(MAX_20X_PROFILE))

    expect(await refreshOAuthToken(store)).toBe(true)
    expect(stub.profileCalls()).toBe(0)
  })

  it("asks again once the reading has aged out", async () => {
    const { refreshOAuthToken } = await import("../proxy/tokenRefresh")
    const { PLAN_RECHECK_MS } = await import("../proxy/oauthPlan")
    const { store } = makeStore({
      subscriptionType: "max",
      rateLimitTier: "default_claude_max_20x",
      planCheckedAt: Date.now() - PLAN_RECHECK_MS - 1,
    })
    const stub = stubEndpoints(() => jsonResponse(MAX_20X_PROFILE))

    expect(await refreshOAuthToken(store)).toBe(true)
    expect(stub.profileCalls()).toBe(1)
  })

  it("asks about a complete credential that was never dated", async () => {
    const { refreshOAuthToken } = await import("../proxy/tokenRefresh")
    // Every credential on a fleet that predates the date is in this state, so
    // this is what decides whether an upgrade is noticed on an account that is
    // already logged in and wants nothing else from a human.
    const { store } = makeStore({ subscriptionType: "max", rateLimitTier: "default_claude_max_5x" })
    const stub = stubEndpoints(() => jsonResponse(MAX_20X_PROFILE))

    expect(await refreshOAuthToken(store)).toBe(true)
    expect(stub.profileCalls()).toBe(1)
  })

  it("takes an upgrade over the plan already on disk", async () => {
    const { refreshOAuthToken } = await import("../proxy/tokenRefresh")
    // The measured case: an account added as Max 5x, upgraded to Max 20x, and
    // still reported 5x days later because nothing ever read it a second time.
    const { store, oauth } = makeStore({ subscriptionType: "max", rateLimitTier: "default_claude_max_5x" })
    stubEndpoints(() => jsonResponse(MAX_20X_PROFILE))

    expect(await refreshOAuthToken(store)).toBe(true)
    expect(oauth().rateLimitTier).toBe("default_claude_max_20x")
    expect(typeof oauth().planCheckedAt).toBe("number")
  })

  it("takes a due plan upgrade without rotating a still-valid access token", async () => {
    const { ensureFreshToken } = await import("../proxy/tokenRefresh")
    const { PLAN_RECHECK_MS } = await import("../proxy/oauthPlan")
    const { store, oauth } = makeStore({
      subscriptionType: "max",
      rateLimitTier: "default_claude_max_5x",
      planCheckedAt: Date.now() - PLAN_RECHECK_MS - 1,
      expiresAt: Date.now() + 4 * 60 * 60_000,
    })
    const stub = stubEndpoints(() => jsonResponse(MAX_20X_PROFILE))

    expect(await ensureFreshToken(store)).toBe(true)
    expect(stub.tokenCalls()).toBe(0)
    expect(stub.profileCalls()).toBe(1)
    expect(oauth().rateLimitTier).toBe("default_claude_max_20x")
  })

  it("leaves a field the reading did not carry alone", async () => {
    const { refreshOAuthToken } = await import("../proxy/tokenRefresh")
    // A partial response must not erase disk: an absent key means "not
    // reported", never "no longer set".
    const { store, oauth } = makeStore({ subscriptionType: "team", seatTier: "default_raven" })
    stubEndpoints(() => jsonResponse({ organization: { rate_limit_tier: "default_claude_max_5x" } }))

    expect(await refreshOAuthToken(store)).toBe(true)
    expect(oauth().subscriptionType).toBe("team")
    expect(oauth().seatTier).toBe("default_raven")
    expect(oauth().rateLimitTier).toBe("default_claude_max_5x")
  })

  it("does not date a reading that failed, so the next refresh retries", async () => {
    const { refreshOAuthToken } = await import("../proxy/tokenRefresh")
    const { store, oauth } = makeStore({ subscriptionType: "max", rateLimitTier: "default_claude_max_5x" })
    stubEndpoints(() => null)

    expect(await refreshOAuthToken(store)).toBe(true)
    expect(oauth().rateLimitTier).toBe("default_claude_max_5x")
    expect("planCheckedAt" in oauth()).toBe(false)
  })

  it("still refreshes the token when the plan lookup fails", async () => {
    const { refreshOAuthToken } = await import("../proxy/tokenRefresh")
    const { store, oauth } = makeStore({})
    stubEndpoints(() => null)

    expect(await refreshOAuthToken(store)).toBe(true)
    expect(oauth().accessToken).toBe("rotated-access-token")
    expect("subscriptionType" in oauth()).toBe(false)
  })

  it("writes no plan key at all for an account it could not identify", async () => {
    const { refreshOAuthToken } = await import("../proxy/tokenRefresh")
    const { store, oauth } = makeStore({})
    stubEndpoints(() => jsonResponse({ organization: { organization_type: "claude_something_new" } }))

    expect(await refreshOAuthToken(store)).toBe(true)
    expect(JSON.stringify(oauth())).not.toContain("subscriptionType")
    expect(JSON.stringify(oauth())).not.toContain("rateLimitTier")
  })

  it("leaves the refresh a single credential-store write", async () => {
    const { refreshOAuthToken } = await import("../proxy/tokenRefresh")
    let writes = 0
    let stored: Record<string, unknown> = {
      claudeAiOauth: {
        accessToken: "old-access-token",
        refreshToken: "the-refresh-token",
        expiresAt: Date.now() - 1000,
      },
    }
    const store: CredentialStore = {
      async read() { return JSON.parse(JSON.stringify(stored)) as never },
      async write(credentials) { writes++; stored = credentials as never; return true },
    }
    stubEndpoints(() => jsonResponse(MAX_20X_PROFILE))

    expect(await refreshOAuthToken(store)).toBe(true)
    expect(writes).toBe(1)
    expect((stored.claudeAiOauth as Record<string, unknown>).rateLimitTier).toBe("default_claude_max_20x")
  })
})
