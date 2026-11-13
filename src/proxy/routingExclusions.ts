export type RoutingPurpose = "work" | "warm"

type ResolveRoutingAccessInput = {
  readonly purpose: RoutingPurpose
  readonly availableProfileIds: readonly string[]
  readonly excludedProfileIds: readonly string[]
  /**
   * Profiles held out of rotation: unpinned work and every warm pass them by,
   * while work pinned to one is served there. Used to measure a job on an
   * account nothing else touches.
   */
  readonly heldProfileIds?: readonly string[]
  readonly explicitProfileId?: string
}

export type RoutingAccess =
  | { readonly kind: "allowed"; readonly eligibleProfileIds: readonly string[] }
  | { readonly kind: "explicit_excluded"; readonly profileId: string }
  | { readonly kind: "explicit_held"; readonly profileId: string }
  | { readonly kind: "no_eligible_profiles" }

export function parseRoutingExcludedProfiles(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((profileId): profileId is string => typeof profileId === "string"))]
}

export function mergeRoutingExcludedProfiles(
  manualProfileIds: readonly string[],
  managedProfileIds: readonly string[],
): string[] {
  return [...new Set([...manualProfileIds, ...managedProfileIds])]
}

export function filterEligibleProfileIds(
  profileIds: readonly string[],
  excludedProfileIds: readonly string[],
): string[] {
  if (excludedProfileIds.length === 0) return [...profileIds]
  const excluded = new Set(excludedProfileIds)
  return profileIds.filter(profileId => !excluded.has(profileId))
}

export function resolveRoutingAccess(input: ResolveRoutingAccessInput): RoutingAccess {
  const held = input.heldProfileIds ?? []
  switch (input.purpose) {
    case "warm":
      if (input.explicitProfileId && held.includes(input.explicitProfileId)) {
        return { kind: "explicit_held", profileId: input.explicitProfileId }
      }
      return { kind: "allowed", eligibleProfileIds: filterEligibleProfileIds(input.availableProfileIds, held) }
    case "work": {
      const excluded = new Set(input.excludedProfileIds)
      if (input.explicitProfileId && excluded.has(input.explicitProfileId)) {
        return { kind: "explicit_excluded", profileId: input.explicitProfileId }
      }
      const pinnedToHeld = input.explicitProfileId !== undefined && held.includes(input.explicitProfileId)
      const eligibleProfileIds = filterEligibleProfileIds(
        input.availableProfileIds,
        pinnedToHeld ? input.excludedProfileIds : [...input.excludedProfileIds, ...held],
      )
      return eligibleProfileIds.length > 0
        ? { kind: "allowed", eligibleProfileIds }
        : { kind: "no_eligible_profiles" }
    }
    default: {
      const exhaustive: never = input.purpose
      return exhaustive
    }
  }
}
