/**
 * Unit tests for resolveSdkWorkingDirectory and neutralSdkWorkingDirectory.
 *
 * Verifies the precedence chain (env > adapter > fallback), the
 * existsSync-based fallback that fixes the remote-host issue (#381), and
 * that the directory it falls back to carries no repository for the
 * claude_code preset to describe.
 */

import { describe, it, expect } from "bun:test"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { neutralSdkWorkingDirectory, resolveSdkWorkingDirectory } from "../proxy/cwd"

describe("resolveSdkWorkingDirectory", () => {
  it("uses env override when set and exists", () => {
    const r = resolveSdkWorkingDirectory({
      envOverride: "/env/path",
      adapterCwd: "/adapter/path",
      fallback: "/fallback",
      exists: (p) => p === "/env/path",
    })
    expect(r.workingDirectory).toBe("/env/path")
    expect(r.claimedWorkingDirectory).toBe("/env/path")
    expect(r.fellBack).toBe(false)
  })

  it("uses adapter cwd when env is unset and adapter cwd exists", () => {
    const r = resolveSdkWorkingDirectory({
      envOverride: undefined,
      adapterCwd: "/adapter/path",
      fallback: "/fallback",
      exists: (p) => p === "/adapter/path",
    })
    expect(r.workingDirectory).toBe("/adapter/path")
    expect(r.claimedWorkingDirectory).toBe("/adapter/path")
    expect(r.fellBack).toBe(false)
  })

  it("uses fallback when both env and adapter are unset", () => {
    const r = resolveSdkWorkingDirectory({
      envOverride: undefined,
      adapterCwd: undefined,
      fallback: "/fallback",
      exists: () => true,
    })
    expect(r.workingDirectory).toBe("/fallback")
    expect(r.claimedWorkingDirectory).toBe("/fallback")
    expect(r.fellBack).toBe(false)
  })

  // Regression for #381 — when client supplies a working directory that
  // doesn't exist on the proxy host (remote-host setup), we MUST fall back
  // to the proxy's own cwd or the SDK spawn dies with ENOENT.
  it("falls back to fallback when adapter cwd doesn't exist (remote-host case)", () => {
    const r = resolveSdkWorkingDirectory({
      envOverride: undefined,
      adapterCwd: "/Users/clientmachine/proj",
      fallback: "/home/proxy",
      exists: (p) => p === "/home/proxy", // adapter path missing on proxy host
    })
    expect(r.workingDirectory).toBe("/home/proxy")
    expect(r.claimedWorkingDirectory).toBe("/Users/clientmachine/proj")
    expect(r.fellBack).toBe(true)
  })

  it("falls back when env override doesn't exist", () => {
    const r = resolveSdkWorkingDirectory({
      envOverride: "/missing",
      adapterCwd: undefined,
      fallback: "/home/proxy",
      exists: (p) => p === "/home/proxy",
    })
    expect(r.workingDirectory).toBe("/home/proxy")
    expect(r.claimedWorkingDirectory).toBe("/missing")
    expect(r.fellBack).toBe(true)
  })

  it("env override beats adapter cwd even when adapter cwd exists", () => {
    const r = resolveSdkWorkingDirectory({
      envOverride: "/env/path",
      adapterCwd: "/adapter/path",
      fallback: "/fallback",
      exists: () => true, // both exist
    })
    expect(r.workingDirectory).toBe("/env/path")
    expect(r.fellBack).toBe(false)
  })

  it("treats empty string envOverride as unset", () => {
    const r = resolveSdkWorkingDirectory({
      envOverride: "",
      adapterCwd: "/adapter/path",
      fallback: "/fallback",
      exists: () => true,
    })
    expect(r.workingDirectory).toBe("/adapter/path")
  })

  it("lands in neutralFallback when the claimed path is absent here", () => {
    const r = resolveSdkWorkingDirectory({
      envOverride: undefined,
      adapterCwd: "/Users/clientmachine/proj",
      fallback: "/home/proxy/checkout",
      neutralFallback: "/home/proxy/.config/meridian/sdk-cwd",
      exists: (p) => p !== "/Users/clientmachine/proj",
    })
    expect(r.workingDirectory).toBe("/home/proxy/.config/meridian/sdk-cwd")
    // The claim keys fingerprint bucketing, so it stays the client's own path
    // rather than wherever the subprocess had to land instead.
    expect(r.claimedWorkingDirectory).toBe("/Users/clientmachine/proj")
    expect(r.fellBack).toBe(true)
  })

  it("claims fallback rather than neutralFallback when nothing is supplied", () => {
    const r = resolveSdkWorkingDirectory({
      envOverride: undefined,
      adapterCwd: undefined,
      fallback: "/home/proxy/checkout",
      neutralFallback: "/home/proxy/.config/meridian/sdk-cwd",
      exists: () => true,
    })
    expect(r.workingDirectory).toBe("/home/proxy/checkout")
    expect(r.claimedWorkingDirectory).toBe("/home/proxy/checkout")
    expect(r.fellBack).toBe(false)
  })
})

describe("neutralSdkWorkingDirectory", () => {
  it("creates the directory it hands to the SDK", () => {
    const made: string[] = []
    const dir = neutralSdkWorkingDirectory({ root: "/neutral", mkdir: (p) => { made.push(p) } })
    expect(dir).toBe("/neutral")
    expect(made).toEqual(["/neutral"])
  })

  it("defaults to meridian's own config root, not the OS temp dir", () => {
    const dir = neutralSdkWorkingDirectory({ mkdir: () => {} })
    expect(dir.endsWith(join(".config", "meridian", "sdk-cwd"))).toBe(true)
  })

  // The whole point of the directory: the claude_code preset builds its
  // gitStatus block from the SDK's cwd, so a fallback anywhere inside a
  // repository reports that repository to a remote client as the client's own.
  it("does not sit inside a git repository", () => {
    let dir = neutralSdkWorkingDirectory({ mkdir: () => {} })
    const checked: string[] = []
    for (let prev = ""; dir !== prev; prev = dir, dir = dirname(dir)) {
      checked.push(dir)
      expect(existsSync(join(dir, ".git"))).toBe(false)
    }
    expect(checked.length).toBeGreaterThan(1)
  })

  it("falls back to a usable directory when the neutral one cannot be created", () => {
    const dir = neutralSdkWorkingDirectory({
      root: "/unwritable",
      mkdir: () => { throw new Error("EACCES") },
      fallback: "/home/proxy",
    })
    expect(dir).toBe("/home/proxy")
  })
})
