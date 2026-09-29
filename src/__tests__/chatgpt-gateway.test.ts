/**
 * The ChatGPT gateway end to end over HTTP, with chatgpt.com mocked.
 *
 * Every guarantee here is paired with a control that proves the check can
 * fail: the never-refresh assertions against owned mode, where a refresh does
 * happen and the same spy sees it; the no-plugin assertions against the
 * Claude path, where the same plugin does run.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { assistantMessage, resolveMockSdkSessionId } from "./helpers"

let sdkCalls = 0
installSdkMock(() => ({
  query: (params: unknown) => {
    sdkCalls++
    return (async function* () {
      yield { ...assistantMessage([{ type: "text", text: "claude-ok" }]), session_id: resolveMockSdkSessionId((params as { options?: unknown }).options, "sdk-chatgpt-1") }
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}), "chatgpt-gateway.test.ts")
installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => Promise<Response> | Response) => fn(),
}))

const sessionDir = mkdtempSync(join(tmpdir(), "chatgpt-gateway-sess-"))
process.env.CLAUDE_PROXY_SESSION_DIR = sessionDir
delete process.env.MERIDIAN_API_KEY

const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const { telemetryStore } = await import("../telemetry")

const NOW = Date.now()
const CODEX_URL = "https://chatgpt.com/backend-api/codex/responses"
const TOKEN_URL = "https://auth.openai.com/oauth/token"

interface UpstreamCall { url: string; authorization: string | null; accountId: string | null; body: Record<string, unknown> }
let upstreamCalls: UpstreamCall[] = []
let tokenCalls = 0
let respond: (call: UpstreamCall, index: number) => Response | Promise<Response> = () => completed()
const realFetch = globalThis.fetch

function completed(text = "pong"): Response {
  const events = [
    { type: "response.created", response: { id: "r1", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { type: "message" } },
    { type: "response.output_text.delta", delta: text },
    { type: "response.output_item.done", output_index: 0, item: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } },
    { type: "response.completed", response: { id: "r1", model: "gpt-6-luna", output: [], usage: { input_tokens: 50, input_tokens_details: { cached_tokens: 10 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 2 } } } },
  ]
  return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream", "set-cookie": "must-not-leak=1" },
  })
}
const refused = () => new Response(JSON.stringify({ detail: "Unauthorized" }), { status: 401, headers: { "content-type": "application/json" } })

function mockFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
  if (url === TOKEN_URL) {
    tokenCalls++
    return Promise.resolve(new Response(JSON.stringify({ access_token: "at-refreshed", refresh_token: "rt-rotated", expires_in: 3600 }), { status: 200, headers: { "content-type": "application/json" } }))
  }
  if (url === CODEX_URL) {
    const headers = new Headers(init?.headers)
    const call = { url, authorization: headers.get("authorization"), accountId: headers.get("chatgpt-account-id"), body: JSON.parse(String(init?.body)) as Record<string, unknown> }
    upstreamCalls.push(call)
    return Promise.resolve(respond(call, upstreamCalls.length - 1))
  }
  if (url.startsWith("https://chatgpt.com/")) return Promise.resolve(new Response("{}", { status: 503 }))
  return Promise.reject(new Error(`unexpected network call in test: ${url}`))
}

function account(n: number, extra: Record<string, unknown> = {}) {
  return {
    accountId: `workspace-${n}`, accountUserId: `user-${n}__workspace-${n}`, email: `seat${n}@example.test`,
    refreshToken: `rt-${n}`, accessToken: `at-${n}`, expiresAt: NOW + 3_600_000, addedAt: 1, lastUsed: 1, ...extra,
  }
}

let dir: string
let poolDir: string
let poolPath: string
function writePool(accounts: unknown[]) {
  writeFileSync(poolPath, JSON.stringify({ version: 3, accounts, activeIndex: 0 }))
}
function snapshotPoolDir() {
  return { bytes: readFileSync(poolPath), entries: readdirSync(poolDir).sort() }
}

async function server(mode: string | undefined, plugin?: string) {
  if (mode === undefined) delete process.env.MERIDIAN_CHATGPT_CREDENTIALS
  else process.env.MERIDIAN_CHATGPT_CREDENTIALS = mode
  const pluginConfigPath = join(dir, "plugins.json")
  writeFileSync(pluginConfigPath, JSON.stringify({ plugins: plugin ? [{ path: plugin, enabled: true }] : [] }))
  const proxy = createProxyServer({ port: 0, host: "127.0.0.1", pluginDir: join(dir, "no-plugins"), pluginConfigPath })
  await proxy.initPlugins?.()
  return proxy
}

function responses(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer any-client-key", ...headers },
    body: JSON.stringify(body),
  })
}

const LUNA = {
  model: "gpt-6-luna",
  stream: true,
  max_output_tokens: 32000,
  input: [{ role: "developer", content: "You are opencode." }, { role: "user", content: "hi" }],
  prompt_cache_key: "conversation-1", // gitleaks:allow - a conversation id, not a credential
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chatgpt-gateway-"))
  poolDir = join(dir, "opencode")
  mkdirSync(poolDir)
  poolPath = join(poolDir, "oc-codex-multi-auth-accounts.json")
  process.env.MERIDIAN_CODEX_POOL_PATH = poolPath
  upstreamCalls = []
  tokenCalls = 0
  sdkCalls = 0
  respond = () => completed()
  globalThis.fetch = mockFetch as typeof fetch
  telemetryStore.clear()
  clearSessionCache()
})
afterEach(() => {
  globalThis.fetch = realFetch
  delete process.env.MERIDIAN_CHATGPT_CREDENTIALS
  delete process.env.MERIDIAN_CODEX_POOL_PATH
  delete process.env.MERIDIAN_CHATGPT_STORE_PATH
  rmSync(dir, { recursive: true, force: true })
})
afterAll(() => {
  rmSync(sessionDir, { recursive: true, force: true })
  delete process.env.CLAUDE_PROXY_SESSION_DIR
  mock.restore()
})

describe("ChatGPT gateway routing", () => {
  it("serves a GPT model from the seat's token, adapting only what the backend requires", async () => {
    writePool([account(0), account(1)])
    const { app } = await server("follow-external")
    const res = await app.fetch(responses(LUNA))
    expect(res.status).toBe(200)
    expect(res.headers.get("set-cookie")).toBeNull()
    expect(await res.text()).toContain('"delta":"pong"')

    expect(upstreamCalls).toHaveLength(1)
    const [call] = upstreamCalls
    expect(call!.authorization).toBe("Bearer at-0")
    expect(call!.accountId).toBe("workspace-0")
    const { max_output_tokens: _dropped, ...client } = LUNA
    expect(call!.body).toEqual({ ...client, store: false, include: ["reasoning.encrypted_content"] })

    const [metric] = telemetryStore.getRecent({ limit: 1 })
    expect(metric).toMatchObject({ adapter: "chatgpt", requestModel: "gpt-6-luna", status: 200, isPassthrough: true, inputTokens: 40, cacheReadInputTokens: 10, outputTokens: 5 })
  })

  it("aggregates the stream for a client that did not ask to stream", async () => {
    writePool([account(0)])
    const { app } = await server("follow-external")
    const res = await app.fetch(responses({ ...LUNA, stream: false }))
    expect(res.status).toBe(200)
    const body = await res.json() as { output: Array<{ content: Array<{ text: string }> }> }
    expect(body.output[0]!.content[0]!.text).toBe("pong")
  })

  it("keeps Claude models on Claude and refuses GPT models on the Messages surface", async () => {
    writePool([account(0)])
    const { app } = await server("follow-external")
    const claude = await app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 64, stream: false, messages: [{ role: "user", content: "hi" }] }),
    }))
    expect(claude.status).toBe(200)
    expect(sdkCalls).toBe(1)
    const gptOnMessages = await app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-6-luna", max_tokens: 64, messages: [{ role: "user", content: "hi" }] }),
    }))
    expect(gptOnMessages.status).toBe(404)
    expect(upstreamCalls).toHaveLength(0)
  })

  it("serves an unlisted OpenAI model from ChatGPT, never from Claude", async () => {
    writePool([account(0)])
    const { app } = await server("follow-external")
    const res = await app.fetch(responses({ ...LUNA, model: "gpt-5.4-nano" }))
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('"delta":"pong"')
    expect(sdkCalls).toBe(0)
    expect(upstreamCalls.map(call => call.body.model)).toEqual(["gpt-5.4-nano"])
    const [metric] = telemetryStore.getRecent({ limit: 1 })
    expect(metric).toMatchObject({ adapter: "chatgpt", requestModel: "gpt-5.4-nano" })
  })

  it("returns the backend's refusal of a model in OpenAI's error shape, without benching or trying another seat", async () => {
    writePool([account(0), account(1)])
    const detail = "The 'gpt-5.4-nano' model is not supported when using Codex with a ChatGPT account."
    respond = () => new Response(JSON.stringify({ detail }), { status: 400, headers: { "content-type": "application/json" } })
    const { app } = await server("follow-external")
    for (const stream of [false, true]) {
      const res = await app.fetch(responses({ ...LUNA, model: "gpt-5.4-nano", stream }))
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: { type: "invalid_request_error", message: detail, code: null } })
    }
    expect(upstreamCalls.map(call => call.accountId)).toEqual(["workspace-0", "workspace-0"])
    expect(sdkCalls).toBe(0)
    expect(telemetryStore.getRecent({ limit: 2 }).map(m => [m.adapter, m.status, m.error])).toEqual([
      ["chatgpt", 400, "request_refused"], ["chatgpt", 400, "request_refused"],
    ])
  })

  it("passes a refusal already in OpenAI's shape through unchanged", async () => {
    writePool([account(0)])
    const body = JSON.stringify({ error: { type: "invalid_request_error", message: "bad field", code: "unknown_parameter" } })
    respond = () => new Response(body, { status: 400, headers: { "content-type": "application/json" } })
    const { app } = await server("follow-external")
    const res = await app.fetch(responses({ ...LUNA, stream: false }))
    expect(res.status).toBe(400)
    expect(await res.text()).toBe(body)
  })

  it("leaves GPT names on Claude when no ChatGPT source is configured", async () => {
    writePool([account(0)])
    const { app } = await server(undefined)
    const res = await app.fetch(responses({ ...LUNA, stream: false }))
    expect(res.status).toBe(200)
    expect(sdkCalls).toBe(1)
    expect(upstreamCalls).toHaveLength(0)
  })
})

describe("follow-external never refreshes and never writes", () => {
  it("answers expired tokens with an owner-must-refresh error, without a token call or a write", async () => {
    writePool([account(0, { expiresAt: NOW - 1 }), account(1, { expiresAt: NOW + 10_000 })])
    const before = snapshotPoolDir()
    const { app } = await server("follow-external")
    const res = await app.fetch(responses(LUNA))
    expect(res.status).toBe(401)
    const body = await res.json() as { error: { type: string; message: string } }
    expect(body.error.type).toBe("authentication_error")
    expect(body.error.message).toContain("never refreshes")
    expect(tokenCalls).toBe(0)
    expect(upstreamCalls).toHaveLength(0)
    expect(snapshotPoolDir()).toEqual(before)
  })

  it("fails over past a refused token without refreshing it", async () => {
    writePool([account(0), account(1)])
    const before = snapshotPoolDir()
    respond = call => call.authorization === "Bearer at-0" ? refused() : completed()
    const { app } = await server("follow-external")
    const res = await app.fetch(responses(LUNA))
    expect(res.status).toBe(200)
    expect(upstreamCalls.map(c => c.authorization)).toEqual(["Bearer at-0", "Bearer at-1"])
    expect(tokenCalls).toBe(0)
    expect(snapshotPoolDir()).toEqual(before)
  })

  it("re-reads once and retries the same seat when the owner rotated its token", async () => {
    writePool([account(0), account(1)])
    respond = (call, index) => {
      if (index > 0) return completed()
      writePool([account(0, { accessToken: "at-0-rotated-by-owner" }), account(1)])
      utimesSync(poolPath, new Date(), new Date(Date.now() + 5000))
      return refused()
    }
    const { app } = await server("follow-external")
    const res = await app.fetch(responses(LUNA))
    expect(res.status).toBe(200)
    expect(upstreamCalls.map(c => c.authorization)).toEqual(["Bearer at-0", "Bearer at-0-rotated-by-owner"])
    expect(tokenCalls).toBe(0)
  })

  it("returns the owner-must-refresh error when every seat refuses", async () => {
    writePool([account(0), account(1)])
    respond = () => refused()
    const { app } = await server("follow-external")
    const res = await app.fetch(responses(LUNA))
    expect(res.status).toBe(401)
    expect((await res.json() as { error: { message: string } }).error.message).toContain("owner must refresh")
    expect(tokenCalls).toBe(0)
  })

  it("control: owned mode DOES refresh an expired token, and the same spy sees it", async () => {
    const storePath = join(dir, "chatgpt-accounts.json")
    process.env.MERIDIAN_CHATGPT_STORE_PATH = storePath
    writeFileSync(storePath, JSON.stringify({ version: 1, accounts: [{
      accountUserId: "user-0__workspace-0", accountId: "workspace-0", email: null, refreshToken: "rt-0",
      accessToken: "at-0", expiresAt: NOW - 1, tokenRotatedAt: null, exchangeStartedAt: null,
    }] }))
    const proxy = await server("owned")
    await proxy.chatGpt!.acquire()
    try {
      const res = await proxy.app.fetch(responses(LUNA))
      expect(res.status).toBe(200)
      expect(tokenCalls).toBe(1)
      expect(upstreamCalls[0]!.authorization).toBe("Bearer at-refreshed")
    } finally {
      proxy.chatGpt!.release()
    }
  })
})

describe("plugins never touch ChatGPT requests", () => {
  function writeMarkerPlugin() {
    const marker = join(dir, "plugin-ran")
    const path = join(dir, "marker-plugin.mjs")
    writeFileSync(path, `
      import { appendFileSync } from "node:fs"
      export default {
        name: "marker", version: "1.0.0", description: "records every hook call",
        onRequest(ctx) { appendFileSync(${JSON.stringify(marker)}, "onRequest\\n"); return { ...ctx, systemContext: "[SCRUBBED] " + (ctx.systemContext || "") } },
        onResponse(ctx) { appendFileSync(${JSON.stringify(marker)}, "onResponse\\n"); return ctx },
      }
    `)
    return { path, marker }
  }

  it("runs no request plugin for an opencode client on the ChatGPT path", async () => {
    writePool([account(0)])
    const plugin = writeMarkerPlugin()
    const { app } = await server("follow-external", plugin.path)
    const res = await app.fetch(responses(LUNA, { "user-agent": "opencode/1.18.32", "x-opencode-session": "s1" }))
    expect(res.status).toBe(200)
    await res.text()
    expect(existsSync(plugin.marker)).toBe(false)
    expect(upstreamCalls[0]!.body.input).toEqual(LUNA.input)
  })

  it("control: the same plugin does run on the Claude path", async () => {
    writePool([account(0)])
    const plugin = writeMarkerPlugin()
    const { app } = await server("follow-external", plugin.path)
    const res = await app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST", headers: { "content-type": "application/json", "user-agent": "opencode/1.18.32" },
      body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 64, stream: false, system: "sys", messages: [{ role: "user", content: "hi" }] }),
    }))
    expect(res.status).toBe(200)
    expect(readFileSync(plugin.marker, "utf8")).toContain("onRequest")
  })
})

describe("/providers", () => {
  it("shows ChatGPT seats and their state without exposing any token", async () => {
    writePool([account(0), account(1, { enabled: false })])
    const { app } = await server("follow-external")
    await (await app.fetch(responses(LUNA))).text()
    const res = await app.fetch(new Request("http://localhost/providers/status"))
    const text = await res.text()
    const data = JSON.parse(text) as { providers: Array<{ id: string; enabled: boolean; activity?: { requests: number }; accounts: Array<{ id: string; label?: string; error?: string }> }> }
    const chatgpt = data.providers.find(p => p.id === "chatgpt")!
    expect(chatgpt.enabled).toBe(true)
    expect(chatgpt.activity?.requests).toBe(1)
    expect(chatgpt.accounts.map(a => [a.id, a.label, a.error ?? null])).toEqual([
      ["user-0__workspace-0", "seat0@example.test · id:pace-0", null],
      ["user-1__workspace-1", "seat1@example.test · id:pace-1", "Disabled by its credential owner."],
    ])
    expect(text).not.toMatch(/at-0|at-1|rt-0|rt-1/)
    const view = await (await app.fetch(new Request("http://localhost/providers/view?provider=chatgpt"))).text()
    expect(view).toContain("OpenAI subscription")
  })

  it("tells apart one person's seats in different workspaces, on the page and in telemetry", async () => {
    const sameEmail = { email: "shared@example.test" }
    writePool([
      account(0, { ...sameEmail, accountId: "ws-aaaaaa", accountUserId: "user-shared__ws-aaaaaa", accessToken: "at-a" }),
      account(1, { ...sameEmail, accountId: "ws-bbbbbb", accountUserId: "user-shared__ws-bbbbbb", accessToken: "at-b" }),
    ])
    respond = call => call.authorization === "Bearer at-a" ? refused() : completed()
    const { app } = await server("follow-external")
    await (await app.fetch(responses(LUNA))).text()

    const text = await (await app.fetch(new Request("http://localhost/providers/status"))).text()
    const chatgpt = (JSON.parse(text) as { providers: Array<{ id: string; accounts: Array<{ id: string; label?: string }> }> })
      .providers.find(p => p.id === "chatgpt")!
    expect(chatgpt.accounts.map(a => a.id)).toEqual(["user-shared__ws-aaaaaa", "user-shared__ws-bbbbbb"])
    expect(chatgpt.accounts.map(a => a.label)).toEqual(["shared@example.test · id:aaaaaa", "shared@example.test · id:bbbbbb"])
    expect(text).not.toMatch(/at-a|at-b|rt-0|rt-1/)

    const view = await (await app.fetch(new Request("http://localhost/providers/view?provider=chatgpt"))).text()
    expect(view).toContain("shared@example.test · id:aaaaaa")
    expect(view).toContain("shared@example.test · id:bbbbbb")

    const [metric] = telemetryStore.getRecent({ limit: 1 })
    expect(metric!.profileId).toBe("chatgpt:shared@example.test · id:bbbbbb")
  })
})
