/**
 * Usage reserves on Claude profiles, end to end over HTTP: a profile its
 * reserve holds back takes no new work, however the request would have
 * reached it, and the share it keeps is never spent to answer one.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assistantMessage, withMockSdkSessionId } from "./helpers"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"

type QueryCall = { readonly oauthToken?: string; readonly model?: string }

let queryCalls: QueryCall[] = []

installSdkMock(() => ({
  query: (params: { prompt: string | AsyncIterable<unknown>; options?: { env?: Record<string, string>; model?: string } }) => {
    queryCalls.push({ oauthToken: params.options?.env?.CLAUDE_CODE_OAUTH_TOKEN, model: params.options?.model })
    return (async function* () {
      if (typeof params.prompt !== "string") await Array.fromAsync(params.prompt)
      yield withMockSdkSessionId(assistantMessage([{ type: "text", text: "ok" }]), params.options)
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}), "usage-reserve-routing.test.ts")

installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_context: unknown, run: () => unknown) => run(),
}))

installMcpToolsMock(() => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

// mock.module is process-global: spread the real module and replace only the
// auth probe, which must not reach the host.
const actualModels = await import("../proxy/models")
mock.module("../proxy/models", () => ({
  ...actualModels,
  getClaudeAuthStatusAsync: async () => ({ loggedIn: true, subscriptionType: "max" }),
}))

const designDir = mkdtempSync(join(tmpdir(), "meridian-usage-reserve-"))
process.env.MERIDIAN_DESIGN_TOKEN_PATH = join(designDir, "missing-token.json")

const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const { getActiveProfileId, resetActiveProfile, setActiveProfile } = await import("../proxy/profiles")
const { resetFollowActive } = await import("../proxy/followActive")
const { rateLimitStore } = await import("../proxy/rateLimitStore")
const { __setFetchOAuthUsageOverride } = await import("../proxy/oauthUsage")
const { setSetting } = await import("../settings")

const HOUR = 3_600_000
const DAY = 24 * HOUR

const PROFILES = [
  { id: "work", type: "oauth-token" as const, oauthToken: "token-work" },
  { id: "personal", type: "oauth-token" as const, oauthToken: "token-personal" },
]

type TestApp = ReturnType<typeof createProxyServer>["app"]

function createTestApp(): TestApp {
  return createProxyServer({ port: 0, host: "127.0.0.1", profiles: PROFILES, defaultProfile: "work" }).app
}

function anthropicRequest(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 32, stream: false, messages: [{ role: "user", content: "work" }] }),
  })
}

function putRouting(app: TestApp, body: Record<string, unknown>): Promise<Response> {
  return Promise.resolve(app.fetch(new Request("http://localhost/settings/api/routing", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })))
}

async function routingSettings(app: TestApp): Promise<Record<string, unknown>> {
  return await (await app.fetch(new Request("http://localhost/settings/api/routing"))).json() as Record<string, unknown>
}

/** What the SDK last said about one window of a profile, as a real request would record it. */
function recordUsage(profileId: string, window: "five_hour" | "seven_day", utilization: number, resetsInMs: number): void {
  rateLimitStore.record(profileId, { status: "allowed", rateLimitType: window, utilization, resetsAt: Date.now() + resetsInMs })
}

type ErrorBody = { error?: { type?: string; message?: string; retry_after?: number } }

const FLAT_WEEK_95 = { seven_day: { floor: 95, ceiling: 95 } }
const PACED_5H_80 = { five_hour: { floor: 80, ceiling: 100 } }

function resetState(): void {
  rateLimitStore.clear()
  setSetting("usageReserves", {})
  setSetting("routingExcludedProfiles", [])
  setSetting("routingManagedExcludedProfiles", [])
  setSetting("routing", "active")
  setSetting("profileOrder", [])
  resetFollowActive()
  delete process.env.MERIDIAN_API_KEY
  delete process.env.MERIDIAN_FOLLOW_ACTIVE
  delete process.env.MERIDIAN_ROUTING
  delete process.env.MERIDIAN_PROFILE_ORDER
}

beforeEach(async () => {
  queryCalls = []
  await clearSessionCache()
  resetActiveProfile()
  resetState()
  __setFetchOAuthUsageOverride(async () => null)
})

afterEach(() => {
  resetState()
  __setFetchOAuthUsageOverride(null)
})

afterAll(() => {
  delete process.env.MERIDIAN_DESIGN_TOKEN_PATH
  rmSync(designDir, { recursive: true, force: true })
})

