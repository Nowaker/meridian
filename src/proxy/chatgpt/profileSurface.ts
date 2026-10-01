/**
 * The ChatGPT half of Meridian's profile surface.
 *
 * `/profiles/list`, `/v1/usage/quota/all`, `POST /profiles/active`,
 * `POST /profiles/:id/warm`, `/profiles/events` and the routing exclusions are
 * the one interface an account supervisor (Vibeterm's switcher and warmer)
 * drives Claude accounts through. ChatGPT seats join that interface here
 * instead of getting a second one: server.ts keeps the routes and appends what
 * this returns, so the supervisor's code is the same for both providers and
 * only `type: "chatgpt"` tells them apart.
 *
 * What this owns: the ChatGPT active pointer's meaning, how a turn is routed
 * across seats (active first, exclusions honoured, a pin obeyed), the entries
 * each route returns, and a refusal translated into the limit vocabulary the
 * events ring already speaks. What it does not own: storage of the pointer and
 * of the exclusions (settings, injected), the usage reading (injected), and
 * any credential - nothing here sees a token.
 */
import type { CodexUsageResponse } from "../codex/types"
import type { LimitDiagnosis } from "../limitDetection"
import type { SpentRecord } from "../profileHealth"
import {
  CHATGPT_PROFILE_TYPE,
  chatGptOwner,
  chatGptProfiles,
  chatGptQuotaError,
  chatGptRemovalRefusal,
  chatGptResetsView,
  chatGptTokenState,
  findChatGptProfile,
  planChatGptRename,
  profileWindowType,
  seatWindows,
  type ChatGptProfile,
  type ObservedRateLimit,
} from "./profiles"
import type { ChatGptCreditsPolicy } from "./features"
import type { ChatGptCredentialSource } from "./source"
import type { ChatGptRateLimit, ChatGptUsageWindow } from "./windows"

/**
 * The warm request's model, cheapest first. GPT-6 Luna is listed for every
 * plan and served on the probed seats; an account outside the GPT-6 rollout
 * refuses it as unsupported, and 5.6 Luna is the same tier one generation
 * back. A refusal of the model is a request refusal (400), never a seat one.
 */
export const CHATGPT_WARM_MODELS = ["gpt-6-luna", "gpt-5.6-luna"] as const

/**
 * The smallest real Responses request: one short user turn, the lowest
 * reasoning effort both warm models accept, terse output. No
 * `max_output_tokens` - the backend refuses that field outright.
 */
export function chatGptWarmBody(model: string): Record<string, unknown> {
  return {
    model,
    stream: false,
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    reasoning: { effort: "low" },
    text: { verbosity: "low" },
  }
}

export interface ChatGptProfileSurfaceDeps {
  source: ChatGptCredentialSource
  observed: () => ReadonlyMap<string, ObservedRateLimit>
  /** The seat's effective credits policy and where it comes from. */
  creditsPolicy?: (seat: string) => { policy: ChatGptCreditsPolicy; source: "seat" | "default" }
  /** Whether the seat's plan is spent and whether it is serving on credits now (the backend's view). */
  creditState?: (seat: string) => { planSpent: boolean; servingOnCredits: boolean }
  usage: () => CodexUsageResponse | null
  /** Ids a ChatGPT profile must not take: the Claude profiles', and `default`. */
  reserved: () => ReadonlySet<string>
  names: () => Readonly<Record<string, unknown>> | undefined
  /** Former ids of renamed seats, seat id -> ids (the `chatGptProfileAliases` setting). */
  aliases?: () => Readonly<Record<string, unknown>> | undefined
  /** The persisted pointer, a seat id. */
  activeSeat: () => string | undefined
  /** Routing exclusions as configured: profile ids, seat ids, or Claude ids (ignored here). */
  excluded: () => readonly string[]
  /** The saved profile order (`profileOrder`), Claude ids included; ChatGPT failover follows it after the active seat. */
  order?: () => readonly string[] | undefined
  spent: (profileId: string) => SpentRecord | undefined
}

export type ChatGptActivation =
  | { ok: true; profile: ChatGptProfile }
  | { ok: false; status: 400 | 409; error: string }

