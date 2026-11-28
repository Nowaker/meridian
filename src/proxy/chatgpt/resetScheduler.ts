/**
 * Runs the banked-reset policy (resetPolicy.ts) on a timer and redeems what
 * it says is due, through the redeemer (resetRedeem.ts).
 *
 * NOTE: agent-specific. Every tick plans every seat from its latest usage
 * reading; with auto-redeem on, a seat whose plan is due is redeemed, one
 * seat at a time per seat. What a supervisor needs to hear is reported as an
 * event:
 *
 * - `reset_planned` when a seat's next redemption changes (another reset,
 *   another trigger, or a time that moved by an hour or more);
 * - `reset_redeemed` when one went through;
 * - `reset_redeem_failed` when it did not, except a `not_applicable` refusal
 *   before the last chance: ChatGPT refuses until a seat is limited, and the
 *   reset is tried again half an hour later. When no later try fits before
 *   the reset expires, that refusal is reported too. A seat
 *   whose credentials cannot be used at its deadline is reported once.
 */

import type { CodexResetCredit, CodexUsageWindow } from "../codex/types"
import { planSeatReset, type ResetAutoRedeemSettings, type SeatResetPlan } from "./resetPolicy"
import { RESET_RETRY_AFTER_REFUSAL_MS, type ResetAttemptOutcome, type ResetRedeemer, type ResetRedeemTrigger } from "./resetRedeem"

export interface ResetSeatReading {
  seat: string
  windows: readonly CodexUsageWindow[]
  credits: readonly CodexResetCredit[] | null
  applicable: number | null
}

export interface ResetEvent {
  kind: "reset_planned" | "reset_redeemed" | "reset_redeem_failed"
  seat: string
  creditKey: string
  expiresAt: number | null
  trigger: ResetRedeemTrigger | "none"
  /** When the redemption is planned for, on `reset_planned`. */
  earliestRedeemAt: number | null
  outcome: ResetAttemptOutcome | "unavailable" | null
  error: string | null
}

export interface ResetSchedulerDeps {
  redeemer: ResetRedeemer
  /** The seats' latest readings; awaited fresh enough by `refresh` first. */
  readings: () => readonly ResetSeatReading[]
  refresh?: () => Promise<void> | undefined
  settings: () => ResetAutoRedeemSettings
  emit: (event: ResetEvent) => void
  /** After a redemption went through: lift the seat's bench and read its usage again. */
  redeemed?: (seat: string) => Promise<void>
  log?: (line: string) => void
  now?: () => number
}

export interface ResetScheduler {
  plans(): SeatResetPlan[]
  tick(): Promise<void>
}

export function createResetScheduler(deps: ResetSchedulerDeps): ResetScheduler {
  const now = deps.now ?? Date.now
  const plannedAs = new Map<string, string>()
  const reported = new Set<string>()

  const plans = (): SeatResetPlan[] => {
    const settings = deps.settings()
    const attempts = deps.redeemer.attempts()
    const decisions = deps.redeemer.decisions()
    const at = now()
    return deps.readings().map(reading => planSeatReset({ ...reading, attempts, decisions, settings, now: at }))
  }

  const event = (plan: SeatResetPlan, kind: ResetEvent["kind"], extra: Partial<ResetEvent> = {}): ResetEvent => ({
    kind, seat: plan.seat, creditKey: plan.next?.creditKey ?? "", expiresAt: plan.next?.expiresAt ?? null,
    trigger: plan.trigger, earliestRedeemAt: plan.earliestRedeemAt, outcome: null, error: null, ...extra,
  })

  const notePlanned = (plan: SeatResetPlan): void => {
    if (!plan.next || plan.trigger === "none" || plan.earliestRedeemAt === null) {
      plannedAs.delete(plan.seat)
      return
    }
    const key = `${plan.next.creditKey}|${plan.trigger}|${Math.round(plan.earliestRedeemAt / 3_600_000)}`
    if (plannedAs.get(plan.seat) === key) return
    plannedAs.set(plan.seat, key)
    deps.emit(event(plan, "reset_planned"))
  }

  async function redeem(plan: SeatResetPlan): Promise<void> {
    const next = plan.next!
    const trigger = plan.trigger as ResetRedeemTrigger
    const result = await deps.redeemer.redeem(plan.seat, trigger, { creditKey: next.creditKey })
    if (result.kind === "redeemed") {
      deps.emit(event(plan, "reset_redeemed", { outcome: "redeemed" }))
      await deps.redeemed?.(plan.seat)
      return
    }
    if (result.kind === "failed") {
      const lastChance = next.expiresAt === null || now() + RESET_RETRY_AFTER_REFUSAL_MS >= next.expiresAt
      if (result.outcome === "not_applicable" && !lastChance) {
        deps.log?.(`[PROXY] ChatGPT reset on ${plan.seat} not applicable yet; trying again in 30 min`)
        return
      }
      deps.emit(event(plan, "reset_redeem_failed", { outcome: result.outcome, error: result.error }))
      if (result.outcome === "spent_without_reset" || result.outcome === "indeterminate" || result.outcome === "unconfirmed") await deps.redeemed?.(plan.seat)
      return
    }
    if (result.kind === "unavailable" && trigger === "deadline" && !reported.has(`${next.creditKey}|unavailable`)) {
      reported.add(`${next.creditKey}|unavailable`)
      deps.emit(event(plan, "reset_redeem_failed", { outcome: "unavailable", error: result.error }))
    }
  }

  return {
    plans,
    async tick() {
      await deps.refresh?.()
      const settings = deps.settings()
      for (const plan of plans()) {
        notePlanned(plan)
        if (!settings.enabled || !plan.due || !plan.next || plan.trigger === "none" || deps.redeemer.running(plan.seat)) continue
        try {
          await redeem(plan)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          deps.log?.(`[PROXY] ChatGPT reset auto-redeem on ${plan.seat} failed: ${message}`)
          deps.emit(event(plan, "reset_redeem_failed", { outcome: "indeterminate", error: `Meridian could not record the redemption: ${message}` }))
        }
      }
    },
  }
}

/** Run `tick` every `intervalMs`, never two at once; the first runs at once. */
export function startResetSchedule(tick: () => Promise<void>, log: (line: string) => void, intervalMs = 60_000): { stop(): Promise<void> } {
  let settled: Promise<void> = Promise.resolve()
  let running = false
  const look = () => {
    if (running) return
    running = true
    settled = tick().then(() => undefined, error => {
      log(`[PROXY] ChatGPT reset schedule tick failed: ${error instanceof Error ? error.message : String(error)}`)
    }).finally(() => { running = false })
  }
  look()
  const timer = setInterval(look, intervalMs)
  timer.unref?.()
  return {
    stop() {
      clearInterval(timer)
      return settled
    },
  }
}
