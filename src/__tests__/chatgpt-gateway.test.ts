/**
 * The ChatGPT gateway end to end over HTTP, with chatgpt.com mocked.
 *
 * Every guarantee here is paired with a control that proves the check can
 * fail: the never-refresh assertions against owned mode, where a refresh does
 * happen and the same spy sees it; the no-plugin assertions against the
 * Claude path, where the same plugin does run.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { assistantMessage, resolveMockSdkSessionId } from "./helpers"
import { CHATGPT_MODELS } from "../proxy/upstream/provider"

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
const { __setFetchOAuthUsageOverride, resetOAuthUsageCache } = await import("../proxy/oauthUsage")
const { saveSettings } = await import("../settings")
const { resetCodexUsageCache } = await import("../proxy/codex/service")
const { __setChatGptLoginListenOverride } = await import("../proxy/chatgpt/login")

const NOW = Date.now()
const CODEX_URL = "https://chatgpt.com/backend-api/codex/responses"
const TOKEN_URL = "https://auth.openai.com/oauth/token"

interface UpstreamCall { url: string; authorization: string | null; accountId: string | null; body: Record<string, unknown> }
let upstreamCalls: UpstreamCall[] = []
let tokenCalls = 0
let respond: (call: UpstreamCall, index: number) => Response | Promise<Response> = () => completed()
const CATALOG_URL = "https://chatgpt.com/backend-api/codex/models"
let catalogCalls: Array<{ authorization: string | null }> = []
let catalog: () => Response = () => new Response("{}", { status: 503 })
const WHAM_PREFIX = "https://chatgpt.com/backend-api/wham/"
let whamCalls: Array<{ url: string; method: string; authorization: string | null }> = []
let wham: (url: string, authorization: string | null) => Response | undefined = () => undefined
const realFetch = globalThis.fetch

function completed(text = "pong", extraHeaders: Record<string, string> = {}): Response {
  const events = [
    { type: "response.created", response: { id: "r1", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { type: "message" } },
    { type: "response.output_text.delta", delta: text },
    { type: "response.output_item.done", output_index: 0, item: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } },
    { type: "response.completed", response: { id: "r1", model: "gpt-6-luna", output: [], usage: { input_tokens: 50, input_tokens_details: { cached_tokens: 10 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 2 } } } },
  ]
  return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream", "set-cookie": "must-not-leak=1", ...extraHeaders },
  })
}

/** `x-codex-*` window headers as the backend states them: width in minutes, reset in epoch seconds. */
function codexWindows(windows: Array<{ minutes: number; used: number; resetInS: number }>): Record<string, string> {
  const headers: Record<string, string> = {}
  windows.forEach((w, i) => {
    const position = i === 0 ? "primary" : "secondary"
    headers[`x-codex-${position}-window-minutes`] = String(w.minutes)
    headers[`x-codex-${position}-used-percent`] = String(w.used)
    headers[`x-codex-${position}-reset-at`] = String(Math.floor(Date.now() / 1000) + w.resetInS)
  })
  return headers
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
  if (url.startsWith(`${CATALOG_URL}?`)) {
    catalogCalls.push({ authorization: new Headers(init?.headers).get("authorization") })
    return Promise.resolve(catalog())
  }
  if (url.startsWith(WHAM_PREFIX)) {
    const authorization = new Headers(init?.headers).get("authorization")
    whamCalls.push({ url, method: init?.method ?? "GET", authorization })
    const answer = wham(url, authorization)
    if (answer) return Promise.resolve(answer)
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
  catalogCalls = []
  catalog = () => new Response("{}", { status: 503 })
  whamCalls = []
  wham = () => undefined
  globalThis.fetch = mockFetch as typeof fetch
  telemetryStore.clear()
  clearSessionCache()
  __setFetchOAuthUsageOverride(async () => null)
  // Another suite in the same process may have switched usage reads off, or
  // left a Claude `default` reading cached.
  resetOAuthUsageCache()
  saveSettings({ integrations: undefined })
})
afterEach(() => {
  __setFetchOAuthUsageOverride(null)
  saveSettings({
    chatGptActiveSeat: undefined, chatGptProfileNames: undefined, chatGptProfileAliases: undefined, profileOrder: undefined,
    routingExcludedProfiles: undefined, routingManagedExcludedProfiles: undefined,
  })
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
    expect(metric!.profileId).toBe("shared-bbbbbb")
  })
})

