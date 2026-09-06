/**
 * Task 3 — provider-scoped profiles.
 *
 * Two rules do the work here, and they are deliberately different:
 *
 *   AMBIENT selection (active profile, config default, first) FILTERS by
 *   provider. An OpenAI profile that happens to be active must not make an
 *   Anthropic-scoped resolution fail, because the callers doing ambient
 *   resolution are /health, /profiles/list, the token refresher and the 45s
 *   auth keepalive. A throw there is not a routing bug, it is an outage: the
 *   reverse proxy's health probe requires the literal string "healthy" in the
 *   body, so a /health that throws silently drops the instance out of
 *   rotation.
 *
 *   EXPLICIT selection (an x-meridian-profile header naming a profile) ERRORS
 *   on a provider mismatch. There the client has asserted something false,
 *   and quietly serving it from another vendor's account is the exact
 *   cross-provider failure this scoping exists to prevent.
 *
 * The resolved OpenAI shape carries no `env` at all. That is not tidiness: it
 * makes feeding an OpenAI profile into the Claude environment builder a type
 * error rather than a runtime surprise, and the runtime assertion below
 * exists because types are erased and the consequence would be a ChatGPT
 * credential handed to the Claude SDK.
 */
import { describe, test, expect, beforeEach } from "bun:test"
import {
  resolveProfile,
  resolveProfileForProvider,
  profilesForProvider,
  profileProvider,
  ProfileProviderMismatchError,
  NoProfileForProviderError,
  listProfiles,
  resetActiveProfile,
  setActiveProfile,
  type ProfileConfig,
} from "../proxy/profiles"

beforeEach(() => {
  resetActiveProfile()
})

const LEGACY: ProfileConfig[] = [
  { id: "personal", type: "claude-max", claudeConfigDir: "/home/.config/meridian/profiles/personal" },
  { id: "work", type: "claude-max", claudeConfigDir: "/home/.config/meridian/profiles/work" },
  { id: "api-test", type: "api", apiKey: "sk-test-123", baseUrl: "https://api.example.com" },
]

const GPT: ProfileConfig = { id: "gpt", provider: "openai", accountUserId: "user-abc" }

const MIXED: ProfileConfig[] = [GPT, ...LEGACY]

describe("normalization — a profiles.json with no provider key is unchanged", () => {
  test("every legacy entry normalizes to anthropic", () => {
    for (const profile of LEGACY) {
      expect(profileProvider(profile)).toBe("anthropic")
    }
  })

  test("legacy resolution is byte-identical to today", () => {
    expect(resolveProfile(LEGACY, undefined).id).toBe("personal")
    expect(resolveProfile(LEGACY, undefined).env).toEqual({
      CLAUDE_CONFIG_DIR: "/home/.config/meridian/profiles/personal",
    })
    expect(resolveProfile(LEGACY, undefined, "api-test").env).toEqual({
      ANTHROPIC_API_KEY: "sk-test-123",
      ANTHROPIC_BASE_URL: "https://api.example.com",
    })
    expect(resolveProfile(LEGACY, "work").id).toBe("work")
  })

  test("no profiles at all still means single-account mode", () => {
    const resolved = resolveProfile(undefined, undefined)
    expect(resolved).toEqual({ provider: "anthropic", id: "default", type: "claude-max", env: {} })
  })

  test("an explicit provider: anthropic is accepted and identical", () => {
    const explicit: ProfileConfig[] = [{ id: "personal", provider: "anthropic", claudeConfigDir: "/x" }]
    expect(profileProvider(explicit[0]!)).toBe("anthropic")
    expect(resolveProfile(explicit, undefined).env).toEqual({ CLAUDE_CONFIG_DIR: "/x" })
  })
})

describe("profilesForProvider", () => {
  test("partitions a mixed pool", () => {
    expect(profilesForProvider(MIXED, "anthropic").map(p => p.id)).toEqual(["personal", "work", "api-test"])
    expect(profilesForProvider(MIXED, "openai").map(p => p.id)).toEqual(["gpt"])
  })

  test("an all-legacy pool is entirely anthropic", () => {
    expect(profilesForProvider(LEGACY, "anthropic")).toHaveLength(3)
    expect(profilesForProvider(LEGACY, "openai")).toEqual([])
  })
})

