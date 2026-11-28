/**
 * Per-request cybersec preservation through the HTTP layer: whether unpinned
 * plain Claude work meets the supervisor's `cybersec-preserved` managed
 * exclusions, decided by `x-meridian-cybersec-preservation` or the instance's
 * `cybersecPreservationDefault`, with the pointer, refusals, attestation,
 * activation, the routing settings and telemetry following that decision.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { rmSync } from "node:fs"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { installModelsMock } from "./modelsMock"
import { assistantMessage, resolveMockSdkSessionId } from "./helpers"

let served: string[] = []
let failTokens = new Set<string>()

installSdkMock(() => ({
  query: (params: any) => {
    const token = params.options?.env?.CLAUDE_CODE_OAUTH_TOKEN ?? "none"
    served.push(token)
    if (failTokens.has(token)) throw new Error("429 rate limit reached for this account")
    const sessionId = resolveMockSdkSessionId(params.options, "preservation-session")
    return (async function* () {
      yield { ...assistantMessage([{ type: "text", text: `ok from ${token}` }]), session_id: sessionId }
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}), "cybersec-preservation-integration.test.ts")

installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_context: unknown, run: () => unknown) => run(),
}))

installMcpToolsMock(() => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

installModelsMock(() => ({
  getClaudeAuthStatusAsync: async () => ({ loggedIn: true, subscriptionType: "team" }),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const { resetActiveProfile } = await import("../proxy/profiles")
const { clearAccountModels } = await import("../proxy/accountModels")
const { resetCvpAccessCacheForTests } = await import("../proxy/cvpAccess")
const { CYBERSEC_PRESERVATION_HEADER, resolveCybersecPreservation } = await import("../proxy/managedExclusionEvidence")
const { __setFetchOAuthUsageOverride } = await import("../proxy/oauthUsage")
const { rateLimitStore } = await import("../proxy/rateLimitStore")
const { configPath } = await import("../configDir")
const { setSetting } = await import("../settings")

// team is the CVP holder the supervisor keeps for cybersec work.
const PROFILES = [
  { id: "team", type: "oauth-token" as const, oauthToken: "token-team" },
  { id: "max", type: "oauth-token" as const, oauthToken: "token-max" },
  { id: "team2", type: "oauth-token" as const, oauthToken: "token-team2" },
  { id: "solo", type: "oauth-token" as const, oauthToken: "token-solo" },
]

const realFetch = globalThis.fetch
const savedEnv: Record<string, string | undefined> = {}
const ENV_KEYS = ["MERIDIAN_ROUTING", "MERIDIAN_PROFILE_ORDER", "MERIDIAN_CLAUDE_EXTRA_USAGE"]
let turn = 0

beforeEach(async () => {
  served = []
  failTokens = new Set()
  rmSync(configPath("cvp-access.json"), { force: true })
  rmSync(configPath("organizations.json"), { force: true })
  resetCvpAccessCacheForTests()
  clearAccountModels()
  rateLimitStore.clear()
  await clearSessionCache()
  resetActiveProfile()
  setSetting("activeProfile", undefined)
  setSetting("routingExcludedProfiles", [])
  setSetting("routingManagedExcludedProfiles", [])
  setSetting("routingHeldProfiles", [])
  setSetting("routingManagedReasons", undefined)
  setSetting("cvpProfileOrder", undefined)
  setSetting("cvpActiveProfile", undefined)
  setSetting("cvpManagedExcludedProfiles", undefined)
  setSetting("cybersecPreservationDefault", undefined)
  __setFetchOAuthUsageOverride(async () => null)
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
  process.env.MERIDIAN_ROUTING = "active+priority"
  process.env.MERIDIAN_PROFILE_ORDER = "team,max,team2,solo"
  delete process.env.MERIDIAN_CLAUDE_EXTRA_USAGE
  globalThis.fetch = Object.assign(
    async (...args: Parameters<typeof fetch>): Promise<Response> => {
      const url = String(args[0])
      if (!url.startsWith("https://api.anthropic.com/v1/models")) throw new Error(`unexpected network call in test: ${url}`)
      return Response.json({ data: [], has_more: false })
    },
    { preconnect: realFetch.preconnect },
  )
})

afterEach(() => {
  globalThis.fetch = realFetch
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  __setFetchOAuthUsageOverride(null)
  rateLimitStore.clear()
  resetActiveProfile()
  setSetting("activeProfile", undefined)
  setSetting("cybersecPreservationDefault", undefined)
})

type TestApp = ReturnType<typeof createProxyServer>["app"]

function app(): TestApp {
  return createProxyServer({ port: 0, host: "127.0.0.1", profiles: PROFILES, defaultProfile: "team" }).app
}

async function putRouting(target: TestApp, body: Record<string, unknown>) {
  return target.fetch(new Request("http://localhost/settings/api/routing", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }))
}

/** Write the supervisor's managed list with fresh evidence naming each profile's reason. */
async function preserve(target: TestApp, reasons: Record<string, string>) {
  const response = await putRouting(target, {
    routingManagedExcludedProfiles: Object.keys(reasons),
    routingManagedExclusionEvidence: { version: 1, observedAt: Date.now(), reasons },
  })
  expect(response.status).toBe(200)
}

