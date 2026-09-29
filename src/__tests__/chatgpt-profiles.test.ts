/**
 * ChatGPT seats as profiles: ids, plan weight, window shape and routing, as
 * pure functions. The HTTP surface is covered in chatgpt-gateway.test.ts.
 */
import { describe, expect, it } from "bun:test"
import {
  chatGptPlanFields,
  chatGptProfileIds,
  chatGptQuotaError,
  isWindowNotStarted,
  observedUsageWindows,
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
      id: "s", type: "codex", identity: "x", email: null, plan: null, resetCredits: null, stale: false, error: null, fetchedAt: NOW,
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
      id: "s", type: "codex", identity: "x", email: null, plan: null, resetCredits: null, stale: false, error: null, fetchedAt: NOW - 60_000,
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
})
