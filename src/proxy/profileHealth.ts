/**
 * What we know, right now, about accounts that have just been refused.
 *
 * Two stores, both in-memory and both deliberately not persisted - this is
 * observability and routing hygiene, not durable truth. After a restart the
 * next refusal re-establishes everything.
 *
 * `SpentStore` holds the latest refusal per profile, so a UI can say "this
 * account is refusing" alongside the cached percentages instead of replacing
 * them. Measured on the live fleet: an account rendered `5h 67% / 7d 7%` while
 * every request through it was being refused, because those percentages are a
 * snapshot of the last successful read and a refusal never touched them.
 *
 * `FailoverEventLog` is a bounded, monotonically numbered event ring so an
 * external supervisor (vibeterm's account switcher) can poll for refusals and
 * failovers. It exists because `claudeLog("profile.failover", …)` went to the
 * log and nowhere else, and because `/telemetry/requests` - the obvious place
 * to look - is a 500-row ring with no cursor, so a poller cannot tell "nothing
 * happened" from "it scrolled past between polls". The `since` cursor here is
 * the fix for exactly that.
 *
 * Leaf module: no I/O, no imports from server.ts. Clocks are injectable so the
 * tests do not depend on wall time.
 */

import type { LimitDiagnosis } from "./limitDetection"
import type { WeeklyModelFamily } from "./routing"

export interface SpentRecord {
  profileId: string
  /** When the refusal was observed (epoch ms). */
  at: number
  diagnosis: LimitDiagnosis
  /** When this account is expected to serve again, when known. */
  until: number | null
  /** Truncated raw SDK message - the operator's evidence for the verdict. */
  message: string
  /**
   * The model family routing benched this profile for alone, when this
   * refusal came from that family's own weekly bucket and matched the refused
   * request's model. Null for every refusal that benches the whole profile or
   * none: account-wide, unknown, guessed, billing, another family's bucket,
   * and refusals outside pool routing.
   */
  modelFamily: WeeklyModelFamily | null
}

/**
 * How long a refusal stands when nothing told us when the window reopens.
 * Matches the priority router's own conservative default, so an account is
 * never shown as spent for longer than routing would avoid it.
 */
const SPENT_DEFAULT_TTL_MS = 10 * 60_000
/** Longest a single refusal is allowed to keep an account marked spent. */
const SPENT_MAX_TTL_MS = 6 * 60 * 60_000

/**
 * Latest refusal per profile, dropped on read once it expires (the same
 * read-time expiry `ProfileExhaustion` uses, so the two never disagree about
 * whether an account is currently in trouble).
 */
export class SpentStore {
  private readonly records = new Map<string, SpentRecord>()

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Record a refusal. A later record always replaces an earlier one: unlike an
   * exhaustion mark (where a longer cooldown must win), the newest refusal is
   * by definition the best description of the account's current state.
   */
  record(profileId: string, diagnosis: LimitDiagnosis, message: string): SpentRecord {
    const at = this.now()
    const resets = diagnosis.resetsAt
    const until = resets && resets > at
      ? Math.min(resets, at + SPENT_MAX_TTL_MS)
      : at + SPENT_DEFAULT_TTL_MS
    const record: SpentRecord = {
      profileId,
      at,
      diagnosis,
      until,
      message: message.length > 300 ? `${message.slice(0, 300)}…` : message,
      modelFamily: null,
    }
    this.records.set(profileId, record)
    return record
  }

  get(profileId: string): SpentRecord | undefined {
    const record = this.records.get(profileId)
    if (!record) return undefined
    if (record.until !== null && record.until <= this.now()) {
      this.records.delete(profileId)
      return undefined
    }
    return record
  }

  /** Live records only - expired ones are dropped on read. */
  snapshot(): SpentRecord[] {
    const out: SpentRecord[] = []
    for (const id of [...this.records.keys()]) {
      const record = this.get(id)
      if (record) out.push(record)
    }
    return out
  }

  clear(): void {
    this.records.clear()
  }

  forget(profileId: string): void {
    this.records.delete(profileId)
  }
}

