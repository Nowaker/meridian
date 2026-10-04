/**
 * Auth-status caching and resilience — against the REAL implementation (#707).
 *
 * This file previously declared its own `authCache`, `lastKnownGood`, TTLs and
 * caching logic and asserted against that copy. It never imported
 * `../proxy/models`, so all 8 tests would have passed with
 * `getClaudeAuthStatusAsync` deleted — no coverage at all of the resilience
 * behaviour it claimed to test.
 *
 * The original objection to mocking was real and is quoted in the old file:
 * bun's `mock.module` is global and leaks across files. It no longer applies —
 * `package.json` excludes this file from the main `bun test` run and executes
 * it as its own invocation, so a module mock here cannot reach other files.
 *
 * Two things make the real implementation testable deterministically:
 *   - `MERIDIAN_CLAUDE_PATH` short-circuits executable resolution, so no real
 *     binary is probed.
 *   - `profileAuthCaches` is keyed by profile id, so a unique profile per test
 *     gives isolation without any shared-singleton race — which is what drove
 *     the reimplementation in the first place.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, mock, setSystemTime, spyOn } from "bun:test"
import * as realChildProcess from "node:child_process"
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * Controls what the mocked `claude auth status` does on the next call.
 * "hang" models a spawn stalled on a loaded host: the callback is parked in
 * `hungSpawns` until the test settles it with `releaseHungSpawns`.
 */
let authBehavior: "success" | "fail" | "hang" | "timeout" | "exit1" | "exit2" = "success"
let execFileCalls = 0
/** Options the probe passed to execFile, so spawn flags can be asserted. */
let execFileOptions: any
let currentPayload = { loggedIn: true, email: "test@test.com", subscriptionType: "max" }
let hungSpawns: Array<(err: Error | null, out: { stdout: string; stderr: string }) => void> = []

function releaseHungSpawns(): void {
  const pending = hungSpawns
  hungSpawns = []
  for (const done of pending) done(null, { stdout: JSON.stringify(currentPayload), stderr: "" })
}

/** What execFile rejects with when it kills the child at its timeout. */
const timeoutError = () =>
  Object.assign(new Error("Command failed: /fake/claude auth status\n"), { killed: true, signal: "SIGTERM", code: null })

function killHungSpawns(): void {
  const pending = hungSpawns
  hungSpawns = []
  for (const done of pending) done(timeoutError(), { stdout: "", stderr: "" })
}

// The /health test loads server.ts, which imports more of child_process than
// the auth probe uses; only exec and execFile are replaced.
mock.module("child_process", () => ({
  ...realChildProcess,
  exec: (_cmd: string, optsOrCb: any, cb?: any) => {
    const done = typeof optsOrCb === "function" ? optsOrCb : cb
    done?.(null, { stdout: "", stderr: "" })
  },
  execFile: (_file: string, _args: any, optsOrCb: any, cb?: any) => {
    execFileCalls++
    execFileOptions = typeof optsOrCb === "function" ? undefined : optsOrCb
    const done = typeof optsOrCb === "function" ? optsOrCb : cb
    if (authBehavior === "hang") {
      hungSpawns.push(done)
      return
    }
    if (authBehavior === "fail") {
      done?.(new Error("claude auth status failed"), { stdout: "", stderr: "" })
      return
    }
    if (authBehavior === "timeout") {
      done?.(timeoutError(), { stdout: "", stderr: "" })
      return
    }
    // A non-zero exit still carries the CLI's stdout: its JSON, account email
    // included (exit1), or output that is not JSON at all (exit2).
    if (authBehavior === "exit1") {
      const stdout = JSON.stringify({ loggedIn: false, email: "private@test.com" })
      done?.(Object.assign(new Error("Command failed: /fake/claude auth status\n"), { killed: false, signal: null, code: 1, stdout }), { stdout, stderr: "" })
      return
    }
    if (authBehavior === "exit2") {
      const stdout = "not json"
      done?.(Object.assign(new Error("Command failed: /fake/claude auth status\n"), { killed: false, signal: null, code: 2, stdout }), { stdout, stderr: "" })
      return
    }
    done?.(null, { stdout: JSON.stringify(currentPayload), stderr: "" })
  },
}))

