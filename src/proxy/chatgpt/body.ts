/**
 * The only changes Meridian makes to a ChatGPT-bound Responses body.
 *
 * The ChatGPT path is a pass-through: no Claude system prompt, no scrubbing,
 * no plugin hooks, and no instruction text of Meridian's or Codex CLI's own.
 * What remains here is what `chatgpt.com/backend-api/codex/responses` refuses
 * a request without. Each adaptation is listed in `applied` so telemetry and
 * tests can see exactly what changed; everything else - input items, tools,
 * reasoning settings, prompt_cache_key - reaches the provider as the client
 * sent it. A body that already satisfies the backend (Codex CLI's) passes
 * through with `applied` empty.
 *
 * Pure: no I/O, and the input object is not mutated.
 */

export type BodyAdaptation =
  /** The backend refuses stored responses ("Store must be set to false"). */
  | "store=false"
  /** The backend only streams. Non-streaming clients get the final response aggregated back. */
  | "stream=true"
  /** With store=false, reasoning survives across turns only as encrypted content the client carries. */
  | "include+reasoning.encrypted_content"
  /** The backend refuses `system` role input items; their text moves into `instructions`. */
  | "system->instructions"
  /** The backend requires `instructions`; a leading developer message supplies it when absent. */
  | "developer->instructions"

export interface AdaptedBody {
  body: Record<string, unknown>
  /** What the client asked for, before `stream=true` was forced. */
  clientWantsStream: boolean
  applied: BodyAdaptation[]
}

const ENCRYPTED_REASONING = "reasoning.encrypted_content"

function messageText(item: Record<string, unknown>): string | null {
  const content = item.content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return null
  const parts: string[] = []
  for (const part of content) {
    if (typeof part !== "object" || part === null) return null
    const text = (part as Record<string, unknown>).text
    const type = (part as Record<string, unknown>).type
    // Only text can live in `instructions`. A system item carrying anything
    // else is left where it is rather than silently losing that part.
    if ((type === "input_text" || type === "text") && typeof text === "string") parts.push(text)
    else return null
  }
  return parts.join("\n")
}

function roleOf(item: unknown): string | undefined {
  if (typeof item !== "object" || item === null) return undefined
  const record = item as Record<string, unknown>
  if (record.type !== undefined && record.type !== "message") return undefined
  return typeof record.role === "string" ? record.role : undefined
}

export function adaptResponsesBody(input: Record<string, unknown>): AdaptedBody {
  const body: Record<string, unknown> = { ...input }
  const applied: BodyAdaptation[] = []
  const clientWantsStream = input.stream === true

  if (body.store !== false) {
    body.store = false
    applied.push("store=false")
  }
  if (body.stream !== true) {
    body.stream = true
    applied.push("stream=true")
  }

  const include = Array.isArray(body.include) ? body.include.filter((v): v is string => typeof v === "string") : []
  if (!include.includes(ENCRYPTED_REASONING)) {
    body.include = [...include, ENCRYPTED_REASONING]
    applied.push("include+reasoning.encrypted_content")
  }

  const instructions: string[] = typeof body.instructions === "string" && body.instructions.length > 0 ? [body.instructions] : []
  if (Array.isArray(body.input)) {
    const kept: unknown[] = []
    let movedSystem = false
    for (const item of body.input) {
      if (roleOf(item) === "system") {
        const text = messageText(item as Record<string, unknown>)
        if (text !== null) {
          instructions.push(text)
          movedSystem = true
          continue
        }
      }
      kept.push(item)
    }
    if (movedSystem) applied.push("system->instructions")

    // Reasoning-model clients (the AI SDK among them) send their system prompt
    // as a developer message. Only the LEADING developer messages move, and
    // only when nothing else supplied instructions: later developer messages
    // are turn context the client placed deliberately.
    if (instructions.length === 0) {
      let movedDeveloper = false
      while (kept.length > 0 && roleOf(kept[0]) === "developer") {
        const text = messageText(kept[0] as Record<string, unknown>)
        if (text === null) break
        instructions.push(text)
        kept.shift()
        movedDeveloper = true
      }
      if (movedDeveloper) applied.push("developer->instructions")
    }
    if (movedSystem || applied.includes("developer->instructions")) body.input = kept
  }
  if (instructions.length > 0) body.instructions = instructions.join("\n\n")

  return { body, clientWantsStream, applied }
}