export function createChatGptProfileSurface(deps: ChatGptProfileSurfaceDeps) {
  const planTypes = (): Map<string, string | null> => new Map(
    (deps.usage()?.entries ?? []).map(entry => [entry.id, entry.plan?.slug ?? null]),
  )

  const profiles = (): ChatGptProfile[] => chatGptProfiles(deps.source.seats(), {
    reserved: deps.reserved(),
    names: deps.names(),
    planTypes: planTypes(),
    aliases: deps.aliases?.(),
  })

  /** Seats in the saved order, or undefined while the order names none of them. */
  const savedSeatOrder = (list: readonly ChatGptProfile[]): string[] | undefined => {
    const seats: string[] = []
    for (const id of deps.order?.() ?? []) {
      const profile = findChatGptProfile(list, id)
      if (profile && !seats.includes(profile.seat)) seats.push(profile.seat)
    }
    return seats.length > 0 ? seats : undefined
  }

  const excludedSeats = (list: readonly ChatGptProfile[]): Set<string> => {
    const seats = new Set<string>()
    for (const id of deps.excluded()) {
      const profile = findChatGptProfile(list, id)
      if (profile) seats.add(profile.seat)
    }
    return seats
  }

  /**
   * The pointer while it names a seat that may take work; otherwise the
   * credential owner's own pick, which is where an unpinned turn would go
   * anyway. An exhausted active seat stays active - the pointer is the
   * supervisor's decision, and serving around it is failover, not a switch.
   */
  const active = (list: readonly ChatGptProfile[]): ChatGptProfile | undefined => {
    const excluded = excludedSeats(list)
    const pointer = findChatGptProfile(list, deps.activeSeat())
    if (pointer && !excluded.has(pointer.seat)) return pointer
    // Without a pointer, the pick is the seat a turn would go to first: one
    // with plan quota, or one whose policy spends its credits at once.
    const servesFirst = (profile: ChatGptProfile) => !deps.creditState?.(profile.seat).planSpent
      || deps.creditsPolicy?.(profile.seat).policy === "immediately"
    const candidates = list.filter(profile => !excluded.has(profile.seat))
    return candidates.find(profile => profile.ownerActive && servesFirst(profile))
      ?? candidates.find(profile => profile.eligible && servesFirst(profile))
      ?? candidates.find(profile => profile.ownerActive)
      ?? candidates.find(profile => profile.eligible)
  }

  return {
    profiles,
    resolve: (idOrSeat: string | null | undefined) => findChatGptProfile(profiles(), idOrSeat),
    activeProfileId: (): string | null => active(profiles())?.id ?? null,

    /** Validate a switch; the caller persists `profile.seat` and logs it. */
    activate(idOrSeat: string): ChatGptActivation {
      const list = profiles()
      const profile = findChatGptProfile(list, idOrSeat)
      if (!profile) return { ok: false, status: 400, error: `Unknown profile: ${idOrSeat}` }
      if (excludedSeats(list).has(profile.seat)) {
        return { ok: false, status: 409, error: `Profile "${profile.id}" is excluded from work routing` }
      }
      return { ok: true, profile }
    },

    /**
     * Where one turn may go. `pin` is the request's own profile header and is
     * obeyed only when it names a ChatGPT seat - on an instance serving both
     * providers it may name a Claude profile, which says nothing here. A warm
     * may use an excluded seat, as a Claude warm may; work may not.
     */
    route(pin: string | undefined, purpose: "work" | "warm") {
      const list = profiles()
      const excluded = excludedSeats(list)
      const pinned = findChatGptProfile(list, pin)
      if (pinned) {
        if (purpose === "work" && excluded.has(pinned.seat)) {
          return { kind: "refuse" as const, profile: pinned }
        }
        return { kind: "pinned" as const, seat: pinned.seat }
      }
      return { kind: "pool" as const, preferred: active(list)?.seat, excluded, order: savedSeatOrder(list) }
    },

    /** Profile id for a seat, for telemetry and events. */
    profileIdFor(seat: string): string | undefined {
      return profiles().find(profile => profile.seat === seat)?.id
    },

    /** Who owns these seats' logins, for a page offering to add one. */
    owner: () => chatGptOwner(deps.source.mode, null),

    /** Validate a rename; the caller persists `names` and `aliasesBySeat`. */
    planRename: (from: string, to: string) => planChatGptRename({
      profiles: profiles(),
      reserved: deps.reserved(),
      names: deps.names(),
      aliases: deps.aliases?.(),
      from,
      to,
    }),

    /** Why a remove of this seat is refused, and what removes it at its owner. */
    removalRefusal(profile: ChatGptProfile): string {
      return chatGptRemovalRefusal(profile, chatGptOwner(deps.source.mode, profile.storeIndex))
    },

    listEntries() {
      const list = profiles()
      const activeId = active(list)?.id
      const usage = deps.usage()
      const usageById = new Map((usage?.entries ?? []).map(entry => [entry.id, entry]))
      return list.map(profile => {
        const reading = usageById.get(profile.seat)
        const tokenState = chatGptTokenState(profile.unavailable, reading?.error)
        const owner = chatGptOwner(deps.source.mode, profile.storeIndex)
        return {
          id: profile.id,
          type: CHATGPT_PROFILE_TYPE,
          provider: CHATGPT_PROFILE_TYPE,
          label: profile.label,
          seat: profile.seat,
          isActive: profile.id === activeId,
          ...(profile.aliases.length > 0 ? { aliases: profile.aliases } : {}),
          email: profile.email,
          subscriptionType: profile.subscriptionType,
          // The seat's Business workspace is its organization, as a Claude
          // Team account's is.
          organizationName: reading?.workspaceName ?? null,
          rateLimitTier: null,
          seatTier: null,
          allowance: profile.allowance,
          allowanceWeight: profile.allowanceWeight,
          planLabel: profile.planLabel,
          accountType: profile.accountType,
          planName: profile.planName,
          loggedIn: tokenState === "ok",
          tokenState,
          unavailable: profile.unavailable,
          resets: chatGptResetsView(reading?.resetCredits),
          owner,
          removal: chatGptRemovalRefusal(profile, owner),
          // A usage read succeeding is chatgpt.com accepting the token, the
          // same evidence Claude's "Last Verified" rests on.
          lastCheckedAt: reading?.failure?.lastFailureAt ?? reading?.fetchedAt ?? null,
          lastSuccessAt: reading?.fetchedAt ?? null,
          authProvenance: "live" as const,
          credentialDir: null,
        }
      })
    },

    quotaEntries() {
      const list = profiles()
      const activeId = active(list)?.id
      const usageById = new Map((deps.usage()?.entries ?? []).map(entry => [entry.id, entry]))
      const observed = deps.observed()
      return list.map(profile => {
        const usage = usageById.get(profile.seat)
        const reading = seatWindows({ usage, observed: observed.get(profile.seat) })
        const policy = deps.creditsPolicy?.(profile.seat)
        const creditState = deps.creditState?.(profile.seat)
        // A failed usage check explains the figures only if it came after
        // them: a response's headers may have given newer ones since.
        const failure = usage?.failure && (reading.fetchedAt === null || usage.failure.lastFailureAt > reading.fetchedAt)
          ? usage.failure
          : null
        return {
          id: profile.id,
          isActive: profile.id === activeId,
          type: CHATGPT_PROFILE_TYPE,
          provider: CHATGPT_PROFILE_TYPE,
          windows: reading.windows,
          windowsReported: reading.windowsReported,
          windowSource: reading.source,
          extraUsage: null,
          credits: usage?.credits ?? null,
          creditsPolicy: policy?.policy ?? null,
          creditsPolicySource: policy?.source ?? null,
          planSpent: creditState?.planSpent ?? false,
          servingOnCredits: creditState?.servingOnCredits ?? false,
          fetchedAt: reading.fetchedAt,
          stale: reading.stale,
          error: chatGptQuotaError(profile.unavailable, usage?.error, reading.windows.length > 0),
          failure,
          spent: deps.spent(profile.id) ?? null,
        }
      })
    },
  }
}

