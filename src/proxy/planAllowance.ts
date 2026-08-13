/**
 * Plan → coding-allotment multiplier.
 *
 * Anthropic sizes a plan's Claude Code allotment as a multiple of the Pro
 * baseline — 5x, 20x, 6.25x — and that number, not the plan name, is what says
 * how much work an account can actually do. Two accounts both reporting
 * `Plan: max` can differ by 4x in capacity, so a page that shows only the plan
 * cannot tell the user which account has room left.
 *
 * The multiplier is derived from `rateLimitTier` — the raw string the profile
 * endpoint returns, e.g. `default_claude_max_20x` — rather than from
 * `subscriptionType`, because that field is too coarse: it collapses Max 5x
 * and Max 20x into the single word `max`, and Team Standard and Team Premium
 * into `team`. `subscriptionType` is used only as a fallback for the tiers it
 * does identify unambiguously.
 *
 * An unrecognized tier yields null rather than a default, which is the whole
 * point of the field: rendering `1x` for an account that is really 20x is
 * worse than rendering nothing, because a reader acts on it.
 *
 * This is a leaf module — pure, no I/O, no imports.
 */

export interface PlanAllowance {
  /** Multiplier as displayed, e.g. `"20x"`. Null when the tier is unknown. */
  multiplier: string | null
  /**
   * The same value as a number, so callers can weight or rank accounts without
   * re-parsing the label. Null whenever `multiplier` is.
   */
  weight: number | null
  /** Tier label, e.g. `"Personal Max"`. Null when the tier is unknown. */
  label: string | null
}

const UNKNOWN: PlanAllowance = { multiplier: null, weight: null, label: null }

/**
 * Which side of Anthropic's pricing an account sits on. Tracked separately
 * from the multiplier because the two fields can disagree: measured on a
 * ten-account host, a Team seat reports `subscriptionType: "team"` with
 * `rateLimitTier: "default_claude_max_5x"`, so the tier names the SIZE of the
 * allotment and `subscriptionType` names WHOSE it is.
 */
type PlanFamily = "personal" | "team" | "enterprise"

interface TierProfile {
  label: string
  family: PlanFamily
  multiplier: string
  weight: number
}

/**
 * Reduce a raw tier string to the form the table below is keyed by.
 *
 * Anthropic prefixes the wire value (`default_claude_max_20x`) and separates
 * words with underscores; the same tier also appears bare (`max_20x`) in
 * places, and `team_tier_1` is the wire spelling of what the pricing page
 * calls Team Premium. Normalizing first means one entry per tier instead of
 * one per spelling.
 */
export function normalizeRateLimitTier(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  return trimmed
    .replace(/^default_claude_/, "")
    .replace(/^default_/, "")
    .replace(/_/g, " ")
    .toLowerCase()
}

/**
 * Multipliers are Anthropic's published Claude Code allotments relative to
 * Pro. Team Premium is listed as 6.25x — the ratio of its $125 seat to the $20
 * Pro plan — and is the reason this table stores a fractional weight rather
 * than an integer.
 *
 * Bare `max` and bare `team` deliberately have no entry: both name a family
 * with two differently-sized members, so resolving them would mean picking one
 * at random.
 */
const TIERS: Record<string, TierProfile> = {
  "max 20x": { label: "Personal Max", family: "personal", multiplier: "20x", weight: 20 },
  "max 5x": { label: "Personal Max", family: "personal", multiplier: "5x", weight: 5 },
  "pro": { label: "Personal Pro", family: "personal", multiplier: "1x", weight: 1 },
  "team premium": { label: "Team Premium", family: "team", multiplier: "6.25x", weight: 6.25 },
  "team tier 1": { label: "Team Premium", family: "team", multiplier: "6.25x", weight: 6.25 },
  "team standard": { label: "Team Standard", family: "team", multiplier: "1x", weight: 1 },
}

/** Which family each `subscriptionType` names, for the reconciliation below. */
const SUBSCRIPTION_FAMILY: Record<string, PlanFamily> = {
  max: "personal",
  pro: "personal",
  team: "team",
  enterprise: "enterprise",
}

/**
 * What to call an account whose declared family contradicts its tier's. Only
 * the family is left, so the label drops to it rather than asserting a product
 * name nobody can confirm.
 */
const FAMILY_LABEL: Record<PlanFamily, string> = {
  personal: "Personal",
  team: "Team",
  enterprise: "Enterprise",
}

/**
 * `subscriptionType` values that pin a single tier on their own. `max` and
 * `team` are absent for the reason given above, and `enterprise` because its
 * allotment is negotiated per contract rather than published.
 */
const SUBSCRIPTION_FALLBACK: Record<string, string> = {
  pro: "pro",
}

/**
 * Derive the allowance from whatever plan fields a credential file carries.
 *
 * Both arguments are optional because both are optional on disk: a profile
 * written before the plan was persisted has neither, and one written by an
 * older Meridian has only `subscriptionType`. Every unknown case returns the
 * same all-null shape, so callers can render conditionally on one field.
 */
export function planAllowance(fields: {
  rateLimitTier?: string | null
  subscriptionType?: string | null
} | null | undefined): PlanAllowance {
  const subscription = fields?.subscriptionType?.trim().toLowerCase()
  const declaredFamily = subscription ? SUBSCRIPTION_FAMILY[subscription] : undefined

  const fromTier = TIERS[normalizeRateLimitTier(fields?.rateLimitTier) ?? ""]
  if (fromTier) return reconcile(fromTier, declaredFamily)

  const key = subscription ? SUBSCRIPTION_FALLBACK[subscription] : undefined
  const fromSubscription = key ? TIERS[key] : undefined
  return fromSubscription ? reconcile(fromSubscription, declaredFamily) : { ...UNKNOWN }
}

/**
 * Size from the tier, name from `subscriptionType` — and where the two
 * disagree, the name degrades to the family rather than keeping the tier's.
 *
 * A Team seat sized like Personal Max 5x is a real account on this host, and
 * calling it "Personal Max" is wrong in the direction that matters: the reader
 * is deciding whose allotment they are about to spend. The multiplier is still
 * the tier's, because the tier is what Anthropic sizes the allotment by.
 */
function reconcile(tier: TierProfile, declaredFamily: PlanFamily | undefined): PlanAllowance {
  const label = declaredFamily && declaredFamily !== tier.family
    ? FAMILY_LABEL[declaredFamily]
    : tier.label
  return { multiplier: tier.multiplier, weight: tier.weight, label }
}
