import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import SyncDatabase from "libsql"
import { closeStoreDatabase, openStoreDatabase } from "../proxy/session/storeDatabase"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await closeStoreDatabase(root)
    rmSync(root, { recursive: true, force: true })
  }
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "meridian-db-publication-"))
  roots.push(root)
  return openStoreDatabase(root, 1000)
}
const insert = "INSERT INTO sessions (key, seq, entry) VALUES (?, ?, ?)"

describe("SQLite publication authority", () => {
  it("rolls back a refused publication and preserves the exact refusal", async () => {
    const db = fixture()
    const refusal = new Error("owned publication revoked")
    let failure: unknown
    let guards = 0
    try {
      await db.transact({
        lockWaitMs: 1000,
        build: () => ({ ops: [[insert, ["revoked", 1, "{}"]]], result: 1 }),
        beforeCommit: () => {
          guards++
          throw refusal
        },
      })
    } catch (error) {
      failure = error
    }
    expect(failure).toBe(refusal)
    expect(guards).toBe(1)
    expect(db.get("SELECT key FROM sessions WHERE key = ?", "revoked")).toBeUndefined()
    const next = await db.transact({ lockWaitMs: 1000, build: () => ({ ops: [[insert, ["later", 1, "{}"]]], result: 2 }) })
    expect(next).toEqual({ committed: true, result: 2 })
    expect(db.get<{ key: string }>("SELECT key FROM sessions WHERE key = ?", "later")?.key).toBe("later")
  })

  it("rechecks authority after waiting on an actual SQLite writer", async () => {
    const db = fixture()
    const blocker = new SyncDatabase(db.path)
    const refusal = new Error("revoked during native lock wait")
    let allowed = true
    let guards = 0
    let settled = false
    let failure: unknown
    blocker.exec("BEGIN IMMEDIATE")
    const mutation = db.transact({
      lockWaitMs: 1000,
      build: () => ({ ops: [[insert, ["revoked-after-wait", 1, "{}"]]], result: 1 }),
      beforeCommit: () => {
        guards++
        if (!allowed) throw refusal
      },
    }).then(() => { settled = true }, error => {
      settled = true
      failure = error
    })
    try {
      await new Promise(resolve => setTimeout(resolve, 30))
      expect(settled).toBe(false)
      expect(guards).toBe(0)
      allowed = false
    } finally {
      blocker.exec("ROLLBACK")
      await mutation
      blocker.close()
    }
    expect(failure).toBe(refusal)
    expect(guards).toBe(1)
    expect(db.get("SELECT key FROM sessions WHERE key = ?", "revoked-after-wait")).toBeUndefined()
  })
})
