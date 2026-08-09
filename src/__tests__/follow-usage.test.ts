/**
 * followUsage — a follower reports the usage figures the followed instance
 * has already paid for, instead of competing with it for the same per-account
 * rate-limit budget.
 *
 * The parser is pure and gets direct tests. The lookup is gated on
 * MERIDIAN_FOLLOW_ACTIVE, which this file sets and restores per test; the
 * preload clears it, so nothing here leaks into the profile/routing suites.
 */

import { describe, expect, test, afterEach } from "bun:test"
import {
  FOLLOW_USAGE_MAX_AGE_MS,
  followedUsageSnapshot,
  readFollowedUsage,
  resetFollowedUsage,
  setFollowedUsageForTesting,
} from "../proxy/followUsage"
import type { OAuthUsageSnapshot } from "../proxy/oauthUsage"

const FLAG = "MERIDIAN_FOLLOW_ACTIVE"

function quotaBody(profiles: unknown[]): unknown {
  return { profiles, activeProfile: "personal", asOf: Date.now() }
}

function snapshot(utilization: number): OAuthUsageSnapshot {
  return {
    windows: [{ type: "five_hour", utilization, resetsAt: null }],
    extraUsage: null,
    fetchedAt: Date.now(),
  }
}

afterEach(() => {
  delete process.env[FLAG]
  delete process.env.CLAUDE_PROXY_FOLLOW_ACTIVE
  resetFollowedUsage()
})

describe("readFollowedUsage", () => {
  test("keeps profiles that carry windows", () => {
    const parsed = readFollowedUsage(quotaBody([
      {
        id: "personal",
        windows: [
          { type: "five_hour", utilization: 0.4, resetsAt: 1234 },
          { type: "seven_day", utilization: 0.1, resetsAt: null },
        ],
        extraUsage: null,
        fetchedAt: 999,
        error: null,
      },
    ]))

    expect(parsed.size).toBe(1)
    const personal = parsed.get("personal")!
    expect(personal.windows).toEqual([
      { type: "five_hour", utilization: 0.4, resetsAt: 1234 },
      { type: "seven_day", utilization: 0.1, resetsAt: null },
    ])
    expect(personal.fetchedAt).toBe(999)
  })

  test("drops a profile the followed instance itself could not read", () => {
    const parsed = readFollowedUsage(quotaBody([
      { id: "dead", windows: [], extraUsage: null, fetchedAt: null, error: "no_token" },
      { id: "limited", windows: [], extraUsage: null, fetchedAt: null, error: "upstream_error" },
    ]))
    expect(parsed.size).toBe(0)
  })

  test("drops an entry with no windows even when it reports no error", () => {
    const parsed = readFollowedUsage(quotaBody([
      { id: "cold", windows: [], extraUsage: null, fetchedAt: null, error: null },
    ]))
    expect(parsed.size).toBe(0)
  })

  test("survives a garbage body without throwing", () => {
    expect(readFollowedUsage(undefined).size).toBe(0)
    expect(readFollowedUsage(null).size).toBe(0)
    expect(readFollowedUsage("nope").size).toBe(0)
    expect(readFollowedUsage({ profiles: "nope" }).size).toBe(0)
    expect(readFollowedUsage({ profiles: [null, 7, { noId: true }] }).size).toBe(0)
  })

  test("skips malformed windows but keeps the usable ones", () => {
    const parsed = readFollowedUsage(quotaBody([
      {
        id: "mixed",
        windows: [
          { utilization: 0.5 },
          { type: "five_hour", utilization: "high", resetsAt: "soon" },
          { type: "seven_day", utilization: 0.2, resetsAt: 42 },
        ],
        error: null,
      },
    ]))
    expect(parsed.get("mixed")!.windows).toEqual([
      { type: "five_hour", utilization: null, resetsAt: null },
      { type: "seven_day", utilization: 0.2, resetsAt: 42 },
    ])
  })
})

describe("followedUsageSnapshot", () => {
  test("returns nothing when this instance follows no one", () => {
    setFollowedUsageForTesting(new Map([["personal", snapshot(0.4)]]))
    expect(followedUsageSnapshot("personal")).toBeUndefined()
  })

  test("returns the followed figures when following", () => {
    process.env[FLAG] = "http://127.0.0.1:3456"
    setFollowedUsageForTesting(new Map([["personal", snapshot(0.4)]]))
    expect(followedUsageSnapshot("personal")!.windows[0]!.utilization).toBe(0.4)
  })

  test("returns nothing for a profile the followed instance did not report", () => {
    process.env[FLAG] = "http://127.0.0.1:3456"
    setFollowedUsageForTesting(new Map([["personal", snapshot(0.4)]]))
    expect(followedUsageSnapshot("someone-else")).toBeUndefined()
  })

  test("stops serving figures older than the max age", () => {
    process.env[FLAG] = "http://127.0.0.1:3456"
    setFollowedUsageForTesting(
      new Map([["personal", snapshot(0.4)]]),
      Date.now() - FOLLOW_USAGE_MAX_AGE_MS - 1,
    )
    expect(followedUsageSnapshot("personal")).toBeUndefined()
  })
})
