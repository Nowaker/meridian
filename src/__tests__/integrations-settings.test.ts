/**
 * The Integrations settings surface.
 *
 * Integrations are optional couplings to tools that are not Meridian — here,
 * reading another program's credential file. The operator must be able to see
 * that coupling and switch it off, and switching it off has to mean Meridian
 * stops looking entirely rather than merely hiding the result.
 *
 * The section is deliberately a list rather than a single switch: it is the
 * place a second integration lands without redesigning anything.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"

installSdkMock(() => ({
  query: () => (async function* () {})(),
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}), "integrations-settings.test.ts")

installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}))

installMcpToolsMock(() => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const { createProxyServer } = await import("../proxy/server")
const { loadSettings, saveSettings, isCodexUsageEnabled } = await import("../proxy/settings")
const { settingsPageHtml } = await import("../telemetry/settingsPage")

const configDir = join(tmpdir(), `meridian-integrations-${process.pid}`)

interface IntegrationsBody {
  integrations: Record<string, boolean>
}

async function get(): Promise<{ status: number; body: IntegrationsBody }> {
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
  const res = await app.fetch(new Request("http://localhost/settings/api/integrations"))
  return { status: res.status, body: await res.json() as IntegrationsBody }
}

async function put(payload: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
  const res = await app.fetch(new Request("http://localhost/settings/api/integrations", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }))
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

describe("GET/PUT /settings/api/integrations", () => {
  let savedConfigDir: string | undefined

  beforeEach(() => {
    savedConfigDir = process.env.MERIDIAN_CONFIG_DIR
    rmSync(configDir, { recursive: true, force: true })
    mkdirSync(configDir, { recursive: true })
    process.env.MERIDIAN_CONFIG_DIR = configDir
  })

  afterEach(() => {
    if (savedConfigDir !== undefined) process.env.MERIDIAN_CONFIG_DIR = savedConfigDir
    else delete process.env.MERIDIAN_CONFIG_DIR
    rmSync(configDir, { recursive: true, force: true })
  })

  it("reports the ChatGPT usage integration as on when nothing has been configured", async () => {
    const { status, body } = await get()
    expect(status).toBe(200)
    expect(body.integrations.codexUsage).toBe(true)
  })

  it("turns the integration off and reads it back off", async () => {
    expect((await put({ codexUsage: false })).status).toBe(200)
    expect((await get()).body.integrations.codexUsage).toBe(false)
    expect(isCodexUsageEnabled(loadSettings())).toBe(false)
  })

  it("turns it back on", async () => {
    await put({ codexUsage: false })
    await put({ codexUsage: true })
    expect((await get()).body.integrations.codexUsage).toBe(true)
    expect(isCodexUsageEnabled(loadSettings())).toBe(true)
  })

  it("refuses a non-boolean rather than persisting a truthy string", async () => {
    const { status } = await put({ codexUsage: "false" })
    expect(status).toBe(400)
    expect(isCodexUsageEnabled(loadSettings())).toBe(true)
  })

  it("refuses an unknown integration key instead of silently accepting it", async () => {
    // A typo that is quietly accepted is a setting the operator believes they
    // changed and did not.
    const { status } = await put({ notAnIntegration: true })
    expect(status).toBe(400)
  })

  it("refuses a body that is not JSON", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    const res = await app.fetch(new Request("http://localhost/settings/api/integrations", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "{ not json",
    }))
    expect(res.status).toBe(400)
  })

  it("leaves unrelated settings alone", async () => {
    saveSettings({ routing: "priority", activeProfile: "work" })
    await put({ codexUsage: false })
    const settings = loadSettings()
    expect(settings.routing).toBe("priority")
    expect(settings.activeProfile).toBe("work")
    expect(settings.integrations?.codexUsage).toBe(false)
  })
})

describe("the Integrations section of the settings page", () => {
  it("sits below Routing", async () => {
    const routing = settingsPageHtml.indexOf(">Routing<")
    const integrations = settingsPageHtml.indexOf(">Integrations<")
    expect(routing).toBeGreaterThan(-1)
    expect(integrations).toBeGreaterThan(routing)
  })

  it("is fed by the integrations endpoint", () => {
    expect(settingsPageHtml).toContain("/settings/api/integrations")
  })

  it("names the integration and what it reads", () => {
    expect(settingsPageHtml).toContain("ChatGPT")
    expect(settingsPageHtml).toContain("oc-codex")
  })

  it("is rendered from a list so a second integration needs no new markup", () => {
    // The container is populated from a descriptor array; a hand-written row
    // per integration is what this test exists to prevent.
    expect(settingsPageHtml).toContain("INTEGRATIONS")
    expect(settingsPageHtml).toContain('id="integrations-body"')
  })
})
