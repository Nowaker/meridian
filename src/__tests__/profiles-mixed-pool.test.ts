/**
 * Task 3 addendum — a pool holding BOTH an Anthropic and a ChatGPT account
 * must not poison the Anthropic machinery.
 *
 * Four all-profiles loops used to iterate the pool and resolve every entry
 * through the Anthropic chain: the startup + 45s credential refresh
 * (`ensureFreshTokenForProfiles`), the 45s auth keepalive, `/health` and
 * `/profiles/list`. A ChatGPT entry reaching any of them is not cosmetic —
 * `/health` throwing drops the instance out of caddy's rotation, which is the
 * shape of this repo's 2026-09-04 outage, and the credential loop is the one
 * that ends in a destroyed account.
 *
 * `startProxyServer` rather than `createProxyServer`, because the credential
 * loop and the keepalive live in the former and are exactly what is under
 * test. Port 0 so the OS picks a free one; 3457 and 3458 are live instances.
 *
 * TWO THINGS ARE DELIBERATE AND BOTH PROTECT THE DEVELOPER'S REAL ACCOUNTS:
 *
 *   1. Profiles are passed through ProxyConfig instead of written to
 *      ~/.config/meridian/profiles.json. Bun's `os.homedir()` reads HOME once
 *      at process start and IGNORES a later `process.env.HOME = ...`, so an
 *      on-disk fixture cannot be isolated from the real file inside a test
 *      process — it would read (and route requests at) the developer's own
 *      accounts. `getEffectiveProfiles` returns the same array either way, so
 *      the loops under test see exactly what they would see from disk.
 *   2. The background refresh scheduler is started here first, on a synthetic
 *      store. `startBackgroundRefresh` is idempotent, so the server's own call
 *      becomes a no-op and can never point the scheduler at the default
 *      ~/.claude credentials.
 *
 * It runs in its own `bun test` invocation (see package.json) because that
 * scheduler is process-global state.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AddressInfo } from "node:net"
import { startProxyServer } from "../proxy/server"
import { startBackgroundRefresh, stopBackgroundRefresh, type CredentialStore } from "../proxy/tokenRefresh"
import type { ProfileConfig } from "../proxy/profiles"
import type { ProxyInstance } from "../proxy/types"

const ANTHROPIC_TOKEN_URL = "https://platform.claude.com/v1/oauth/token"
const HOUR_MS = 60 * 60 * 1000

const scratch = mkdtempSync(join(tmpdir(), "meridian-mixed-pool-"))
const claudeProfileDir = join(scratch, "claude-personal")
const fakeClaude = join(scratch, "claude-stub.sh")
mkdirSync(claudeProfileDir, { recursive: true })

writeFileSync(
  fakeClaude,
  `#!/bin/sh\necho '{"loggedIn":true,"email":"synthetic@example.test","subscriptionType":"max"}'\n`,
)
chmodSync(fakeClaude, 0o755)

// Expired on purpose: it gives the startup credential loop exactly one unit
// of work to do. An unfiltered loop throws on the leading ChatGPT entry and
// never reaches this profile, so the refresh count is 0 instead of 1 — a
// difference that asserting "nothing happened" could not have seen.
writeFileSync(
  join(claudeProfileDir, ".credentials.json"),
  JSON.stringify({
    claudeAiOauth: {
      accessToken: "synthetic-access",
      refreshToken: "synthetic-refresh",
      expiresAt: Date.now() - HOUR_MS,
      subscriptionType: "max",
    },
  }),
  { mode: 0o600 },
)

// The ChatGPT entry is FIRST on purpose: `candidates[0]` is the last link of
// the ambient resolution chain, so an unscoped resolver hands it to /health.
// `chatgpt-legacy` omits `type`, the shape that used to normalize to
// claude-max and put a ChatGPT profile in front of an Anthropic credential
// store.
const PROFILES: ProfileConfig[] = [
  { id: "chatgpt-work", provider: "openai", type: "chatgpt-oauth", accountUserId: "user_AAA" },
  { id: "claude-personal", type: "claude-max", claudeConfigDir: claudeProfileDir },
  { id: "chatgpt-legacy", provider: "openai", accountUserId: "user_BBB" },
]

/** Reads as "no credentials yet", which parks the scheduler on a 5m re-poll. */
const inertStore: CredentialStore = {
  refreshKey: "mixed-pool-test-inert",
  read: async () => null,
  write: async () => true,
}

const anthropicTokenRequests: string[] = []
const realFetch = globalThis.fetch
const savedClaudePath = process.env.MERIDIAN_CLAUDE_PATH
// Pinned at a path that is never created. This file uses startProxyServer,
// which ACQUIRES the ChatGPT writer lease when the store holds anything — so
// unpinned, once the operator has run the importer, a test run would seize
// refresh authority from the instance actually serving with it.
const savedStorePath = process.env.MERIDIAN_CHATGPT_STORE_PATH

let instance: ProxyInstance
let baseUrl: string
let startupTokenRequests: string[] = []