describe("offered models follow the backend's catalog", () => {
  const catalogBody = {
    models: [
      { slug: "gpt-6-luna", visibility: "list", display_name: "GPT-6-Luna", context_window: 272000, available_in_plans: ["pro"] },
      { slug: "gpt-daybreak-red-latest", visibility: "hide", available_in_plans: ["pro"] },
      { slug: "gpt-team-only", visibility: "list", available_in_plans: ["team"] },
    ],
  }
  const openAiIds = async (app: { fetch: (request: Request) => Response | Promise<Response> }) => {
    const res = await app.fetch(new Request("http://localhost/v1/models"))
    expect(res.status).toBe(200)
    const body = await res.json() as { data: Array<{ id: string; owned_by: string; context_window: number }> }
    expect(body.data.some(model => model.owned_by === "anthropic")).toBe(true)
    return body.data.filter(model => model.owned_by === "openai")
  }
  const providerModels = async (app: { fetch: (request: Request) => Response | Promise<Response> }) => {
    const data = await (await app.fetch(new Request("http://localhost/providers/status"))).json() as { providers: Array<{ id: string; models: string[]; capabilities?: Array<{ name: string; status: string }> }> }
    return data.providers.find(p => p.id === "chatgpt")!
  }

  it("offers the listed models of the seats' plans on /v1/models and /providers, and still routes the rest", async () => {
    writePool([account(0, { planType: "pro" })])
    catalog = () => new Response(JSON.stringify(catalogBody), { status: 200, headers: { "content-type": "application/json" } })
    const { app } = await server("follow-external")
    const offered = await openAiIds(app)
    expect(offered.map(model => [model.id, model.context_window])).toEqual([["gpt-6-luna", 272000]])
    expect(catalogCalls).toEqual([{ authorization: "Bearer at-0" }])
    const provider = await providerModels(app)
    expect(provider.models).toEqual(["gpt-6-luna"])
    expect(provider.capabilities?.find(row => row.name === "Models")?.status).toBe("catalog")

    const res = await app.fetch(responses({ ...LUNA, model: "gpt-team-only" }))
    expect(res.status).toBe(200)
    expect(upstreamCalls.map(call => call.body.model)).toEqual(["gpt-team-only"])
    expect(sdkCalls).toBe(0)
  })

  it("offers the built-in list while the catalog cannot be read", async () => {
    writePool([account(0, { planType: "pro" })])
    const { app } = await server("follow-external")
    expect((await openAiIds(app)).map(model => model.id)).toEqual([...CHATGPT_MODELS])
    expect((await providerModels(app)).capabilities?.find(row => row.name === "Models")?.status).toBe("built-in")
  })

  it("offers no ChatGPT model when the gateway is off", async () => {
    writePool([account(0)])
    const { app } = await server("off")
    expect(await openAiIds(app)).toEqual([])
    expect(catalogCalls).toEqual([])
  })

  it("control: owned mode never refreshes a token near expiry to read the catalog", async () => {
    const storePath = join(dir, "chatgpt-accounts.json")
    process.env.MERIDIAN_CHATGPT_STORE_PATH = storePath
    writeFileSync(storePath, JSON.stringify({ version: 1, accounts: [{
      accountUserId: "user-0__workspace-0", accountId: "workspace-0", email: null, refreshToken: "rt-0",
      accessToken: "at-0", expiresAt: Date.now() + 60_000, tokenRotatedAt: null, exchangeStartedAt: null,
    }] }))
    catalog = () => new Response(JSON.stringify(catalogBody), { status: 200, headers: { "content-type": "application/json" } })
    const proxy = await server("owned")
    await proxy.chatGpt!.acquire()
    try {
      expect((await openAiIds(proxy.app)).map(model => model.id)).toEqual([...CHATGPT_MODELS])
      expect(tokenCalls).toBe(0)
      expect(catalogCalls).toEqual([])
      const res = await proxy.app.fetch(responses(LUNA))
      expect(res.status).toBe(200)
      expect(tokenCalls).toBe(1)
    } finally {
      proxy.chatGpt!.release()
    }
  })
})

