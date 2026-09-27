/**
 * Where the ChatGPT backend gets its seats and access tokens.
 *
 * Two implementations, chosen once per instance:
 *
 * - `owned` (owned.ts): Meridian's own store. Meridian holds the single
 *   writer lease and is the only process that refreshes these tokens.
 * - `follow-external` (external.ts): the oc-codex-multi-auth store, read-only.
 *   Its owner refreshes; Meridian only reads access tokens and never writes
 *   the file, its locks, or the token endpoint.
 *
 * The backend never learns which one it holds beyond `mode`, which it uses
 * only to word the error a client sees when nothing can serve.
 *
 * Nothing on this interface returns a refresh token, and `seats()` returns no
 * token at all, so a view built from it cannot leak one.
 */
import type { CodexPoolResult } from "../codex/pool"

export type ChatGptCredentialMode = "owned" | "follow-external"

/** One seat, as the dashboard may see it. No credential fields. */
export interface ChatGptSeatView {
  /** `accountUserId`: the seat. `accountId` is shared between seats and never a key. */
  id: string
  email: string | null
  planType: string | null
  /** Whether the external owner (or the owned store) currently lets this seat serve. */
  eligible: boolean
  /** Why not, when `eligible` is false. */
  reason?: SeatUnavailableReason
  /** The access token's expiry, epoch ms. */
  expiresAt: number | null
  /** The seat the credential owner itself would pick next. */
  active?: boolean
}

export type SeatUnavailableReason =
  | "unknown"
  | "disabled"
  | "cooling_down"
  | "quota_exhausted"
  | "no_token"
  | "expired"
  | "requires_reauth"
  | "no_authority"

export interface ChatGptServingAccount {
  accountUserId: string
  /** Workspace scope header value. */
  accountId: string
  accessToken: string
}

export type SeatCredential =
  | { ok: true; account: ChatGptServingAccount }
  | { ok: false; reason: SeatUnavailableReason }

export interface ChatGptCredentialSource {
  readonly mode: ChatGptCredentialMode
  /** Every seat the source knows, eligible or not. */
  seats(model?: string): ChatGptSeatView[]
  /** Seats that may serve `model` now, best first. */
  candidateSeats(model?: string): string[]
  /**
   * The seat's current access token. `reread: true` bypasses any cache - it is
   * how the backend asks "has the owner rotated this token since?" after a 401.
   */
  credentials(seat: string, options?: { reread?: boolean; model?: string }): Promise<SeatCredential>
  /** Whether any request could be served right now (lease held, store readable). */
  isServing(): boolean
  /** The pool as the read-only usage service expects it. */
  usagePool(): CodexPoolResult
  /** What to tell a client when every seat was unavailable for these reasons. */
  describeUnavailable(reasons: ReadonlySet<SeatUnavailableReason>): string
  /** Take whatever authority this mode needs. No-op for follow-external. */
  acquire(): Promise<void>
  release(): void
}
