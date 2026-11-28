/**
 * Redeeming a ChatGPT seat's banked rate-limit resets.
 *
 * NOTE: agent-specific. Only the instance that owns the seats' credentials
 * (owned mode, holding the writer lease) redeems; a follow-external or
 * read-only instance answers `not_owned`, so two instances can never spend
 * credits for the same seats.
 *
 * Every redemption lists the seat's credits afresh, picks one, writes it to a
 * ledger on disk BEFORE the consume leaves the process, and records how it
 * ended. The ledger is what keeps a credit from being spent twice: a crash
 * between the write and the answer leaves the credit marked as tried, never
 * as free to try again. A credit that may have been spent is never tried
 * again. One ChatGPT refused is intact: a person may try it again at once, a
 * scheduled redemption half an hour later (resetPolicy.ts). Each retry sends
 * an idempotency key of its own, so a refusal ChatGPT stored under the first
 * key cannot be replayed to it. One redemption runs per seat at a time.
 *
 * The ledger also keeps the operator's decision per credit: `prevent` keeps a
 * scheduled redemption off that credit until it expires, and off every credit
 * of its seat until the seat's binding window renews (`holds`), so "don't"
 * does not become "spend the next one"; `approve` is recorded only.
 *
 * FRESH-READ GATE. Another instance owning the same accounts may have
 * redeemed since this one planned. Right before the irreversible POST a
 * scheduled redemption lists the credits and reads the seat's usage afresh
 * and stops, recorded `superseded`, when its credit is gone, the binding
 * window no longer meets the usage trigger, or the window started within
 * RECENT_RESET_MS (someone just reset it). Credits are taken soonest expiry
 * first, ties by id, so two instances redeeming at once name the same credit
 * and the provider spends it once.
 *
 * A refusal is `not_applicable` when ChatGPT counted no reset as applicable
 * just before (it does so only once a seat is limited, measured 2026-11-28),
 * else `refused`. Both leave the credit intact.
 *
 * After a consume answers success the credits are listed once more: a reset
 * the backend still lists as available was not redeemed, whatever the answer
 * said, and is reported as unconfirmed. Then the seat's usage is read again:
 * a reset that went but left the binding window as used as before is
 * `spent_without_reset` - the one way trying early could cost a credit, so it
 * is reported as a failure.
 */

import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { consumeResetCredit, listResetCredits } from "./resetCredits"
import { fetchCodexAccountUsage, type CodexCredentials } from "../codex/usage"
import { codexBindingWindow } from "../codex/windows"
import type { ChatGptCredentialSource } from "./source"

export type ResetRedeemTrigger = "manual" | "deadline" | "usage"
export type ResetDecision = "approve" | "prevent"

/** How an attempt ended; `dispatching` means the consume was sent and no answer was recorded. */
export type ResetAttemptOutcome = "dispatching" | "redeemed" | "refused" | "not_applicable" | "superseded" | "indeterminate" | "unconfirmed" | "spent_without_reset"

/** An outcome after which the credit is certainly still banked: ChatGPT said no, or nothing was sent. */
export function isIntactRefusal(outcome: ResetAttemptOutcome): boolean {
  return outcome === "refused" || outcome === "not_applicable" || outcome === "superseded"
}

/** A binding window that started this recently was just reset, by a renewal or another instance. */
export const RECENT_RESET_MS = 15 * 60_000

export interface ResetAttempt {
  /** Stable, non-reversible name of the credit: what the plan and decisions use. */
  creditKey: string
  seat: string
  expiresAt: number | null
  trigger: ResetRedeemTrigger
  attemptedAt: number
  outcome: ResetAttemptOutcome
  error: string | null
  settledAt: number | null
}

export type ResetRedeemResult =
  | { kind: "redeemed"; creditKey: string; expiresAt: number | null; windowsReset: string[]; redeemedAt: number | null; remaining: number | null }
  | { kind: "failed"; creditKey: string; expiresAt: number | null; error: string; indeterminate: boolean; outcome: ResetAttemptOutcome }
  | { kind: "no_credit"; available: number }
  | { kind: "superseded"; creditKey: string; reason: string }
  | { kind: "unavailable"; error: string }
  | { kind: "in_progress" }
  | { kind: "not_owned" }

