/**
 * Process-lifetime lock and gate files are not fsynced.
 *
 * Each of these files only matters while the process that wrote it lives. A
 * process crash leaves their contents in the page cache, where every other
 * process reads them. Only an OS crash or power loss can lose the contents,
 * and then every holder is dead too: recovery reclaims a lock it cannot
 * parse once it predates the current boot. Each fsync here used to cost
 * ~250 ms of journal wait on a loaded /home, hundreds of times a minute.
 *
 * The store database's writer commits with synchronous=NORMAL for the same
 * reason; see storeDatabase.ts.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test"
import * as fsPromises from "node:fs/promises"
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir, uptime } from "node:os"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import AsyncDatabase from "libsql/promise"
import * as durableFileSystem from "../proxy/session/durableFileSystem"
import { CrossProcessTurnCoordinator } from "../proxy/session/crossProcessTurnCoordinator"
import { createSdkProcessGate } from "../proxy/session/sdkProcessGate"
import { openStoreDatabase, closeStoreDatabase } from "../proxy/session/storeDatabase"
import {
  abandonFork,
  createInitializedSidecarLockCandidate,
  prepareFork,
  runGc,
} from "../proxy/sessionLifecycle"

const roots: string[] = []
function root(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix))
  roots.push(path)
  return path
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true })
})

/** Every file and directory fsync the code under test asks for, by path. */
async function recordSyncs<T>(operation: () => Promise<T>): Promise<{ result: T; synced: string[] }> {
  const synced: string[] = []
  const realOpen = fsPromises.open
  const openSpy = spyOn(fsPromises, "open").mockImplementation(async (...args: Parameters<typeof realOpen>) => {
    const handle = await realOpen(...args)
    const path = String(args[0])
    const sync = handle.sync.bind(handle)
    const datasync = handle.datasync.bind(handle)
    handle.sync = async () => { synced.push(path); return sync() }
    handle.datasync = async () => { synced.push(path); return datasync() }
    return handle
  })
  const realSyncDirectory = durableFileSystem.syncDirectoryDurably
  const directorySpy = spyOn(durableFileSystem, "syncDirectoryDurably").mockImplementation(async (path) => {
    synced.push(path)
    return realSyncDirectory(path)
  })
  try {
    return { result: await operation(), synced }
  } finally {
    openSpy.mockRestore()
    directorySpy.mockRestore()
  }
}

describe("process-lifetime lock and gate files", () => {
  test("a session-gc lock candidate is written without fsync", async () => {
    const dir = root("meridian-fsync-sidecar-")
    const lock = join(dir, "session-gc.json.lock")
    const { result: candidate, synced } = await recordSyncs(() =>
      createInitializedSidecarLockCandidate(lock, "this-owner\n"))
    expect(await candidate.publish()).toBe(true)
    await candidate.discard()
    expect(synced).toEqual([])
  })

  // The exception: a turn lock's owner is flushed so a host crash cannot tear it.
  test("a turn lock flushes its owner record and directories at acquire, and nothing at release", async () => {
    const locks = join(root("meridian-fsync-turn-"), "turn-locks")
    const turns = new CrossProcessTurnCoordinator(locks, { acquireTimeoutMs: 10_000 })
    const { synced } = await recordSyncs(async () => {
      const lease = await turns.acquire("conversation")
      await lease.release()
    })
    // A directory sync shows twice: syncDirectoryDurably opens it through fs.promises.
    const paths = [...new Set(synced)]
    expect(paths).toHaveLength(3)
    expect(paths[0]).toEndWith("/owner.json")
    expect(paths[1]).toBe(dirname(paths[0]!))
    expect(paths[2]).toBe(locks)
  })

  test("an SDK process gate is published without fsync", async () => {
    const gates = join(root("meridian-fsync-sdk-gate-"), "sdk-process-gates")
    const { synced } = await recordSyncs(async () => {
      const gate = await createSdkProcessGate(gates, async () => undefined)
      const child = gate.spawnClaudeCodeProcess({
        command: process.execPath,
        args: ["-e", "process.stdin.pipe(process.stdout)"],
        env: { ...process.env },
        signal: new AbortController().signal,
      })
      const output = new Promise<string>((resolve) => {
        child.stdout.once("data", (chunk) => resolve(chunk.toString()))
      })
      child.stdin.write("gated\n")
      expect(await output).toBe("gated\n")
      child.stdin.end()
      expect(await gate.closeAndJoin()).toBe(true)
    })
    expect(synced.filter((path) => path.startsWith(gates))).toEqual([])
  })

  test("a session deletion gate is opened without fsync", async () => {
    const dir = root("meridian-fsync-deletion-")
    const storeDir = join(dir, "store")
    const sdkPath = join(dir, "stub-sdk.mjs")
    writeFileSync(sdkPath, "export async function deleteSession() {}\n")
    const options = {
      storeDir,
      preparedGraceMs: 0,
      retiredGraceMs: 0,
      lockWaitMs: 2_000,
      lockRetryMs: 5,
      sdkModuleUrl: pathToFileURL(sdkPath).href,
    }
    const locator = { sessionId: "fsync-deletion", configDir: join(dir, "config"), projectDir: join(dir, "project") }
    await abandonFork(await prepareFork(locator, options), options)

    const { result, synced } = await recordSyncs(() => runGc([], options))
    expect(result.deleted).toBe(1)
    expect(synced.filter((path) => path.includes("deletion-gates"))).toEqual([])
    await closeStoreDatabase(storeDir)
  }, 30_000)
})

