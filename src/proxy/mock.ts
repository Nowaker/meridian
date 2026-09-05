/**
 * Mock mode — answer a request locally, without any upstream call, returning
 * the exact payload Meridian would have sent to the Claude Agent SDK.
 *
 * ## Why this exists
 *
 * Meridian rewrites a request substantially on its way upstream: adapter
 * transforms, plugin transforms, system-prompt injection, working-directory
 * notes, tool translation, MCP wiring and profile/routing resolution all edit
 * the payload. None of that is observable from the outside. Debugging it means
 * spending real tokens and inferring the input from the output.
 *
 * Mock mode makes the input directly observable: the assistant text of the
 * response IS the payload, so a client sees precisely what the model would
 * have seen.
 *
 * ## Where it is applied
 *
 * `server.ts` short-circuits at the top of `runSdkQueryAttempt` — the single
 * choke point all eight SDK paths funnel through — so the `params` rendered
 * here are the value `query()` would have received.
 *
 * Two things are deliberately *not* in the render, both assigned by the few
 * lines between that short-circuit and the `query()` call:
 * `options.spawnClaudeCodeProcess`, Meridian's process-gate hook, and the
 * `options` object's own creation when a caller left it unset. Both are
 * Meridian's subprocess plumbing rather than anything the model sees, and
 * running the gate for a mock would create gate files and a writer join for a
 * subprocess that is never spawned.
 *
 * ## Rendering
 *
 * Pretty-printed with two-space indentation, and newlines inside string values
 * are emitted as *real* newlines rather than `\n` escapes — a flattened prompt
 * is tens of kilobytes of conversation, and as one escaped line it is unusable
 * in a terminal and undiffable. The consequence is deliberate: the rendering is
 * human-readable, not strict JSON.
 *
 * Pure module — no I/O, no imports from server.ts or session/.
 */

import { randomUUID } from "node:crypto"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { envBool } from "../env"

/**
 * Anthropic's Beta message types, reached through the SDK's own exports rather
 * than by importing `@anthropic-ai/sdk` — that package is a transitive
 * dependency this project never names directly, and nothing else in `src/`
 * imports from it.
 */
type SdkAssistantMessage = Extract<SDKMessage, { type: "assistant" }>
type SdkStreamEventMessage = Extract<SDKMessage, { type: "stream_event" }>
type AssistantMessageBody = SdkAssistantMessage["message"]
type StreamEventPayload = SdkStreamEventMessage["event"]
type MessageDeltaUsage = Extract<StreamEventPayload, { type: "message_delta" }>["usage"]

/** Per-request opt-in, so a running instance can mock one request without a restart. */
export const MOCK_HEADER = "x-meridian-mock"

/** Stands in for any value whose key looks credential-shaped. */
export const MOCK_REDACTED = "[redacted by meridian mock mode]"

/**
 * Keys whose values are replaced with {@link MOCK_REDACTED}.
 *
 * The payload travels back to the same client that sent it, over loopback, so
 * the bar for hiding anything is high — a debug tool that hides fields is
 * useless. Credentials are the exception: `options.env` carries the profile's
 * `CLAUDE_CODE_OAUTH_TOKEN`, which the client never sent and must not receive.
 *
 * Key *names* are preserved; only values are replaced. Knowing that a token is
 * present and which variable carries it is exactly the debugging signal.
 */
const SECRET_KEY_PATTERN = /(TOKEN|SECRET|PASSWORD|PASSPHRASE|CREDENTIAL|API_?KEY|AUTHORIZATION|COOKIE|_KEY$|^KEY$)/i

/**
 * Private-use codepoint standing in for a newline across `JSON.stringify`.
 *
 * `stringify` escapes real newlines to `\n`; it passes U+E000 through
 * untouched. So newlines are swapped out before serialization and swapped back
 * after, which is what turns the escaped one-line blob into readable text.
 */
const NEWLINE_SENTINEL = "\uE000"

/** Resolve mock mode for one request: header wins, env is the fallback. */
export function isMockRequested(headerValue?: string | null): boolean {
  if (headerValue != null) {
    const value = headerValue.trim().toLowerCase()
    if (value === "1" || value === "true" || value === "yes") return true
    if (value === "0" || value === "false" || value === "no") return false
  }
  return envBool("MOCK")
}

