/**
 * The banked-reset auto-redeem policy (chatgpt/resetPolicy.ts), the
 * scheduler that acts on it (chatgpt/resetScheduler.ts), and the redeemer's
 * outcomes it depends on (chatgpt/resetRedeem.ts), against a fake chatgpt.com.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { planSeatReset, type ResetAutoRedeemSettings, type SeatResetInput } from "../proxy/chatgpt/resetPolicy"
import { createResetRedeemer, RESET_RETRY_AFTER_REFUSAL_MS, resetCreditKey, type ResetAttempt } from "../proxy/chatgpt/resetRedeem"
import { createResetScheduler, type ResetEvent } from "../proxy/chatgpt/resetScheduler"
import { redeemRequestId } from "../proxy/chatgpt/resetCredits"
import type { CodexUsageWindow } from "../proxy/codex/types"

const HOUR = 3_600_000
const DAY = 24 * HOUR
const NOW = Date.UTC(2026, 10, 28, 12)
const SEAT = "user-1__workspace-1"
const SETTINGS: ResetAutoRedeemSettings = { enabled: true, nearEmptyPoints: 0.5, safetyMarginHours: 2, askAheadHours: 6 }

const weekly = (utilization: number, resetsIn: number): CodexUsageWindow => ({ type: "7d", utilization, resetsAt: NOW + resetsIn, limitWindowSeconds: 604_800 })
const fiveHour = (utilization: number): CodexUsageWindow => ({ type: "5h", utilization, resetsAt: NOW + HOUR, limitWindowSeconds: 18_000 })
const credit = (id: string, expiresIn: number) => ({ id, status: "available", expiresAt: NOW + expiresIn })

function input(over: Partial<SeatResetInput> = {}): SeatResetInput {
  return {
    seat: SEAT, windows: [weekly(0.5, 4 * DAY)], credits: [credit("c-1", 2 * DAY)], applicable: 0,
    attempts: [], decisions: {}, settings: SETTINGS, now: NOW, ...over,
  }
}
const attempt = (id: string, outcome: ResetAttempt["outcome"], at: number): ResetAttempt => ({
  creditKey: resetCreditKey(SEAT, id), seat: SEAT, expiresAt: NOW + 2 * DAY, trigger: "usage", attemptedAt: at, outcome, error: null, settledAt: at,
})

describe("planSeatReset", () => {
  it("redeems at once a seat that is out and renews after the reset's deadline", () => {
    const plan = planSeatReset(input({ windows: [weekly(1, 4 * DAY)] }))
    expect(plan).toMatchObject({ trigger: "usage", due: true, earliestRedeemAt: NOW, deadlineAt: NOW + 2 * DAY - 2 * HOUR, decision: "pending" })
    expect(plan.next).toEqual({ creditKey: resetCreditKey(SEAT, "c-1"), expiresAt: NOW + 2 * DAY })
  })

  it("treats 0.5 points left as out, and 1 point left as not yet", () => {
    expect(planSeatReset(input({ windows: [weekly(0.995, 4 * DAY)] }))).toMatchObject({ trigger: "usage", due: true })
    expect(planSeatReset(input({ windows: [weekly(0.99, 4 * DAY)] })).due).toBe(false)
  })

  it("waits for the deadline when the seat renews before it, however empty it is", () => {
    const plan = planSeatReset(input({ windows: [weekly(1, 5 * HOUR)] }))
    expect(plan).toMatchObject({ trigger: "deadline", due: false, earliestRedeemAt: NOW + 2 * DAY - 2 * HOUR })
    expect(plan.reason).toContain("before the reset's deadline")
  })

  it("never lets a 5-hour window trigger", () => {
    expect(planSeatReset(input({ windows: [fiveHour(1), weekly(0.3, 4 * DAY)] }))).toMatchObject({ trigger: "deadline", due: false })
  })

  it("redeems at the deadline whatever the usage", () => {
    expect(planSeatReset(input({ windows: [weekly(0.1, 4 * DAY)], credits: [credit("c-1", HOUR)] }))).toMatchObject({ trigger: "deadline", due: true })
  })

  it("projects the usage trigger from the window's pace", () => {
    // The 7-day window started 3 days ago and is 75% used: at that pace the last 25 points go in about a day.
    const plan = planSeatReset(input({ windows: [weekly(0.75, 4 * DAY)], credits: [credit("c-1", 3 * DAY)] }))
    expect(plan.trigger).toBe("usage")
    expect(plan.due).toBe(false)
    expect(plan.earliestRedeemAt).toBeGreaterThan(NOW + 0.9 * DAY)
    expect(plan.earliestRedeemAt).toBeLessThan(NOW + 1.1 * DAY)
  })

  it("plans the soonest reset, skipping a prevented one and one that may have been spent", () => {
    const plan = planSeatReset(input({
      windows: [weekly(1, 6 * DAY)],
      credits: [credit("c-a", DAY), credit("c-b", 2 * DAY), credit("c-c", 3 * DAY)],
      decisions: { [resetCreditKey(SEAT, "c-a")]: "prevent" },
      attempts: [attempt("c-b", "indeterminate", NOW - HOUR)],
    }))
    expect(plan.next?.creditKey).toBe(resetCreditKey(SEAT, "c-c"))
  })

  it("tries a refused reset again half an hour after the refusal", () => {
    const refused = [attempt("c-1", "not_applicable", NOW - 10 * 60_000)]
    const plan = planSeatReset(input({ windows: [weekly(1, 4 * DAY)], attempts: refused }))
    expect(plan).toMatchObject({ trigger: "usage", due: false, earliestRedeemAt: NOW - 10 * 60_000 + RESET_RETRY_AFTER_REFUSAL_MS })
    expect(plan.lastAttempt?.outcome).toBe("not_applicable")
    expect(planSeatReset(input({ windows: [weekly(1, 4 * DAY)], attempts: refused, now: NOW + 25 * 60_000 })).due).toBe(true)
  })

  it("plans no retry the reset would not live to see", () => {
    const plan = planSeatReset(input({ credits: [credit("c-1", 15 * 60_000)], attempts: [attempt("c-1", "not_applicable", NOW - 60_000)] }))
    expect(plan).toMatchObject({ trigger: "none", due: false })
    expect(plan.reason).toContain("before another")
  })

  it("plans even with auto-redeem off, and reports the decision", () => {
    const key = resetCreditKey(SEAT, "c-1")
    const plan = planSeatReset(input({ windows: [weekly(1, 4 * DAY)], settings: { ...SETTINGS, enabled: false }, decisions: { [key]: "approve" } }))
    expect(plan).toMatchObject({ trigger: "usage", due: true, decision: "approved" })
  })

  it("says why there is nothing to plan", () => {
    expect(planSeatReset(input({ credits: null }))).toMatchObject({ trigger: "none", next: null, reason: "ChatGPT did not list this seat's resets." })
    expect(planSeatReset(input({ credits: [] }))).toMatchObject({ trigger: "none", reason: "This seat has no banked reset." })
  })
})

const LIST_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits"
const CONSUME_URL = `${LIST_URL}/consume`
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"
const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
const TOKEN = `${part({ alg: "none" })}.${part({
  exp: Math.floor(NOW / 1000) + 3600,
  "https://api.openai.com/auth": { chatgpt_account_id: "workspace-1", chatgpt_account_user_id: SEAT, chatgpt_user_id: "user-1" },
})}.sig`

/** A chatgpt.com whose consume does what `consume` says; usage follows `used` (percent). */
function chatgpt(consume: () => { status: number; body: unknown; spend: boolean; clear: boolean }, used = 100, limited = true) {
  let credits = [{ id: "c-1", status: "available", expires_at: new Date(NOW + 2 * DAY).toISOString() }]
  let percent = used
  const keys: string[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url === LIST_URL) return Response.json({ available_count: credits.length, credits })
    if (url === USAGE_URL) {
      return Response.json({
        user_id: "user-1", account_id: "workspace-1",
        rate_limit: { limit_reached: limited && percent >= 100, primary_window: { used_percent: percent, limit_window_seconds: 604_800, reset_at: Math.floor((NOW + 4 * DAY) / 1000) } },
        rate_limit_reset_credits: { available_count: credits.length, applicable_available_count: limited && percent >= 100 ? credits.length : 0 },
      })
    }
    if (url === CONSUME_URL) {
      keys.push((JSON.parse(String(init?.body)) as { redeem_request_id: string }).redeem_request_id)
      const answer = consume()
      if (answer.spend) credits = []
      if (answer.clear) percent = 0
      return Response.json(answer.body, { status: answer.status })
    }
    return new Response("{}", { status: 404 })
  }) as typeof fetch
  return { fetchImpl, keys }
}

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "chatgpt-reset-policy-")) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

