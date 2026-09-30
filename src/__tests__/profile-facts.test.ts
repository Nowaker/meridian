/**
 * Unit tests for profileFacts.ts.
 *
 * The module ships browser source, so the tests evaluate that exact text
 * rather than a TypeScript copy of it — what is asserted here is what both
 * pages actually run.
 */
import { describe, test, expect } from "bun:test"
import { profileFactsJs } from "../telemetry/profileFacts"
import { landingHtml } from "../telemetry/landing"
import { profilePageHtml } from "../telemetry/profilePage"

interface Fact { label: string; value: string; tone: string }
interface AccessHelp { pill: string; reason: string; summary: string }

const evaluated = new Function(
  profileFactsJs + "\nreturn { profileFacts, timeAgo, formatResets, profileAccessHelp, chatGptUsageGap, refusalSubject, codexCreditsView };",
)() as {
  profileFacts: (p: Record<string, unknown>) => Fact[]
  timeAgo: (ts: number | null | undefined) => string
  formatResets: (resets: unknown, now: number) => string
  profileAccessHelp: (p: Record<string, unknown>) => AccessHelp
  chatGptUsageGap: (error: string | null | undefined) => string
  refusalSubject: (p: Record<string, unknown> | undefined) => { vendor: string; noun: string }
  codexCreditsView: (credits: unknown) => { value: string; note: string; status: string } | null
}

const { profileFacts, timeAgo, formatResets, profileAccessHelp, chatGptUsageGap, refusalSubject, codexCreditsView } = evaluated

function labels(p: Record<string, unknown>): string[] {
  return profileFacts(p).map(f => f.label)
}

function valueOf(p: Record<string, unknown>, label: string): string | undefined {
  return profileFacts(p).find(f => f.label === label)?.value
}

describe("profileFacts", () => {
  test("status is always stated, even for a profile with nothing else known", () => {
    expect(labels({})).toEqual(["Status"])
  })

  test("a logged-in account reads as authenticated, in the affirmative tone", () => {
    const status = profileFacts({ loggedIn: true })[0]!
    expect(status.value).toBe("✓ Authenticated")
    expect(status.tone).toBe("ok")
  })

  test("a logged-out account reads as not logged in, in the error tone", () => {
    const status = profileFacts({ loggedIn: false })[0]!
    expect(status.value).toBe("✗ Not logged in")
    expect(status.tone).toBe("err")
  })

  test("the organization is stated when known", () => {
    expect(valueOf({ organizationName: "Acme Inc" }, "Organization")).toBe("Acme Inc")
  })

  test("an unknown organization is omitted rather than rendered as a placeholder", () => {
    expect(labels({ organizationName: null })).not.toContain("Organization")
    expect(labels({ organizationName: "" })).not.toContain("Organization")
    expect(labels({})).not.toContain("Organization")
  })

  test("the organization sits between the email and the plan", () => {
    const rows = labels({ email: "a@b.c", organizationName: "Acme Inc", subscriptionType: "max" })
    expect(rows).toEqual(["Status", "Email", "Organization", "Plan"])
  })

  test("email and plan are stated when known and omitted when not", () => {
    expect(valueOf({ email: "a@b.c" }, "Email")).toBe("a@b.c")
    expect(valueOf({ subscriptionType: "max" }, "Plan")).toBe("max")
    expect(labels({ email: null, subscriptionType: null })).toEqual(["Status"])
  })

  test("last verified is stated in the affirmative tone", () => {
    const fact = profileFacts({ lastSuccessAt: Date.now() }).find(f => f.label === "Last Verified")!
    expect(fact.value).toBe("just now")
    expect(fact.tone).toBe("ok")
  })

  test("last checked is omitted when it merely repeats last verified", () => {
    const at = Date.now()
    expect(labels({ lastSuccessAt: at, lastCheckedAt: at })).not.toContain("Last Checked")
  })

  test("last checked is stated when it differs from last verified", () => {
    const at = Date.now()
    expect(labels({ lastSuccessAt: at - 60_000, lastCheckedAt: at })).toContain("Last Checked")
  })

  test("last checked is stated when nothing ever verified", () => {
    expect(labels({ loggedIn: false, lastCheckedAt: Date.now() })).toEqual(["Status", "Last Checked"])
  })

  test("the full set reads in card order", () => {
    const at = Date.now()
    expect(labels({
      loggedIn: true,
      email: "a@b.c",
      organizationName: "Acme Inc",
      subscriptionType: "max",
      lastSuccessAt: at - 60_000,
      lastCheckedAt: at,
    })).toEqual(["Status", "Email", "Organization", "Plan", "Last Verified", "Last Checked"])
  })
})