function describeFunction(fn: (...args: never[]) => unknown): string {
  return fn.name ? `[Function: ${fn.name}]` : "[Function]"
}

/**
 * Convert one value into something `JSON.stringify` renders usefully.
 *
 * Functions become a named marker rather than vanishing, because "is the
 * PreToolUse hook actually wired up?" is one of the questions this feature
 * exists to answer, and `stringify` drops functions silently.
 *
 * `seen` is scoped to the current path — deleted on the way out — so a value
 * legitimately referenced twice renders twice, and only a true cycle is cut.
 */
function sanitize(value: unknown, seen: Set<object>, redact: boolean): unknown {
  if (typeof value === "string") {
    if (redact) return MOCK_REDACTED
    // Drop any pre-existing sentinel so the newline round-trip is unambiguous.
    return value.split(NEWLINE_SENTINEL).join("").split("\n").join(NEWLINE_SENTINEL)
  }
  if (redact && (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint")) {
    return MOCK_REDACTED
  }
  if (typeof value === "function") return describeFunction(value as (...args: never[]) => unknown)
  if (typeof value === "bigint") return value.toString()
  if (typeof value === "symbol") return value.toString()
  if (value === null || typeof value !== "object") return value
  if (seen.has(value)) return "[Circular]"
  seen.add(value)
  try {
    if (Array.isArray(value)) return value.map(entry => sanitize(entry, seen, redact))
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      out[key] = sanitize(entry, seen, redact || SECRET_KEY_PATTERN.test(key))
    }
    return out
  } finally {
    seen.delete(value)
  }
}

/**
 * Materialize the prompt so a multimodal request is rendered too.
 *
 * The SDK accepts either a flattened string or an async iterable of message
 * chunks. Draining the iterable would be destructive if the SDK were going to
 * read it — in mock mode nothing downstream ever does.
 */
async function materializePrompt(prompt: unknown): Promise<unknown> {
  if (prompt == null || typeof prompt === "string") return prompt
  const iterator = (prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]
  if (typeof iterator !== "function") return prompt
  const chunks: unknown[] = []
  for await (const chunk of prompt as AsyncIterable<unknown>) chunks.push(chunk)
  return chunks
}

/**
 * The part of a `query()` call this module reads.
 *
 * Deliberately a structural subset rather than the SDK's own `Options`: mock
 * mode renders whatever it is handed, so the only fields it needs to *know*
 * about are the four that decide the response's identity. The SDK's parameter
 * object satisfies this without conversion.
 */
export interface MockQueryParams {
  prompt?: unknown
  options?: {
    model?: string
    sessionId?: string
    resume?: string
    forkSession?: boolean
  }
}

/** The payload, rendered for a human reading it in a terminal. */
export async function formatMockPayload(params: { prompt?: unknown; options?: unknown }): Promise<string> {
  const payload = {
    prompt: await materializePrompt(params.prompt),
    options: params.options,
  }
  const rendered = JSON.stringify(sanitize(payload, new Set<object>(), false), null, 2) ?? "undefined"
  return rendered.split(NEWLINE_SENTINEL).join("\n")
}

/** Explains the response, so nobody mistakes a mock for a real answer. */
export const MOCK_THINKING_TEXT = [
  "Meridian is running in MOCK MODE. Nothing was sent to Anthropic — this response",
  "was generated locally by the proxy.",
  "",
  "The assistant text below is the payload Meridian would have passed to the Claude",
  "Agent SDK, captured at the last point before the SDK call: after adapter",
  "transforms, plugin transforms, system-prompt injection, working-directory notes,",
  "tool translation and profile/routing resolution.",
  "",
  "Rendering: two-space indentation, and newlines inside string values are real",
  "newlines rather than \\n escapes, so the text is readable and diffable but is NOT",
  "strict JSON. Credential-shaped values are replaced with a redaction marker and",
  "functions are shown as [Function: name].",
].join("\n")

