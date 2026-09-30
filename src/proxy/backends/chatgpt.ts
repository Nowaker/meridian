/**
 * The ChatGPT upstream backend: one complete provider request, passed through.
 *
 * The upstream already speaks Responses, so nothing is translated. The body is
 * adapted only where the Codex backend requires it (chatgpt/body.ts) and the
 * response stream comes back byte for byte. This path never enters the Claude
 * pipeline: no adapter detection, no system-prompt handling, no plugin
 * `onRequest`/`onResponse` hooks - which is what keeps a Claude-oriented
 * plugin such as opencode-scrub from rewriting a ChatGPT request. It is still
 * observed: every client turn produces one `ChatGptTurnEvent` for telemetry.
 *
 * Both directions are contained. Outbound headers are built from nothing
 * (chatgpt/request.ts), so nothing the client sent reaches the provider but
 * the body; and only an allowlist of response headers comes back, so a client
 * is never handed chatgpt.com's cookies.
 *
 * Seats and tokens come from a `ChatGptCredentialSource` (owned or
 * follow-external). What is decided here is rotation: try a seat, read far
 * enough into the answer to know whether the SEAT failed, and move on if it
 * did. Retrying stops where the failure sniffer stops - after the client could
 * have seen output, serving the turn again would bill a second account for the
 * same work.
 *
 * Hook points for later features (Max Budget, fallback model, pricing) are the
 * `hooks` option; see ChatGptHooks.
 */
import { randomUUID } from "node:crypto"
import { AssignmentStore, type ProfileExhaustion } from "../routing"
import type { UpstreamBackend, UpstreamRequest } from "../upstream/backend"
import { adaptResponsesBody, type BodyAdaptation } from "../chatgpt/body"
import { buildCodexRequest } from "../chatgpt/request"
import { sniffChatGptFailure, type ChatGptFailureKind } from "../chatgpt/stream"
import { aggregateResponsesStream, tapResponsesStream, type ChatGptUsage, type TapSummary } from "../chatgpt/tap"
import { chatGptCooldownUntil, chatGptRateLimitFromHeaders, type ChatGptRateLimit } from "../chatgpt/windows"
import type { ChatGptCredentialSource, SeatUnavailableReason } from "../chatgpt/source"

export type UpstreamFetch = (url: string, init: RequestInit) => Promise<Response>

/** What a hook sees of a turn before it is dispatched. */
export interface ChatGptTurnInfo {
  requestId: string
  model: string | undefined
  /** The client's body as received, before adaptation. Do not mutate. */
  body: Readonly<Record<string, unknown>>
  headers: Headers
}

export interface ChatGptAttempt {
  seat: string
  status: number
  failure: ChatGptFailureKind | null
}

/** One per client turn, success or failure. Carries no credential. */
export interface ChatGptTurnEvent {
  requestId: string
  startedAt: number
  requestModel: string | null
  /** The model the provider says answered, when it said. */
  model: string | null
  seat: string | null
  status: number
  stream: boolean
  adaptations: BodyAdaptation[]
  attempts: ChatGptAttempt[]
  usage: ChatGptUsage | null
  ttfbMs: number | null
  durationMs: number
  error: string | null
  reasoningSummaryEvents: number
  requestSource?: string
}

/** A seat said no to a turn: benched until `until`. Carries no credential. */
export interface ChatGptSeatRefusal {
  requestId: string
  seat: string
  kind: Exclude<ChatGptFailureKind, "transient">
  status: number
  until: number
  /** The limit state the refusing response stated, when it stated one. */
  rateLimit: ChatGptRateLimit | null
}

export interface ChatGptHooks {
  /**
   * Admission before any seat is tried - the Max Budget seam. Return a
   * Response to refuse the turn; it is returned to the client as is.
   */
  admit?(turn: ChatGptTurnInfo): Response | undefined | Promise<Response | undefined>
  /**
   * Every seat was unavailable or refused - the Fallback Model seam. Return a
   * Response to serve the turn another way, or undefined for the default error.
   */
  onPoolExhausted?(turn: ChatGptTurnInfo & { reasons: ReadonlySet<SeatUnavailableReason> }): Promise<Response | undefined>
  /** Usage/telemetry seam: called once per client turn when it ends. */
  onTurn?(event: ChatGptTurnEvent): void
  /**
   * Refusal seam for an account supervisor: each seat that refused, and how
   * the turn ended for the refused seats - `servedBy` another seat, or every
   * candidate refused (`servedBy: null`).
   */
  onSeatRefused?(refusal: ChatGptSeatRefusal): void
  onRefusalsSettled?(outcome: { requestId: string; refused: readonly ChatGptSeatRefusal[]; servedBy: string | null }): void
}