describe("a ChatGPT seat's card", () => {
  const DAY = 86_400_000
  const HOUR = 3_600_000
  // The shape /profiles/list gives a seat followed from oc-codex-multi-auth.
  const owner = {
    name: "oc-codex-multi-auth", mode: "follow-external", account: 3,
    login: "opencode auth login", loginMethod: "OpenAI → Codex OAuth (ChatGPT Plus/Pro)",
    refresh: "npx -y oc-codex-multi-auth doctor --fix", refreshTool: "codex-refresh",
    remove: "codex-remove index=3 confirm=true", importCommand: null,
  }
  const seat = (extra: Record<string, unknown> = {}) => ({
    id: "oferty-c487c4", type: "chatgpt", provider: "chatgpt", label: "oferty@nowaker.net · id:c487c4",
    email: "oferty@nowaker.net", accountType: "Personal", planName: "Pro", subscriptionType: "pro",
    allowance: "20x", loggedIn: true, tokenState: "ok", unavailable: null, authProvenance: "live",
    resets: { available: 0, expiresAt: [] }, owner, ...extra,
  })

  test("states banked resets as the brief spells them", () => {
    const now = 1_800_000_000_000
    expect(formatResets({ available: 1, expiresAt: [now + 13 * DAY + 5 * HOUR] }, now)).toBe("1 (expires 13d)")
    expect(formatResets({ available: 2, expiresAt: [now + 3 * DAY + HOUR, now + 11 * DAY + 2 * HOUR] }, now)).toBe("2 (expire 3d, 11d)")
    expect(formatResets({ available: 0, expiresAt: [] }, now)).toBe("0")
  })

  test("never hides a reset whose expiry it does not know, and says unknown with nothing to go on", () => {
    const now = 1_800_000_000_000
    expect(formatResets({ available: 2, expiresAt: [now + 3 * DAY, null] }, now)).toBe("2 (expire 3d, unknown)")
    expect(formatResets({ available: 2, expiresAt: null }, now)).toBe("2 (expiry unknown)")
    expect(formatResets({ available: 1, expiresAt: [now + 5 * HOUR + 1] }, now)).toBe("1 (expires 5h)")
    expect(formatResets({ available: 1, expiresAt: [now + 40 * 60_000 + 1] }, now)).toBe("1 (expires 40m)")
    // No valid access token, so the credits were never asked for.
    expect(formatResets(null, now)).toBe("unknown")
    expect(formatResets(undefined, now)).toBe("unknown")
  })

  test("prints Resets right after Plan, and only for a seat", () => {
    const facts = profileFacts(seat({ resets: { available: 1, expiresAt: [Date.now() + 13 * DAY + HOUR] } }))
    const rows = facts.map(f => f.label)
    expect(rows.slice(rows.indexOf("Plan"), rows.indexOf("Plan") + 2)).toEqual(["Plan", "Resets"])
    expect(facts.find(f => f.label === "Resets")?.value).toBe("1 (expires 13d)")
    expect(valueOf(seat({ resets: null }), "Resets")).toBe("unknown")
    expect(labels({ subscriptionType: "max", allowance: "20x" })).not.toContain("Resets")
  })

  test("words the allowance against ChatGPT Plus, and the owner of the login", () => {
    expect(valueOf(seat(), "Allowance")).toBe("20x of a ChatGPT Plus plan’s Codex usage")
    expect(valueOf({ allowance: "20x" }, "Allowance")).toBe("20x of a Pro plan’s Claude Code usage")
    expect(valueOf(seat(), "Owner")).toBe("oc-codex-multi-auth · account 3")
    expect(valueOf(seat({ unavailable: "quota_exhausted" }), "Owner state")).toBe("quota exhausted")
    expect(labels({ subscriptionType: "max" })).not.toContain("Owner")
  })

  test("shows a Business seat's workspace where a Claude card shows its organization", () => {
    const rows = labels(seat({ organizationName: "Acme Workspace" }))
    expect(rows.slice(0, 4)).toEqual(["Status", "Email", "Organization", "Account"])
    expect(valueOf(seat({ organizationName: "Acme Workspace" }), "Organization")).toBe("Acme Workspace")
    expect(labels(seat({ organizationName: null }))).not.toContain("Organization")
  })

  test("says what is wrong with the token rather than 'not logged in'", () => {
    const status = (tokenState: string) => valueOf(seat({ loggedIn: false, tokenState }), "Status")
    expect(status("expired")).toBe("✗ Access token expired")
    expect(status("refused")).toBe("✗ Token refused by chatgpt.com")
    expect(status("no_token")).toBe("✗ No access token")
    expect(valueOf(seat(), "Status")).toBe("✓ Authenticated")
  })

  test("sends a seat that cannot serve to its owner's exact command, never to meridian's", () => {
    const expired = profileAccessHelp(seat({ loggedIn: false, tokenState: "expired" }))
    expect(expired.pill).toBe("token expired")
    expect(expired.summary).toContain("npx -y oc-codex-multi-auth doctor --fix")
    expect(expired.summary).toContain("oc-codex-multi-auth owns this login")
    const refused = profileAccessHelp(seat({ loggedIn: false, tokenState: "refused" }))
    expect(refused.pill).toBe("token refused")
    expect(refused.summary).toContain("opencode auth login → OpenAI → Codex OAuth (ChatGPT Plus/Pro) → oferty@nowaker.net · id:c487c4 → Refresh account")
    for (const help of [expired, refused]) expect(help.summary).not.toContain("meridian profile login")
    expect(profileAccessHelp({ id: "work" })).toMatchObject({ pill: "needs login", summary: "Cannot serve requests — run: meridian profile login work" })
  })

  test("states purchased Codex credits where a Claude card states extra usage, and nothing without them", () => {
    const credits = (extra: Record<string, unknown>) => ({ hasCredits: false, unlimited: false, overageLimitReached: false, balance: null, ...extra })
    expect(codexCreditsView(credits({ hasCredits: true, balance: 1234.5 })))
      .toEqual({ value: "1,234.5 credits", note: "used once the plan’s limits run out", status: "ok" })
    expect(codexCreditsView(credits({ unlimited: true }))?.value).toBe("unlimited")
    expect(codexCreditsView(credits({ hasCredits: true }))?.value).toBe("available")
    expect(codexCreditsView(credits({ hasCredits: true, balance: 3, overageLimitReached: true })))
      .toMatchObject({ note: "overage limit reached", status: "high" })
    expect(codexCreditsView(credits({ balance: 0 }))).toBeNull()
    expect(codexCreditsView(null)).toBeNull()
  })

  test("explains a missing reading and names who is refusing", () => {
    expect(chatGptUsageGap("token_expired")).toContain("never renews")
    expect(chatGptUsageGap("unauthorized")).toContain("refused")
    expect(chatGptUsageGap(null)).toBe("")
    expect(refusalSubject(seat())).toEqual({ vendor: "ChatGPT", noun: "seat" })
    expect(refusalSubject({ id: "work" })).toEqual({ vendor: "Anthropic", noun: "account" })
  })
})

