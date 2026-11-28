/**
 * The error a client gets when pool routing has no Claude account left for a
 * request, through the HTTP layer with a mocked SDK.
 *
 * A client that can read it pauses the conversation instead of letting it die
 * on a rate limit, and a supervisor polling `/profiles/events` opens one
 * incident per outage rather than one per refused request. So the assertions
 * are on the machine-read fields: the code, the incident that ties the error
 * to its `pool_exhausted` events, and the per-profile reasons.
 */
import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { createOwnedCredentialStore } from "./modelsMock"
import { assistantMessage, resolveMockSdkSessionId } from "./helpers"

let failingDirs = new Set<string>()
let sdkCalls = 0
const SESSION_LIMIT = "Claude Code returned an error result: You've hit your session limit · resets 12:30am (America/Chicago)"

installSdkMock(() => ({
  query: (params: any) => {
    sdkCalls++
    const dir = params.options?.env?.CLAUDE_CONFIG_DIR ?? "default"
    const sessionId = resolveMockSdkSessionId(params.options, "test-session")
    return (async function* () {
      if ([...failingDirs].some((f) => dir.includes(f))) throw new Error(SESSION_LIMIT)
      yield { ...assistantMessage([{ type: "text", text: "ok from " + dir }]), session_id: sessionId }
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}), "no-routable-account.test.ts")

installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}))

installMcpToolsMock(() => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const { resetActiveProfile } = await import("../proxy/profiles")
const { __setFetchOAuthUsageOverride, clearOAuthUsageForProfile, fetchOAuthUsage } = await import("../proxy/oauthUsage")
const { clearAccountModels, fetchAccountModels } = await import("../proxy/accountModels")
const { rateLimitStore } = await import("../proxy/rateLimitStore")
const tokens = await import("../proxy/tokenRefresh")
const { setSetting } = await import("../settings")
const { recordCvpReading, resetCvpAccessCacheForTests } = await import("../proxy/cvpAccess")
const { configPath } = await import("../configDir")
const { rmSync } = await import("node:fs")

const ALL_DIRS = ["nr-work", "nr-personal", "nr-spare"]
const PROFILES = [
  { id: "work", claudeConfigDir: "/tmp/meridian-nr-work" },
  { id: "personal", claudeConfigDir: "/tmp/meridian-nr-personal" },
  { id: "spare", claudeConfigDir: "/tmp/meridian-nr-spare" },
]
const DAY = 24 * 3_600_000
const PREFIX = "No routable Claude account: "
const CONTRACT_FIELDS = ["type", "code", "message", "reset_at", "incident_id", "request_id", "profiles"]
const REASONS = ["spent", "reserve_held", "weekly_held", "model_benched", "excluded", "held", "extra_usage_off", "logged_out"]
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/

type TestApp = { fetch: (r: Request) => Response | Promise<Response> }
type ProfileEntry = { id: string; reason: string; resets_at: string | null }
type NoRoutableError = {
  type: string
  code?: string
  message: string
  reset_at?: string | null
  incident_id?: string
  request_id?: string
  route_refusal?: unknown
  profiles?: ProfileEntry[]
}
type PoolEvent = {
  seq: number
  kind: string
  profile: string
  servedBy: string | null
  incidentId?: string
  requestId?: string | null
  sessionKey: string | null
  resetAt?: string | null
  profiles?: Array<{ id: string; reason: string; resetsAt: string | null }>
}

function createTestApp(): TestApp {
  return createProxyServer({ port: 0, host: "127.0.0.1", profiles: PROFILES, defaultProfile: "work" }).app
}

function setFleetEvidence(app: TestApp, reasons: Record<string, string>, observedAt = Date.now()) {
  return app.fetch(new Request("http://localhost/settings/api/routing", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ routingManagedExcludedProfiles: Object.keys(reasons),
      routingManagedExclusionEvidence: { version: 1, observedAt, reasons } }),
  }))
}

function post(app: TestApp, opts: { stream?: boolean; content?: string; requestId?: string; profile?: string; attest?: boolean; model?: string; require?: string } = {}) {
  const headers = new Headers({ "Content-Type": "application/json" })
  if (opts.requestId) headers.set("x-request-id", opts.requestId)
  if (opts.require) headers.set("x-meridian-require", opts.require)
  if (opts.profile) headers.set("x-meridian-profile", opts.profile)
  if (opts.attest) headers.set("x-meridian-route-refusal", "1")
  return Promise.resolve(app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: opts.model ?? "claude-sonnet-4-5",
      max_tokens: 128,
      stream: opts.stream ?? false,
      messages: [{ role: "user", content: opts.content ?? "hello" }],
    }),
  })))
}

async function errorOf(res: Response): Promise<NoRoutableError> {
  return (await res.json() as { error: NoRoutableError }).error
}