/**
 * Which seats may serve this turn, decided by the caller (server.ts owns the
 * active pointer, the routing exclusions and the trust of internal headers).
 *
 * - `pool`: every eligible seat, `preferred` first when it can serve, the
 *   `excluded` ones never. The rest follow `order` (the saved profile
 *   order) where given, then the credential owner's order.
 * - `pinned`: that seat only, no failover - an explicit profile header, or a
 *   warm.
 * - `refuse`: answered before any seat is tried.
 */
export type ChatGptRoute =
  | { kind: "pool"; preferred?: string; excluded: ReadonlySet<string>; order?: readonly string[] }
  | { kind: "pinned"; seat: string }
  | { kind: "refuse"; response: Response; error: string }

export interface ChatGptBackendOptions<Ctx> {
  source: ChatGptCredentialSource
  /** Rebuild the inbound request; dispatch has already read the original's body. */
  inboundRequest: (context: Ctx) => Request | Promise<Request>
  /** A ChatGPT-only exhaustion tracker; never shared with Claude profiles. */
  exhaustion: ProfileExhaustion
  /** Seat selection per turn; without it every eligible seat serves in the owner's order. */
  route?: (turn: ChatGptTurnInfo) => ChatGptRoute
  hooks?: ChatGptHooks
  fetchImpl?: UpstreamFetch
  now?: () => number
}

export interface ObservedSeatLimits {
  rateLimit: ChatGptRateLimit
  at: number
}

export interface ChatGptBackend<Ctx> extends UpstreamBackend<Ctx> {
  /** Latest `x-codex-*` window headers per seat, from real responses. */
  observedLimits(): ReadonlyMap<string, ObservedSeatLimits>
}

/** How long a spent seat sits out when the refusal named no reset. */
const DEFAULT_COOLDOWN_MS = 10 * 60_000
/**
 * A refused token is benched briefly: in follow-external mode the owner may
 * refresh it at any moment, and the next request re-reads it anyway.
 */
const REAUTH_COOLDOWN_MS = 60_000
const MAX_CONVERSATIONS = 5_000

const FORWARDED_RESPONSE_HEADERS = ["content-type", "cache-control", "retry-after"] as const