/**
 * Mirrors the SDK: a resumed query keeps its session, a forked one does not.
 *
 * `sessionId` comes first and is not optional to honour. When the proxy forks a
 * managed session it allocates the target id itself, journals ownership of it
 * before the query, and then rejects a turn whose reported `session_id` is
 * anything else ("Managed SDK fork returned X; expected Y"). So a mock that
 * minted its own id there would 500 rather than answer.
 */
function resolveSessionId(options: MockQueryParams["options"]): string {
  if (options?.sessionId) return options.sessionId
  if (options?.resume && !options.forkSession) return options.resume
  return `mock-${randomUUID()}`
}

/** Zero usage keeps mock traffic out of cost and quota telemetry. */
const ZERO_USAGE: AssistantMessageBody["usage"] = {
  cache_creation: null,
  cache_creation_input_tokens: null,
  cache_read_input_tokens: null,
  inference_geo: null,
  input_tokens: 0,
  iterations: null,
  output_tokens: 0,
  server_tool_use: null,
  service_tier: null,
  speed: null,
}

const ZERO_DELTA_USAGE: MessageDeltaUsage = {
  cache_creation_input_tokens: null,
  cache_read_input_tokens: null,
  input_tokens: null,
  iterations: null,
  output_tokens: 0,
  server_tool_use: null,
}

function mockMessageBody(id: string, model: string, content: AssistantMessageBody["content"]): AssistantMessageBody {
  return {
    id,
    type: "message",
    role: "assistant",
    content,
    model,
    container: null,
    context_management: null,
    stop_details: null,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: ZERO_USAGE,
  }
}

/** Deltas exist to prove the stream is a stream; the size is cosmetic. */
const STREAM_CHUNK_SIZE = 1024

function chunkText(text: string, size: number): string[] {
  if (text.length === 0) return [""]
  const chunks: string[] = []
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size))
  return chunks
}

/**
 * A response that would have come from the SDK, had one been asked for.
 *
 * Emitted in the SDK's own message shapes — `assistant` for a non-streaming
 * query, `stream_event` envelopes around raw Anthropic SSE events for a
 * streaming one — so every downstream stage (thinking-block policy, envelope
 * integrity, telemetry) runs exactly as it does for a real response.
 */
export async function* mockSdkMessages(
  params: MockQueryParams,
  stream: boolean,
): AsyncGenerator<SDKMessage> {
  const sessionId = resolveSessionId(params.options)
  const model = params.options?.model ?? "meridian-mock"
  const messageId = `msg_mock_${randomUUID().replace(/-/g, "").slice(0, 24)}`
  const text = await formatMockPayload(params)

  if (!stream) {
    yield {
      type: "assistant",
      message: mockMessageBody(messageId, model, [
        { type: "thinking", thinking: MOCK_THINKING_TEXT, signature: "" },
        { type: "text", text, citations: null },
      ]),
      parent_tool_use_id: null,
      uuid: randomUUID(),
      session_id: sessionId,
    }
    return
  }

  const streamEvent = (event: StreamEventPayload): SDKMessage => ({
    type: "stream_event",
    event,
    parent_tool_use_id: null,
    uuid: randomUUID(),
    session_id: sessionId,
  })

  yield streamEvent({ type: "message_start", message: mockMessageBody(messageId, model, []) })

  yield streamEvent({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } })
  for (const chunk of chunkText(MOCK_THINKING_TEXT, STREAM_CHUNK_SIZE)) {
    yield streamEvent({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: chunk } })
  }
  yield streamEvent({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "" } })
  yield streamEvent({ type: "content_block_stop", index: 0 })

  yield streamEvent({ type: "content_block_start", index: 1, content_block: { type: "text", text: "", citations: null } })
  for (const chunk of chunkText(text, STREAM_CHUNK_SIZE)) {
    yield streamEvent({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: chunk } })
  }
  yield streamEvent({ type: "content_block_stop", index: 1 })

  yield streamEvent({
    type: "message_delta",
    context_management: null,
    delta: { container: null, stop_details: null, stop_reason: "end_turn", stop_sequence: null },
    usage: ZERO_DELTA_USAGE,
  })
  yield streamEvent({ type: "message_stop" })
}