let ledgers = 0
function redeemer(fetchImpl: typeof fetch, now: () => number) {
  return createResetRedeemer({
    source: { credentials: async seat => ({ ok: true, account: { accountUserId: seat, accountId: "workspace-1", accessToken: TOKEN } }) },
    ledgerPath: join(dir, `ledger-${++ledgers}.json`), canRedeem: () => true, fetchImpl, now,
  })
}

describe("redeemer outcomes", () => {
  it("records a refusal ChatGPT counted no reset applicable for as not_applicable, and retries it with a key of its own", async () => {
    let clock = NOW
    const fake = chatgpt(() => ({ status: 409, body: { code: "not_applicable" }, spend: false, clear: false }), 100, false)
    const target = redeemer(fake.fetchImpl, () => clock)
    expect(await target.redeem(SEAT, "usage")).toMatchObject({ kind: "failed", outcome: "not_applicable", indeterminate: false })
    expect(await target.redeem(SEAT, "usage")).toEqual({ kind: "no_credit", available: 1 })
    clock += RESET_RETRY_AFTER_REFUSAL_MS
    expect(await target.redeem(SEAT, "usage")).toMatchObject({ outcome: "not_applicable" })
    expect(fake.keys).toEqual([redeemRequestId("c-1"), redeemRequestId("c-1#1")])
  })

  it("calls a reset that went but cleared nothing spent_without_reset", async () => {
    const fake = chatgpt(() => ({ status: 200, body: { code: "ok", windows_reset: [] }, spend: true, clear: false }))
    const result = await redeemer(fake.fetchImpl, () => NOW).redeem(SEAT, "usage")
    expect(result).toMatchObject({ kind: "failed", outcome: "spent_without_reset", indeterminate: false })
    expect((result as { error: string }).error).toContain("100% before and 100% after")
  })

  it("redeems one that clears the window", async () => {
    const fake = chatgpt(() => ({ status: 200, body: { code: "ok", windows_reset: ["primary"] }, spend: true, clear: true }))
    expect(await redeemer(fake.fetchImpl, () => NOW).redeem(SEAT, "usage")).toMatchObject({ kind: "redeemed", remaining: 0 })
  })
})

