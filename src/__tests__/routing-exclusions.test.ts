import { describe, expect, it } from "bun:test"
import {
  filterEligibleProfileIds,
  mergeRoutingExcludedProfiles,
  resolveRoutingAccess,
} from "../proxy/routingExclusions"

describe("routing exclusions", () => {
  it("preserves the resolved priority order while removing excluded profiles", () => {
    // Given
    const resolvedOrder = ["work", "personal", "spare"]

    // When
    const eligible = filterEligibleProfileIds(resolvedOrder, ["work", "future-profile"])

    // Then
    expect(eligible).toEqual(["personal", "spare"])
  })

  it("leaves the pool unchanged when no profiles are excluded", () => {
    // Given
    const resolvedOrder = ["work", "personal"]

    // When
    const eligible = filterEligibleProfileIds(resolvedOrder, [])

    // Then
    expect(eligible).toEqual(resolvedOrder)
  })

  it("combines manual and managed exclusions without duplicates", () => {
    // Given / When
    const excluded = mergeRoutingExcludedProfiles(
      ["manual", "shared"],
      ["managed", "shared"],
    )

    // Then
    expect(excluded).toEqual(["manual", "shared", "managed"])
  })

  it("rejects an explicitly excluded work target", () => {
    // Given / When
    const access = resolveRoutingAccess({
      purpose: "work",
      availableProfileIds: ["work", "personal"],
      excludedProfileIds: ["work"],
      explicitProfileId: "work",
    })

    // Then
    expect(access).toEqual({ kind: "explicit_excluded", profileId: "work" })
  })

  it("reports no eligible automatic target when the whole pool is excluded", () => {
    // Given / When
    const access = resolveRoutingAccess({
      purpose: "work",
      availableProfileIds: ["work", "personal"],
      excludedProfileIds: ["work", "personal"],
    })

    // Then
    expect(access).toEqual({ kind: "no_eligible_profiles" })
  })

  it("allows the fixed warm purpose to target an excluded profile", () => {
    // Given / When
    const access = resolveRoutingAccess({
      purpose: "warm",
      availableProfileIds: ["work", "personal"],
      excludedProfileIds: ["work"],
      explicitProfileId: "work",
    })

    // Then
    expect(access).toEqual({ kind: "allowed", eligibleProfileIds: ["work", "personal"] })
  })
})

describe("held profiles", () => {
  const pool = { availableProfileIds: ["work", "personal", "spare"], excludedProfileIds: ["spare"], heldProfileIds: ["work"] }

  it("keeps unpinned work off a held profile", () => {
    expect(resolveRoutingAccess({ ...pool, purpose: "work" })).toEqual({ kind: "allowed", eligibleProfileIds: ["personal"] })
  })

  it("serves work pinned to a held profile", () => {
    expect(resolveRoutingAccess({ ...pool, purpose: "work", explicitProfileId: "work" }))
      .toEqual({ kind: "allowed", eligibleProfileIds: ["work", "personal"] })
  })

  it("refuses a warm of a held profile and leaves it out of unpinned warms", () => {
    expect(resolveRoutingAccess({ ...pool, purpose: "warm", explicitProfileId: "work" }))
      .toEqual({ kind: "explicit_held", profileId: "work" })
    expect(resolveRoutingAccess({ ...pool, purpose: "warm" }))
      .toEqual({ kind: "allowed", eligibleProfileIds: ["personal", "spare"] })
  })

  it("still refuses work pinned to an excluded profile", () => {
    expect(resolveRoutingAccess({ ...pool, purpose: "work", explicitProfileId: "spare" }))
      .toEqual({ kind: "explicit_excluded", profileId: "spare" })
  })
})
