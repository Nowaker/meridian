/**
 * A ChatGPT seat's banked rate-limit resets: list them with their ids, and
 * redeem one.
 *
 * NOTE: agent-specific. Kept out of codex/, which only ever reads
 * (codex-no-write.test.ts). These are the two undocumented endpoints the Codex
 * apps' `/usage` screen and oc-codex-multi-auth's `codex-reset` use:
 * `GET /wham/rate-limit-reset-credits` and
 * `POST /wham/rate-limit-reset-credits/consume`. Both authenticate like
 * `/wham/usage`, so they share its token checks and headers (codex/usage.ts).
 *
 * Redeeming is irreversible and spends a finite credit, so nothing here
 * decides to redeem; the caller names the credit. The consume carries an
 * idempotency key derived from the credit id alone, so a retry of the same
 * redemption - by Meridian or by oc-codex-multi-auth, which derives the same
 * key - is recognised by the backend instead of spending a second credit.
 */

import { createHash } from "node:crypto"
import { availableCredits, classifyStatus, codexHeaders, getJson, RESET_CREDITS_URL, usableToken, type CodexCredentials } from "../codex/usage"
import type { CodexRemoteError, CodexResetCredit, CodexUsageError } from "../codex/types"

const CONSUME_URL = `${RESET_CREDITS_URL}/consume`
const DEFAULT_TIMEOUT_MS = 25_000
const VENDOR_CODE = /^[A-Za-z0-9_.:-]{1,64}$/

export interface ResetCreditOptions {
  fetchImpl?: typeof fetch
  timeoutMs?: number
  now?: number
}

export interface ResetConsumeOptions extends ResetCreditOptions {
  /** How many times this credit was tried before; each try after a refusal sends a key of its own. */
  attempt?: number
}

export type ResetCreditList =
  | { ok: true; credits: CodexResetCredit[] }
  | { ok: false; error: CodexUsageError }

/** The seat's available credits with their ids, soonest expiry first. */
export async function listResetCredits(credentials: CodexCredentials, options: ResetCreditOptions = {}): Promise<ResetCreditList> {
  const usable = usableToken(credentials, options.now ?? Date.now())
  if ("error" in usable) return { ok: false, error: usable.error }
  const result = await getJson(options.fetchImpl ?? fetch, RESET_CREDITS_URL, usable.token, credentials.accountId, options.timeoutMs)
  if (result.error) return { ok: false, error: result.error }
  return { ok: true, credits: availableCredits(result.body) }
}

/**
 * The idempotency key for redeeming `creditId`: stable across calls, because
 * a credit is redeemed at most once, so "the same redemption" is "the same
 * credit". The derivation is oc-codex-multi-auth's `createRedeemRequestId`
 * byte for byte, so the two tools cannot spend one seat's credit twice
 * between them. UUID-shaped, as the official clients send it.
 */
export function redeemRequestId(creditId: string): string {
  const bytes = createHash("sha256").update(`oc-codex-multi-auth:redeem-request:${creditId}`).digest().subarray(0, 16)
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = bytes.toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * What a consume came to.
 *
 * - `redeemed`: the backend answered 2xx.
 * - `refused`: it answered 4xx, so the credit was not spent; `code` is the
 *   vendor's own short code when it sent one in a readable shape.
 * - `indeterminate`: the request went out and no trustworthy answer came back
 *   (a 5xx, a dropped connection, a body that is not JSON). The credit may or
 *   may not be spent; never retry it automatically.
 * - `not_sent`: the token could not be used, so nothing left the process.
 */
export type ResetConsumeOutcome =
  | { kind: "redeemed"; code: string | null; windowsReset: string[]; redeemedAt: number | null }
  | { kind: "refused"; status: number; error: CodexRemoteError | "refused"; code: string | null }
  | { kind: "indeterminate"; status: number | null }
  | { kind: "not_sent"; error: CodexUsageError }

export async function consumeResetCredit(
  credentials: CodexCredentials,
  creditId: string,
  options: ResetConsumeOptions = {},
): Promise<ResetConsumeOutcome> {
  const usable = usableToken(credentials, options.now ?? Date.now())
  if ("error" in usable) return { kind: "not_sent", error: usable.error }
  let response: Response
  try {
    response = await (options.fetchImpl ?? fetch)(CONSUME_URL, {
      method: "POST",
      headers: { ...codexHeaders(usable.token, credentials.accountId), "Content-Type": "application/json" },
      body: JSON.stringify({ credit_id: creditId, redeem_request_id: redeemRequestId(options.attempt ? `${creditId}#${options.attempt}` : creditId) }),
      // A bearer credential must never be replayed to a redirect target.
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    })
  } catch {
    return { kind: "indeterminate", status: null }
  }
  if (response.status >= 500) return { kind: "indeterminate", status: response.status }
  const body = asRecord(await response.json().catch(() => null))
  if (!response.ok) {
    const error = classifyStatus(response.status)
    return { kind: "refused", status: response.status, error: error === "upstream_error" ? "refused" : error, code: vendorCode(body) }
  }
  if (!body) return { kind: "indeterminate", status: response.status }
  const credit = asRecord(body.credit)
  const redeemedAt = typeof credit?.redeemed_at === "string" ? Date.parse(credit.redeemed_at) : Number.NaN
  const windows = Array.isArray(body.windows_reset) ? body.windows_reset : typeof body.windows_reset === "string" ? [body.windows_reset] : []
  return {
    kind: "redeemed",
    code: vendorCode(body),
    windowsReset: windows.filter((w): w is string => typeof w === "string" && VENDOR_CODE.test(w)),
    redeemedAt: Number.isFinite(redeemedAt) ? redeemedAt : null,
  }
}

/**
 * The vendor's short code from `code`, `error.code` or `detail.code`, only
 * when it looks like a code: free text in an error body is attacker-
 * influenced and is never passed on.
 */
function vendorCode(body: Record<string, unknown> | null): string | null {
  const candidates = [body?.code, asRecord(body?.error)?.code, asRecord(body?.detail)?.code, body?.detail]
  for (const candidate of candidates) {
    if (typeof candidate === "string" && VENDOR_CODE.test(candidate)) return candidate
  }
  return null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}