const savedClaudePath = process.env.MERIDIAN_CLAUDE_PATH
process.env.MERIDIAN_CLAUDE_PATH = "/fake/claude"

const {
  getClaudeAuthStatusAsync,
  getAuthCacheInfo,
  resetCachedClaudeAuthStatus,
  expireAuthStatusCache,
  pendingAuthStatusRefresh,
  authStatusFailureTtlMs,
  setAuthStatusWaitMsForTesting,
} = await import("../proxy/models")

/** Failed checks warn; kept off the test output and asserted where it matters. */
const warnSpy = spyOn(console, "warn").mockImplementation(() => {})
const warnings = () => warnSpy.mock.calls.map(call => String(call[0]))

beforeEach(() => warnSpy.mockClear())

afterAll(() => {
  warnSpy.mockRestore()
  if (savedClaudePath === undefined) delete process.env.MERIDIAN_CLAUDE_PATH
  else process.env.MERIDIAN_CLAUDE_PATH = savedClaudePath
})

const NOT_SETTLED = Symbol("not settled")

function settledWithin<T>(promise: Promise<T>, ms: number): Promise<T | typeof NOT_SETTLED> {
  return Promise.race([promise, new Promise<typeof NOT_SETTLED>((r) => setTimeout(() => r(NOT_SETTLED), ms))])
}

/** Let the refresh reach execFile: it first awaits executable resolution. */
const tick = () => new Promise((r) => setTimeout(r, 10))

/** Unique profile per test — the isolation that replaces the local copy. */
let profileSeq = 0
const nextProfile = () => `auth-test-${++profileSeq}`

