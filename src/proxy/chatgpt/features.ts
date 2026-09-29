/**
 * Operator settings for the ChatGPT gateway.
 *
 * Separate from the per-adapter SDK features (sdkFeatures.ts) on purpose: those
 * configure the Claude Agent SDK, and the ChatGPT path never runs adapter
 * detection or the SDK, so a per-adapter key would silently not apply. These
 * three are the ChatGPT counterparts of Thinking Passthrough, Max Budget and
 * Fallback Model, stored under `chatgpt` in settings.json and re-read on every
 * request, like routing.
 *
 * Defaults differ from Claude's where the pass-through contract demands it:
 * reasoning summaries are forwarded unless the operator turns them off, because
 * the client asked for them and dropping them by default would be a mutation of
 * a pass-through response.
 */
import { getSetting, setSetting } from "../../settings"
import { CHATGPT_MODELS, providerForModel } from "../upstream/provider"

export interface ChatGptFeatures {
  /** Forward ChatGPT's reasoning summaries to the client. */
  thinkingPassthrough: boolean
  /** Per-request cost cap in USD, 0 = off. */
  maxBudgetUsd: number
  /** A ChatGPT model to retry on when the requested one cannot serve, "" = off. */
  fallbackModel: string
}

export const CHATGPT_FEATURE_DEFAULTS: Readonly<ChatGptFeatures> = {
  thinkingPassthrough: true,
  maxBudgetUsd: 0,
  fallbackModel: "",
}

/**
 * The effective features. A saved value of the wrong type, a negative budget, or
 * a fallback model this build no longer routes to ChatGPT falls back to the
 * default rather than reaching the request path. What the gateway currently
 * offers is deliberately not the test here: that follows the backend's catalog
 * and can shrink for an hour, and a saved choice should outlive that.
 */
export function getChatGptFeatures(): ChatGptFeatures {
  const saved = getSetting("chatgpt") ?? {}
  return {
    thinkingPassthrough: typeof saved.thinkingPassthrough === "boolean"
      ? saved.thinkingPassthrough
      : CHATGPT_FEATURE_DEFAULTS.thinkingPassthrough,
    maxBudgetUsd: typeof saved.maxBudgetUsd === "number" && Number.isFinite(saved.maxBudgetUsd) && saved.maxBudgetUsd > 0
      ? saved.maxBudgetUsd
      : CHATGPT_FEATURE_DEFAULTS.maxBudgetUsd,
    fallbackModel: typeof saved.fallbackModel === "string" && providerForModel(saved.fallbackModel) === "chatgpt"
      ? saved.fallbackModel
      : CHATGPT_FEATURE_DEFAULTS.fallbackModel,
  }
}

/**
 * Validate a partial update in full before anything is written, so a body with
 * one good key and one bad one is refused rather than half-applied.
 *
 * The fallback model must be one the gateway offers (`fallbackChoices`, the
 * same list the settings page shows): a Claude id, or a ChatGPT id no seat can
 * serve, would send the retry to a model that refuses it.
 */
export function validateChatGptFeatureUpdate(raw: unknown, fallbackChoices: readonly string[] = CHATGPT_MODELS): Partial<ChatGptFeatures> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("body must be a JSON object")
  const result: Partial<ChatGptFeatures> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key === "thinkingPassthrough") {
      if (typeof value !== "boolean") throw new Error("thinkingPassthrough must be a boolean")
      result.thinkingPassthrough = value
    } else if (key === "maxBudgetUsd") {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("maxBudgetUsd must be a number >= 0")
      result.maxBudgetUsd = value
    } else if (key === "fallbackModel") {
      if (typeof value !== "string" || (value !== "" && !fallbackChoices.includes(value))) {
        throw new Error(`fallbackModel must be "" or one of: ${fallbackChoices.join(", ")}`)
      }
      result.fallbackModel = value
    } else {
      throw new Error(`Unknown ChatGPT setting: ${key}`)
    }
  }
  return result
}

export function chatGptFeatureCapabilities(features: ChatGptFeatures): Array<{ name: string; status: string; detail: string }> {
  return [
    {
      name: "Thinking",
      status: features.thinkingPassthrough ? "summaries" : "hidden",
      detail: features.thinkingPassthrough
        ? "ChatGPT exposes only short reasoning summaries and encrypted reasoning; both pass through untouched."
        : "Reasoning summaries are removed from responses. Encrypted reasoning still passes through for the next turn.",
    },
    {
      name: "Max Budget",
      status: features.maxBudgetUsd > 0 ? `$${features.maxBudgetUsd}` : "off",
      detail: "Per-request cost cap from OpenAI pricing: refused before sending, or stopped mid-stream, when the estimate is over it.",
    },
    {
      name: "Fallback Model",
      status: features.fallbackModel || "off",
      detail: "Retried once on this model when the requested one fails before any output was sent.",
    },
  ]
}

export function updateChatGptFeatures(patch: Partial<ChatGptFeatures>): ChatGptFeatures {
  setSetting("chatgpt", { ...(getSetting("chatgpt") ?? {}), ...patch })
  return getChatGptFeatures()
}

export function resetChatGptFeatures(): ChatGptFeatures {
  setSetting("chatgpt", undefined)
  return getChatGptFeatures()
}