async function events(app: TestApp): Promise<PoolEvent[]> {
  const res = await app.fetch(new Request("http://localhost/profiles/events?since=0&limit=500"))
  return (await res.json() as { events: PoolEvent[] }).events
}

/** The error frames of an SSE body, parsed. */
function streamErrors(text: string): NoRoutableError[] {
  return text.split("\n\n")
    .filter(frame => frame.startsWith("event: error"))
    .map(frame => (JSON.parse(frame.slice(frame.indexOf("data: ") + 6)) as { error: NoRoutableError }).error)
}

/** Every field the contract names, in the shape it names. */
function expectContractShape(error: NoRoutableError): void {
  for (const field of CONTRACT_FIELDS) expect(Object.keys(error)).toContain(field)
  expect(error.type).toBe("rate_limit_error")
  expect(error.code).toBe("no_routable_account")
  expect(error.message.startsWith(PREFIX)).toBe(true)
  expect(error.incident_id).toMatch(/^inc_\d+_\d+$/)
  const token = error.message.match(/\(incident (inc_\d+_\d+)\)$/)
  expect(token?.[1]).toBe(error.incident_id!)
  expect(typeof error.request_id).toBe("string")
  expect(error.request_id!.length).toBeGreaterThan(0)
  if (error.reset_at !== null) expect(error.reset_at).toMatch(ISO)
  for (const entry of error.profiles!) {
    expect(Object.keys(entry).sort()).toEqual(["id", "reason", "resets_at"])
    expect(REASONS).toContain(entry.reason)
    if (entry.resets_at !== null) expect(entry.resets_at).toMatch(ISO)
  }
}

const savedEnv: Record<string, string | undefined> = {}
const ENV_KEYS = ["MERIDIAN_ROUTING", "MERIDIAN_PROFILE_ORDER", "MERIDIAN_WEEKLY_RESERVE", "MERIDIAN_CLAUDE_EXTRA_USAGE"]

beforeEach(async () => {
  failingDirs = new Set()
  sdkCalls = 0
  await clearSessionCache()
  resetActiveProfile()
  rateLimitStore.clear()
  setSetting("usageReserves", {})
  setSetting("routingExcludedProfiles", [])
  setSetting("routingManagedExcludedProfiles", [])
  __setFetchOAuthUsageOverride(async () => null)
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
  process.env.MERIDIAN_ROUTING = "active+priority"
  process.env.MERIDIAN_PROFILE_ORDER = "work,personal,spare"
  delete process.env.MERIDIAN_WEEKLY_RESERVE
  delete process.env.MERIDIAN_CLAUDE_EXTRA_USAGE
})

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  setSetting("usageReserves", {})
  setSetting("routingExcludedProfiles", [])
  setSetting("routingManagedExcludedProfiles", [])
  __setFetchOAuthUsageOverride(null)
  rateLimitStore.clear()
  resetActiveProfile()
  rmSync(configPath("cvp-access.json"), { force: true })
  resetCvpAccessCacheForTests()
})

describe("no_routable_account before the stream starts", () => {
  it("answers 429 with Retry-After and the contract's fields when every candidate refuses", async () => {
    for (const dir of ALL_DIRS) failingDirs.add(dir)
    const app = createTestApp()

    const res = await post(app)

    expect(res.status).toBe(429)
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0)
    const error = await errorOf(res)
    expectContractShape(error)
    expect(error.profiles!.map(p => [p.id, p.reason]).sort()).toEqual([["personal", "spent"], ["spare", "spent"], ["work", "spent"]])
    // The pool opens when its first account does, and every refused one names when.
    expect(error.profiles!.every(p => p.resets_at !== null)).toBe(true)
    const earliest = Math.min(...error.profiles!.map(p => Date.parse(p.resets_at!)))
    expect(Date.parse(error.reset_at!)).toBe(earliest)
  }, 40_000)
})

describe("no_routable_account inside the stream", () => {
  it("carries exactly the pre-stream error object's fields in its one error frame", async () => {
    for (const dir of ALL_DIRS) failingDirs.add(dir)
    const app = createTestApp()

    const res = await post(app, {
      stream: true,
      content: "streamed unique message",
      requestId: "d8f674be-a3b9-4bc9-a13c-57aa3cf2fa6d",
      attest: true,
    })

    expect(res.status).toBe(200)
    const frames = streamErrors(await res.text())
    expect(frames).toHaveLength(1)
    const error = frames[0]!
    expectContractShape(error)
    expect(error.route_refusal).toBeUndefined()
    expect(error.profiles!.map(p => p.id).sort()).toEqual(["personal", "spare", "work"])

    // Same object shape as the JSON body a non-streaming request gets.
    const jsonError = await errorOf(await post(app, { content: "json unique message" }))
    expect(Object.keys(error).sort()).toEqual(Object.keys(jsonError).sort())
  }, 40_000)
})

