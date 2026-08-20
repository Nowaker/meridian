/**
 * Unit tests for profileRemove.ts.
 *
 * Everything on disk here lives in a throwaway config dir — no test may read,
 * move or write anything under the developer's real ~/.config/meridian.
 *
 * The assertions worth keeping are the two failure directions, not the happy
 * path: a removal that wrote the list and could not delete the directory is
 * recoverable and must SAY SO, and a removal that could not write the list
 * must not have deleted anything at all.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applyProfileRemove, planProfileRemove } from "../proxy/profileRemove"
import type { ProfileConfig } from "../proxy/profiles"

const PROFILES_DIR = "/cfg/meridian/profiles"

describe("planProfileRemove", () => {
  test("takes the named entry out and leaves the rest in order", () => {
    const profiles: ProfileConfig[] = [{ id: "a" }, { id: "b" }, { id: "c" }]
    const result = planProfileRemove(profiles, "b", PROFILES_DIR)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.profiles.map(p => p.id)).toEqual(["a", "c"])
    expect(result.plan.removed.id).toBe("b")
  })

  test("refuses a name nothing answers to", () => {
    const result = planProfileRemove([{ id: "a" }], "ghost", PROFILES_DIR)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.hint).toBeUndefined()
  })

  test("refuses a former name, and says which profile holds it now", () => {
    const result = planProfileRemove([{ id: "employer", aliases: ["work"] }], "work", PROFILES_DIR)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.hint).toContain("employer")
  })

  test("removing an id never matches an alias on another profile", () => {
    // Both profiles answer to "work" — one as its real id, one as a redirect.
    // The real one is the only correct target.
    const profiles: ProfileConfig[] = [{ id: "old", aliases: ["work"] }, { id: "work" }]
    const result = planProfileRemove(profiles, "work", PROFILES_DIR)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.profiles.map(p => p.id)).toEqual(["old"])
  })
})

describe("applyProfileRemove", () => {
  let root: string
  let profilesDir: string
  let configFile: string
  let savedConfigDir: string | undefined

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "meridian-remove-"))
    profilesDir = join(root, "profiles")
    configFile = join(root, "profiles.json")
    mkdirSync(profilesDir, { recursive: true })
    savedConfigDir = process.env.MERIDIAN_CONFIG_DIR
    process.env.MERIDIAN_CONFIG_DIR = root
  })

  afterEach(() => {
    if (savedConfigDir !== undefined) process.env.MERIDIAN_CONFIG_DIR = savedConfigDir
    else delete process.env.MERIDIAN_CONFIG_DIR
    chmodSync(profilesDir, 0o700)
    rmSync(root, { recursive: true, force: true })
  })

  function seed(profiles: ProfileConfig[]): void {
    writeFileSync(configFile, JSON.stringify(profiles, null, 2))
  }

  function readConfig(): ProfileConfig[] {
    return JSON.parse(readFileSync(configFile, "utf-8"))
  }

  function seedProfileDir(id: string): string {
    const dir = join(profilesDir, id)
    mkdirSync(dir)
    writeFileSync(join(dir, ".credentials.json"), "{}")
    return dir
  }

  test("drops the entry and deletes the credentials it owned", () => {
    const workDir = seedProfileDir("work")
    seed([{ id: "work", claudeConfigDir: workDir }, { id: "personal" }])

    const result = applyProfileRemove("work", { profilesDir, configFile })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.dirsRemoved).toEqual([workDir])
    expect(result.dirsOrphaned).toEqual([])
    expect(existsSync(workDir)).toBe(false)
    expect(readConfig().map(p => p.id)).toEqual(["personal"])
  })

  test("leaves a credential directory it does not own alone", () => {
    // A profile pointed outside profilesDir names credentials somebody else
    // owns — the host's own ~/.claude in the reported case — and removing one
    // account must never delete those.
    const foreign = join(root, "not-ours")
    mkdirSync(foreign)
    seed([{ id: "wild", claudeConfigDir: foreign }])

    const result = applyProfileRemove("wild", { profilesDir, configFile })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.dirsRemoved).toEqual([])
    expect(existsSync(foreign)).toBe(true)
    expect(readConfig()).toEqual([])
  })

  test("deletes the isolation dir an oauth-token profile never recorded", () => {
    const isolation = seedProfileDir("ci")
    seed([{ id: "ci", type: "oauth-token" }])

    const result = applyProfileRemove("ci", { profilesDir, configFile })

    expect(result.ok).toBe(true)
    expect(existsSync(isolation)).toBe(false)
  })

  test("removes the profile even when the directory cannot be deleted, and reports the orphan", () => {
    if (process.getuid?.() === 0) return // root ignores the write bit
    const workDir = seedProfileDir("work")
    seed([{ id: "work", claudeConfigDir: workDir }])
    chmodSync(profilesDir, 0o500)

    const result = applyProfileRemove("work", { profilesDir, configFile })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(readConfig()).toEqual([])
    expect(result.dirsRemoved).toEqual([])
    expect(result.dirsOrphaned.map(o => o.dir)).toEqual([workDir])
    expect(existsSync(workDir)).toBe(true)
  })

  test("deletes nothing when the profile list cannot be written", () => {
    if (process.getuid?.() === 0) return // root ignores the read-only bit
    const workDir = seedProfileDir("work")
    seed([{ id: "work", claudeConfigDir: workDir }])
    chmodSync(configFile, 0o400)

    const result = applyProfileRemove("work", { profilesDir, configFile })

    expect(result.ok).toBe(false)
    expect(existsSync(join(workDir, ".credentials.json"))).toBe(true)
    expect(readConfig()[0]!.id).toBe("work")
  })

  test("named no paths, it works on the config directory this instance uses", () => {
    // The web route passes no options, so this is the call it makes. While the
    // defaults hardcoded ~/.config/meridian, the instance that owns the
    // credentials searched the OTHER instance's profiles.json - answering
    // "not found" for a profile the page had just listed, and, for any id the
    // two files shared, queueing the wrong account's credentials for deletion.
    const workDir = seedProfileDir("work")
    seed([{ id: "work", claudeConfigDir: workDir }, { id: "personal" }])

    const result = applyProfileRemove("work")

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.dirsRemoved).toEqual([workDir])
    expect(existsSync(workDir)).toBe(false)
    expect(readConfig().map(p => p.id)).toEqual(["personal"])
  })

  test("refuses an unknown profile without touching the file", () => {
    seed([{ id: "work" }])

    const result = applyProfileRemove("ghost", { profilesDir, configFile })

    expect(result.ok).toBe(false)
    expect(readConfig().map(p => p.id)).toEqual(["work"])
  })
})

describe("the /profiles page wires the remove control", () => {
  test("the button, the confirmation and the route are all present", async () => {
    const { profilePageHtml } = await import("../telemetry/profilePage")

    expect(profilePageHtml).toContain("startRemove(")
    expect(profilePageHtml).toContain("commitRemove(")
    expect(profilePageHtml).toContain("cancelRemove()")
    expect(profilePageHtml).toContain("'/profiles/remove'")
  })

  test("a pending confirmation suspends the poll", async () => {
    const { profilePageHtml } = await import("../telemetry/profilePage")

    // The poll rewrites innerHTML. Without this guard a tick lands between the
    // confirmation appearing and the click that answers it, and the click
    // reaches whichever card the redraw put in that spot.
    expect(profilePageHtml).toContain("if (editingProfile || removingProfile) return;")
  })
})
