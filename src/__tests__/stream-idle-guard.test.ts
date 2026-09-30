import { describe, expect, it } from "bun:test"
import net from "node:net"
import { createInterface } from "node:readline"

const { guardUpstreamIdle, UpstreamIdleError, IDLE_DEADLINE_LATE_MS } = await import("../proxy/streamIdleGuard")
import type { IdleGuardClock, LateIdleDeadline } from "../proxy/streamIdleGuard"

type IdleTimerHandle = ReturnType<typeof setTimeout> | number

// A fully controllable clock for the guard: timers never fire on their own, so
// real upstream chunks always win their race against the idle deadline. The
// test fires the idle timer explicitly via advance(), making stall detection
// deterministic instead of racing the wall clock.
function makeFakeClock() {
  let current = 0
  let nextId = 1
  let scheduledTotal = 0
  const pending = new Map<IdleTimerHandle, { fireAt: number; fn: () => void }>()
  const waiters: Array<{ n: number; resolve: () => void }> = []

  const clock: IdleGuardClock = {
    now: () => current,
    setTimeout(fn, ms) {
      const id = nextId++
      pending.set(id, { fireAt: current + ms, fn })
      scheduledTotal++
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (scheduledTotal >= waiters[i]!.n) { waiters[i]!.resolve(); waiters.splice(i, 1) }
      }
      return id
    },
    clearTimeout(handle) { pending.delete(handle) },
  }

  return {
    clock,
    /** Resolves once at least `n` timers have been scheduled in total. */
    waitForScheduled(n: number): Promise<void> {
      if (scheduledTotal >= n) return Promise.resolve()
      return new Promise<void>((resolve) => { waiters.push({ n, resolve }) })
    },
    /** Advance time by `ms`, firing every timer whose deadline has passed. */
    advance(ms: number) {
      current += ms
      for (const [id, t] of [...pending]) {
        if (t.fireAt <= current) { pending.delete(id); t.fn() }
      }
    },
  }
}

// A controllable async iterable: push() emits a value, stall() just waits.
function makeSource<T>() {
  const queue: T[] = []
  let resolveNext: (() => void) | null = null
  let done = false
  const wake = () => { if (resolveNext) { const r = resolveNext; resolveNext = null; r() } }
  return {
    push(v: T) { queue.push(v); wake() },
    finish() { done = true; wake() },
    iterable: {
      async *[Symbol.asyncIterator]() {
        while (true) {
          if (queue.length) { yield queue.shift() as T; continue }
          if (done) return
          await new Promise<void>((r) => { resolveNext = r })
        }
      },
    } as AsyncIterable<T>,
  }
}

