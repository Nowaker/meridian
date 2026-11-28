import { afterEach, expect, it } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, watch, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const roots: string[] = []
const children: ReturnType<typeof Bun.spawn>[] = []
const worker = join(import.meta.dir, "fixtures/chatgpt-lease-process.ts")

function spawn(mode: string, root: string, name: string) {
  const child = Bun.spawn([process.execPath, worker, mode, root, name], { stdout: "ignore", stderr: "inherit" })
  children.push(child)
  return child
}

/**
 * The file `worker` publishes (the fixture renames it into place), once it
 * appears: on the directory's own change event, never on a timer, and failing
 * at once if the worker exits without it. The test's timeout is the only
 * bound, since a worker can take tens of seconds just to start on a loaded host.
 */
async function waitFile(root: string, file: string, worker: ReturnType<typeof Bun.spawn>): Promise<string> {
  const path = join(root, file)
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const watcher = watch(root)
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      watcher.close()
      if (error) reject(error)
      else resolve()
    }
    const check = () => { if (existsSync(path)) finish() }
    watcher.on("change", check)
    watcher.on("error", error => finish(error))
    void worker.exited.then(code => {
      if (!existsSync(path)) finish(new Error(`Worker exited ${code} without publishing ${file}`))
      else finish()
    })
    check()
  })
  return readFileSync(path, "utf8")
}

async function deadOwner(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "chatgpt-recovery-"))
  roots.push(root)
  expect(await spawn("dead", root, "dead").exited).toBe(0)
  utimesSync(join(root, "writer.lock"), new Date(0), new Date(0))
  return root
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill("SIGKILL")
    await child.exited
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it("excludes a second reclaimer while the first pauses before canonical retirement", async () => {
  const root = await deadOwner()
  const first = spawn("pause-writer", root, "first")
  await waitFile(root, "first.paused", first)
  const second = spawn("attempt", root, "second")
  expect(await waitFile(root, "second.result", second)).toBe("denied")
  expect(await second.exited).toBe(0)
  writeFileSync(join(root, "first.resume"), "resume")
  expect(await waitFile(root, "first.result", first)).toBe("admitted")
  expect(first.exitCode).toBeNull()
}, 180_000)

it("cannot retire a live successor when two processes recover a crashed claimant", async () => {
  const root = await deadOwner()
  expect(await spawn("crash-claim", root, "crashed").exited).toBe(0)
  const first = spawn("pause-claim", root, "first")
  await waitFile(root, "first.paused", first)
  const winner = spawn("attempt", root, "winner")
  expect(await waitFile(root, "winner.result", winner)).toBe("admitted")
  writeFileSync(join(root, "first.resume"), "resume")
  expect(await waitFile(root, "first.result", first)).toBe("denied")
  expect(winner.exitCode).toBeNull()
  writeFileSync(join(root, "winner.validate"), "validate")
  expect(await waitFile(root, "winner.validated", winner)).toBe("still-valid")
  const third = spawn("attempt", root, "third")
  expect(await waitFile(root, "third.result", third)).toBe("denied")
}, 180_000)

it("recovers after killing a paused reclaimer and can reacquire after release", async () => {
  const root = await deadOwner()
  const first = spawn("pause-writer", root, "first")
  await waitFile(root, "first.paused", first)
  first.kill("SIGKILL")
  await first.exited
  const second = spawn("attempt", root, "second")
  expect(await waitFile(root, "second.result", second)).toBe("admitted")
  writeFileSync(join(root, "second.release"), "release")
  expect(await second.exited).toBe(0)
  const third = spawn("attempt", root, "third")
  expect(await waitFile(root, "third.result", third)).toBe("admitted")
}, 180_000)

it.skipIf(process.platform !== "linux")("never steals from a SIGSTOPed admitted writer with an expired heartbeat", async () => {
  const root = await deadOwner()
  const writer = spawn("attempt", root, "writer")
  expect(await waitFile(root, "writer.result", writer)).toBe("admitted")
  process.kill(writer.pid, "SIGSTOP")
  utimesSync(join(root, "writer.lock"), new Date(0), new Date(0))
  const contender = spawn("attempt", root, "contender")
  expect(await waitFile(root, "contender.result", contender)).toBe("denied")
  process.kill(writer.pid, "SIGCONT")
  writeFileSync(join(root, "writer.validate"), "validate")
  expect(await waitFile(root, "writer.validated", writer)).toBe("still-valid")
}, 180_000)
