/**
 * ChatGPT seats as profiles: ids, plan weight, window shape and routing, as
 * pure functions. The HTTP surface is covered in chatgpt-gateway.test.ts.
 */
import { describe, expect, it } from "bun:test"
import {
  chatGptOwner,
  chatGptPlanFields,
  chatGptProfileIds,
  chatGptProfiles,
  chatGptQuotaError,
  chatGptRemovalRefusal,
  chatGptResetsView,
  chatGptTokenState,
  findChatGptProfile,
  isWindowNotStarted,
  observedUsageWindows,
  planChatGptRename,
  profileWindowType,
  seatWindows,
} from "../proxy/chatgpt/profiles"
import { chatGptRefusalDiagnosis, chatGptWarmBody, createChatGptProfileSurface } from "../proxy/chatgpt/profileSurface"
import type { ChatGptCredentialSource, ChatGptSeatView } from "../proxy/chatgpt/source"
import type { CodexUsageEntry } from "../proxy/codex/types"

const NOW = 1_800_000_000_000
const seat = (id: string, email: string | null, extra: Partial<ChatGptSeatView> = {}): ChatGptSeatView => ({
  id, email, planType: "pro", eligible: true, expiresAt: null, ...extra,
})

describe("chatGptProfileIds", () => {
  it("derives email local part plus the workspace suffix, stable across order", () => {
    const seats = [seat("user-a__ws-c487c4", "Oferty@nowaker.net"), seat("user-b__ws-e1dde4", "enrique.t+x@gmail.com")]
    const ids = chatGptProfileIds(seats)
    expect([...ids.values()]).toEqual(["oferty-c487c4", "enrique.t-x-e1dde4"])
    expect(chatGptProfileIds([...seats].reverse())).toEqual(ids)
  })

  it("names a seat without an email, and splits two seats deriving one id", () => {
    const ids = chatGptProfileIds([
      seat("user-a__ws-111111", null),
      seat("user-a__x-989a40", "damian@x.test"),
      seat("user-b__y-989a40", "damian@y.test"),
    ])
    expect(ids.get("user-a__ws-111111")).toBe("seat-111111")
    const pair = [ids.get("user-a__x-989a40")!, ids.get("user-b__y-989a40")!]
    expect(pair[0]).toMatch(/^damian-989a40-[0-9a-f]{4}$/)
    expect(pair[1]).toMatch(/^damian-989a40-[0-9a-f]{4}$/)
    expect(pair[0]).not.toBe(pair[1])
  })

  it("never takes a reserved (Claude) id, and honours valid operator names only", () => {
    const seats = [seat("user-a__ws-aaaaaa", "d-dh-p@x.test"), seat("user-b__ws-bbbbbb", "b@x.test"), seat("user-c__ws-cccccc", "c@x.test")]
    const ids = chatGptProfileIds(seats, {
      reserved: new Set(["d-dh-p-aaaaaa", "kwiat-dh-p"]),
      names: { "user-b__ws-bbbbbb": "enrique-pro", "user-c__ws-cccccc": "kwiat-dh-p" },
    })
    expect(ids.get("user-a__ws-aaaaaa")).toBe("chatgpt-d-dh-p-aaaaaa")
    expect(ids.get("user-b__ws-bbbbbb")).toBe("enrique-pro")
    expect(ids.get("user-c__ws-cccccc")).toBe("c-cccccc")
  })
})

describe("chatGptPlanFields", () => {
  it("weights plans by what the slug determines, and nothing more", () => {
    expect(chatGptPlanFields("pro")).toMatchObject({ subscriptionType: "pro", planLabel: "ChatGPT Pro", planName: "Pro", accountType: "Personal", allowance: "20x", allowanceWeight: 20 })
    expect(chatGptPlanFields("self_serve_business_prolite")).toMatchObject({ allowance: "5x", allowanceWeight: 5, accountType: "Business" })
    expect(chatGptPlanFields("plus")).toMatchObject({ allowanceWeight: 1 })
    expect(chatGptPlanFields("free")).toMatchObject({ allowance: null, allowanceWeight: null })
    expect(chatGptPlanFields(null)).toEqual({ subscriptionType: null, planLabel: null, planName: null, accountType: null, allowance: null, allowanceWeight: null })
  })
})