describe("crash recovery without lock fsyncs", () => {
  test("reclaims an unreadable session-gc lock left by an earlier boot", async () => {
    const storeDir = root("meridian-fsync-preboot-")
    const lock = join(storeDir, "session-gc.json.lock")
    // What a power loss leaves of an unsynced lock: its size, not its data.
    writeFileSync(lock, "\0".repeat(180), { mode: 0o600 })
    const beforeBoot = (Date.now() - uptime() * 1000 - 3_600_000) / 1000
    utimesSync(lock, beforeBoot, beforeBoot)

    const locator = { sessionId: "after-power-loss", configDir: join(storeDir, "config"), projectDir: join(storeDir, "project") }
    await prepareFork(locator, { storeDir, lockWaitMs: 2_000, lockRetryMs: 1, lockStaleMs: 10 })
    expect(readdirSync(storeDir).filter((name) => name.startsWith("session-gc.json.lock"))).toEqual([])
    await closeStoreDatabase(storeDir)
  })

  test("keeps an unreadable session-gc lock written during this boot", async () => {
    const storeDir = root("meridian-fsync-thisboot-")
    const lock = join(storeDir, "session-gc.json.lock")
    writeFileSync(lock, "\0".repeat(180), { mode: 0o600 })
    const stale = (Date.now() - 60_000) / 1000
    utimesSync(lock, stale, stale)

    const locator = { sessionId: "blocked", configDir: join(storeDir, "config"), projectDir: join(storeDir, "project") }
    await expect(prepareFork(locator, { storeDir, lockWaitMs: 20, lockRetryMs: 1, lockStaleMs: 10 }))
      .rejects.toThrow("timed out waiting for")
  })
})

describe("store database durability", () => {
  test("the writer commits with synchronous=NORMAL", async () => {
    const dir = root("meridian-fsync-store-")
    const executed: string[] = []
    const realExec = AsyncDatabase.prototype.exec
    const execSpy = spyOn(AsyncDatabase.prototype, "exec").mockImplementation(function (this: AsyncDatabase, sql: string) {
      executed.push(sql)
      return realExec.call(this, sql)
    })
    try {
      const database = openStoreDatabase(dir, 1_000)
      const { committed } = await database.transact({
        lockWaitMs: 1_000,
        build: () => ({ ops: [["UPDATE store_info SET format = format WHERE id = 1", []]], result: undefined }),
      })
      expect(committed).toBe(true)
      await closeStoreDatabase(dir)
    } finally {
      execSpy.mockRestore()
    }
    const synchronous = executed.filter((sql) => /^PRAGMA synchronous\b/i.test(sql))
    expect(synchronous).toEqual(["PRAGMA synchronous = NORMAL"])
  })

  test("a deletion claim is synced to disk before any deletion starts", async () => {
    const dir = root("meridian-fsync-claim-")
    const storeDir = join(dir, "store")
    const sdkPath = join(dir, "stub-sdk.mjs")
    writeFileSync(sdkPath, "export async function deleteSession() {}\n")
    const options = {
      storeDir,
      preparedGraceMs: 0,
      retiredGraceMs: 0,
      lockWaitMs: 2_000,
      lockRetryMs: 5,
      sdkModuleUrl: pathToFileURL(sdkPath).href,
    }
    const locator = { sessionId: "durable-claim", configDir: join(dir, "config"), projectDir: join(dir, "project") }
    await abandonFork(await prepareFork(locator, options), options)

    const events: string[] = []
    const realExec = AsyncDatabase.prototype.exec
    const execSpy = spyOn(AsyncDatabase.prototype, "exec").mockImplementation(function (this: AsyncDatabase, sql: string) {
      events.push(sql)
      return realExec.call(this, sql)
    })
    const realOpen = fsPromises.open
    const openSpy = spyOn(fsPromises, "open").mockImplementation(async (...args: Parameters<typeof realOpen>) => {
      if (String(args[0]).includes("deletion-gates")) events.push("deletion gate")
      return realOpen(...args)
    })
    try {
      expect((await runGc([], options)).deleted).toBe(1)
    } finally {
      execSpy.mockRestore()
      openSpy.mockRestore()
      await closeStoreDatabase(storeDir)
    }
    const gate = events.indexOf("deletion gate")
    const full = events.indexOf("PRAGMA synchronous = FULL")
    expect(events.filter((sql) => sql === "PRAGMA synchronous = FULL")).toHaveLength(1)
    expect(gate).toBeGreaterThan(0)
    expect(events.slice(full, events.indexOf("PRAGMA synchronous = NORMAL", full) + 1))
      .toEqual(["PRAGMA synchronous = FULL", "BEGIN IMMEDIATE", "COMMIT", "PRAGMA synchronous = NORMAL"])
    expect(events.indexOf("PRAGMA synchronous = NORMAL", full)).toBeLessThan(gate)
  }, 30_000)
})