describe("early refusal for fresh, spent plan windows", () => {
  it.each([
    ["all spent", null, false, 429],
    ["managed-out account", "managed", false, 429],
    ["manually excluded account", "manual", false, 200],
    ["stale observation", null, true, 200],
    ["paid overflow still allowed", "overflow", false, 200],
    ["legacy correlated request", "legacy", false, 200],
  ] as const)("honors routing evidence for %s", async (_name, special, stale, status) => {
    process.env.MERIDIAN_CLAUDE_EXTRA_USAGE = special === "overflow" ? "immediately" : "never"
    if (special === "manual") setSetting("routingExcludedProfiles", ["spare"])
    const now = Date.now()
    for (const id of special === "managed" || special === "manual" ? ["work", "personal"] : ["work", "personal", "spare"]) {
      rateLimitStore.record(id, { status: "rejected", rateLimitType: "five_hour", utilization: 1, resetsAt: now + 3_600_000 },
        stale && id === "spare" ? now - 10 * 60_000 : now)
    }
    const app = createTestApp()
    if (special === "managed") expect((await setFleetEvidence(app, { spare: "loaner-gate" })).status).toBe(200)

    const res = await post(app, { stream: true, requestId: "aba6ca87-82f1-49ed-8905-329ff6b25931", attest: special !== "legacy" })

    expect(res.status).toBe(status)
    if (status === 429) {
      const error = await errorOf(res)
      expect(error.code).toBe("no_routable_account")
      expect(error.route_refusal).toMatchObject({ sent: false, model: "claude-sonnet-4-5", reason: "quota_exhausted" })
      expect(sdkCalls).toBe(0)
    } else {
      expect(await res.text()).toContain("ok from")
    }
  })
})

describe("restricted work", () => {
  it("attests quota_exhausted over the restricted accounts alone while a CVP holder is still open", async () => {
    process.env.MERIDIAN_CLAUDE_EXTRA_USAGE = "never"
    recordCvpReading("work", [{ id: "claude-opus-5-5", badge: { message: "CVP: Defense Access" } }])
    const now = Date.now()
    for (const id of ["personal", "spare"]) {
      rateLimitStore.record(id, { status: "rejected", rateLimitType: "five_hour", utilization: 1, resetsAt: now + 3_600_000 }, now)
    }
    const app = createTestApp()

    const res = await post(app, { stream: true, requestId: "5f0b8a3e-2c41-4d7a-9e1b-6a2f3c4d5e6f", attest: true, require: "restricted" })

    expect(res.status).toBe(429)
    const error = await errorOf(res)
    expect(error.code).toBe("no_routable_account")
    expect(error.route_refusal).toMatchObject({ sent: false, model: "claude-sonnet-4-5", reason: "quota_exhausted" })
    expect(error.profiles!.map(p => [p.id, p.reason])).toEqual([["personal", "spent"], ["spare", "spent"]])
    expect(sdkCalls).toBe(0)

    expect((await post(app)).status).toBe(200)
    expect(sdkCalls).toBe(1)
  })
})