describe("getClaudeAuthStatusAsync — real implementation", () => {
  beforeEach(() => {
    authBehavior = "success"
    execFileCalls = 0
    execFileOptions = undefined
    hungSpawns = []
    currentPayload = { loggedIn: true, email: "test@test.com", subscriptionType: "max" }
    resetCachedClaudeAuthStatus()
  })

  afterEach(() => {
    releaseHungSpawns()
    setSystemTime()
    setAuthStatusWaitMsForTesting()
  })

  // Windows allocates a visible console for a child launched without this flag,
  // and the probe re-runs on cache expiry, so a service with no console of its
  // own flashed a window on most prompts (#1172). The flag is a no-op elsewhere,
  // so this guards the fix from every platform CI runs on.
  it("hides the console window when probing auth status", async () => {
    await getClaudeAuthStatusAsync(nextProfile())
    expect(execFileCalls).toBe(1)
    expect(execFileOptions?.windowsHide).toBe(true)
  })

  it("fetches and returns auth status on a cold cache", async () => {
    const status = await getClaudeAuthStatusAsync(nextProfile())
    expect(status).toEqual(currentPayload)
    expect(execFileCalls).toBe(1)
  })

  it("serves from cache within the TTL instead of re-running the CLI", async () => {
    const p = nextProfile()
    await getClaudeAuthStatusAsync(p)
    expect(await getClaudeAuthStatusAsync(p)).toEqual(currentPayload)
    // The point of the cache: one subprocess, not two.
    expect(execFileCalls).toBe(1)
  })

  it("re-fetches once the TTL has expired", async () => {
    const p = nextProfile()
    await getClaudeAuthStatusAsync(p)
    expireAuthStatusCache()
    await getClaudeAuthStatusAsync(p)
    await pendingAuthStatusRefresh(p)
    expect(execFileCalls).toBe(2)
  })

  it("picks up a changed payload after expiry, one call later", async () => {
    const p = nextProfile()
    const previous = await getClaudeAuthStatusAsync(p)
    currentPayload = { loggedIn: true, email: "new@test.com", subscriptionType: "team" }
    expireAuthStatusCache()
    // The caller that finds the cache expired is answered from it...
    expect(await getClaudeAuthStatusAsync(p)).toEqual(previous!)
    await pendingAuthStatusRefresh(p)
    // ...and the refresh it started answers the next one.
    expect(await getClaudeAuthStatusAsync(p)).toEqual(currentPayload)
  })

  it("does not wait on the auth-status spawn once the cache has expired", async () => {
    // The /health freeze: a load balancer probing with a 2 s timeout marked the
    // proxy down whenever the expired cache made the probe wait on a spawn
    // that a loaded host stretched past it.
    const p = nextProfile()
    const previous = await getClaudeAuthStatusAsync(p)
    expireAuthStatusCache()
    authBehavior = "hang"

    expect(await settledWithin(getClaudeAuthStatusAsync(p), 200)).toEqual(previous!)
    await tick()
    expect(hungSpawns).toHaveLength(1)

    currentPayload = { loggedIn: true, email: "later@test.com", subscriptionType: "max" }
    releaseHungSpawns()
    await pendingAuthStatusRefresh(p)
    expect(await getClaudeAuthStatusAsync(p)).toEqual(currentPayload)
  })

  it("starts a single background refresh for concurrent callers after expiry", async () => {
    const p = nextProfile()
    const previous = await getClaudeAuthStatusAsync(p)
    expireAuthStatusCache()
    authBehavior = "hang"

    const results = await settledWithin(
      Promise.all(Array.from({ length: 5 }, () => getClaudeAuthStatusAsync(p))),
      200,
    )
    expect(results).toEqual(Array.from({ length: 5 }, () => previous!))
    await tick()
    // One warm-up spawn plus exactly one refresh, still in flight.
    expect(execFileCalls).toBe(2)
    expect(await settledWithin(getClaudeAuthStatusAsync(p), 200)).toEqual(previous!)
    await tick()
    expect(execFileCalls).toBe(2)
  })

  it("still waits on a cold start with nothing to fall back on", async () => {
    const p = nextProfile()
    authBehavior = "hang"
    const first = getClaudeAuthStatusAsync(p)
    expect(await settledWithin(first, 100)).toBe(NOT_SETTLED)
    releaseHungSpawns()
    expect(await first).toEqual(currentPayload)
  })

  it("lets the CLI run far longer than any caller waits for it", async () => {
    await getClaudeAuthStatusAsync(nextProfile())
    expect(execFileOptions?.timeout).toBe(90_000)
  })

  it("stops waiting on a slow first check without killing it, then serves its answer", async () => {
    // A cold CLI on a loaded host was measured taking 15-40 s. Killed at the
    // caller's 5 s, no check ever finished and the proxy stayed unverified.
    setAuthStatusWaitMsForTesting(50)
    const p = nextProfile()
    authBehavior = "hang"

    expect(await settledWithin(getClaudeAuthStatusAsync(p), 1_000)).toBeNull()
    expect(await settledWithin(getClaudeAuthStatusAsync(p), 1_000)).toBeNull()
    expect(hungSpawns).toHaveLength(1)
    // Still running, not failed: nothing to back off from.
    expect(getAuthCacheInfo(p)).toEqual({ lastCheckedAt: 0, lastSuccessAt: 0, isFailure: false })

    releaseHungSpawns()
    await pendingAuthStatusRefresh(p)
    expect(await getClaudeAuthStatusAsync(p)).toEqual(currentPayload)
    expect(execFileCalls).toBe(1)
  })

  it("falls back to last-known-good when the auth check fails", async () => {
    // The resilience property with no real coverage before: a transient CLI
    // failure must not blank the proxy's view of auth.
    const p = nextProfile()
    const good = await getClaudeAuthStatusAsync(p)
    expect(good).toEqual(currentPayload)

    authBehavior = "fail"
    expireAuthStatusCache()
    expect(await getClaudeAuthStatusAsync(p)).toEqual(currentPayload)
  })

  it("returns null when the first check fails and there is no last-known-good", async () => {
    authBehavior = "fail"
    expect(await getClaudeAuthStatusAsync(nextProfile())).toBeNull()
  })

  it("marks the cache as failed so /health can report it", async () => {
    const p = nextProfile()
    authBehavior = "fail"
    await getClaudeAuthStatusAsync(p)
    expect(getAuthCacheInfo(p).isFailure).toBe(true)
  })

  it("clears the failure flag once a later check succeeds", async () => {
    const p = nextProfile()
    authBehavior = "fail"
    await getClaudeAuthStatusAsync(p)
    expect(getAuthCacheInfo(p).isFailure).toBe(true)

    authBehavior = "success"
    expireAuthStatusCache()
    await getClaudeAuthStatusAsync(p)
    const info = getAuthCacheInfo(p)
    expect(info.isFailure).toBe(false)
    expect(info.lastSuccessAt).toBeGreaterThan(0)
  })

  it("records lastSuccessAt only on success", async () => {
    const p = nextProfile()
    authBehavior = "fail"
    await getClaudeAuthStatusAsync(p)
    expect(getAuthCacheInfo(p).lastSuccessAt).toBe(0)
  })

  it("doubles the retry delay per consecutive failure, capped at 5 minutes", () => {
    expect(authStatusFailureTtlMs(1)).toBe(5_000)
    expect(authStatusFailureTtlMs(2)).toBe(10_000)
    expect(authStatusFailureTtlMs(3)).toBe(20_000)
    expect(authStatusFailureTtlMs(6)).toBe(160_000)
    expect(authStatusFailureTtlMs(7)).toBe(300_000)
    expect(authStatusFailureTtlMs(1_000)).toBe(300_000)
  })

  it("backs off after repeated failures and resets on success", async () => {
    // A flat 5 s retry re-spawned `claude auth status` on every health probe
    // for as long as the check kept failing.
    const p = nextProfile()
    let now = Date.parse("2026-01-01T00:00:00Z")
    const advance = (ms: number) => { now += ms; setSystemTime(new Date(now)) }
    setSystemTime(new Date(now))

    authBehavior = "fail"
    await getClaudeAuthStatusAsync(p)
    expect(execFileCalls).toBe(1)

    advance(4_000)
    await getClaudeAuthStatusAsync(p)
    expect(execFileCalls).toBe(1)
    advance(1_500)
    await getClaudeAuthStatusAsync(p)
    expect(execFileCalls).toBe(2)

    // Second consecutive failure: 10 s, not 5 s.
    advance(6_000)
    await getClaudeAuthStatusAsync(p)
    expect(execFileCalls).toBe(2)
    advance(4_500)
    await getClaudeAuthStatusAsync(p)
    expect(execFileCalls).toBe(3)

    // Third: 20 s.
    advance(15_000)
    await getClaudeAuthStatusAsync(p)
    expect(execFileCalls).toBe(3)
    advance(5_500)
    authBehavior = "success"
    expect(await getClaudeAuthStatusAsync(p)).toEqual(currentPayload)
    expect(execFileCalls).toBe(4)

    // A success resets the count: the next failure is retried after 5 s again.
    advance(61_000)
    authBehavior = "fail"
    await getClaudeAuthStatusAsync(p)
    await pendingAuthStatusRefresh(p)
    expect(execFileCalls).toBe(5)
    expect(getAuthCacheInfo(p).isFailure).toBe(true)
    advance(5_500)
    await getClaudeAuthStatusAsync(p)
    await pendingAuthStatusRefresh(p)
    expect(execFileCalls).toBe(6)
  })

  it("de-duplicates concurrent cold-cache calls into one subprocess", async () => {
    // Without the in-flight promise, a burst of requests on a cold cache would
    // spawn one `claude auth status` each.
    const p = nextProfile()
    const results = await Promise.all([
      getClaudeAuthStatusAsync(p),
      getClaudeAuthStatusAsync(p),
      getClaudeAuthStatusAsync(p),
    ])
    for (const r of results) expect(r).toEqual(currentPayload)
    expect(execFileCalls).toBe(1)
  })

  it("keeps profiles isolated — one account's failure does not poison another", async () => {
    // The reason the cache is per-profile at all: two Claude accounts have
    // independent auth state.
    const good = nextProfile()
    const bad = nextProfile()
    await getClaudeAuthStatusAsync(good)

    authBehavior = "fail"
    await getClaudeAuthStatusAsync(bad)

    expect(getAuthCacheInfo(good).isFailure).toBe(false)
    expect(getAuthCacheInfo(bad).isFailure).toBe(true)
    // The healthy profile still serves from its own cache, no new subprocess.
    const callsBefore = execFileCalls
    expect(await getClaudeAuthStatusAsync(good)).toEqual(currentPayload)
    expect(execFileCalls).toBe(callsBefore)
  })

  it("reports zeroed cache info for a profile never checked", async () => {
    expect(getAuthCacheInfo("never-seen")).toEqual({
      lastCheckedAt: 0,
      lastSuccessAt: 0,
      isFailure: false,
    })
  })
})