describe("windows", () => {
  it("names windows by width in Claude's vocabulary", () => {
    expect(profileWindowType(18_000)).toBe("five_hour")
    expect(profileWindowType(604_800)).toBe("seven_day")
    expect(profileWindowType(2_592_000)).toBe("30d")
  })

  it("reads a cold window (0%, full countdown) as not started", () => {
    const cold = { type: "7d", utilization: 0, resetsAt: NOW + 604_800_000 - 2_000, limitWindowSeconds: 604_800 }
    expect(isWindowNotStarted(cold, NOW)).toBe(true)
    expect(isWindowNotStarted({ ...cold, utilization: 0.01 }, NOW)).toBe(false)
    expect(isWindowNotStarted({ ...cold, resetsAt: NOW + 3_600_000 }, NOW)).toBe(false)
  })

  it("reports a weekly-only seat as having no five_hour window, from the reading", () => {
    const usage: CodexUsageEntry = {
      id: "s", type: "codex", identity: "x", email: null, plan: null, workspaceName: null, resetCredits: null, stale: false, error: null, fetchedAt: NOW,
      windows: [{ type: "7d", utilization: 0.67, resetsAt: NOW + 86_400_000, limitWindowSeconds: 604_800 }],
    }
    const reading = seatWindows({ usage })
    expect(reading.windows).toEqual([{ type: "seven_day", utilization: 0.67, resetsAt: NOW + 86_400_000 }])
    expect(reading.windowsReported).toEqual(["seven_day"])
    expect(reading.source).toBe("usage")
  })

  it("says nothing about window shape with no reading", () => {
    expect(seatWindows({})).toEqual({ windows: [], windowsReported: null, source: null, fetchedAt: null, stale: false })
  })

  it("prefers the newer header reading, anchoring reset_after at the observation", () => {
    const usage: CodexUsageEntry = {
      id: "s", type: "codex", identity: "x", email: null, plan: null, workspaceName: null, resetCredits: null, stale: false, error: null, fetchedAt: NOW - 60_000,
      windows: [{ type: "7d", utilization: 0.1, resetsAt: NOW + 1_000, limitWindowSeconds: 604_800 }],
    }
    const observed = { at: NOW, rateLimit: {
      primary_window: { used_percent: 20, limit_window_seconds: 18_000, reset_after_seconds: 600 },
      secondary_window: { used_percent: 40, limit_window_seconds: 604_800, reset_at: (NOW + 3_600_000) / 1000 },
    } }
    expect(observedUsageWindows(observed)[0]!.resetsAt).toBe(NOW + 600_000)
    const reading = seatWindows({ usage, observed })
    expect(reading.source).toBe("headers")
    expect(reading.windowsReported).toEqual(["five_hour", "seven_day"])
    expect(reading.windows[1]).toEqual({ type: "seven_day", utilization: 0.4, resetsAt: NOW + 3_600_000 })
  })

  it("maps seat state to the switcher's error words", () => {
    expect(chatGptQuotaError("requires_reauth", null, true)).toBe("no_token")
    expect(chatGptQuotaError("expired", null, true)).toBe("token_expired")
    expect(chatGptQuotaError(null, "rate_limited", false)).toBe("rate_limited")
    expect(chatGptQuotaError(null, "rate_limited", true)).toBeNull()
  })
})

describe("refusal diagnosis", () => {
  it("names the widest spent window from the response headers", () => {
    const d = chatGptRefusalDiagnosis({ kind: "rate_limited", until: NOW + 5, rateLimit: {
      primary_window: { used_percent: 100, limit_window_seconds: 18_000 },
      secondary_window: { used_percent: 100, limit_window_seconds: 604_800 },
    } })
    expect(d).toMatchObject({ bucket: "seven_day", reported: true, source: "response_headers", resetsAt: NOW + 5 })
    expect(chatGptRefusalDiagnosis({ kind: "rate_limited", until: NOW, rateLimit: null })).toMatchObject({ bucket: null, reported: false })
    expect(chatGptRefusalDiagnosis({ kind: "requires_reauth", until: NOW, rateLimit: null }).resetsAt).toBeNull()
  })
})

