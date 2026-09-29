/**
 * The models the ChatGPT gateway offers, read from the backend's own catalog.
 *
 * A hand-kept list does not stay true. On 2026-09-28 the gateway advertised 24
 * ids and the backend refused 17 of them for every ChatGPT account ("not
 * supported when using Codex with a ChatGPT account"). OpenAI changes this per
 * plan and without notice, so the answer is read where Codex CLI reads it:
 * `GET /backend-api/codex/models`, the catalog its model picker is built from.
 * Each entry names the plans it is available in (`available_in_plans`).
 *
 * Offered: every `visibility: "list"` entry available in the plan of at least
 * one seat. Hidden entries are left out on purpose: Codex's own bundled copy
 * of the catalog hides `gpt-daybreak-red-latest`, which the backend refuses,
 * and `gpt-daybreak-blue-latest`, which it serves, so "hidden" says nothing
 * about whether a model is served. An entry that names no plans is taken as
 * available in all of them. Measured 2026-09-29: the listed set was exactly
 * the set served on a Pro and a Team seat.
 *
 * The catalog is read with the first seat whose credentials serve now, re-read
 * hourly, and kept through a failed read. Until one read has succeeded - a
 * fresh process, or every read failing - `CHATGPT_MODELS` stands in.
 *
 * Offering is all this decides. Routing does not consult it: every OpenAI id
 * still goes to ChatGPT, where an unoffered one is served or refused by the
 * backend in its own words.
 *
 * NOTE: agent-specific. Like `/wham/usage`, this is an undocumented endpoint;
 * a response of an unrecognised shape is a failed read, never an empty catalog.
 * Nothing here refreshes a token: seats come from the credential source, which
 * in follow-external mode only reads what the store's owner wrote.
 */
import type { OpenAiModel } from "../openai"
import { CHATGPT_MODELS } from "../upstream/provider"
import type { ChatGptCredentialSource } from "./source"

/** Fixed by construction, like the responses URL: a bearer token is never aimed at a configurable host. */
const CATALOG_URL = "https://chatgpt.com/backend-api/codex/models"

/**
 * The Codex CLI version the catalog is asked for: a real release, the newest
 * listed model's `minimal_client_version` on 2026-09-29. The backend answers
 * for that version (measured: 0.100.0 got no usable catalog, so the static
 * list stood in), so a model that needs a newer Codex is not offered until
 * this is raised. That errs toward offering less, never a refused model; an
 * unoffered model still routes to ChatGPT when a client names it.
 */
export const CATALOG_CLIENT_VERSION = "0.155.0"

const ORIGINATOR = "codex_cli_rs"
const CATALOG_TTL_MS = 60 * 60_000
const FAILED_READ_RETRY_MS = 5 * 60_000
const TIMEOUT_MS = 10_000
const TOKEN_HEADROOM_MS = 10 * 60_000

export interface CatalogModel {
  slug: string
  displayName: string
  contextWindow: number | null
  /** The plan slugs it is available in; null = the entry does not say, so all. */
  plans: string[] | null
}

/**
 * The listed entries of a catalog response, in the backend's order, or null
 * when the body is not a catalog at all.
 */
export function parseCodexModelCatalog(body: unknown): CatalogModel[] | null {
  if (typeof body !== "object" || body === null) return null
  const entries = (body as { models?: unknown }).models
  if (!Array.isArray(entries)) return null
  const listed: CatalogModel[] = []
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue
    const { slug, visibility, display_name, context_window, available_in_plans } = entry as Record<string, unknown>
    if (typeof slug !== "string" || slug.length === 0 || visibility !== "list") continue
    if (listed.some(model => model.slug === slug)) continue
    listed.push({
      slug,
      displayName: typeof display_name === "string" && display_name.length > 0 ? display_name : slug,
      contextWindow: typeof context_window === "number" && Number.isFinite(context_window) && context_window > 0 ? context_window : null,
      plans: Array.isArray(available_in_plans) ? available_in_plans.filter((plan): plan is string => typeof plan === "string") : null,
    })
  }
  return listed
}

/**
 * The models of `catalog` available in at least one of `plans`. No known plan
 * at all (seats whose tokens name none) filters nothing: there is nothing to
 * filter by, and offering nothing would be a guess too.
 */
export function offeredModels(catalog: readonly CatalogModel[], plans: ReadonlySet<string>): CatalogModel[] {
  if (plans.size === 0) return [...catalog]
  return catalog.filter(model => model.plans === null || model.plans.some(plan => plans.has(plan)))
}

/** What the catalog gave every listed model on 2026-09-29; stands in for the static list, which carries none. */
const DEFAULT_CONTEXT_WINDOW = 272_000

