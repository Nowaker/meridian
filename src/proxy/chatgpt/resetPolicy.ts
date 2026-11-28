/**
 * When Meridian spends a ChatGPT seat's banked reset by itself.
 *
 * NOTE: agent-specific. Pure: no I/O, no clock of its own. The scheduler
 * (resetScheduler.ts) feeds it the seat's latest usage reading, the reset
 * ledger and the operator's decisions, and redeems what it says is due.
 *
 * A redeemed reset clears the seat's windows and keeps its renewal date, so a
 * reset is worth most when it is spent as late as possible: just before the
 * seat runs out, or just before the reset expires. Only the binding window
 * counts (codex/windows.ts `codexBindingWindow`); a 5-hour window refills by
 * itself and never triggers. For the seat's soonest-expiring reset that may
 * still be tried (expiry E, binding window renewal R, safety margin M):
 *
 * - deadline: at E - M the reset is redeemed, whatever the usage;
 * - usage: once the binding window has at most `nearEmptyPoints` percentage
 *   points left, it is redeemed - but only when R >= E - M. A seat that
 *   renews before the deadline gets its quota back for free, so the reset
 *   waits for the deadline instead.
 *
 * Measured 2026-11-28 on ten live seats: ChatGPT reports a reset as
 * applicable (`applicable_available_count` > 0) only once the seat is limited
 * (`limit_reached`), and a seat Meridian stops sending work to at 100% may
 * never get there. So a due reset is tried regardless; a refusal does not
 * spend it, and it is tried again every RESET_RETRY_AFTER_REFUSAL_MS until it
 * expires.
 *
 * The plan is computed whether or not auto-redeem is on, so a supervisor can
 * see what would happen before it is turned on.
 */

import type { CodexResetCredit, CodexUsageWindow } from "../codex/types"
import { codexBindingWindow } from "../codex/windows"
import { isIntactRefusal, mayTryAutomatically, RESET_RETRY_AFTER_REFUSAL_MS, resetCreditKey, type ResetAttempt, type ResetDecision } from "./resetRedeem"

export interface ResetAutoRedeemSettings {
  enabled: boolean
  /** Percentage points of the binding window left at which the usage trigger fires. */
  nearEmptyPoints: number
  /** How long before a reset expires the deadline trigger fires, in hours. */
  safetyMarginHours: number
  /** How long before a redeem a supervisor (Vibeterm) asks about it, in hours. Meridian only reports it. */
  askAheadHours: number
}

export type ResetTrigger = "deadline" | "usage" | "none"
export type ResetPlanDecision = "pending" | "approved" | "prevented"

export interface ResetPlanAttempt {
  trigger: ResetAttempt["trigger"]
  attemptedAt: number
  outcome: ResetAttempt["outcome"]
  error: string | null
}

export interface SeatResetPlan {
  seat: string
  available: number
  /** The reset the next redemption spends, or null when none may be tried. */
  next: { creditKey: string; expiresAt: number | null } | null
  binding: { type: string; utilization: number | null; resetsAt: number | null } | null
  /** ChatGPT's own count of resets it would redeem right now. */
  applicable: number | null
  /** The trigger that fires next, or `none` when none will. */
  trigger: ResetTrigger
  /** True when `trigger` is due now. */
  due: boolean
  /** When the redemption happens: exact for the deadline, projected from the seat's pace for usage; null when unknown. */
  earliestRedeemAt: number | null
  /** The deadline of the next reset (E - M), or null when its expiry is unknown. */
  deadlineAt: number | null
  decision: ResetPlanDecision
  /** Why, in a sentence for a person. */
  reason: string
  lastAttempt: ResetPlanAttempt | null
}

export interface SeatResetInput {
  seat: string
  windows: readonly CodexUsageWindow[]
  credits: readonly CodexResetCredit[] | null
  applicable: number | null
  attempts: readonly ResetAttempt[]
  decisions: Readonly<Record<string, ResetDecision>>
  settings: ResetAutoRedeemSettings
  now: number
}

const DECISION: Record<ResetDecision, ResetPlanDecision> = { approve: "approved", prevent: "prevented" }

/**
 * When the binding window reaches `threshold` used at the pace it has been
 * used since it started; null when it has not started, nothing is used yet,
 * or it renews first.
 */
function projectedEmpty(window: CodexUsageWindow, threshold: number, now: number): number | null {
  const u = window.utilization
  if (u === null || window.resetsAt === null || window.limitWindowSeconds === null) return null
  if (u >= threshold) return now
  const started = window.resetsAt - window.limitWindowSeconds * 1000
  const elapsed = now - started
  if (u <= 0 || elapsed <= 0) return null
  const at = now + (threshold - u) / (u / elapsed)
  return at < window.resetsAt ? at : null
}

