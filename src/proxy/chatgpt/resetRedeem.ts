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
 * ended. The ledger is what keeps a credit from being tried twice: a crash
 * between the write and the answer leaves the credit marked as tried, never
 * as free to try again. Automatic redemptions skip any credit the ledger
 * names; a person's redeem skips only those that may have been spent (a
 * refusal left the credit intact, so a person may try it again). One
 * redemption runs per seat at a time.
 *
 * After a consume answers success the credits are listed once more: a reset
 * the backend still lists as available was not redeemed, whatever the answer
 * said, and is reported as unconfirmed.
 */

import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { consumeResetCredit, listResetCredits } from "./resetCredits"
import type { CodexCredentials } from "../codex/usage"
import type { ChatGptCredentialSource } from "./source"

export type ResetRedeemTrigger = "manual" | "deadline" | "usage"

/** How an attempt ended; `dispatching` means the consume was sent and no answer was recorded. */
export type ResetAttemptOutcome = "dispatching" | "redeemed" | "refused" | "indeterminate" | "unconfirmed"

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
  | { kind: "failed"; creditKey: string; expiresAt: number | null; error: string; indeterminate: boolean }
  | { kind: "no_credit"; available: number }
  | { kind: "unavailable"; error: string }
  | { kind: "in_progress" }
  | { kind: "not_owned" }

export interface ResetRedeemer {
  /**
   * Redeem the seat's soonest-expiring credit that may be tried, or, with
   * `creditKey`, that credit only.
   */
  redeem(seat: string, trigger: ResetRedeemTrigger, options?: { creditKey?: string }): Promise<ResetRedeemResult>
  /** Every recorded attempt, oldest first. */
  attempts(): ResetAttempt[]
  /** Whether a redemption is running for the seat. */
  running(seat: string): boolean
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

export function resetCreditKey(seat: string, creditId: string): string {
  return createHash("sha256").update(`${seat}\u0000${creditId}`).digest("hex").slice(0, 16)
}

interface LedgerDoc {
  version: 1
  attempts: ResetAttempt[]
}

function readLedger(path: string): LedgerDoc {
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, attempts: [] }
    throw error
  }
  const parsed = JSON.parse(raw) as Partial<LedgerDoc>
  if (parsed.version !== 1 || !Array.isArray(parsed.attempts)) throw new Error(`unreadable reset ledger ${path}`)
  return { version: 1, attempts: parsed.attempts }
}

function writeLedger(path: string, doc: LedgerDoc): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 })
  renameSync(temp, path)
}

/** A credit an automatic redemption may not try: any attempt at all. */
const triedForAutomatic = (attempt: ResetAttempt | undefined): boolean => attempt !== undefined
/** A credit a person's redeem may not try: one that may have been spent. */
const triedForManual = (attempt: ResetAttempt | undefined): boolean => attempt !== undefined && attempt.outcome !== "refused"

export function createResetRedeemer(deps: ResetRedeemerDeps): ResetRedeemer {
  const now = deps.now ?? Date.now
  const running = new Map<string, Promise<ResetRedeemResult>>()

  const update = (mutate: (doc: LedgerDoc) => void): void => {
    const doc = readLedger(deps.ledgerPath)
    mutate(doc)
    const at = now()
    doc.attempts = doc.attempts.filter(a => a.expiresAt === null || a.expiresAt + ATTEMPT_RETENTION_MS > at)
    writeLedger(deps.ledgerPath, doc)
  }
  const settle = (creditKey: string, outcome: ResetAttemptOutcome, error: string | null): void => {
    update(doc => {
      const attempt = doc.attempts.findLast(a => a.creditKey === creditKey)
      if (attempt) Object.assign(attempt, { outcome, error, settledAt: now() })
    })
  }

  async function run(seat: string, trigger: ResetRedeemTrigger, wanted: string | undefined): Promise<ResetRedeemResult> {
    const credential = await deps.source.credentials(seat)
    if (!credential.ok) return { kind: "unavailable", error: `the seat's credentials cannot be used (${credential.reason})` }
    const credentials: CodexCredentials = {
      accountId: credential.account.accountId,
      accountUserId: credential.account.accountUserId,
      accessToken: credential.account.accessToken,
      email: null,
    }
    const options = { fetchImpl: deps.fetchImpl, now: now() }
    const listed = await listResetCredits(credentials, options)
    if (!listed.ok) return { kind: "unavailable", error: `ChatGPT did not list the seat's resets (${listed.error})` }

    const attempts = new Map(readLedger(deps.ledgerPath).attempts.map(a => [a.creditKey, a]))
    const tried = trigger === "manual" ? triedForManual : triedForAutomatic
    const candidates = listed.credits
      .flatMap(credit => credit.id ? [{ id: credit.id, key: resetCreditKey(seat, credit.id), expiresAt: credit.expiresAt }] : [])
      .filter(credit => (wanted === undefined || credit.key === wanted) && !tried(attempts.get(credit.key)))
    const credit = candidates[0]
    if (!credit) return { kind: "no_credit", available: listed.credits.length }

    update(doc => {
      doc.attempts.push({
        creditKey: credit.key, seat, expiresAt: credit.expiresAt, trigger,
        attemptedAt: now(), outcome: "dispatching", error: null, settledAt: null,
      })
    })
    const fail = (outcome: ResetAttemptOutcome, error: string, indeterminate: boolean): ResetRedeemResult => {
      settle(credit.key, outcome, error)
      return { kind: "failed", creditKey: credit.key, expiresAt: credit.expiresAt, error, indeterminate }
    }

    const consumed = await consumeResetCredit(credentials, credit.id, options)
    if (consumed.kind === "not_sent") {
      // Nothing left the process, so the credit is untouched and free to try again.
      update(doc => { doc.attempts = doc.attempts.filter(a => !(a.creditKey === credit.key && a.outcome === "dispatching")) })
      return { kind: "unavailable", error: `the seat's access token cannot be sent (${consumed.error})` }
    }
    if (consumed.kind === "refused") {
      return fail("refused", `ChatGPT refused the redemption: HTTP ${consumed.status}${consumed.code ? ` ${consumed.code}` : ""}`, false)
    }
    if (consumed.kind === "indeterminate") {
      return fail("indeterminate", `ChatGPT gave no usable answer${consumed.status ? ` (HTTP ${consumed.status})` : ""}; the reset may or may not be spent`, true)
    }

    const after = await listResetCredits(credentials, { ...options, now: now() })
    if (after.ok && after.credits.some(c => c.id === credit.id)) {
      return fail("unconfirmed", "ChatGPT answered success but still lists the reset as available", true)
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
      const pending = run(seat, trigger, options?.creditKey).finally(() => running.delete(seat))
      running.set(seat, pending)
      return pending
    },
    attempts: () => readLedger(deps.ledgerPath).attempts,
    running: seat => running.has(seat),
  }
}
