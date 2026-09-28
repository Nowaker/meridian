/**
 * Which opencode config files load oc-codex-multi-auth, and editing them.
 *
 * Mirrors opencode's `config/config.ts` load order (verified against opencode
 * dev, 2026-09):
 *
 *   1. Global directory: `config.json`, `opencode.json`, `opencode.jsonc`,
 *      merged with remeda `mergeDeep`, which REPLACES arrays. A later file that
 *      declares `plugin` therefore discards every earlier file's list - the
 *      earlier entries are inert, not active.
 *   2. `OPENCODE_CONFIG`, then project `opencode.json`/`opencode.jsonc` files
 *      from the outermost directory down to the session directory, stopping at
 *      the worktree (`/` outside git), then `opencode.json{,c}` inside every
 *      `.opencode` directory on the same walk, `~/.opencode`,
 *      `OPENCODE_CONFIG_DIR`, `OPENCODE_CONFIG_CONTENT`, and the managed
 *      directory. From step 2 on, plugin lists ACCUMULATE across files.
 *   3. Any `plugin/*.{ts,js}` or `plugins/*.{ts,js}` file inside those
 *      directories is loaded without being listed anywhere.
 *
 * Edits go through jsonc-parser `modify`, which changes only the touched
 * range, so comments, trailing commas and the operator's layout survive.
 * Option objects of `[spec, options]` plugin tuples are never read into a
 * report: they are free-form and may carry credentials.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { applyEdits, modify, parse as parseJsonc, type ParseError } from "jsonc-parser"
import {
  GLOBAL_CONFIG_FILE_NAMES,
  PLUGIN_PACKAGE_NAME,
  defaultManagedConfigDir,
  opencodeGlobalConfigDir,
  type MigrationEnvironment,
} from "./layout"
import { isRecord } from "./sources"

export type LayerScope = "global" | "custom" | "project" | "dotdir" | "content" | "managed"

export interface ConfigLayer {
  /** A file path; for `content` the literal `OPENCODE_CONFIG_CONTENT`. */
  path: string
  scope: LayerScope
}

export interface OpencodeContext {
  /** Where opencode was started. */
  directory: string
  /** The git worktree root, or `/` outside git - where the upward walk stops. */
  worktree: string
}

export type PluginMatchReason = "package-name" | "package-json" | "path-name"

export interface PluginEntry {
  layer: ConfigLayer
  /** Index in that file's `plugin` array. */
  index: number
  /** The specifier only - never the options of a tuple entry. */
  spec: string
  match: PluginMatchReason | null
  /** False when a later global file's `plugin` array replaced this file's. */
  effective: boolean
  shadowedBy?: string
}

export interface AutoloadedPluginFile {
  path: string
  reason: "file-name" | "imports-plugin"
}

export interface PluginResolution {
  layers: ConfigLayer[]
  entries: PluginEntry[]
  autoloaded: AutoloadedPluginFile[]
  /** Files that exist but could not be parsed: whether they load the plugin is unknown. */
  unparseable: string[]
}

// ---------------------------------------------------------------------------
// Git worktree (only as far as opencode uses it: the upward walk's stop)
// ---------------------------------------------------------------------------

export function findWorktree(directory: string): string {
  let current = resolve(directory)
  while (true) {
    if (existsSync(join(current, ".git"))) return current
    const parent = dirname(current)
    if (parent === current) return "/"
    current = parent
  }
}

export function contextFor(directory: string): OpencodeContext {
  return { directory: resolve(directory), worktree: findWorktree(directory) }
}

