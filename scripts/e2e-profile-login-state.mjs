#!/usr/bin/env bun
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { spawnSync } from "node:child_process"

if (process.argv.includes("--help")) {
  console.log("Usage: bun scripts/e2e-profile-login-state.mjs [--real-cli] [--serve]\nOwned credentials only; inference and external HTTP calls are blocked. E2E_PORT selects the loopback fixture port.")
  process.exit(0)
}

const repo = resolve(process.env.E2E_MERIDIAN_ROOT ?? ".")
const root = mkdtempSync(join(tmpdir(), "meridian-login-state-"))
const executable = join(root, "claude-fixture.cjs")
for (const key of Object.keys(process.env)) {
  if (key.startsWith("MERIDIAN_") || key.startsWith("CLAUDE_PROXY_") || key.startsWith("ANTHROPIC_")) delete process.env[key]
}
delete process.env.CLAUDE_CODE_OAUTH_TOKEN
if (process.argv.includes("--real-cli")) {
  const config = join(root, "real-cli")
  mkdirSync(config)
  const start = performance.now()
  const result = spawnSync(join(repo, "node_modules/.bin/claude"), ["auth", "status"], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: config }, encoding: "utf8", timeout: 30000,
  })
  const loggedIn = JSON.parse(result.stdout || "{}").loggedIn
  assert.equal(result.status, 1)
  assert.equal(loggedIn, false)
  console.log(JSON.stringify({ realCli: "PASS", exitCode: result.status, loggedIn, durationMs: performance.now() - start, credentials: "owned empty directory" }))
}
Object.assign(process.env, {
  MERIDIAN_CONFIG_DIR: join(root, "config"), MERIDIAN_SESSION_DIR: join(root, "sessions"), MERIDIAN_WORKDIR: root,
  MERIDIAN_CLAUDE_PATH: executable, MERIDIAN_CREDENTIALS_READONLY: "1", MERIDIAN_TELEMETRY_PERSIST: "0", MERIDIAN_NO_UPDATE_CHECK: "1",
  MERIDIAN_CHATGPT_CREDENTIALS: "follow-external", MERIDIAN_CODEX_POOL_PATH: join(root, "pool.json"),
})
const credentialDirs = new Map()
const profiles = ["healthy", "rejected", "explicit"].map(id => {
  const dir = join(root, id)
  mkdirSync(dir)
  writeFileSync(join(dir, "answer"), "true")
  writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: {
    accessToken: "synthetic-access", refreshToken: "synthetic-refresh", expiresAt: Date.now() + 8 * 3_600_000,
    refreshTokenExpiresAt: Date.now() + 20 * 86_400_000,
  } }))
  credentialDirs.set(id, dir)
  return { id, type: "claude-max", claudeConfigDir: dir }
})
writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('2.1.284'); process.exit(0); }
const mode = fs.readFileSync(require('node:path').join(process.env.CLAUDE_CONFIG_DIR, 'answer'), 'utf8');
console.log(JSON.stringify({loggedIn: mode === 'true', email: 'fixture@example.invalid', subscriptionType: 'max'}));
process.exit(mode === 'true' ? 0 : 1);
`, { mode: 0o700 })
const seat = "fixture-user__fixture-workspace"
writeFileSync(join(root, "pool.json"), JSON.stringify({ version: 3, activeIndex: 0, accounts: [{
  accountId: "fixture-workspace", accountUserId: seat, email: "gpt@example.invalid", accessToken: "synthetic-access",
  refreshToken: "synthetic-refresh", expiresAt: Date.now() + 3_600_000, addedAt: Date.now(), lastUsed: 0,
}] }))
const realFetch = globalThis.fetch
let networkCalls = 0
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (url.hostname === "127.0.0.1") return realFetch(input, init)
  networkCalls++
  return Promise.resolve(new Response("{}", { status: 503 }))
}
const load = path => import(pathToFileURL(join(repo, path)).href)
const { createProxyServer } = await load("src/proxy/server.ts")
const models = await load("src/proxy/models.ts")
const { createPlatformCredentialStore } = await load("src/proxy/tokenRefresh.ts")
const { noteAuthLogin, noteRefreshRejected } = await load("src/proxy/authLifecycle.ts")
const { reconcileClaudeProfileAuth } = await load("src/proxy/profileLoginState.ts")
const { __setFetchOAuthUsageOverride } = await load("src/proxy/oauthUsage.ts")
__setFetchOAuthUsageOverride(async () => ({ windows: [{ type: "five_hour", utilization: 0, resetsAt: Date.now() + 3_600_000 }], extraUsage: null, fetchedAt: Date.now() }))
const store = createPlatformCredentialStore({ claudeConfigDir: credentialDirs.get("rejected") })
noteRefreshRejected(store.refreshKey, { detail: "invalid_grant" })
noteRefreshRejected(`chatgpt:${seat}`, { detail: "rejected" })
await models.getClaudeAuthStatusAsync("explicit", { CLAUDE_CONFIG_DIR: credentialDirs.get("explicit") })
writeFileSync(join(credentialDirs.get("explicit"), "answer"), "false")
models.expireAuthStatusCache()
await models.getClaudeAuthStatusAsync("explicit", { CLAUDE_CONFIG_DIR: credentialDirs.get("explicit") })
await models.pendingAuthStatusRefresh("explicit")
const { app } = createProxyServer({ host: "127.0.0.1", port: 0, silent: true, profiles, defaultProfile: "healthy" })
const listener = Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.E2E_PORT ?? 0), fetch: request => {
  const path = new URL(request.url).pathname
  if (path.startsWith("/v1/") && !path.startsWith("/v1/usage/")) return new Response("Inference forbidden in owned fixture", { status: 403 })
  return app.fetch(request)
} })
const origin = `http://127.0.0.1:${listener.port}`
const list = () => realFetch(`${origin}/profiles/list`).then(response => response.json())
const activate = profile => realFetch(`${origin}/profiles/active`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ profile }) })
const cleanup = () => { listener.stop(true); globalThis.fetch = realFetch; rmSync(root, { recursive: true, force: true }) }
try {
  const initial = await list()
  for (const profile of initial.profiles) assert.equal(profile.loggedIn, profile.id === "healthy")
  for (const id of ["rejected", "explicit", initial.profiles.find(profile => profile.type === "chatgpt").id]) {
    const refusal = await activate(id)
    assert.equal(refusal.status, 409)
    assert.equal((await refusal.json()).code, "needs_login")
    assert.equal((await list()).activeProfile, "healthy")
  }
  const start = performance.now()
  for (let i = 0; i < 100; i++) await reconcileClaudeProfileAuth({ loggedIn: true }, { id: "rejected", type: "claude-max", env: { CLAUDE_CONFIG_DIR: credentialDirs.get("rejected") } })
  console.log(JSON.stringify({ result: "PASS", surface: "real child process + HTTP + credential stores", profiles: initial.profiles.map(({ id, loggedIn }) => ({ id, loggedIn })), localProbeMeanMs: (performance.now() - start) / 100, upstreamAuthProbes: 0, networkRequestsBlocked: networkCalls }))
  if (process.argv.includes("--serve")) {
    console.log(JSON.stringify({ fixtureUrl: origin, inference: "forbidden" }))
    await new Promise(resolve => { process.once("SIGTERM", resolve); process.once("SIGINT", resolve) })
  } else {
    noteAuthLogin(store.refreshKey)
    assert.equal((await list()).profiles.find(profile => profile.id === "rejected").loggedIn, true)
    assert.equal((await activate("rejected")).status, 200)
    console.log(JSON.stringify({ recovery: "PASS", accountMutations: "owned synthetic fixture only" }))
  }
} finally { cleanup() }
