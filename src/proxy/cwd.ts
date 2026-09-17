/**
 * Resolve the SDK subprocess `cwd:` option, falling back to a known-valid
 * path on the proxy host when the resolved working directory doesn't exist.
 *
 * Background — issue #381:
 *   When meridian runs on a remote machine (e.g. accessed over Tailscale)
 *   and the client (OpenCode/Crush/etc.) runs on a different machine, the
 *   adapter extracts the client's reported working directory and passes it
 *   to the SDK as `cwd:`. That path doesn't exist on the proxy host, so
 *   `child_process.spawn(claude, { cwd })` fails with ENOENT — which the
 *   SDK then reports as the misleading "Claude Code native binary not
 *   found at ..." error.
 *
 *   Falling back to a directory that exists on the proxy host lets the SDK
 *   spawn succeed; `clientWorkingDirectory` is tracked separately (and
 *   emitted into the model's context via buildCwdNote) so the model still
 *   hears about the user's real working directory.
 *
 *   That landing spot is `neutralFallback` rather than the proxy's own
 *   checkout — see `neutralSdkWorkingDirectory` for why.
 */

import { existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export interface CwdResolution {
  /** Path passed to the SDK as `cwd:`. Always exists on the proxy host. */
  workingDirectory: string
  /**
   * The originally-resolved path before existence validation. May not
   * exist on the proxy host. Used as `clientWorkingDirectory` for
   * fingerprint bucketing and the system-prompt cwdNote.
   */
  claimedWorkingDirectory: string
  /** True if `workingDirectory` differs from `claimedWorkingDirectory`. */
  fellBack: boolean
}

export interface ResolveCwdOpts {
  /** MERIDIAN_WORKDIR / CLAUDE_PROXY_WORKDIR (highest precedence). */
  envOverride: string | undefined
  /** Adapter's extracted client working directory. */
  adapterCwd: string | undefined
  /**
   * Claimed when neither an override nor an adapter path is supplied. Must
   * exist; typically `process.cwd()`. This value is claimed, so it also keys
   * fingerprint bucketing — changing it re-buckets cwd-less clients.
   */
  fallback: string
  /**
   * Where to land when the claimed path is absent on this host. Must exist,
   * and must not sit inside a repository; typically
   * `neutralSdkWorkingDirectory()`. Defaults to `fallback`, which preserves
   * the pre-#744 behaviour for callers that don't supply one.
   */
  neutralFallback?: string
  /** Injection point for tests. Defaults to `node:fs`'s existsSync. */
  exists?: (path: string) => boolean
}

export function resolveSdkWorkingDirectory(opts: ResolveCwdOpts): CwdResolution {
  const exists = opts.exists ?? existsSync
  const claimed = opts.envOverride || opts.adapterCwd || opts.fallback
  if (exists(claimed)) {
    return { workingDirectory: claimed, claimedWorkingDirectory: claimed, fellBack: false }
  }
  return {
    workingDirectory: opts.neutralFallback ?? opts.fallback,
    claimedWorkingDirectory: claimed,
    fellBack: true,
  }
}

export interface NeutralCwdOpts {
  /** Directory to use. Defaults to `~/.config/meridian/sdk-cwd`. */
  root?: string
  /** Injection point for tests. Defaults to a recursive `mkdirSync`. */
  mkdir?: (path: string) => void
  /** Used only when the neutral directory cannot be created. */
  fallback?: string
}

/**
 * A directory that exists on the proxy host and describes nothing.
 *
 * The `claude_code` preset derives environment facts from the SDK's own
 * `cwd:` — the `# Environment` working-directory line and, whenever that
 * directory sits inside a repository, the entire `gitStatus` block. Landing a
 * remote client in `process.cwd()` therefore handed it meridian's OWN
 * checkout: our branch, our recent commits and our dirty files, presented as
 * that client's repository. An agent reading it builds git commands against a
 * branch belonging to the proxy, and reads a default branch that contradicts
 * the one it is actually on.
 *
 * `settingSources: []` already stops the same cwd leaking the proxy host's
 * CLAUDE.md into the prompt (#490). This closes the git half: an empty
 * directory outside any repository still satisfies `spawn()`, but gives the
 * preset nothing to report. That removes the contradiction at the source
 * instead of adding another note arguing the model out of it.
 *
 * Kept under meridian's own config root, not the OS temp dir, so a tmp sweep
 * cannot delete it out from under a long-running proxy.
 */
export function neutralSdkWorkingDirectory(opts: NeutralCwdOpts = {}): string {
  const dir = opts.root ?? join(homedir(), ".config", "meridian", "sdk-cwd")
  const mkdir = opts.mkdir ?? ((path: string) => { mkdirSync(path, { recursive: true }) })
  try {
    mkdir(dir)
    return dir
  } catch {
    // Spawning in the proxy's checkout is wrong, but failing to spawn at all
    // is worse. Never leave the caller with a directory that doesn't exist.
    return opts.fallback ?? process.cwd()
  }
}
