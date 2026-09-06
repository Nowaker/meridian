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
 * Account SELECTION is injected rather than decided here. Rotation, cooldown
 * and failover are provider-partitioned routing concerns; this module's job
 * ends at "serve this request with this account, or say plainly that it
 * cannot be served".
 */

import type { UpstreamBackend, UpstreamRequest } from "../upstream/backend"
import { buildCodexRequest } from "./request"

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
  selectAccount: (
    request: UpstreamRequest<Ctx>,
    body: Record<string, unknown> | undefined,
  ) => Promise<ChatGptServingAccount | null> | ChatGptServingAccount | null
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

      const account = await options.selectAccount(request, parsed)
      if (!account) {
        return errorResponse(
          503,
          "overloaded_error",
          "No ChatGPT account is available to serve this request.",
        )
      }

      const { url, headers } = buildCodexRequest(parsed, account)

      let upstream: Response
      try {
        upstream = await dispatch(url, {
          method: "POST",
          headers,
          body: rawBody,
          // A bearer credential must never be replayed to a redirect target.
          redirect: "error",
          signal: inbound.signal,
        })
      } catch {
        // The thrown detail can name internal hosts and, on some clients,
        // quote the request that produced it. Report the shape, not the text.
        return errorResponse(502, "api_error", "The ChatGPT upstream could not be reached.")
      }

      const responseHeaders = new Headers()
      for (const name of FORWARDED_RESPONSE_HEADERS) {
        const value = upstream.headers.get(name)
        if (value !== null) responseHeaders.set(name, value)
      }
      return new Response(upstream.body, { status: upstream.status, headers: responseHeaders })
    },
  }
}