/**
 * `refused`        - an account said no. Emitted in every routing mode, so an
 *                    exhausted account is visible even when nothing failed over.
 * `failover`       - a request was re-issued on another account and succeeded,
 *                    so the client never saw the refusal.
 * `pool_exhausted` - no Claude account could take the request; the client got
 *                    the error. Opens or carries the pool incident.
 * `pool_recovered` - a Claude account served a request again; closes the
 *                    incident the last `pool_exhausted` carried.
 */
export type FailoverEventKind = "refused" | "failover" | "pool_exhausted" | "pool_recovered"

/** Why a profile could not take a request nobody could take. */
export type NoRoutableReason =
  | "spent"
  | "reserve_held"
  | "weekly_held"
  | "model_benched"
  | "excluded"
  | "held"
  | "no_cvp"
  | "no_restricted"
  | "extra_usage_off"
  | "logged_out"

export interface NoRoutableProfile {
  id: string
  reason: NoRoutableReason
  /** When this profile is expected to take work again (epoch ms), when known. */
  resetsAt: number | null
}

/** A profile on a `pool_exhausted` event: the error body's entry, camelCase. */
export interface PoolEventProfile {
  id: string
  reason: NoRoutableReason
  resetsAt: string | null
}

export interface FailoverEvent {
  /** Monotonic, starts at 1, never reused. The `since` cursor. */
  seq: number
  at: number
  kind: FailoverEventKind
  /** The account that refused. */
  profile: string
  /** The account that served the request instead, for `failover`. */
  servedBy: string | null
  reason: string
  /** Routing mode in effect when this happened. */
  routing: string
  sessionKey: string | null
  /**
   * True when this refusal happened on an internal re-proxy hop, meaning the
   * client did not see it. A `refused` event with `internalHop: false` is one
   * the connected agent actually received.
   */
  internalHop: boolean
  until: number | null
  limit: LimitDiagnosis | null
  /** Which provider's account this is; absent means Claude. */
  provider?: "chatgpt"
  /** The pool incident, on `pool_exhausted` and `pool_recovered`. */
  incidentId?: string
  /** Meridian's id of the request that exhausted the pool, or that the pool served again. */
  requestId?: string | null
  /** Every profile that could not take the request and why, on `pool_exhausted`. */
  profiles?: PoolEventProfile[]
  /** ISO time of the pool's earliest opening, on `pool_exhausted`; null when none is known. */
  resetAt?: string | null
}

export type PoolExhaustedEvent = FailoverEvent & { kind: "pool_exhausted"; incidentId: string }

export interface FailoverEventPage {
  events: FailoverEvent[]
  /**
   * Cursor for the next poll. The seq of the LAST RETURNED event, or the
   * requested `since` when nothing was returned - never the ring's newest seq,
   * because a page truncated by `limit` would then skip the remainder.
   */
  nextSince: number
  oldestSeq: number
  latestSeq: number
  /**
   * True when events between the requested `since` and the oldest retained one
   * were evicted, so the caller knows it missed some rather than believing it
   * has seen everything.
   */
  dropped: boolean
  capacity: number
}

const DEFAULT_EVENT_CAPACITY = 500
const DEFAULT_PAGE_LIMIT = 100

/**
 * Bounded ring of refusal/failover events, oldest-first on read.
 *
 * Capacity is generous relative to the event rate (one per refusal, not one per
 * request), so a consumer polling every few seconds cannot outrun it; `dropped`
 * exists for the case where a consumer was away long enough that it did.
 */
export class FailoverEventLog {
  private readonly events: FailoverEvent[] = []
  private seq = 0
  private openIncident: string | null = null

  constructor(
    private readonly capacity: number = DEFAULT_EVENT_CAPACITY,
    private readonly now: () => number = Date.now,
  ) {}

  append(event: Omit<FailoverEvent, "seq" | "at"> & { at?: number }): FailoverEvent {
    const stored: FailoverEvent = { ...event, seq: ++this.seq, at: event.at ?? this.now() }
    this.events.push(stored)
    if (this.events.length > this.capacity) this.events.splice(0, this.events.length - this.capacity)
    return stored
  }

