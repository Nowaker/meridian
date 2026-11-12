/**
 * Session-GC deletion throughput and backlog reporting.
 *
 * On a loaded host every lifecycle transaction waits in the lock FIFO behind
 * request traffic, so one deletion at a time (three transactions each) fell
 * below the rate resumes create superseded forks, and the last claim of each
 * sweep was truncated to the run's remainder and failed. The backlog grew
 * silently until the ownership ceiling.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  abandonFork,
  prepareFork,
  registerLiveTranscript,
  runGc,
  type GcBacklog,
  type SessionLifecycleOptions,
  type TranscriptLocator,
} from "../proxy/sessionLifecycle"

describe("session GC throughput", () => {
  let storeDir: string
  let options: SessionLifecycleOptions

  beforeEach(() => {
    storeDir = mkdtempSync(join(tmpdir(), "meridian-gc-throughput-"))
    options = {
      storeDir,
      preparedGraceMs: 0,
      retiredGraceMs: 0,
      lockWaitMs: 2_000,
      lockRetryMs: 1,
    }
  })

  afterEach(() => {
    rmSync(storeDir, { recursive: true, force: true })
  })

  function locator(sessionId: string): TranscriptLocator {
    return { sessionId, configDir: join(storeDir, "config"), projectDir: join(storeDir, "project") }
  }

  async function retire(count: number): Promise<void> {
    for (let index = 0; index < count; index++) {
      await abandonFork(await prepareFork(locator(`retired-${index}`), options), options)
    }
  }

  it("runs a claimed batch's deletions side by side", async () => {
    await retire(4)
    let started = 0
    let allStarted!: () => void
    const everyoneStarted = new Promise<void>((resolve) => { allStarted = resolve })
    // Each deletion settles only once all four are in flight. Deleting one at a
    // time never gets there, and the bounded wait fails it instead of hanging.
    const deleter = async (): Promise<void> => {
      if (++started === 4) allStarted()
      let timer: ReturnType<typeof setTimeout> | undefined
      const bounded = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("deletions ran one at a time")), 2_000)
      })
      try {
        await Promise.race([everyoneStarted, bounded])
      } finally {
        clearTimeout(timer)
      }
    }

    const result = await runGc([], { ...options, deleter })

    expect(result).toEqual({ deleted: 4, notFound: 0, failed: 0, deferred: 0 })
  })

  it("keeps a claimed deletion's whole budget when the run deadline passes", async () => {
    await retire(1)
    // The deletion budget is the behavior under test: the run deadline expires
    // long before the deletion finishes, well inside its own budget.
    const deleter = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 300))

    const result = await runGc([], { ...options, runTimeoutMs: 20, deletionTimeoutMs: 5_000, deleter })

    expect(result).toEqual({ deleted: 1, notFound: 0, failed: 0, deferred: 0 })
  })

  it("claims nothing new once the run deadline has passed", async () => {
    await retire(20)
    const result = await runGc([], {
      ...options,
      maxDeletesPerRun: 20,
      runTimeoutMs: 20,
      deleter: (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 100)),
    })

    // One batch was claimed before the deadline; the rest wait for the next sweep.
    expect(result.deleted).toBe(8)
    expect(result.deferred).toBe(12)
  })

  it("claims nothing new once asked to stop, finishing the batch it already claimed", async () => {
    await retire(20)
    let stopping = false
    const result = await runGc([], {
      ...options,
      maxDeletesPerRun: 20,
      shouldStop: () => stopping,
      deleter: async () => { stopping = true },
    })

    expect(result.deleted).toBe(8)
    expect(result.deferred).toBe(12)
  })

  it("reports a saturated backlog when superseded transcripts wait for a full pending budget", async () => {
    for (let index = 0; index < 5; index++) await registerLiveTranscript(locator(`live-${index}`), options)
    const backlogs: GcBacklog[] = []

    await runGc([], {
      ...options,
      maxPending: 3,
      retiredGraceMs: 60_000,
      deleter: async () => undefined,
      onBacklog: (backlog) => { backlogs.push(backlog) },
    })

    expect(backlogs).toEqual([{
      pending: 2,
      maxPending: 3,
      awaitingRetirement: 3,
      dueForDeletion: 0,
      saturated: true,
    }])
  })

  it("reports retired transcripts still due after a run that hit its claim limit", async () => {
    await retire(3)
    const backlogs: GcBacklog[] = []

    const result = await runGc([], {
      ...options,
      maxDeletesPerRun: 1,
      deleter: async () => undefined,
      onBacklog: (backlog) => { backlogs.push(backlog) },
    })

    expect(result.deleted).toBe(1)
    expect(backlogs).toEqual([{
      pending: 2,
      maxPending: 256,
      awaitingRetirement: 0,
      dueForDeletion: 2,
      saturated: false,
    }])
  })
})