describe("profile surface routing", () => {
  const seats = [
    seat("user-a__ws-aaaaaa", "a@x.test", { active: true }),
    seat("user-b__ws-bbbbbb", "b@x.test"),
    seat("user-c__ws-cccccc", "c@x.test"),
  ]
  const source = { seats: () => seats } as unknown as ChatGptCredentialSource
  const surface = (activeSeat?: string, excluded: string[] = []) => createChatGptProfileSurface({
    source, observed: () => new Map(), usage: () => null, reserved: () => new Set(), names: () => undefined,
    activeSeat: () => activeSeat, excluded: () => excluded, spent: () => undefined,
  })

  it("defaults to the owner's pick and follows the pointer once set", () => {
    expect(surface().activeProfileId()).toBe("a-aaaaaa")
    expect(surface("user-b__ws-bbbbbb").activeProfileId()).toBe("b-bbbbbb")
    expect(surface("user-b__ws-bbbbbb").route(undefined, "work")).toMatchObject({ kind: "pool", preferred: "user-b__ws-bbbbbb" })
  })

  it("never routes work to an excluded seat, and refuses to activate one", () => {
    const s = surface("user-b__ws-bbbbbb", ["b-bbbbbb"])
    expect(s.activeProfileId()).toBe("a-aaaaaa")
    const pool = s.route(undefined, "work")
    expect(pool.kind === "pool" && [...pool.excluded]).toEqual(["user-b__ws-bbbbbb"])
    expect(s.route("b-bbbbbb", "work").kind).toBe("refuse")
    expect(s.route("b-bbbbbb", "warm")).toEqual({ kind: "pinned", seat: "user-b__ws-bbbbbb" })
    expect(s.activate("b-bbbbbb")).toMatchObject({ ok: false, status: 409 })
    expect(s.activate("nope")).toMatchObject({ ok: false, status: 400 })
    expect(s.activate("user-c__ws-cccccc")).toMatchObject({ ok: true })
  })

  it("ignores a pin that names no ChatGPT seat", () => {
    expect(surface().route("kwiat-dh-p", "work").kind).toBe("pool")
  })

  it("warms with the smallest request the backend accepts", () => {
    const body = chatGptWarmBody("gpt-6-luna")
    expect(body).not.toHaveProperty("max_output_tokens")
    expect(body).toMatchObject({ model: "gpt-6-luna", stream: false, reasoning: { effort: "low" } })
  })

  it("fails over in the saved profile order, which may name seats by id, former id or seat id", () => {
    const withOrder = (order: string[]) => createChatGptProfileSurface({
      source, observed: () => new Map(), usage: () => null, reserved: () => new Set(), names: () => undefined,
      aliases: () => ({ "user-c__ws-cccccc": ["old-c"] }),
      activeSeat: () => undefined, excluded: () => [], order: () => order, spent: () => undefined,
    })
    expect(withOrder(["claude-work", "old-c", "user-b__ws-bbbbbb", "a-aaaaaa"]).route(undefined, "work"))
      .toMatchObject({ kind: "pool", order: ["user-c__ws-cccccc", "user-b__ws-bbbbbb", "user-a__ws-aaaaaa"] })
    // An order that names no seat leaves the credential owner's order alone.
    expect(withOrder(["claude-work"]).route(undefined, "work")).toMatchObject({ kind: "pool", order: undefined })
  })
})