describe("guardUpstreamIdle", () => {
  it("passes through messages while the source is active", async () => {
    const src = makeSource<number>()
    const out: number[] = []
    const p = (async () => { for await (const v of guardUpstreamIdle(src.iterable, 500)) out.push(v) })()
    src.push(1); await new Promise((r) => setTimeout(r, 5))
    src.push(2); await new Promise((r) => setTimeout(r, 5))
    src.finish()
    await p
    expect(out).toEqual([1, 2])
  })

  it("throws UpstreamIdleError when the source goes silent even if onStall throws", async () => {
    const src = makeSource<number>()
    const stalls: number[] = []
    const clock = makeFakeClock()
    const p = (async () => { for await (const _ of guardUpstreamIdle(src.iterable, 30, (ms) => { stalls.push(ms); throw new Error("observer failed") }, clock.clock)) { /* drain */ } })()
    src.push(1) // one real chunk, then silence
    // Chunk 1 is delivered (its idle timer is cleared) and a fresh idle timer
    // is armed for the silent gap — the second scheduled timer. Fire it.
    await clock.waitForScheduled(2)
    clock.advance(30)
    let err: unknown
    try { await p } catch (e) { err = e }
    expect(err).toBeInstanceOf(UpstreamIdleError)
    expect(stalls.length).toBe(1)
    expect((err as InstanceType<typeof UpstreamIdleError>).sinceLastMs).toBeGreaterThanOrEqual(30)
  })

  it("trips even before the first chunk (slow TTFB)", async () => {
    const src = makeSource<number>() // never push
    let err: unknown
    try { for await (const _ of guardUpstreamIdle(src.iterable, 20)) { /* none */ } } catch (e) { err = e }
    expect(err).toBeInstanceOf(UpstreamIdleError)
  })

  it("calls return on the source iterator after an idle stall", async () => {
    let returned = false
    const source: AsyncIterable<number> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<number>>(() => {}),
          return: () => {
            returned = true
            return Promise.resolve({ done: true, value: undefined })
          },
        }
      },
    }

    let err: unknown
    try { for await (const _ of guardUpstreamIdle(source, 20)) { /* none */ } } catch (e) { err = e }
    expect(err).toBeInstanceOf(UpstreamIdleError)
    expect(returned).toBe(true)
  })

  it("does not let SDK stream pings extend the idle deadline", async () => {
    const src = makeSource<{ type: string; event?: { type: string } }>()
    const clock = makeFakeClock()
    const stalls: number[] = []
    const output: unknown[] = []
    let error: unknown
    const pending = (async () => {
      for await (const message of guardUpstreamIdle(src.iterable, 90, ms => stalls.push(ms), clock.clock)) output.push(message)
    })().catch(caught => { error = caught })
    try {
      await clock.waitForScheduled(1)
      for (let i = 0; i < 2; i++) {
        clock.advance(30)
        src.push({ type: "stream_event", event: { type: "ping" } })
        await clock.waitForScheduled(i + 2)
      }
      clock.advance(30)
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(error).toBeInstanceOf(UpstreamIdleError)
      expect(stalls).toEqual([90])
      expect(output).toEqual([])
    } finally {
      src.finish()
      await pending
    }
  })

  it("resets the deadline for model progress between pings", async () => {
    const src = makeSource<{ type: string; event: { type: string } }>()
    const clock = makeFakeClock()
    const content = { type: "stream_event", event: { type: "content_block_delta" } }
    const output: unknown[] = []
    let error: unknown
    const pending = (async () => {
      for await (const message of guardUpstreamIdle(src.iterable, 90, undefined, clock.clock)) output.push(message)
    })().catch(caught => { error = caught })
    try {
      await clock.waitForScheduled(1)
      clock.advance(60)
      src.push(content)
      await clock.waitForScheduled(2)
      clock.advance(60)
      src.push({ type: "stream_event", event: { type: "ping" } })
      await clock.waitForScheduled(3)
      expect(error).toBeUndefined()
      clock.advance(30)
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(error).toBeInstanceOf(UpstreamIdleError)
      expect(output).toEqual([content])
    } finally {
      src.finish()
      await pending
    }
  })

  it("passes nested pings through when disabled and preserves other event shapes", async () => {
    const ping = { type: "stream_event", event: { type: "ping" } }
    const ordinary = [null, { type: "ping" }, { type: "keep_alive" },
      { type: "stream_event", event: null }, { type: "stream_event", event: { type: "message_start" } }]
    async function* source(values: unknown[]) { yield* values }
    const disabled: unknown[] = []
    for await (const event of guardUpstreamIdle(source([ping, ...ordinary]), 0)) disabled.push(event)
    expect(disabled).toEqual([ping, ...ordinary])
    const enabled: unknown[] = []
    for await (const event of guardUpstreamIdle(source([ping, ...ordinary]), 500)) enabled.push(event)
    expect(enabled).toEqual(ordinary)
  })

  // A blocked event loop (a synchronous fsync, say) makes the idle timer fire
  // late. The upstream kept sending meanwhile, but when the loop resumes the
  // expired timer runs before the I/O poll that delivers the waiting bytes.
  // setImmediate(push) models those bytes: they are delivered on the next
  // event-loop turn, after the timer callback.
  function runGuarded(idleMs: number, clock: ReturnType<typeof makeFakeClock>, src: ReturnType<typeof makeSource<number>>) {
    const out: number[] = []
    const stalls: number[] = []
    const lates: LateIdleDeadline[] = []
    const done = (async () => {
      for await (const v of guardUpstreamIdle(src.iterable, idleMs, (ms) => stalls.push(ms), clock.clock, (late) => lates.push(late))) out.push(v)
    })()
    return { out, stalls, lates, done }
  }

  it("a late deadline with upstream data waiting behind it does not stall", async () => {
    const src = makeSource<number>()
    const clock = makeFakeClock()
    const run = runGuarded(90_000, clock, src)
    await clock.waitForScheduled(1)
    setImmediate(() => src.push(1))
    clock.advance(105_131)
    // Chunk 1 reached the consumer and a fresh deadline was armed for the next.
    await clock.waitForScheduled(2)
    src.finish()
    await run.done
    expect(run.out).toEqual([1])
    expect(run.stalls).toEqual([])
    expect(run.lates).toEqual([{ lateMs: 15_131, sinceLastMs: 105_131, resumed: true }])
  })

  it("a late deadline on a silent stream still stalls", async () => {
    const src = makeSource<number>()
    const clock = makeFakeClock()
    const run = runGuarded(90_000, clock, src)
    await clock.waitForScheduled(1)
    clock.advance(105_131)
    let err: unknown
    try { await run.done } catch (e) { err = e }
    expect(err).toBeInstanceOf(UpstreamIdleError)
    expect((err as InstanceType<typeof UpstreamIdleError>).sinceLastMs).toBe(105_131)
    expect(run.stalls).toEqual([105_131])
    expect(run.lates).toEqual([{ lateMs: 15_131, sinceLastMs: 105_131, resumed: false }])
  })

  it("an on-time deadline stalls at once, without yielding for queued data", async () => {
    const src = makeSource<number>()
    const clock = makeFakeClock()
    const run = runGuarded(90_000, clock, src)
    await clock.waitForScheduled(1)
    setImmediate(() => src.push(1))
    clock.advance(90_000 + IDLE_DEADLINE_LATE_MS)
    let err: unknown
    try { await run.done } catch (e) { err = e }
    expect(err).toBeInstanceOf(UpstreamIdleError)
    expect((err as InstanceType<typeof UpstreamIdleError>).sinceLastMs).toBe(90_000 + IDLE_DEADLINE_LATE_MS)
    expect(run.out).toEqual([])
    expect(run.stalls).toEqual([90_000 + IDLE_DEADLINE_LATE_MS])
    expect(run.lates).toEqual([])
  })

  it("a live socket stream survives the loop blocking inside another connection's handler", async () => {
    const streamer = net.createServer((s) => {
      let i = 0
      const t = setInterval(() => s.write(`${i++}\n`), 50)
      s.on("close", () => clearInterval(t))
      s.on("error", () => {})
    })
    const blockMs = IDLE_DEADLINE_LATE_MS + 500
    const blocker = net.createServer((s) => {
      s.on("data", () => {
        const end = Date.now() + blockMs
        while (Date.now() < end) { /* a synchronous fsync holding the loop */ }
        s.end()
      })
    })
    await new Promise<void>((r) => streamer.listen(0, "127.0.0.1", r))
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r))
    const port = (s: net.Server) => (s.address() as net.AddressInfo).port
    const sock = net.connect(port(streamer), "127.0.0.1")
    const lines = async function* () { for await (const l of createInterface({ input: sock })) yield l }

    let got = 0
    const lates: LateIdleDeadline[] = []
    try {
      for await (const _ of guardUpstreamIdle(lines(), 200, undefined, undefined, (late) => lates.push(late))) {
        if (++got === 3) net.connect(port(blocker), "127.0.0.1").end("go")
        if (got === 10) break
      }
    } finally {
      sock.destroy()
      streamer.close()
      blocker.close()
    }
    expect(got).toBe(10)
    expect(lates).toHaveLength(1)
    expect(lates[0]!.resumed).toBe(true)
    expect(lates[0]!.lateMs).toBeGreaterThan(IDLE_DEADLINE_LATE_MS)
  }, 15_000)

  it("idleMs<=0 disables the guard (pure pass-through)", async () => {
    const src = makeSource<number>()
    const out: number[] = []
    const p = (async () => { for await (const v of guardUpstreamIdle(src.iterable, 0)) out.push(v) })()
    src.push(7); src.finish()
    await p
    expect(out).toEqual([7])
  })
})
