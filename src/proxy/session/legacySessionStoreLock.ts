/** Legacy JSON writer lock, retained only to fence SQLite migration retirement.
 * Same initialized-owner, hard-link and incarnation/recovery protocol as the
 * JSON writer in #1220. A database lock cannot fence an older JSON process.
 */
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { link, open, readFile, unlink, type FileHandle } from "node:fs/promises"
import { setTimeout as waitForLockRetry } from "node:timers/promises"
import { randomUUID } from "node:crypto"
import { hostname } from "node:os"
import { basename, dirname, join } from "node:path"
import { directoryRenameWasBlockedSync, syncDirectoryDurablySync } from "./durableFileSystem"
import { createRecoveryClaimOwner, getRecoveryClaimPath, getRecoveryClaimTombstonePath, parseRecoveryClaimOwnerJson, recoveryClaimOwnerIsDead, type RecoveryClaimOwner } from "./recoveryClaim"
import { captureProcessIncarnation, parseProcessIncarnation, processIncarnationIsDead, type ProcessIncarnation } from "./processIncarnation"
const STALE_LOCK_THRESHOLD_MS = 30_000
const DEFAULT_LOCK_WAIT_MS = 10_000
const LOCK_RETRY_MS = 10

function getLockWaitMs(): number {
  const raw = process.env.MERIDIAN_SESSION_LOCK_TIMEOUT_MS
    ?? process.env.CLAUDE_PROXY_SESSION_LOCK_TIMEOUT_MS
  if (!raw) return DEFAULT_LOCK_WAIT_MS
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_LOCK_WAIT_MS
  return parsed
}

interface StoreLock {
  path: string
  token: string
}

interface StoreLockCandidate {
  /** Become the lock with an atomic no-replace hard link. False: it is held. */
  publish: () => Promise<boolean>
  /** Drop the staging name. A published candidate stays linked as the lock. */
  discard: () => Promise<void>
}

/** Initialise fully written lock metadata once per acquisition, off the event
 *  loop, and re-link it on every attempt.
 *
 *  The fsync is load-bearing: stale-lock recovery retires only a lock whose
 *  owner it can parse and prove dead, so a crash must never leave the lock
 *  linked to an unwritten inode. One fsync per attempt does not follow from
 *  that, and on a slow disk it made every retry cost a journal commit on the
 *  directory the holder is about to fsync. This is the same protocol as the
 *  session lifecycle sidecar lock. */
async function createInitializedLockCandidate(path: string, contents: string): Promise<StoreLockCandidate> {
  const staging = `${path}.candidate-${process.pid}-${randomUUID()}`
  const discard = async (): Promise<void> => {
    try {
      await unlink(staging)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error("[sessionStore] lock staging cleanup failed:", (error as Error).message)
      }
    }
  }
  let handle: FileHandle | undefined
  try {
    handle = await open(staging, "wx", 0o600)
    await handle.chmod(0o600)
    await handle.writeFile(contents, "utf8")
    await handle.sync()
    await handle.close()
    handle = undefined
  } catch (error) {
    if (handle) {
      await handle.close().catch((closeError: unknown) => {
        console.error("[sessionStore] lock staging close failed:", (closeError as Error).message)
      })
    }
    await discard()
    throw error
  }
  return {
    publish: async () => {
      try {
        await link(staging, path)
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return false
        throw error
      }
    },
    discard,
  }
}

interface CanonicalStoreLockOwner {
  pid: number
  hostname: string
  token: string
  incarnation: ProcessIncarnation
}

function parseCanonicalStoreLockOwner(contents: string): CanonicalStoreLockOwner | undefined {
  try {
    const owner = JSON.parse(contents) as Record<string, unknown>
    const incarnation = parseProcessIncarnation(owner.incarnation)
    if (
      typeof owner.pid !== "number"
      || !Number.isInteger(owner.pid)
      || owner.pid <= 0
      || typeof owner.hostname !== "string"
      || owner.hostname.length === 0
      || typeof owner.token !== "string"
      || owner.token.length === 0
      || !incarnation
    ) return undefined
    return {
      pid: owner.pid,
      hostname: owner.hostname,
      token: owner.token,
      incarnation,
    }
  } catch {
    return undefined
  }
}

function canonicalStoreLockOwnerIsDead(contents: string): boolean {
  const owner = parseCanonicalStoreLockOwner(contents)
  return owner ? processIncarnationIsDead(owner.incarnation) : false
}

