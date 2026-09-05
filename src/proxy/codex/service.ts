/**
 * Read-only ChatGPT (Codex) account usage, assembled for the dashboard.
 *
 * NOTE: agent-specific. This is the one place that knows the integration as a
 * whole exists: it gates on the operator's setting, reads the oc-codex pool,
 * and fans out to the usage endpoint once per account. Everything above it —
 * the HTTP route, the landing page — talks only to `getCodexUsage`.
 *
 * The stateful parts live here rather than in `usage.ts` so that module stays a
 * pure fetch-and-validate leaf. Three of them matter:
 *
 * - The dashboard polls every ten seconds. Six accounts times two endpoints
 *   would be seventy-two authenticated requests a minute against undocumented
 *   vendor endpoints, so a short cache is a correctness requirement, not an
 *   optimisation.
 * - A refused or rate-limited account is held off for a while, so a dead token
 *   is asked about once every few minutes instead of six times a minute.
 * - Outbound requests are bounded process-wide, so several open dashboards
 *   cannot multiply into an unbounded fan-out.
 *
 * Nothing here writes the pool and nothing renews a credential; see
 * `codex-no-write.test.ts`, which pins that structurally.
 */

import { createHash } from "node:crypto"
import { isCodexUsageEnabled, loadSettings, type MeridianSettings } from "../settings"
import { codexAccountIdentity, readCodexPool, type CodexPoolAccount, type CodexPoolResult } from "./pool"
import { describeCodexPlan } from "./plan"
import { decodeCodexToken, type CodexTokenClaims } from "./token"
import { fetchCodexAccountUsage, type CodexAccountUsage, type CodexUsageOutcome } from "./usage"
import type { CodexPlan, CodexUsageEntry, CodexUsageError, CodexUsageResponse } from "./types"

const SUCCESS_TTL_MS = 30_000
const STALE_MAX_MS = 15 * 60_000
const RATE_LIMIT_COOLDOWN_MS = 60_000
const REFUSED_CREDENTIAL_COOLDOWN_MS = 5 * 60_000
const MAX_CONCURRENT_FETCHES = 4

interface CachedUsage {
  usage: CodexAccountUsage
  fetchedAt: number
}

const lastGood = new Map<string, CachedUsage>()
const inFlight = new Map<string, Promise<CodexUsageOutcome>>()
const heldOffUntil = new Map<string, { until: number; error: CodexUsageError }>()

export function resetCodexUsageCache(): void {
  lastGood.clear()
  inFlight.clear()
  heldOffUntil.clear()
}

/**
 * Bound concurrent upstream work process-wide.
 *
 * A finishing task hands its slot straight to the next waiter rather than
 * decrementing and letting it re-enter; decrementing first would let a caller
 * arriving in between take the freed slot as well, so the limit could be
 * exceeded by exactly the number of waiters woken.
 */
function createGate(limit: number) {
  let active = 0
  const waiting: Array<() => void> = []

  const yieldSlot = () => {
    const next = waiting.shift()
    if (next) next()
    else active--
  }

  return async function enter<T>(task: () => Promise<T>): Promise<T> {
    if (active < limit) active++
    else await new Promise<void>((resolve) => waiting.push(resolve))
    try {
      return await task()
    } finally {
      yieldSlot()
    }
  }
}

const gate = createGate(MAX_CONCURRENT_FETCHES)

export interface CodexUsageDeps {
  settings?: MeridianSettings
  loadPool?: () => CodexPoolResult
  fetchImpl?: typeof fetch
  now?: number
}

export async function getCodexUsage(deps: CodexUsageDeps = {}): Promise<CodexUsageResponse> {
  const now = deps.now ?? Date.now()

  // Off means off: no pool read, no request, no trace of another tool's
  // credentials having been looked at.
  if (!isCodexUsageEnabled(deps.settings ?? loadSettings())) {
    return { entries: [], error: "disabled", asOf: now }
  }

  const { pool, error } = (deps.loadPool ?? readCodexPool)()
  if (!pool) return { entries: [], error: error ?? "not_configured", asOf: now }
  if (pool.accounts.length === 0) return { entries: [], error: "not_configured", asOf: now }

  const entries = await Promise.all(
    pool.accounts.map((account) => resolveAccount(account, now, deps.fetchImpl)),
  )
  return { entries, error: null, asOf: now }
}