export function chatGptModelList(models: readonly CatalogModel[], created: number): OpenAiModel[] {
  return models.map(model => ({
    id: model.slug,
    object: "model",
    created,
    owned_by: "openai",
    display_name: model.displayName,
    context_window: model.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
  }))
}

export interface ChatGptModelCatalogView {
  /** "catalog" once the backend's catalog has been read, else "static". */
  source: "catalog" | "static"
  fetchedAt: number | null
  models: string[]
  /** Per plan held by a seat: what the catalog offers it. Empty until a read. */
  plans: Record<string, string[]>
}

export interface ChatGptModelCatalog {
  /** The models to offer: see the module note. */
  models(): string[]
  /** The offered models with the catalog's metadata; the static stand-ins carry none. */
  entries(): CatalogModel[]
  view(): ChatGptModelCatalogView
  /** Re-read the catalog when due. Concurrent calls share one read; undefined when not due. */
  refresh(): Promise<void> | undefined
}

export interface ChatGptModelCatalogOptions {
  source: ChatGptCredentialSource
  fetchImpl?: typeof fetch
  now?: () => number
  /** Offered until the catalog has been read. */
  fallback?: readonly string[]
  /**
   * A fresher plan slug per seat than the credential store's, where the usage
   * service has read one: the store keeps the plan from the last login, and a
   * seat moved from one plan to another keeps its old slug there.
   */
  planTypes?: () => ReadonlyMap<string, string | null>
}

export function createChatGptModelCatalog(options: ChatGptModelCatalogOptions): ChatGptModelCatalog {
  const { source } = options
  const doFetch = options.fetchImpl ?? fetch
  const now = options.now ?? Date.now
  const fallback = [...(options.fallback ?? CHATGPT_MODELS)]
  let catalog: { models: CatalogModel[]; fetchedAt: number } | null = null
  let retryAt = 0
  let running: Promise<void> | undefined

  const seatPlans = (): Set<string> => {
    const fresher = options.planTypes?.() ?? new Map<string, string | null>()
    return new Set(source.seats()
      .map(seat => fresher.get(seat.id) ?? seat.planType)
      .filter((plan): plan is string => typeof plan === "string"))
  }

  // Only a seat whose token has well over the owned store's five-minute refresh
  // buffer left: in owned mode `credentials` renews a token near expiry, and a
  // catalog read is never a reason to spend a refresh token.
  const readableSeats = (at: number) => source.seats()
    .filter(seat => seat.eligible && seat.expiresAt !== null && seat.expiresAt - at > TOKEN_HEADROOM_MS)

  /** `asked` is whether any request left the process; without one there is nothing to back off from. */
  const read = async (at: number): Promise<{ models: CatalogModel[] | null; asked: boolean }> => {
    let asked = false
    for (const seat of readableSeats(at)) {
      const credential = await source.credentials(seat.id)
      if (!credential.ok) continue
      const url = new URL(CATALOG_URL)
      url.searchParams.set("client_version", CATALOG_CLIENT_VERSION)
      asked = true
      try {
        const response = await doFetch(url, {
          headers: {
            authorization: `Bearer ${credential.account.accessToken}`,
            "chatgpt-account-id": credential.account.accountId,
            originator: ORIGINATOR,
            accept: "application/json",
          },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        })
        if (!response.ok) {
          await response.body?.cancel().catch(() => {})
          continue
        }
        const parsed = parseCodexModelCatalog(await response.json())
        if (parsed && parsed.length > 0) return { models: parsed, asked }
      } catch {
        continue
      }
    }
    return { models: null, asked }
  }

  const entries = (): CatalogModel[] => {
    if (!catalog) return fallback.map(slug => ({ slug, displayName: slug, contextWindow: null, plans: null }))
    return offeredModels(catalog.models, seatPlans())
  }

  return {
    entries,
    models: () => entries().map(model => model.slug),
    view() {
      const plans: Record<string, string[]> = {}
      if (catalog) {
        for (const plan of seatPlans()) plans[plan] = offeredModels(catalog.models, new Set([plan])).map(model => model.slug)
      }
      return {
        source: catalog ? "catalog" : "static",
        fetchedAt: catalog?.fetchedAt ?? null,
        models: entries().map(model => model.slug),
        plans,
      }
    },
    refresh() {
      if (running) return running
      const at = now()
      if (catalog && at - catalog.fetchedAt < CATALOG_TTL_MS) return undefined
      if (at < retryAt) return undefined
      running = read(at)
        .then(({ models, asked }) => {
          if (models) {
            catalog = { models, fetchedAt: at }
            retryAt = 0
          } else if (asked) {
            retryAt = at + FAILED_READ_RETRY_MS
          }
        })
        .finally(() => { running = undefined })
      return running
    },
  }
}
