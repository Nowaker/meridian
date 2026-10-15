/**
 * Usage reserves as pure functions: the allowance curve, when a profile is
 * held back, when the hold ends, and the readings it is drawn from.
 */
import { describe, expect, it } from "bun:test"
import {
  allHeldMessage,
  describeUsageReserveHold,
  newestClaudeWindows,
  parseUsageReserves,
  readUsageReserves,
  soonestOpening,
  usageReserveAllowancePct,
  usageReserveHold,
  usageReserveResponse,
  usageReserveStates,
  usageReserveView,
  type ReserveWindowReading,
  type UsageReserve,
} from "../proxy/usageReserve"

const NOW = 1_790_600_000_000
const HOUR = 3_600_000
const FIVE = 5 * HOUR
const WEEK = 168 * HOUR

/** A 5-hour window `t5` of the way through at `u5` used, and a week `t7` through at `u7`; null = not running. */
function at(u5: number, t5: number | null, u7: number, t7: number | null): ReserveWindowReading[] {
  return [
    { type: "five_hour", utilization: u5, resetsAt: t5 === null ? null : NOW + (1 - t5) * FIVE },
    { type: "seven_day", utilization: u7, resetsAt: t7 === null ? null : NOW + (1 - t7) * WEEK },
  ]
}

const PACED_5H: UsageReserve = { five_hour: { floor: 80, ceiling: 100 } }
const FLAT_WEEK: UsageReserve = { seven_day: { floor: 95, ceiling: 95 } }

describe("the allowance curve clamp(100t, floor, ceiling)", () => {
  const paced = { floor: 80, ceiling: 100 }

  it("allows the whole floor from the first minute of a paced window", () => {
    expect(usageReserveAllowancePct(paced, 1 / 300)).toBe(80)
  })

  it("holds at the floor until the window is that far through, then follows elapsed time", () => {
    expect(usageReserveAllowancePct(paced, 0.5)).toBe(80)
    expect(usageReserveAllowancePct(paced, 0.85)).toBe(85)
  })

  it("allows 95% at 95% of the window elapsed", () => {
    expect(usageReserveAllowancePct(paced, 0.95)).toBe(95)
  })

  it("reaches the ceiling at the reset", () => {
    expect(usageReserveAllowancePct(paced, 1)).toBe(100)
    expect(usageReserveAllowancePct({ floor: 80, ceiling: 97.5 }, 1)).toBe(97.5)
  })

  it("is the ceiling for the whole of a flat window", () => {
    for (const t of [0, 0.5, 0.99, 1]) expect(usageReserveAllowancePct({ floor: 95, ceiling: 95 }, t)).toBe(95)
  })
})

describe("holding a profile back", () => {
  it("lets a paced 5-hour window be used up to its floor in the first minute, and holds it there", () => {
    expect(usageReserveHold(at(0.79, 1 / 300, 0, 0.5), PACED_5H, NOW)).toBeNull()
    expect(usageReserveHold(at(0.8, 1 / 300, 0, 0.5), PACED_5H, NOW)).toMatchObject({ window: "five_hour", allowancePct: 80 })
  })

  it("releases a paced window as its allowance passes what was used, and says when", () => {
    expect(usageReserveHold(at(0.85, 0.9, 0, 0.5), PACED_5H, NOW)).toBeNull()
    expect(usageReserveHold(at(0.92, 0.9, 0, 0.5), PACED_5H, NOW)?.opensAt).toBe(NOW + 0.02 * FIVE)
  })

  it("holds a flat weekly cap until the week resets", () => {
    const hold = usageReserveHold(at(0, null, 0.95, 0.4), FLAT_WEEK, NOW)
    expect(hold).toMatchObject({ window: "seven_day", usedPct: 95, allowancePct: 95, held: true, opensAt: NOW + 0.6 * WEEK })
    expect(usageReserveHold(at(0, null, 0.949, 0.4), FLAT_WEEK, NOW)).toBeNull()
  })

  it("never holds a window that is not running, nor one the profile does not report", () => {
    expect(usageReserveHold([{ type: "seven_day", utilization: 0.99, resetsAt: NOW - 1 }], FLAT_WEEK, NOW)).toBeNull()
    expect(usageReserveHold([{ type: "seven_day", utilization: 0.5, resetsAt: NOW + HOUR }], PACED_5H, NOW)).toBeNull()
    expect(usageReserveHold(at(1, 0.5, 1, 0.5), undefined, NOW)).toBeNull()
  })

  it("names the window that holds and the shape of its reserve", () => {
    const flat = usageReserveHold(at(0, null, 0.98, 0.5), { seven_day: { floor: 97.5, ceiling: 97.5 } }, NOW)!
    expect(describeUsageReserveHold(flat)).toBe("weekly at 98%, capped at 97.5%")
    const paced = usageReserveHold(at(0.82, 0.1, 0, 0.5), PACED_5H, NOW)!
    expect(describeUsageReserveHold(paced)).toBe("5-hour at 82%, 80% allowed now, paced from 80% to 100%")
  })

  it("reports the weekly first, and finds the soonest opening among several holds", () => {
    const states = usageReserveStates(at(0.9, 0.5, 0.96, 0.5), { ...PACED_5H, ...FLAT_WEEK }, NOW)
    expect(states.map(state => [state.window, state.held])).toEqual([["seven_day", true], ["five_hour", true]])
    expect(soonestOpening(states)).toBe(NOW + 0.4 * FIVE)
  })
})

