/**
 * Mock mode — local answers carrying the payload that would have gone upstream.
 *
 * The integration cases exist to prove the two properties the unit cases
 * cannot: that `query()` is never reached when mock mode is on, and that it
 * still is when mock mode is off.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "bun:test"
import type { SDKAssistantMessage, SDKMessage, SDKPartialAssistantMessage } from "@anthropic-ai/claude-agent-sdk"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { assistantMessage, parseSSE, withMockSdkSessionId } from "./helpers"
import {
  isMockRequested,
  formatMockPayload,
  mockSdkMessages,
  MOCK_HEADER,
  MOCK_REDACTED,
  MOCK_THINKING_TEXT,
} from "../proxy/mock"

let queryCallCount = 0

installSdkMock(() => ({
  query: (params: { options?: unknown }) => {
    queryCallCount++
    return (async function* () {
      yield withMockSdkSessionId(assistantMessage([{ type: "text", text: "real answer" }]), params.options)
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}), "mock-mode.test.ts")

installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}))

installMcpToolsMock(() => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const { createProxyServer } = await import("../proxy/server")

// ============================================================
// isMockRequested
// ============================================================

describe("isMockRequested", () => {
  let savedMock: string | undefined

  beforeEach(() => { savedMock = process.env.MERIDIAN_MOCK })
  afterEach(() => {
    if (savedMock !== undefined) process.env.MERIDIAN_MOCK = savedMock
    else delete process.env.MERIDIAN_MOCK
  })

  it("is off when neither the header nor the env var is set", () => {
    delete process.env.MERIDIAN_MOCK
    expect(isMockRequested(undefined)).toBe(false)
    expect(isMockRequested(null)).toBe(false)
  })

  it("accepts the affirmative header spellings", () => {
    delete process.env.MERIDIAN_MOCK
    for (const value of ["1", "true", "yes", "TRUE", " Yes "]) {
      expect(isMockRequested(value)).toBe(true)
    }
  })

  it("falls back to MERIDIAN_MOCK when no header is present", () => {
    process.env.MERIDIAN_MOCK = "1"
    expect(isMockRequested(undefined)).toBe(true)
  })

  it("lets a negative header opt one request out of an instance-wide MERIDIAN_MOCK", () => {
    process.env.MERIDIAN_MOCK = "1"
    for (const value of ["0", "false", "no"]) {
      expect(isMockRequested(value)).toBe(false)
    }
  })

  it("ignores an unrecognized header value and defers to the env var", () => {
    process.env.MERIDIAN_MOCK = "1"
    expect(isMockRequested("maybe")).toBe(true)
    delete process.env.MERIDIAN_MOCK
    expect(isMockRequested("maybe")).toBe(false)
  })
})

// ============================================================
// formatMockPayload
// ============================================================

describe("formatMockPayload", () => {
  it("renders newlines inside strings as real newlines, not escapes", async () => {
    const text = await formatMockPayload({ prompt: "line one\nline two\nline three" })
    expect(text).toContain("line one\nline two\nline three")
    expect(text).not.toContain("\\n")
  })

  it("pretty-prints with two-space indentation", async () => {
    const text = await formatMockPayload({ prompt: "hi", options: { model: "opus", cwd: "/tmp" } })
    expect(text).toContain('\n  "options": {')
    expect(text).toContain('\n    "model": "opus"')
  })

  it("keeps credential-shaped keys but replaces their values", async () => {
    const text = await formatMockPayload({
      options: {
        env: {
          CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-do-not-echo",
          MY_API_KEY: "do-not-echo-either",
          PATH: "/usr/bin",
        },
      },
    })
    expect(text).toContain("CLAUDE_CODE_OAUTH_TOKEN")
    expect(text).toContain("MY_API_KEY")
    expect(text).not.toContain("sk-ant-oat-do-not-echo")
    expect(text).not.toContain("do-not-echo-either")
    expect(text.match(new RegExp(MOCK_REDACTED.replace(/[[\]]/g, "\\$&"), "g"))).toHaveLength(2)
    expect(text).toContain('"PATH": "/usr/bin"')
  })

  it("redacts every value nested under a credential-shaped key", async () => {
    const text = await formatMockPayload({ options: { credentials: { user: "nowaker", rotations: 3 } } })
    expect(text).not.toContain("nowaker")
    expect(text).not.toContain("3")
  })

  it("names functions instead of dropping them the way JSON.stringify does", async () => {
    const text = await formatMockPayload({ options: { hooks: { PreToolUse: function denyWrite() {} } } })
    expect(text).toContain("[Function: denyWrite]")
  })

  it("cuts genuine cycles without collapsing values that merely repeat", async () => {
    const shared = { name: "shared" }
    const cyclic: Record<string, unknown> = { shared, also: shared }
    cyclic.self = cyclic
    const text = await formatMockPayload({ options: cyclic })
    expect(text).toContain("[Circular]")
    expect(text.match(/"name": "shared"/g)).toHaveLength(2)
  })

  it("materializes an async-iterable prompt so multimodal requests render", async () => {
    async function* prompt() {
      yield { type: "user", message: { role: "user", content: "first" } }
      yield { type: "user", message: { role: "user", content: "second" } }
    }
    const text = await formatMockPayload({ prompt: prompt() })
    expect(text).toContain('"first"')
    expect(text).toContain('"second"')
  })
})

// ============================================================
// mockSdkMessages
// ============================================================

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const item of source) out.push(item)
  return out
}

function onlyAssistant(messages: SDKMessage[]): SDKAssistantMessage {
  const [first] = messages
  if (messages.length !== 1 || !first || first.type !== "assistant") {
    throw new Error(`expected exactly one assistant message, got [${messages.map((m) => m.type).join(", ")}]`)
  }
  return first
}

function streamEvents(messages: SDKMessage[]): SDKPartialAssistantMessage[] {
  return messages.filter((m): m is SDKPartialAssistantMessage => m.type === "stream_event")
}

function assistantText(message: SDKAssistantMessage): string {
  const block = message.message.content.find((b) => b.type === "text")
  if (!block) throw new Error(`no text block in [${message.message.content.map((b) => b.type).join(", ")}]`)
  return block.text
}

function assistantThinking(message: SDKAssistantMessage): string {
  const block = message.message.content.find((b) => b.type === "thinking")
  if (!block) throw new Error(`no thinking block in [${message.message.content.map((b) => b.type).join(", ")}]`)
  return block.thinking
}

function streamedText(messages: SDKMessage[]): string {
  return streamEvents(messages).flatMap((m) =>
    m.event.type === "content_block_delta" && m.event.delta.type === "text_delta" ? [m.event.delta.text] : [],
  ).join("")
}

function streamedThinking(messages: SDKMessage[]): string {
  return streamEvents(messages).flatMap((m) =>
    m.event.type === "content_block_delta" && m.event.delta.type === "thinking_delta" ? [m.event.delta.thinking] : [],
  ).join("")
}

describe("mockSdkMessages", () => {
  const params = { prompt: "hello\nworld", options: { model: "claude-opus-4-5", cwd: "/srv/app" } }

  it("emits one assistant message carrying the thinking block and the payload", async () => {
    const message = onlyAssistant(await collect(mockSdkMessages(params, false)))
    expect(message.message.content.map((b) => b.type)).toEqual(["thinking", "text"])
    expect(assistantThinking(message)).toBe(MOCK_THINKING_TEXT)
    expect(assistantText(message)).toBe(await formatMockPayload(params))
    expect(message.message.model).toBe("claude-opus-4-5")
  })

  it("reports zero usage so mock traffic stays out of cost and quota telemetry", async () => {
    const message = onlyAssistant(await collect(mockSdkMessages(params, false)))
    expect(message.message.usage.input_tokens).toBe(0)
    expect(message.message.usage.output_tokens).toBe(0)
  })

  it("emits a well-formed stream whose assembled text is the same payload", async () => {
    const messages = await collect(mockSdkMessages(params, true))
    const types = streamEvents(messages).map((m) => m.event.type)
    expect(types[0]).toBe("message_start")
    expect(types.at(-1)).toBe("message_stop")
    expect(types.at(-2)).toBe("message_delta")
    expect(streamedText(messages)).toBe(await formatMockPayload(params))
    expect(streamedThinking(messages)).toBe(MOCK_THINKING_TEXT)
  })

  it("opens and closes both content blocks exactly once", async () => {
    const events = streamEvents(await collect(mockSdkMessages(params, true))).map((m) => m.event)
    const starts = events.filter((e) => e.type === "content_block_start")
    const stops = events.filter((e) => e.type === "content_block_stop")
    expect(starts.map((e) => e.content_block.type)).toEqual(["thinking", "text"])
    expect(starts.map((e) => e.index)).toEqual([0, 1])
    expect(stops.map((e) => e.index)).toEqual([0, 1])
  })

  it("keeps a resumed session id and mints a fresh one for a fork", async () => {
    const resumed = onlyAssistant(await collect(mockSdkMessages({ options: { resume: "sess-abc" } }, false)))
    expect(resumed.session_id).toBe("sess-abc")

    const forked = onlyAssistant(await collect(mockSdkMessages({ options: { resume: "sess-abc", forkSession: true } }, false)))
    expect(forked.session_id).not.toBe("sess-abc")
    expect(forked.session_id).toStartWith("mock-")
  })

  it("echoes a managed fork target, which the proxy verifies and would 500 on", async () => {
    const options = { sessionId: "b53ac32c-9c8a-489f-8bf6-2cbb2fc64c8d", resume: "sess-abc", forkSession: true }
    expect(onlyAssistant(await collect(mockSdkMessages({ options }, false))).session_id).toBe(options.sessionId)

    const streamed = streamEvents(await collect(mockSdkMessages({ options }, true)))
    expect(new Set(streamed.map((m) => m.session_id))).toEqual(new Set([options.sessionId]))
  })
})

// ============================================================
// Through the HTTP layer
// ============================================================

interface WireBlock {
  type: string
  text?: string
  thinking?: string
}

async function wireBlocks(response: Response): Promise<WireBlock[]> {
  const body: unknown = await response.json()
  const content = (body as { content?: unknown }).content
  if (!Array.isArray(content)) {
    throw new Error(`expected an Anthropic message with content, got ${JSON.stringify(body)?.slice(0, 300)}`)
  }
  return content as WireBlock[]
}

function wireBlockText(blocks: WireBlock[], type: "text" | "thinking"): string {
  const block = blocks.find((b) => b.type === type)
  const value = block && (type === "text" ? block.text : block.thinking)
  if (typeof value !== "string") {
    throw new Error(`no ${type} block in [${blocks.map((b) => b.type).join(", ")}]`)
  }
  return value
}

function wireDeltaText(events: ReturnType<typeof parseSSE>, deltaType: string, field: string): string {
  return events.flatMap((e) => {
    if (e.event !== "content_block_delta") return []
    const delta = e.data.delta
    if (typeof delta !== "object" || delta === null) return []
    const fields = delta as Record<string, unknown>
    if (fields.type !== deltaType) return []
    const value = fields[field]
    return typeof value === "string" ? [value] : []
  }).join("")
}

describe("mock mode over HTTP", () => {
  let app: ReturnType<typeof createProxyServer>["app"]
  let savedPassthrough: string | undefined
  let savedMock: string | undefined

  beforeAll(() => {
    // No profiles, so nothing here can reach a credential — which is the point:
    // mock mode has to answer on an instance that could not call upstream.
    app = createProxyServer({ port: 0, host: "127.0.0.1" }).app
  })

  beforeEach(() => {
    savedPassthrough = process.env.MERIDIAN_PASSTHROUGH
    savedMock = process.env.MERIDIAN_MOCK
    process.env.MERIDIAN_PASSTHROUGH = "0"
    queryCallCount = 0
  })

  afterEach(() => {
    if (savedPassthrough !== undefined) process.env.MERIDIAN_PASSTHROUGH = savedPassthrough
    else delete process.env.MERIDIAN_PASSTHROUGH
    if (savedMock !== undefined) process.env.MERIDIAN_MOCK = savedMock
    else delete process.env.MERIDIAN_MOCK
  })

  async function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
    return app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": "dummy", ...headers },
      body: JSON.stringify(body),
    }))
  }

  const baseBody = {
    model: "claude-sonnet-4-5",
    max_tokens: 1024,
    messages: [{ role: "user", content: "what would you have sent?" }],
    system: "You are a helpful assistant.",
  }

  it("answers a non-streaming request without calling the SDK", async () => {
    const response = await post({ ...baseBody, stream: false }, { [MOCK_HEADER]: "1" })
    expect(response.status).toBe(200)
    const blocks = await wireBlocks(response)

    expect(queryCallCount).toBe(0)
    expect(wireBlockText(blocks, "thinking")).toBe(MOCK_THINKING_TEXT)

    const text = wireBlockText(blocks, "text")
    expect(text).toContain('"prompt"')
    expect(text).toContain('"options"')
    expect(text).toContain("You are a helpful assistant.")
    expect(text).toContain("what would you have sent?")
  })

  it("answers a streaming request without calling the SDK", async () => {
    const response = await post({ ...baseBody, stream: true }, { [MOCK_HEADER]: "1" })
    expect(response.status).toBe(200)
    const events = parseSSE(await response.text())

    expect(queryCallCount).toBe(0)

    const names = events.map((e) => e.event)
    expect(names[0]).toBe("message_start")
    expect(names.at(-1)).toBe("message_stop")

    const assembled = wireDeltaText(events, "text_delta", "text")
    expect(assembled).toContain("You are a helpful assistant.")
    expect(assembled).toContain("what would you have sent?")

    expect(wireDeltaText(events, "thinking_delta", "thinking")).toBe(MOCK_THINKING_TEXT)
  })

  it("renders the payload with real newlines over the wire", async () => {
    const response = await post({ ...baseBody, stream: false }, { [MOCK_HEADER]: "1" })
    const text = wireBlockText(await wireBlocks(response), "text")
    expect(text.split("\n").length).toBeGreaterThan(5)
  })

  it("turns on from MERIDIAN_MOCK with no header", async () => {
    process.env.MERIDIAN_MOCK = "1"
    const response = await post({ ...baseBody, stream: false })
    expect(response.status).toBe(200)
    expect(queryCallCount).toBe(0)
  })

  it("still calls the SDK when mock mode is off", async () => {
    delete process.env.MERIDIAN_MOCK
    const response = await post({ ...baseBody, stream: false })
    expect(response.status).toBe(200)
    expect(queryCallCount).toBe(1)
    expect(wireBlockText(await wireBlocks(response), "text")).toBe("real answer")
  })

  it("lets a negative header override MERIDIAN_MOCK for one request", async () => {
    process.env.MERIDIAN_MOCK = "1"
    const response = await post({ ...baseBody, stream: false }, { [MOCK_HEADER]: "0" })
    expect(response.status).toBe(200)
    expect(queryCallCount).toBe(1)
  })

  it("does not echo a credential the client never sent", async () => {
    const response = await post({ ...baseBody, stream: false }, { [MOCK_HEADER]: "1" })
    const text = wireBlockText(await wireBlocks(response), "text")
    expect(text).not.toContain("sk-ant-")
    expect(text).not.toContain("CLAUDE_CODE_OAUTH_TOKEN\": \"sk")
  })
})
