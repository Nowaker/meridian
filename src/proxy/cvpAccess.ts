/**
 * Which Claude models each profile's account holds Cyber Verification Program
 * (CVP) access on, so work that needs it reaches an account that has it.
 *
 * Anthropic serves this per account, per model, only to a claude.ai web
 * session (the model selector's `badge`), never to the OAuth credential
 * Meridian holds, so Meridian cannot read it itself. Two sources feed it: a
 * claude.ai reading posted by something that has that session, and the
 * `stop_details.cyber_verification` a cyber refusal carries. A profile with
 * neither reading for a model takes what the other profiles of its
 * organization read there. Policy and contract: profiles-routing.spec.md,
 * "CVP access is learned, never fetched".
 *
 * Leaf module: no imports from server.ts or session/.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { z } from "zod"
import { configPath } from "../configDir"

/** CVP tiers as Anthropic names them: a specialized, b red team, c defense. */
export type CvpTier = "a" | "b" | "c"
/** Where a reading came from; "organization" is inferred from another profile's own reading, never stored. */
export type CvpSource = "claude_ai" | "observed" | "organization"

export interface CvpReading {
  readonly type: "active" | "inactive"
  readonly tier: CvpTier | null
  /** Why access is inactive, as Anthropic says it; null for a claude.ai reading. */
  readonly reason: string | null
  readonly source: CvpSource
  /** When it was learned, epoch ms. */
  readonly at: number
  /** claude.ai's display name for the model, when the reading named it. */
  readonly name?: string
  /** For an "organization" reading: the profile whose own reading it is. */
  readonly inferredFrom?: string
}

export interface CvpEntry extends CvpReading {
  readonly model: string
}

/** A claude.ai reading newer than this outranks a refusal observed after it. */
export const CLAUDE_AI_READING_FRESH_MS = 24 * 60 * 60_000

const tier = z.enum(["a", "b", "c"])
const reading = z.object({
  type: z.enum(["active", "inactive"]),
  tier: tier.nullable(),
  reason: z.string().nullable(),
  source: z.enum(["claude_ai", "observed"]),
  at: z.number(),
  name: z.string().optional(),
})
const modelRecord = z.object({ claude_ai: reading.optional(), observed: reading.optional() })
const storeFile = z.object({ profiles: z.record(z.string(), z.record(z.string(), modelRecord)) })
type StoreFile = z.infer<typeof storeFile>
type ModelRecord = z.infer<typeof modelRecord>
type StoredReading = z.infer<typeof reading>

const cyberVerification = z.union([
  z.object({ type: z.literal("active"), tier }),
  z.object({ type: z.literal("inactive"), reason: z.string().min(1) }),
])

const badge = z.object({ message: z.string() }).nullish()
/** One model of a claude.ai `model_selector_config` row, as posted to Meridian. */
export const claudeAiModelReading = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  badge,
  selector_badge: badge,
})
export type ClaudeAiModelReading = z.infer<typeof claudeAiModelReading>
/** `POST /profiles/:id/cvp-access`: one surface's `model_selector_config[].models`. */
export const cvpReadingBody = z.object({ models: z.array(claudeAiModelReading).min(1) })

/**
 * The id a reading, a refusal and a request agree on: lowercase, without a
 * `[1m]` suffix or a `-YYYYMMDD` snapshot date (claude.ai lists
 * `claude-haiku-4-5-20251001`, a refusal may name a dated snapshot).
 */
export function normalizeCvpModel(model: string): string {
  return model.trim().toLowerCase().replace(/\[1m\]$/, "").replace(/-20\d{6}$/, "")
}

/**
 * Whether a model id can key the map. Claude Code's own synthetic messages
 * carry the model `<synthetic>`, which no request ever names.
 */
export function isCvpModelId(model: string): boolean {
  return /^claude-[a-z0-9][a-z0-9.-]*$/.test(normalizeCvpModel(model))
}

/** Each profile's organization UUID, null or absent when unknown. */
export type CvpOrganizationLookup = () => Readonly<Record<string, string | null | undefined>>

let organizationsOf: CvpOrganizationLookup = () => ({})

