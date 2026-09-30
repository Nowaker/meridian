/**
 * Upstream-idle guard for proxied model streams.
 *
 * Wraps the provider SDK's streaming async iterable and enforces a maximum gap
 * between *real* upstream messages. If the source goes silent for longer than
 * `idleMs` — before the first chunk (slow TTFB) or mid-stream — the guard
 * aborts iteration and throws `UpstreamIdleError`. SDK `stream_event/ping`
 * messages are discarded: they prove transport liveness, not model progress.
 *
 * Why this is needed: the proxy emits downstream SSE heartbeats (`: ping`) on a
 * fixed interval, which resets the *client's* (pi's) byte-level idle timer. A
 * stalled upstream is therefore invisible to the client and would wedge the
 * turn forever. This guard is the authoritative upstream-liveness check.
 *
 * COORDINATION CONTRACT (Pylon Orchestrator): this guard owns *model-stream*
 * liveness. Pylon's runtime stall watchdog is only a BACKSTOP for the
 * model-wait gap with no tool in flight, and keeps its abort threshold above
 * this guard's idle limit so the two layers never race to abort the same hung
 * model. The limit is `MERIDIAN_UPSTREAM_IDLE_MS` (default 90s, set in
 * server.ts); Pylon warns at 120s and aborts at 180s. Any override must stay
 * BELOW Pylon's STALL_ABORT_MS; raising it past 180s requires changing Pylon
 * first.
 * Note `MERIDIAN_IDLE_TIMEOUT_SECONDS` is a different knob — the HTTP
 * keep-alive timeout — and has no bearing on this contract. See
 * pylon-orchestrator/docs/circuit/specs/stall-watchdog-tool-exempt.md.
 */
export class UpstreamIdleError extends Error {
  readonly idleMs: number
  readonly sinceLastMs: number
  constructor(idleMs: number, sinceLastMs: number) {
    super(`upstream idle for ${sinceLastMs}ms (limit ${idleMs}ms)`)
    this.name = "UpstreamIdleError"
    this.idleMs = idleMs
    this.sinceLastMs = sinceLastMs
  }
}

/** Opaque handle returned by a clock's timer scheduler. */
type IdleTimerHandle = ReturnType<typeof setTimeout> | number

/**
 * Time source the guard depends on. Injectable so tests can drive idle
 * detection deterministically instead of racing the real wall clock. Defaults
 * to the platform clock in production.
 */
export interface IdleGuardClock {
  now(): number
  setTimeout(fn: () => void, ms: number): IdleTimerHandle
  clearTimeout(handle: IdleTimerHandle): void
}

const realClock: IdleGuardClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
}

function isSdkStreamPing(value: unknown): boolean {
  return typeof value === "object" && value !== null
    && "type" in value && value.type === "stream_event"
    && "event" in value && typeof value.event === "object" && value.event !== null
    && "type" in value.event && value.event.type === "ping"
}

/**
 * How far past its deadline the idle timer may fire before the guard treats
 * the lateness as a blocked event loop rather than ordinary timer jitter.
 *
 * A timer can only fire late if this process stopped running callbacks: a
 * synchronous fsync or a long CPU burst on the main thread. While the loop is
 * blocked the upstream keeps sending, and its bytes wait in the socket or
 * pipe. When the loop resumes, expired timers run before the I/O poll that
 * would deliver those bytes, so without this check a live stream is rejected
 * as silent. On a responsive but loaded host timers fire within a few hundred
 * milliseconds of their deadline, so 2 s never catches an on-time firing,
 * while a freeze long enough to matter is well past it. The only cost of
 * crossing it is one turn of the event loop.
 */
export const IDLE_DEADLINE_LATE_MS = 2_000

/** Reported when the idle timer fired more than IDLE_DEADLINE_LATE_MS late. */
export interface LateIdleDeadline {
  /** How long after its deadline the timer actually ran. */
  lateMs: number
  /** Time since the last upstream message, measured when the timer ran. */
  sinceLastMs: number
  /** True if upstream data turned up after yielding to I/O, so the stream continues. */
  resumed: boolean
}

const IDLE = Symbol("idle")

// Two chained immediates guarantee one I/O poll in between on both runtimes.
// Node polls before the first one runs, but Bun runs an immediate queued from
// a timer callback before it polls, so a single one is not enough there.
function yieldToIo(): Promise<void> {
  return new Promise((resolve) => setImmediate(() => setImmediate(resolve)))
}

export async function* guardUpstreamIdle<T>(
  source: AsyncIterable<T>,
  idleMs: number,
  onStall?: (sinceLastMs: number) => void,
  clock: IdleGuardClock = realClock,
  onLateDeadline?: (late: LateIdleDeadline) => void,
): AsyncGenerator<T> {
  if (idleMs <= 0) {
    yield* source
    return
  }
  const it = source[Symbol.asyncIterator]()
  let lastAt = clock.now()
  try {
    while (true) {
      // Start the next pull and swallow any late rejection if we abandon it
      // via the idle deadline (prevents an unhandled-rejection on teardown).
      const nextP = it.next()
      nextP.catch(() => {})

      let timer: IdleTimerHandle | undefined
      let deadlineAt = 0
      const idle = new Promise<typeof IDLE>((resolve) => {
        const remaining = Math.max(0, idleMs - (clock.now() - lastAt))
        deadlineAt = clock.now() + remaining
        timer = clock.setTimeout(() => resolve(IDLE), remaining)
      })

      let res: IteratorResult<T> | typeof IDLE
      try {
        res = await Promise.race([nextP, idle])
      } finally {
        if (timer !== undefined) clock.clearTimeout(timer)
      }
      if (res === IDLE) {
        const sinceLastMs = clock.now() - lastAt
        const lateMs = clock.now() - deadlineAt
        if (lateMs > IDLE_DEADLINE_LATE_MS) {
          // The loop was blocked, so upstream data may be waiting behind this
          // timer. Poll I/O once, then check the stream again.
          await yieldToIo()
          res = await Promise.race([nextP, Promise.resolve(IDLE)])
          try {
            onLateDeadline?.({ lateMs, sinceLastMs, resumed: res !== IDLE })
          } catch {
            // Observer errors must not change the guard's verdict.
          }
        }
        if (res === IDLE) {
          try {
            onStall?.(sinceLastMs)
          } catch {
            // Observer errors must not prevent rejecting the guarded iterator.
          }
          throw new UpstreamIdleError(idleMs, sinceLastMs)
        }
      }
      if (res.done) return
      if (isSdkStreamPing(res.value)) continue
      lastAt = clock.now()
      yield res.value
    }
  } finally {
    // Runs on normal completion, stall throw, AND consumer break — ask the
    // upstream iterator to tear down without hanging on a stalled pull.
    const returnP = it.return?.(undefined as never)
    returnP?.catch(() => {})
  }
}