describe("usage reserves through the routing settings", () => {
  it("stores the whole map a supervisor writes, replacing the last one", async () => {
    // Given
    const app = createTestApp()

    // When
    const first = await putRouting(app, { usageReserves: { work: FLAT_WEEK_95, personal: PACED_5H_80 } })
    const second = await putRouting(app, { usageReserves: { personal: { five_hour: { floor: 80, ceiling: 97.5 } } } })

    // Then
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect((await routingSettings(app)).usageReserves).toEqual({ personal: { five_hour: { floor: 80, ceiling: 97.5 } } })
  })

  it("refuses a reserve it cannot draw and persists nothing from that write", async () => {
    // Given
    setSetting("usageReserves", { work: FLAT_WEEK_95 })
    const app = createTestApp()

    // When
    const inverted = await putRouting(app, {
      routingManagedExcludedProfiles: ["personal"],
      usageReserves: { work: { seven_day: { floor: 96, ceiling: 95 } } },
    })
    const zero = await putRouting(app, { usageReserves: { work: { seven_day: { floor: 0, ceiling: 95 } } } })

    // Then
    expect(inverted.status).toBe(400)
    expect(zero.status).toBe(400)
    const settings = await routingSettings(app)
    expect(settings.usageReserves).toEqual({ work: FLAT_WEEK_95 })
    expect(settings.routingManagedExcludedProfiles).toEqual([])
  })

  it("refuses a reserve for a profile it does not know", async () => {
    // Given
    const app = createTestApp()

    // When
    const put = await putRouting(app, { usageReserves: { nobody: FLAT_WEEK_95 } })

    // Then
    expect(put.status).toBe(400)
    expect((await routingSettings(app)).usageReserves).toEqual({})
  })
})

describe("a held Claude profile under active routing", () => {
  it("sends work that only defaulted to it to the next profile, leaving the pointer where it was", async () => {
    // Given
    setSetting("usageReserves", { work: FLAT_WEEK_95 })
    recordUsage("work", "seven_day", 0.96, 3 * DAY)
    setActiveProfile("work")
    const app = createTestApp()

    // When
    const response = await app.fetch(anthropicRequest())

    // Then
    expect(response.status).toBe(200)
    expect(queryCalls.map(call => call.oauthToken)).toEqual(["token-personal"])
    expect(getActiveProfileId()).toBe("work")
  })

  it("refuses work that named it, unsent, and says when its paced allowance catches up", async () => {
    // Given: 85% used halfway through a 5-hour window paced from 80%, so the
    // allowance passes 85% when 85% of the window has elapsed, 1.75h from now.
    setSetting("usageReserves", { work: PACED_5H_80 })
    recordUsage("work", "five_hour", 0.85, 2.5 * HOUR)
    const app = createTestApp()

    // When
    const response = await app.fetch(anthropicRequest({ "x-meridian-profile": "work" }))

    // Then
    expect(response.status).toBe(429)
    const body = await response.json() as ErrorBody
    expect(body.error?.type).toBe("rate_limit_error")
    expect(body.error?.message).toContain("5-hour at 85%, 80% allowed now, paced from 80% to 100%")
    const retryAfter = Number(response.headers.get("retry-after"))
    expect(retryAfter).toBeGreaterThan(1.75 * 3600 - 10)
    expect(retryAfter).toBeLessThanOrEqual(1.75 * 3600)
    expect(queryCalls).toEqual([])
  })

  it("refuses work, unsent, when every profile is held, naming each and timed by the soonest opening", async () => {
    // Given
    setSetting("usageReserves", { work: FLAT_WEEK_95, personal: { five_hour: { floor: 50, ceiling: 50 } } })
    recordUsage("work", "seven_day", 0.96, 3 * DAY)
    recordUsage("personal", "five_hour", 0.6, HOUR)
    const app = createTestApp()

    // When
    const response = await app.fetch(anthropicRequest())

    // Then
    expect(response.status).toBe(429)
    const message = (await response.json() as ErrorBody).error?.message ?? ""
    expect(message).toContain("work (weekly at 96%, capped at 95%)")
    expect(message).toContain("personal (5-hour at 60%, capped at 50%)")
    const retryAfter = Number(response.headers.get("retry-after"))
    expect(retryAfter).toBeGreaterThan(3600 - 10)
    expect(retryAfter).toBeLessThanOrEqual(3600)
    expect(queryCalls).toEqual([])
  })

  it("serves it again once its paced allowance passes what it used", async () => {
    // Given
    setSetting("usageReserves", { work: PACED_5H_80 })
    setActiveProfile("work")
    const app = createTestApp()

    // When: 85% used at half the window (80% allowed), then at 90% (90% allowed)
    recordUsage("work", "five_hour", 0.85, 2.5 * HOUR)
    const early = await app.fetch(anthropicRequest())
    recordUsage("work", "five_hour", 0.85, 0.5 * HOUR)
    const late = await app.fetch(anthropicRequest())

    // Then
    expect(early.status).toBe(200)
    expect(late.status).toBe(200)
    expect(queryCalls.map(call => call.oauthToken)).toEqual(["token-personal", "token-work"])
  })

  it("refuses to point the active profile at it", async () => {
    // Given
    setSetting("usageReserves", { personal: FLAT_WEEK_95 })
    recordUsage("personal", "seven_day", 0.95, 2 * DAY)
    setActiveProfile("work")
    const app = createTestApp()

    // When
    const response = await app.fetch(new Request("http://localhost/profiles/active", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile: "personal" }),
    }))

    // Then
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: "Profile \"personal\" is held back by its usage reserve: weekly at 95%, capped at 95%",
      code: "usage_reserve",
    })
    expect(getActiveProfileId()).toBe("work")
  })

  it("still lets a warm reach it", async () => {
    // Given
    setSetting("usageReserves", { work: FLAT_WEEK_95 })
    recordUsage("work", "seven_day", 0.97, 3 * DAY)
    const app = createTestApp()

    // When
    const response = await app.fetch(new Request("http://localhost/profiles/work/warm", { method: "POST" }))

    // Then
    expect(response.status).toBe(200)
    expect(queryCalls.map(call => call.oauthToken)).toEqual(["token-work"])
  })
})