/** Tell the map which profiles share an organization; server.ts supplies it so this module stays a leaf. */
export function setCvpOrganizationLookup(lookup: CvpOrganizationLookup): void {
  organizationsOf = lookup
}

/** The tier claude.ai's badge names ("CVP: Defense Access"); null when it names none we know. */
export function cvpTierFromBadge(message: string): CvpTier | null {
  if (/defen[cs]e/i.test(message)) return "c"
  if (/red\s*team/i.test(message)) return "b"
  if (/speciali[sz]ed/i.test(message)) return "a"
  return null
}

let cached: { file: string; mtimeMs: number; data: StoreFile } | undefined

function storePath(): string {
  return configPath("cvp-access.json")
}

function load(): StoreFile {
  const file = storePath()
  try {
    if (!existsSync(file)) {
      cached = { file, mtimeMs: 0, data: { profiles: {} } }
      return cached.data
    }
    const mtimeMs = statSync(file).mtimeMs
    if (cached?.file === file && cached.mtimeMs === mtimeMs) return cached.data
    const parsed = storeFile.safeParse(JSON.parse(readFileSync(file, "utf-8")))
    const data = parsed.success ? parsed.data : { profiles: {} }
    if (!parsed.success) console.warn(`[meridian] Ignoring malformed ${file}`)
    cached = { file, mtimeMs, data }
    return data
  } catch (err) {
    console.warn(`[meridian] Failed to read ${file}: ${err instanceof Error ? err.message : err}`)
    return cached?.file === file ? cached.data : { profiles: {} }
  }
}

function save(data: StoreFile): void {
  const file = storePath()
  // Written beside the file and renamed over it, so another instance never
  // reads half a file.
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(temporary, JSON.stringify(data, null, 2) + "\n", { mode: 0o600, flag: "wx" })
    renameSync(temporary, file)
    cached = { file, mtimeMs: statSync(file).mtimeMs, data }
  } catch (err) {
    console.warn(`[meridian] Failed to write ${file}: ${err instanceof Error ? err.message : err}`)
    try {
      rmSync(temporary, { force: true })
    } catch (cleanupErr) {
      console.warn(`[meridian] Failed to remove ${temporary}: ${cleanupErr instanceof Error ? cleanupErr.message : cleanupErr}`)
    }
    cached = { file, mtimeMs: -1, data }
  }
}

/** The profile's records under model ids that can key the map; a stored `<synthetic>` one is left out. */
function ownRecords(data: StoreFile, profileId: string): Record<string, ModelRecord> {
  return Object.fromEntries(Object.entries(data.profiles[profileId] ?? {}).filter(([model]) => isCvpModelId(model)))
}

function update(profileId: string, change: (models: Record<string, ModelRecord>) => Record<string, ModelRecord>): void {
  const data = load()
  const models = change(ownRecords(data, profileId))
  const profiles = { ...data.profiles }
  if (Object.keys(models).length > 0) profiles[profileId] = models
  else delete profiles[profileId]
  save({ profiles })
}

/**
 * Store a claude.ai model-selector reading for one profile. It is the whole
 * truth for the account at that moment: a listed model with a CVP badge is
 * active, one without is inactive, and claude.ai entries for models it no
 * longer lists are dropped. Refusals observed earlier are kept. Answers the
 * profile's resulting map.
 */
export function recordCvpReading(profileId: string, models: readonly ClaudeAiModelReading[], now = Date.now()): CvpEntry[] {
  update(profileId, current => {
    const next: Record<string, ModelRecord> = {}
    for (const [model, record] of Object.entries(current)) {
      if (record.observed) next[model] = { observed: record.observed }
    }
    for (const model of models) {
      if (!isCvpModelId(model.id)) continue
      const message = model.badge?.message ?? model.selector_badge?.message ?? null
      const active = message !== null && /\bCVP\b|cyber/i.test(message)
      const id = normalizeCvpModel(model.id)
      next[id] = {
        ...next[id],
        claude_ai: {
          type: active ? "active" : "inactive",
          tier: active ? cvpTierFromBadge(message) : null,
          reason: null,
          source: "claude_ai",
          at: now,
          ...(model.name ? { name: model.name } : {}),
        },
      }
    }
    return next
  })
  return cvpAccessFor(profileId, now)
}

