/**
 * A stream that has been answered or abandoned leaves no SDK attempt running
 * behind it.
 *
 * The upstream idle guard answers the client while the SDK query is still
 * waiting for the model's first output, and a client can leave while its
 * request still waits for a free SDK slot. Either attempt used to carry on, so
 * once a slot freed it started Claude Code and spent upstream calls on a
 * request nobody was waiting for. Waiting for a slot is not upstream silence:
 * a queued request is never answered as an upstream stall.
 *
 * Runs in its own `bun test` invocation: the idle limit is read once, when the
 * server module loads, and the 90s default would make this file take minutes.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { parseSSE } from "./helpers"
import { getProcessSdkSemaphore } from "../proxy/concurrency"

// Above the time a fresh session's durable admission takes to reach query().
const IDLE_MS = 8_000
process.env.MERIDIAN_UPSTREAM_IDLE_MS = String(IDLE_MS)
process.env.MERIDIAN_MAX_CONCURRENT = "1"

let controllers: Array<AbortController | undefined> = []

installSdkMock(() => ({
  query: (params: { options: { abortController?: AbortController } }) => {
    const controller = params.options.abortController
    controllers.push(controller)
    return (async function* () {
      await new Promise<never>((_resolve, reject) => {
        const signal = controller?.signal
        if (!signal) return reject(new Error("missing SDK abort controller"))
        if (signal.aborted) return reject(new Error("SDK query aborted"))
        signal.addEventListener("abort", () => reject(new Error("SDK query aborted")), { once: true })
      })
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "fixture", instance: {} }),
  tool: () => ({}),
}), "proxy-stream-abandoned-attempt.test.ts")
installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: <T>(_context: unknown, fn: () => T) => fn(),
}))
installMcpToolsMock(() => ({ createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }) }))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")

function streamRequest(text: string, signal?: AbortSignal): Request {
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    signal,
    headers: { "content-type": "application/json", "x-opencode-session": crypto.randomUUID() },
    body: JSON.stringify({ model: "haiku", max_tokens: 100, stream: true, messages: [{ role: "user", content: text }] }),
  })
}

function errorType(raw: string): string | undefined {
  const error = parseSSE(raw).find(event => event.event === "error")?.data.error as { type?: string } | undefined
  return error?.type
}

async function sdkSlotsIdle(deadlineMs = 5_000) {
  const deadline = performance.now() + deadlineMs
  let snapshot = getProcessSdkSemaphore().snapshot
  while ((snapshot.active > 0 || snapshot.queued > 0) && performance.now() < deadline) {
    await Bun.sleep(20)
    snapshot = getProcessSdkSemaphore().snapshot
  }
  return snapshot
}

describe("a stream answered by the upstream idle guard", () => {
  beforeEach(() => {
    controllers = []
    clearSessionCache()
  })

  afterAll(() => {
    delete process.env.MERIDIAN_UPSTREAM_IDLE_MS
    delete process.env.MERIDIAN_MAX_CONCURRENT
  })

  it("keeps a request queued for an SDK slot waiting, and never starts it once its client leaves", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1", silent: true })
    const onlySlot = await getProcessSdkSemaphore().acquire()
    const client = new AbortController()
    try {
      const body = (await app.fetch(streamRequest("hello", client.signal))).text().catch(() => "")
      const answered = await Promise.race([body.then(() => true), Bun.sleep(IDLE_MS + 1_000).then(() => false)])
      expect(answered).toBe(false)
      expect(getProcessSdkSemaphore().snapshot.queued).toBe(1)
      client.abort()
      expect(errorType(await body)).not.toBe("upstream_timeout")
      expect(getProcessSdkSemaphore().snapshot.queued).toBe(0)
    } finally {
      onlySlot.release()
    }

    expect(await sdkSlotsIdle()).toMatchObject({ active: 0, queued: 0 })
    expect(controllers).toHaveLength(0)
  })

  it("aborts the SDK query of an attempt still waiting for output", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1", silent: true })

    const timedOut = await (await app.fetch(streamRequest("hello"))).text()
    expect(errorType(timedOut)).toBe("upstream_timeout")
    expect(controllers).toHaveLength(1)
    expect(controllers[0]?.signal.aborted).toBe(true)

    expect(await sdkSlotsIdle()).toMatchObject({ active: 0, queued: 0 })
    expect(controllers).toHaveLength(1)
  })
})