describe("ChatGPT seats on the profile surface", () => {
  type ListBody = { profiles: Array<Record<string, unknown>>; activeProfile: string | null; activeProfiles?: { claude: string | null; chatgpt: string | null } }
  type QuotaBody = { profiles: Array<{ id: string; type: string; isActive: boolean; windows: Array<{ type: string; utilization: number | null; resetsAt: number | null }>; windowsReported: string[] | null; windowSource: string | null; error: string | null; spent: unknown }>; activeProfile: string | null; activeProfiles?: { chatgpt: string | null } }
  type App = { fetch: (r: Request) => Response | Promise<Response> }
  const get = async <T>(app: App, path: string) => {
    const res = await app.fetch(new Request(`http://localhost${path}`))
    const text = await res.text()
    expect(text).not.toMatch(/"at-\d|"rt-\d/)
    return JSON.parse(text) as T
  }
  const post = (app: App, path: string, body?: unknown) =>
    app.fetch(new Request(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }))
  const rateLimited = (headers: Record<string, string>) =>
    new Response(JSON.stringify({ detail: "usage limit" }), { status: 429, headers: { "content-type": "application/json", ...headers } })

  it("lists each seat as a chatgpt profile with its plan weight, and no dead default", async () => {
    writePool([account(0, { planType: "pro" }), account(1, { planType: "self_serve_business_prolite" }), account(2, { expiresAt: NOW - 1 })])
    const { app } = await server("follow-external")
    const list = await get<ListBody>(app, "/profiles/list")
    expect(list.profiles.map(p => [p.id, p.type, p.provider, p.allowanceWeight, p.loggedIn, p.isActive])).toEqual([
      ["seat0-pace-0", "chatgpt", "chatgpt", 20, true, true],
      ["seat1-pace-1", "chatgpt", "chatgpt", 5, true, false],
      ["seat2-pace-2", "chatgpt", "chatgpt", null, false, false],
    ])
    expect(list.profiles[0]).toMatchObject({ subscriptionType: "pro", planLabel: "ChatGPT Pro", seat: "user-0__workspace-0", label: "seat0@example.test · id:pace-0" })
    expect(list.activeProfile).toBe("seat0-pace-0")
    expect(list.activeProfiles).toEqual({ claude: null, chatgpt: "seat0-pace-0" })

    const quota = await get<QuotaBody>(app, "/v1/usage/quota/all")
    expect(quota.profiles.map(p => [p.id, p.type, p.windowsReported, p.error])).toEqual([
      ["seat0-pace-0", "chatgpt", null, "invalid_token"],
      ["seat1-pace-1", "chatgpt", null, "invalid_token"],
      ["seat2-pace-2", "chatgpt", null, "token_expired"],
    ])
    expect(quota.activeProfile).toBe("seat0-pace-0")
  })

  it("reports the windows each seat's backend states: weekly-only has no five_hour, a cold window has no reset", async () => {
    writePool([account(0), account(1)])
    respond = call => call.accountId === "workspace-0"
      ? completed("pong", codexWindows([{ minutes: 10080, used: 67, resetInS: 3 * 86400 }]))
      : completed("pong", codexWindows([{ minutes: 300, used: 0, resetInS: 18000 }, { minutes: 10080, used: 37, resetInS: 5 * 86400 }]))
    const { app } = await server("follow-external")
    await (await app.fetch(responses(LUNA, { "x-meridian-profile": "seat0-pace-0" }))).text()
    await (await app.fetch(responses(LUNA, { "x-meridian-profile": "seat1-pace-1" }))).text()
    expect(upstreamCalls.map(c => c.accountId)).toEqual(["workspace-0", "workspace-1"])

    const quota = await get<QuotaBody>(app, "/v1/usage/quota/all")
    const [weekly, both] = quota.profiles
    expect(weekly!.windowsReported).toEqual(["seven_day"])
    expect(weekly!.windows.map(w => w.type)).toEqual(["seven_day"])
    expect(weekly!.windows[0]!.utilization).toBe(0.67)
    expect(weekly!.windows[0]!.resetsAt).toBeGreaterThan(Date.now())
    expect(weekly!.windowSource).toBe("headers")
    expect(weekly!.error).toBeNull()
    expect(both!.windowsReported).toEqual(["five_hour", "seven_day"])
    expect(both!.windows[0]).toEqual({ type: "five_hour", utilization: 0, resetsAt: null })
    expect(both!.windows[1]!.utilization).toBe(0.37)
  })

  it("routes unpinned turns to the active seat, refuses an excluded one, persists the pointer", async () => {
    writePool([account(0), account(1), account(2)])
    const { app } = await server("follow-external")
    const switched = await post(app, "/profiles/active", { profile: "seat1-pace-1" })
    expect(switched.status).toBe(200)
    expect(await switched.json()).toEqual({ success: true, activeProfile: "seat1-pace-1", provider: "chatgpt" })
    await (await app.fetch(responses(LUNA))).text()
    expect(upstreamCalls.map(c => c.accountId)).toEqual(["workspace-1"])
    expect((await get<ListBody>(app, "/profiles/list")).activeProfile).toBe("seat1-pace-1")

    // The raw seat id is accepted too, and the pointer survives a new instance.
    expect((await post(app, "/profiles/active", { profile: "user-2__workspace-2" })).status).toBe(200)
    const { app: restarted } = await server("follow-external")
    expect((await get<QuotaBody>(restarted, "/v1/usage/quota/all")).activeProfiles?.chatgpt).toBe("seat2-pace-2")

    saveSettings({ routingManagedExcludedProfiles: ["seat0-pace-0"] })
    expect((await post(app, "/profiles/active", { profile: "seat0-pace-0" })).status).toBe(409)
    expect((await post(app, "/profiles/active", { profile: "nobody" })).status).toBe(400)
    const pinned = await app.fetch(responses(LUNA, { "x-meridian-profile": "seat0-pace-0" }))
    expect(pinned.status).toBe(409)
    expect(upstreamCalls.map(c => c.accountId)).toEqual(["workspace-1"])
  })

  it("never serves unpinned work from an excluded seat, even when the others refuse", async () => {
    writePool([account(0), account(1)])
    saveSettings({ routingExcludedProfiles: ["seat0-pace-0"] })
    respond = () => rateLimited(codexWindows([{ minutes: 10080, used: 100, resetInS: 86400 }]))
    const { app } = await server("follow-external")
    const res = await app.fetch(responses(LUNA))
    expect(res.status).toBe(429)
    expect(upstreamCalls.map(c => c.accountId)).toEqual(["workspace-1"])
  })

  it("warms a seat with the smallest real request, on that seat only, without refreshing or writing", async () => {
    writePool([account(0), account(1)])
    saveSettings({ routingManagedExcludedProfiles: ["seat1-pace-1"] })
    const before = snapshotPoolDir()
    const { app } = await server("follow-external")
    const res = await post(app, "/profiles/seat1-pace-1/warm")
    expect(res.status).toBe(200)
    await res.text()
    expect(upstreamCalls).toHaveLength(1)
    expect(upstreamCalls[0]!.authorization).toBe("Bearer at-1")
    expect(upstreamCalls[0]!.body).toMatchObject({ model: "gpt-6-luna", store: false, reasoning: { effort: "low" } })
    expect(upstreamCalls[0]!.body).not.toHaveProperty("max_output_tokens")
    expect(telemetryStore.getRecent({ limit: 1 })[0]).toMatchObject({ adapter: "chatgpt", requestSource: "warm", profileId: "seat1-pace-1" })
    expect(tokenCalls).toBe(0)
    expect(snapshotPoolDir()).toEqual(before)
    expect((await post(app, "/profiles/nobody/warm")).status).toBe(404)
  })

  it("falls back to the next warm model when the seat refuses the first as a request", async () => {
    writePool([account(0)])
    respond = call => call.body.model === "gpt-6-luna"
      ? new Response(JSON.stringify({ detail: "The 'gpt-6-luna' model is not supported" }), { status: 400, headers: { "content-type": "application/json" } })
      : completed()
    const { app } = await server("follow-external")
    const res = await post(app, "/profiles/seat0-pace-0/warm")
    expect(res.status).toBe(200)
    expect(upstreamCalls.map(c => c.body.model)).toEqual(["gpt-6-luna", "gpt-5.6-luna"])
  })

  it("publishes refusals, failovers and pool exhaustion to the events ring and spent", async () => {
    writePool([account(0), account(1)])
    const before = snapshotPoolDir()
    respond = call => call.accountId === "workspace-0"
      ? rateLimited(codexWindows([{ minutes: 300, used: 40, resetInS: 3600 }, { minutes: 10080, used: 100, resetInS: 2 * 86400 }]))
      : completed()
    const { app } = await server("follow-external")
    expect((await app.fetch(responses(LUNA))).status).toBe(200)

    type Events = { events: Array<{ kind: string; profile: string; servedBy: string | null; reason: string; provider?: string; until: number | null; limit: { bucket: string | null; source: string; reported: boolean } | null }>; nextSince: number }
    const page = await get<Events>(app, "/profiles/events?since=0")
    expect(page.events.map(e => [e.kind, e.profile, e.servedBy, e.reason, e.provider])).toEqual([
      ["refused", "seat0-pace-0", null, "rate_limit_error", "chatgpt"],
      ["failover", "seat0-pace-0", "seat1-pace-1", "rate_limit_error", "chatgpt"],
    ])
    expect(page.events[0]!.limit).toMatchObject({ bucket: "seven_day", source: "response_headers", reported: true })
    expect(page.events[0]!.until).toBeGreaterThan(Date.now() + 86400_000)
    const quota = await get<QuotaBody>(app, "/v1/usage/quota/all")
    expect(quota.profiles.find(p => p.id === "seat0-pace-0")!.spent).toMatchObject({ profileId: "seat0-pace-0" })

    respond = () => refused()
    await (await app.fetch(responses(LUNA, { "x-meridian-profile": "seat1-pace-1" }))).text()
    const next = await get<Events>(app, `/profiles/events?since=${page.nextSince}`)
    expect(next.events.map(e => [e.kind, e.profile, e.reason])).toEqual([
      ["refused", "seat1-pace-1", "authentication_error"],
      ["pool_exhausted", "seat1-pace-1", "authentication_error"],
    ])
    expect(tokenCalls).toBe(0)
    expect(snapshotPoolDir()).toEqual(before)
  })

  /** An access token shaped like the real one, so the usage reader will use it. */
  const seatToken = (n: number, expSeconds = Math.floor(NOW / 1000) + 3600) => {
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
    return `${part({ alg: "RS256" })}.${part({
      exp: expSeconds,
      "https://api.openai.com/auth": {
        chatgpt_account_id: `workspace-${n}`, chatgpt_account_user_id: `user-${n}__workspace-${n}`,
        chatgpt_user_id: `user-${n}`, chatgpt_plan_type: "pro",
      },
    })}.sig`
  }

  it("states each seat's banked resets and workspace from what oc-codex-multi-auth reads, never refreshing a token to read them", async () => {
    resetCodexUsageCache()
    const live = seatToken(0)
    const expired = seatToken(1, Math.floor(NOW / 1000) - 60)
    writePool([account(0, { accessToken: live, planType: "pro" }), account(1, { accessToken: expired, expiresAt: NOW - 60_000 })])
    const soon = NOW + 3 * 86_400_000 + 3_600_000
    const later = NOW + 11 * 86_400_000 + 3_600_000
    wham = (url, authorization) => {
      if (authorization !== `Bearer ${live}`) return new Response("{}", { status: 401 })
      if (url.endsWith("/wham/usage")) {
        return Response.json({
          user_id: "user-0", account_id: "workspace-0", email: "seat0@example.test", plan_type: "pro",
          rate_limit: { primary_window: { used_percent: 40, limit_window_seconds: 604_800, reset_at: Math.floor(NOW / 1000) + 3 * 86_400 }, secondary_window: null },
          rate_limit_reset_credits: { available_count: 2, applicable_available_count: 0 },
        })
      }
      if (url.endsWith("/wham/accounts/check")) {
        return Response.json({ accounts: [{ id: "workspace-0", structure: "workspace", name: "Acme Workspace" }] })
      }
      if (url.endsWith("/wham/rate-limit-reset-credits")) {
        return Response.json({
          available_count: 2,
          credits: [
            { id: "c-later", status: "available", expires_at: new Date(later).toISOString() },
            { id: "c-spent", status: "redeemed", expires_at: new Date(soon).toISOString() },
            { id: "c-soon", status: "available", expires_at: new Date(soon).toISOString() },
          ],
        })
      }
      return undefined
    }
    const before = snapshotPoolDir()
    const { app } = await server("follow-external")
    await get<QuotaBody>(app, "/v1/usage/quota/all")
    const list = await get<ListBody>(app, "/profiles/list")
    expect(JSON.stringify(list)).not.toContain(live)
    expect(JSON.stringify(list)).not.toContain(expired)
    expect(list.profiles[0]).toMatchObject({ id: "seat0-pace-0", loggedIn: true, tokenState: "ok", organizationName: "Acme Workspace", resets: { available: 2, expiresAt: [soon, later] } })
    // No valid token, so nothing was asked: the card says "unknown".
    expect(list.profiles[1]).toMatchObject({ id: "seat1-pace-1", loggedIn: false, tokenState: "expired", organizationName: null, resets: null })
    expect(whamCalls.map(c => c.url.slice(WHAM_PREFIX.length)).sort()).toEqual(["accounts/check", "rate-limit-reset-credits", "usage"])
    expect(whamCalls.every(c => c.method === "GET" && c.authorization === `Bearer ${live}`)).toBe(true)
    expect(tokenCalls).toBe(0)
    expect(snapshotPoolDir()).toEqual(before)
  })

  it("renames a seat the way a Claude profile is renamed: the old name keeps answering", async () => {
    writePool([account(0), account(1)])
    const before = snapshotPoolDir()
    const { app } = await server("follow-external")
    const renamed = await post(app, "/profiles/rename", { from: "seat0-pace-0", to: "enrique-pro" })
    expect(renamed.status).toBe(200)
    expect(await renamed.json()).toEqual({ success: true, from: "seat0-pace-0", to: "enrique-pro", aliases: ["seat0-pace-0"], provider: "chatgpt" })
    const list = await get<ListBody>(app, "/profiles/list")
    expect(list.profiles.map(p => [p.id, p.aliases ?? null])).toEqual([["enrique-pro", ["seat0-pace-0"]], ["seat1-pace-1", null]])

    // The former id still selects the seat and pins a request to it.
    expect(await (await post(app, "/profiles/active", { profile: "seat0-pace-0" })).json()).toEqual({ success: true, activeProfile: "enrique-pro", provider: "chatgpt" })
    await (await app.fetch(responses(LUNA, { "x-meridian-profile": "seat0-pace-0" }))).text()
    expect(upstreamCalls.map(c => c.accountId)).toEqual(["workspace-0"])
    expect(telemetryStore.getRecent({ limit: 1 })[0]).toMatchObject({ adapter: "chatgpt", profileId: "enrique-pro" })

    expect((await post(app, "/profiles/rename", { from: "enrique-pro", to: "seat1-pace-1" })).status).toBe(400)
    expect((await post(app, "/profiles/rename", { from: "enrique-pro", to: "Enrique Pro" })).status).toBe(400)
    // A name is Meridian's setting: the owner's store is not touched.
    expect(snapshotPoolDir()).toEqual(before)
    expect(tokenCalls).toBe(0)
  })

  it("answers a remove of a followed seat with where to remove it, and removes nothing", async () => {
    writePool([account(0), account(1)])
    const before = snapshotPoolDir()
    const { app } = await server("follow-external")
    const res = await post(app, "/profiles/remove", { profile: "seat1-pace-1" })
    expect(res.status).toBe(409)
    const body = await res.json() as { error: string; code: string; provider: string }
    expect(body).toMatchObject({ code: "owned_elsewhere", provider: "chatgpt" })
    expect(body.error).toContain("oc-codex-multi-auth owns")
    expect(body.error).toContain("codex-remove index=2 confirm=true")
    expect((await get<ListBody>(app, "/profiles/list")).profiles.map(p => p.id)).toEqual(["seat0-pace-0", "seat1-pace-1"])
    expect(snapshotPoolDir()).toEqual(before)
  })

  it("says who owns the seats' logins, and keeps a Claude profile off a seat's name", async () => {
    writePool([account(0)])
    const { app } = await server("follow-external")
    const list = await get<ListBody & { chatgpt?: { owner: Record<string, unknown> } }>(app, "/profiles/list")
    expect(list.chatgpt?.owner).toMatchObject({ name: "oc-codex-multi-auth", mode: "follow-external", login: "opencode auth login" })
    expect(list.profiles[0]).toMatchObject({ owner: { account: 1, remove: "codex-remove index=1 confirm=true" } })
    expect((await post(app, "/profiles/add/start", { profile: "seat0-pace-0" })).status).toBe(400)
  })

  it("fails over in the order saved on the Profiles page, after the active seat", async () => {
    writePool([account(0), account(1), account(2)])
    const { app } = await server("follow-external")
    const saved = await app.fetch(new Request("http://localhost/settings/api/routing", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profileOrder: ["seat2-pace-2", "seat1-pace-1", "seat0-pace-0"] }),
    }))
    expect(saved.status).toBe(200)
    const routing = await get<{ profiles: string[]; profileOrder: string[] }>(app, "/settings/api/routing")
    expect(routing.profiles).toEqual(["seat0-pace-0", "seat1-pace-1", "seat2-pace-2"])
    expect(routing.profileOrder).toEqual(["seat2-pace-2", "seat1-pace-1", "seat0-pace-0"])

    respond = call => call.accountId === "workspace-0"
      ? rateLimited(codexWindows([{ minutes: 10080, used: 100, resetInS: 86400 }]))
      : completed()
    const res = await app.fetch(responses(LUNA))
    expect(res.status).toBe(200)
    await res.text()
    // The owner's pick (seat 0) leads; the saved order, not the store's, follows.
    expect(upstreamCalls.map(c => c.accountId)).toEqual(["workspace-0", "workspace-2"])
  })
})

