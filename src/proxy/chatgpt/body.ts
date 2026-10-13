/**
 * The only changes Meridian makes to a ChatGPT-bound Responses body.
 *
 * The ChatGPT path is a pass-through: no Claude system prompt, no scrubbing,
 * no plugin hooks, and no instruction text of Meridian's or Codex CLI's own.
 * What remains here is what `chatgpt.com/backend-api/codex/responses` refuses
 * or cannot serve a request without. Each adaptation is listed in `applied`
 * so telemetry and tests can see exactly what changed; input items, system
 * and developer messages, instructions, tools, reasoning settings and
 * prompt_cache_key all reach the provider as the client sent them. A body
 * that already satisfies the backend (Codex CLI's) passes with `applied` empty.
 *
 * Measured against the live backend on 2026-09-27: a request with no
 * `instructions` is served and `system` role input is accepted, so the
 * client's system/developer text is NOT moved; `max_output_tokens` is refused
 * with 400 "Unsupported parameter", so it is removed.
 *
 * Pure: no I/O, and the input object is not mutated.
 */

export type BodyAdaptation =
  /** The backend refuses stored responses ("Store must be set to false"). */
  | "store=false"
  /** The backend only streams. Non-streaming clients get the final response aggregated back. */
  | "stream=true"
  /** With store=false, reasoning survives across turns only as encrypted content the client carries back. */
  | "include+reasoning.encrypted_content"
  /** The backend refuses it (400 "Unsupported parameter: max_output_tokens"); the cap cannot be honoured there. */
  | "-max_output_tokens"

export interface AdaptedBody {
  body: Record<string, unknown>
  /** What the client asked for, before `stream=true` was forced. */
  clientWantsStream: boolean
  applied: BodyAdaptation[]
}

const ENCRYPTED_REASONING = "reasoning.encrypted_content"

export function adaptResponsesBody(input: Record<string, unknown>): AdaptedBody {
  const body: Record<string, unknown> = { ...input }
  const applied: BodyAdaptation[] = []

  if (body.store !== false) {
    body.store = false
    applied.push("store=false")
  }
  if (body.stream !== true) {
    body.stream = true
    applied.push("stream=true")
  }
  const include = Array.isArray(body.include) ? body.include : []
  if (!include.includes(ENCRYPTED_REASONING)) {
    body.include = [...include, ENCRYPTED_REASONING]
    applied.push("include+reasoning.encrypted_content")
  }
  if ("max_output_tokens" in body) {
    delete body.max_output_tokens
    applied.push("-max_output_tokens")
  }

  return { body, clientWantsStream: input.stream === true, applied }
}