it.each([
  { name: "Opus family", model: "claude-opus-5-5", effort: "high", window: "seven_day_opus", expected: 0.25 },
  { name: "Sonnet exact model", model: "claude-sonnet-4-6", effort: "medium", scope: "Claude Sonnet 4.6", expected: 0.25 },
  { name: "Terra reverse target", model: "claude-sonnet-5-5", effort: "high", scope: "Claude Sonnet 5.5", expected: 0.25 },
  { name: "Fable family", model: "claude-fable-5-2", effort: "xhigh", scope: "Fable", expected: 0.25 },
  { name: "Astra reverse target", model: "claude-fable-5-2", effort: "high", scope: "Fable", expected: 0.25 },
  { name: "Mythos governed by Fable", model: "claude-mythos-5-2", effort: "max", window: "seven_day_overage_included", expected: 0.25 },
  { name: "Mythos governed by versioned Fable scope", model: "claude-mythos-5-2", effort: "max", scope: "Claude Fable 5.2", expected: 0.25 },
  { name: "Mythos SDK Fable refusal", model: "claude-mythos-5-2", effort: "max", scope: "Fable", sdkBucket: "seven_day_overage_included", expected: 0 },
  { name: "explicit Haiku", model: "claude-haiku-5-5", effort: "low", expected: 1 - 0.7 },
  { name: "Haiku catalog omits effort", model: "claude-haiku-5-5", effort: "low", noEffort: true, expected: 0 },
  { name: "default Haiku", model: "claude-haiku-4-5-20251001", effort: "default", expected: 0 },
  { name: "unlisted Mythos", model: "claude-mythos-5-2", effort: "high", scope: "Fable", offered: "claude-fable-5-2", expected: 0 },
  { name: "unsupported explicit effort", model: "claude-opus-5-5", effort: "low", offeredEffort: "high", expected: 0 },
  { name: "missing Fable quota", model: "claude-fable-5-2", effort: "high", expected: 0 },
  { name: "spent Sonnet scope", model: "claude-sonnet-4-6", effort: "medium", scope: "Sonnet", used: 100, expected: 0 },
  { name: "malformed Opus quota", model: "claude-opus-5-5", effort: "high", window: "seven_day_opus", used: -1, expected: 0 },
  { name: "expired credentials", model: "claude-opus-5-5", effort: "high", expired: true, expected: 0 },
  { name: "quota from a replaced credential", model: "claude-opus-5-5", effort: "high", replaced: true, expected: 0 },
  { name: "paid usage", model: "claude-opus-5-5", effort: "high", paid: true, expected: 0 },
  { name: "unknown paid usage status", model: "claude-opus-5-5", effort: "high", unknownPaid: true, expected: 0 },
  { name: "immediate paid routing policy", model: "claude-opus-5-5", effort: "high", immediatePaid: true, expected: 0 },
  { name: "manual exclusion", model: "claude-opus-5-5", effort: "high", excluded: true, expected: 0 },
  { name: "CVP requirement", model: "claude-opus-5-5", effort: "high", header: ["x-meridian-require", "cvp"], expected: 0 },
  { name: "manual pin", model: "claude-opus-5-5", effort: "high", header: ["x-meridian-profile", "return-work"], expected: 0 },
  { name: "cybersec-preserved by default", model: "claude-opus-5-5", effort: "high", window: "seven_day_opus", preserved: true, expected: 0 },
  { name: "cybersec-preserved with preservation on", model: "claude-opus-5-5", effort: "high", window: "seven_day_opus", preserved: true, header: ["x-meridian-cybersec-preservation", "on"], expected: 0 },
  { name: "cybersec-preserved with preservation off", model: "claude-opus-5-5", effort: "high", window: "seven_day_opus", preserved: true, header: ["x-meridian-cybersec-preservation", "Off"], expected: 0.25 },
  { name: "unknown preservation value", model: "claude-opus-5-5", effort: "high", window: "seven_day_opus", header: ["x-meridian-cybersec-preservation", "maybe"], expected: 0 },
  { name: "cold catalog shared with pinned model list", model: "claude-sonnet-4-6", effort: "medium", cold: true, expected: 1 - 0.7 },
])("attests only exact available Claude routes over loopback: $name", async ({ model, effort, window, scope, offered, offeredEffort, noEffort, used = 75, expired, replaced, header, sdkBucket, paid, unknownPaid, immediatePaid, excluded, preserved, cold, expected }) => {
  const root = await mkdtemp(join(tmpdir(), "meridian-return-"))
  const dir = join(root, "work")
  const profileId = "return-work"
  const resetsAt = new Date(Date.now() + 60 * 60_000).toISOString()
  const expiresAt = Date.now() + DAY
  const credentials = { claudeAiOauth: { accessToken: "fixture", refreshToken: "fixture", expiresAt } }
  const { app } = createProxyServer({ profiles: [{ id: profileId, claudeConfigDir: dir }, ...PROFILES], defaultProfile: profileId })
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch })
  tokens.setCredentialStorePlatformForTests("linux")
  const storeOverride = spyOn(tokens, "createPlatformCredentialStore").mockImplementation(options =>
    createOwnedCredentialStore(root, options?.claudeConfigDir))
  const network = globalThis.fetch
  let catalogReads = 0
  try {
    if (immediatePaid) process.env.MERIDIAN_CLAUDE_EXTRA_USAGE = "immediately"
    await mkdir(dir)
    await writeFile(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { ...credentials.claudeAiOauth,
      accessToken: replaced ? "replacement-fixture" : "fixture", expiresAt: expired ? Date.now() - 1 : expiresAt } }))
    const sample = await fetchOAuthUsage({ profileId, force: true,
      store: { read: async () => credentials,
        write: async () => { throw new Error("availability fixture must not renew credentials") } },
      fetchImpl: async () => Response.json({ five_hour: { utilization: 30, resets_at: resetsAt },
        seven_day: { utilization: 70, resets_at: resetsAt },
        extra_usage: unknownPaid ? {} : { is_enabled: paid === true },
        ...(window ? { [window]: { utilization: used, resets_at: resetsAt } } : {}),
        ...(scope ? { limits: [{ kind: "weekly_scoped", scope: { model: { display_name: scope } }, percent: used, resets_at: resetsAt }] } : {}),
      }),
    })
    if (excluded) setSetting("routingExcludedProfiles", [profileId])
    if (preserved) expect((await setFleetEvidence(app, { [profileId]: "cybersec-preserved" })).status).toBe(200)
    if (sdkBucket || paid) rateLimitStore.record(profileId, {
      status: sdkBucket ? "rejected" : "allowed", rateLimitType: sdkBucket ?? "five_hour",
      utilization: sdkBucket ? 1 : 0.3, resetsAt: Date.parse(resetsAt), isUsingOverage: paid,
    }, (sample?.fetchedAt ?? Date.now()) + 1)
    const catalog = () => Response.json({ data: [{ id: offered ?? model,
      ...(noEffort ? {} : { capabilities: { effort: { supported: true, [offeredEffort ?? effort]: { supported: true } } } }) }] })
    globalThis.fetch = Object.assign(async (...args: Parameters<typeof fetch>) => {
      if (String(args[0]).startsWith(listener.url.origin)) return network(...args)
      if (!cold || !String(args[0]).startsWith("https://api.anthropic.com/v1/models?") ||
        new Headers(args[1]?.headers).get("authorization") !== "Bearer fixture") {
        throw new Error("Unexpected non-loopback request in route availability test")
      }
      catalogReads++
      return catalog()
    }, { preconnect: network.preconnect })
    if (!cold) await fetchAccountModels({ cacheKey: profileId, auth: async () => ({ Authorization: "Bearer fixture" }), fetchImpl: async () => catalog() })

    const url = new URL("/profiles/route-availability", listener.url)
    url.search = new URLSearchParams({ provider: "claude", model, variant: effort }).toString()
    if (cold) {
      expect(await (await fetch(url)).json()).toMatchObject({ available: false, observed_at: null })
      const listed = await fetch(new URL("/v1/models", listener.url), { headers: { "x-meridian-profile": profileId } })
      expect(listed.headers.get("x-meridian-models-source")).toBe("account")
      expect(await listed.json()).toMatchObject({ data: [{ id: model }] })
      expect(catalogReads).toBe(1)
    }
    const headers = new Headers()
    if (header) headers.set(header[0], header[1])
    const res = await fetch(url, { headers })

    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(await res.json()).toEqual({ version: 1, provider: "claude", model, variant: effort,
      available: expected > 0, routable_allotment: expected, observed_at: expected > 0 ? sample?.fetchedAt : null })
    expect(sdkCalls).toBe(0)
  } finally {
    globalThis.fetch = network
    await listener.stop(true)
    storeOverride.mockRestore()
    tokens.setCredentialStorePlatformForTests(null)
    clearOAuthUsageForProfile(profileId)
    clearAccountModels(profileId)
    await rm(root, { recursive: true, force: true })
  }
})