/**
 * A failed check used to be visible only with OPENCODE_CLAUDE_PROVIDER_DEBUG
 * set, so a proxy stuck at "Could not verify auth status" said nothing about why.
 */
describe("auth-status warnings", () => {
  beforeEach(() => {
    authBehavior = "success"
    execFileCalls = 0
    hungSpawns = []
    currentPayload = { loggedIn: true, email: "test@test.com", subscriptionType: "max" }
    resetCachedClaudeAuthStatus()
  })

  afterEach(() => {
    releaseHungSpawns()
    setAuthStatusWaitMsForTesting()
    setSystemTime()
  })

  async function failAgain(p: string): Promise<void> {
    expireAuthStatusCache()
    await getClaudeAuthStatusAsync(p)
  }

  it("warns why a check failed, then only on the 2nd, 4th, 8th... repeat", async () => {
    const p = nextProfile()
    authBehavior = "fail"
    await getClaudeAuthStatusAsync(p)
    expect(warnings()).toHaveLength(1)
    expect(warnings()[0]).toContain(`Could not verify Claude auth status for profile "${p}": claude auth status failed`)
    expect(warnings()[0]).toContain("1 in a row; no status known yet; next check in 5s")

    await failAgain(p)
    expect(warnings()).toHaveLength(2)
    await failAgain(p)
    expect(warnings()).toHaveLength(2)
    await failAgain(p)
    expect(warnings()).toHaveLength(3)
    expect(warnings()[2]).toContain("4 in a row")

    authBehavior = "success"
    expireAuthStatusCache()
    await getClaudeAuthStatusAsync(p)
    expect(warnings()[3]).toContain(`Verified Claude auth status for profile "${p}" after 4 failed checks`)
  })

  it("warns again at once when the failure changes", async () => {
    const p = nextProfile()
    authBehavior = "fail"
    await getClaudeAuthStatusAsync(p)
    await failAgain(p)
    authBehavior = "timeout"
    await failAgain(p)
    expect(warnings()).toHaveLength(3)
    expect(warnings()[2]).toContain("no answer within 90s, so the check was killed")
  })

  it("counts timeouts as the same failure however long each run took", async () => {
    const p = nextProfile()
    let now = Date.parse("2026-01-01T00:00:00Z")
    setSystemTime(new Date(now))
    authBehavior = "hang"
    for (const runMs of [90_012, 90_377, 91_840]) {
      expireAuthStatusCache()
      void getClaudeAuthStatusAsync(p)
      await tick()
      now += runMs
      setSystemTime(new Date(now))
      killHungSpawns()
      await pendingAuthStatusRefresh(p)
    }
    expect(warnings()).toHaveLength(2)
  })

  it("says when the last known status is being served", async () => {
    const p = nextProfile()
    await getClaudeAuthStatusAsync(p)
    authBehavior = "timeout"
    await failAgain(p)
    expect(warnings()[0]).toContain("serving the last known status")
  })

  it("reports a non-zero exit with its loggedIn answer, never the CLI's output", async () => {
    const p = nextProfile()
    authBehavior = "exit1"
    await getClaudeAuthStatusAsync(p)
    expect(warnings()[0]).toContain("exited with code 1 reporting loggedIn: false")
    expect(warnings().join("\n")).not.toContain("private@test.com")
  })

  it("reports a non-zero exit whose output is not JSON by its code alone", async () => {
    authBehavior = "exit2"
    await getClaudeAuthStatusAsync(nextProfile())
    expect(warnings()[0]).toContain("`claude auth status` exited with code 2 (1 in a row")
  })

  it("notes a first answer that outlived the caller's wait", async () => {
    setAuthStatusWaitMsForTesting(20)
    const p = nextProfile()
    authBehavior = "hang"
    expect(await getClaudeAuthStatusAsync(p)).toBeNull()
    expect(warnings()).toHaveLength(0)

    await new Promise(r => setTimeout(r, 30))
    releaseHungSpawns()
    await pendingAuthStatusRefresh(p)
    expect(warnings()).toHaveLength(1)
    expect(warnings()[0]).toContain(`Claude auth status for profile "${p}" took`)
    expect(warnings()[0]).toContain("it read as unverified until then")
  })

  it("stays quiet about a fast first answer", async () => {
    await getClaudeAuthStatusAsync(nextProfile())
    expect(warnings()).toHaveLength(0)
  })
})

