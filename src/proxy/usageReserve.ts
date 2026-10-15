/**
 * Usage reserves: how far Meridian may take one profile's 5-hour and weekly
 * windows, so the rest of each stays with the account's owner for use
 * elsewhere - a phone app, the vendor's own site.
 *
 * Each window takes a floor and a ceiling, in percent of the window. At
 * elapsed fraction `t` of the window the allowance is
 * `clamp(100t, floor, ceiling)`: equal bounds are a flat cap, and a floor below
 * the ceiling lets the floor be used at once and the rest only as the window
 * elapses - 95% allowed at 95% through. A profile whose usage is at or above
 * its allowance in either window is HELD BACK: it takes no new work until the
 * allowance passes what it has used, or the window resets.
 *
 * The bounds come from outside. A supervisor that owns profile policy writes
 * them through `PUT /settings/api/routing`, as it writes the managed
 * exclusions; this module only reads them, and draws the same curve the
 * supervisor draws from the same readings, so the two agree on what is held.
 *
 * Pure leaf module: no I/O, and no imports from `server.ts` or `session/`.
 */

import { retryAfterBodyFields, retryAfterHeaders, retryAfterSeconds } from "./retryAfter"

export const USAGE_RESERVE_WINDOWS = ["five_hour", "seven_day"] as const
export type UsageReserveWindow = (typeof USAGE_RESERVE_WINDOWS)[number]

const HOUR_MS = 3_600_000

/** Each window's width, which is what turns a reset time into elapsed time. */
export const USAGE_RESERVE_WINDOW_MS: Readonly<Record<UsageReserveWindow, number>> = {
  five_hour: 5 * HOUR_MS,
  seven_day: 168 * HOUR_MS,
}

/** How old a reading may grow before work for a reserved profile renews it. */
export const USAGE_RESERVE_READING_MAX_AGE_MS = 60_000

/** Percent of the window, `0 < floor <= ceiling <= 100`. */
export interface UsageReserveBounds {
  readonly floor: number
  readonly ceiling: number
}

/** One profile's bounds per window; a window without an entry has no reserve. */
export type UsageReserve = Readonly<Partial<Record<UsageReserveWindow, UsageReserveBounds>>>

/** Per profile id. A profile without an entry has no reserve. */
export type UsageReserveMap = Readonly<Record<string, UsageReserve>>

/**
 * A percentage a reserve may name: above zero, at most the whole window. Zero
 * is refused because it is a deadlock rather than a strict setting: a window
 * that has not started allows its floor, so a floor of zero allows nothing,
 * nothing is ever sent, and the window never starts.
 */
function isReservePct(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 100
}

function isWindow(value: string): value is UsageReserveWindow {
  return (USAGE_RESERVE_WINDOWS as readonly string[]).includes(value)
}

/** One profile's bounds, or why they cannot be drawn. */
function parseReserve(raw: unknown): UsageReserve | string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "must map windows to { floor, ceiling }"
  const out: Partial<Record<UsageReserveWindow, UsageReserveBounds>> = {}
  for (const [window, bounds] of Object.entries(raw as Record<string, unknown>)) {
    if (!isWindow(window)) return `unknown window "${window}" (expected ${USAGE_RESERVE_WINDOWS.join(" or ")})`
    if (!bounds || typeof bounds !== "object" || Array.isArray(bounds)) return `${window} must be { floor, ceiling }`
    const { floor, ceiling } = bounds as Record<string, unknown>
    if (!isReservePct(floor) || !isReservePct(ceiling)) {
      return `${window} floor and ceiling must be percentages above 0 and at most 100`
    }
    if (floor > ceiling) return `${window} floor is above its ceiling`
    out[window] = { floor, ceiling }
  }
  return out
}

/** A `usageReserves` write, refused whole when any entry cannot be drawn. */
export function parseUsageReserves(
  raw: unknown,
): { readonly ok: true; readonly value: UsageReserveMap } | { readonly ok: false; readonly error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "usageReserves must be an object keyed by profile id" }
  }
  const out: Record<string, UsageReserve> = {}
  for (const [id, entry] of Object.entries(raw as Record<string, unknown>)) {
    const parsed = parseReserve(entry)
    if (typeof parsed === "string") return { ok: false, error: `usageReserves.${id}: ${parsed}` }
    if (Object.keys(parsed).length > 0) out[id] = parsed
  }
  return { ok: true, value: out }
}

