/**
 * Multi-profile support.
 *
 * Allows a single Meridian instance to route requests to different Claude
 * accounts. Each profile is a named auth context — a CLAUDE_CONFIG_DIR for
 * Max subscriptions, an Anthropic API key for direct API access, or a
 * long-lived OAuth token minted by `claude setup-token`.
 *
 * Profile selection priority:
 *   1. x-meridian-profile request header (per-request override)
 *   2. Active profile (set via POST /profiles/active or UI)
 *   3. First configured profile (or implicit "default" if none configured)
 *
 * This is a leaf module — no imports from server.ts or session/.
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { setSetting, getSetting } from "./settings"
import { pickStickyProfile, type RoutingMode } from "./routing"

const CONFIG_FILE = join(homedir(), ".config", "meridian", "profiles.json")

/** Disk profile cache with short TTL so new profiles are picked up quickly */
const DISK_CACHE_TTL_MS = 5_000
let diskProfilesCache: ProfileConfig[] = []
let diskProfilesCacheAt = 0

/**
 * Load profiles from ~/.config/meridian/profiles.json.
 * Cached with a 5s TTL so new profiles are picked up without restart,
 * while avoiding synchronous disk I/O on every request.
 */
export function loadProfilesFromDisk(): ProfileConfig[] {
  if (diskProfilesCacheAt > 0 && Date.now() - diskProfilesCacheAt < DISK_CACHE_TTL_MS) {
    return diskProfilesCache
  }
  try {
    if (!existsSync(CONFIG_FILE)) {
      diskProfilesCache = []
    } else {
      diskProfilesCache = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"))
    }
    diskProfilesCacheAt = Date.now()
    return diskProfilesCache
  } catch (err) {
    console.warn(`[meridian] Failed to read ${CONFIG_FILE}: ${err instanceof Error ? err.message : err}`)
    diskProfilesCacheAt = Date.now()
    diskProfilesCache = []
    return []
  }
}

/**
 * The three ANTHROPIC auth mechanisms. Not providers — `api` and
 * `oauth-token` keep their current Anthropic meaning permanently and are
 * never reinterpreted.
 */
export type ProfileType = "claude-max" | "api" | "oauth-token"

export type ProfileProvider = "anthropic" | "openai"

export type ProfileAuthType = ProfileType | "chatgpt-oauth"

export interface AnthropicProfileConfig {
  /** Unique profile identifier (e.g. "personal", "work") */
  id: string
  /**
   * Optional, and permanently so: every profile written before ChatGPT
   * support existed omits it, and an untouched profiles.json has to keep
   * working. An absent provider normalizes to "anthropic".
   */
  provider?: "anthropic"
  /**
   * Auth type. Inferred from the populated credential field when omitted:
   *   - `oauthToken`        → "oauth-token" (CLAUDE_CODE_OAUTH_TOKEN)
   *   - `apiKey`/`baseUrl`  → must be combined with explicit `type: "api"`
   *   - `claudeConfigDir`   → "claude-max" (CLAUDE_CONFIG_DIR)
   */
  type?: ProfileType
  /** Path to .claude config directory (claude-max profiles) */
  claudeConfigDir?: string
  /** Anthropic API key (api profiles) */
  apiKey?: string
  /** Anthropic base URL override (api profiles) */
  baseUrl?: string
  /** Long-lived OAuth token from `claude setup-token` (oauth-token profiles) */
  oauthToken?: string
}

export interface OpenAIProfileConfig {
  id: string
  provider: "openai"
  type?: "chatgpt-oauth"
  /**
   * Seat identity, the `chatgpt_account_user_id` claim. Deliberately NOT
   * `accountId`: that one is shared between distinct users in a real pool, so
   * keying anything on it merges two accounts into one.
   */
  accountUserId: string
  /**
   * Declared `never` rather than simply omitted. Omitting them would make a
   * union whose members disagree about which fields exist, breaking every
   * existing read of `profile.claudeConfigDir`; declaring them impossible
   * keeps those reads compiling while making a Claude credential on a ChatGPT
   * profile a compile error rather than a runtime discovery.
   */
  claudeConfigDir?: never
  apiKey?: never
  baseUrl?: never
  oauthToken?: never
}