interface RoutingSettings {
  capabilities: string[]
  cybersecPreservationDefault: boolean
  cybersecPreservedProfiles: string[]
  saved: { routing: string | null; profileOrder: string[] | null }
}

async function routingSettings(target: TestApp): Promise<RoutingSettings> {
  const response = await target.fetch(new Request("http://localhost/settings/api/routing"))
  expect(response.status).toBe(200)
  return await response.json() as RoutingSettings
}

async function activeProfile(target: TestApp): Promise<string | null> {
  const body = await (await target.fetch(new Request("http://localhost/profiles/list"))).json() as { activeProfile: string | null }
  return body.activeProfile
}

async function activate(target: TestApp, profile: string) {
  return target.fetch(new Request("http://localhost/profiles/active", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profile }),
  }))
}

const ON = { [CYBERSEC_PRESERVATION_HEADER]: "on" }
const OFF = { [CYBERSEC_PRESERVATION_HEADER]: "off" }

/** Each turn says something new, so no conversation affinity carries one account to the next. */
async function message(target: TestApp, headers: Record<string, string> = {}, model = "claude-sonnet-4-5") {
  return target.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ model, max_tokens: 64, messages: [{ role: "user", content: `say ok ${turn++}` }] }),
  }))
}

async function models(target: TestApp, headers: Record<string, string>) {
  return target.fetch(new Request("http://localhost/v1/models", { headers }))
}

interface TelemetryRow { profileId?: string; routingRequire?: string[]; cybersecPreservation?: string; cybersecPreservationSource?: string }

async function rowsSince(target: TestApp, since: number): Promise<TelemetryRow[]> {
  const response = await target.fetch(new Request(`http://localhost/telemetry/requests?limit=20&since=${since}`))
  return await response.json() as TelemetryRow[]
}

const preservationOf = (row: TelemetryRow) => [row.profileId, row.cybersecPreservation, row.cybersecPreservationSource]

interface NoRoutableBody {
  error: { code: string; route_refusal?: Record<string, unknown>; profiles: Array<{ id: string; reason: string; resets_at: string | null }> }
}

describe("resolveCybersecPreservation", () => {
  it("takes on or off from the header, case-insensitive, else the default", () => {
    expect(resolveCybersecPreservation(undefined, true)).toEqual({ value: "on", source: "default", error: null })
    expect(resolveCybersecPreservation(undefined, false)).toEqual({ value: "off", source: "default", error: null })
    expect(resolveCybersecPreservation(" ON ", false)).toEqual({ value: "on", source: "header", error: null })
    expect(resolveCybersecPreservation("Off", true)).toEqual({ value: "off", source: "header", error: null })
  })

  it("answers an error for any other value", () => {
    for (const value of ["yes", "", "on,off", "1"]) {
      expect(resolveCybersecPreservation(value, true)).toMatchObject({ value: null, source: null })
      expect(resolveCybersecPreservation(value, true).error).toContain(CYBERSEC_PRESERVATION_HEADER)
    }
  })
})

