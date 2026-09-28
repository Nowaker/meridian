/**
 * Slow session bookkeeping must not fail a turn whose model already answered.
 *
 * Terminal publication records where the NEXT turn resumes. When its lifecycle
 * lock could not be admitted - a holder stalled under a frozen event loop, a
 * full queue, an external lock deadline - every concurrent answered turn used
 * to fail at once with a 503, and each client re-ran its whole turn.
 */
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { lookupSharedSession, setSessionStoreDir } from "../proxy/sessionStore"
import * as lifecycle from "../proxy/sessionLifecycle"
import { SessionLifecycleQueueStalledError } from "../proxy/session/lifecycleErrors"
import {
  assistantMessage,
  blockStop,
  messageDelta,
  messageStart,
  messageStop,
  resolveMockSdkSessionId,
  textBlockStart,
  textDelta,
} from "./helpers"

let queryCalls = 0

installSdkMock(() => ({
  query: (params: { options?: { sessionId?: string } }) => {
    queryCalls++
    const sessionId = resolveMockSdkSessionId(params?.options, `sdk-degrade-${queryCalls}`)
    const generator = (async function* () {
      yield { ...messageStart(), session_id: sessionId }
      yield { ...textBlockStart(0), session_id: sessionId }
      yield { ...textDelta(0, "answered"), session_id: sessionId }
      yield { ...blockStop(0), session_id: sessionId }
      yield { ...messageDelta("end_turn"), session_id: sessionId }
      yield { ...messageStop(), session_id: sessionId }
      yield { ...assistantMessage([{ type: "text", text: "answered" }]), session_id: sessionId }
    })()
    return Object.assign(generator, { close: () => {} })
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}), "lifecycle-publication-degrade.test.ts")

installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}))

installMcpToolsMock(() => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

import { resolveSdkModelDefaults } from "../proxy/models"

mock.module("../proxy/models", () => ({
  mapModelToClaudeModel: () => "sonnet",
  resolveClaudeExecutableAsync: async () => "claude",
  resolveSdkModelDefaults,
  getClaudeAuthStatusAsync: async () => ({ loggedIn: true, email: "test@test.com", subscriptionType: "max" }),
  getAuthCacheInfo: () => ({ lastCheckedAt: 0, lastSuccessAt: 0, isFailure: false }),
  hasExtendedContext: () => false,
  stripExtendedContext: (m: string) => m,
  isClosedControllerError: (e: unknown) => e instanceof Error && e.message.includes("controller is closed"),
  recordExtendedContextUnavailable: () => {},
  isExtendedContextKnownUnavailable: () => false,
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const { resetActiveProfile } = await import("../proxy/profiles")

const profiles = [{ id: "personal", claudeConfigDir: "/home/.claude" }]
const FIRST_TURN = [{ role: "user", content: "hi" }]
const SECOND_TURN = [...FIRST_TURN, { role: "assistant", content: "answered" }, { role: "user", content: "again" }]
const THIRD_TURN = [...SECOND_TURN, { role: "assistant", content: "answered" }, { role: "user", content: "once more" }]

function turn(sessionId: string, messages: Array<{ role: string; content: string }>, stream: boolean): Request {
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-opencode-session": sessionId },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 128, stream, messages }),
  })
}

const stalled = () => new SessionLifecycleQueueStalledError("active lifecycle holder stalled for /store/session-gc.json.lock")

describe("terminal publication under a stalled lifecycle lock", () => {
  let sessionDir = ""

  beforeEach(() => {
    sessionDir = mkdtempSync(join(tmpdir(), "meridian-publication-degrade-"))
    setSessionStoreDir(sessionDir)
    resetActiveProfile()
    clearSessionCache()
    queryCalls = 0
  })

  afterEach(() => {
    rmSync(sessionDir, { recursive: true, force: true })
  })

  for (const stream of [false, true]) {
    for (const step of ["commitFork", "publishPinnedTranscript"] as const) {
      it(`delivers the answered ${stream ? "stream" : "non-stream"} turn when ${step} cannot be admitted`, async () => {
        const { app, sweepSessionGc } = createProxyServer({ port: 0, host: "127.0.0.1", silent: true, profiles })
        const key = `degrade-${stream ? "stream" : "json"}-${step}`
        expect((await app.fetch(turn(key, FIRST_TURN, false))).status).toBe(200)
        const before = lookupSharedSession(`personal:${key}`)
        expect(before).toBeDefined()

        const spy = spyOn(lifecycle, step).mockImplementation(async () => { throw stalled() })
        let text: string
        let status: number
        try {
          const response = await app.fetch(turn(key, SECOND_TURN, stream))
          status = response.status
          text = await response.text()
        } finally {
          spy.mockRestore()
        }

        expect(status).toBe(200)
        expect(text).toContain("answered")
        expect(text).not.toContain("bookkeeping")
        if (stream) {
          expect(text).toContain("event: message_stop")
          expect(text).not.toContain("event: error")
        }
        // The old mapping would resume a transcript without this turn's
        // answer, so it is gone and the next turn replays instead.
        expect(lookupSharedSession(`personal:${key}`)).toBeUndefined()

        const next = await app.fetch(turn(key, THIRD_TURN, stream))
        expect(next.status).toBe(200)
        await next.text()
        expect(lookupSharedSession(`personal:${key}`)?.messageCount).toBe(THIRD_TURN.length)
        await sweepSessionGc?.()
      })
    }
  }
})
