/**
 * Profile removal.
 *
 * Removing a profile drops its entry from profiles.json and deletes the
 * credential directory it owns. Both halves are planned before either is
 * applied, and the ORDER is the opposite of a rename's: the profile list is
 * written FIRST, then the directories are deleted.
 *
 * That order is the one that fails safely. A list written with the directory
 * still on disk leaves an orphaned directory - reported, recoverable, and
 * belonging to no profile. Deleting first and then failing to write the list
 * leaves a live profile pointing at credentials that are gone, which serves
 * 401s until somebody notices and cannot be undone at all.
 *
 * Removal matches on the profile ID only, never on a rename alias: an alias is
 * a redirect left behind by a rename, and "remove x" deleting the profile now
 * called y is not what anybody means.
 *
 * This is a leaf module - it shares profileRename.ts's disk primitives and
 * imports nothing from server.ts, profileCli.ts or session/.
 */

import { existsSync, rmSync } from "node:fs"
import { join } from "node:path"
import type { ProfileConfig } from "./profiles"
import {
  defaultProfilesConfigFile,
  defaultProfilesDir,
  loadProfileConfigFrom,
  saveProfileConfigTo,
} from "./profileRename"

/**
 * Which on-disk directories should be removed when this profile is deleted.
 *
 * Browser-login profiles drop their explicit `claudeConfigDir`, and only when
 * it lives under `profilesDir` - a profile pointed at ~/.claude names the
 * host's own credentials, which removing one account must never delete.
 * oauth-token profiles store no `claudeConfigDir` at all, so their isolation
 * dir at `profilesDir/<id>` is derived instead; it is created by the SDK
 * during use rather than written on the profile, and was orphaned forever
 * before this covered it.
 */
export function dirsToRemoveOnProfileRemove(profile: ProfileConfig, profilesDir: string): string[] {
  const dirs: string[] = []
  if (profile.claudeConfigDir?.startsWith(profilesDir)) {
    dirs.push(profile.claudeConfigDir)
  }
  if (profile.oauthToken || profile.type === "oauth-token") {
    const isolationDir = join(profilesDir, profile.id)
    if (!dirs.includes(isolationDir)) dirs.push(isolationDir)
  }
  return dirs
}

export interface ProfileRemovePlan {
  /** The complete profile list as it should be written to disk. */
  profiles: ProfileConfig[]
  /** The entry being taken out. */
  removed: ProfileConfig
  /** Credential directories this profile owns, deleted after the list is written. */
  dirsToRemove: string[]
}

export type PlanProfileRemoveResult =
  | { ok: true; plan: ProfileRemovePlan }
  | { ok: false; error: string; hint?: string }

export function planProfileRemove(
  profiles: ProfileConfig[],
  id: string,
  profilesDir: string,
): PlanProfileRemoveResult {
  const idx = profiles.findIndex(p => p.id === id)
  if (idx === -1) {
    const byAlias = profiles.find(p => p.aliases?.includes(id))
    if (byAlias) {
      return {
        ok: false,
        error: `Profile "${id}" not found.`,
        hint: `"${id}" is a former name of "${byAlias.id}" — remove that instead.`,
      }
    }
    return { ok: false, error: `Profile "${id}" not found.` }
  }

  const removed = profiles[idx]!
  return {
    ok: true,
    plan: {
      profiles: profiles.filter((_, i) => i !== idx),
      removed,
      dirsToRemove: dirsToRemoveOnProfileRemove(removed, profilesDir),
    },
  }
}

export interface ApplyProfileRemoveOptions {
  /** Directory holding per-profile credential dirs. Defaults to the real one. */
  profilesDir?: string
  /** profiles.json path. Defaults to the real one. */
  configFile?: string
}

export type ApplyProfileRemoveResult =
  | {
      ok: true
      id: string
      /** Directories actually deleted, for the caller to report. */
      dirsRemoved: string[]
      /**
       * Directories the list no longer claims and that could not be deleted.
       * The removal itself succeeded; these are orphans somebody may want to
       * clear by hand, and staying silent about them is how a credential
       * directory outlives every profile that named it.
       */
      dirsOrphaned: { dir: string; reason: string }[]
      profiles: ProfileConfig[]
    }
  | { ok: false; error: string; hint?: string }

export function applyProfileRemove(
  id: string,
  options: ApplyProfileRemoveOptions = {},
): ApplyProfileRemoveResult {
  const profilesDir = options.profilesDir ?? defaultProfilesDir()
  const configFile = options.configFile ?? defaultProfilesConfigFile()

  const profiles = loadProfileConfigFrom(configFile)
  const planned = planProfileRemove(profiles, id, profilesDir)
  if (!planned.ok) return planned
  const { plan } = planned

  try {
    saveProfileConfigTo(configFile, plan.profiles)
  } catch (err) {
    return {
      ok: false,
      error: `Could not write ${configFile}: ${err instanceof Error ? err.message : err}`,
    }
  }

  const dirsRemoved: string[] = []
  const dirsOrphaned: { dir: string; reason: string }[] = []
  for (const dir of plan.dirsToRemove) {
    if (!existsSync(dir)) continue
    try {
      rmSync(dir, { recursive: true, force: true })
      dirsRemoved.push(dir)
    } catch (err) {
      dirsOrphaned.push({ dir, reason: err instanceof Error ? err.message : String(err) })
    }
  }

  return { ok: true, id: plan.removed.id, dirsRemoved, dirsOrphaned, profiles: plan.profiles }
}
