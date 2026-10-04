/**
 * Per-process scratch directories the test preload creates, and their cleanup.
 *
 * Every `bun test` process gets its own settings and session directory under
 * the system temp dir, keyed by pid. `npm test` starts a series of such
 * processes, so without cleanup each run leaves a pair of directories per
 * invocation behind, indefinitely.
 *
 * The owning process removes its own pair when its run finishes, which covers
 * passing, failing and timed-out runs alike. A process killed by a signal never gets to
 * do that, so each new process also sweeps leftovers whose pid is no longer
 * running. A directory whose pid is alive is never touched: it may belong to a
 * concurrent run.
 */

import { readdirSync, rmSync } from "node:fs"
import { join } from "node:path"

const TEST_DIR_PATTERN = /^meridian-test-(?:settings|sessions)-(\d+)$/

export function testDirsFor(root: string, pid: number) {
  return {
    configDir: join(root, `meridian-test-settings-${pid}`),
    sessionDir: join(root, `meridian-test-sessions-${pid}`),
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the pid exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** Remove a scratch directory. Best effort: a failure here must not change the
 *  test run's outcome, and the next run's sweep retries it. */
export function removeTestDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // Left for the next run's sweepStaleTestDirs.
  }
}

/** Delete preload scratch directories under `root` whose owning pid is gone.
 *  Returns the directories removed. */
export function sweepStaleTestDirs(root: string, alive: (pid: number) => boolean = isProcessAlive): string[] {
  let names: string[]
  try {
    names = readdirSync(root)
  } catch {
    return []
  }
  const removed: string[] = []
  for (const name of names) {
    const match = TEST_DIR_PATTERN.exec(name)
    if (!match) continue
    const pid = Number(match[1])
    if (pid === process.pid || alive(pid)) continue
    const dir = join(root, name)
    removeTestDir(dir)
    removed.push(dir)
  }
  return removed
}
