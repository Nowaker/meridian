/**
 * Which vendor serves a model.
 *
 * Pure — no I/O, no config, no network. The answer has to be available before
 * profile resolution, session lookup and any transcript work, because all of
 * those are Claude-shaped and a non-Claude request must not enter them.
 *
 * The list is an EXACT-MATCH allowlist of the model families a ChatGPT
 * subscription serves. Everything else resolves to "anthropic": an absent
 * model, an unknown one, a provider-qualified name, and a GPT name that is
 * not on the list. That asymmetry is the compatibility guarantee — no request
 * that works today can change provider because a matcher guessed. A prefix
 * rule like "starts with gpt-" would fail the other way, aiming an
 * unverified model at a credential set nobody chose for it.
 */
import type { ProviderId } from "./backend"

const OPENAI_MODEL_FAMILIES: ReadonlySet<string> = new Set([
  "gpt-5-codex",
  "codex-max",
  "codex",
  "gpt-6-astra",
  "gpt-daybreak-blue",
  "gpt-daybreak-red",
  "gpt-5.6-cyber",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.4-pro",
  "gpt-5.2",
  "gpt-5.1",
])

export function providerForModel(model: string | null | undefined): ProviderId {
  if (typeof model !== "string") return "anthropic"
  return OPENAI_MODEL_FAMILIES.has(model.trim().toLowerCase()) ? "openai" : "anthropic"
}