export type ProfileConfig = AnthropicProfileConfig | OpenAIProfileConfig

export interface ResolvedAnthropicProfile {
  provider: "anthropic"
  id: string
  type: ProfileType
  /** Env vars to overlay on the SDK subprocess environment */
  env: Record<string, string>
}

/**
 * Carries NO `env`, and that absence is the safety property rather than an
 * oversight: there is no shape in which a ChatGPT profile can be handed to
 * the Claude environment builder or the Claude token refresher.
 */
export interface ResolvedOpenAIProfile {
  provider: "openai"
  id: string
  authType: "chatgpt-oauth"
  accountUserId: string
}

export type ResolvedProfile = ResolvedAnthropicProfile | ResolvedOpenAIProfile

/** Answer this with a 4xx: it is never retryable and never a reason to fall back. */
export class ProfileProviderMismatchError extends Error {
  readonly profileId: string
  readonly requestedProvider: ProfileProvider
  readonly actualProvider: ProfileProvider

  constructor(profileId: string, requestedProvider: ProfileProvider, actualProvider: ProfileProvider) {
    super(
      `Profile "${profileId}" authenticates against "${actualProvider}", `
      + `but this request requires "${requestedProvider}".`,
    )
    this.name = "ProfileProviderMismatchError"
    this.profileId = profileId
    this.requestedProvider = requestedProvider
    this.actualProvider = actualProvider
  }
}

export class NoProfileForProviderError extends Error {
  readonly provider: ProfileProvider

  constructor(provider: ProfileProvider) {
    super(`No profile is configured for the "${provider}" provider.`)
    this.name = "NoProfileForProviderError"
    this.provider = provider
  }
}

export function profileProvider(profile: ProfileConfig): ProfileProvider {
  return profile.provider === "openai" ? "openai" : "anthropic"
}

export function profilesForProvider(
  profiles: readonly ProfileConfig[],
  provider: "anthropic",
): AnthropicProfileConfig[]
export function profilesForProvider(
  profiles: readonly ProfileConfig[],
  provider: "openai",
): OpenAIProfileConfig[]
export function profilesForProvider(
  profiles: readonly ProfileConfig[],
  provider: ProfileProvider,
): ProfileConfig[]
export function profilesForProvider(
  profiles: readonly ProfileConfig[],
  provider: ProfileProvider,
): ProfileConfig[] {
  return profiles.filter(profile => profileProvider(profile) === provider)
}

const DEFAULT_PROFILE_ID = "default"

/** Mutable active profile — changed via POST /profiles/active or UI */
let activeProfileId: string | undefined

/**
 * Set the active profile. All requests without an explicit x-meridian-profile
 * header will use this profile. Persisted to ~/.config/meridian/settings.json.
 */
export function setActiveProfile(profileId: string): void {
  activeProfileId = profileId
  setSetting("activeProfile", profileId)
}

/**
 * Get the current active profile ID.
 */
export function getActiveProfileId(): string | undefined {
  return activeProfileId
}

/** Reset active profile — for testing only. */
export function resetActiveProfile(): void {
  activeProfileId = undefined
}

/**
 * Load persisted active profile from settings. Called once at startup
 * to restore the user's last selection. Only restores when disk
 * discovery is enabled (i.e. real CLI startup, not tests).
 * Validates the saved profile actually exists before restoring.
 */
export function restoreActiveProfile(configProfiles?: ProfileConfig[]): void {
  if (activeProfileId) return // already set (e.g. by env var)
  if (!diskDiscoveryEnabled) return // tests / programmatic usage — don't read disk
  const saved = getSetting("activeProfile")
  if (!saved) return
  // Validate the saved profile exists in the effective profile list
  const effective = getEffectiveProfiles(configProfiles)
  if (effective.length === 0 || effective.some(p => p.id === saved)) {
    activeProfileId = saved
  } else {
    console.warn(`[meridian] Saved active profile "${saved}" not found. Using default.`)
  }
}

/**
 * Get the effective profile list: config-provided profiles merged with
 * disk-loaded profiles. Disk profiles are re-read on each call so new
 * profiles added via `meridian profile add` are picked up without restart.
 */
