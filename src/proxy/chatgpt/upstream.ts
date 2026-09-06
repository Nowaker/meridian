/**
 * What an instance that OWNS ChatGPT accounts is allowed to do with them.
 *
 * Ownership is read from Meridian's own store and from nowhere else. It is
 * what decides whether a GPT model name still means Claude, so it must not be
 * inferable from configuration intent: an instance can be told about a ChatGPT
 * profile and still hold none of its credentials, and that instance has to go
 * on behaving exactly as it did before this module existed.
 *
 * OWNING NOTHING RETURNS `undefined` RATHER THAN AN INACTIVE OBJECT. Two live
 * instances on the operator's machine own nothing and one of them holds the
 * Anthropic credentials every Claude session here depends on. A guard that has
 * to be remembered at each call site is a guard that can be forgotten once;
 * having no object to call is a guard that cannot be.
 *
 * THE LEASE IS TAKEN SEPARATELY, AND LATER. Construction happens inside
 * `createProxyServer`, which the test suite calls constantly and which no
 * embedder expects to seize a machine-wide resource. Acquiring is an explicit
 * async step the owned lifecycle performs at startup.
 *
 * A STORE THAT CANNOT BE READ STOPS THE INSTANCE. Refusing to start is
 * recoverable; guessing that an unreadable store holds nothing would silently
 * turn an owning instance back into a Claude-serving one, which is the shape
 * of failure this project has already paid for once.
 */

import type { UpstreamBackend, UpstreamRequest } from "../upstream/backend"
import { createChatGptBackend, type ChatGptServingAccount, type UpstreamFetch } from "./backend"
import { createChatGptCredentialStore, type ChatGptCredentialStore } from "./credentials"
import { acquireWriterLease, type WriterLease } from "./lease"
import { chatGptLockPath } from "./paths"
import { createChatGptRefresher, type ChatGptRefresher } from "./refresh"

/** Renew this far ahead of expiry, matching the Anthropic path's own margin. */
const ACCESS_TOKEN_BUFFER_MS = 5 * 60_000

export interface ChatGptUpstreamOptions<Ctx> {
  storePath: string
  /** Rebuild the inbound request; the dispatch seam has already spent the original's body. */
  inboundRequest: (context: Ctx) => Request | Promise<Request>
  /** Which seat serves this request, or null when no ChatGPT profile answers for it. */
  selectSeat: (request: UpstreamRequest<Ctx>) => string | null
  leaseWaitMs?: number
  staleMs?: number
  heartbeatMs?: number
  fetchImpl?: UpstreamFetch
  now?: () => number
}

export interface ChatGptUpstream<Ctx> {
  /** How many seats this instance holds credentials for. */
  readonly ownedAccounts: number
  readonly backend: UpstreamBackend<Ctx>
  /** Whether a request could actually be served right now. */
  isServing(): boolean
  acquire(): Promise<void>
  release(): void
}

/** Undefined when this instance owns no ChatGPT credentials at all. */
export function createChatGptUpstream<Ctx>(
  options: ChatGptUpstreamOptions<Ctx>,
): ChatGptUpstream<Ctx> | undefined {
  const { storePath } = options
  const owned = createChatGptCredentialStore({ path: storePath }).readAccounts()
  if (owned.length === 0) return undefined

  const now = options.now ?? Date.now
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

  const servingAccount = async (
    request: UpstreamRequest<Ctx>,
  ): Promise<ChatGptServingAccount | null> => {
    // Checked here rather than at acquisition. A holder can be displaced after
    // a crash-recovery window, and the moment before a token is spent is the
    // only one at which discovering that is still useful.
    if (!store || !refresher || !holdsLease()) return null

    const accountUserId = options.selectSeat(request)
    if (!accountUserId) return null

    // By seat, never by workspace: one `accountId` is shared between distinct
    // people in the operator's real pool, so a lookup that fell back to it
    // would serve one person's request with another's credential.
    const account = store.readAccount(accountUserId)
    if (!account) return null

    if (
      account.accessToken
      && account.expiresAt !== null
      && account.expiresAt - now() > ACCESS_TOKEN_BUFFER_MS
    ) {
      return { accountUserId, accountId: account.accountId, accessToken: account.accessToken }
    }

    const outcome = await refresher.refreshAccount(accountUserId)
    if (outcome.status !== "refreshed") return null
    return { accountUserId, accountId: account.accountId, accessToken: outcome.accessToken }
  }

  return {
    ownedAccounts: owned.length,

    backend: createChatGptBackend<Ctx>({
      inboundRequest: options.inboundRequest,
      selectAccount: servingAccount,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    }),

    isServing: holdsLease,

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
      refresher = createChatGptRefresher({
        store,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        now,
      })
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