interface StoreRecoveryClaimSnapshot {
  dev: number
  ino: number
  owner?: RecoveryClaimOwner
}

function snapshotStoreRecoveryClaim(claimPath: string): StoreRecoveryClaimSnapshot | undefined {
  let info: ReturnType<typeof lstatSync>
  try {
    info = lstatSync(claimPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
  if (!info.isDirectory() || info.isSymbolicLink()) return { dev: info.dev, ino: info.ino }

  let owner: RecoveryClaimOwner | undefined
  try {
    owner = parseRecoveryClaimOwnerJson(readFileSync(join(claimPath, "owner.json"), "utf8"))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  return { dev: info.dev, ino: info.ino, owner }
}

/** Atomically publish a fully initialized, non-empty recovery owner directory. */
function publishStoreRecoveryClaim(claimPath: string, owner: RecoveryClaimOwner): boolean {
  const candidate = `${claimPath}.candidate-${process.pid}-${owner.token}`
  let fd: number | undefined
  let published = false
  try {
    mkdirSync(candidate, { mode: 0o700 })
    fd = openSync(join(candidate, "owner.json"), "wx", 0o600)
    writeFileSync(fd, JSON.stringify(owner), "utf8")
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    syncDirectoryDurablySync(candidate)

    // Protocol-created destinations are non-empty directories, so rename is
    // atomic and no-replace. Refuse malformed pre-existing paths as well.
    try {
      lstatSync(claimPath)
      return false
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    try {
      renameSync(candidate, claimPath)
      published = true
      syncDirectoryDurablySync(dirname(claimPath))
      return true
    } catch (error) {
      if (directoryRenameWasBlockedSync(error, claimPath)) return false
      throw error
    }
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch (error) {
        console.error("[sessionStore] recovery claim owner close failed:", (error as Error).message)
      }
    }
    if (!published) {
      try { rmSync(candidate, { recursive: true, force: true }) } catch (error) {
        console.error("[sessionStore] recovery claim candidate cleanup failed:", (error as Error).message)
      }
    }
  }
}

/** Retire only the observed dead claim generation. Its tombstone fences ABA. */
function retireDeadStoreRecoveryClaim(claimPath: string, generation: string): boolean {
  const observed = snapshotStoreRecoveryClaim(claimPath)
  if (!observed) return true
  if (
    !observed.owner
    || observed.owner.generation !== generation
    || !recoveryClaimOwnerIsDead(observed.owner)
  ) return false

  const tombstone = getRecoveryClaimTombstonePath(claimPath, observed.owner.token)
  try {
    lstatSync(tombstone)
    return false
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }

  const current = snapshotStoreRecoveryClaim(claimPath)
  if (
    !current
    || current.dev !== observed.dev
    || current.ino !== observed.ino
    || current.owner?.token !== observed.owner.token
    || current.owner.generation !== generation
    || !recoveryClaimOwnerIsDead(current.owner)
  ) return !current

  try {
    renameSync(claimPath, tombstone)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT") return true
    if (directoryRenameWasBlockedSync(error, tombstone)) return false
    throw error
  }

  const moved = snapshotStoreRecoveryClaim(tombstone)
  if (
    !moved
    || moved.dev !== observed.dev
    || moved.ino !== observed.ino
    || moved.owner?.token !== observed.owner.token
    || moved.owner.generation !== generation
  ) throw new Error("recovery claim identity changed during retirement")
  return true
}

function releaseStoreRecoveryClaim(claimPath: string, owner: RecoveryClaimOwner): void {
  try {
    const current = snapshotStoreRecoveryClaim(claimPath)
    if (current?.owner?.token === owner.token && current.owner.generation === owner.generation) {
      rmSync(claimPath, { recursive: true })
    }
  } catch (error) {
    console.error("[sessionStore] stale recovery claim cleanup failed:", (error as Error).message)
  }
}

function cleanupStoreRecoveryTombstones(claimPath: string): void {
  const prefix = `${basename(claimPath)}.orphan-`
  try {
    for (const name of readdirSync(dirname(claimPath))) {
      if (!name.startsWith(prefix)) continue
      const path = join(dirname(claimPath), name)
      const info = lstatSync(path)
      if (info.isDirectory() && !info.isSymbolicLink()) {
        rmSync(path, { recursive: true })
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("[sessionStore] stale recovery tombstone cleanup failed:", (error as Error).message)
    }
  }
}

function retireStaleLock(lockPath: string): boolean {
  let token: string
  let info: ReturnType<typeof statSync>
  try {
    token = readFileSync(lockPath, "utf8")
    info = statSync(lockPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true
    throw new Error(`[sessionStore] stale lock inspection failed: ${(error as Error).message}`, { cause: error })
  }
  if (
    Date.now() - info.mtimeMs <= STALE_LOCK_THRESHOLD_MS
    || !canonicalStoreLockOwnerIsDead(token)
  ) return false

  const generation = token
  const claimPath = getRecoveryClaimPath(lockPath, generation)
  const claimOwner = createRecoveryClaimOwner(generation)
  try {
    if (!publishStoreRecoveryClaim(claimPath, claimOwner)) {
      if (!retireDeadStoreRecoveryClaim(claimPath, generation)) return false
      if (!publishStoreRecoveryClaim(claimPath, claimOwner)) return false
    }
  } catch (error) {
    throw new Error(`[sessionStore] stale recovery claim failed: ${(error as Error).message}`, { cause: error })
  }

  let generationResolved = false
  try {
    let currentToken: string
    let currentInfo: ReturnType<typeof statSync>
    try {
      currentToken = readFileSync(lockPath, "utf8")
      currentInfo = statSync(lockPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        generationResolved = true
        return true
      }
      throw error
    }
    if (
      currentToken !== token
      || currentInfo.dev !== info.dev
      || currentInfo.ino !== info.ino
    ) {
      generationResolved = true
      return true
    }
    if (
      Date.now() - currentInfo.mtimeMs <= STALE_LOCK_THRESHOLD_MS
      || !canonicalStoreLockOwnerIsDead(currentToken)
    ) return false

    const retiredPath = `${lockPath}.stale-${process.pid}-${randomUUID()}`
    renameSync(lockPath, retiredPath)
    generationResolved = true
    try {
      const movedToken = readFileSync(retiredPath, "utf8")
      if (movedToken !== currentToken) {
        throw new Error("claimed lock identity changed during stale recovery")
      }
      unlinkSync(retiredPath)
    } catch (error) {
      console.error("[sessionStore] stale lock cleanup failed:", (error as Error).message)
    }
    return true
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    if (err.code === "ENOENT") {
      generationResolved = true
      return true
    }
    throw new Error(`[sessionStore] stale lock recovery failed: ${err.message}`, { cause: err })
  } finally {
    releaseStoreRecoveryClaim(claimPath, claimOwner)
    if (generationResolved) cleanupStoreRecoveryTombstones(claimPath)
  }
}

async function acquireLock(lockPath: string): Promise<StoreLock> {
  const incarnation = captureProcessIncarnation()
  if (!incarnation) throw new Error("[sessionStore] cannot capture lock owner process incarnation")
  const token = JSON.stringify({
    pid: process.pid,
    hostname: hostname(),
    token: randomUUID(),
    incarnation,
  })
  const deadline = performance.now() + getLockWaitMs()

  let candidate: StoreLockCandidate
  try {
    candidate = await createInitializedLockCandidate(lockPath, token)
  } catch (error) {
    throw new Error(`[sessionStore] lock acquire failed: ${(error as Error).message}`, { cause: error })
  }
  try {
    while (true) {
      try {
        if (await candidate.publish()) return { path: lockPath, token }
      } catch (error) {
        throw new Error(`[sessionStore] lock acquire failed: ${(error as Error).message}`, { cause: error })
      }

      if (deadline - performance.now() <= 0) {
        throw new Error(`[sessionStore] timed out waiting for lock ${lockPath}`)
      }
      if (retireStaleLock(lockPath)) continue
      const remaining = deadline - performance.now()
      if (remaining <= 0) {
        throw new Error(`[sessionStore] timed out waiting for lock ${lockPath}`)
      }
      await waitForLockRetry(Math.min(LOCK_RETRY_MS, remaining))
    }
  } finally {
    await candidate.discard()
  }
}

async function releaseLock(lock: StoreLock): Promise<void> {
  try {
    if (await readFile(lock.path, "utf8") !== lock.token) {
      console.error("[sessionStore] lock ownership changed before release")
      return
    }
    await unlink(lock.path)
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    if (err.code !== "ENOENT") {
      console.error("[sessionStore] lock release failed:", err.message)
    }
  }
}

/** Hold the exact older JSON writer fence across digest verification/rename. */
export async function withLegacySessionStoreLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const lock = await acquireLock(`${path}.lock`)
  try {
    return await operation()
  } finally {
    await releaseLock(lock)
  }
}