export interface ResetRedeemer {
  /**
   * Redeem the seat's soonest-expiring credit that may be tried, or, with
   * `creditKey`, that credit only.
   */
  redeem(seat: string, trigger: ResetRedeemTrigger, options?: ResetRedeemOptions): Promise<ResetRedeemResult>
  /** Every recorded attempt, oldest first. */
  attempts(): ResetAttempt[]
  /** The operator's decision per credit key. */
  decisions(): Record<string, ResetDecision>
  /** `hold`: on a prevent, the seat and until when no credit of it is redeemed by itself. */
  decide(creditKey: string, decision: ResetDecision, expiresAt: number | null, hold?: { seat: string; until: number }): void
  /** Per seat, until when a prevent holds it. */
  holds(): Record<string, number>
  /** Whether a redemption is running for the seat. */
  running(seat: string): boolean
}

export interface ResetRedeemOptions {
  /** That credit only. */
  creditKey?: string
  /** A usage-triggered redemption goes ahead only while the binding window has at most this many points left. */
  nearEmptyPoints?: number
}

export interface ResetRedeemerDeps {
  source: Pick<ChatGptCredentialSource, "credentials">
  ledgerPath: string
  /** True only while this instance holds the authority to spend the seats' credits. */
  canRedeem: () => boolean
  fetchImpl?: typeof fetch
  now?: () => number
}

/** Attempts are kept a week past their credit's expiry; after that no credit they name can come back. */
const ATTEMPT_RETENTION_MS = 7 * 24 * 3_600_000
export const RESET_RETRY_AFTER_REFUSAL_MS = 30 * 60_000

/** Whether a scheduled redemption may try a credit with these attempts: never tried, or only refused and not lately. */
export function mayTryAutomatically(attempts: readonly ResetAttempt[], now: number): boolean {
  if (attempts.length === 0) return true
  if (attempts.some(a => !isIntactRefusal(a.outcome))) return false
  return now - Math.max(...attempts.map(a => a.attemptedAt)) >= RESET_RETRY_AFTER_REFUSAL_MS
}

export function resetCreditKey(seat: string, creditId: string): string {
  return createHash("sha256").update(`${seat}\u0000${creditId}`).digest("hex").slice(0, 16)
}

interface DecisionRecord {
  decision: ResetDecision
  decidedAt: number
  expiresAt: number | null
  seat?: string
  holdUntil?: number
}

interface LedgerDoc {
  version: 1
  attempts: ResetAttempt[]
  decisions: Record<string, DecisionRecord>
}

function readLedger(path: string): LedgerDoc {
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, attempts: [], decisions: {} }
    throw error
  }
  const parsed = JSON.parse(raw) as Partial<LedgerDoc>
  if (parsed.version !== 1 || !Array.isArray(parsed.attempts)) throw new Error(`unreadable reset ledger ${path}`)
  const decisions = typeof parsed.decisions === "object" && parsed.decisions !== null && !Array.isArray(parsed.decisions) ? parsed.decisions : {}
  return { version: 1, attempts: parsed.attempts, decisions }
}

function writeLedger(path: string, doc: LedgerDoc): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 })
  renameSync(temp, path)
}

/** A person's redeem may try any credit that cannot have been spent. */
const mayTryByHand = (attempts: readonly ResetAttempt[]): boolean => attempts.every(a => isIntactRefusal(a.outcome))