describe("x-meridian-cybersec-preservation values", () => {
  it("refuses a value other than on or off, unsent, on messages and models", async () => {
    const server = app()

    const response = await message(server, { [CYBERSEC_PRESERVATION_HEADER]: "maybe" })
    expect(response.status).toBe(400)
    const body = await response.json() as { error: { type: string; message: string } }
    expect(body.error.type).toBe("invalid_request_error")
    expect(body.error.message).toContain(CYBERSEC_PRESERVATION_HEADER)
    expect((await models(server, { [CYBERSEC_PRESERVATION_HEADER]: "maybe" })).status).toBe(400)
    expect((await models(server, { [CYBERSEC_PRESERVATION_HEADER]: "Off" })).status).toBe(200)
    expect(served).toEqual([])
  })
})

describe("with the default on (unset)", () => {
  it("keeps a preserved holder out unless the request says off", async () => {
    process.env.MERIDIAN_ROUTING = "priority"
    const server = app()
    await preserve(server, { team: "cybersec-preserved" })

    expect((await message(server)).status).toBe(200)
    expect((await message(server, { [CYBERSEC_PRESERVATION_HEADER]: "ON" })).status).toBe(200)
    expect((await message(server, OFF)).status).toBe(200)

    expect(served).toEqual(["token-max", "token-max", "token-team"])
  })

  it("attests over a pool only preserved holders are left in, and serves off work on them", async () => {
    const server = app()
    await preserve(server, { team: "cybersec-preserved", max: "spent", team2: "spent", solo: "spent" })

    const refused = await message(server, { "x-meridian-route-refusal": "1", "x-request-id": "3b8e2f61-7c4d-4a19-9e5f-0d6a1c2b3e48" })
    expect(refused.status).toBe(429)
    const body = await refused.json() as NoRoutableBody
    expect(body.error.code).toBe("no_routable_account")
    expect(body.error.route_refusal).toMatchObject({ sent: false, reason: "quota_exhausted" })
    expect(body.error.profiles.find(p => p.id === "team")).toEqual({ id: "team", reason: "excluded", resets_at: null })

    const offRefusal = await message(server, { ...OFF, "x-meridian-route-refusal": "1", "x-request-id": "7a1c9e03-5b2d-4f86-a4e7-2c9b8d0f1e65" })
    expect(offRefusal.status).toBe(200)
    expect(served).toEqual(["token-team"])
  })
})

describe("with the default off", () => {
  for (const routing of ["active+priority", "active"]) {
    it(`lets unflagged work use a preserved holder and passes the pointer for on work under ${routing}`, async () => {
      process.env.MERIDIAN_ROUTING = routing
      const server = app()
      expect((await putRouting(server, { cybersecPreservationDefault: false })).status).toBe(200)
      await preserve(server, { team: "cybersec-preserved" })
      const since = Date.now()

      expect((await message(server)).status).toBe(200)
      expect((await message(server, ON)).status).toBe(200)
      expect((await message(server, OFF)).status).toBe(200)

      expect(served).toEqual(["token-team", "token-max", "token-team"])
      expect((await rowsSince(server, since)).map(preservationOf)).toEqual([
        ["team", "off", "header"],
        ["max", "on", "header"],
        ["team", "off", "default"],
      ])
    })
  }
})

describe("off bypasses only the cybersec-preserved exclusions", () => {
  it("still applies the user's list, other managed reasons and holds", async () => {
    process.env.MERIDIAN_ROUTING = "priority"
    const server = app()
    await preserve(server, { team: "cybersec-preserved", max: "spent" })

    expect((await message(server, OFF)).status).toBe(200)
    setSetting("routingExcludedProfiles", ["team"])
    expect((await message(server, OFF)).status).toBe(200)
    setSetting("routingHeldProfiles", ["team2"])
    expect((await message(server, OFF)).status).toBe(200)

    expect(served).toEqual(["token-team", "token-team2", "token-solo"])
  })

  it("cannot bypass a managed exclusion without evidence naming its reason", async () => {
    process.env.MERIDIAN_ROUTING = "priority"
    setSetting("routingManagedExcludedProfiles", ["team"])
    const server = app()

    expect((await message(server, OFF)).status).toBe(200)
    expect(served).toEqual(["token-max"])
  })

  // The refusing account sits through the SDK's own rate-limit retries (~3s).
  it("names a bypassed holder by its own refusal, and the rest excluded", async () => {
    const server = app()
    await preserve(server, { team: "cybersec-preserved", max: "spent", team2: "spent", solo: "spent" })
    failTokens = new Set(["token-team"])

    const response = await message(server, OFF)

    expect(response.status).toBe(429)
    const body = await response.json() as NoRoutableBody
    expect(body.error.code).toBe("no_routable_account")
    expect(body.error.profiles.map(p => [p.id, p.reason])).toEqual([["team", "spent"], ["max", "excluded"], ["team2", "excluded"], ["solo", "excluded"]])
    expect([...new Set(served)]).toEqual(["token-team"])
  }, 20_000)
})

