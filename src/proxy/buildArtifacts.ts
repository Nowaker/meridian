import { createHash, randomUUID } from "node:crypto"
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { z } from "zod"
import { BuildProvenanceError, gitOutput, snapshotSource } from "./buildSnapshot"
import { acquireBuildLock, buildBusy } from "./buildLock"
export { acquireBuildLock } from "./buildLock"

const identitySchema = z.object({
  source: z.literal("local"), kind: z.literal("artifact"), version: z.string(),
  releaseVersion: z.string().optional(), sha: z.string().regex(/^[a-f0-9]{40,64}$/),
  branch: z.string().optional(), dirty: z.boolean(), sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  branchUrl: z.string().url().optional(), commitUrl: z.string().url().optional(),
  counter: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), counterScope: z.string().uuid(),
  attemptId: z.string().uuid(), builtAt: z.string().datetime(), displayVersion: z.string(),
  certification: z.literal("verified"),
}).strict()
export const buildManifestSchema = z.object({
  schema: z.literal(1), build: identitySchema,
  artifacts: z.record(z.string().regex(/^(?!.*(?:^|\/)\.\.(?:\/|$))(?!\/)[A-Za-z0-9_./@-]+$/), z.string().regex(/^[a-f0-9]{64}$/)),
}).strict()
export type BuildManifest = z.infer<typeof buildManifestSchema>

export function buildStore(root: string): string {
  if (resolve(gitOutput(root, ["rev-parse", "--show-toplevel"])) !== resolve(root)) throw new BuildProvenanceError("invalid")
  return join(gitOutput(root, ["rev-parse", "--absolute-git-dir"]), "meridian-builds")
}

export function artifactInventory(directory: string): Record<string, string> {
  const entries: Record<string, string> = {}
  function visit(relative: string): void {
    for (const item of readdirSync(join(directory, relative), { withFileTypes: true })) {
      const name = relative ? `${relative}/${item.name}` : item.name
      if (name === "build-provenance.json") continue
      if (item.isDirectory()) visit(name)
      else if (item.isFile()) entries[name] = createHash("sha256").update(readFileSync(join(directory, name))).digest("hex")
      else throw new BuildProvenanceError("invalid")
    }
  }
  visit("")
  return Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)))
}

export function readCertifiedBuild(root: string): BuildManifest {
  const store = buildStore(root)
  if (buildBusy(store)) throw new BuildProvenanceError("building")
  const raw = readFileSync(join(root, "dist/build-provenance.json"), "utf8")
  const manifest = buildManifestSchema.parse(JSON.parse(raw))
  const scope = z.string().uuid().parse(readFileSync(join(store, "scope"), "utf8"))
  const record = readFileSync(join(store, `${manifest.build.counter}.json`), "utf8")
  if (scope !== manifest.build.counterScope || record !== raw || JSON.stringify(artifactInventory(join(root, "dist"))) !== JSON.stringify(manifest.artifacts)) throw new BuildProvenanceError("invalid")
  if (buildBusy(store) || readFileSync(join(root, "dist/build-provenance.json"), "utf8") !== raw) throw new BuildProvenanceError("building")
  return manifest
}

export function certifyBuild(root: string, gates: (identity: BuildManifest["build"]) => void): BuildManifest {
  const store = buildStore(root)
  const release = acquireBuildLock(store)
  try {
    const scopePath = join(store, "scope")
    if (!existsSync(scopePath)) writeFileSync(scopePath, randomUUID(), { flag: "wx", mode: 0o600 })
    const counterScope = z.string().uuid().parse(readFileSync(scopePath, "utf8"))
    const counters = readdirSync(store).filter(name => /^\d+\.json$/.test(name)).map(name => Number(name.slice(0, -5)))
    for (const completed of counters) {
      const record = buildManifestSchema.parse(JSON.parse(readFileSync(join(store, `${completed}.json`), "utf8")))
      if (record.build.counter !== completed || record.build.counterScope !== counterScope) throw new BuildProvenanceError("invalid")
    }
    const counter = Math.max(0, ...counters) + 1
    if (!Number.isSafeInteger(counter)) throw new BuildProvenanceError("invalid")
    const snapshot = snapshotSource(root)
    const build = identitySchema.parse({ ...snapshot, source: "local", kind: "artifact", counter, counterScope,
      attemptId: randomUUID(), builtAt: new Date().toISOString(), certification: "verified",
      displayVersion: `${snapshot.releaseVersion ? `v${snapshot.releaseVersion}` : `package-${snapshot.version}`}-${counter}-${snapshot.branch ?? "detached"}-${snapshot.sha.slice(0, 8)}${snapshot.dirty ? "-dirty" : ""}`,
    })
    rmSync(join(root, "dist"), { recursive: true, force: true })
    gates(build)
    if (JSON.stringify(snapshotSource(root)) !== JSON.stringify(snapshot)) throw new BuildProvenanceError("inputs-changed")
    const manifest = buildManifestSchema.parse({ schema: 1, build, artifacts: artifactInventory(join(root, "dist")) })
    if (Object.keys(manifest.artifacts).length === 0) throw new BuildProvenanceError("invalid")
    const content = JSON.stringify(manifest)
    const pending = join(store, "pending")
    writeFileSync(pending, content, { mode: 0o600 })
    const published = join(root, "dist/build-provenance.json")
    writeFileSync(`${published}.tmp`, content)
    renameSync(`${published}.tmp`, published)
    renameSync(pending, join(store, `${counter}.json`))
    return manifest
  } finally { release() }
}
