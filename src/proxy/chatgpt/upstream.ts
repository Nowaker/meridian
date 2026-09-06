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

import { AssignmentStore, type ProfileExhaustion } from "../routing"
import type { UpstreamBackend, UpstreamRequest } from "../upstream/backend"
import { createChatGptBackend, type ChatGptServingAccount, type UpstreamFetch } from "./backend"
import { createChatGptCredentialStore, type ChatGptCredentialStore } from "./credentials"
import { acquireWriterLease, type WriterLease } from "./lease"
import { chatGptLockPath } from "./paths"
import { createChatGptRefresher, type ChatGptRefresher } from "./refresh"
import type { ChatGptFailure } from "./stream"
import { chatGptCooldownUntil, type ChatGptRateLimit } from "./windows"

/** Renew this far ahead of expiry, matching the Anthropic path's own margin. */
const ACCESS_TOKEN_BUFFER_MS = 5 * 60_000

/** How long a spent seat sits out when nothing said when it frees up. Matches the Anthropic pool's `PRIORITY_DEFAULT_COOLDOWN_MS`. */
const DEFAULT_COOLDOWN_MS = 10 * 60_000

/** Bounded because forgetting an affinity costs a cold prefix and nothing else. */
const MAX_CONVERSATIONS = 5_000

/**
 * The conversation this body belongs to, which is what a ChatGPT seat's prompt
 * cache is keyed on (D5). Deliberately not Claude's session machinery: a
 * Responses turn has no SDK session, no fork and no rollback authority to own.
 */
function conversationKey(body: Record<string, unknown> | undefined): string | undefined {
  const key = body?.prompt_cache_key
  return typeof key === "string" && key.length > 0 ? key : undefined
}

export interface ChatGptUpstreamOptions<Ctx> {
  storePath: string
  /** Rebuild the inbound request; the dispatch seam has already spent the original's body. */
  inboundRequest: (context: Ctx) => Request | Promise<Request>
  /**
   * The seats this request is entitled to, in configured order, before
   * cooldown and affinity are applied. Empty when no ChatGPT profile answers
   * for it. A client naming one explicitly gets that one alone: an explicit
   * claim is honoured rather than rotated away from.
   */
  configuredSeats: (request: UpstreamRequest<Ctx>) => readonly string[]
  /**
   * The OPENAI partition of the provider-scoped tracker, never a shared one.
   * Profile and seat ids are operator-chosen strings, so a tracker holding
   * both vendors would let a spent Claude account bench a ChatGPT seat.
   */
  exhaustion: ProfileExhaustion
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

  const affinity = new AssignmentStore(MAX_CONVERSATIONS)

  const candidateSeats = (
    request: UpstreamRequest<Ctx>,
    body: Record<string, unknown> | undefined,
  ): readonly string[] => {
    // Checked here rather than only at acquisition. A holder can be displaced
    // after a crash-recovery window, and the moment before a token is spent is
    // the only one at which discovering that is still useful.
    if (!store || !refresher || !holdsLease()) return []

    const live = options.configuredSeats(request).filter(id => !options.exhaustion.isExhausted(id))

    // A conversation stays on the seat that already holds its prompt prefix,
    // for as long as that seat can serve. Moving it costs a full cold cache,
    // so only a seat that has actually dropped out gets one moved off it - and
    // only NEW conversations drain back once it returns.
    const sticky = conversationKey(body)
    const preferred = sticky ? affinity.get(sticky)?.profileId : undefined
    return preferred !== undefined && live.includes(preferred)
      ? [preferred, ...live.filter(id => id !== preferred)]
      : live
  }

  const seatCredentials = async (accountUserId: string): Promise<ChatGptServingAccount | null> => {
    if (!store || !refresher || !holdsLease()) return null

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

  // The refusal usually states when this seat frees up, and a real reset beats
  // a guess in both directions: benching a weekly window for ten minutes
  // re-probes it with a failing request every ten minutes for days, and
  // benching a five-hour one for a week idles an account that recovered.
  const benchSeat = (
    accountUserId: string,
    failure: ChatGptFailure,
    rateLimit: ChatGptRateLimit | null,
  ): void => {
    options.exhaustion.mark(
      accountUserId,
      chatGptCooldownUntil(rateLimit, now()) ?? now() + DEFAULT_COOLDOWN_MS,
      failure.kind,
    )
  }

  // A seat that just served can already be out of allowance, and it says so on
  // that very answer. Benching it here spends nothing; leaving it costs the
  // next request a real refusal to discover the same fact. Nothing is marked
  // unless a window is genuinely spent - a healthy account reports its windows
  // too, and presence is not exhaustion.
  const noteSeatLimits = (accountUserId: string, rateLimit: ChatGptRateLimit | null): void => {
    const until = chatGptCooldownUntil(rateLimit, now())
    if (until !== null) options.exhaustion.mark(accountUserId, until, "quota_spent")
  }

  const noteServed = (body: Record<string, unknown> | undefined, accountUserId: string): void => {
    const key = conversationKey(body)
    if (key) affinity.set(key, { profileId: accountUserId, requestId: undefined })
  }

  return {
    ownedAccounts: owned.length,

    backend: createChatGptBackend<Ctx>({
      inboundRequest: options.inboundRequest,
      candidateSeats,
      seatCredentials,
      benchSeat,
      noteSeatLimits,
      noteServed,
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