describe("renaming a seat", () => {
  const seats = [seat("user-a__ws-aaaaaa", "a@x.test"), seat("user-b__ws-bbbbbb", "b@x.test")]
  const list = (names?: Record<string, unknown>, aliases?: Record<string, unknown>, reserved = new Set<string>()) =>
    chatGptProfiles(seats, { names, aliases, reserved })

  it("keeps each former id as an alias, and a current id always beats one", () => {
    const profiles = list({ "user-a__ws-aaaaaa": "work" }, { "user-a__ws-aaaaaa": ["a-aaaaaa", "Bad Name"], "user-b__ws-bbbbbb": ["work"] })
    expect(profiles.map(p => [p.id, p.aliases])).toEqual([["work", ["a-aaaaaa"]], ["b-bbbbbb", []]])
    expect(findChatGptProfile(profiles, "a-aaaaaa")?.seat).toBe("user-a__ws-aaaaaa")
    expect(findChatGptProfile(profiles, "work")?.seat).toBe("user-a__ws-aaaaaa")
    expect(findChatGptProfile(profiles, "user-b__ws-bbbbbb")?.id).toBe("b-bbbbbb")
  })

  it("drops an alias the moment a Claude profile is called that", () => {
    const profiles = list(undefined, { "user-a__ws-aaaaaa": ["personal"] }, new Set(["personal"]))
    expect(profiles[0]!.aliases).toEqual([])
  })

  it("plans the rename as settings to write, collapsing the chain", () => {
    const first = planChatGptRename({ profiles: list(), reserved: new Set(), names: undefined, aliases: undefined, from: "a-aaaaaa", to: "work" })
    expect(first).toEqual({
      ok: true, seat: "user-a__ws-aaaaaa", from: "a-aaaaaa", to: "work", aliases: ["a-aaaaaa"],
      names: { "user-a__ws-aaaaaa": "work" }, aliasesBySeat: { "user-a__ws-aaaaaa": ["a-aaaaaa"] },
    })
    if (!first.ok) throw new Error("unreachable")
    const renamed = list(first.names, first.aliasesBySeat)
    // A second rename, asked for by the former id, keeps both former ids.
    const second = planChatGptRename({ profiles: renamed, reserved: new Set(), names: first.names, aliases: first.aliasesBySeat, from: "a-aaaaaa", to: "work2" })
    expect(second).toMatchObject({ ok: true, from: "work", to: "work2", aliases: ["a-aaaaaa", "work"] })
    // Renaming back to a former id takes it out of the alias list.
    const back = planChatGptRename({ profiles: renamed, reserved: new Set(), names: first.names, aliases: first.aliasesBySeat, from: "work", to: "a-aaaaaa" })
    expect(back).toMatchObject({ ok: true, aliases: ["work"] })
    expect(back.ok && back.aliasesBySeat).toEqual({ "user-a__ws-aaaaaa": ["work"] })
  })

  it("takes a name another seat once had, and refuses one in use or malformed", () => {
    const profiles = list(undefined, { "user-b__ws-bbbbbb": ["shared"] })
    const taken = planChatGptRename({ profiles, reserved: new Set(), names: undefined, aliases: { "user-b__ws-bbbbbb": ["shared"] }, from: "a-aaaaaa", to: "shared" })
    expect(taken.ok && taken.aliasesBySeat).toEqual({ "user-a__ws-aaaaaa": ["a-aaaaaa"] })
    const plan = (to: string, reserved = new Set<string>()) => planChatGptRename({ profiles, reserved, names: undefined, aliases: undefined, from: "a-aaaaaa", to })
    expect(plan("b-bbbbbb")).toEqual({ ok: false, error: 'Profile "b-bbbbbb" already exists.' })
    expect(plan("personal", new Set(["personal"]))).toEqual({ ok: false, error: 'Profile "personal" already exists.' })
    expect(plan("a-aaaaaa")).toEqual({ ok: false, error: 'Profile "a-aaaaaa" is already called that.' })
    expect(plan("Work Seat")).toMatchObject({ ok: false, error: expect.stringContaining("Invalid profile name") })
    expect(planChatGptRename({ profiles, reserved: new Set(), names: undefined, aliases: undefined, from: "nobody", to: "x" }))
      .toEqual({ ok: false, error: 'Profile "nobody" not found.' })
  })
})

describe("banked resets on the card", () => {
  const resets = (extra: Partial<NonNullable<CodexUsageEntry["resetCredits"]>>) => ({
    availableCount: null, applicableAvailableCount: null, listedCount: null, credits: null, error: null, ...extra,
  })

  it("is unknown without a count, and zero is a count", () => {
    expect(chatGptResetsView(null)).toBeNull()
    expect(chatGptResetsView(resets({}))).toBeNull()
    expect(chatGptResetsView(resets({ availableCount: 1.5 }))).toBeNull()
    expect(chatGptResetsView(resets({ availableCount: 0, listedCount: 0, credits: [] }))).toEqual({ available: 0, expiresAt: [] })
  })

  it("prefers the credit list's count and lists one expiry per reset, soonest first", () => {
    const credits = [{ status: "available", expiresAt: NOW + 11 }, { status: "available", expiresAt: null }, { status: "available", expiresAt: NOW + 3 }]
    expect(chatGptResetsView(resets({ availableCount: 1, listedCount: 3, credits }))).toEqual({ available: 3, expiresAt: [NOW + 3, NOW + 11, null] })
    expect(chatGptResetsView(resets({ listedCount: 2, credits }))).toEqual({ available: 2, expiresAt: [NOW + 3, NOW + 11] })
    expect(chatGptResetsView(resets({ listedCount: 2, credits: [credits[2]!] }))).toEqual({ available: 2, expiresAt: [NOW + 3, null] })
  })

  it("falls back to the usage payload's count when the credit list could not be read", () => {
    expect(chatGptResetsView(resets({ availableCount: 2, error: "upstream_error" }))).toEqual({ available: 2, expiresAt: null })
  })
})

