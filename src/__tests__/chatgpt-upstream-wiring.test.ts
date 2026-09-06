/**
 * Wiring the ChatGPT backend into the running server.
 *
 * Everything before this was reachable only from a test. This is the commit
 * that lets a real request arrive at chatgpt.com, so the properties worth
 * proving are the ones about instances that must NOT be changed by it.
 *
 * TWO SUCH INSTANCES ARE LIVE ON THIS MACHINE and both own zero ChatGPT
 * accounts: the one holding the operator's Anthropic credentials, which every
 * Claude session here routes through, and the one serving the dashboard. If
 * owning nothing were enough to take a writer lease, or to change what a GPT
 * model name means, this branch would break both the moment it deployed.
 *
 * So ownership decides everything, it is decided once, and an instance that
 * owns nothing has no lease to take and no method with which to take one.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AddressInfo } from "node:net"
import { createProxyServer, startProxyServer } from "../proxy/server"
import { startBackgroundRefresh, stopBackgroundRefresh, type CredentialStore } from "../proxy/tokenRefresh"
import { acquireWriterLease } from "../proxy/chatgpt/lease"
import { createChatGptCredentialStore, type ChatGptAccount } from "../proxy/chatgpt/credentials"
import { chatGptLockPath } from "../proxy/chatgpt/paths"
import type { ProfileConfig } from "../proxy/profiles"
import type { ProxyInstance } from "../proxy/types"

const CODEX_URL = "https://chatgpt.com/backend-api/codex/responses"
const OPENAI_TOKEN_URL = "https://auth.openai.com/oauth/token"
const HOUR_MS = 60 * 60 * 1000

const LEASE_MODULE = join(import.meta.dir, "../proxy/chatgpt/lease.ts")

const scratch = mkdtempSync(join(tmpdir(), "meridian-chatgpt-wiring-"))
const fakeClaude = join(scratch, "claude-stub.sh")
writeFileSync(
  fakeClaude,
  `#!/bin/sh\necho '{"loggedIn":true,"email":"synthetic@example.test","subscriptionType":"max"}'\n`,
)
chmodSync(fakeClaude, 0o755)

const CLAUDE_PROFILE: ProfileConfig = { id: "claude-personal", type: "claude-max" }
const CHATGPT_PROFILE: ProfileConfig = {
  id: "chatgpt-work",
  provider: "openai",
  type: "chatgpt-oauth",
  accountUserId: "user_seat_C0RSu9",
}

function account(overrides: Partial<ChatGptAccount> = {}): ChatGptAccount {
  return {
    accountUserId: "user_seat_C0RSu9",
    accountId: "05cd9f04-1111-2222-3333-444444989a40",
    email: "seat@example.test",
    refreshToken: "refresh-seat",
    accessToken: "access-seat",
    expiresAt: Date.now() + HOUR_MS,
    tokenRotatedAt: null,
    exchangeStartedAt: null,
    ...overrides,
  }
}

/** Reads as "no credentials yet", parking the scheduler off the real store. */
const inertStore: CredentialStore = {
  refreshKey: "chatgpt-wiring-test-inert",
  read: async () => null,
  write: async () => true,
}

interface OutboundCall {
  url: string
  init: Parameters<typeof fetch>[1]
}

const outbound: OutboundCall[] = []
const realFetch = globalThis.fetch
const savedClaudePath = process.env.MERIDIAN_CLAUDE_PATH
const savedStorePath = process.env.MERIDIAN_CHATGPT_STORE_PATH
const savedPoolPath = process.env.MERIDIAN_CODEX_POOL_PATH

let caseCount = 0

/** A store path nobody else in this file touches, so one test cannot seed another. */
function freshStorePath(): string {
  const dir = join(scratch, `case-${++caseCount}`)
  mkdirSync(dir, { recursive: true })
  return join(dir, "chatgpt-accounts.json")
}

async function seed(storePath: string, ...accounts: ChatGptAccount[]): Promise<void> {
  const lease = await acquireWriterLease({
    lockPath: chatGptLockPath(storePath),
    staleMs: 60_000,
    heartbeatMs: 500,
    waitMs: 0,
  })
  const store = createChatGptCredentialStore({ path: storePath, lease })
  for (const entry of accounts) store.commitAccount(entry.accountUserId, () => entry)
  lease.release()
}

function boot(storePath: string, profiles: ProfileConfig[]) {
  process.env.MERIDIAN_CHATGPT_STORE_PATH = storePath
  return createProxyServer({ port: 0, host: "127.0.0.1", silent: true, profiles })
}

