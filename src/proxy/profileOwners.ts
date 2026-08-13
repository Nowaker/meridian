/**
 * Per-profile ownership — whose Claude subscription an account actually is.
 *
 * A fleet is rarely all one person's. Some accounts are the operator's own;
 * others are borrowed, and a borrowed account is spent under different rules —
 * drained late in its window, capped below full, never switched to casually.
 * Meridian does not schedule against this itself. It records the designation
 * and publishes it on /profiles/list, so whatever does the scheduling stops
 * having to infer it from the profile's name.
 *
 * Stored in settings.json rather than profiles.json because under
 * MERIDIAN_FOLLOW_ACTIVE a follower serves profiles ADOPTED from the instance
 * it follows (followActive.ts, `adoptedProfiles()`), and those have no local
 * profiles.json entry to hang a field on. A map keyed by id designates adopted
 * and local profiles alike — and ownership is a local opinion either way: the
 * followed instance does not get to decide whose account this is.
 *
 * Leaf module — no imports from server.ts or session/.
 */

import { getSetting, setSetting, type ProfileOwner } from "./settings"

export type { ProfileOwner }

/**
 * The values that may be stored. The UI shows "Mine" / "Borrowed" instead;
 * the wire vocabulary stays own/loaner because that is what every consumer
 * already speaks.
 */
export const PROFILE_OWNERS: readonly ProfileOwner[] = ["own", "loaner"]

function isProfileOwner(value: unknown): value is ProfileOwner {
  return typeof value === "string" && (PROFILE_OWNERS as readonly string[]).includes(value)
}

function acceptedValues(): string {
  return PROFILE_OWNERS.map(o => `"${o}"`).join(" or ")
}

/**
 * Pure: read a designation map out of whatever settings.json actually holds.
 *
 * Hand-edited and written by other versions, so an entry that is not a known
 * value is dropped rather than served. A consumer forced to defend against a
 * third vocabulary word is a consumer that will not.
 */
export function readProfileOwners(raw: unknown): Record<string, ProfileOwner> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {}
  const out: Record<string, ProfileOwner> = {}
  for (const [id, value] of Object.entries(raw)) {
    if (id && isProfileOwner(value)) out[id] = value
  }
  return out
}

/**
 * Pure: the map that results from designating one profile.
 *
 * Clearing DELETES the key rather than storing null, so "not designated" has
 * one representation on disk and someone reading the raw file sees the same
 * absence the API reports.
 */
export function withProfileOwner(
  current: Record<string, ProfileOwner>,
  profileId: string,
  owner: ProfileOwner | null,
): Record<string, ProfileOwner> {
  const next = { ...current }
  if (owner === null) delete next[profileId]
  else next[profileId] = owner
  return next
}

export type OwnerRequest =
  | { ok: true; profile: string; owner: ProfileOwner | null }
  | { ok: false; error: string }

/**
 * Pure: validate a POST /profiles/owner body against the profiles that exist.
 *
 * A MISSING `owner` field is rejected rather than read as "clear it". Clearing
 * must be asked for: a caller that forgot the field would otherwise erase a
 * designation, and the designation exists precisely to stop a borrowed account
 * being spent like an own one.
 */
export function parseOwnerRequest(body: unknown, knownIds: readonly string[]): OwnerRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: "Request body must be a JSON object" }
  }
  const record = body as { profile?: unknown; owner?: unknown }
  if (typeof record.profile !== "string" || !record.profile.trim()) {
    return { ok: false, error: "Missing 'profile' in request body" }
  }
  const profile = record.profile.trim()
  if (!knownIds.includes(profile)) {
    return {
      ok: false,
      error: `Unknown profile: ${profile}. Available: ${knownIds.join(", ") || "(none configured)"}`,
    }
  }
  if (!("owner" in record)) {
    return { ok: false, error: `Missing 'owner' in request body. Send ${acceptedValues()}, or null to clear.` }
  }
  if (record.owner === null) return { ok: true, profile, owner: null }
  if (isProfileOwner(record.owner)) return { ok: true, profile, owner: record.owner }
  return {
    ok: false,
    error: `Invalid owner: ${String(record.owner).slice(0, 40)}. Accepted values are ${acceptedValues()}, or null to clear.`,
  }
}

/** Every designation on record, keyed by profile id. */
export function profileOwners(): Record<string, ProfileOwner> {
  return readProfileOwners(getSetting("profileOwners"))
}

/** One profile's designation, or null when it has none. */
export function profileOwner(profileId: string): ProfileOwner | null {
  return profileOwners()[profileId] ?? null
}

/** Designate a profile, or clear it with null. Persisted to settings.json. */
export function setProfileOwner(profileId: string, owner: ProfileOwner | null): void {
  setSetting("profileOwners", withProfileOwner(profileOwners(), profileId, owner))
}
