import { beforeEach, describe, expect, it } from "bun:test"
import { readFileSync, rmSync, writeFileSync } from "node:fs"
import { configPath } from "../configDir"
import {
  CLAUDE_AI_READING_FRESH_MS,
  cvpAccessFor,
  cvpAccessOn,
  cvpActive,
  cvpTierFromBadge,
  cyberVerificationOf,
  forgetCvpAccess,
  holdsCvpAccess,
  normalizeCvpModel,
  parseRoutingRequirements,
  recordCvpReading,
  recordCvpRefusal,
  resetCvpAccessCacheForTests,
  setCvpOrganizationLookup,
} from "../proxy/cvpAccess"

const DEFENSE = { message: "CVP: Defense Access", variant: "neutral" }
const T0 = 1_800_000_000_000

beforeEach(() => {
  rmSync(configPath("cvp-access.json"), { force: true })
  resetCvpAccessCacheForTests()
  setCvpOrganizationLookup(() => ({}))
})

describe("claude.ai readings", () => {
  it("marks badged models active with their tier and the rest inactive", () => {
    const map = recordCvpReading("team", [
      { id: "claude-opus-5-5", name: "Opus 5.5", badge: DEFENSE, selector_badge: { message: "CVP" } },
      { id: "claude-fable-5-2", name: "Fable 5.2" },
      { id: "claude-haiku-4-5-20251001", name: "Haiku 4.5", badge: null },
    ], T0)

    expect(map).toEqual([
      { model: "claude-fable-5-2", type: "inactive", tier: null, reason: null, source: "claude_ai", at: T0, name: "Fable 5.2" },
      { model: "claude-haiku-4-5", type: "inactive", tier: null, reason: null, source: "claude_ai", at: T0, name: "Haiku 4.5" },
      { model: "claude-opus-5-5", type: "active", tier: "c", reason: null, source: "claude_ai", at: T0, name: "Opus 5.5" },
    ])
    expect(cvpActive("team", "claude-opus-5-5[1m]", T0)).toBe(true)
    expect(cvpActive("team", "claude-fable-5-2", T0)).toBe(false)
    expect(cvpActive("max", "claude-opus-5-5", T0)).toBe(false)
  })

  it("replaces the previous reading but keeps observed refusals", () => {
    recordCvpReading("team", [{ id: "claude-opus-5-5", badge: DEFENSE }, { id: "claude-sonnet-5-5", badge: DEFENSE }], T0)
    recordCvpRefusal("team", "claude-mythos-5-2", { type: "active", tier: "c" }, T0 + 1)
    recordCvpReading("team", [{ id: "claude-opus-5-5", badge: DEFENSE }], T0 + 2)

    expect(cvpAccessFor("team", T0 + 2).map(e => [e.model, e.type, e.source])).toEqual([
      ["claude-mythos-5-2", "active", "observed"],
      ["claude-opus-5-5", "active", "claude_ai"],
    ])
  })

  it("reads the tier the badge names", () => {
    expect(cvpTierFromBadge("CVP: Defense Access")).toBe("c")
    expect(cvpTierFromBadge("CVP: Red Team Access")).toBe("b")
    expect(cvpTierFromBadge("CVP: Specialized Access")).toBe("a")
    expect(cvpTierFromBadge("CVP")).toBeNull()
  })
})