/**
 * The stored map, with any entry that cannot be drawn dropped. Read per
 * request, so a hand-edited settings file costs that one entry rather than
 * failing every turn.
 */
export function readUsageReserves(raw: unknown): UsageReserveMap {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  const out: Record<string, UsageReserve> = {}
  for (const [id, entry] of Object.entries(raw as Record<string, unknown>)) {
    const parsed = parseReserve(entry)
    if (typeof parsed !== "string" && Object.keys(parsed).length > 0) out[id] = parsed
  }
  return out
}

/** One usage window, in the `/v1/usage/quota` vocabulary every provider is read into. */
export interface ReserveWindowReading {
  readonly type: string
  /** Consumed fraction, 0..1. */
  readonly utilization: number | null
  /** Epoch ms of the reset; null for a window that has not started. */
  readonly resetsAt: number | null
}

export interface UsageReserveState {
  readonly window: UsageReserveWindow
  readonly floor: number
  readonly ceiling: number
  /** What may be used now, in percent. */
  readonly allowancePct: number
  /** What the reading says is used, in percent; 0 for a window that is not running. */
  readonly usedPct: number
  readonly held: boolean
  /**
   * When the hold ends: the instant a paced allowance passes what is used, or
   * the window's reset when only a reset will do. Null when not held, or when
   * the reading names no reset.
   */
  readonly opensAt: number | null
}

function running(w: ReserveWindowReading | undefined, now: number): w is ReserveWindowReading & { resetsAt: number } {
  return w !== undefined && typeof w.resetsAt === "number" && w.resetsAt > now
}

/** The allowance at elapsed fraction `t`, in percent. */
export function usageReserveAllowancePct(bounds: UsageReserveBounds, t: number): number {
  return Math.min(bounds.ceiling, Math.max(bounds.floor, t * 100))
}

/**
 * Each reserved window's state, the weekly first. A window that is not
 * running holds nothing: it has reset, or never started, whatever an older
 * reading of it said.
 */
export function usageReserveStates(
  windows: readonly ReserveWindowReading[],
  reserve: UsageReserve,
  now: number,
): UsageReserveState[] {
  const out: UsageReserveState[] = []
  for (const window of ["seven_day", "five_hour"] as const) {
    const bounds = reserve[window]
    if (!bounds) continue
    const w = windows.find(candidate => candidate.type === window)
    const live = running(w, now)
    const t = live ? Math.min(1, Math.max(0, 1 - (w.resetsAt - now) / USAGE_RESERVE_WINDOW_MS[window])) : 0
    const allowancePct = usageReserveAllowancePct(bounds, t)
    const usedPct = live && typeof w.utilization === "number" && Number.isFinite(w.utilization)
      ? Math.min(100, Math.max(0, w.utilization * 100))
      : 0
    const held = usedPct >= allowancePct
    // Below the ceiling a paced allowance catches up with what is used once
    // 100t reaches it; at or above the ceiling nothing short of a reset will do.
    const opensAt = !held || !live
      ? null
      : usedPct < bounds.ceiling
        ? w.resetsAt - (1 - usedPct / 100) * USAGE_RESERVE_WINDOW_MS[window]
        : w.resetsAt
    out.push({ window, floor: bounds.floor, ceiling: bounds.ceiling, allowancePct, usedPct, held, opensAt })
  }
  return out
}

/** The window holding this profile back, the weekly first; null when none does. */
export function usageReserveHold(
  windows: readonly ReserveWindowReading[],
  reserve: UsageReserve | undefined,
  now: number,
): UsageReserveState | null {
  if (!reserve) return null
  return usageReserveStates(windows, reserve, now).find(state => state.held) ?? null
}

/** `95`, `97.5`: a percentage to at most one decimal. */
function pct(value: number): string {
  return String(Math.round(value * 10) / 10)
}

/** `weekly at 95%, capped at 95%` / `5-hour at 82%, 80% allowed now, paced from 80% to 100%`. */
export function describeUsageReserveHold(state: UsageReserveState): string {
  const window = state.window === "five_hour" ? "5-hour" : "weekly"
  const shape = state.floor === state.ceiling
    ? `capped at ${pct(state.ceiling)}%`
    : `${pct(state.allowancePct)}% allowed now, paced from ${pct(state.floor)}% to ${pct(state.ceiling)}%`
  return `${window} at ${pct(state.usedPct)}%, ${shape}`
}

