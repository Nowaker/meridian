import { afterEach, describe, expect, it, spyOn } from "bun:test"
import * as promises from "node:fs/promises"
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { fileDigest, retireImportedFile } from "../proxy/session/storeDatabase"
import { withLegacySessionStoreLock } from "../proxy/session/legacySessionStoreLock"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "meridian-migration-lock-"))
  roots.push(dir)
  const path = join(dir, "sessions.json")
  const imported = JSON.stringify({ imported: { claudeSessionId: "already-in-db" } })
  const replacement = JSON.stringify({ later: { claudeSessionId: "not-yet-in-db" } })
  writeFileSync(path, imported, { mode: 0o600 })
  return { dir, path, imported, replacement, digest: fileDigest(Buffer.from(imported)) }
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
function publish(path: string, bytes: string) {
  const staging = path + ".writer-tmp"
  writeFileSync(staging, bytes, { mode: 0o600 })
  renameSync(staging, path)
}

describe("SQLite retirement cooperates with legacy JSON writers", () => {
  it("waits for a live JSON writer before checking what was imported", async () => {
    const f = fixture(), entered = deferred(), release = deferred()
    const writer = withLegacySessionStoreLock(f.path, async () => {
      entered.resolve()
      await release.promise
      publish(f.path, f.replacement)
    })
    await entered.promise
    let finished = false
    const retirement = retireImportedFile(f.path, f.digest).finally(() => { finished = true })
    try {
      await new Promise(resolve => setTimeout(resolve, 30))
      expect(finished).toBe(false)
    } finally {
      release.resolve()
      await writer
      await retirement
    }
    expect(readFileSync(f.path, "utf8")).toBe(f.replacement)
    expect(readdirSync(f.dir)).toEqual(["sessions.json"])
  })

  it("keeps a replacement published at the retirement rename boundary active", async () => {
    const f = fixture(), rename = promises.rename
    let interleaved = false, writer: Promise<void> | undefined
    const observed = spyOn(promises, "rename").mockImplementation(async (from, to) => {
      if (String(from) === f.path && !interleaved) {
        interleaved = true
        // A cooperating older writer uses the same canonical .lock protocol.
        // Unfenced source lets it finish here; fenced retirement makes it wait
        // until the imported inode is renamed and the lock is released.
        const migrationHoldsLock = existsSync(f.path + ".lock")
        writer = withLegacySessionStoreLock(f.path, async () => { publish(f.path, f.replacement) })
        if (!migrationHoldsLock) await writer
      }
      return rename(from, to)
    })
    let retired: string | undefined
    try {
      retired = await retireImportedFile(f.path, f.digest)
      await writer
    } finally {
      observed.mockRestore()
      await writer
    }
    expect(interleaved).toBe(true)
    expect(existsSync(f.path)).toBe(true)
    expect(readFileSync(f.path, "utf8")).toBe(f.replacement)
    expect(retired).toBeDefined()
    expect(readFileSync(retired!, "utf8")).toBe(f.imported)
    expect(existsSync(f.path + ".lock")).toBe(false)
  })

  it("fails closed on a live-writer lock timeout and removes its staging name", async () => {
    const f = fixture(), entered = deferred(), release = deferred()
    const writer = withLegacySessionStoreLock(f.path, async () => { entered.resolve(); await release.promise })
    await entered.promise
    const previous = process.env.MERIDIAN_SESSION_LOCK_TIMEOUT_MS
    process.env.MERIDIAN_SESSION_LOCK_TIMEOUT_MS = "20"
    let failure: unknown
    try {
      try { await retireImportedFile(f.path, f.digest) } catch (error) { failure = error }
      expect(failure).toBeInstanceOf(Error)
      expect(String(failure)).toContain("timed out waiting for lock")
      expect(readFileSync(f.path, "utf8")).toBe(f.imported)
    } finally {
      if (previous === undefined) delete process.env.MERIDIAN_SESSION_LOCK_TIMEOUT_MS
      else process.env.MERIDIAN_SESSION_LOCK_TIMEOUT_MS = previous
      release.resolve()
      await writer
    }
    expect(readdirSync(f.dir)).toEqual(["sessions.json"])
  })

  it("keeps missing-file retirement harmless even after its directory was removed", async () => {
    const f = fixture()
    rmSync(f.dir, { recursive: true })
    const result = await retireImportedFile(f.path, f.digest)
    expect(result).toBeUndefined()
    expect(existsSync(f.dir)).toBe(false)
  })

  it("releases the legacy fence after a real-file read error", async () => {
    const f = fixture()
    const failure = Object.assign(new Error("owned read failure"), { code: "EIO" })
    const observed = spyOn(promises, "readFile").mockRejectedValueOnce(failure)
    let caught: unknown
    try {
      try { await retireImportedFile(f.path, f.digest) } catch (error) { caught = error }
    } finally { observed.mockRestore() }
    expect(caught).toBe(failure)
    expect(readFileSync(f.path, "utf8")).toBe(f.imported)
    expect(readdirSync(f.dir)).toEqual(["sessions.json"])
  })

  it("serializes two migrating owners without overwriting a retired file", async () => {
    const f = fixture()
    const results = await Promise.all([retireImportedFile(f.path, f.digest), retireImportedFile(f.path, f.digest)])
    const retired = results.filter((path): path is string => typeof path === "string")
    expect(retired).toHaveLength(1)
    expect(readFileSync(retired[0]!, "utf8")).toBe(f.imported)
    expect(readdirSync(f.dir)).toHaveLength(1)
    expect(existsSync(f.path + ".lock")).toBe(false)
  })

  it("retires the matching imported inode and leaves a changed file for later import", async () => {
    const f = fixture()
    const changed = await retireImportedFile(f.path, fileDigest(Buffer.from(f.replacement)))
    expect(changed).toBeUndefined()
    expect(readFileSync(f.path, "utf8")).toBe(f.imported)
    const retired = await retireImportedFile(f.path, f.digest)
    expect(retired).toBeDefined()
    expect(readFileSync(retired!, "utf8")).toBe(f.imported)
    expect(existsSync(f.path)).toBe(false)
    expect(existsSync(f.path + ".lock")).toBe(false)
  })
})
