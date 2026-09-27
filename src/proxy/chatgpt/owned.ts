/**
 * owned: serve from Meridian's own ChatGPT store, with refresh authority.
 *
 * Seats come from the store (`MERIDIAN_CHATGPT_STORE_PATH`, default
 * `~/.config/meridian/chatgpt-accounts.json`), filled by the importer - never
 * from Claude's ProfileConfig, which has no place for these credentials.
 *
 * THE LEASE IS TAKEN SEPARATELY, AND LATER. Construction happens inside
 * `createProxyServer`, which tests call constantly and which no embedder
 * expects to seize a machine-wide resource. `acquire` is the explicit step the
 * owned lifecycle performs at startup, and it fails rather than degrades:
 * two processes exchanging one single-use refresh token is unrecoverable.
 * Without the lease `credentials` answers `no_authority` for every seat.
 */
import type { CodexPoolResult } from "../codex/pool"
import { createChatGptCredentialStore, type ChatGptCredentialStore } from "./credentials"
import { acquireWriterLease, type WriterLease } from "./lease"
import { chatGptLockPath } from "./paths"
import { createChatGptRefresher, type ChatGptRefresher, type TokenExchangeFetch } from "./refresh"
import type { ChatGptCredentialSource, ChatGptSeatView } from "./source"

/** Renew this far ahead of expiry, matching the Claude path's own margin. */
const ACCESS_TOKEN_BUFFER_MS = 5 * 60_000

export interface OwnedSourceOptions {
  storePath: string
  leaseWaitMs?: number
  staleMs?: number
  heartbeatMs?: number
  /** Token-endpoint fetch, injectable for tests. */
  fetchImpl?: TokenExchangeFetch
  now?: () => number
}

/** Undefined when the store holds no accounts: nothing to own, nothing to serve. */
export function createOwnedCredentialSource(options: OwnedSourceOptions): ChatGptCredentialSource | undefined {
  const { storePath } = options
  // A store that exists but cannot be read throws here and stops startup.
  // Guessing it is empty would silently turn an owning instance into one that
  // routes GPT names back to Claude.
  if (createChatGptCredentialStore({ path: storePath }).readAccounts().length === 0) return undefined

  const now = options.now ?? Date.now
  const reader = createChatGptCredentialStore({ path: storePath })
  let lease: WriterLease | undefined
  let store: ChatGptCredentialStore | undefined
  let refresher: ChatGptRefresher | undefined

  const holdsLease = (): boolean => {
    if (!lease) return false
    try {
      lease.assertValid()
      return true
    } catch {
      return false
    }
  }

  return {
    mode: "owned",

    seats() {
      return reader.readAccounts().map((account, index): ChatGptSeatView => {
        const pending = account.exchangeStartedAt !== null
        return {
          id: account.accountUserId,
          email: account.email,
          planType: null,
          eligible: !pending,
          ...(pending ? { reason: "requires_reauth" as const } : {}),
          expiresAt: account.expiresAt,
          active: index === 0,
        }
      })
    },

    candidateSeats() {
      return reader.readAccounts().map(account => account.accountUserId)
    },

    async credentials(seat) {
      // Checked here rather than only at acquisition: a holder can be
      // displaced after a crash-recovery window, and the moment before a token
      // is spent is the only one at which discovering that is still useful.
      if (!store || !refresher || !holdsLease()) return { ok: false, reason: "no_authority" }
      const account = store.readAccount(seat)
      if (!account) return { ok: false, reason: "unknown" }
      if (account.accessToken && account.expiresAt !== null && account.expiresAt - now() > ACCESS_TOKEN_BUFFER_MS) {
        return { ok: true, account: { accountUserId: seat, accountId: account.accountId, accessToken: account.accessToken } }
      }
      const outcome = await refresher.refreshAccount(seat)
      if (outcome.status === "refreshed") {
        return { ok: true, account: { accountUserId: seat, accountId: account.accountId, accessToken: outcome.accessToken } }
      }
      return { ok: false, reason: outcome.status === "requires-reauth" ? "requires_reauth" : "no_authority" }
    },

    isServing: holdsLease,

    usagePool(): CodexPoolResult {
      // Read-only, and re-read so the dashboard observes token rotation.
      return {
        error: null,
        pool: {
          path: storePath,
          accounts: reader.readAccounts().map(account => ({
            accountUserId: account.accountUserId,
            accountId: account.accountId,
            email: account.email,
            accessToken: account.accessToken,
            expiresAt: account.expiresAt,
            organizationId: null,
            accountLabel: null,
            planType: null,
            enabled: true,
          })),
        },
      }
    },

    describeUnavailable(reasons) {
      if (reasons.has("no_authority")) return "This Meridian does not hold refresh authority for its ChatGPT accounts."
      if (reasons.has("requires_reauth")) return "Every ChatGPT account this Meridian owns needs an interactive login."
      return "Every ChatGPT account this Meridian owns is spent or unavailable."
    },

    async acquire() {
      if (lease) return
      const acquired = await acquireWriterLease({
        lockPath: chatGptLockPath(storePath),
        ...(options.staleMs === undefined ? {} : { staleMs: options.staleMs }),
        ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
        waitMs: options.leaseWaitMs ?? 0,
      })
      lease = acquired
      store = createChatGptCredentialStore({ path: storePath, lease: acquired })
      refresher = createChatGptRefresher({ store, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}), now })
    },

    release() {
      const held = lease
      lease = undefined
      store = undefined
      refresher = undefined
      held?.release()
    },
  }
}