/** The soonest a hold among these opens, or null when none names a time. */
export function soonestOpening(holds: readonly UsageReserveState[]): number | null {
  const times = holds.map(hold => hold.opensAt).filter((at): at is number => at !== null)
  return times.length > 0 ? Math.min(...times) : null
}

/** One SDK rate-limit event, as `rateLimitStore` keeps it. */
export interface SdkWindowEvent {
  readonly rateLimitType?: string
  readonly utilization?: number
  readonly resetsAt?: number
  readonly observedAt: number
}

/**
 * A Claude profile's newest reading of each window: the OAuth snapshot,
 * overlaid by any SDK rate-limit event observed after it that states a
 * utilization. The SDK reports from real requests between snapshots, which is
 * exactly when a profile crosses its allowance.
 */
export function newestClaudeWindows(
  oauth: { readonly windows: readonly ReserveWindowReading[]; readonly fetchedAt: number } | undefined,
  sdk: readonly SdkWindowEvent[],
): ReserveWindowReading[] {
  const byType = new Map<string, ReserveWindowReading>((oauth?.windows ?? []).map(w => [w.type, w]))
  const since = oauth?.fetchedAt ?? Number.NEGATIVE_INFINITY
  for (const event of sdk) {
    if (!event.rateLimitType || typeof event.utilization !== "number" || event.observedAt <= since) continue
    const earlier = byType.get(event.rateLimitType)
    byType.set(event.rateLimitType, {
      type: event.rateLimitType,
      utilization: event.utilization,
      resetsAt: event.resetsAt ?? earlier?.resetsAt ?? null,
    })
  }
  return [...byType.values()]
}

/** A window's bounds and allowance, for a profile card. */
export interface UsageReserveWindowView extends UsageReserveBounds {
  /** What may be used now, in percent. */
  readonly allowance: number
  readonly held: boolean
}

/** What `/v1/usage/quota/all` reports about one profile's reserve. */
export interface UsageReserveView {
  readonly held: boolean
  /** Why it is held, in the words a card prints; null while it is not. */
  readonly reason: string | null
  readonly opensAt: number | null
  readonly windows: Readonly<Partial<Record<UsageReserveWindow, UsageReserveWindowView>>>
}

/** The reserve as a card draws it, from the windows the card shows; null for a profile without one. */
export function usageReserveView(
  windows: readonly ReserveWindowReading[],
  reserve: UsageReserve | undefined,
  now: number,
): UsageReserveView | null {
  if (!reserve || Object.keys(reserve).length === 0) return null
  const states = usageReserveStates(windows, reserve, now)
  const hold = states.find(state => state.held) ?? null
  const views: Partial<Record<UsageReserveWindow, UsageReserveWindowView>> = {}
  for (const state of states) {
    views[state.window] = { floor: state.floor, ceiling: state.ceiling, allowance: state.allowancePct, held: state.held }
  }
  return {
    held: hold !== null,
    reason: hold ? describeUsageReserveHold(hold) : null,
    opensAt: hold?.opensAt ?? null,
    windows: views,
  }
}

/**
 * Work Meridian will not send because every profile it could go to is held
 * back by its usage reserve - or a request that named a held one. Anthropic's
 * rate-limit shape, so a client waits instead of failing, and told when the
 * soonest reserve opens: the share kept back is not spent to answer it.
 */
export function usageReserveResponse(message: string, opensAt: number | null, now: number): Response {
  const seconds = retryAfterSeconds({ status: 429, resetAtMs: opensAt, now })
  return new Response(JSON.stringify({
    type: "error",
    error: { type: "rate_limit_error", message, ...retryAfterBodyFields(seconds) },
  }), {
    status: 429,
    headers: { "Content-Type": "application/json", ...retryAfterHeaders(seconds) },
  })
}

/** The refusal for work with nowhere to go but profiles their reserves hold back. */
export function allHeldMessage(holds: ReadonlyMap<string, UsageReserveState>): string {
  const named = [...holds].map(([id, hold]) => `${id} (${describeUsageReserveHold(hold)})`).join("; ")
  return `Every eligible profile is held back by its usage reserve: ${named}. `
    + "The rest of each window is kept for use elsewhere, so this request was not sent."
}
