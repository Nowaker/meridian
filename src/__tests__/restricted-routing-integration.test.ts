/**
 * `x-meridian-require: restricted` through the HTTP layer: unpinned work kept
 * off every account whose CVP map shows access on any model, under the general
 * switcher's own order, pointer and lists, plus pins, /v1/models, the routing
 * settings and telemetry.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { rmSync, writeFileSync } from "node:fs"
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
    const sessionId = resolveMockSdkSessionId(params.options, "restricted-session")
    return (async function* () {
      yield { ...assistantMessage([{ type: "text", text: `ok from ${token}` }]), session_id: sessionId }
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}), "restricted-routing-integration.test.ts")

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
const { __setFetchOAuthUsageOverride } = await import("../proxy/oauthUsage")
const { configPath } = await import("../configDir")
const { setSetting } = await import("../settings")

// team holds CVP access; the other three hold none until a test says so.
const PROFILES = [
  { id: "team", type: "oauth-token" as const, oauthToken: "token-team" },
  { id: "max", type: "oauth-token" as const, oauthToken: "token-max" },
  { id: "team2", type: "oauth-token" as const, oauthToken: "token-team2" },
  { id: "solo", type: "oauth-token" as const, oauthToken: "token-solo" },
]

const MODELS = [
  { type: "model", id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5", created_at: "2026-11-01T00:00:00Z", max_input_tokens: 1_000_000, max_tokens: 128_000 },
  { type: "model", id: "claude-opus-5-5", display_name: "Claude Opus 5.5", created_at: "2026-11-01T00:00:00Z", max_input_tokens: 1_000_000, max_tokens: 128_000 },
  { type: "model", id: "claude-mythos-5-2", display_name: "Claude Mythos 5.2", created_at: "2026-11-01T00:00:00Z", max_input_tokens: 1_000_000, max_tokens: 128_000 },
]

/** Only the holder lists Mythos, so a restricted list must leave it out. */
function modelsFor(token: string) {
  if (token === "token-team") return MODELS
  if (token === "token-solo") return MODELS.filter(m => m.id === "claude-sonnet-5-5")
  return MODELS.filter(m => !m.id.includes("mythos"))
}

const DEFENSE = { message: "CVP: Defense Access", variant: "neutral" }
const OPUS_ONLY = [{ id: "claude-opus-5-5", badge: DEFENSE }, { id: "claude-sonnet-5-5" }]

const realFetch = globalThis.fetch
const savedEnv: Record<string, string | undefined> = {}

beforeEach(async () => {
  served = []
  failTokens = new Set()
  rmSync(configPath("cvp-access.json"), { force: true })
  rmSync(configPath("organizations.json"), { force: true })
  resetCvpAccessCacheForTests()
  clearAccountModels()
  await clearSessionCache()
  resetActiveProfile()
  setSetting("routingExcludedProfiles", [])
  setSetting("routingManagedExcludedProfiles", [])
  setSetting("routingHeldProfiles", [])
  setSetting("cvpProfileOrder", undefined)
  setSetting("cvpActiveProfile", undefined)
  setSetting("cvpManagedExcludedProfiles", undefined)
  __setFetchOAuthUsageOverride(async () => null)
  savedEnv.MERIDIAN_ROUTING = process.env.MERIDIAN_ROUTING
  savedEnv.MERIDIAN_PROFILE_ORDER = process.env.MERIDIAN_PROFILE_ORDER
  process.env.MERIDIAN_ROUTING = "active+priority"
  process.env.MERIDIAN_PROFILE_ORDER = "team,max,team2,solo"
  globalThis.fetch = Object.assign(
    async (...args: Parameters<typeof fetch>): Promise<Response> => {
      const url = String(args[0])
      if (!url.startsWith("https://api.anthropic.com/v1/models")) throw new Error(`unexpected network call in test: ${url}`)
      const token = (new Headers(args[1]?.headers).get("authorization") ?? "").replace(/^Bearer /, "")
      return Response.json({ data: modelsFor(token), has_more: false })
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
  resetActiveProfile()
})

type TestApp = ReturnType<typeof createProxyServer>["app"]

/** A server whose map shows team holding CVP access on opus (and none on sonnet). */
async function app(): Promise<TestApp> {
  const server = createProxyServer({ port: 0, host: "127.0.0.1", profiles: PROFILES, defaultProfile: "team" }).app
  expect((await postReading(server, "team", OPUS_ONLY)).status).toBe(200)
  return server
}

async function postReading(target: TestApp, profile: string, models: unknown) {
  return target.fetch(new Request(`http://localhost/profiles/${profile}/cvp-access`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ models }),
  }))
}

async function setActive(target: TestApp, profile: string) {
  const response = await target.fetch(new Request("http://localhost/profiles/active", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profile }),
  }))
  expect(response.status).toBe(200)
}

const RESTRICTED = { "x-meridian-require": "restricted" }

async function message(target: TestApp, headers: Record<string, string> = {}, model = "claude-sonnet-5-5") {
  return target.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ model, max_tokens: 64, messages: [{ role: "user", content: "say ok" }] }),
  }))
}