describe("requirements, pins and warms", () => {
  it("ignores the header beside x-meridian-require", async () => {
    const server = app()
    const reading = await server.fetch(new Request("http://localhost/profiles/team/cvp-access", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ models: [{ id: "claude-opus-5-5", badge: { message: "CVP: Defense Access" } }] }),
    }))
    expect(reading.status).toBe(200)
    await preserve(server, { team: "cybersec-preserved" })
    const since = Date.now()

    expect((await message(server, { ...ON, "x-meridian-require": "cvp" }, "claude-opus-5-5")).status).toBe(200)
    expect((await message(server, { ...OFF, "x-meridian-require": "restricted" })).status).toBe(200)

    expect(served).toEqual(["token-team", "token-max"])
    expect((await rowsSince(server, since)).map(row => [row.profileId, row.routingRequire, row.cybersecPreservation])).toEqual([
      ["max", ["restricted"], undefined],
      ["team", ["cvp"], undefined],
    ])
  })

  it("exempts pins, and records no preservation for them", async () => {
    const server = app()
    await preserve(server, { team: "cybersec-preserved" })
    const since = Date.now()

    expect((await message(server, { ...ON, "x-meridian-profile": "team" })).status).toBe(200)

    expect(served).toEqual(["token-team"])
    expect((await rowsSince(server, since)).map(preservationOf)).toEqual([["team", undefined, undefined]])
  })
})

describe("GET/PUT /settings/api/routing", () => {
  it("advertises the capability and reports the default and the preserved profiles", async () => {
    const server = app()
    const initial = await routingSettings(server)
    expect(initial.capabilities).toEqual(expect.arrayContaining(["managed-exclusion-cybersec-preserved", "cybersec-preservation-per-request"]))
    expect(initial.cybersecPreservationDefault).toBe(true)
    expect(initial.cybersecPreservedProfiles).toEqual([])

    expect((await putRouting(server, { cybersecPreservationDefault: false })).status).toBe(200)
    await preserve(server, { team: "cybersec-preserved", max: "spent" })
    const off = await routingSettings(server)
    expect(off.cybersecPreservationDefault).toBe(false)
    expect(off.cybersecPreservedProfiles).toEqual(["team"])

    expect((await putRouting(server, { cybersecPreservationDefault: null })).status).toBe(200)
    const cleared = await routingSettings(server)
    expect(cleared.cybersecPreservationDefault).toBe(true)
  })

  it("refuses a value that is not a boolean or null without writing the rest of the body", async () => {
    const server = app()

    expect((await putRouting(server, { routing: "sticky", cybersecPreservationDefault: "off" })).status).toBe(400)
    expect((await putRouting(server, { cybersecPreservationDefault: 0 })).status).toBe(400)

    const body = await routingSettings(server)
    expect(body.saved.routing).toBeNull()
    expect(body.cybersecPreservationDefault).toBe(true)
  })
})

describe("the active pointer follows the machine default", () => {
  it("is moved off a preserved holder while the default is on, and may rest there while it is off", async () => {
    const server = app()
    expect((await activate(server, "team")).status).toBe(200)

    await preserve(server, { team: "cybersec-preserved" })
    expect(await activeProfile(server)).toBe("max")
    expect((await activate(server, "team")).status).toBe(409)

    expect((await putRouting(server, { cybersecPreservationDefault: false })).status).toBe(200)
    expect((await activate(server, "team")).status).toBe(200)
    await preserve(server, { team: "cybersec-preserved" })
    expect(await activeProfile(server)).toBe("team")

    expect((await putRouting(server, { cybersecPreservationDefault: true })).status).toBe(200)
    expect(await activeProfile(server)).toBe("max")
  })
})
