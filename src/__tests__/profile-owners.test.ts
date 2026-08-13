/**
 * Unit tests for profileOwners.ts — per-profile ownership designation.
 *
 * The pure functions are exercised directly. The persistence round trip goes
 * through the real settings module with MERIDIAN_CONFIG_DIR redirected, the
 * same arrangement settings-unit.test.ts uses — a re-implementation of the
 * JSON handling would pass regardless of what the module actually did.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  PROFILE_OWNERS,
  parseOwnerRequest,
  profileOwner,
  profileOwners,
  readProfileOwners,
  setProfileOwner,
  withProfileOwner,
} from "../proxy/profileOwners"
import { getSetting, setSetting } from "../proxy/settings"

describe("readProfileOwners", () => {
  test("keeps known designations", () => {
    expect(readProfileOwners({ a: "own", b: "loaner" })).toEqual({ a: "own", b: "loaner" })
  })

  test("drops entries whose value is not a known designation", () => {
    // settings.json is hand-editable, so a third vocabulary word must never
    // reach a consumer.
    expect(readProfileOwners({ a: "own", b: "mine", c: null, d: 1, e: {} })).toEqual({ a: "own" })
  })

  test("drops the empty profile id", () => {
    expect(readProfileOwners({ "": "own", a: "loaner" })).toEqual({ a: "loaner" })
  })

  test("non-object input yields an empty map", () => {
    expect(readProfileOwners(undefined)).toEqual({})
    expect(readProfileOwners(null)).toEqual({})
    expect(readProfileOwners("own")).toEqual({})
    expect(readProfileOwners(["own"])).toEqual({})
  })
})

describe("withProfileOwner", () => {
  test("designates a profile that had none", () => {
    expect(withProfileOwner({}, "work", "own")).toEqual({ work: "own" })
  })

  test("overwrites an existing designation", () => {
    expect(withProfileOwner({ work: "own" }, "work", "loaner")).toEqual({ work: "loaner" })
  })

  test("clearing deletes the key rather than storing null", () => {
    const next = withProfileOwner({ work: "own", side: "loaner" }, "work", null)
    expect(next).toEqual({ side: "loaner" })
    expect("work" in next).toBe(false)
  })

  test("clearing a profile that was never designated is a no-op", () => {
    expect(withProfileOwner({ side: "loaner" }, "work", null)).toEqual({ side: "loaner" })
  })

  test("does not mutate the map it was given", () => {
    const current = { work: "own" as const }
    withProfileOwner(current, "side", "loaner")
    expect(current).toEqual({ work: "own" })
  })
})

describe("parseOwnerRequest", () => {
  const known = ["work", "side"]

  test("accepts every storable designation", () => {
    for (const owner of PROFILE_OWNERS) {
      expect(parseOwnerRequest({ profile: "work", owner }, known)).toEqual({ ok: true, profile: "work", owner })
    }
  })

  test("accepts an explicit null as a clear", () => {
    expect(parseOwnerRequest({ profile: "work", owner: null }, known)).toEqual({ ok: true, profile: "work", owner: null })
  })

  test("trims the profile id", () => {
    expect(parseOwnerRequest({ profile: "  work  ", owner: "own" }, known)).toEqual({ ok: true, profile: "work", owner: "own" })
  })

  test("rejects a body that is not a JSON object", () => {
    for (const body of [null, "work", 3, ["work"]]) {
      const result = parseOwnerRequest(body, known)
      expect(result.ok).toBe(false)
    }
  })

  test("rejects a missing or blank profile", () => {
    for (const body of [{ owner: "own" }, { profile: "", owner: "own" }, { profile: "   ", owner: "own" }, { profile: 7, owner: "own" }]) {
      const result = parseOwnerRequest(body, known)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toContain("profile")
    }
  })

  test("an unknown profile id is named in the error", () => {
    const result = parseOwnerRequest({ profile: "ghost", owner: "own" }, known)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain("ghost")
      expect(result.error).toContain("work")
    }
  })

  test("a missing owner field is rejected rather than read as a clear", () => {
    // The designation exists to stop a borrowed account being spent like an
    // own one, so a caller that forgot the field must not erase one.
    const result = parseOwnerRequest({ profile: "work" }, known)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("owner")
  })

  test("an unknown owner value is rejected, naming the accepted values", () => {
    for (const owner of ["mine", "borrowed", "OWN", "", 1, {}]) {
      const result = parseOwnerRequest({ profile: "work", owner }, known)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toContain('"own"')
        expect(result.error).toContain('"loaner"')
      }
    }
  })

  test("reports that nothing is configured rather than an empty list", () => {
    const result = parseOwnerRequest({ profile: "work", owner: "own" }, [])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("none configured")
  })
})

describe("ownership persistence", () => {
  const tempDir = join(tmpdir(), `meridian-profile-owners-${process.pid}`)
  const settingsFile = join(tempDir, "settings.json")
  let savedConfigDir: string | undefined

  beforeEach(() => {
    savedConfigDir = process.env.MERIDIAN_CONFIG_DIR
    rmSync(tempDir, { recursive: true, force: true })
    mkdirSync(tempDir, { recursive: true })
    process.env.MERIDIAN_CONFIG_DIR = tempDir
  })

  afterEach(() => {
    if (savedConfigDir !== undefined) process.env.MERIDIAN_CONFIG_DIR = savedConfigDir
    else delete process.env.MERIDIAN_CONFIG_DIR
    rmSync(tempDir, { recursive: true, force: true })
  })

  test("an undesignated profile reads as null", () => {
    expect(profileOwner("work")).toBeNull()
    expect(profileOwners()).toEqual({})
  })

  test("a designation survives a write and read", () => {
    setProfileOwner("work", "loaner")
    expect(profileOwner("work")).toBe("loaner")
    expect(getSetting("profileOwners")).toEqual({ work: "loaner" })
  })

  test("designating one profile leaves the others alone", () => {
    setProfileOwner("work", "own")
    setProfileOwner("side", "loaner")
    expect(profileOwners()).toEqual({ work: "own", side: "loaner" })
  })

  test("clearing removes the key from the file rather than writing null", () => {
    setProfileOwner("work", "own")
    setProfileOwner("side", "loaner")
    setProfileOwner("work", null)
    expect(profileOwner("work")).toBeNull()
    const raw = JSON.parse(readFileSync(settingsFile, "utf-8"))
    expect(raw.profileOwners).toEqual({ side: "loaner" })
    expect("work" in raw.profileOwners).toBe(false)
  })

  test("designating does not disturb unrelated settings", () => {
    setSetting("activeProfile", "work")
    setSetting("routing", "priority")
    setProfileOwner("work", "own")
    expect(getSetting("activeProfile")).toBe("work")
    expect(getSetting("routing")).toBe("priority")
  })

  test("a hand-edited unknown value is ignored rather than served", () => {
    writeFileSync(settingsFile, JSON.stringify({ profileOwners: { work: "mine", side: "loaner" } }))
    expect(profileOwners()).toEqual({ side: "loaner" })
    expect(profileOwner("work")).toBeNull()
  })

  test("a designation written beside a garbage map replaces it cleanly", () => {
    writeFileSync(settingsFile, JSON.stringify({ profileOwners: "nonsense" }))
    setProfileOwner("work", "own")
    expect(profileOwners()).toEqual({ work: "own" })
  })
})