async function models(target: TestApp, headers: Record<string, string>) {
  const response = await target.fetch(new Request("http://localhost/v1/models", { headers }))
  const body = await response.json() as { data?: Array<Record<string, any>> }
  return { response, data: body.data ?? [] }
}

interface NoRoutableBody {
  error: { type: string; code: string; message: string; reset_at: string | null; profiles: Array<{ id: string; reason: string; resets_at: string | null }> }
}

function organizations(byProfile: Record<string, string>) {
  writeFileSync(configPath("organizations.json"), JSON.stringify(Object.fromEntries(Object.entries(byProfile).map(([id, organizationUuid]) =>
    [id, { name: `Org ${organizationUuid}`, fetchedAt: 1, accountUuid: `account-${id}`, organizationUuid }]))))
}

interface RoutingSettings {
  capabilities: string[]
  restrictedProfiles: string[]
  cvpHolders: Record<string, string[]>
}

async function routingSettings(target: TestApp): Promise<RoutingSettings> {
  const response = await target.fetch(new Request("http://localhost/settings/api/routing"))
  expect(response.status).toBe(200)
  return await response.json() as RoutingSettings
}

describe("parsing x-meridian-require: restricted", () => {
  it("refuses cvp and restricted together, on messages and models, unsent", async () => {
    const server = await app()
    const response = await message(server, { "x-meridian-require": "cvp, restricted" })
    expect(response.status).toBe(400)
    const body = await response.json() as { error: { type: string; message: string } }
    expect(body.error.type).toBe("invalid_request_error")
    expect(body.error.message).toContain("cvp and restricted conflict")
    expect((await models(server, { "x-meridian-require": "restricted,cvp" })).response.status).toBe(400)
    expect(served).toEqual([])
  })

  it("still refuses an unknown token beside it", async () => {
    const server = await app()
    expect((await message(server, { "x-meridian-require": "restricted,zdr" })).status).toBe(400)
    expect((await models(server, { "x-meridian-require": "restricted,zdr" })).response.status).toBe(400)
    expect(served).toEqual([])
  })
})

describe("unpinned restricted work", () => {
  it("passes over a CVP holder at the head of the order and the active pointer, for any model", async () => {
    const server = await app()
    await setActive(server, "team")

    // team holds CVP on opus only, yet sonnet work still keeps off it: the allowance is account-wide.
    expect((await message(server, RESTRICTED)).status).toBe(200)
    expect((await message(server)).status).toBe(200)

    expect(served).toEqual(["token-max", "token-team"])
  })

  it("keeps the general active pointer when it is restricted", async () => {
    const server = await app()
    await setActive(server, "team2")

    expect((await message(server, RESTRICTED)).status).toBe(200)
    expect(served).toEqual(["token-team2"])
  })

  it("counts organization inference: a sibling of a holder is a holder", async () => {
    organizations({ team: "org-sub", max: "org-sub", team2: "org-other", solo: "org-solo" })
    const server = await app()

    expect((await message(server, RESTRICTED)).status).toBe(200)
    expect(served).toEqual(["token-team2"])
  })

  it("follows the general switcher's lists and never the cvp switcher's", async () => {
    setSetting("routingManagedExcludedProfiles", ["max"])
    setSetting("cvpManagedExcludedProfiles", ["team2"])
    setSetting("cvpActiveProfile", "solo")
    setSetting("cvpProfileOrder", ["solo", "team2"])
    const server = await app()

    expect((await message(server, RESTRICTED)).status).toBe(200)
    expect(served).toEqual(["token-team2"])
  })

  it("fails over only within the restricted accounts", async () => {
    const server = await app()
    failTokens = new Set(["token-max"])

    expect((await message(server, RESTRICTED)).status).toBe(200)
    expect([...new Set(served)]).toEqual(["token-max", "token-team2"])
  })

  // Each spent account sits through the SDK's own rate-limit retries (~3s).
  it("answers the normal pool refusal, holders left out, when every restricted account is spent", async () => {
    const server = await app()
    await postReading(server, "solo", OPUS_ONLY)
    failTokens = new Set(["token-max", "token-team2"])

    const response = await message(server, RESTRICTED)

    expect(response.status).toBe(429)
    const body = await response.json() as NoRoutableBody
    expect(body.error.code).toBe("no_routable_account")
    expect(body.error.message).toStartWith("No routable Claude account: every candidate refused")
    expect(body.error.profiles.map(p => [p.id, p.reason])).toEqual([["max", "spent"], ["team2", "spent"]])
    expect(body.error.reset_at).not.toBeNull()
    expect([...new Set(served)]).toEqual(["token-max", "token-team2"])
  }, 20_000)

  it("answers the normal excluded refusal when the managed list takes out every restricted account", async () => {
    setSetting("routingManagedExcludedProfiles", ["max", "team2", "solo"])
    const server = await app()

    const response = await message(server, RESTRICTED)

    expect(response.status).toBe(429)
    const body = await response.json() as NoRoutableBody
    expect(body.error.code).toBe("no_routable_account")
    expect(body.error.profiles.map(p => [p.id, p.reason])).toEqual([["max", "excluded"], ["team2", "excluded"], ["solo", "excluded"]])
    expect(served).toEqual([])
  })

  it("refuses unsent with no_restricted when every account holds CVP access", async () => {
    const server = await app()
    for (const id of ["max", "team2", "solo"]) await postReading(server, id, OPUS_ONLY)

    const response = await message(server, RESTRICTED)

    expect(response.status).toBe(429)
    const body = await response.json() as NoRoutableBody
    expect(body.error.code).toBe("no_routable_account")
    expect(body.error.reset_at).toBeNull()
    expect(body.error.profiles).toEqual([
      { id: "team", reason: "no_restricted", resets_at: null },
      { id: "max", reason: "no_restricted", resets_at: null },
      { id: "team2", reason: "no_restricted", resets_at: null },
      { id: "solo", reason: "no_restricted", resets_at: null },
    ])
    expect(served).toEqual([])
  })

  it("steers active routing off a holder by the general order", async () => {
    process.env.MERIDIAN_ROUTING = "active"
    process.env.MERIDIAN_PROFILE_ORDER = "team,solo,max,team2"
    const server = await app()
    await setActive(server, "team")

    expect((await message(server, RESTRICTED)).status).toBe(200)
    expect((await message(server)).status).toBe(200)

    expect(served).toEqual(["token-solo", "token-team"])
  })

  it("refuses with no_restricted under active routing when nobody qualifies", async () => {
    process.env.MERIDIAN_ROUTING = "active"
    const server = await app()
    for (const id of ["max", "team2", "solo"]) await postReading(server, id, OPUS_ONLY)

    const response = await message(server, RESTRICTED)

    expect(response.status).toBe(429)
    expect((await response.json() as NoRoutableBody).error.profiles.every(p => p.reason === "no_restricted")).toBe(true)
    expect(served).toEqual([])
  })
})

