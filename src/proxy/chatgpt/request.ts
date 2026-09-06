/**
 * The outbound ChatGPT request, built from nothing.
 *
 * Pure: no I/O, no config, no inbound request. That last one is the point
 * rather than a convenience. The reference implementation starts from the
 * CLIENT's headers and deletes what it does not want, which is safe only
 * while the delete list keeps pace with everything clients send. Building
 * from an empty Headers inverts that: a header reaches the provider because
 * it is named below, and for no other reason.
 *
 * The origin is a compile-time constant with no override. An operator-supplied
 * base URL would let a bearer token be aimed at an arbitrary host, and the
 * token in question belongs to a subscription rather than to the operator.
 */

const CODEX_ORIGIN = "https://chatgpt.com"
const CODEX_BASE_PATH = "/backend-api"

export const CODEX_RESPONSES_URL = `${CODEX_ORIGIN}${CODEX_BASE_PATH}/codex/responses`

const ORIGINATOR = "codex_cli_rs"
const RESPONSES_BETA = "responses=experimental"
const RESPONSES_LITE_HEADER = "x-openai-internal-codex-responses-lite"

/** The tiers the reference implementation sends the responses-lite hint for. */
const RESPONSES_LITE_MODELS: ReadonlySet<string> = new Set([
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.6-cyber",
  "gpt-6-astra",
  "gpt-daybreak-blue",
  "gpt-daybreak-red",
])

export interface CodexRequestAccount {
  /** The workspace, sent as the scope header. */
  accountId: string
  accessToken: string
}

export interface CodexRequestOptions {
  /**
   * Off by default and deliberately opt-in: sending it changes how upstream
   * scopes and bills the request, so it is never inferred from an id merely
   * being available.
   */
  sendOrganizationHeader?: boolean
  organizationId?: string | null
}

export interface CodexRequest {
  url: string
  headers: Headers
}

export function buildCodexRequest(
  body: Record<string, unknown> | null | undefined,
  account: CodexRequestAccount,
  options?: CodexRequestOptions,
): CodexRequest {
  const headers = new Headers()
  headers.set("authorization", `Bearer ${account.accessToken}`)
  headers.set("chatgpt-account-id", account.accountId)
  headers.set("openai-beta", RESPONSES_BETA)
  headers.set("originator", ORIGINATOR)
  headers.set("accept", "text/event-stream")
  headers.set("content-type", "application/json")

  const model = body?.model
  if (typeof model === "string" && RESPONSES_LITE_MODELS.has(model)) {
    headers.set(RESPONSES_LITE_HEADER, "true")
  }

  // Both names carry the same key: it is what the provider reads for prompt
  // cache affinity, and a request with no key must go without one rather than
  // be given a fresh one, which would land it on a cold cache every turn.
  const cacheKey = body?.prompt_cache_key
  if (typeof cacheKey === "string" && cacheKey.length > 0) {
    headers.set("conversation_id", cacheKey)
    headers.set("session_id", cacheKey)
  }

  if (options?.sendOrganizationHeader && options.organizationId) {
    headers.set("openai-organization", options.organizationId)
  }

  return { url: CODEX_RESPONSES_URL, headers }
}