function errorResponse(status: number, type: string, message: string): Response {
  return new Response(JSON.stringify({ error: { type, message, code: null } }), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function forwardHeaders(upstream: Response): Headers {
  const headers = new Headers()
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name)
    if (value !== null) headers.set(name, value)
  }
  return headers
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** Seats the order names first, in its order; the rest after them, as they came. */
function inSavedOrder(seats: readonly string[], order: readonly string[]): string[] {
  const rank = new Map(order.map((seat, index) => [seat, index]))
  return seats
    .map((seat, index) => ({ seat, index, rank: rank.get(seat) ?? Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(entry => entry.seat)
}

/**
 * The backend's answer to a request it refuses as a request - an unsupported
 * model, a field it rejects - rather than as a seat failure.
 *
 * The Codex backend states such refusals as `{"detail": "..."}`, which an
 * OpenAI client does not read: it looks for `error.message` and would show a
 * generic failure instead of the reason. That one shape is re-enveloped, with
 * the backend's status and its own words; anything else is returned verbatim.
 * This touches the RESPONSE only, and only on a refusal.
 */
async function requestRefusal(status: number, body: ReadableStream<Uint8Array>, headers: Headers): Promise<Response> {
  const text = await new Response(body).text()
  let detail: string | undefined
  try {
    const parsed = asRecord(JSON.parse(text) as unknown)
    detail = parsed && !parsed.error && typeof parsed.detail === "string" ? parsed.detail : undefined
  } catch {
    detail = undefined
  }
  return detail === undefined
    ? new Response(text, { status, headers })
    : errorResponse(status, "invalid_request_error", detail)
}

export function createChatGptBackend<Ctx>(options: ChatGptBackendOptions<Ctx>): ChatGptBackend<Ctx> {
  const dispatch: UpstreamFetch = options.fetchImpl ?? ((url, init) => fetch(url, init))
  const now = options.now ?? Date.now
  const { source, exhaustion, hooks } = options
  const affinity = new AssignmentStore(MAX_CONVERSATIONS)
  const observed = new Map<string, ObservedSeatLimits>()

  const bench = (seat: string, kind: ChatGptFailureKind, rateLimit: ChatGptRateLimit | null): number => {
    const until = kind === "requires_reauth"
      ? now() + REAUTH_COOLDOWN_MS
      : chatGptCooldownUntil(rateLimit, now()) ?? now() + DEFAULT_COOLDOWN_MS
    exhaustion.mark(seat, until, kind)
    return until
  }

  return {
    provider: "chatgpt",
    observedLimits: () => observed,

    async handle(request: UpstreamRequest<Ctx>) {
      const startedAt = now()
      const requestId = randomUUID()
      if (request.endpoint !== "responses") {
        return errorResponse(404, "not_found_error",
          `This model is served by ChatGPT, which Meridian reaches through the Responses API only. ${request.route} is not available for it.`)
      }

      const inbound = await options.inboundRequest(request.context)
      const rawBody = await inbound.text()
      let parsed: Record<string, unknown> | undefined
      try {
        parsed = asRecord(JSON.parse(rawBody) as unknown)
      } catch {
        parsed = undefined
      }
      if (!parsed) return errorResponse(400, "invalid_request_error", "Request body must be a JSON object")

      const model = typeof parsed.model === "string" ? parsed.model : undefined
      const requestSource = inbound.headers.get("x-meridian-source")?.slice(0, 64) || undefined
      const turn: ChatGptTurnInfo = { requestId, model, body: parsed, headers: inbound.headers }
      const adapted = adaptResponsesBody(parsed)
      const attempts: ChatGptAttempt[] = []

      const report = (fields: Partial<ChatGptTurnEvent> & { status: number }) => {
        hooks?.onTurn?.({
          requestId, startedAt, requestModel: model ?? null, model: model ?? null, seat: null,
          stream: adapted.clientWantsStream, adaptations: adapted.applied, attempts,
          usage: null, ttfbMs: null, durationMs: now() - startedAt, error: null,
          reasoningSummaryEvents: 0, ...(requestSource ? { requestSource } : {}), ...fields,
        })
      }
      const fail = (response: Response, error: string) => {
        report({ status: response.status, error })
        return response
      }

      const route = options.route?.(turn) ?? { kind: "pool", excluded: new Set<string>() }
      if (route.kind === "refuse") return fail(route.response, route.error)

      const refused = await hooks?.admit?.(turn)
      if (refused) return fail(refused, "refused_by_admission")

      // Serialized once: every seat is offered exactly the same bytes.
      const outbound = JSON.stringify(adapted.body)
      const reasons = new Set<SeatUnavailableReason>()
      const cacheKey = typeof parsed.prompt_cache_key === "string" && parsed.prompt_cache_key ? parsed.prompt_cache_key : undefined
      const seats = ((): string[] => {
        // A pinned seat is tried even when the owner would not pick it: its
        // own credential check below says why it cannot serve, if it cannot.
        const listed = route.kind === "pinned" ? [route.seat] : source.candidateSeats(model)
        const routable = route.kind === "pool" ? listed.filter(seat => !route.excluded.has(seat)) : listed
        if (routable.length < listed.length) reasons.add("excluded")
        const unbenched = routable.filter(seat => !exhaustion.isExhausted(seat))
        if (unbenched.length < routable.length) reasons.add("quota_exhausted")
        const live = route.kind === "pool" && route.order ? inSavedOrder(unbenched, route.order) : unbenched
        // The active seat leads: a supervisor that moved the pointer wants the
        // next turn there, at the price of a cold cache. Otherwise a
        // conversation stays on the seat holding its prompt-cache prefix while
        // that seat can serve.
        const active = route.kind === "pool" ? route.preferred : undefined
        const cached = cacheKey ? affinity.get(cacheKey)?.profileId : undefined
        const first = [active, cached].find(seat => seat !== undefined && live.includes(seat))
        return first === undefined ? live : [first, ...live.filter(seat => seat !== first)]
      })()

      const refusals: ChatGptSeatRefusal[] = []
      let settled = false
      const settle = (servedBy: string | null) => {
        if (settled || refusals.length === 0) return
        settled = true
        hooks?.onRefusalsSettled?.({ requestId, refused: refusals, servedBy })
      }

      let spent: Response | undefined
      let spentKind: ChatGptFailureKind | undefined
      for (const seat of seats) {
        let credential = await source.credentials(seat, { model })
        // An expired token may have been rotated by its owner since the last
        // read: look once more before giving up on the seat.
        if (!credential.ok && credential.reason === "expired") credential = await source.credentials(seat, { model, reread: true })
        if (!credential.ok) { reasons.add(credential.reason); continue }

        let retriedAuth = false
        for (;;) {
          const { url, headers } = buildCodexRequest(adapted.body, credential.account)
          let upstream: Response
          try {
            upstream = await dispatch(url, { method: "POST", headers, body: outbound, redirect: "error", signal: inbound.signal })
          } catch {
            // Unreachable for one seat is unreachable for all; report the shape only.
            settle(null)
            return fail(errorResponse(502, "api_error", "The ChatGPT upstream could not be reached."), "upstream_unreachable")
          }

          const sniffed = await sniffChatGptFailure(upstream)
          const rateLimit = chatGptRateLimitFromHeaders(upstream.headers)
          if (rateLimit) observed.set(seat, { rateLimit, at: now() })
          attempts.push({ seat, status: upstream.status, failure: sniffed.failure?.kind ?? null })
          const headersOut = forwardHeaders(upstream)

          // Not a seat failure yet not a success: the request itself was
          // refused, and every other seat would refuse it the same way, so
          // no seat is benched and none is tried. Treating it as a success
          // would hand a non-stream client a bogus "stream ended" 502.
          if (!sniffed.failure && upstream.status >= 400) {
            settle(null)
            report({ status: upstream.status, seat, error: "request_refused" })
            return await requestRefusal(upstream.status, sniffed.body, headersOut)
          }

          if (!sniffed.failure) {
            const until = chatGptCooldownUntil(rateLimit, now())
            if (until !== null) exhaustion.mark(seat, until, "quota_spent")
            if (cacheKey) affinity.set(cacheKey, { profileId: seat, requestId: undefined })
            settle(seat)
            const onDone = (summary: TapSummary) => report({
              status: upstream.status, seat, model: summary.model ?? model ?? null, usage: summary.usage,
              ttfbMs: summary.firstOutputAt === null ? null : summary.firstOutputAt - startedAt,
              reasoningSummaryEvents: summary.reasoningSummaryEvents,
              error: summary.interrupted ?? (summary.outcome && summary.outcome !== "completed" ? `response_${summary.outcome}` : null),
            })
            const tapped = tapResponsesStream(sniffed.body, onDone, now)
            if (adapted.clientWantsStream) return new Response(tapped, { status: upstream.status, headers: headersOut })
            const final = await aggregateResponsesStream(tapped)
            if (!final) return errorResponse(502, "api_error", "The ChatGPT stream ended without a final response.")
            return new Response(JSON.stringify(final), { status: 200, headers: { "content-type": "application/json" } })
          }

          // A provider-side fault says nothing about this seat; benching
          // healthy accounts during an incident would only deepen it.
          const failureKind = sniffed.failure.kind
          if (failureKind === "transient") {
            settle(null)
            report({ status: upstream.status, seat, error: "transient" })
            return new Response(sniffed.body, { status: upstream.status, headers: headersOut })
          }

          if (failureKind === "requires_reauth" && !retriedAuth) {
            // Re-read once: the owner may have rotated this token after we read it.
            const fresh = await source.credentials(seat, { model, reread: true })
            if (fresh.ok && fresh.account.accessToken !== credential.account.accessToken) {
              void sniffed.body.cancel().catch(() => {})
              credential = fresh
              retriedAuth = true
              continue
            }
          }

          const refusal: ChatGptSeatRefusal = {
            requestId, seat, kind: failureKind, status: upstream.status,
            until: bench(seat, failureKind, rateLimit), rateLimit,
          }
          refusals.push(refusal)
          hooks?.onSeatRefused?.(refusal)
          if (failureKind === "requires_reauth") reasons.add("requires_reauth")
          void spent?.body?.cancel().catch(() => {})
          spent = new Response(sniffed.body, { status: upstream.status, headers: headersOut })
          spentKind = failureKind
          break
        }
      }
      settle(null)

      // A quota refusal is returned as the provider sent it, keeping its
      // status and stated wait. A refused credential is not: its body means
      // nothing actionable to the client, the reason below does.
      if (spent && spentKind !== "requires_reauth") {
        report({ status: spent.status, error: spentKind ?? "refused" })
        return spent
      }
      void spent?.body?.cancel().catch(() => {})

      const fallback = await hooks?.onPoolExhausted?.({ ...turn, reasons })
      if (fallback) return fallback

      const message = source.describeUnavailable(reasons)
      const auth = reasons.has("expired") || reasons.has("requires_reauth")
      const quota = !auth && reasons.size > 0 && [...reasons].every(r => r === "quota_exhausted" || r === "cooling_down")
      const response = auth
        ? errorResponse(401, "authentication_error", message)
        : quota ? errorResponse(429, "rate_limit_error", message) : errorResponse(503, "overloaded_error", message)
      return fail(response, auth ? "chatgpt_auth_unavailable" : quota ? "chatgpt_quota_exhausted" : "chatgpt_unavailable")
    },
  }
}