describe("refusals", () => {
  it("records an active tier and an inactive reason", () => {
    expect(recordCvpRefusal("max", "claude-opus-5-5", { type: "inactive", reason: "organization_not_approved" }, T0)).toBe(true)
    expect(recordCvpRefusal("team", "claude-opus-5-5", { type: "active", tier: "c" }, T0)).toBe(true)

    expect(cvpAccessOn("max", "claude-opus-5-5", T0)).toMatchObject({ type: "inactive", tier: null, reason: "organization_not_approved", source: "observed" })
    expect(cvpActive("team", "claude-opus-5-5", T0)).toBe(true)
  })

  it("ignores a refusal without a readable cyber_verification", () => {
    expect(recordCvpRefusal("team", "claude-opus-5-5", { type: "active", tier: "z" }, T0)).toBe(false)
    expect(recordCvpRefusal("team", "claude-opus-5-5", undefined, T0)).toBe(false)
    expect(recordCvpRefusal("team", "", { type: "active", tier: "c" }, T0)).toBe(false)
    expect(cvpAccessFor("team", T0)).toEqual([])
  })

  it("finds cyber_verification on a refusal row only", () => {
    const refusal = { message: { model: "claude-opus-5-5", stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", cyber_verification: { type: "active", tier: "c" } } } }
    expect(cyberVerificationOf(refusal)).toEqual({ model: "claude-opus-5-5", value: { type: "active", tier: "c" } })
    expect(cyberVerificationOf({ message: { stop_reason: "end_turn" } })).toBeNull()
    expect(cyberVerificationOf({ message: { stop_reason: "refusal", stop_details: { category: "cyber" } } })).toBeNull()
  })
})

describe("which source decides", () => {
  it("a fresh claude.ai reading beats a later refusal", () => {
    recordCvpReading("team", [{ id: "claude-opus-5-5", badge: DEFENSE }], T0)
    recordCvpRefusal("team", "claude-opus-5-5", { type: "inactive", reason: "not_assigned_but_organization_approved" }, T0 + 60_000)

    expect(cvpAccessOn("team", "claude-opus-5-5", T0 + 60_000)?.source).toBe("claude_ai")
    expect(cvpActive("team", "claude-opus-5-5", T0 + 60_000)).toBe(true)
  })

  it("a refusal newer than a stale reading decides", () => {
    recordCvpReading("team", [{ id: "claude-opus-5-5", badge: DEFENSE }], T0)
    const later = T0 + CLAUDE_AI_READING_FRESH_MS + 1
    recordCvpRefusal("team", "claude-opus-5-5", { type: "inactive", reason: "not_assigned_but_organization_approved" }, later)

    expect(cvpAccessOn("team", "claude-opus-5-5", later)).toMatchObject({ source: "observed", type: "inactive" })
    expect(cvpActive("team", "claude-opus-5-5", later)).toBe(false)
  })

  it("a stale reading still beats an older refusal", () => {
    recordCvpRefusal("team", "claude-opus-5-5", { type: "inactive", reason: "organization_not_approved" }, T0)
    recordCvpReading("team", [{ id: "claude-opus-5-5", badge: DEFENSE }], T0 + 1)

    expect(cvpActive("team", "claude-opus-5-5", T0 + CLAUDE_AI_READING_FRESH_MS * 3)).toBe(true)
  })
})

describe("organization inference", () => {
  const ORGS = { c1: "org-sub-1", c1b: "org-sub-1", c1c: "org-sub-1", c2: "org-sub-2", personal: "org-personal", unknown: null }

  beforeEach(() => {
    setCvpOrganizationLookup(() => ORGS)
  })

  it("gives a profile with no reading its organization sibling's reading, naming the sibling", () => {
    recordCvpReading("c1", [{ id: "claude-opus-5-5", name: "Opus 5.5", badge: DEFENSE }, { id: "claude-fable-5-2" }], T0)

    expect(cvpAccessOn("c1b", "claude-opus-5-5[1m]", T0)).toEqual({
      model: "claude-opus-5-5", type: "active", tier: "c", reason: null, source: "organization", inferredFrom: "c1", at: T0, name: "Opus 5.5",
    })
    expect(cvpActive("c1b", "claude-opus-5-5", T0)).toBe(true)
    expect(cvpAccessFor("c1b", T0).map(e => [e.model, e.type, e.source, e.inferredFrom])).toEqual([
      ["claude-fable-5-2", "inactive", "organization", "c1"],
      ["claude-opus-5-5", "active", "organization", "c1"],
    ])
    expect(cvpAccessFor("c1", T0).every(e => e.source === "claude_ai" && e.inferredFrom === undefined)).toBe(true)
  })

  it("infers nothing when siblings with readings disagree", () => {
    recordCvpReading("c1", [{ id: "claude-opus-5-5", badge: DEFENSE }], T0)
    recordCvpRefusal("c1b", "claude-opus-5-5", { type: "inactive", reason: "not_assigned_but_organization_approved" }, T0)

    expect(cvpAccessOn("c1c", "claude-opus-5-5", T0)).toBeUndefined()
    expect(cvpAccessFor("c1c", T0)).toEqual([])
  })

  it("lets the profile's own reading outrank the inferred one", () => {
    recordCvpReading("c1", [{ id: "claude-opus-5-5", badge: DEFENSE }], T0)
    recordCvpRefusal("c1b", "claude-opus-5-5", { type: "inactive", reason: "not_assigned_but_organization_approved" }, T0 + 1)

    expect(cvpAccessOn("c1b", "claude-opus-5-5", T0 + 1)).toMatchObject({ type: "inactive", source: "observed" })
    expect(cvpActive("c1b", "claude-opus-5-5", T0 + 1)).toBe(false)
  })

  it("never leaks across organizations or to a profile whose organization is unknown", () => {
    recordCvpReading("c1", [{ id: "claude-opus-5-5", badge: DEFENSE }], T0)

    expect(cvpAccessOn("c2", "claude-opus-5-5", T0)).toBeUndefined()
    expect(cvpAccessOn("personal", "claude-opus-5-5", T0)).toBeUndefined()
    expect(cvpAccessOn("unknown", "claude-opus-5-5", T0)).toBeUndefined()
    expect(cvpAccessOn("nobody", "claude-opus-5-5", T0)).toBeUndefined()
  })

  it("does not infer through an unknown organization shared by name only", () => {
    setCvpOrganizationLookup(() => ({ a: null, b: null }))
    recordCvpReading("a", [{ id: "claude-opus-5-5", badge: DEFENSE }], T0)

    expect(cvpAccessOn("b", "claude-opus-5-5", T0)).toBeUndefined()
  })
})

describe("readings under a model id that is not a Claude model", () => {
  it("refuses to record a refusal under <synthetic>", () => {
    expect(recordCvpRefusal("team", "<synthetic>", { type: "active", tier: "c" }, T0)).toBe(false)
    expect(cvpAccessFor("team", T0)).toEqual([])
  })

  it("ignores stored <synthetic> entries and prunes them on the next write", () => {
    writeFileSync(configPath("cvp-access.json"), JSON.stringify({ profiles: {
      team: { "<synthetic>": { observed: { type: "active", tier: "c", reason: null, source: "observed", at: T0 } } },
    } }))
    resetCvpAccessCacheForTests()

    expect(cvpAccessFor("team", T0)).toEqual([])
    expect(cvpAccessOn("team", "<synthetic>", T0)).toBeUndefined()

    recordCvpRefusal("team", "claude-opus-5-5", { type: "active", tier: "c" }, T0 + 1)
    const stored = JSON.parse(readFileSync(configPath("cvp-access.json"), "utf-8")).profiles.team
    expect(Object.keys(stored)).toEqual(["claude-opus-5-5"])
  })

  it("never lends a <synthetic> entry to an organization sibling", () => {
    setCvpOrganizationLookup(() => ({ a: "org", b: "org" }))
    writeFileSync(configPath("cvp-access.json"), JSON.stringify({ profiles: {
      a: { "<synthetic>": { observed: { type: "active", tier: "c", reason: null, source: "observed", at: T0 } } },
    } }))
    resetCvpAccessCacheForTests()

    expect(cvpAccessFor("b", T0)).toEqual([])
  })
})

describe("persistence", () => {
  it("survives a restart and is forgotten per profile", () => {
    recordCvpReading("team", [{ id: "claude-opus-5-5", badge: DEFENSE }], T0)
    recordCvpRefusal("max", "claude-opus-5-5", { type: "inactive", reason: "organization_not_approved" }, T0)
    resetCvpAccessCacheForTests()

    expect(cvpActive("team", "claude-opus-5-5", T0)).toBe(true)
    forgetCvpAccess("team")
    resetCvpAccessCacheForTests()
    expect(cvpAccessFor("team", T0)).toEqual([])
    expect(cvpAccessFor("max", T0)).toHaveLength(1)
    expect(JSON.parse(readFileSync(configPath("cvp-access.json"), "utf-8")).profiles.team).toBeUndefined()
  })

  it("treats a malformed file as empty", () => {
    writeFileSync(configPath("cvp-access.json"), "{\"profiles\": 3}")
    expect(cvpAccessFor("team", T0)).toEqual([])
  })
})

describe("holdsCvpAccess", () => {
  it("counts active access on any model, its own or its organization's", () => {
    recordCvpReading("team", [{ id: "claude-opus-5-5", badge: DEFENSE }, { id: "claude-sonnet-5-5" }], T0)
    recordCvpRefusal("max", "claude-opus-5-5", { type: "inactive", reason: "organization_not_approved" }, T0)
    setCvpOrganizationLookup(() => ({ team: "org", team2: "org", max: "personal" }))

    expect(holdsCvpAccess("team", T0)).toBe(true)
    expect(holdsCvpAccess("team2", T0)).toBe(true)
    expect(holdsCvpAccess("max", T0)).toBe(false)
    expect(holdsCvpAccess("unread", T0)).toBe(false)
  })
})

describe("x-meridian-require", () => {
  it("parses cvp and reports unknown requirements", () => {
    expect(parseRoutingRequirements(undefined)).toEqual({ cvp: false, restricted: false, known: [], unknown: [], error: null })
    expect(parseRoutingRequirements(" CVP ")).toEqual({ cvp: true, restricted: false, known: ["cvp"], unknown: [], error: null })
    expect(parseRoutingRequirements("cvp, zdr")).toMatchObject({ cvp: true, known: ["cvp"], unknown: ["zdr"], error: "x-meridian-require: unknown requirement zdr" })
  })

  it("parses restricted and refuses it beside cvp", () => {
    expect(parseRoutingRequirements(" Restricted ")).toEqual({ cvp: false, restricted: true, known: ["restricted"], unknown: [], error: null })
    const conflict = parseRoutingRequirements("cvp,restricted")
    expect(conflict).toMatchObject({ cvp: true, restricted: true, known: ["cvp", "restricted"], unknown: [] })
    expect(conflict.error).toContain("cvp and restricted conflict")
  })

  it("normalizes model ids the same on every side", () => {
    expect(normalizeCvpModel("Claude-Opus-5-5[1m]")).toBe("claude-opus-5-5")
    expect(normalizeCvpModel("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5")
  })
})
