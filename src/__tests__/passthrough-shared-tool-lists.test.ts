/**
 * Sessions sending the same tools hold one copy of the list and a short key.
 *
 * OpenCode sends a ~300 KB tool list on every turn of every session. The
 * per-session tool cache kept each session's parsed copy and the per-session
 * MCP cache kept a ~190 KB key string, so a long-lived proxy grew by about
 * 1 MB per session until MERIDIAN_MAX_SESSIONS was reached.
 */

import { describe, it, expect, beforeEach } from "bun:test"
import { heapStats } from "bun:jsc"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { assistantMessage, withMockSdkSessionId } from "./helpers"

installSdkMock(() => ({
  query: (params: any) => (async function* () {
    yield withMockSdkSessionId(assistantMessage([{ type: "text", text: "ok" }]), params.options)
  })(),
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}), "passthrough-shared-tool-lists.test.ts")

installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}))

installMcpToolsMock(() => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const { sharedToolList, computeToolSetKey } = await import("../proxy/passthroughTools")

function tools(description = "Read a file") {
  return ["read", "write", "bash"].map(name => ({
    name,
    description: `${description} (${name})`,
    input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  }))
}

/** About the size of OpenCode's real list: 260 tools, ~300 KB of JSON. */
function largeToolList() {
  return Array.from({ length: 260 }, (_, i) => ({
    name: `mcp__server${i % 12}__tool_${i}`,
    description: `Tool ${i}. ` + "Does one thing with the given arguments and returns a structured result. ".repeat(8),
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The identifier of the target object, exactly as a list call returned it." },
        count: { type: "integer", description: "How many results to return", minimum: 1, maximum: 500 },
        mode: { type: "string", enum: ["fast", "slow", "exact", "fuzzy"], description: "Search mode" },
        tags: { type: "array", items: { type: "string" }, description: "Tags to filter by" },
        options: { type: "object", properties: { a: { type: "string" }, b: { type: "number" } }, required: ["a"] },
      },
      required: ["id"],
    },
  }))
}

function settledHeap(): number {
  Bun.gc(true)
  Bun.gc(true)
  return heapStats().heapSize
}

describe("sharedToolList", () => {
  it("returns one list for identical content", () => {
    const first = sharedToolList(tools())
    expect(sharedToolList(tools())).toBe(first)
    expect(sharedToolList(structuredClone(first))).toBe(first)
  })

  it("keeps a separate list for different content or order", () => {
    const base = sharedToolList(tools())
    expect(sharedToolList(tools("Changed"))).not.toBe(base)
    expect(sharedToolList([...tools()].reverse())).not.toBe(base)
    const reordered = tools().map(({ name, description, input_schema }) => ({ description, name, input_schema }))
    expect(sharedToolList(reordered)).not.toBe(base)
    const retyped = tools().map(tool => ({ ...tool, input_schema: { ...tool.input_schema, properties: { path: { type: "number" } } } }))
    expect(sharedToolList(retyped)).not.toBe(base)
  })

  it("keeps nothing alive once no session holds the list", async () => {
    const held = (() => new WeakRef(sharedToolList(tools("Dropped"))))()
    // A WeakRef keeps its target until the job that created it ends.
    await Bun.sleep(0)
    Bun.gc(true)
    expect(held.deref()).toBeUndefined()
  })
})

describe("passthrough session caches", () => {
  beforeEach(async () => {
    await clearSessionCache()
  })

  it("keeps the tool-set key short", () => {
    expect(computeToolSetKey(largeToolList()).length).toBeLessThanOrEqual(64)
  })

  it("does not grow by a tool list per session", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1", silent: true })
    const body = (session: string) => JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: false,
      messages: [{ role: "user", content: `hello from ${session}` }],
      tools: largeToolList(),
    })
    const post = async (session: string) => {
      const res = await app.fetch(new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-opencode-session": session },
        body: body(session),
      }))
      expect(res.status).toBe(200)
      await res.text()
    }
    // The first sessions build the shared definitions and warm the process.
    for (let i = 0; i < 20; i++) await post(`warm-${i}`)
    const before = settledHeap()
    const SESSIONS = 40
    for (let i = 0; i < SESSIONS; i++) await post(`session-${i}`)
    const perSession = (settledHeap() - before) / SESSIONS
    // A copy of the list and its key cost ~680 KB per session here; what is
    // left is the session's own state and code still being compiled.
    expect(perSession).toBeLessThan(100_000)
  }, 60_000)
})