/**
 * Learn from a refusal's `stop_details.cyber_verification` on `model`. Answers
 * whether it carried one Meridian could read.
 */
export function recordCvpRefusal(profileId: string, model: string, value: unknown, now = Date.now()): boolean {
  const parsed = cyberVerification.safeParse(value)
  if (!parsed.success || !isCvpModelId(model)) return false
  const observed: StoredReading = parsed.data.type === "active"
    ? { type: "active", tier: parsed.data.tier, reason: null, source: "observed", at: now }
    : { type: "inactive", tier: null, reason: parsed.data.reason, source: "observed", at: now }
  const id = normalizeCvpModel(model)
  update(profileId, current => ({ ...current, [id]: { ...current[id], observed } }))
  return true
}

/** The `cyber_verification` of a refusal row (assistant message), if it carries one. */
export function cyberVerificationOf(row: { readonly message?: unknown }): { model: string | null; value: unknown } | null {
  const message = row.message
  if (typeof message !== "object" || message === null) return null
  const { stop_reason, stop_details, model } = message as { stop_reason?: unknown; stop_details?: unknown; model?: unknown }
  if (stop_reason !== "refusal" || typeof stop_details !== "object" || stop_details === null) return null
  const value = (stop_details as { cyber_verification?: unknown }).cyber_verification
  if (value === undefined) return null
  return { model: typeof model === "string" ? model : null, value }
}

function effective(record: ModelRecord, now: number): CvpReading | undefined {
  const { claude_ai: claudeAi, observed } = record
  if (claudeAi && now - claudeAi.at < CLAUDE_AI_READING_FRESH_MS) return claudeAi
  if (claudeAi && observed) return observed.at > claudeAi.at ? observed : claudeAi
  return claudeAi ?? observed
}

function ownEntry(model: string, record: ModelRecord | undefined, now: number): CvpEntry | undefined {
  const decided = record ? effective(record, now) : undefined
  if (!decided) return undefined
  // A refusal names no display name; keep claude.ai's.
  const name = decided.name ?? record?.claude_ai?.name
  return { model, ...decided, ...(name ? { name } : {}) }
}

/**
 * The reading the profile's organization siblings agree on, from their own
 * readings only; undefined when its organization is unknown, no sibling has
 * one, or they disagree on active and inactive. The freshest names the source.
 */
function inferredEntry(data: StoreFile, organizations: ReturnType<CvpOrganizationLookup>, profileId: string, model: string, now: number): CvpEntry | undefined {
  const organization = organizations[profileId]
  if (!organization) return undefined
  const readings = Object.keys(data.profiles).flatMap(id => {
    if (id === profileId || organizations[id] !== organization) return []
    const entry = ownEntry(model, ownRecords(data, id)[model], now)
    return entry ? [{ id, entry }] : []
  })
  if (readings.length === 0 || readings.some(({ entry }) => entry.type !== readings[0]!.entry.type)) return undefined
  const freshest = readings.reduce((best, next) => next.entry.at > best.entry.at ? next : best)
  return { ...freshest.entry, source: "organization", inferredFrom: freshest.id }
}

/** Every model the profile's map knows, each with the reading that decides it: its own, else its organization's. */
export function cvpAccessFor(profileId: string, now = Date.now()): CvpEntry[] {
  const data = load()
  const organizations = organizationsOf()
  const own = ownRecords(data, profileId)
  const organization = organizations[profileId]
  const siblingModels = organization
    ? Object.keys(data.profiles).filter(id => id !== profileId && organizations[id] === organization).flatMap(id => Object.keys(ownRecords(data, id)))
    : []
  return [...new Set([...Object.keys(own), ...siblingModels])].flatMap(model => {
    const entry = ownEntry(model, own[model], now) ?? inferredEntry(data, organizations, profileId, model, now)
    return entry ? [entry] : []
  }).sort((a, b) => a.model.localeCompare(b.model))
}

