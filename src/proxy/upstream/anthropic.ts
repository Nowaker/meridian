/**
 * The Claude upstream backend.
 *
 * Deliberately a thin adapter over the handlers that already live in
 * server.ts rather than a reimplementation of them. Introducing the seam must
 * not change one byte of observable Claude behavior, so the Agent SDK path,
 * its Anthropic-specific retry wrapper and the whole session machinery are
 * reached exactly as before — just one call deeper.
 *
 * The only logic here is surface dispatch, which is real: two inbound
 * surfaces reach Claude by different routes, and the Responses surface gets
 * there through a lossy translation the Messages surface must never take.
 */
import type { UpstreamBackend, UpstreamRequest } from "./backend"

export interface AnthropicUpstreamHandlers<Ctx> {
  /** Serves the Anthropic Messages surface (`/v1/messages`, `/messages`). */
  messages(request: UpstreamRequest<Ctx>): Promise<Response>
  /** Serves the OpenAI Responses surface (`/v1/responses`) by translation. */
  responses(request: UpstreamRequest<Ctx>): Promise<Response>
}

export function createAnthropicBackend<Ctx>(
  handlers: AnthropicUpstreamHandlers<Ctx>,
): UpstreamBackend<Ctx> {
  return {
    provider: "anthropic",
    handle(request) {
      return request.endpoint === "responses"
        ? handlers.responses(request)
        : handlers.messages(request)
    },
  }
}