/** opencode's `FSUtil.up`: every target in every directory from start to stop, innermost first. */
function up(targets: readonly string[], start: string, stop: string): string[] {
  const found: string[] = []
  let current = start
  while (true) {
    for (const target of targets) {
      const candidate = join(current, target)
      if (existsSync(candidate)) found.push(candidate)
    }
    if (current === stop) break
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return found
}

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

export function globalConfigLayers(env: MigrationEnvironment): ConfigLayer[] {
  const dir = opencodeGlobalConfigDir(env)
  return GLOBAL_CONFIG_FILE_NAMES.map(name => ({ path: join(dir, name), scope: "global" as const }))
}

function directoriesFor(env: MigrationEnvironment, context: OpencodeContext | null): string[] {
  const dirs = [opencodeGlobalConfigDir(env)]
  if (context && !env.disableProjectConfig) dirs.push(...up([".opencode"], context.directory, context.worktree))
  dirs.push(...up([".opencode"], env.home, env.home))
  if (env.opencodeConfigDir) dirs.push(env.opencodeConfigDir)
  return [...new Set(dirs)]
}

/** Every config source opencode reads for this context, in merge order. */
export function configLayers(env: MigrationEnvironment, context: OpencodeContext | null): ConfigLayer[] {
  const layers: ConfigLayer[] = globalConfigLayers(env)
  if (env.opencodeConfig) layers.push({ path: env.opencodeConfig, scope: "custom" })
  if (context && !env.disableProjectConfig) {
    for (const path of up(["opencode.jsonc", "opencode.json"], context.directory, context.worktree).reverse()) {
      layers.push({ path, scope: "project" })
    }
  }
  for (const dir of directoriesFor(env, context)) {
    if (!dir.endsWith(".opencode") && dir !== env.opencodeConfigDir) continue
    for (const name of ["opencode.json", "opencode.jsonc"]) layers.push({ path: join(dir, name), scope: "dotdir" })
  }
  if (env.opencodeConfigContent) layers.push({ path: "OPENCODE_CONFIG_CONTENT", scope: "content" })
  const managed = env.managedConfigDir ?? defaultManagedConfigDir()
  for (const name of ["opencode.json", "opencode.jsonc"]) layers.push({ path: join(managed, name), scope: "managed" })
  return layers
}

// ---------------------------------------------------------------------------
// Parsing and matching
// ---------------------------------------------------------------------------

export class UnparseableOpencodeConfigError extends Error {
  readonly path: string

  constructor(path: string) {
    super(`Could not parse ${path} as JSONC. It was left untouched.`)
    this.name = "UnparseableOpencodeConfigError"
    this.path = path
  }
}

export function parseConfigText(text: string, path: string): Record<string, unknown> {
  const errors: ParseError[] = []
  const parsed: unknown = parseJsonc(text, errors, { allowTrailingComma: true })
  if (errors.length > 0 || !isRecord(parsed)) throw new UnparseableOpencodeConfigError(path)
  return parsed
}

function readLayerText(layer: ConfigLayer, env: MigrationEnvironment): string | null {
  if (layer.scope === "content") return env.opencodeConfigContent ?? null
  try {
    if (!statSync(layer.path).isFile()) return null
    return readFileSync(layer.path, "utf8")
  } catch {
    return null
  }
}

function specifierOf(entry: unknown): string | null {
  if (typeof entry === "string") return entry
  if (Array.isArray(entry) && typeof entry[0] === "string") return entry[0]
  return null
}

function isPathSpec(spec: string): boolean {
  return spec.startsWith("file://") || spec.startsWith(".") || isAbsolute(spec) || /^[A-Za-z]:[\\/]/.test(spec)
}

/** `oc-codex-multi-auth`, `oc-codex-multi-auth@1.2.3`, `npm:oc-codex-multi-auth@latest`. */
export function packageNameOf(spec: string): string {
  const bare = spec.startsWith("npm:") ? spec.slice(4) : spec
  const versionAt = bare.startsWith("@") ? bare.indexOf("@", 1) : bare.indexOf("@")
  return versionAt > 0 ? bare.slice(0, versionAt) : bare
}

function packageJsonName(start: string): string | null | undefined {
  let current = start
  for (let depth = 0; depth < 12; depth++) {
    const candidate = join(current, "package.json")
    if (existsSync(candidate)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(candidate, "utf8"))
        return isRecord(parsed) && typeof parsed.name === "string" ? parsed.name : null
      } catch {
        return null
      }
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return undefined
}

/**
 * A path entry is the plugin when the package.json above it says so - which
 * also catches a checkout renamed to anything, such as a worktree. Only when
 * the target is gone does the directory name decide.
 */
export function matchPluginSpec(spec: string, declaredIn: string | null): PluginMatchReason | null {
  if (!isPathSpec(spec)) return packageNameOf(spec) === PLUGIN_PACKAGE_NAME ? "package-name" : null
  let target: string
  try {
    target = spec.startsWith("file://") ? fileURLToPath(spec) : spec
  } catch {
    return null
  }
  if (!isAbsolute(target)) target = resolve(declaredIn ? dirname(declaredIn) : process.cwd(), target)
  let start = target
  try {
    if (!statSync(target).isDirectory()) start = dirname(target)
  } catch {
    start = dirname(target)
  }
  const name = packageJsonName(start)
  if (name === PLUGIN_PACKAGE_NAME) return "package-json"
  if (name === undefined && target.includes(PLUGIN_PACKAGE_NAME)) return "path-name"
  return null
}

function autoloadedFiles(dir: string): AutoloadedPluginFile[] {
  const found: AutoloadedPluginFile[] = []
  for (const sub of ["plugin", "plugins"]) {
    const pluginDir = join(dir, sub)
    let names: string[]
    try {
      names = readdirSync(pluginDir).filter(name => /\.(ts|js)$/.test(name)).sort()
    } catch {
      continue
    }
    for (const name of names) {
      const path = join(pluginDir, name)
      if (name.includes(PLUGIN_PACKAGE_NAME)) {
        found.push({ path, reason: "file-name" })
        continue
      }
      try {
        if (readFileSync(path, "utf8").includes(PLUGIN_PACKAGE_NAME)) found.push({ path, reason: "imports-plugin" })
      } catch {
        // An unreadable file is not evidence either way; opencode would fail to load it too.
      }
    }
  }
  return found
}

export function resolvePlugins(env: MigrationEnvironment, context: OpencodeContext | null): PluginResolution {
  const layers = configLayers(env, context)
  const entries: PluginEntry[] = []
  const unparseable: string[] = []
  let globalWinner: string | null = null

  // Walk global files backwards: the last one that declares `plugin` is the only global list that counts.
  const parsedByLayer = new Map<ConfigLayer, Record<string, unknown>>()
  for (const layer of layers) {
    const text = readLayerText(layer, env)
    if (text === null) continue
    try {
      parsedByLayer.set(layer, parseConfigText(text, layer.path))
    } catch (error) {
      if (!(error instanceof UnparseableOpencodeConfigError)) throw error
      unparseable.push(layer.path)
    }
  }
  for (const layer of [...layers].reverse()) {
    if (layer.scope !== "global") continue
    if (Array.isArray(parsedByLayer.get(layer)?.plugin)) {
      globalWinner = layer.path
      break
    }
  }

  for (const layer of layers) {
    const list = parsedByLayer.get(layer)?.plugin
    if (!Array.isArray(list)) continue
    const effective = layer.scope !== "global" || layer.path === globalWinner
    list.forEach((raw, index) => {
      const spec = specifierOf(raw)
      if (spec === null) return
      entries.push({
        layer,
        index,
        spec,
        match: matchPluginSpec(spec, layer.scope === "content" ? null : layer.path),
        effective,
        ...(effective ? {} : { shadowedBy: globalWinner ?? undefined }),
      })
    })
  }

  const autoloaded = directoriesFor(env, context).flatMap(autoloadedFiles)
  return { layers, entries, autoloaded, unparseable }
}

export function loadsPlugin(resolution: PluginResolution): boolean {
  return resolution.entries.some(entry => entry.match && entry.effective) || resolution.autoloaded.length > 0
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

function detectIndent(text: string): { insertSpaces: boolean; tabSize: number } {
  const line = text.split("\n").find(candidate => /^[ \t]+\S/.test(candidate))
  if (!line) return { insertSpaces: true, tabSize: 2 }
  if (line.startsWith("\t")) return { insertSpaces: false, tabSize: 1 }
  return { insertSpaces: true, tabSize: line.length - line.trimStart().length }
}

export interface PluginRemoval {
  text: string
  removed: string[]
}

/** Remove every `plugin` entry that is oc-codex-multi-auth. Unchanged text when none are. */
export function removePluginEntries(text: string, path: string): PluginRemoval {
  const list = parseConfigText(text, path).plugin
  if (!Array.isArray(list)) return { text, removed: [] }
  const indices: number[] = []
  const removed: string[] = []
  list.forEach((raw, index) => {
    const spec = specifierOf(raw)
    if (spec !== null && matchPluginSpec(spec, path)) {
      indices.push(index)
      removed.push(spec)
    }
  })
  let next = text
  const formattingOptions = detectIndent(text)
  // Highest index first, so each removal leaves the earlier indices valid.
  for (const index of indices.reverse()) {
    next = applyEdits(next, modify(next, ["plugin", index], undefined, { formattingOptions }))
  }
  parseConfigText(next, path)
  return { text: next, removed }
}

export interface ProviderPointing {
  providerId: string
  baseURL: string
  /** Written only when the provider has no `options.apiKey` yet. */
  apiKey: string
}

export interface ProviderEdit {
  text: string
  changed: boolean
  previousBaseURL: string | null
  apiKeyAdded: boolean
  /** The provider already had an API key, which opencode will now send to Meridian. */
  existingApiKeyKept: boolean
}

function providerOptions(config: Record<string, unknown>, providerId: string): Record<string, unknown> | null {
  const providers = config.provider
  if (!isRecord(providers)) return null
  const provider = providers[providerId]
  if (!isRecord(provider)) return null
  return isRecord(provider.options) ? provider.options : null
}

export function pointProviderAtMeridian(text: string, path: string, pointing: ProviderPointing): ProviderEdit {
  const options = providerOptions(parseConfigText(text, path), pointing.providerId)
  const previousBaseURL = typeof options?.baseURL === "string" ? options.baseURL : null
  const hasApiKey = options !== null && options.apiKey !== undefined
  const formattingOptions = detectIndent(text)
  let next = text
  if (previousBaseURL !== pointing.baseURL) {
    next = applyEdits(next, modify(next, ["provider", pointing.providerId, "options", "baseURL"], pointing.baseURL, { formattingOptions }))
  }
  if (!hasApiKey) {
    next = applyEdits(next, modify(next, ["provider", pointing.providerId, "options", "apiKey"], pointing.apiKey, { formattingOptions }))
  }
  parseConfigText(next, path)
  return {
    text: next,
    changed: next !== text,
    previousBaseURL,
    apiKeyAdded: !hasApiKey,
    existingApiKeyKept: hasApiKey,
  }
}

/** The file a provider setting must go in to beat every other global file. */
export function highestPrecedenceGlobalFile(env: MigrationEnvironment): string {
  const layers = globalConfigLayers(env)
  const existing = [...layers].reverse().find(layer => existsSync(layer.path))
  return (existing ?? layers[1]!).path
}

/** Layers after the global ones that set this provider's baseURL, and so override it. */
export function providerBaseUrlOverrides(
  env: MigrationEnvironment,
  context: OpencodeContext | null,
  providerId: string,
): string[] {
  const overrides: string[] = []
  for (const layer of configLayers(env, context)) {
    if (layer.scope === "global") continue
    const text = readLayerText(layer, env)
    if (text === null) continue
    try {
      const options = providerOptions(parseConfigText(text, layer.path), providerId)
      if (options && options.baseURL !== undefined) overrides.push(layer.path)
    } catch (error) {
      if (!(error instanceof UnparseableOpencodeConfigError)) throw error
    }
  }
  return overrides
}

export function describeLayer(layer: ConfigLayer): string {
  return layer.scope === "content" ? "OPENCODE_CONFIG_CONTENT" : `${layer.path} (${layer.scope})`
}
