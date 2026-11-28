/**
 * A ChatGPT seat's banked rate-limit resets on its /profiles card, and what
 * the card says after `POST /profiles/:id/chatgpt-resets/redeem` answers.
 *
 * The seat's `resets` comes from /profiles/list (chatgpt/profiles.ts
 * `chatGptResetsView`): a count and one expiry per reset, soonest first. A
 * redeem spends the soonest-expiring one, so that is the expiry the card and
 * its confirmation name.
 *
 * Both functions are serialized with `.toString()` into the page's inline
 * script (the buildBadge.ts pattern), so each stays self-contained. They take
 * `unknown` because the browser hands them raw JSON.
 */

export interface ChatGptResetCardView {
  readonly available: number
  /** When the reset a redeem would spend expires, if known. */
  readonly nextExpiresAt: number | null
  /** Whether this page may offer the redeem: the instance owns the seat's login and it holds a reset. */
  readonly redeemable: boolean
  /** Why the redeem is not offered, when it is not. */
  readonly reason: string | null
}

export function chatGptResetCardView(resets: unknown, ownerMode: unknown): ChatGptResetCardView | null {
  const value = (typeof resets === "object" && resets !== null ? resets : null) as { available?: unknown; expiresAt?: unknown } | null
  if (!value || typeof value.available !== "number" || !Number.isInteger(value.available) || value.available < 0) return null
  const expiries = Array.isArray(value.expiresAt) ? value.expiresAt : []
  const first = expiries[0]
  const nextExpiresAt = typeof first === "number" && Number.isFinite(first) ? first : null
  const reason = value.available === 0 ? "This seat has no banked reset."
    : ownerMode !== "owned" ? "Only the instance that owns this seat's ChatGPT login redeems its resets."
    : null
  return { available: value.available, nextExpiresAt, redeemable: reason === null, reason }
}

/** What the card says after the redeem route answers `status` with `body`. */
export function chatGptRedeemOutcomeText(status: number, body: unknown): { ok: boolean; text: string } {
  const answer = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>
  if (status >= 200 && status < 300 && answer.result === "redeemed") {
    const left = answer.remaining
    return { ok: true, text: "Reset redeemed; the seat's windows are cleared." + (typeof left === "number" ? " " + left + " left." : "") }
  }
  if (status === 0) return { ok: false, text: "Not redeemed: Meridian did not answer." }
  const error = typeof answer.error === "string" && answer.error.length > 0 ? answer.error : "Meridian answered " + status
  return {
    ok: false,
    text: "Not redeemed: " + error + "." + (answer.indeterminate === true ? " It may have gone through - check the seat's resets before trying again." : ""),
  }
}