/** What the profile's map says about one model, its own reading else its organization's; undefined when neither says. */
export function cvpAccessOn(profileId: string, model: string, now = Date.now()): CvpEntry | undefined {
  const id = normalizeCvpModel(model)
  if (!isCvpModelId(id)) return undefined
  const data = load()
  return ownEntry(id, ownRecords(data, profileId)[id], now) ?? inferredEntry(data, organizationsOf(), profileId, id, now)
}

/** When the profile's latest claude.ai reading arrived, whether or not it decides any model now; null when none has. */
export function lastClaudeAiReadingAt(profileId: string): number | null {
  const times = Object.values(ownRecords(load(), profileId)).flatMap(record => record.claude_ai ? [record.claude_ai.at] : [])
  return times.length > 0 ? Math.max(...times) : null
}

/** The `cyber_verification` field of a `/v1/models` entry: an entry without its model. */
export type CyberVerificationField = Omit<CvpEntry, "model" | "name">

export function cyberVerificationField(entry: CvpEntry): CyberVerificationField {
  return { type: entry.type, tier: entry.tier, reason: entry.reason, source: entry.source, at: entry.at, ...(entry.inferredFrom ? { inferredFrom: entry.inferredFrom } : {}) }
}

/** True only when the map says the profile holds CVP access on this model. */
export function cvpActive(profileId: string, model: string, now = Date.now()): boolean {
  return cvpAccessOn(profileId, model, now)?.type === "active"
}

/**
 * Whether the map, organization inference included, shows `active` access on
 * any model: a CVP holder, which `x-meridian-require: restricted` work never
 * reaches. Account-wide, since every model spends the same weekly allowance.
 */
export function holdsCvpAccess(profileId: string, now = Date.now()): boolean {
  return cvpAccessFor(profileId, now).some(entry => entry.type === "active")
}

/** Header naming what an unpinned request's account must hold. */
export const ROUTING_REQUIRE_HEADER = "x-meridian-require"
const KNOWN_REQUIREMENTS = new Set(["cvp", "restricted"])

export interface RoutingRequirements {
  /** Only accounts holding CVP access on the requested model. */
  readonly cvp: boolean
  /** Only accounts holding CVP access on no model. */
  readonly restricted: boolean
  readonly known: string[]
  readonly unknown: string[]
  /** Why the header cannot be honored (400), or null. */
  readonly error: string | null
}

/**
 * Read `x-meridian-require` (comma-separated, case-insensitive). A requirement
 * this build does not know, or two that no account can meet together, give an
 * `error`, so the caller refuses the request rather than route as if they had
 * been met.
 */
export function parseRoutingRequirements(header: string | undefined): RoutingRequirements {
  const tokens = [...new Set((header ?? "").split(",").map(token => token.trim().toLowerCase()).filter(Boolean))]
  const cvp = tokens.includes("cvp")
  const restricted = tokens.includes("restricted")
  const unknown = tokens.filter(token => !KNOWN_REQUIREMENTS.has(token))
  return {
    cvp,
    restricted,
    known: tokens.filter(token => KNOWN_REQUIREMENTS.has(token)),
    unknown,
    error: unknown.length > 0
      ? `${ROUTING_REQUIRE_HEADER}: unknown requirement ${unknown.join(", ")}`
      : cvp && restricted
        ? `${ROUTING_REQUIRE_HEADER}: cvp and restricted conflict: cvp work needs an account holding CVP access, restricted work one holding none`
        : null,
  }
}

/** The requirements a request carried, as telemetry records them; absent when none. */
export function routingRequireOf(header: string | undefined): string[] | undefined {
  const { known } = parseRoutingRequirements(header)
  return known.length > 0 ? known : undefined
}

/** Forget a profile's map: a new login may be another account. */
export function forgetCvpAccess(profileId: string): void {
  if (!load().profiles[profileId]) return
  update(profileId, () => ({}))
}

/** Test-only: drop the in-memory copy so the next read hits the file. */
export function resetCvpAccessCacheForTests(): void {
  cached = undefined
}