/** Whether disk auto-discovery is enabled (set by CLI at startup) */
let diskDiscoveryEnabled = false

/** Enable disk auto-discovery of profiles. Called by the CLI when
 *  no MERIDIAN_PROFILES env var is set, so the server picks up
 *  profiles from ~/.config/meridian/profiles.json dynamically. */
export function enableDiskProfileDiscovery(): void {
  diskDiscoveryEnabled = true
}

export function getEffectiveProfiles(configProfiles: ProfileConfig[] | undefined): ProfileConfig[] {
  const fromConfig = configProfiles ?? []
  if (!diskDiscoveryEnabled) return fromConfig
  const fromDisk = loadProfilesFromDisk()
  // Config (env var) takes precedence; disk fills in anything not already defined
  const configIds = new Set(fromConfig.map(p => p.id))
  return [...fromConfig, ...fromDisk.filter(p => !configIds.has(p.id))]
}

/** Check if any profiles are available from any source */
export function hasProfiles(configProfiles: ProfileConfig[] | undefined): boolean {
  return getEffectiveProfiles(configProfiles).length > 0
}

/** Options for the sticky-routing resolution step (#383). */
export interface ResolveProfileOptions {
  /** Session identity for sticky assignment (adapter.getSessionId). */
  stickySessionKey?: string
  /** Routing mode — "active" (default, pre-#383 chain) or "sticky". */
  routingMode?: RoutingMode
}

/**
 * Resolve a profile from the configuration.
 *
 * Priority: header > sticky assignment (routing="sticky" only) > active >
 * config default > first profile. The sticky step exists so multi-account
 * setups can distribute sessions across profiles WITHOUT losing per-account
 * prompt caching — see routing.ts. With routingMode unset/"active" the
 * chain is exactly the pre-#383 behavior.
 *
 * @param profiles - Configured profiles (from ProxyConfig)
 * @param defaultProfile - Default profile ID (from ProxyConfig)
 * @param requestedId - Explicit profile ID from request header
 * @param options - Sticky-routing inputs (session key + mode)
 */
export function resolveProfile(
  profiles: ProfileConfig[] | undefined,
  defaultProfile: string | undefined,
  requestedId?: string,
  options?: ResolveProfileOptions
): ResolvedAnthropicProfile {
  return resolveProfileForProvider("anthropic", profiles, defaultProfile, requestedId, options)
}