describe("the reserves a supervisor writes", () => {
  it("accepts decimals and a flat or paced window", () => {
    const parsed = parseUsageReserves({ "of-n-p20-gpt": { seven_day: { floor: 95, ceiling: 95 } }, d: { five_hour: { floor: 80, ceiling: 100 }, seven_day: { floor: 97.5, ceiling: 97.5 } } })
    expect(parsed).toEqual({ ok: true, value: {
      "of-n-p20-gpt": { seven_day: { floor: 95, ceiling: 95 } },
      d: { five_hour: { floor: 80, ceiling: 100 }, seven_day: { floor: 97.5, ceiling: 97.5 } },
    } })
  })

  it("refuses a write whole when any entry cannot be drawn, naming it", () => {
    expect(parseUsageReserves({ a: { seven_day: { floor: 96, ceiling: 95 } } })).toEqual({ ok: false, error: "usageReserves.a: seven_day floor is above its ceiling" })
    expect(parseUsageReserves({ a: { seven_day: { floor: 0, ceiling: 95 } } })).toMatchObject({ ok: false })
    expect(parseUsageReserves({ a: { thirty_day: { floor: 5, ceiling: 5 } } })).toMatchObject({ ok: false })
    expect(parseUsageReserves([1])).toMatchObject({ ok: false })
  })

  it("reads a stored map leniently, dropping only what cannot be drawn", () => {
    expect(readUsageReserves({ a: FLAT_WEEK, b: { seven_day: { floor: 96, ceiling: 95 } } })).toEqual({ a: FLAT_WEEK })
    expect(readUsageReserves(undefined)).toEqual({})
  })
})

describe("the readings a Claude profile is judged on", () => {
  it("overlays an SDK event newer than the OAuth snapshot, and only a newer one", () => {
    const oauth = { windows: at(0.5, 0.5, 0.9, 0.5), fetchedAt: NOW - 60_000 }
    const windows = newestClaudeWindows(oauth, [
      { rateLimitType: "seven_day", utilization: 0.96, observedAt: NOW - 1000 },
      { rateLimitType: "five_hour", utilization: 0.1, observedAt: NOW - 120_000 },
    ])
    expect(windows.find(w => w.type === "seven_day")).toEqual({ type: "seven_day", utilization: 0.96, resetsAt: NOW + 0.5 * WEEK })
    expect(windows.find(w => w.type === "five_hour")?.utilization).toBe(0.5)
    expect(newestClaudeWindows(undefined, [])).toEqual([])
  })
})

describe("what a card and a client are told", () => {
  it("describes each reserved window and whether it holds", () => {
    expect(usageReserveView(at(0.5, 0.9, 0.95, 0.4), { ...PACED_5H, ...FLAT_WEEK }, NOW)).toEqual({
      held: true,
      reason: "weekly at 95%, capped at 95%",
      opensAt: NOW + 0.6 * WEEK,
      windows: {
        seven_day: { floor: 95, ceiling: 95, allowance: 95, held: true },
        five_hour: { floor: 80, ceiling: 100, allowance: 90, held: false },
      },
    })
    expect(usageReserveView(at(0.5, 0.9, 0.5, 0.4), undefined, NOW)).toBeNull()
  })

  it("answers with Anthropic's rate-limit shape and when the soonest reserve opens", async () => {
    const response = usageReserveResponse("held", NOW + 90_000, NOW)
    expect(response.status).toBe(429)
    expect(response.headers.get("retry-after")).toBe("90")
    expect(await response.json()).toEqual({ type: "error", error: { type: "rate_limit_error", message: "held", retry_after: 90 } })
  })

  it("names every held profile in the refusal", () => {
    const hold = usageReserveHold(at(0, null, 0.95, 0.4), FLAT_WEEK, NOW)!
    expect(allHeldMessage(new Map([["of-n-p20-gpt", hold]]))).toContain("of-n-p20-gpt (weekly at 95%, capped at 95%)")
  })
})