/**
 * Credential-file mtime invalidation under MERIDIAN_CREDENTIALS_READONLY.
 *
 * A read-only instance never refreshes its own tokens, so the only thing that
 * ever changes its auth status is a rotation performed by the instance that
 * owns them. Time-based expiry alone would keep serving the pre-rotation
 * answer for up to a full TTL after one lands.
 *
 * Lives here rather than in credentials-readonly.test.ts because it asserts on
 * the real auth-status cache: four files in the main `bun test` run call
 * `mock.module("../proxy/models", …)`, which is global, so those assertions
 * only hold in this file's own isolated invocation.
 */
describe("auth-status cache — credential mtime invalidation", () => {
  let dir: string
  let credFile: string

  beforeEach(() => {
    authBehavior = "success"
    execFileCalls = 0
    resetCachedClaudeAuthStatus()
    dir = mkdtempSync(join(tmpdir(), "meridian-readonly-mtime-"))
    credFile = join(dir, ".credentials.json")
    // Fabricated placeholder — only the file's mtime matters here.
    writeFileSync(credFile, JSON.stringify({ claudeAiOauth: { accessToken: "placeholder" } }))
  })

  afterEach(() => {
    delete process.env.MERIDIAN_CREDENTIALS_READONLY
    rmSync(dir, { recursive: true, force: true })
  })

  /** Push mtime forward a whole second so the change is unambiguous. */
  function ageCredentialFile(): void {
    const next = new Date(statSync(credFile).mtimeMs + 1000)
    utimesSync(credFile, next, next)
  }

  it("re-reads when the other instance rotates the credential file", async () => {
    process.env.MERIDIAN_CREDENTIALS_READONLY = "1"
    const p = nextProfile()
    const overrides = { CLAUDE_CONFIG_DIR: dir }

    await getClaudeAuthStatusAsync(p, overrides)
    expect(execFileCalls).toBe(1)

    await getClaudeAuthStatusAsync(p, overrides)
    expect(execFileCalls).toBe(1)

    ageCredentialFile()
    await getClaudeAuthStatusAsync(p, overrides)
    await pendingAuthStatusRefresh(p)
    expect(execFileCalls).toBe(2)
  })

  it("picks up the rotated payload rather than the cached one", async () => {
    process.env.MERIDIAN_CREDENTIALS_READONLY = "1"
    const p = nextProfile()
    const overrides = { CLAUDE_CONFIG_DIR: dir }

    await getClaudeAuthStatusAsync(p, overrides)
    currentPayload = { loggedIn: true, email: "rotated@test.com", subscriptionType: "max" }

    ageCredentialFile()
    await getClaudeAuthStatusAsync(p, overrides)
    await pendingAuthStatusRefresh(p)
    expect(await getClaudeAuthStatusAsync(p, overrides)).toEqual(currentPayload)
  })

  it("leaves the time-based cache untouched when the flag is absent", async () => {
    const p = nextProfile()
    const overrides = { CLAUDE_CONFIG_DIR: dir }

    await getClaudeAuthStatusAsync(p, overrides)
    expect(execFileCalls).toBe(1)

    ageCredentialFile()
    await getClaudeAuthStatusAsync(p, overrides)
    expect(execFileCalls).toBe(1)
  })
})