it.each(["gpt-6-sol", "sonnet", "claude-sonnet-test"])("keeps the ordinary quota refusal but does not attest Claude origin for %s", async (model) => {
  process.env.MERIDIAN_CLAUDE_EXTRA_USAGE = "never"
  const app = createTestApp()
  const now = Date.now()
  for (const { id } of PROFILES) {
    rateLimitStore.record(id, { status: "allowed", rateLimitType: "seven_day", utilization: 0.97, resetsAt: now + DAY })
  }
  const reserve = { seven_day: { floor: 95, ceiling: 95 } }
  setSetting("usageReserves", { work: reserve, personal: reserve, spare: reserve })

  const res = await post(app, { model, stream: true, attest: true, requestId: "aba6ca87-82f1-49ed-8905-329ff6b25931" })

  expect(res.status).toBe(429)
  const error = await errorOf(res)
  expect(error.code).toBe("no_routable_account")
  expect(error.route_refusal).toBeUndefined()
  expect(sdkCalls).toBe(0)
})

describe("no_routable_account when every candidate is held back", () => {
  const FLAT_WEEK_95 = { seven_day: { floor: 95, ceiling: 95 } }
  const REQUEST_ID = "73f3a376-4d3a-4efa-ae91-d4aff18d898d"

  function holdEveryProfile(): void {
    setSetting("usageReserves", { work: FLAT_WEEK_95, personal: FLAT_WEEK_95, spare: FLAT_WEEK_95 })
    for (const [id, days] of [["work", 3], ["personal", 2], ["spare", 4]] as const) {
      rateLimitStore.record(id, { status: "allowed", rateLimitType: "seven_day", utilization: 0.97, resetsAt: Date.now() + days * DAY })
    }
  }

  it("names every profile reserve_held and opens at the soonest reserve under pool routing", async () => {
    holdEveryProfile()
    const app = createTestApp()

    const res = await post(app)

    expect(res.status).toBe(429)
    expect(res.headers.get("retry-after")).not.toBeNull()
    const error = await errorOf(res)
    expectContractShape(error)
    expect(error.profiles!.map(p => [p.id, p.reason]).sort()).toEqual([["personal", "reserve_held"], ["spare", "reserve_held"], ["work", "reserve_held"]])
    const personal = error.profiles!.find(p => p.id === "personal")!
    expect(error.reset_at).toBe(personal.resets_at)
    expect(error.route_refusal).toBeUndefined()
  })

  it("attests an unsent streaming request held by every pool reserve in the HTTP refusal", async () => {
    holdEveryProfile()
    const app = createTestApp()

    const res = await post(app, { stream: true, requestId: REQUEST_ID, attest: true })

    expect(res.status).toBe(429)
    const error = await errorOf(res)
    expect(error.request_id).toBe(REQUEST_ID)
    expect(error.route_refusal).toEqual({
      version: 1,
      phase: "before_inference",
      sent: false,
      provider: "claude",
      model: "claude-sonnet-4-5",
      reason: "reserve_held",
    })
  })

  it("does not attest a pinned request when the named seat is held", async () => {
    holdEveryProfile()
    const app = createTestApp()

    const res = await post(app, { stream: true, requestId: REQUEST_ID, profile: "work", attest: true })

    expect(res.status).toBe(429)
    expect((await errorOf(res)).route_refusal).toBeUndefined()
  })

  it("does not attest a mixed reserve and exclusion refusal", async () => {
    holdEveryProfile()
    setSetting("routingExcludedProfiles", ["spare"])
    const app = createTestApp()

    const res = await post(app, { stream: true, requestId: REQUEST_ID, attest: true })

    expect(res.status).toBe(429)
    const error = await errorOf(res)
    expect(error.profiles?.map(p => p.reason).sort()).toEqual(["excluded", "reserve_held", "reserve_held"])
    expect(error.route_refusal).toBeUndefined()
  })

  it("tries the remaining permitted account instead of attesting pool exhaustion", async () => {
    holdEveryProfile()
    setSetting("usageReserves", { work: FLAT_WEEK_95, personal: FLAT_WEEK_95 })
    const app = createTestApp()

    const res = await post(app, { requestId: REQUEST_ID, attest: true })

    expect(res.status).toBe(200)
    expect(await res.text()).toContain("ok from /tmp/meridian-nr-spare")
  })

  it("does the same for unpinned work in plain active mode", async () => {
    process.env.MERIDIAN_ROUTING = "active"
    holdEveryProfile()
    const app = createTestApp()

    const res = await post(app)

    expect(res.status).toBe(429)
    const error = await errorOf(res)
    expectContractShape(error)
    expect(error.profiles!.every(p => p.reason === "reserve_held")).toBe(true)
  })

  it("names weekly_held when every profile holds its weekly reserve", async () => {
    process.env.MERIDIAN_WEEKLY_RESERVE = "work=10,personal=10,spare=10"
    for (const id of ["work", "personal", "spare"]) {
      rateLimitStore.record(id, { status: "allowed", rateLimitType: "seven_day", utilization: 0.95, resetsAt: Date.now() + 2 * DAY })
    }
    const app = createTestApp()

    const error = await errorOf(await post(app))

    expectContractShape(error)
    expect(error.profiles!.every(p => p.reason === "weekly_held" && p.resets_at !== null)).toBe(true)
  })

  it("names extra_usage_off when every profile would draw Extra Usage and the policy is never", async () => {
    process.env.MERIDIAN_CLAUDE_EXTRA_USAGE = "never"
    for (const id of ["work", "personal", "spare"]) {
      rateLimitStore.record(id, { status: "allowed", rateLimitType: "five_hour", utilization: 1, isUsingOverage: true, resetsAt: Date.now() + 3_600_000 })
    }
    const app = createTestApp()

    const error = await errorOf(await post(app))

    expectContractShape(error)
    expect(error.profiles!.every(p => p.reason === "extra_usage_off")).toBe(true)
  })
})

