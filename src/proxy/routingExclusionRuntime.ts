import type { ProfileConfig } from "./profiles"
import { findProfileByIdOrAlias } from "./profiles"
import { filterEligibleProfileIds, resolveRoutingAccess, type RoutingAccess, type RoutingPurpose } from "./routingExclusions"

export interface RoutingProfileAccess {
  readonly access: RoutingAccess
  readonly profiles: readonly ProfileConfig[]
  readonly excludedProfileIds: readonly string[]
  readonly defaultProfile: string | undefined
}

function canonicalProfileId(profiles: readonly ProfileConfig[], profileId: string): string {
  return findProfileByIdOrAlias(profiles, profileId)?.id ?? profileId
}

export function canonicalRoutingExcludedProfileIds(
  profiles: readonly ProfileConfig[],
  excludedProfileIds: readonly string[],
): string[] {
  return [...new Set(excludedProfileIds.map(profileId => canonicalProfileId(profiles, profileId)))]
}

export function evaluateRoutingProfileAccess(input: {
  readonly profiles: readonly ProfileConfig[]
  readonly defaultProfile?: string
  readonly purpose: RoutingPurpose
  readonly explicitProfileId?: string
  readonly excludedProfileIds: readonly string[]
}): RoutingProfileAccess {
  const excludedProfileIds = canonicalRoutingExcludedProfileIds(input.profiles, input.excludedProfileIds)
  const explicitProfileId = input.explicitProfileId
    ? canonicalProfileId(input.profiles, input.explicitProfileId)
    : undefined
  const defaultProfile = input.defaultProfile
    ? canonicalProfileId(input.profiles, input.defaultProfile)
    : undefined
  const availableProfileIds = input.profiles.length > 0 ? input.profiles.map(profile => profile.id) : ["default"]
  const access = resolveRoutingAccess({
    purpose: input.purpose,
    availableProfileIds,
    excludedProfileIds,
    ...(explicitProfileId ? { explicitProfileId } : {}),
  })
  if (access.kind !== "allowed") {
    return { access, profiles: [], excludedProfileIds, defaultProfile: undefined }
  }
  const eligible = new Set(access.eligibleProfileIds)
  const profiles = input.profiles.filter(profile => eligible.has(profile.id))
  return {
    access,
    profiles,
    excludedProfileIds,
    defaultProfile: profiles.some(profile => profile.id === defaultProfile)
      ? defaultProfile
      : undefined,
  }
}

export function replacementForExcludedActive(input: {
  readonly profiles: readonly ProfileConfig[]
  readonly defaultProfile?: string
  readonly activeProfile?: string
  readonly excludedProfileIds: readonly string[]
}): { readonly change: false } | { readonly change: true; readonly profileId: string | undefined } {
  const excludedProfileIds = canonicalRoutingExcludedProfileIds(input.profiles, input.excludedProfileIds)
  const selectedProfile = input.activeProfile ?? input.defaultProfile ?? input.profiles[0]?.id
  const activeProfile = selectedProfile ? canonicalProfileId(input.profiles, selectedProfile) : undefined
  if (!activeProfile || !excludedProfileIds.includes(activeProfile)) return { change: false }
  const eligibleProfileIds = filterEligibleProfileIds(
    input.profiles.map(profile => profile.id),
    excludedProfileIds,
  )
  return { change: true, profileId: eligibleProfileIds[0] }
}

export function profileExcludedResponse(profileId: string): Response {
  return new Response(JSON.stringify({
    type: "error",
    error: {
      type: "profile_excluded",
      message: `Profile "${profileId}" is excluded from work routing`,
    },
  }), { status: 409, headers: { "Content-Type": "application/json" } })
}

export function noEligibleProfilesResponse(): Response {
  return new Response(JSON.stringify({
    type: "error",
    error: {
      type: "no_eligible_profiles",
      message: "No profiles are eligible for work routing",
    },
  }), { status: 503, headers: { "Content-Type": "application/json" } })
}