/**
 * The same property end to end: `/health` over the real auth-status cache.
 * Caddy probes it with a 2 s timeout, so a probe that waits on the spawn is a
 * proxy marked down.
 */
describe("/health with an expired auth-status cache", () => {
  beforeEach(() => {
    authBehavior = "success"
    execFileCalls = 0
    hungSpawns = []
    currentPayload = { loggedIn: true, email: "test@test.com", subscriptionType: "max" }
    resetCachedClaudeAuthStatus()
  })

  afterEach(() => {
    releaseHungSpawns()
  })

  it("answers healthy from the previous status while the refresh is stalled", async () => {
    const { createProxyServer } = await import("../proxy/server")
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    const probe = async () => {
      const res = await app.fetch(new Request("http://localhost/health"))
      return { status: res.status, body: await res.json() as Record<string, unknown> }
    }

    expect((await probe()).body.status).toBe("healthy")
    expireAuthStatusCache()
    authBehavior = "hang"

    const stalled = await settledWithin(probe(), 1_000)
    expect(stalled).not.toBe(NOT_SETTLED)
    if (stalled === NOT_SETTLED) return
    expect(stalled.status).toBe(200)
    expect(stalled.body.status).toBe("healthy")
    await tick()
    expect(hungSpawns).toHaveLength(1)
  })
})

