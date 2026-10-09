import { noteApiRejected, noteCredentialObserved } from "./authLifecycle"
import { isExpiredTokenError } from "./errors"
import type { ClaudeAuthStatus } from "./models"
import type { ResolvedProfile } from "./profiles"
import { createPlatformCredentialStore, readStoredCredentialSnapshot, type CredentialStore, type StoredCredentialPresence } from "./tokenRefresh"

export type ProfileLoginState = "authenticated" | "needs_login" | "unverified"

export function profileLoginState(input: {
  readonly loggedIn?: boolean
  readonly presence?: StoredCredentialPresence
  readonly firstUnauthedAt?: number | null
}): ProfileLoginState {
  if (input.firstUnauthedAt || input.presence === "absent" || input.loggedIn === false) return "needs_login"
  return input.loggedIn === true ? "authenticated" : "unverified"
}

export async function reconcileClaudeProfileAuth(
  auth: ClaudeAuthStatus | null,
  profile: ResolvedProfile,
  store?: CredentialStore,
): Promise<ClaudeAuthStatus | null> {
  if (profile.type !== "claude-max") return auth
  const profileStore = store ?? createPlatformCredentialStore({ claudeConfigDir: profile.env.CLAUDE_CONFIG_DIR })
  const stored = await readStoredCredentialSnapshot(profileStore)
  const lifecycle = noteCredentialObserved(profileStore.refreshKey, stored)
  const state = profileLoginState({ loggedIn: auth?.loggedIn, presence: stored.presence, firstUnauthedAt: lifecycle?.firstUnauthedAt })
  return state === "needs_login" ? { ...auth, loggedIn: false } : auth
}

export async function noteClaudeAuthenticationFailure(profile: ResolvedProfile, input: { message: string; startedAt: number }): Promise<void> {
  if (profile.type !== "claude-max" || !(isExpiredTokenError(input.message) || input.message.toLowerCase().includes("failed to authenticate: oauth session"))) return
  const store = createPlatformCredentialStore({ claudeConfigDir: profile.env.CLAUDE_CONFIG_DIR })
  noteCredentialObserved(store.refreshKey, await readStoredCredentialSnapshot(store))
  noteApiRejected(store.refreshKey, { startedAt: input.startedAt })
}