export type ChatGptProfileSurface = ReturnType<typeof createChatGptProfileSurface>

function spentWindow(rateLimit: ChatGptRateLimit | null): ChatGptUsageWindow | null {
  let widest: ChatGptUsageWindow | null = null
  for (const window of [rateLimit?.primary_window, rateLimit?.secondary_window]) {
    if (!window || (window.used_percent ?? 0) < 100) continue
    if (!widest || (window.limit_window_seconds ?? 0) > (widest.limit_window_seconds ?? 0)) widest = window
  }
  return widest
}

/**
 * A seat's refusal in the events ring's limit vocabulary.
 *
 * The bucket is the widest window the refusing response itself reported spent
 * - the same one the bench is timed to - so it is `reported`, never inferred.
 */
export function chatGptRefusalDiagnosis(refusal: { kind: string; until: number; rateLimit: ChatGptRateLimit | null }): LimitDiagnosis {
  if (refusal.kind === "requires_reauth") {
    return { bucket: null, reported: false, source: "unknown", resetsAt: null, rationale: "The ChatGPT backend refused this seat's access token." }
  }
  const window = spentWindow(refusal.rateLimit)
  if (!window) {
    return {
      bucket: null, reported: false, source: "unknown", resetsAt: refusal.until,
      rationale: "The ChatGPT backend refused this seat without stating which window is spent.",
    }
  }
  const bucket = profileWindowType(window.limit_window_seconds)
  return {
    bucket, reported: true, source: "response_headers", resetsAt: refusal.until,
    rationale: `The ChatGPT backend reported this seat's ${bucket} window spent.`,
  }
}