/**
 * A fresh process whose first check is slower than any caller waits: what the
 * HTTP surfaces say while it runs, and that its answer is what they say next.
 */
describe("HTTP surfaces during a slow first auth check", () => {
  beforeEach(() => {
    authBehavior = "hang"
    execFileCalls = 0
    hungSpawns = []
    currentPayload = { loggedIn: true, email: "test@test.com", subscriptionType: "max" }
    resetCachedClaudeAuthStatus()
    setAuthStatusWaitMsForTesting(50)
  })

  afterEach(() => {
    releaseHungSpawns()
    setAuthStatusWaitMsForTesting()
  })

  it("/health answers degraded within the wait, then healthy once the check lands", async () => {
    const { createProxyServer } = await import("../proxy/server")
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    const probe = async () => (await (await app.fetch(new Request("http://localhost/health"))).json() as { status: string }).status

    expect(await settledWithin(probe(), 1_000)).toBe("degraded")
    expect(hungSpawns).toHaveLength(1)

    releaseHungSpawns()
    await pendingAuthStatusRefresh()
    expect(await probe()).toBe("healthy")
    expect(execFileCalls).toBe(1)
  })

  it("/profiles/list reports the profile as never read, not logged out, until then", async () => {
    const { createProxyServer } = await import("../proxy/server")
    const { app } = createProxyServer({
      profiles: [{ id: "slow-first", type: "api", apiKey: "fixture-key" }],
      defaultProfile: "slow-first",
      silent: true,
    })
    const listed = async () => {
      const body = await (await app.fetch(new Request("http://localhost/profiles/list"))).json() as {
        profiles: Array<{ loggedIn: boolean; authProvenance: string }>
      }
      return body.profiles[0]!
    }

    expect(await listed()).toMatchObject({ loggedIn: false, authProvenance: "never" })

    releaseHungSpawns()
    await pendingAuthStatusRefresh("slow-first")
    expect(await listed()).toMatchObject({ loggedIn: true, authProvenance: "live" })
  })
})
