/**
 * ChatGPT usage windows to an absolute bench-until instant.
 *
 * Pure. Meridian's rotation already speaks in opaque profile ids and absolute
 * `until` timestamps (`routing.ts`), so nothing downstream needs to change -
 * what needs translating is the vocabulary, and the translation has two traps
 * in it.
 *
 * THE FIRST IS THAT POSITION DOES NOT IMPLY WIDTH. `rate_limit` carries a
 * `primary_window` and a `secondary_window`, and reading primary as "the
 * five-hour one" is wrong on four of the six accounts this was measured
 * against: pro and business-prolite both report their WEEKLY window as the
 * primary, free reports a 30-day one there, and only team uses the
 * 5h-primary / weekly-secondary layout. Width therefore comes from
 * `limit_window_seconds` and from nowhere else.
 *
 * THE SECOND IS THE UNIT. `reset_at` is epoch SECONDS - the reference
 * implementation multiplies it by 1000 and falls back to
 * `reset_after_seconds` only when it is absent. Read as milliseconds every
 * reset lands in 1970, every window looks long expired, and no account is
 * ever benched at all.
 */

export interface ChatGptUsageWindow {
  used_percent?: number
  /** Window WIDTH in seconds. The only thing that says what kind of window this is. */
  limit_window_seconds?: number
  /** Epoch SECONDS, not milliseconds. */
  reset_at?: number
  reset_after_seconds?: number
}

export interface ChatGptRateLimit {
  allowed?: boolean
  limit_reached?: boolean
  primary_window?: ChatGptUsageWindow | null
  secondary_window?: ChatGptUsageWindow | null
}

const HOUR_MS = 3_600_000

/**
 * The longest any single bench may last, for a window whose width the
 * provider did not state. 31 days because a 30-day free-tier window is real
 * and observed; anything past that is a garbage value rather than a quota.
 */
const MAX_COOLDOWN_MS = 31 * 24 * HOUR_MS

/** A window is spent at 100 percent. Below that it is evidence of nothing. */
const SPENT_PERCENT = 100

/**
 * The furthest out a reset for a window of this width can legitimately be.
 *
 * Per-width rather than one constant, and that is the entire point: a single
 * cap either flattens a 30-day reset into something far shorter - resuming a
 * spent account weeks early and re-probing it with real failing requests - or
 * lets a five-hour window bench an account for a month. The slack is an hour
 * or a tenth of the window, whichever is larger, which reproduces the
 * six-hour cap Anthropic's five-hour window already uses in routing.ts.
 */
export function chatGptCooldownCapMs(limitWindowSeconds: number | null | undefined): number {
  if (typeof limitWindowSeconds !== "number"
    || !Number.isFinite(limitWindowSeconds)
    || limitWindowSeconds <= 0) return MAX_COOLDOWN_MS
  const widthMs = limitWindowSeconds * 1000
  return Math.min(widthMs + Math.max(HOUR_MS, widthMs * 0.1), MAX_COOLDOWN_MS)
}

function windowWidthSeconds(window: ChatGptUsageWindow): number | null {
  const width = window.limit_window_seconds
  return typeof width === "number" && Number.isFinite(width) && width > 0 ? width : null
}

function isSpent(window: ChatGptUsageWindow): boolean {
  const used = window.used_percent
  return typeof used === "number" && Number.isFinite(used) && used >= SPENT_PERCENT
}

function resetInstant(window: ChatGptUsageWindow, now: number): number | null {
  const at = window.reset_at
  if (typeof at === "number" && Number.isFinite(at) && at > 0) return at * 1000
  const after = window.reset_after_seconds
  if (typeof after === "number" && Number.isFinite(after) && after > 0) return now + after * 1000
  return null
}

/**
 * When this account frees up, or null when nothing here proves it is capped.
 *
 * Null is a real answer rather than a failure: the caller keeps its own
 * conservative default, exactly as `findCooldownReset` does for Anthropic.
 * Inventing an instant from a spent window that named no reset would dress a
 * guess up as an observation, and inventing one from a bare `limit_reached`
 * would bench a five-hour problem for a week or a weekly one for five hours,
 * depending on which way the guess fell.
 */
export function chatGptCooldownUntil(
  rateLimit: ChatGptRateLimit | null | undefined,
  now: number,
): number | null {
  if (!rateLimit) return null

  let best: { width: number; until: number } | null = null
  for (const window of [rateLimit.primary_window, rateLimit.secondary_window]) {
    if (!window || !isSpent(window)) continue
    const reset = resetInstant(window, now)
    if (reset === null || reset <= now) continue

    const width = windowWidthSeconds(window)
    const until = Math.min(reset, now + chatGptCooldownCapMs(width))
    // The LONGEST spent window wins. An account inside its weekly cap is still
    // unusable when the five-hour one rolls over, so benching to the shorter
    // reset just resumes probing an account that cannot serve.
    if (!best || (width ?? 0) > best.width) best = { width: width ?? 0, until }
  }

  return best?.until ?? null
}