describe("timeAgo", () => {
  test("an absent timestamp reads as a dash", () => {
    expect(timeAgo(null)).toBe("—")
    expect(timeAgo(0)).toBe("—")
    expect(timeAgo(undefined)).toBe("—")
  })

  test("recent timestamps read in the coarsest unit that fits", () => {
    const now = Date.now()
    expect(timeAgo(now)).toBe("just now")
    expect(timeAgo(now - 30_000)).toBe("30s ago")
    expect(timeAgo(now - 5 * 60_000)).toBe("5m ago")
    expect(timeAgo(now - 3 * 3_600_000)).toBe("3h ago")
  })
})

describe("both pages render from this one builder", () => {
  test("the landing page carries the shared source", () => {
    expect(landingHtml).toContain("function profileFacts(p)")
  })

  test("the profiles page carries the shared source", () => {
    expect(profilePageHtml).toContain("function profileFacts(p)")
  })

  test("neither page defines a second row list of its own", () => {
    // The drift this module exists to prevent: a page that stops calling the
    // builder and starts hand-writing rows again.
    expect(landingHtml).toContain("profileFacts(entry)")
    expect(profilePageHtml).toContain("profileFacts(p)")
    expect(profilePageHtml).not.toContain("Last Verified<")
  })

  test("the shared source is emitted exactly once per page", () => {
    expect(landingHtml.split("function profileFacts(p)").length - 1).toBe(1)
    expect(profilePageHtml.split("function profileFacts(p)").length - 1).toBe(1)
  })
})