describe("the pool incident on /profiles/events", () => {
  it("opens on the first exhaustion, carries through the next, and closes with pool_recovered when an account serves", async () => {
    for (const dir of ALL_DIRS) failingDirs.add(dir)
    const app = createTestApp()

    const first = await errorOf(await post(app, { content: "first exhaustion" }))
    const second = await errorOf(await post(app, { content: "second exhaustion" }))
    expect(second.incident_id).toBe(first.incident_id!)
    expect(second.request_id).not.toBe(first.request_id!)

    const exhausted = (await events(app)).filter(e => e.kind === "pool_exhausted")
    expect(exhausted).toHaveLength(2)
    expect(exhausted.map(e => e.incidentId)).toEqual([first.incident_id!, first.incident_id!])
    expect(exhausted.map(e => e.requestId)).toEqual([first.request_id!, second.request_id!])
    // The id is the first exhaustion's own time and seq.
    expect(first.incident_id).toBe(`inc_${(exhausted[0] as PoolEvent & { at: number }).at}_${exhausted[0]!.seq}`)
    expect(exhausted[0]!.resetAt).toBe(first.reset_at!)
    expect(exhausted[0]!.profiles).toEqual(first.profiles!.map(p => ({ id: p.id, reason: p.reason, resetsAt: p.resets_at })))

    failingDirs.clear()
    expect((await post(app, { content: "served again" })).status).toBe(200)
    const recovered = (await events(app)).filter(e => e.kind === "pool_recovered")
    expect(recovered).toHaveLength(1)
    expect(recovered[0]!.incidentId).toBe(first.incident_id!)
    expect(recovered[0]!.servedBy).toBe("work")

    // Only the first served request closes it.
    expect((await post(app, { content: "served once more" })).status).toBe(200)
    expect((await events(app)).filter(e => e.kind === "pool_recovered")).toHaveLength(1)

    // The next outage is a new incident.
    for (const dir of ALL_DIRS) failingDirs.add(dir)
    const later = await errorOf(await post(app, { content: "later exhaustion" }))
    expect(later.incident_id).not.toBe(first.incident_id!)
  }, 60_000)
})

