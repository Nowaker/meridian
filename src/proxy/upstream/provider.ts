/**
 * Which provider serves a model.
 *
 * Pure: no I/O, no config, no network. The answer is needed before profile
 * resolution, session lookup and transcript work, because all of those are
 * Claude-shaped and a ChatGPT request must not enter them.
 *
 * An EXACT-MATCH allowlist of the model ids a ChatGPT subscription serves.
 * Everything else resolves to "claude": an absent model, an unknown one, and a
 * GPT id that is not listed. That asymmetry is the compatibility guarantee - a
 * request that works today cannot change provider because a matcher guessed.
 * The dispatcher consults this only when a ChatGPT backend is enabled, so an
 * instance without one keeps translating GPT names onto Claude as before.
 */
import type { ProviderId } from "./backend"

export const CHATGPT_MODELS: readonly string[] = [
  "gpt-6-astra",
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-daybreak-blue",
  "gpt-daybreak-red",
  "gpt-5.6-cyber",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.4-pro",
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
  "gpt-5.2",
  "gpt-5.2-codex",
  "gpt-5.1",
  "gpt-5.1-codex",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-mini",
  "gpt-5-codex",
  "codex-max",
  "codex",
]

const CHATGPT_MODEL_SET: ReadonlySet<string> = new Set(CHATGPT_MODELS)

export function providerForModel(model: string | null | undefined): ProviderId {
  if (typeof model !== "string") return "claude"
  return CHATGPT_MODEL_SET.has(model.trim().toLowerCase()) ? "chatgpt" : "claude"
}