async function resolveAccount(
  account: CodexPoolAccount,
  now: number,
  fetchImpl: typeof fetch | undefined,
): Promise<CodexUsageEntry> {
  const claims = decodeCodexToken(account.accessToken)
  const key = cacheKey(account)
  const cached = lastGood.get(key)

  if (cached && now - cached.fetchedAt < SUCCESS_TTL_MS) {
    return toEntry(account, claims, cached.usage, false, null)
  }

  let outcome: CodexUsageOutcome
  try {
    outcome = await obtainUsage(account, key, now, fetchImpl)
  } catch {
    // Promise.all rejects on the first failure, so an unforeseen throw here
    // would take the whole card grid down with one account.
    outcome = { usage: null, error: "upstream_error" }
  }

  if (outcome.usage) {
    lastGood.set(key, { usage: outcome.usage, fetchedAt: outcome.usage.fetchedAt })
    return toEntry(account, claims, outcome.usage, false, null)
  }

  // Old numbers are worth showing through a blip, but never through a
  // credential the vendor has just refused or that does not match the account.
  if (outcome.error && isTransient(outcome.error) && cached && now - cached.fetchedAt < STALE_MAX_MS) {
    return toEntry(account, claims, cached.usage, true, outcome.error)
  }
  return toEntry(account, claims, null, false, outcome.error)
}

async function obtainUsage(
  account: CodexPoolAccount,
  key: string,
  now: number,
  fetchImpl: typeof fetch | undefined,
): Promise<CodexUsageOutcome> {
  const heldOff = heldOffUntil.get(key)
  if (heldOff) {
    if (now < heldOff.until) return { usage: null, error: heldOff.error }
    heldOffUntil.delete(key)
  }

  const pending = inFlight.get(key)
  if (pending) return pending

  const request = gate(() => fetchCodexAccountUsage(
    {
      accountId: account.accountId,
      accountUserId: account.accountUserId,
      accessToken: account.accessToken,
      email: account.email,
    },
    { fetchImpl, now },
  )).then((outcome) => {
    if (outcome.error) {
      const cooldown = cooldownFor(outcome.error)
      if (cooldown !== null) heldOffUntil.set(key, { until: now + cooldown, error: outcome.error })
    }
    return outcome
  }).finally(() => {
    inFlight.delete(key)
  })

  inFlight.set(key, request)
  return request
}

function cooldownFor(error: CodexUsageError): number | null {
  if (error === "rate_limited") return RATE_LIMIT_COOLDOWN_MS
  if (error === "unauthorized" || error === "identity_mismatch") return REFUSED_CREDENTIAL_COOLDOWN_MS
  return null
}

function isTransient(error: CodexUsageError): boolean {
  return error === "rate_limited" || error === "upstream_error" || error === "invalid_response"
}

/**
 * Key on identity plus a fingerprint of the credential, never the credential.
 *
 * Including the token is what makes a rotated credential a cache miss rather
 * than a stale hit, and what lifts a refused account's cooldown the moment
 * oc-codex replaces its token.
 */
function cacheKey(account: CodexPoolAccount): string {
  const fingerprint = account.accessToken
    ? createHash("sha256").update(account.accessToken).digest("hex").slice(0, 16)
    : "none"
  return `${account.accountUserId ?? ""}|${account.accountId ?? ""}|${fingerprint}`
}

function toEntry(
  account: CodexPoolAccount,
  claims: CodexTokenClaims | null,
  usage: CodexAccountUsage | null,
  stale: boolean,
  error: CodexUsageError | null,
): CodexUsageEntry {
  return {
    id: account.accountUserId ?? account.accountId ?? account.email ?? "unknown",
    type: "codex",
    identity: codexAccountIdentity(account),
    email: usage?.email ?? account.email,
    // The token names the tier without a network call, so a card whose usage
    // could not be fetched still says which plan it is.
    plan: toPlan(usage?.planType ?? claims?.planType ?? account.planType),
    windows: usage?.windows ?? [],
    resetCredits: usage?.resetCredits ?? null,
    fetchedAt: usage?.fetchedAt ?? null,
    stale,
    error,
  }
}

function toPlan(slug: string | null | undefined): CodexPlan | null {
  const described = describeCodexPlan(slug)
  if (described.slug === null) return null
  return { slug: described.slug, label: described.label, multiplier: described.multiplier }
}