  /**
   * A Claude request no account could take. The first one since a request was
   * last served opens an incident named for its own time and seq; every later
   * one carries that id until `served` closes it.
   */
  poolExhausted(event: Omit<FailoverEvent, "seq" | "at" | "kind" | "incidentId">): PoolExhaustedEvent {
    const at = this.now()
    this.openIncident ??= `inc_${at}_${this.seq + 1}`
    return this.append({ ...event, kind: "pool_exhausted", incidentId: this.openIncident, at }) as PoolExhaustedEvent
  }

  /** A Claude account served a request: closes the open incident, if any, with `pool_recovered`. */
  served(served: { profile: string; requestId: string; routing: string }): FailoverEvent | null {
    const incidentId = this.openIncident
    if (incidentId === null) return null
    this.openIncident = null
    return this.append({
      kind: "pool_recovered",
      profile: served.profile,
      servedBy: served.profile,
      reason: "served",
      routing: served.routing,
      sessionKey: null,
      internalHop: false,
      until: null,
      limit: null,
      incidentId,
      requestId: served.requestId,
    })
  }

  /**
   * Events strictly after `since`, oldest-first. `since = 0` returns everything
   * retained, which is what a consumer starting cold wants.
   */
  since(since: number, limit: number = DEFAULT_PAGE_LIMIT): FailoverEventPage {
    const from = Number.isFinite(since) && since > 0 ? Math.floor(since) : 0
    const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_PAGE_LIMIT
    const oldestSeq = this.events[0]?.seq ?? 0
    const matched = this.events.filter(e => e.seq > from)
    const events = matched.slice(0, cap)
    return {
      events,
      nextSince: events.length > 0 ? events[events.length - 1]!.seq : from,
      oldestSeq,
      latestSeq: this.seq,
      // Nothing is dropped for a cold start (from === 0); and a caller that is
      // exactly caught up (from === oldestSeq - 1) has missed nothing either.
      dropped: from > 0 && oldestSeq > 0 && from < oldestSeq - 1,
      capacity: this.capacity,
    }
  }

  clear(): void {
    this.events.length = 0
    this.seq = 0
    this.openIncident = null
  }
}

export const NO_ROUTABLE_ACCOUNT_CODE = "no_routable_account"
export const NO_ROUTABLE_ACCOUNT_PREFIX = "No routable Claude account: "

const isoOrNull = (at: number | null): string | null => at === null ? null : new Date(at).toISOString()

/** The pool's earliest opening: the soonest profile that names one. */
export function earliestOpening(profiles: readonly NoRoutableProfile[]): number | null {
  const times = profiles.map(p => p.resetsAt).filter((at): at is number => at !== null)
  return times.length > 0 ? Math.min(...times) : null
}

export function poolEventProfiles(profiles: readonly NoRoutableProfile[]): PoolEventProfile[] {
  return profiles.map(p => ({ id: p.id, reason: p.reason, resetsAt: isoOrNull(p.resetsAt) }))
}

export function poolEventResetAt(profiles: readonly NoRoutableProfile[]): string | null {
  return isoOrNull(earliestOpening(profiles))
}

/**
 * The `error` object of a request no Claude account could take, identical on
 * the 429 body and the SSE error frame. The incident is also the message's
 * last token, because a client SDK that keeps only `type` and `message` of a
 * stream error still has to find it.
 */
export function noRoutableAccountError(input: {
  summary: string
  incidentId: string
  requestId: string
  profiles: readonly NoRoutableProfile[]
}): Record<string, unknown> {
  return {
    type: "rate_limit_error",
    code: NO_ROUTABLE_ACCOUNT_CODE,
    message: `${NO_ROUTABLE_ACCOUNT_PREFIX}${input.summary} (incident ${input.incidentId})`,
    reset_at: poolEventResetAt(input.profiles),
    incident_id: input.incidentId,
    request_id: input.requestId,
    profiles: input.profiles.map(p => ({ id: p.id, reason: p.reason, resets_at: isoOrNull(p.resetsAt) })),
  }
}

/** `every candidate refused (work spent, personal reserve_held)` */
export function noRoutableSummary(lead: string, profiles: readonly NoRoutableProfile[]): string {
  return profiles.length === 0 ? lead : `${lead} (${profiles.map(p => `${p.id} ${p.reason}`).join(", ")})`
}