beforeAll(async () => {
  process.env.MERIDIAN_CLAUDE_PATH = fakeClaude
  process.env.MERIDIAN_CHATGPT_STORE_PATH = join(scratch, "chatgpt-accounts.json")

  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      if (url.startsWith(ANTHROPIC_TOKEN_URL)) {
        anthropicTokenRequests.push(url)
        return new Response("{}", { status: 500 })
      }
      // Loopback is this test talking to its own server. Anything else is a
      // background poll (npm registry, usage API) that must not leave the box.
      if (url.startsWith("http://127.0.0.1:")) return realFetch(input, init)
      return new Response("{}", { status: 500 })
    },
    { preconnect: realFetch.preconnect },
  ) as typeof globalThis.fetch

  startBackgroundRefresh(inertStore)

  instance = await startProxyServer({
    port: 0,
    host: "127.0.0.1",
    silent: true,
    profiles: PROFILES,
  })
  baseUrl = `http://127.0.0.1:${(instance.server.address() as AddressInfo).port}`

  // ensureFreshTokenForProfiles is fired as a bare `void` call. Give it room
  // to finish before anything reads what it did.
  await new Promise(resolve => setTimeout(resolve, 250))

  startupTokenRequests = [...anthropicTokenRequests]
})

afterAll(async () => {
  await instance?.close()
  stopBackgroundRefresh()
  globalThis.fetch = realFetch
  if (savedClaudePath === undefined) delete process.env.MERIDIAN_CLAUDE_PATH
  else process.env.MERIDIAN_CLAUDE_PATH = savedClaudePath
  if (savedStorePath === undefined) delete process.env.MERIDIAN_CHATGPT_STORE_PATH
  else process.env.MERIDIAN_CHATGPT_STORE_PATH = savedStorePath
  rmSync(scratch, { recursive: true, force: true })
})

describe("mixed Anthropic + ChatGPT pool", () => {
  // Exactly one: the Anthropic profile's, and nothing on behalf of either
  // ChatGPT profile. Zero would mean the loop threw before reaching it.
  test("the startup credential loop refreshes only the Anthropic profile", () => {
    expect(startupTokenRequests).toEqual([ANTHROPIC_TOKEN_URL])
  })

  test("/health stays healthy and names the GPT routing mode", async () => {
    const res = await fetch(`${baseUrl}/health`)
    const body = await res.json() as {
      status: string
      auth?: { loggedIn?: boolean; email?: string }
      upstream?: { gptModels?: string; chatgptAccounts?: number }
    }

    expect(res.status).toBe(200)
    // caddy's health_body probe matches this literal string. A /health that
    // throws, or reports anything else, silently removes the instance from
    // the reverse-proxy rotation.
    expect(body.status).toBe("healthy")
    // Resolved past the leading ChatGPT entry to the Anthropic one.
    expect(body.auth?.loggedIn).toBe(true)
    expect(body.auth?.email).toBe("synthetic@example.test")
    // Two ChatGPT PROFILES, zero ChatGPT CREDENTIALS. /health reports what
    // this instance can serve rather than what it was told about, so both
    // numbers describe the store and neither describes profiles.json — an
    // instance that answered "chatgpt" here would be advertising a provider
    // it has no token for.
    expect(body.upstream).toEqual({ gptModels: "claude", chatgptAccounts: 0 })
  })

  test("/profiles/list reports both providers rather than hiding one", async () => {
    const res = await fetch(`${baseUrl}/profiles/list`)
    const body = await res.json() as {
      profiles: Array<{ id: string; provider: string; type: string; loggedIn: boolean; email: string | null }>
    }

    expect(res.status).toBe(200)
    expect(body.profiles.map(p => p.id).sort())
      .toEqual(["chatgpt-legacy", "chatgpt-work", "claude-personal"])

    const byId = new Map(body.profiles.map(p => [p.id, p]))
    expect(byId.get("claude-personal")).toMatchObject({
      provider: "anthropic",
      type: "claude-max",
      loggedIn: true,
      email: "synthetic@example.test",
    })
    // Listed with their own provider and no Claude auth enrichment: reported
    // rather than pretended absent, and never resolved through the Anthropic
    // chain to get there. The type-less entry normalizes the same way.
    expect(byId.get("chatgpt-work")).toMatchObject({
      provider: "openai",
      type: "chatgpt-oauth",
      loggedIn: false,
      email: null,
    })
    expect(byId.get("chatgpt-legacy")).toMatchObject({
      provider: "openai",
      type: "chatgpt-oauth",
      loggedIn: false,
      email: null,
    })
  })

  test("POST /auth/refresh naming a ChatGPT profile is refused before any request", async () => {
    const before = anthropicTokenRequests.length
    const res = await fetch(`${baseUrl}/auth/refresh`, {
      method: "POST",
      headers: { "x-meridian-profile": "chatgpt-work" },
    })
    const body = await res.json() as { success: boolean; message: string }

    expect(res.status).toBe(400)
    expect(body.success).toBe(false)
    expect(body.message).toContain("openai")
    expect(anthropicTokenRequests.length).toBe(before)
  })

  test("POST /auth/refresh still reaches Anthropic for an Anthropic profile", async () => {
    const before = anthropicTokenRequests.length
    const res = await fetch(`${baseUrl}/auth/refresh`, {
      method: "POST",
      headers: { "x-meridian-profile": "claude-personal" },
    })

    // The stubbed endpoint answers 500, so this is a FAILED refresh rather
    // than a refused one. What it pins is that the Anthropic path is still
    // reached for an Anthropic profile — the half a provider filter could
    // quietly break while every other assertion here still passed.
    expect(res.status).toBe(500)
    expect(anthropicTokenRequests.length).toBe(before + 1)
  })
})
