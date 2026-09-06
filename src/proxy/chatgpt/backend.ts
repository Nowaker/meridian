/**
 * The ChatGPT upstream backend: one complete provider request, raw.
 *
 * Meridian's existing Responses support translates into Anthropic and back
 * out, because its upstream is Claude. Here the upstream already speaks
 * Responses, so translating would lower a format into a lossier one and lift
 * it back for nothing - and every lossy step is somewhere a tool call or a
 * reasoning block quietly changes shape. The request body goes out as it
 * arrived and the response stream comes back as it was sent.
 *
 * Both directions are contained. Nothing the client sent reaches the provider
 * except the body, because the outbound headers are built from scratch; and
 * nothing the provider sent reaches the client except the stream and an
 * allowlisted pair of headers, because a client that never authenticated
 * against chatgpt.com must not be handed chatgpt.com's cookies by a proxy
 * standing in the middle.
 *
 * WHICH seats exist, in what order, and for how long a spent one stays
 * benched are injected. What is decided here is the thing the seam calls one
 * complete provider request: try a seat, read far enough into the answer to
 * know whether the SEAT failed, and hand the turn on if it did.
 *
 * Retrying stops exactly where the sniffer's scan stops, and that is not a
 * coincidence - it is the same rule stated once. A failure the sniffer
 * reports arrived while the stream had produced nothing, so nobody has seen
 * the turn and another seat may serve it. A failure it does not report
 * arrived after output the client already holds, and serving that turn again
 * would bill a second account to deliver the same work twice.
 */

import type { UpstreamBackend, UpstreamRequest } from "../upstream/backend"
import { buildCodexRequest } from "./request"
import { sniffChatGptFailure, type ChatGptFailure } from "./stream"

export interface ChatGptServingAccount {
  /** The seat, carried so a caller can attribute the outcome to the right account. */
  accountUserId: string
  accountId: string
  accessToken: string
}

export type UpstreamFetch = (url: string, init: RequestInit) => Promise<Response>

export interface ChatGptBackendOptions<Ctx> {
  /**
   * How to reach the inbound HTTP request from the host's context, so this
   * module never imports Hono.
   *
   * May be async, and usually has to be: the dispatch seam reads the model out
   * of the body to choose a provider, which spends the original request's
   * stream, so a host reaching this point holds a Request that answers `Body
   * already used`. Rebuilding an equivalent one needs the bytes back, and
   * getting them back is asynchronous.
   */
  inboundRequest: (context: Ctx) => Request | Promise<Request>
  /** Seats to try, best first. Empty means nothing here can serve this request. */
  candidateSeats: (
    request: UpstreamRequest<Ctx>,
    body: Record<string, unknown> | undefined,
  ) => readonly string[] | Promise<readonly string[]>
  /**
   * This seat's credentials, or null when it has none usable right now.
   *
   * Null SKIPS the seat without benching it. A seat waiting on a human to log
   * in again has already been reported by whatever discovered that; benching
   * it here would restate a fact and reset its clock on every request.
   */
  seatCredentials: (
    accountUserId: string,
  ) => ChatGptServingAccount | null | Promise<ChatGptServingAccount | null>
  /** Called once per spent seat per turn, before the turn moves on to the next one. */
  benchSeat: (accountUserId: string, failure: ChatGptFailure) => void
  /** Which seat served this conversation, so the next turn of it can prefer the same one. */
  noteServed?: (body: Record<string, unknown> | undefined, accountUserId: string) => void
  fetchImpl?: UpstreamFetch
}

/** Everything else the provider sends back is dropped. */
const FORWARDED_RESPONSE_HEADERS = ["content-type", "cache-control"] as const

function errorResponse(status: number, type: string, message: string): Response {
  return new Response(JSON.stringify({ error: { type, message, code: null } }), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function forwardResponse(upstream: Response, body: ReadableStream<Uint8Array>): Response {
  const headers = new Headers()
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name)
    if (value !== null) headers.set(name, value)
  }
  return new Response(body, { status: upstream.status, headers })
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

export function createChatGptBackend<Ctx>(options: ChatGptBackendOptions<Ctx>): UpstreamBackend<Ctx> {
  const dispatch: UpstreamFetch = options.fetchImpl ?? ((url, init) => fetch(url, init))

  return {
    provider: "openai",

    async handle(request) {
      if (request.endpoint !== "responses") {
        // GPT models through /v1/messages are out of scope for this version.
        // Refusing beats attempting it: that surface carries an Anthropic-
        // shaped body, which this provider cannot read.
        return errorResponse(
          404,
          "not_found_error",
          `This model is served by ChatGPT, which Meridian reaches through the Responses API only. `
          + `${request.route} is not available for it.`,
        )
      }

      const inbound = await options.inboundRequest(request.context)
      const rawBody = await inbound.text()
      let parsed: Record<string, unknown> | undefined
      try {
        parsed = asRecord(JSON.parse(rawBody) as unknown)
      } catch {
        return errorResponse(400, "invalid_request_error", "Request body must be valid JSON")
      }

      let spent: Response | undefined
      for (const accountUserId of await options.candidateSeats(request, parsed)) {
        const account = await options.seatCredentials(accountUserId)
        if (!account) continue

        const { url, headers } = buildCodexRequest(parsed, account)

        let upstream: Response
        try {
          upstream = await dispatch(url, {
            method: "POST",
            headers,
            // Every attempt sends the SAME original bytes: a second seat must
            // be offered the request the first one refused, not a re-encoding.
            body: rawBody,
            // A bearer credential must never be replayed to a redirect target.
            redirect: "error",
            signal: inbound.signal,
          })
        } catch {
          // The thrown detail can name internal hosts and, on some clients,
          // quote the request that produced it. Report the shape, not the text.
          // Not a seat failure either: an unreachable provider is unreachable
          // for every seat, so trying the rest would multiply a dead request.
          return errorResponse(502, "api_error", "The ChatGPT upstream could not be reached.")
        }

        const sniffed = await sniffChatGptFailure(upstream)
        const answer = forwardResponse(upstream, sniffed.body)

        if (!sniffed.failure) {
          options.noteServed?.(parsed, accountUserId)
          return answer
        }
        // A provider-side fault says nothing about this seat. Benching six
        // healthy accounts and re-sending during an incident would make the
        // incident worse and leave the pool cold once it passed.
        if (sniffed.failure.kind === "transient") return answer

        options.benchSeat(accountUserId, sniffed.failure)
        // Only the last refusal is returned, so release the ones before it
        // rather than leaving their connections held open by an unread body.
        void spent?.body?.cancel().catch(() => {})
        spent = answer
      }

      // The last seat's OWN answer, carrying the status and whatever wait the
      // provider chose to state. Replacing it with an invented error would
      // discard both. Only a pool with nothing left to try has none.
      return spent ?? errorResponse(
        503,
        "overloaded_error",
        "Every ChatGPT account this Meridian owns is spent or unavailable.",
      )
    },
  }
}
