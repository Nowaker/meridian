export const CAPACITY_OBSERVATION_MAX_AGE_MS = 120_000

/**
 * A CVP holder the supervisor keeps out of general work by policy: it covers
 * the account for an attestation without proving any capacity spent.
 */
export const POLICY_PRESERVED_REASON = "cybersec-preserved"

const PROTECTION_REASONS = new Set([
  "spent", "usage-reserve", "weekly-reserve", "extra-usage",
  "loaner-gate", "unmeasured-loaner", "unmeasured-loaner-cap",
  POLICY_PRESERVED_REASON,
])

export interface ManagedExclusionEvidence {
  readonly observedAt: number
  readonly profiles: ReadonlySet<string>
  readonly reasons: ReadonlyMap<string, string>
}

export function parseManagedExclusionEvidence(value: unknown, allowed: ReadonlySet<string>,
  reasonTypes: ReadonlySet<string> = PROTECTION_REASONS): ManagedExclusionEvidence | undefined {
  if (typeof value !== "object" || value === null || !("version" in value) || value.version !== 1 ||
    !("observedAt" in value) || typeof value.observedAt !== "number" || !Number.isSafeInteger(value.observedAt) ||
    value.observedAt <= 0 || !("reasons" in value) || !value.reasons || typeof value.reasons !== "object" ||
    Array.isArray(value.reasons)) return undefined

  const reasons = new Map<string, string>()
  for (const [id, reason] of Object.entries(value.reasons)) {
    if (!allowed.has(id) || typeof reason !== "string" || !reasonTypes.has(reason)) return undefined
    reasons.set(id, reason)
  }
  return { observedAt: value.observedAt, profiles: new Set(reasons.keys()), reasons }
}

export function capacityObservationIsFresh(at: number, now: number): boolean {
  return Number.isFinite(at) && at <= now && now - at <= CAPACITY_OBSERVATION_MAX_AGE_MS
}