describe("a held Claude profile in a priority pool", () => {
  it("is passed over without being attempted", async () => {
    // Given
    setSetting("routing", "priority")
    setSetting("profileOrder", ["work", "personal"])
    setSetting("usageReserves", { work: FLAT_WEEK_95 })
    recordUsage("work", "seven_day", 0.96, 3 * DAY)
    const app = createTestApp()

    // When
    const response = await app.fetch(anthropicRequest())

    // Then
    expect(response.status).toBe(200)
    expect(queryCalls.map(call => call.oauthToken)).toEqual(["token-personal"])
  })

  it("is never the last resort: with every profile held the request is refused unsent", async () => {
    // Given
    setSetting("routing", "priority")
    setSetting("profileOrder", ["work", "personal"])
    setSetting("usageReserves", { work: FLAT_WEEK_95, personal: FLAT_WEEK_95 })
    recordUsage("work", "seven_day", 0.96, 3 * DAY)
    recordUsage("personal", "seven_day", 0.99, 2 * DAY)
    const app = createTestApp()

    // When
    const response = await app.fetch(anthropicRequest())

    // Then
    expect(response.status).toBe(429)
    expect((await response.json() as ErrorBody).error?.message).toContain("Every eligible profile is held back by its usage reserve")
    expect(queryCalls).toEqual([])
  })
})

describe("the reserve on a profile's usage entry", () => {
  it("states each reserved window's cap and current allowance, and whether it holds", async () => {
    // Given
    setSetting("usageReserves", { work: { ...FLAT_WEEK_95, ...PACED_5H_80 } })
    recordUsage("work", "seven_day", 0.96, 3 * DAY)
    recordUsage("work", "five_hour", 0.5, 2.5 * HOUR)
    const app = createTestApp()

    // When
    const response = await app.fetch(new Request("http://localhost/v1/usage/quota/all"))
    const body = await response.json() as { profiles: Array<{ id: string; reserve?: Record<string, unknown> }> }

    // Then
    const work = body.profiles.find(profile => profile.id === "work")
    expect(work?.reserve).toMatchObject({
      held: true,
      reason: "weekly at 96%, capped at 95%",
      windows: {
        seven_day: { floor: 95, ceiling: 95, allowance: 95, held: true },
        five_hour: { floor: 80, ceiling: 100, allowance: 80, held: false },
      },
    })
    expect(work?.reserve?.opensAt).toBeGreaterThan(Date.now() + 2 * DAY)
    expect(body.profiles.find(profile => profile.id === "personal")).not.toHaveProperty("reserve")
  })
})