function responses(body: unknown): Request {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

function sse(): Response {
  return new Response("event: response.created\ndata: {}\n\n", {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
}

beforeAll(() => {
  process.env.MERIDIAN_CLAUDE_PATH = fakeClaude
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      outbound.push({ url, init })
      if (url === CODEX_URL) return sse()
      if (url === OPENAI_TOKEN_URL) {
        return new Response(
          JSON.stringify({ access_token: "access-rotated", refresh_token: "refresh-rotated", expires_in: 3600 }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }
      // This test's own loopback traffic is the only other thing allowed out.
      if (url.startsWith("http://127.0.0.1:")) return realFetch(input, init)
      return new Response("{}", { status: 500 })
    },
    { preconnect: realFetch.preconnect },
  ) as typeof globalThis.fetch
})

afterEach(() => {
  outbound.length = 0
})

afterAll(() => {
  globalThis.fetch = realFetch
  stopBackgroundRefresh()
  if (savedClaudePath === undefined) delete process.env.MERIDIAN_CLAUDE_PATH
  else process.env.MERIDIAN_CLAUDE_PATH = savedClaudePath
  if (savedStorePath === undefined) delete process.env.MERIDIAN_CHATGPT_STORE_PATH
  else process.env.MERIDIAN_CHATGPT_STORE_PATH = savedStorePath
  if (savedPoolPath === undefined) delete process.env.MERIDIAN_CODEX_POOL_PATH
  else process.env.MERIDIAN_CODEX_POOL_PATH = savedPoolPath
  rmSync(scratch, { recursive: true, force: true })
})

describe("an instance that owns no ChatGPT account", () => {
  it("is not offered a way to take the writer lease at all", () => {
    const storePath = freshStorePath()
    const server = boot(storePath, [CLAUDE_PROFILE])

    // Structural rather than conditional. A guard that must be remembered is
    // a guard that can be forgotten, and the instances this protects hold the
    // operator's real Anthropic credentials.
    expect(server.chatGptUpstream).toBeUndefined()
  })

  it("creates no lock file, so nothing else is told to stand down", async () => {
    const storePath = freshStorePath()
    const server = boot(storePath, [CLAUDE_PROFILE])
    await server.app.fetch(responses({ model: "gpt-5-codex" }))

    expect(existsSync(chatGptLockPath(storePath))).toBe(false)
    expect(readdirSync(join(storePath, ".."))).toEqual([])
  })

  it("reports that GPT names still mean Claude", async () => {
    const server = boot(freshStorePath(), [CLAUDE_PROFILE])
    const res = await server.app.fetch(new Request("http://localhost/health"))
    const body = await res.json() as { status: string; upstream: { gptModels: string; chatgptAccounts: number } }

    expect(["healthy", "degraded", "unhealthy"]).toContain(body.status)
    expect(body.upstream).toEqual({ gptModels: "claude", chatgptAccounts: 0 })
  })

  it("still serves a GPT name through the Claude translation path, unchanged", async () => {
    const server = boot(freshStorePath(), [CLAUDE_PROFILE])
    const res = await server.app.fetch(responses({ model: "gpt-5-codex" }))

    // The translation layer's own refusal, which only exists on the Claude
    // path. Reaching it proves upstream's Codex-CLI-on-Claude feature is
    // untouched for every deployment that owns no ChatGPT account.
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: { type: "invalid_request_error", message: "input: Field required", code: null },
    })
    expect(outbound.filter(call => call.url === CODEX_URL)).toEqual([])
  })
})

describe("an instance that owns an account but holds no lease", () => {
  it("refuses the request rather than quietly borrowing a Claude account", async () => {
    const storePath = freshStorePath()
    await seed(storePath, account())
    const server = boot(storePath, [CLAUDE_PROFILE, CHATGPT_PROFILE])

    const res = await server.app.fetch(responses({ model: "gpt-5-codex" }))
    const body = await res.json() as { error?: { type?: string; message?: string } }

    expect(res.status).toBe(503)
    expect(body.error?.type).toBe("overloaded_error")
    // Emphatically NOT the Claude marker. An owned instance that cannot serve
    // must fail, not fall back - that fallback is the cross-provider mix-up
    // the whole provider split exists to prevent.
    expect(body.error?.message).not.toContain("Field required")
    expect(outbound.filter(call => call.url === CODEX_URL)).toEqual([])
  })

  it("says it cannot serve, rather than advertising ChatGPT", async () => {
    const storePath = freshStorePath()
    await seed(storePath, account())
    const server = boot(storePath, [CLAUDE_PROFILE, CHATGPT_PROFILE])

    const res = await server.app.fetch(new Request("http://localhost/health"))
    const body = await res.json() as { upstream: { gptModels: string; chatgptAccounts: number } }

    // An instance whose report and behaviour disagree is the 2026-09-04
    // outage in miniature: convincing answers from a state nobody can see.
    expect(body.upstream).toEqual({ gptModels: "unavailable", chatgptAccounts: 1 })
  })
})

describe("an instance that owns an account and holds the lease", () => {
  it("sends the request to ChatGPT with this seat's own credentials", async () => {
    const storePath = freshStorePath()
    await seed(storePath, account())
    const server = boot(storePath, [CLAUDE_PROFILE, CHATGPT_PROFILE])
    await server.chatGptUpstream!.acquire()

    try {
      const sent = { model: "gpt-5-codex", input: "hi", prompt_cache_key: "conv-9f04" }
      const res = await server.app.fetch(responses(sent))

      expect(res.status).toBe(200)
      const call = outbound.find(entry => entry.url === CODEX_URL)
      expect(call).toBeDefined()
      const headers = new Headers(call!.init!.headers)
      expect(headers.get("authorization")).toBe("Bearer access-seat")
      expect(headers.get("chatgpt-account-id")).toBe("05cd9f04-1111-2222-3333-444444989a40")
      // The body the client sent, byte for byte. The dispatch seam reads the
      // model out of it first, so this also pins that the peek gives the bytes
      // back rather than a re-serialization of them.
      expect(call!.init!.body).toBe(JSON.stringify(sent))
    } finally {
      server.chatGptUpstream!.release()
    }
  })

  it("reports that GPT names now mean ChatGPT", async () => {
    const storePath = freshStorePath()
    await seed(storePath, account())
    const server = boot(storePath, [CLAUDE_PROFILE, CHATGPT_PROFILE])
    await server.chatGptUpstream!.acquire()

    try {
      const res = await server.app.fetch(new Request("http://localhost/health"))
      const body = await res.json() as { upstream: { gptModels: string; chatgptAccounts: number } }

      expect(body.upstream).toEqual({ gptModels: "chatgpt", chatgptAccounts: 1 })
    } finally {
      server.chatGptUpstream!.release()
    }
  })

  it("leaves Claude models on Claude", async () => {
    const storePath = freshStorePath()
    await seed(storePath, account())
    const server = boot(storePath, [CLAUDE_PROFILE, CHATGPT_PROFILE])
    await server.chatGptUpstream!.acquire()

    try {
      const res = await server.app.fetch(responses({ model: "claude-sonnet-5" }))

      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({
        error: { type: "invalid_request_error", message: "input: Field required", code: null },
      })
      expect(outbound.filter(call => call.url === CODEX_URL)).toEqual([])
    } finally {
      server.chatGptUpstream!.release()
    }
  })

  it("renews an expired access token instead of serving with it", async () => {
    const storePath = freshStorePath()
    await seed(storePath, account({ accessToken: "access-expired", expiresAt: Date.now() - HOUR_MS }))
    const server = boot(storePath, [CLAUDE_PROFILE, CHATGPT_PROFILE])
    await server.chatGptUpstream!.acquire()

    try {
      const res = await server.app.fetch(responses({ model: "gpt-5-codex" }))

      expect(res.status).toBe(200)
      // Without this the instance serves convincingly until the token expires
      // and then stops, which is the failure shape this project already wore
      // for thirteen hours.
      expect(outbound.map(call => call.url)).toContain(OPENAI_TOKEN_URL)
      const call = outbound.find(entry => entry.url === CODEX_URL)
      expect(new Headers(call!.init!.headers).get("authorization")).toBe("Bearer access-rotated")
      // Durably, so a restart does not exchange the spent token again.
      const stored = createChatGptCredentialStore({ path: storePath }).readAccount("user_seat_C0RSu9")
      expect(stored?.refreshToken).toBe("refresh-rotated")
    } finally {
      server.chatGptUpstream!.release()
    }
  })

  it("refuses when the profile names a seat the store has never heard of", async () => {
    const storePath = freshStorePath()
    await seed(storePath, account({ accountUserId: "user_someone_else" }))
    const server = boot(storePath, [CLAUDE_PROFILE, CHATGPT_PROFILE])
    await server.chatGptUpstream!.acquire()

    try {
      const res = await server.app.fetch(responses({ model: "gpt-5-codex" }))

      // The other seat's credentials are RIGHT THERE and would produce a 200.
      // Serving with them would attribute one person's usage to another and
      // spend a token that was never this profile's.
      expect(res.status).toBe(503)
      expect(outbound.filter(call => call.url === CODEX_URL)).toEqual([])
    } finally {
      server.chatGptUpstream!.release()
    }
  })
})

describe("exactly one writer, proven against a real second process", () => {
  it("refuses to start when another process already holds the lease", async () => {
    const storePath = freshStorePath()
    await seed(storePath, account())

    const child = Bun.spawn({
      cmd: [process.execPath, "-e", `
        import { acquireWriterLease } from ${JSON.stringify(LEASE_MODULE)}
        await acquireWriterLease({
          lockPath: ${JSON.stringify(chatGptLockPath(storePath))},
          staleMs: 60000,
          heartbeatMs: 200,
          waitMs: 0,
        })
        console.log("HELD")
        setInterval(() => {}, 1000)
      `],
      stdout: "pipe",
      stderr: "pipe",
    })

    const reader = child.stdout.getReader()
    const decoder = new TextDecoder()
    let seen = ""
    while (!seen.includes("HELD")) {
      const { done, value } = await reader.read()
      if (done) break
      seen += decoder.decode(value, { stream: true })
    }
    expect(seen).toContain("HELD")

    try {
      const server = boot(storePath, [CLAUDE_PROFILE, CHATGPT_PROFILE])
      // Fail, not degrade. A second Meridian that started anyway would be a
      // second writer of single-use tokens, which is unrecoverable.
      await expect(server.chatGptUpstream!.acquire()).rejects.toThrow()
    } finally {
      child.kill("SIGKILL")
      await child.exited
    }
  })
})

describe("the plugin's pool is never opened for write", () => {
  it("leaves it byte-identical, and works while it is read-only", async () => {
    const poolPath = join(scratch, "oc-codex-multi-auth-accounts.json")
    writeFileSync(poolPath, JSON.stringify({ version: 3, accounts: [], activeIndex: 0 }), { mode: 0o600 })
    chmodSync(poolPath, 0o400)
    process.env.MERIDIAN_CODEX_POOL_PATH = poolPath
    const before = {
      sha256: createHash("sha256").update(readFileSync(poolPath)).digest("hex"),
      mtimeMs: statSync(poolPath).mtimeMs,
      mode: statSync(poolPath).mode & 0o777,
    }

    const storePath = freshStorePath()
    await seed(storePath, account())
    const server = boot(storePath, [CLAUDE_PROFILE, CHATGPT_PROFILE])
    await server.chatGptUpstream!.acquire()

    try {
      await server.app.fetch(responses({ model: "gpt-5-codex" }))
    } finally {
      server.chatGptUpstream!.release()
    }

    expect({
      sha256: createHash("sha256").update(readFileSync(poolPath)).digest("hex"),
      mtimeMs: statSync(poolPath).mtimeMs,
      mode: statSync(poolPath).mode & 0o777,
    }).toEqual(before)
  })
})

describe("the owned lifecycle", () => {
  it("boots an unowned instance without a lease and shuts it down cleanly", async () => {
    const storePath = freshStorePath()
    process.env.MERIDIAN_CHATGPT_STORE_PATH = storePath
    startBackgroundRefresh(inertStore)

    const instance: ProxyInstance = await startProxyServer({
      port: 0,
      host: "127.0.0.1",
      silent: true,
      profiles: [CLAUDE_PROFILE],
    })
    const base = `http://127.0.0.1:${(instance.server.address() as AddressInfo).port}`

    try {
      const health = await realFetch(`${base}/health`)
      const body = await health.json() as { status: string; upstream: { gptModels: string } }

      expect(["healthy", "degraded", "unhealthy"]).toContain(body.status)
      expect(body.upstream.gptModels).toBe("claude")
      expect(existsSync(chatGptLockPath(storePath))).toBe(false)
    } finally {
      await instance.close()
    }
  }, 30_000)

  it("takes the lease for an owned instance and releases it on close", async () => {
    const storePath = freshStorePath()
    await seed(storePath, account())
    process.env.MERIDIAN_CHATGPT_STORE_PATH = storePath
    startBackgroundRefresh(inertStore)

    const instance: ProxyInstance = await startProxyServer({
      port: 0,
      host: "127.0.0.1",
      silent: true,
      profiles: [CLAUDE_PROFILE, CHATGPT_PROFILE],
    })

    try {
      expect(existsSync(chatGptLockPath(storePath))).toBe(true)
    } finally {
      await instance.close()
    }

    // Released rather than left for the stale-reclaim path: a lock outliving
    // its process makes the next start wait for a timeout it did not need to.
    expect(existsSync(chatGptLockPath(storePath))).toBe(false)
  }, 30_000)
})