export function createResetRedeemer(deps: ResetRedeemerDeps): ResetRedeemer {
  const now = deps.now ?? Date.now
  const running = new Map<string, Promise<ResetRedeemResult>>()

  const update = (mutate: (doc: LedgerDoc) => void): void => {
    const doc = readLedger(deps.ledgerPath)
    mutate(doc)
    const at = now()
    doc.attempts = doc.attempts.filter(a => a.expiresAt === null || a.expiresAt + ATTEMPT_RETENTION_MS > at)
    for (const [key, record] of Object.entries(doc.decisions)) {
      if (record.expiresAt !== null && record.expiresAt + ATTEMPT_RETENTION_MS <= at) delete doc.decisions[key]
    }
    writeLedger(deps.ledgerPath, doc)
  }
  const settle = (creditKey: string, outcome: ResetAttemptOutcome, error: string | null): void => {
    update(doc => {
      const attempt = doc.attempts.findLast(a => a.creditKey === creditKey)
      if (attempt) Object.assign(attempt, { outcome, error, settledAt: now() })
    })
  }

  const holds = (): Record<string, number> => {
    const at = now()
    const out: Record<string, number> = {}
    for (const record of Object.values(readLedger(deps.ledgerPath).decisions)) {
      if (record.decision !== "prevent" || !record.seat || record.holdUntil === undefined || record.holdUntil <= at) continue
      out[record.seat] = Math.max(out[record.seat] ?? 0, record.holdUntil)
    }
    return out
  }

  async function run(seat: string, trigger: ResetRedeemTrigger, options: ResetRedeemOptions): Promise<ResetRedeemResult> {
    const wanted = options.creditKey
    const credential = await deps.source.credentials(seat)
    if (!credential.ok) return { kind: "unavailable", error: `the seat's credentials cannot be used (${credential.reason})` }
    const credentials: CodexCredentials = {
      accountId: credential.account.accountId,
      accountUserId: credential.account.accountUserId,
      accessToken: credential.account.accessToken,
      email: null,
    }
    const fetchOptions = { fetchImpl: deps.fetchImpl, now: now() }
    const listed = await listResetCredits(credentials, fetchOptions)
    if (!listed.ok) return { kind: "unavailable", error: `ChatGPT did not list the seat's resets (${listed.error})` }

    const ledger = readLedger(deps.ledgerPath)
    const attemptsOf = (key: string) => ledger.attempts.filter(a => a.creditKey === key)
    const mayTry = (key: string) => trigger === "manual"
      ? mayTryByHand(attemptsOf(key))
      : mayTryAutomatically(attemptsOf(key), now()) && ledger.decisions[key]?.decision !== "prevent"
    const candidates = listed.credits
      .flatMap(credit => credit.id ? [{ id: credit.id, key: resetCreditKey(seat, credit.id), expiresAt: credit.expiresAt }] : [])
      .filter(credit => (wanted === undefined || credit.key === wanted) && mayTry(credit.key))
    const credit = candidates[0]
    if (!credit) return { kind: "no_credit", available: listed.credits.length }

    const binding = (usage: Awaited<ReturnType<typeof fetchCodexAccountUsage>>) => usage.usage ? codexBindingWindow(usage.usage.windows)?.utilization ?? null : null
    const before = await fetchCodexAccountUsage(credentials, { ...fetchOptions, now: now() })
    const applicable = before.usage?.resetCredits?.applicableAvailableCount ?? null
    const usedBefore = binding(before)

    if (trigger !== "manual") {
      const supersede = (reason: string): ResetRedeemResult => {
        update(doc => {
          doc.attempts.push({ creditKey: credit.key, seat, expiresAt: credit.expiresAt, trigger, attemptedAt: now(), outcome: "superseded", error: reason, settledAt: now() })
        })
        return { kind: "superseded", creditKey: credit.key, reason }
      }
      const heldUntil = holds()[seat]
      if (heldUntil !== undefined) return { kind: "superseded", creditKey: credit.key, reason: `the seat is held until ${new Date(heldUntil).toISOString()} by a \"don't redeem\" decision` }
      if (!before.usage) return { kind: "unavailable", error: `ChatGPT did not answer the seat's usage (${before.error ?? "no reading"}), so nothing was sent` }
      const window = codexBindingWindow(before.usage.windows)
      const threshold = 1 - (options.nearEmptyPoints ?? 0.5) / 100
      const started = window?.resetsAt != null && window.limitWindowSeconds != null ? window.resetsAt - window.limitWindowSeconds * 1000 : null
      const pct = Math.round((usedBefore ?? 0) * 100)
      if (started !== null && now() - started < RECENT_RESET_MS && (usedBefore ?? 0) < threshold) {
        return supersede(`the seat's ${window!.type} window started ${Math.round((now() - started) / 60_000)} min ago (${pct}% used): it was just reset, here or by another instance`)
      }
      if (trigger === "usage" && (usedBefore === null || usedBefore < threshold)) {
        return supersede(`the seat's weekly window is ${usedBefore === null ? "unknown" : `${pct}% used`} now, no longer near empty`)
      }
    }

    update(doc => {
      doc.attempts.push({
        creditKey: credit.key, seat, expiresAt: credit.expiresAt, trigger,
        attemptedAt: now(), outcome: "dispatching", error: null, settledAt: null,
      })
    })
    const fail = (outcome: ResetAttemptOutcome, error: string, indeterminate: boolean): ResetRedeemResult => {
      settle(credit.key, outcome, error)
      return { kind: "failed", creditKey: credit.key, expiresAt: credit.expiresAt, error, indeterminate, outcome }
    }

    const consumed = await consumeResetCredit(credentials, credit.id, { ...fetchOptions, attempt: attemptsOf(credit.key).filter(a => a.outcome !== "superseded").length })
    if (consumed.kind === "not_sent") {
      // Nothing left the process, so the credit is untouched and free to try again.
      update(doc => { doc.attempts = doc.attempts.filter(a => !(a.creditKey === credit.key && a.outcome === "dispatching")) })
      return { kind: "unavailable", error: `the seat's access token cannot be sent (${consumed.error})` }
    }
    if (consumed.kind === "refused") {
      const refusal = `ChatGPT refused the redemption: HTTP ${consumed.status}${consumed.code ? ` ${consumed.code}` : ""}`
      return applicable === 0
        ? fail("not_applicable", `${refusal}; it counted no reset as applicable, which it does only once the seat is limited`, false)
        : fail("refused", refusal, false)
    }
    if (consumed.kind === "indeterminate") {
      return fail("indeterminate", `ChatGPT gave no usable answer${consumed.status ? ` (HTTP ${consumed.status})` : ""}; the reset may or may not be spent`, true)
    }

    const after = await listResetCredits(credentials, { ...fetchOptions, now: now() })
    if (after.ok && after.credits.some(c => c.id === credit.id)) {
      return fail("unconfirmed", "ChatGPT answered success but still lists the reset as available", true)
    }
    const usedAfter = binding(await fetchCodexAccountUsage(credentials, { ...fetchOptions, now: now() }))
    const unchanged = usedBefore !== null && usedAfter !== null
      ? usedBefore > 0 && usedAfter >= usedBefore
      : consumed.windowsReset.length === 0
    if (unchanged) {
      const pct = (u: number | null) => u === null ? "unknown" : `${Math.round(u * 100)}%`
      return fail("spent_without_reset", `ChatGPT took the reset but cleared nothing: the seat's weekly usage was ${pct(usedBefore)} before and ${pct(usedAfter)} after, windows reset: ${consumed.windowsReset.join(", ") || "none"}`, false)
    }
    settle(credit.key, "redeemed", null)
    return {
      kind: "redeemed", creditKey: credit.key, expiresAt: credit.expiresAt,
      windowsReset: consumed.windowsReset, redeemedAt: consumed.redeemedAt,
      remaining: after.ok ? after.credits.length : null,
    }
  }

  return {
    redeem(seat, trigger, options) {
      if (!deps.canRedeem()) return Promise.resolve({ kind: "not_owned" })
      if (running.has(seat)) return Promise.resolve({ kind: "in_progress" })
      const pending = run(seat, trigger, options ?? {}).finally(() => running.delete(seat))
      running.set(seat, pending)
      return pending
    },
    attempts: () => readLedger(deps.ledgerPath).attempts,
    decisions: () => Object.fromEntries(Object.entries(readLedger(deps.ledgerPath).decisions).map(([key, record]) => [key, record.decision])),
    decide(creditKey, decision, expiresAt, hold) {
      update(doc => {
        doc.decisions[creditKey] = { decision, decidedAt: now(), expiresAt, ...(hold ? { seat: hold.seat, holdUntil: hold.until } : {}) }
      })
    },
    holds,
    running: seat => running.has(seat),
  }
}
