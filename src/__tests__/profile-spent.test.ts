/**
 * Unit tests for the shared "how spent is this account?" classifier —
 * pure functions, no mocks.
 */
import { describe, expect, it } from "bun:test"
import {
  FADE_FROM,
  SPENT_AT,
  computeProfileSpend,
  generalUtilization,
  isUnusable,
} from "../telemetry/profileSpent"

const win = (type: string, utilization: number | null) => ({ type, utilization })

describe("generalUtilization", () => {
  it("takes the worse of the five-hour and general weekly windows", () => {
    expect(generalUtilization([win("five_hour", 0.2), win("seven_day", 0.8)])).toBe(0.8)
    expect(generalUtilization([win("five_hour", 0.9), win("seven_day", 0.1)])).toBe(0.9)
  })

  it("ignores per-model caps, seven_day_fable above all", () => {
    // The observed case: 94% Fable, general windows barely touched. Folding
    // Fable in would call a usable account spent.
    expect(
      generalUtilization([win("five_hour", 0.05), win("seven_day", 0.1), win("seven_day_fable", 0.94)]),
    ).toBe(0.1)
    expect(
      generalUtilization([win("seven_day", 0.2), win("seven_day_opus", 1), win("seven_day_sonnet", 1)]),
    ).toBe(0.2)
  })

  it("returns null when no general window carries a number", () => {
    expect(generalUtilization([])).toBeNull()
    expect(generalUtilization(null)).toBeNull()
    expect(generalUtilization(undefined)).toBeNull()
    expect(generalUtilization([win("five_hour", null)])).toBeNull()
    expect(generalUtilization([win("seven_day_fable", 0.9)])).toBeNull()
    expect(generalUtilization([win("five_hour", Number.NaN)])).toBeNull()
  })

  it("clamps out-of-range utilization", () => {
    expect(generalUtilization([win("seven_day", 1.4)])).toBe(1)
    expect(generalUtilization([win("seven_day", -0.2)])).toBe(0)
  })
})

describe("isUnusable", () => {
  it("is true for a profile with no token or a failed login", () => {
    expect(isUnusable({ error: "no_token" })).toBe(true)
    expect(isUnusable({ loggedIn: false })).toBe(true)
  })

  it("is false for an API-key profile, which has no OAuth quota but works", () => {
    expect(isUnusable({ error: "not_oauth", loggedIn: true })).toBe(false)
  })

  it("is false for a healthy profile", () => {
    expect(isUnusable({ error: null, loggedIn: true, windows: [win("seven_day", 0.3)] })).toBe(false)
    expect(isUnusable({})).toBe(false)
  })
})

describe("computeProfileSpend", () => {
  it("reports a profile that needs a human as fully spent, with its own reason", () => {
    const s = computeProfileSpend({ error: "no_token", windows: [] })
    expect(s.fraction).toBe(1)
    expect(s.state).toBe("spent")
    expect(s.reason).toBe("unusable")
  })

  it("does not fade a profile that needs a human, however spent it is", () => {
    // Fading says "come back later"; a missing login says "do something".
    expect(computeProfileSpend({ error: "no_token", windows: [] }).fade).toBe(0)
    expect(computeProfileSpend({ loggedIn: false, windows: [win("seven_day", 0.99)] }).fade).toBe(0)
  })

  it("does not confuse an unusable profile with a pristine one", () => {
    // No windows at all is what a broken profile reports — it must not read
    // as 0% used.
    const broken = computeProfileSpend({ error: "no_token", windows: [] })
    const fresh = computeProfileSpend({ windows: [win("five_hour", 0), win("seven_day", 0)] })
    expect(broken.fraction).toBe(1)
    expect(fresh.fraction).toBe(0)
    expect(fresh.state).toBe("available")
  })

  it("is 'unknown' with no quota data, which is not the same as unused", () => {
    const s = computeProfileSpend({ windows: [], loggedIn: true })
    expect(s.fraction).toBeNull()
    expect(s.state).toBe("unknown")
    expect(s.fade).toBe(0)
    expect(s.reason).toBeNull()
  })

  it("leaves a comfortable profile alone", () => {
    const s = computeProfileSpend({ windows: [win("five_hour", 0.4), win("seven_day", 0.6)] })
    expect(s.state).toBe("available")
    expect(s.fade).toBe(0)
  })

  it("ramps the fade across the 95–100% band", () => {
    expect(computeProfileSpend({ windows: [win("seven_day", FADE_FROM)] }).fade).toBe(0)
    expect(computeProfileSpend({ windows: [win("seven_day", 0.975)] }).fade).toBeCloseTo(0.5, 5)
    expect(computeProfileSpend({ windows: [win("seven_day", 0.99)] }).fade).toBeCloseTo(0.8, 5)
    expect(computeProfileSpend({ windows: [win("seven_day", 0.975)] }).state).toBe("fading")
  })

  it("keeps an account with a fresh 5h window out of the spent bucket", () => {
    const s = computeProfileSpend({ windows: [win("five_hour", 0), win("seven_day", 0.96)] })
    expect(s.state).toBe("fading")
    expect(s.reason).toBeNull()
    expect(s.fade).toBeLessThan(0.3)
  })

  it("is fully spent at the threshold and beyond", () => {
    for (const u of [SPENT_AT, 1, 1.4]) {
      const s = computeProfileSpend({ windows: [win("seven_day", u)] })
      expect(s.state).toBe("spent")
      expect(s.fade).toBe(1)
      expect(s.reason).toBe("usage")
    }
  })

  it("spends on the worse window, so a hot 5h counts even with a cold week", () => {
    const s = computeProfileSpend({ windows: [win("five_hour", 0.97), win("seven_day", 0.05)] })
    expect(s.state).toBe("fading")
    expect(s.fraction).toBe(0.97)
    expect(computeProfileSpend({ windows: [win("five_hour", 1), win("seven_day", 0.05)] }).state).toBe("spent")
  })
})

describe("computeProfileSpend with a refusal", () => {
  // The measured case this input exists for: corp4 rendered 5h 67% / 7d 7%
  // while Anthropic refused every request through it. Judging it by the
  // percentages alone makes "least spent" recommend the one account that
  // could not serve.
  const healthyLooking = [win("five_hour", 0.67), win("seven_day", 0.07)]

  it("calls a refusing account spent however comfortable its last read looks", () => {
    const s = computeProfileSpend({ windows: healthyLooking, refused: true })
    expect(s.state).toBe("spent")
    expect(s.reason).toBe("refused")
    expect(s.fade).toBe(1)
  })

  it("sorts a refusing account as most spent, ahead of a genuinely busier one", () => {
    const refusing = computeProfileSpend({ windows: healthyLooking, refused: true })
    const busy = computeProfileSpend({ windows: [win("five_hour", 0.9)] })
    expect(refusing.fraction).not.toBeNull()
    expect(refusing.fraction!).toBeGreaterThan(busy.fraction!)
  })

  it("leaves the same account alone once the refusal is gone", () => {
    const s = computeProfileSpend({ windows: healthyLooking, refused: false })
    expect(s.state).toBe("available")
    expect(s.reason).toBeNull()
    expect(s.fraction).toBe(0.67)
  })

  it("still asks for a human first: a refusal does not mask a missing login", () => {
    const s = computeProfileSpend({ windows: healthyLooking, refused: true, loggedIn: false })
    expect(s.reason).toBe("unusable")
    expect(s.fade).toBe(0)
  })
})