describe("ambient selection filters by provider instead of failing", () => {
  test("an OpenAI profile listed FIRST is skipped for an Anthropic resolution", () => {
    expect(resolveProfile(MIXED, undefined).id).toBe("personal")
  })

  test("an ACTIVE OpenAI profile does not break Anthropic resolution", () => {
    // This is the /health case. Throwing here drops the instance out of the
    // reverse proxy's rotation.
    setActiveProfile("gpt")
    const resolved = resolveProfile(MIXED, undefined)
    expect(resolved.provider).toBe("anthropic")
    expect(resolved.id).toBe("personal")
  })

  test("a config default naming an OpenAI profile does not break it either", () => {
    const resolved = resolveProfile(MIXED, "gpt")
    expect(resolved.provider).toBe("anthropic")
    expect(resolved.id).toBe("personal")
  })

  test("an unknown id still warns and falls back, exactly as before", () => {
    expect(resolveProfile(LEGACY, undefined, "nonexistent").id).toBe("personal")
  })
})

describe("explicit selection errors on a provider mismatch", () => {
  test("asking Anthropic for a named OpenAI profile throws", () => {
    expect(() => resolveProfile(MIXED, undefined, "gpt")).toThrow(ProfileProviderMismatchError)
  })

  test("asking OpenAI for a named Anthropic profile throws", () => {
    expect(() => resolveProfileForProvider("openai", MIXED, undefined, "personal"))
      .toThrow(ProfileProviderMismatchError)
  })

  test("the mismatch error names the profile and both providers", () => {
    try {
      resolveProfile(MIXED, undefined, "gpt")
      throw new Error("expected a mismatch error")
    } catch (error) {
      expect(error).toBeInstanceOf(ProfileProviderMismatchError)
      const mismatch = error as ProfileProviderMismatchError
      expect(mismatch.profileId).toBe("gpt")
      expect(mismatch.requestedProvider).toBe("anthropic")
      expect(mismatch.actualProvider).toBe("openai")
    }
  })
})

describe("an OpenAI resolution with no OpenAI profile fails loudly", () => {
  test("throws NoProfileForProviderError rather than borrowing a Claude account", () => {
    expect(() => resolveProfileForProvider("openai", LEGACY, undefined))
      .toThrow(NoProfileForProviderError)
  })

  test("throws with no profiles configured at all", () => {
    expect(() => resolveProfileForProvider("openai", undefined, undefined))
      .toThrow(NoProfileForProviderError)
  })

  test("does NOT emit the unknown-profile fallback warning", () => {
    const warnings: string[] = []
    const original = console.warn
    console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")) }
    try {
      expect(() => resolveProfileForProvider("openai", LEGACY, undefined, "nonexistent"))
        .toThrow()
    } finally {
      console.warn = original
    }
    expect(warnings.join("\n")).not.toContain("Using first configured profile")
  })
})

describe("a resolved OpenAI profile can never carry Claude credentials", () => {
  test("carries no env and no Claude environment variable anywhere in it", () => {
    const resolved = resolveProfileForProvider("openai", MIXED, undefined)
    expect(resolved.provider).toBe("openai")
    expect(resolved.id).toBe("gpt")
    expect("env" in resolved).toBe(false)

    const serialized = JSON.stringify(resolved)
    expect(serialized).not.toContain("CLAUDE_CONFIG_DIR")
    expect(serialized).not.toContain("ANTHROPIC_API_KEY")
    expect(serialized).not.toContain("CLAUDE_CODE_OAUTH_TOKEN")
    expect(serialized).not.toContain("ANTHROPIC_BASE_URL")
  })

  test("identity is the account user id, never the shared account id", () => {
    const resolved = resolveProfileForProvider("openai", MIXED, undefined)
    expect(resolved).toMatchObject({ provider: "openai", authType: "chatgpt-oauth", accountUserId: "user-abc" })
  })
})

describe("listProfiles reports the provider rather than hiding it", () => {
  test("a mixed pool lists both, each with its provider", () => {
    const listed = listProfiles(MIXED, undefined)
    expect(listed.map(p => p.id).sort()).toEqual(["api-test", "gpt", "personal", "work"])
    expect(listed.find(p => p.id === "gpt")).toMatchObject({ provider: "openai", type: "chatgpt-oauth" })
    expect(listed.find(p => p.id === "personal")).toMatchObject({ provider: "anthropic", type: "claude-max" })
  })
})