const when = (ms: number) => new Date(ms).toISOString().replace(/:\d\d\.\d+Z$/, "Z")

export function planSeatReset(input: SeatResetInput): SeatResetPlan {
  const { seat, settings, now } = input
  const window = codexBindingWindow(input.windows)
  const binding = window ? { type: window.type, utilization: window.utilization, resetsAt: window.resetsAt } : null
  const bySeat = input.attempts.filter(a => a.seat === seat)
  const credits = (input.credits ?? []).flatMap(c => c.id ? [{ creditKey: resetCreditKey(seat, c.id), expiresAt: c.expiresAt }] : [])
  const attemptsOf = (key: string) => bySeat.filter(a => a.creditKey === key)
  const decisionOf = (key: string): ResetPlanDecision => {
    const decided = input.decisions[key]
    return decided ? DECISION[decided] : "pending"
  }
  const candidates = credits.filter(c => (c.expiresAt === null || c.expiresAt > now) && input.decisions[c.creditKey] !== "prevent")
  // The credit to plan for: the soonest one a scheduled redemption may try
  // now, else the soonest one only waiting out a refusal's half hour.
  const next = candidates.find(c => mayTryAutomatically(attemptsOf(c.creditKey), now))
    ?? candidates.find(c => attemptsOf(c.creditKey).every(a => isIntactRefusal(a.outcome))) ?? null
  const last = next ? attemptsOf(next.creditKey).at(-1) : bySeat.at(-1)
  const base = {
    seat, available: input.credits?.length ?? 0, binding, applicable: input.applicable,
    lastAttempt: last ? { trigger: last.trigger, attemptedAt: last.attemptedAt, outcome: last.outcome, error: last.error } : null,
  }
  const none = (reason: string, nextCredit: SeatResetPlan["next"] = null): SeatResetPlan => ({
    ...base, next: nextCredit, trigger: "none", due: false, earliestRedeemAt: null, deadlineAt: null,
    decision: nextCredit ? decisionOf(nextCredit.creditKey) : "pending", reason,
  })

  if (input.credits === null) return none("ChatGPT did not list this seat's resets.")
  if (credits.length === 0) return none("This seat has no banked reset.")
  if (!next) return none("Every banked reset of this seat was prevented or already tried.")
  const nextCredit = { creditKey: next.creditKey, expiresAt: next.expiresAt }
  if (next.expiresAt === null) return none("The reset's expiry is unknown, so no deadline applies.", nextCredit)
  const expiresAt = next.expiresAt

  const deadlineAt = expiresAt - settings.safetyMarginHours * 3_600_000
  const threshold = 1 - settings.nearEmptyPoints / 100
  const refusedAt = last !== undefined && isIntactRefusal(last.outcome) ? last.attemptedAt : null
  const retryAt = refusedAt === null ? now : refusedAt + RESET_RETRY_AFTER_REFUSAL_MS
  if (retryAt >= expiresAt) return none(`ChatGPT refused the last try, and the reset expires ${when(expiresAt)}, before another.`, nextCredit)
  const retrying = refusedAt === null ? "" : ` ChatGPT refused the last try; trying again from ${when(retryAt)}.`
  const plan = (trigger: ResetTrigger, at: number, reason: string): SeatResetPlan => {
    const earliest = Math.max(at, retryAt)
    return {
      ...base, next: nextCredit, trigger, due: earliest <= now, earliestRedeemAt: earliest, deadlineAt,
      decision: decisionOf(next.creditKey), reason,
    }
  }

  if (now >= deadlineAt) return plan("deadline", deadlineAt, `The reset expires ${when(expiresAt)}; its deadline has passed.${retrying}`)
  if (!window || window.resetsAt === null || window.resetsAt < deadlineAt) {
    return plan("deadline", deadlineAt, window?.resetsAt != null
      ? `The ${window.type} window renews ${when(window.resetsAt)}, before the reset's deadline, so the reset waits for its deadline.`
      : "No binding window is known, so the reset waits for its deadline.")
  }
  const empty = projectedEmpty(window, threshold, now)
  if (empty !== null && empty <= now) {
    return plan("usage", now, `The ${window.type} window is ${Math.round((window.utilization ?? 0) * 100)}% used and renews only ${when(window.resetsAt)}, after the reset's deadline.${retrying}`)
  }
  if (empty !== null && empty < deadlineAt) {
    return plan("usage", empty, `At its pace the ${window.type} window runs out around ${when(empty)}, before the reset's deadline.`)
  }
  return plan("deadline", deadlineAt, `The ${window.type} window should not run out before the reset's deadline.`)
}