describe("owned mode signs its own seats in", () => {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
  const signedIn = `${part({ alg: "none" })}.${part({
    exp: Math.floor(NOW / 1000) + 3600,
    email: "fresh@example.test",
    "https://api.openai.com/auth": { chatgpt_account_id: "workspace-9", chatgpt_account_user_id: "user-9__workspace-9" },
  })}.sig`
  const post = (app: { fetch: (r: Request) => Response | Promise<Response> }, path: string, body: unknown) =>
    app.fetch(new Request(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }))

  let storeDir: string
  let storePath: string
  let codeExchanges = 0
  beforeEach(() => {
    storeDir = join(dir, "meridian-gpt")
    storePath = join(storeDir, "chatgpt-accounts.json")
    process.env.MERIDIAN_CHATGPT_STORE_PATH = storePath
    codeExchanges = 0
    __setChatGptLoginListenOverride(async () => null)
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url === TOKEN_URL && new URLSearchParams(String(init?.body)).get("grant_type") === "authorization_code") {
        codeExchanges++
        return new Response(JSON.stringify({ access_token: signedIn, refresh_token: "rt-signed-in", id_token: signedIn, expires_in: 3600 }), { status: 200, headers: { "content-type": "application/json" } })
      }
      return mockFetch(input, init)
    }) as typeof fetch
  })
  afterEach(() => { __setChatGptLoginListenOverride(null) })

  it("starts with an empty store, takes the lease, and tells a GPT client to connect an account", async () => {
    const proxy = await server("owned")
    await proxy.chatGpt!.acquire()
    try {
      expect(existsSync(`${storePath}.lock`)).toBe(true)
      const res = await proxy.app.fetch(responses(LUNA))
      expect(res.status).toBe(401)
      const body = await res.json() as { error: { type: string; message: string } }
      expect(body.error.type).toBe("authentication_error")
      expect(body.error.message).toContain("No ChatGPT account is connected")
      expect(body.error.message).toContain("/profiles")
      expect(upstreamCalls).toHaveLength(0)
      expect(sdkCalls).toBe(0)
      expect(existsSync(storePath)).toBe(false)
    } finally {
      proxy.chatGpt!.release()
    }
  })

  it("signs a seat in from the web UI into a private store, then serves and renews it", async () => {
    const proxy = await server("owned")
    await proxy.chatGpt!.acquire()
    try {
      const list = await (await proxy.app.fetch(new Request("http://localhost/profiles/list"))).json() as { chatgpt: { owner: Record<string, unknown> } }
      expect(list.chatgpt.owner).toMatchObject({ name: "meridian", mode: "owned", webSignIn: true })

      const started = await (await post(proxy.app, "/profiles/chatgpt/connect/start", { returnTo: "https://meridian.example/profiles" })).json() as { connectId: string; authorizeUrl: string; loopback: boolean }
      expect(started.loopback).toBe(false)
      const state = new URL(started.authorizeUrl).searchParams.get("state")
      const done = await post(proxy.app, "/profiles/chatgpt/connect/complete", {
        connectId: started.connectId, url: `http://localhost:1455/auth/callback?code=one-time&state=${state}`,
      })
      const doneText = await done.text()
      expect(done.status).toBe(200)
      expect(doneText).not.toContain("rt-signed-in")
      expect(JSON.parse(doneText)).toEqual({ success: true, seat: "user-9__workspace-9", email: "fresh@example.test" })
      expect(codeExchanges).toBe(1)

      const status = await (await proxy.app.fetch(new Request(`http://localhost/profiles/chatgpt/connect/status?connectId=${started.connectId}`))).json()
      expect(status).toMatchObject({ status: "completed", accountUserId: "user-9__workspace-9" })

      expect(statSync(storeDir).mode & 0o777).toBe(0o700)
      expect(statSync(storePath).mode & 0o777).toBe(0o600)
      const stored = JSON.parse(readFileSync(storePath, "utf8")) as { accounts: Array<Record<string, unknown>> }
      expect(stored.accounts.map(a => [a.accountUserId, a.accountId, a.email, a.exchangeStartedAt])).toEqual([["user-9__workspace-9", "workspace-9", "fresh@example.test", null]])

      const served = await proxy.app.fetch(responses(LUNA))
      expect(served.status).toBe(200)
      await served.text()
      expect(upstreamCalls.at(-1)).toMatchObject({ authorization: `Bearer ${signedIn}`, accountId: "workspace-9" })
      expect(tokenCalls).toBe(0)

      const profiles = await (await proxy.app.fetch(new Request("http://localhost/profiles/list"))).json() as { profiles: Array<{ id: string; seat?: string }> }
      const seat = profiles.profiles.find(p => p.seat === "user-9__workspace-9")!
      const renewed = await post(proxy.app, "/profiles/chatgpt/refresh", { profile: seat.id })
      expect(renewed.status).toBe(200)
      expect(await renewed.json()).toMatchObject({ status: "refreshed", profile: seat.id })
      expect(tokenCalls).toBe(1)
      const rotated = JSON.parse(readFileSync(storePath, "utf8")) as { accounts: Array<Record<string, unknown>> }
      expect(rotated.accounts[0]).toMatchObject({ refreshToken: "rt-rotated", accessToken: "at-refreshed", exchangeStartedAt: null })
    } finally {
      proxy.chatGpt!.release()
    }
  })

  it("refuses to sign a seat in where it follows another tool's store", async () => {
    writePool([account(0)])
    const proxy = await server("follow-external")
    const res = await post(proxy.app, "/profiles/chatgpt/connect/start", {})
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: "chatgpt_signin_unavailable" })
    expect(codeExchanges).toBe(0)
  })
})