describe("the reset scheduler", () => {
  function scheduler(fake: ReturnType<typeof chatgpt>, options: { enabled?: boolean; used?: number; expiresIn?: number; now?: () => number } = {}) {
    const now = options.now ?? (() => NOW)
    const events: ResetEvent[] = []
    const redeemed: string[] = []
    const target = redeemer(fake.fetchImpl, now)
    const sched = createResetScheduler({
      redeemer: target,
      readings: () => [{ seat: SEAT, windows: [weekly((options.used ?? 100) / 100, 4 * DAY)], credits: [credit("c-1", options.expiresIn ?? 2 * DAY)], applicable: 0 }],
      settings: () => ({ ...SETTINGS, enabled: options.enabled ?? true }),
      emit: event => events.push(event),
      redeemed: async seat => { redeemed.push(seat) },
      now,
    })
    return { sched, events, redeemed, target }
  }

  it("announces the plan once, redeems what is due, and lifts the seat", async () => {
    const fake = chatgpt(() => ({ status: 200, body: { code: "ok", windows_reset: ["primary"] }, spend: true, clear: true }))
    const { sched, events, redeemed } = scheduler(fake)
    await sched.tick()
    expect(events.map(e => [e.kind, e.trigger, e.outcome])).toEqual([["reset_planned", "usage", null], ["reset_redeemed", "usage", "redeemed"]])
    expect(redeemed).toEqual([SEAT])
  })

  it("only plans while auto-redeem is off, and does not repeat an unchanged plan", async () => {
    const fake = chatgpt(() => { throw new Error("must not consume") })
    const { sched, events } = scheduler(fake, { enabled: false })
    await sched.tick()
    await sched.tick()
    expect(events.map(e => e.kind)).toEqual(["reset_planned"])
    expect(fake.keys).toEqual([])
  })

  it("keeps quiet about a not_applicable refusal before the last chance, and reports it at the deadline", async () => {
    const quiet = scheduler(chatgpt(() => ({ status: 409, body: {}, spend: false, clear: false }), 100, false))
    await quiet.sched.tick()
    expect(quiet.events.map(e => e.kind)).toEqual(["reset_planned"])

    const last = scheduler(chatgpt(() => ({ status: 409, body: {}, spend: false, clear: false }), 100, false), { used: 20, expiresIn: 20 * 60_000 })
    await last.sched.tick()
    expect(last.events.map(e => [e.kind, e.trigger, e.outcome])).toEqual([["reset_planned", "deadline", null], ["reset_redeem_failed", "deadline", "not_applicable"]])
  })

  it("reports a reset spent without clearing anything as a failure", async () => {
    const { sched, events } = scheduler(chatgpt(() => ({ status: 200, body: { windows_reset: [] }, spend: true, clear: false })))
    await sched.tick()
    expect(events.at(-1)).toMatchObject({ kind: "reset_redeem_failed", outcome: "spent_without_reset" })
  })
})