describe("no_routable_account when the supervisor's exclusions empty the pool", () => {
  it.each([
    ["fresh full fleet evidence", 0, "spent", 200, true],
    ["stale fleet evidence", 120_001, "spent", 200, false],
    ["hand hold", 0, "held", 400, false],
    ["needs login", 0, "logged-out", 400, false],
  ] as const)("attests only a fresh capacity/protection exclusion set: %s", async (_name, age, reason, status, attests) => {
    const app = createTestApp()
    setSetting("routingManagedExcludedProfiles", ["work", "personal", "spare"])
    const update = await setFleetEvidence(app, { work: reason, personal: "weekly-reserve", spare: "unmeasured-loaner-cap" }, Date.now() - age)
    expect(update.status).toBe(status)

    const refused = await post(app, { stream: true, attest: true, requestId: "542acae5-5ad5-4a5b-8a40-6b78a9ea3e47" })

    expect(refused.status).toBe(429)
    const error = await errorOf(refused)
    expect(error.code).toBe("no_routable_account")
    if (attests) expect(error.route_refusal).toMatchObject({ sent: false, reason: "quota_exhausted" })
    else expect(error.route_refusal).toBeUndefined()
    expect(sdkCalls).toBe(0)
  })

  for (const routing of ["active", "active+priority"]) {
    it(`answers 429 instead of no_eligible_profiles under ${routing}, naming each profile excluded`, async () => {
      process.env.MERIDIAN_ROUTING = routing
      setSetting("routingExcludedProfiles", ["spare"])
      setSetting("routingManagedExcludedProfiles", ["work", "personal"])
      const resetsAt = Date.now() + 2 * 3_600_000
      rateLimitStore.record("work", { status: "rejected", rateLimitType: "five_hour", utilization: 1, resetsAt })
      const app = createTestApp()

      const res = await post(app, { content: `managed exclusion ${routing}` })

      expect(res.status).toBe(429)
      expect(res.headers.get("retry-after")).not.toBeNull()
      const error = await errorOf(res)
      expectContractShape(error)
      expect(error.profiles!.map(p => [p.id, p.reason]).sort()).toEqual([["personal", "excluded"], ["spare", "excluded"], ["work", "excluded"]])
      // A profile's known usage reset, else null.
      const work = error.profiles!.find(p => p.id === "work")!
      expect(Date.parse(work.resets_at!)).toBe(resetsAt)
      expect(error.profiles!.find(p => p.id === "personal")!.resets_at).toBeNull()
      expect(error.reset_at).toBe(work.resets_at)
      const exhausted = (await events(app)).filter(e => e.kind === "pool_exhausted")
      expect(exhausted.map(e => e.incidentId)).toEqual([error.incident_id!])
    })
  }

  it("keeps 503 no_eligible_profiles when the user's own exclusions alone empty the pool", async () => {
    setSetting("routingExcludedProfiles", ["work", "personal", "spare"])
    setSetting("routingManagedExcludedProfiles", ["work"])
    const app = createTestApp()

    const res = await post(app, { content: "manual exclusion only" })

    expect(res.status).toBe(503)
    expect((await errorOf(res)).type).toBe("no_eligible_profiles")
    expect((await events(app)).map(e => e.kind)).not.toContain("pool_exhausted")
  })

  it("advertises the behaviour on GET /settings/api/routing", async () => {
    const res = await createTestApp().fetch(new Request("http://localhost/settings/api/routing"))
    const body = await res.json() as { capabilities?: string[] }
    expect(body.capabilities).toContain("managed-exclusion-no-routable")
  })
})

function putEvidence(app: TestApp, managed: string[], reasons: Record<string, string>, observedAt = Date.now()) {
  return app.fetch(new Request("http://localhost/settings/api/routing", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ routingManagedExcludedProfiles: managed,
      routingManagedExclusionEvidence: { version: 1, observedAt, reasons } }),
  }))
}

