/**
 * Unit tests for the plan → allotment multiplier derivation.
 *
 * The module is pure, so these are direct assertions with no mocks. The cases
 * that matter are the ones where a wrong answer is worse than no answer: a
 * `max` that could be 5x or 20x, and a tier string Anthropic has not shipped
 * yet.
 */

import { describe, it, expect } from "bun:test"
import { normalizeRateLimitTier, planAllowance } from "../proxy/planAllowance"

describe("normalizeRateLimitTier", () => {
  it("strips the wire prefix and the underscores", () => {
    expect(normalizeRateLimitTier("default_claude_max_20x")).toBe("max 20x")
    expect(normalizeRateLimitTier("default_team_tier_1")).toBe("team tier 1")
  })

  it("accepts the bare spelling of the same tier", () => {
    expect(normalizeRateLimitTier("max_5x")).toBe("max 5x")
    expect(normalizeRateLimitTier("MAX_5X")).toBe("max 5x")
  })

  it("treats absent and blank as unknown rather than as a tier", () => {
    expect(normalizeRateLimitTier(null)).toBeNull()
    expect(normalizeRateLimitTier(undefined)).toBeNull()
    expect(normalizeRateLimitTier("   ")).toBeNull()
  })
})

describe("planAllowance", () => {
  it("derives every published Claude Code allotment", () => {
    expect(planAllowance({ rateLimitTier: "default_claude_max_20x" }))
      .toEqual({ multiplier: "20x", weight: 20, label: "Personal Max" })
    expect(planAllowance({ rateLimitTier: "default_claude_max_5x" }))
      .toEqual({ multiplier: "5x", weight: 5, label: "Personal Max" })
    expect(planAllowance({ rateLimitTier: "default_claude_pro" }))
      .toEqual({ multiplier: "1x", weight: 1, label: "Personal Pro" })
    expect(planAllowance({ rateLimitTier: "team_tier_1" }))
      .toEqual({ multiplier: "6.25x", weight: 6.25, label: "Team Premium" })
    expect(planAllowance({ rateLimitTier: "team_premium" }))
      .toEqual({ multiplier: "6.25x", weight: 6.25, label: "Team Premium" })
    expect(planAllowance({ rateLimitTier: "team_standard" }))
      .toEqual({ multiplier: "1x", weight: 1, label: "Team Standard" })
  })

  it("prefers the tier over the subscription type when both are present", () => {
    // `subscriptionType: "max"` alone cannot distinguish 5x from 20x, so the
    // tier has to win — this is the case the whole module exists for.
    expect(planAllowance({ rateLimitTier: "default_claude_max_5x", subscriptionType: "max" }).multiplier)
      .toBe("5x")
  })

  it("never calls a Team seat Personal, however its tier is spelled", () => {
    // Measured on a ten-account host: two Team profiles report
    // `subscriptionType: "team"` with `rateLimitTier: "default_claude_max_5x"`.
    // The size is genuinely 5x; the name "Personal Max" is not, and a reader
    // deciding whose allotment to spend acts on the name.
    expect(planAllowance({ rateLimitTier: "default_claude_max_5x", subscriptionType: "team" }))
      .toEqual({ multiplier: "5x", weight: 5, label: "Team" })
    expect(planAllowance({ rateLimitTier: "default_claude_max_20x", subscriptionType: "team" }))
      .toEqual({ multiplier: "20x", weight: 20, label: "Team" })
    expect(planAllowance({ rateLimitTier: "team_standard", subscriptionType: "max" }))
      .toEqual({ multiplier: "1x", weight: 1, label: "Personal" })
    expect(planAllowance({ rateLimitTier: "default_claude_max_5x", subscriptionType: "enterprise" }))
      .toEqual({ multiplier: "5x", weight: 5, label: "Enterprise" })
  })

  it("keeps the tier's own label when the two agree", () => {
    expect(planAllowance({ rateLimitTier: "default_claude_max_20x", subscriptionType: "max" }).label)
      .toBe("Personal Max")
    expect(planAllowance({ rateLimitTier: "team_tier_1", subscriptionType: "team" }).label)
      .toBe("Team Premium")
    expect(planAllowance({ rateLimitTier: "default_claude_pro", subscriptionType: "pro" }).label)
      .toBe("Personal Pro")
  })

  it("keeps the tier's label when the subscription type says nothing usable", () => {
    expect(planAllowance({ rateLimitTier: "default_claude_max_5x", subscriptionType: "something_new" }).label)
      .toBe("Personal Max")
    expect(planAllowance({ rateLimitTier: "default_claude_max_5x", subscriptionType: "  " }).label)
      .toBe("Personal Max")
  })

  it("reports max and team as unknown when only the subscription type is known", () => {
    expect(planAllowance({ subscriptionType: "max" })).toEqual({ multiplier: null, weight: null, label: null })
    expect(planAllowance({ subscriptionType: "team" })).toEqual({ multiplier: null, weight: null, label: null })
    expect(planAllowance({ subscriptionType: "enterprise" })).toEqual({ multiplier: null, weight: null, label: null })
  })

  it("falls back to the subscription type for the one tier it pins", () => {
    expect(planAllowance({ subscriptionType: "pro" }))
      .toEqual({ multiplier: "1x", weight: 1, label: "Personal Pro" })
  })

  it("returns nothing rather than a default for a tier it does not know", () => {
    expect(planAllowance({ rateLimitTier: "default_claude_max_50x" }))
      .toEqual({ multiplier: null, weight: null, label: null })
    expect(planAllowance({})).toEqual({ multiplier: null, weight: null, label: null })
    expect(planAllowance(null)).toEqual({ multiplier: null, weight: null, label: null })
    expect(planAllowance(undefined)).toEqual({ multiplier: null, weight: null, label: null })
  })

  it("hands back a fresh object so a caller cannot corrupt the table", () => {
    const first = planAllowance({ rateLimitTier: "default_claude_max_20x" })
    first.multiplier = "1x"
    expect(planAllowance({ rateLimitTier: "default_claude_max_20x" }).multiplier).toBe("20x")
  })
})
