import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync, lstatSync, readlinkSync } from "node:fs"
import { join, resolve } from "node:path"
import { z } from "zod"
import { compareVersions } from "./buildInfo"
import { repositoryLinks } from "./localBuildInfo"

export class BuildProvenanceError extends Error {
  constructor(readonly reason: "git" | "inputs-changed" | "invalid" | "building" | "gate") {
    super(`Build provenance unavailable: ${reason}`)
  }
}

export function gitOutput(root: string, args: readonly string[]): string {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 2000, maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] })
  if (result.status !== 0) throw new BuildProvenanceError("git")
  return result.stdout.trimEnd()
}

export function snapshotSource(root: string) {
  if (resolve(gitOutput(root, ["rev-parse", "--show-toplevel"])) !== resolve(root)) throw new BuildProvenanceError("invalid")
  const version = z.object({ version: z.string() }).parse(JSON.parse(readFileSync(join(root, "package.json"), "utf8"))).version
  const sha = gitOutput(root, ["rev-parse", "HEAD"])
  const branch = gitOutput(root, ["rev-parse", "--abbrev-ref", "HEAD"])
  const status = gitOutput(root, ["status", "--porcelain=v1", "--untracked-files=all"])
  const files = gitOutput(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).split("\0").filter(Boolean).sort()
  const hash = createHash("sha256").update(sha).update("\0").update(branch).update("\0").update(status)
  for (const file of new Set(files)) {
    hash.update("\0").update(file).update("\0")
    try {
      const path = join(root, file)
      const stat = lstatSync(path)
      hash.update(String(stat.mode)).update("\0")
      if (stat.isSymbolicLink()) hash.update(readlinkSync(path))
      else if (stat.isFile()) hash.update(readFileSync(path))
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") hash.update("deleted")
      else throw error
    }
  }
  let remote = ""
  let releaseVersion: string | undefined
  try { remote = gitOutput(root, ["config", "--get", "remote.origin.url"]) }
  catch (error) { if (!(error instanceof BuildProvenanceError)) throw error }
  try {
    const tag = gitOutput(root, ["describe", "--tags", "--abbrev=0", "--match", "meridian-v[0-9]*", "--match", "v[0-9]*"])
    const tagVersion = /^(?:meridian-)?v(\d+\.\d+\.\d+(?:-[\w.-]+)?)$/.exec(tag)?.[1]
    // The release commit bumps package.json, so a reachable tag older than it
    // means newer tags were never fetched, not that the tree descends from it.
    if (tagVersion && compareVersions(tagVersion, version) >= 0) releaseVersion = tagVersion
  } catch (error) { if (!(error instanceof BuildProvenanceError)) throw error }
  return {
    version, sha, ...(branch !== "HEAD" ? { branch } : {}), dirty: status.length > 0,
    sourceHash: hash.digest("hex"), ...(releaseVersion ? { releaseVersion } : {}),
    ...repositoryLinks(remote, branch !== "HEAD" ? branch : undefined, sha),
  }
}