describe("cybersec-preserved managed exclusion evidence", () => {
  const ATTEST = { stream: true, attest: true, requestId: "0c4b7e2a-9d15-4f3e-a6b8-2e7d1c5f9a40" }

  it("covers preserved holders so an all-excluded pool whose others are spent attests, without naming a holder's reset", async () => {
    const holderReset = Date.now() + 30 * 60_000
    rateLimitStore.record("work", { status: "rejected", rateLimitType: "seven_day", utilization: 1, resetsAt: holderReset })
    const app = createTestApp()
    expect((await putEvidence(app, ["work", "personal", "spare"], { work: "cybersec-preserved", personal: "spent", spare: "weekly-reserve" })).status).toBe(200)

    const res = await post(app, ATTEST)

    expect(res.status).toBe(429)
    const error = await errorOf(res)
    expect(error.code).toBe("no_routable_account")
    expect(error.route_refusal).toMatchObject({ sent: false, reason: "quota_exhausted" })
    expect(error.profiles!.find(p => p.id === "work")).toEqual({ id: "work", reason: "excluded", resets_at: null })
    expect(!error.reset_at || Date.parse(error.reset_at) !== holderReset).toBe(true)
    expect(sdkCalls).toBe(0)
  })

  it("attests over the pool when the non-holders are freshly spent and the holders preserved", async () => {
    process.env.MERIDIAN_CLAUDE_EXTRA_USAGE = "never"
    const now = Date.now()
    for (const id of ["personal", "spare"]) {
      rateLimitStore.record(id, { status: "rejected", rateLimitType: "five_hour", utilization: 1, resetsAt: now + 3_600_000 }, now)
    }
    const app = createTestApp()
    expect((await putEvidence(app, ["work"], { work: "cybersec-preserved" })).status).toBe(200)

    const res = await post(app, ATTEST)

    expect(res.status).toBe(429)
    const error = await errorOf(res)
    expect(error.route_refusal).toMatchObject({ sent: false, reason: "quota_exhausted" })
    expect(sdkCalls).toBe(0)
  })

  it("still blocks the attestation for a managed-excluded holder carrying no reason", async () => {
    const app = createTestApp()
    expect((await putEvidence(app, ["work", "personal", "spare"], { work: "cybersec-preserved", spare: "spent" })).status).toBe(200)

    const res = await post(app, ATTEST)

    expect(res.status).toBe(429)
    expect((await errorOf(res)).route_refusal).toBeUndefined()
    expect(sdkCalls).toBe(0)
  })

  it("does not attest quota exhaustion when every account is only preserved", async () => {
    const app = createTestApp()
    expect((await putEvidence(app, ["work", "personal", "spare"], { work: "cybersec-preserved", personal: "cybersec-preserved", spare: "cybersec-preserved" })).status).toBe(200)

    const res = await post(app, ATTEST)

    expect(res.status).toBe(429)
    expect((await errorOf(res)).route_refusal).toBeUndefined()
  })

  it("rejects the whole payload on an unknown reason beside it", async () => {
    setSetting("routingManagedExcludedProfiles", ["work", "personal", "spare"])
    const app = createTestApp()

    const update = await putEvidence(app, ["work", "personal", "spare"], { work: "cybersec-preserved", personal: "spent", spare: "on-holiday" })

    expect(update.status).toBe(400)
    const res = await post(app, ATTEST)
    expect(res.status).toBe(429)
    expect((await errorOf(res)).route_refusal).toBeUndefined()
  })

  it("never makes a preserved holder routable for unflagged work", async () => {
    const app = createTestApp()
    expect((await putEvidence(app, ["work"], { work: "cybersec-preserved" })).status).toBe(200)

    const res = await post(app, { content: "plain work beside a preserved holder" })

    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain("nr-personal")
    expect(text).not.toContain("nr-work")
  })

  it("advertises managed-exclusion-cybersec-preserved", async () => {
    const res = await createTestApp().fetch(new Request("http://localhost/settings/api/routing"))
    const body = await res.json() as { capabilities?: string[] }
    expect(body.capabilities).toEqual(expect.arrayContaining(["managed-exclusion-evidence-v1", "managed-exclusion-cybersec-preserved"]))
  })
})

describe("plain active mode", () => {
  it("still answers a refusal with the account's own error, outside any incident", async () => {
    process.env.MERIDIAN_ROUTING = "active"
    failingDirs.add("nr-work")
    const app = createTestApp()

    const res = await post(app)

    expect(res.status).toBe(429)
    const error = await errorOf(res)
    expect(error.type).toBe("rate_limit_error")
    expect(error.code).toBeUndefined()
    expect(error.message.startsWith(PREFIX)).toBe(false)
    expect((await events(app)).map(e => e.kind)).not.toContain("pool_exhausted")
  }, 20_000)
})
