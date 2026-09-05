/**
 * Integration tests for `GET /v1/usage/codex`.
 *
 * These drive the real HTTP layer, so they prove the route is wired to the
 * service rather than that the service works — that is covered by
 * codex-service.test.ts.
 *
 * No test here reaches the network. Every state is reachable before a request
 * would be made: the setting off, no pool, a pool whose records carry no usable
 * token. That is deliberate — a route test that needed a live ChatGPT account
 * could not run in CI.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"

installSdkMock(() => ({
  query: () => (async function* () {})(),
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}), "codex-route.test.ts")

installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}))

installMcpToolsMock(() => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const { createProxyServer } = await import("../proxy/server")
const { resetCodexUsageCache } = await import("../proxy/codex/service")
const { setCodexUsageEnabled } = await import("../proxy/settings")
import type { CodexUsageResponse } from "../proxy/codex/types"

const tempDir = join(tmpdir(), `meridian-codex-route-${process.pid}`)
const poolFile = join(tempDir, "oc-codex-multi-auth-accounts.json")
const configDir = join(tempDir, "config")

async function getCodex(): Promise<{ status: number; body: CodexUsageResponse; raw: string }> {
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
  const res = await app.fetch(new Request("http://localhost/v1/usage/codex"))
  const raw = await res.text()
  return { status: res.status, body: JSON.parse(raw) as CodexUsageResponse, raw }
}

describe("GET /v1/usage/codex", () => {
  let savedPoolPath: string | undefined
  let savedConfigDir: string | undefined

  beforeEach(() => {
    savedPoolPath = process.env.MERIDIAN_CODEX_POOL_PATH
    savedConfigDir = process.env.MERIDIAN_CONFIG_DIR
    rmSync(tempDir, { recursive: true, force: true })
    mkdirSync(configDir, { recursive: true })
    process.env.MERIDIAN_CODEX_POOL_PATH = poolFile
    process.env.MERIDIAN_CONFIG_DIR = configDir
    resetCodexUsageCache()
  })

  afterEach(() => {
    if (savedPoolPath !== undefined) process.env.MERIDIAN_CODEX_POOL_PATH = savedPoolPath
    else delete process.env.MERIDIAN_CODEX_POOL_PATH
    if (savedConfigDir !== undefined) process.env.MERIDIAN_CONFIG_DIR = savedConfigDir
    else delete process.env.MERIDIAN_CONFIG_DIR
    rmSync(tempDir, { recursive: true, force: true })
    resetCodexUsageCache()
  })

  it("reports the integration as absent when there is no pool", async () => {
    const { status, body } = await getCodex()
    expect(status).toBe(200)
    expect(body.entries).toEqual([])
    expect(body.error).toBe("not_configured")
    expect(typeof body.asOf).toBe("number")
  })

  it("reports the integration as disabled when the operator turns it off", async () => {
    setCodexUsageEnabled(false)
    writeFileSync(poolFile, JSON.stringify({
      version: 3,
      activeIndex: 0,
      accounts: [{
        accountId: "aaaaaaaa-1111-4111-8111-aaaaaaa1b2c3",
        accountUserId: "user-ABC__aaaaaaaa-1111-4111-8111-aaaaaaa1b2c3",
        email: "someone@example.com",
        refreshToken: "synthetic-refresh-token",
        addedAt: 1,
        lastUsed: 1,
      }],
    }), { mode: 0o600 })

    const { body } = await getCodex()
    expect(body.error).toBe("disabled")
    expect(body.entries).toEqual([])
  })

  it("renders one entry per pool account, naming the failure per card", async () => {
    writeFileSync(poolFile, JSON.stringify({
      version: 3,
      activeIndex: 0,
      accounts: [
        {
          accountId: "aaaaaaaa-1111-4111-8111-aaaaaaa1b2c3",
          accountUserId: "user-ONE__aaaaaaaa-1111-4111-8111-aaaaaaa1b2c3",
          email: "one@example.com",
          refreshToken: "synthetic-refresh-token",
          addedAt: 1,
          lastUsed: 1,
        },
        {
          accountId: "bbbbbbbb-2222-4222-8222-bbbbbbb4d5e6",
          accountUserId: "user-TWO__bbbbbbbb-2222-4222-8222-bbbbbbb4d5e6",
          email: "two@example.com",
          refreshToken: "synthetic-refresh-token",
          accessToken: "not-a-jwt",
          addedAt: 1,
          lastUsed: 1,
        },
      ],
    }), { mode: 0o600 })

    const { status, body } = await getCodex()
    expect(status).toBe(200)
    expect(body.error).toBeNull()
    expect(body.entries).toHaveLength(2)

    expect(body.entries[0]).toMatchObject({
      id: "user-ONE__aaaaaaaa-1111-4111-8111-aaaaaaa1b2c3",
      type: "codex",
      identity: "one@example.com, id:a1b2c3",
      error: "no_token",
      windows: [],
    })
    expect(body.entries[1]).toMatchObject({
      identity: "two@example.com, id:b4d5e6",
      error: "invalid_token",
    })
  })

  it("never puts a credential in the response", async () => {
    writeFileSync(poolFile, JSON.stringify({
      version: 3,
      activeIndex: 0,
      accounts: [{
        accountId: "aaaaaaaa-1111-4111-8111-aaaaaaa1b2c3",
        accountUserId: "user-ABC__aaaaaaaa-1111-4111-8111-aaaaaaa1b2c3",
        email: "someone@example.com",
        refreshToken: "SYNTHETIC-REFRESH-SECRET",
        accessToken: "SYNTHETIC-ACCESS-SECRET",
        addedAt: 1,
        lastUsed: 1,
      }],
    }), { mode: 0o600 })

    const { raw } = await getCodex()
    expect(raw).not.toContain("SYNTHETIC-REFRESH-SECRET")
    expect(raw).not.toContain("SYNTHETIC-ACCESS-SECRET")
    expect(raw).not.toContain("refreshToken")
    expect(raw).not.toContain("accessToken")
  })
})