export function resolveProfileForProvider(
  provider: "anthropic",
  profiles: ProfileConfig[] | undefined,
  defaultProfile: string | undefined,
  requestedId?: string,
  options?: ResolveProfileOptions,
): ResolvedAnthropicProfile
export function resolveProfileForProvider(
  provider: "openai",
  profiles: ProfileConfig[] | undefined,
  defaultProfile: string | undefined,
  requestedId?: string,
  options?: ResolveProfileOptions,
): ResolvedOpenAIProfile
export function resolveProfileForProvider(
  provider: ProfileProvider,
  profiles: ProfileConfig[] | undefined,
  defaultProfile: string | undefined,
  requestedId?: string,
  options?: ResolveProfileOptions,
): ResolvedProfile
export function resolveProfileForProvider(
  provider: ProfileProvider,
  profiles: ProfileConfig[] | undefined,
  defaultProfile: string | undefined,
  requestedId?: string,
  options?: ResolveProfileOptions,
): ResolvedProfile {
  const all = getEffectiveProfiles(profiles)

  // An explicitly named profile is a claim the client made. If it names a
  // profile belonging to another vendor the claim is false, and serving it
  // regardless is the cross-provider mix-up this scoping exists to prevent.
  if (requestedId) {
    const named = all.find(p => p.id === requestedId)
    if (named && profileProvider(named) !== provider) {
      throw new ProfileProviderMismatchError(requestedId, provider, profileProvider(named))
    }
  }

  if (provider === "openai") {
    const candidates = profilesForProvider(all, "openai")
    if (candidates.length === 0) throw new NoProfileForProviderError("openai")
    const chosen = requestedId
      ? candidates.find(p => p.id === requestedId)
      : candidates.find(p => p.id === activeProfileId)
        ?? candidates.find(p => p.id === defaultProfile)
        ?? candidates[0]
    // An explicit id naming nothing at all errors here rather than falling
    // back. Unlike the Anthropic chain there is no legacy behavior to keep.
    if (!chosen) throw new NoProfileForProviderError("openai")
    return {
      provider: "openai",
      id: chosen.id,
      authType: "chatgpt-oauth",
      accountUserId: chosen.accountUserId,
    }
  }

  const candidates = profilesForProvider(all, "anthropic")

  // No profiles configured — return empty env (standard single-account mode)
  if (candidates.length === 0) {
    return { provider: "anthropic", id: DEFAULT_PROFILE_ID, type: "claude-max", env: {} }
  }

  // Sticky assignment: only in sticky mode, only with a session identity,
  // and always subordinate to an explicit header override.
  const stickyId =
    options?.routingMode === "sticky" && options.stickySessionKey
      ? pickStickyProfile(options.stickySessionKey, candidates.map(p => p.id))
      : undefined

  // An ambient selection naming another vendor's profile is skipped in
  // silence: that is a valid configuration rather than a typo, and warning
  // about it on every /health and every 45s keepalive tick would be noise. An
  // id naming nothing at all still reaches the warning below, as it always has.
  const ambient = (id: string | undefined): string | undefined =>
    id && all.some(p => p.id === id) && !candidates.some(p => p.id === id) ? undefined : id

  // Priority: header > sticky > active > config default > first profile
  const resolvedId = requestedId || stickyId || ambient(activeProfileId) || ambient(defaultProfile) || candidates[0]!.id
  const profile = candidates.find(p => p.id === resolvedId)

  if (!profile) {
    console.warn(`[meridian] Unknown profile "${resolvedId}". Using first configured profile.`)
    return buildResolvedProfile(candidates[0]!)
  }

  return buildResolvedProfile(profile)
}

/**
 * Build env overrides for a profile config.
 */
function buildResolvedProfile(profile: AnthropicProfileConfig): ResolvedAnthropicProfile {
  if (profile.oauthToken || profile.type === "oauth-token") {
    const env: Record<string, string> = {}
    if (profile.oauthToken) {
      env.CLAUDE_CODE_OAUTH_TOKEN = profile.oauthToken
      // Isolate from host ~/.claude. Without this, the SDK's 401-recovery
      // silently reads host creds from disk and swaps a refreshed token in
      // for our env value, masking token failures. Path must not collapse
      // to ~/.claude — see query.ts re: upstream claude-code#20553.
      env.CLAUDE_CONFIG_DIR = join(homedir(), ".config", "meridian", "profiles", profile.id)
    }
    return { provider: "anthropic", id: profile.id, type: "oauth-token", env }
  }

  const type = profile.type ?? "claude-max"

  if (type === "api") {
    const env: Record<string, string> = {}
    if (profile.apiKey) env.ANTHROPIC_API_KEY = profile.apiKey
    if (profile.baseUrl) env.ANTHROPIC_BASE_URL = profile.baseUrl
    return { provider: "anthropic", id: profile.id, type, env }
  }

  // claude-max: override config directory
  const env: Record<string, string> = {}
  if (profile.claudeConfigDir) env.CLAUDE_CONFIG_DIR = profile.claudeConfigDir
  return { provider: "anthropic", id: profile.id, type, env }
}

/**
 * Get all configured profile IDs with their types.
 */
export function listProfiles(
  profiles: ProfileConfig[] | undefined,
  defaultProfile: string | undefined
): Array<{ id: string; provider: ProfileProvider; type: ProfileAuthType; isActive: boolean }> {
  const effective = getEffectiveProfiles(profiles)
  if (effective.length === 0) return []

  const currentActive = activeProfileId || defaultProfile || effective[0]!.id
  return effective.map(p => ({
    id: p.id,
    provider: profileProvider(p),
    type: p.provider === "openai" ? "chatgpt-oauth" : (p.type ?? "claude-max"),
    isActive: p.id === currentActive,
  }))
}
