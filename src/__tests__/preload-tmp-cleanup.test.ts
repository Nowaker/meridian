import { describe, expect, it } from "bun:test"
import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { sweepStaleTestDirs, testDirsFor } from "./test-tmp-dirs"

const PRELOAD = resolve(import.meta.dir, "preload.ts")

function withRoot(fn: (root: string) => void | Promise<void>) {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), "meridian-preload-tmp-"))
    try {
      await fn(root)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
}

function childEnv(root: string) {
  return { ...process.env, TMPDIR: root, TMP: root, TEMP: root }
}

function testDirsIn(root: string) {
  return readdirSync(root).filter(name => name.startsWith("meridian-test-")).sort()
}

function writeFixture(root: string, body: string) {
  const fixture = join(root, "fixture.test.ts")
  writeFileSync(fixture, `import { expect, test } from "bun:test"\nimport { existsSync } from "node:fs"\n${body}\n`)
  return fixture
}

function runSuite(root: string, fixture: string, extraArgs: string[] = []) {
  const result = spawnSync(process.execPath, ["test", "--preload", PRELOAD, ...extraArgs, fixture], {
    cwd: root, env: childEnv(root), encoding: "utf8", timeout: 15_000,
  })
  if (result.error) throw result.error
  return result
}

describe("test preload scratch directories", () => {
  it("are removed when a passing run exits", withRoot(root => {
    const fixture = writeFixture(root, `
      test("dirs exist under the redirected tmpdir while the run is live", () => {
        expect(process.env.MERIDIAN_CONFIG_DIR!.startsWith(${JSON.stringify(root)})).toBe(true)
        expect(existsSync(process.env.MERIDIAN_CONFIG_DIR!)).toBe(true)
        expect(existsSync(process.env.MERIDIAN_SESSION_DIR!)).toBe(true)
      })
    `)
    const result = runSuite(root, fixture)
    expect({ status: result.status, output: result.stdout + result.stderr }).toMatchObject({ status: 0 })
    expect(testDirsIn(root)).toEqual([])
  }), 20_000)

  it("are removed when a run fails", withRoot(root => {
    const fixture = writeFixture(root, `test("fails", () => { expect(1).toBe(2) })`)
    const result = runSuite(root, fixture)
    expect(result.status).not.toBe(0)
    expect(testDirsIn(root)).toEqual([])
  }), 20_000)

  it("are removed when a test times out", withRoot(root => {
    const fixture = writeFixture(root, `test("hangs", () => new Promise(r => setTimeout(r, 10_000)))`)
    const result = runSuite(root, fixture, ["--timeout", "200"])
    expect(result.status).not.toBe(0)
    expect(testDirsIn(root)).toEqual([])
  }), 20_000)

  it("left behind by a killed run are swept by the next run, sparing live owners", withRoot(async root => {
    const hanging = writeFixture(root, `test("hangs", () => new Promise(r => setTimeout(r, 60_000)))`)
    const child = spawn(process.execPath, ["test", "--preload", PRELOAD, "--timeout", "120000", hanging], {
      cwd: root, env: childEnv(root), stdio: "ignore",
    })
    const killedDirs = testDirsFor(root, child.pid!)
    const deadline = Date.now() + 10_000
    while (!(existsSync(killedDirs.configDir) && existsSync(killedDirs.sessionDir))) {
      if (Date.now() > deadline) throw new Error("child never created its scratch directories")
      await Bun.sleep(50)
    }
    const exited = new Promise(r => child.once("exit", r))
    child.kill("SIGKILL")
    await exited
    expect(existsSync(killedDirs.configDir)).toBe(true)
    expect(existsSync(killedDirs.sessionDir)).toBe(true)

    // This process is alive, so a directory carrying its pid must survive.
    const liveDirs = testDirsFor(root, process.pid)
    mkdirSync(liveDirs.configDir)
    mkdirSync(join(root, "meridian-test-settings-notapid"))

    const fixture = writeFixture(root, `test("passes", () => {})`)
    const result = runSuite(root, fixture)
    expect({ status: result.status, output: result.stdout + result.stderr }).toMatchObject({ status: 0 })
    expect(testDirsIn(root)).toEqual([`meridian-test-settings-${process.pid}`, "meridian-test-settings-notapid"])
  }), 30_000)

  it("sweep removes only dead owners' directories", withRoot(root => {
    const dead = testDirsFor(root, 111111)
    const live = testDirsFor(root, 222222)
    for (const dir of [dead.configDir, dead.sessionDir, live.configDir, live.sessionDir]) {
      mkdirSync(join(dir, "nested"), { recursive: true })
    }
    const removed = sweepStaleTestDirs(root, pid => pid === 222222)
    expect(removed.sort()).toEqual([dead.sessionDir, dead.configDir].sort())
    expect(testDirsIn(root)).toEqual(["meridian-test-sessions-222222", "meridian-test-settings-222222"])
  }))
})
