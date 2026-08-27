import { describe, expect, it } from "bun:test"
import {
  evaluateRoutingProfileAccess,
  noEligibleProfilesResponse,
  profileExcludedResponse,
  replacementForExcludedActive,
} from "../proxy/routingExclusionRuntime"

const profiles = [
  { id: "primary", env: {} },
  { id: "reserved", env: {} },
]

const renamedProfiles = [
  { id: "employer", aliases: ["work"], env: {} },
  { id: "personal", env: {} },
]

describe("routing exclusion runtime", () => {
  it("returns only work-eligible profiles and an eligible default", () => {
    const result = evaluateRoutingProfileAccess({
      profiles,
      defaultProfile: "reserved",
      purpose: "work",
      excludedProfileIds: ["reserved"],
    })

    expect(result.access.kind).toBe("allowed")
    expect(result.profiles.map(profile => profile.id)).toEqual(["primary"])
    expect(result.defaultProfile).toBeUndefined()
  })

  it("keeps excluded profiles available to the warm purpose", () => {
    const result = evaluateRoutingProfileAccess({
      profiles,
      defaultProfile: "reserved",
      purpose: "warm",
      explicitProfileId: "reserved",
      excludedProfileIds: ["reserved"],
    })

    expect(result.profiles.map(profile => profile.id)).toEqual(["primary", "reserved"])
    expect(result.defaultProfile).toBe("reserved")
  })

  it("moves an excluded active profile to the first eligible profile", () => {
    expect(replacementForExcludedActive({
      profiles,
      activeProfile: "reserved",
      excludedProfileIds: ["reserved"],
    })).toEqual({ change: true, profileId: "primary" })
  })

  it("canonicalizes alias exclusions before filtering automatic work", () => {
    const result = evaluateRoutingProfileAccess({
      profiles: renamedProfiles,
      defaultProfile: "employer",
      purpose: "work",
      excludedProfileIds: ["work"],
    })

    expect(result.profiles.map(profile => profile.id)).toEqual(["personal"])
    expect(result.excludedProfileIds).toEqual(["employer"])
  })

  it("rejects an excluded canonical profile requested through an alias", () => {
    const result = evaluateRoutingProfileAccess({
      profiles: renamedProfiles,
      purpose: "work",
      explicitProfileId: "work",
      excludedProfileIds: ["employer"],
    })

    expect(result.access).toEqual({ kind: "explicit_excluded", profileId: "employer" })
  })

  it("preserves an eligible default expressed through an alias", () => {
    const result = evaluateRoutingProfileAccess({
      profiles: renamedProfiles,
      defaultProfile: "work",
      purpose: "work",
      excludedProfileIds: [],
    })

    expect(result.defaultProfile).toBe("employer")
  })

  it("moves an active canonical profile excluded through an alias", () => {
    expect(replacementForExcludedActive({
      profiles: renamedProfiles,
      activeProfile: "employer",
      excludedProfileIds: ["work"],
    })).toEqual({ change: true, profileId: "personal" })
  })

  it("returns stable error envelopes", async () => {
    const excluded = profileExcludedResponse("reserved")
    const empty = noEligibleProfilesResponse()
    expect(excluded.status).toBe(409)
    expect(await excluded.json()).toEqual({
      type: "error",
      error: {
        type: "profile_excluded",
        message: "Profile \"reserved\" is excluded from work routing",
      },
    })
    expect(empty.status).toBe(503)
  })
})