describe("a seat's token and owner", () => {
  it("reads the token's own state even behind an owner's quota or cooldown mark", () => {
    expect(chatGptTokenState("quota_exhausted", "token_expired")).toBe("expired")
    expect(chatGptTokenState(null, "unauthorized")).toBe("refused")
    expect(chatGptTokenState("expired", null)).toBe("expired")
    expect(chatGptTokenState("requires_reauth", null)).toBe("requires_reauth")
    expect(chatGptTokenState("cooling_down", "rate_limited")).toBe("ok")
    expect(chatGptTokenState(null, null)).toBe("ok")
  })

  it("names oc-codex-multi-auth's own commands for what Meridian will not do to a followed seat", () => {
    const owner = chatGptOwner("follow-external", 2)
    expect(owner).toEqual({
      name: "oc-codex-multi-auth", mode: "follow-external", account: 3,
      login: "opencode auth login", loginMethod: "OpenAI → Codex OAuth (ChatGPT Plus/Pro)",
      refresh: "npx -y oc-codex-multi-auth doctor --fix", refreshTool: "codex-refresh",
      remove: "codex-remove index=3 confirm=true", importCommand: null,
    })
    const refusal = chatGptRemovalRefusal({ id: "oferty-c487c4", label: "oferty@x.test · id:c487c4" }, owner)
    expect(refusal).toContain("oc-codex-multi-auth owns")
    expect(refusal).toContain("pick oferty@x.test · id:c487c4 and choose \"Delete this account\"")
    expect(refusal).toContain("check with `codex-list` that account 3 is oferty@x.test · id:c487c4 and run `codex-remove index=3 confirm=true`")
    expect(chatGptOwner("owned", 0)).toMatchObject({ name: "meridian", login: null, refresh: null, remove: null, importCommand: "meridian chatgpt-migrate --step import" })
  })
})

describe("list entries", () => {
  const seats = [
    seat("user-a__ws-aaaaaa", "a@x.test", { active: true, storeIndex: 0 }),
    seat("user-b__ws-bbbbbb", "b@x.test", { eligible: false, reason: "quota_exhausted", storeIndex: 2 }),
    seat("user-c__ws-cccccc", "c@x.test", { storeIndex: 3 }),
  ]
  const entry = (id: string, extra: Partial<CodexUsageEntry>): CodexUsageEntry => ({
    id, type: "codex", identity: id, email: null, plan: null, workspaceName: null, windows: [], resetCredits: null, fetchedAt: null, stale: false, error: null, ...extra,
  })
  const usage = {
    asOf: NOW,
    error: null,
    entries: [
      entry("user-a__ws-aaaaaa", {
        fetchedAt: NOW - 20_000,
        workspaceName: "Acme Workspace",
        resetCredits: { availableCount: 1, applicableAvailableCount: 0, listedCount: 1, credits: [{ status: "available", expiresAt: NOW + 13 * 86_400_000 }], error: null },
      }),
      entry("user-b__ws-bbbbbb", { error: "token_expired" }),
      entry("user-c__ws-cccccc", { error: "unauthorized" }),
    ],
  }
  const surface = createChatGptProfileSurface({
    source: { mode: "follow-external", seats: () => seats } as unknown as ChatGptCredentialSource,
    observed: () => new Map(), usage: () => usage, reserved: () => new Set(), names: () => undefined,
    aliases: () => ({ "user-a__ws-aaaaaa": ["old-a"] }),
    activeSeat: () => undefined, excluded: () => [], spent: () => undefined,
  })
  const [a, b, c] = surface.listEntries()

  it("carries what the card states: resets, owner, workspace, token state, former names", () => {
    expect(a).toMatchObject({
      id: "a-aaaaaa", isActive: true, loggedIn: true, tokenState: "ok", aliases: ["old-a"], organizationName: "Acme Workspace",
      resets: { available: 1, expiresAt: [NOW + 13 * 86_400_000] },
      owner: { name: "oc-codex-multi-auth", account: 1 },
      lastSuccessAt: NOW - 20_000, lastCheckedAt: NOW - 20_000,
    })
    expect(a!.removal).toContain("account 1")
    // An expired token behind a quota mark cannot serve, and says so.
    expect(b).toMatchObject({ loggedIn: false, tokenState: "expired", unavailable: "quota_exhausted", resets: null, organizationName: null, lastSuccessAt: null, lastCheckedAt: NOW })
    expect(c).toMatchObject({ loggedIn: false, tokenState: "refused", resets: null })
    expect(b).not.toHaveProperty("aliases")
  })

  it("never carries a credential", () => {
    expect(JSON.stringify(surface.listEntries())).not.toMatch(/accessToken|refreshToken|Bearer/)
  })
})