describe("pins carrying restricted", () => {
  it("refuses a pin to a holder unsent with 403 profile_has_cvp", async () => {
    const server = await app()

    const response = await message(server, { ...RESTRICTED, "x-meridian-profile": "team" })

    expect(response.status).toBe(403)
    const body = await response.json() as { error: { type: string; message: string } }
    expect(body.error.type).toBe("profile_has_cvp")
    expect(body.error.message).toBe('Profile "team" holds CVP access, which restricted work never reaches')
    expect(served).toEqual([])
  })

  it("sends a pin to an account with no reading, and a pin without the header to a holder", async () => {
    const server = await app()

    expect((await message(server, { ...RESTRICTED, "x-meridian-profile": "solo" })).status).toBe(200)
    expect((await message(server, { "x-meridian-profile": "team" })).status).toBe(200)
    expect(served).toEqual(["token-solo", "token-team"])
  })
})

describe("GET /v1/models with restricted", () => {
  it("lists unpinned only the models some reachable restricted account serves", async () => {
    setSetting("routingManagedExcludedProfiles", ["team2"])
    const server = await app()

    const restricted = await models(server, RESTRICTED)

    expect(restricted.response.status).toBe(200)
    expect(restricted.data.map(m => [m.id, m.restricted_profiles])).toEqual([
      ["claude-sonnet-5-5", ["max", "solo"]],
      ["claude-opus-5-5", ["max"]],
    ])
  })

  it("answers a pinned account its own models, and a pinned holder nothing", async () => {
    const server = await app()

    expect((await models(server, { ...RESTRICTED, "x-meridian-profile": "solo" })).data.map(m => m.id)).toEqual(["claude-sonnet-5-5"])
    expect((await models(server, { ...RESTRICTED, "x-meridian-profile": "team" })).data).toEqual([])
  })
})

describe("GET /settings/api/routing", () => {
  it("advertises restricted-routing and lists restricted profiles in the general order, exclusions not applied", async () => {
    setSetting("routingManagedExcludedProfiles", ["max"])
    organizations({ team: "org-sub", team2: "org-sub", max: "org-max", solo: "org-solo" })
    const body = await routingSettings(await app())

    expect(body.capabilities).toEqual(expect.arrayContaining(["restricted-routing", "cvp-routing"]))
    expect(body.restrictedProfiles).toEqual(["max", "solo"])
    expect(body.cvpHolders["claude-opus-5-5"]).toEqual(["team", "team2"])
  })
})

describe("telemetry", () => {
  it("records restricted in routingRequire", async () => {
    const server = await app()
    const since = Date.now()

    expect((await message(server, { "x-meridian-require": " Restricted " })).status).toBe(200)

    const rows = await (await server.fetch(new Request(`http://localhost/telemetry/requests?limit=10&since=${since}`))).json() as Array<{ profileId?: string; routingRequire?: string[] }>
    expect(rows.map(row => [row.profileId, row.routingRequire])).toEqual([["max", ["restricted"]]])
  })
})
