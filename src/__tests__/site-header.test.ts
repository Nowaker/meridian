/**
 * Site header + landing page layout contract.
 *
 * The shared header (profileBar.ts) is the single site chrome injected into
 * every HTML page: logo + wordmark + nav + live status pill. The landing
 * page must not duplicate it, and its profile cards are the profile
 * switcher (no dropdown).
 */

import { describe, expect, test } from "bun:test"
import { landingHtml } from "../telemetry/landing"
import { dashboardHtml } from "../telemetry/dashboard"
import { settingsPageHtml } from "../telemetry/settingsPage"
import { profilePageHtml } from "../telemetry/profilePage"
import { pluginPageHtml } from "../proxy/plugins/pluginPage"
import { profileBarHtml, profileBarJs } from "../telemetry/profileBar"
import { DEFAULT_PROFILE_SORT, PROFILE_SORT_MODES } from "../telemetry/profileSort"
import { FADE_FROM, GENERAL_WINDOW_TYPES, SPENT_AT } from "../telemetry/profileSpent"
import { renderLoginCallbackPage } from "../telemetry/loginCallbackPage"

const allPages: Array<[string, string]> = [
  ["landing", landingHtml],
  ["dashboard", dashboardHtml],
  ["settings", settingsPageHtml],
  ["profiles", profilePageHtml],
  ["plugins", pluginPageHtml],
]

describe("shared site header", () => {
  test("header markup has brand link, logo, and nav", () => {
    expect(profileBarHtml).toContain("meridian-header")
    // Brand links home and carries the logo mark + wordmark
    expect(profileBarHtml).toContain('href="/"')
    expect(profileBarHtml).toContain("<svg")
    expect(profileBarHtml).toContain("Meridian")
    // Full site nav
    for (const href of ["/telemetry", "/profiles", "/settings", "/plugins"]) {
      expect(profileBarHtml).toContain(`href="${href}"`)
    }
  })

  test("header shows live status pill fed by /health", () => {
    expect(profileBarHtml).toContain("mhStatus")
    expect(profileBarJs).toContain("/health")
  })

  test("header shows active profile chip, not a dropdown", () => {
    expect(profileBarHtml).not.toContain("meridianProfileSelect")
    expect(profileBarHtml).not.toContain("<select")
    expect(profileBarHtml).toContain("mhProfile")
    expect(profileBarJs).toContain("/profiles/list")
  })

  test("every page embeds the shared header exactly once", () => {
    for (const [name, html] of allPages) {
      const count = html.split("meridian-header").length - 1
      expect(count, `${name} page should embed the header once`).toBeGreaterThanOrEqual(1)
    }
  })

  test("the OAuth callback page is the deliberate exception", () => {
    // /callback is reachable WITHOUT the API key — Anthropic's redirect carries
    // none — while the header polls /health and /profiles/list, which are gated.
    // Embedding it would render broken "offline" chrome on the one page a user
    // sees mid-login. This pins that exception so it is not "fixed" by hand.
    const html = renderLoginCallbackPage({ ok: true, profileId: "personal" })
    expect(html).not.toContain("meridian-header")
    expect(html).toContain("href=\"/profiles\"")
  })
})

describe("landing page layout", () => {
  test("no duplicate in-page header or big status banner", () => {
    expect(landingHtml).not.toContain("status-banner")
    expect(landingHtml).not.toContain("<h1>MERIDIAN</h1>")
  })

  test("removed sections: connect-an-agent, bottom links, model chips", () => {
    expect(landingHtml).not.toContain("Connect an Agent")
    expect(landingHtml).not.toContain('class="links"')
    expect(landingHtml).not.toContain("Models (24h)")
  })

  test("profile cards switch the active profile", () => {
    expect(landingHtml).toContain("switchProfile")
    expect(landingHtml).toContain("/profiles/active")
    expect(landingHtml).toContain("/profiles/list")
  })

  test("has a friendly how-it-works intro pointing at the endpoint", () => {
    expect(landingHtml).toContain("ANTHROPIC_BASE_URL")
  })

  test("stats strip shows meaningful telemetry, not fillers", () => {
    // Token + cache signals are in; TTFB stays on the /telemetry page
    expect(landingHtml).toContain("tokenUsage")
    expect(landingHtml).toContain("Cache Hit")
    expect(landingHtml).not.toContain("Median TTFB")
    // Envelope violations render only when noteworthy
    expect(landingHtml).toContain("envelopeViolationCount>0")
  })

  test("spent accounts recede and unusable ones are flagged instead", () => {
    // The page carries a copy of the classifier's arithmetic, so its
    // thresholds are interpolated from the tested module rather than retyped.
    expect(landingHtml).toContain(`var FADE_FROM=${FADE_FROM}`)
    expect(landingHtml).toContain(`var SPENT_AT=${SPENT_AT}`)
    expect(landingHtml).toContain(`var GENERAL_WINDOW_TYPES=${JSON.stringify(GENERAL_WINDOW_TYPES)}`)
    expect(landingHtml).toContain("--spend-fade")
    expect(landingHtml).toContain("needs login")
  })

  test("accounts can be re-sorted for viewing without touching the saved order", () => {
    // The page carries a copy of the comparator, so the modes it offers are
    // interpolated from the tested module rather than retyped.
    expect(landingHtml).toContain(`var PROFILE_SORT_MODES=${JSON.stringify(PROFILE_SORT_MODES)}`)
    expect(landingHtml).toContain(`var viewSort=${JSON.stringify(DEFAULT_PROFILE_SORT)}`)
    expect(landingHtml).toContain("sort-tab")
    // View-only: the durable pool order has one writer, and it is not here.
    expect(landingHtml).not.toContain("/settings/api/routing")
  })

  test("the fade never reaches the card itself, so the active ring survives it", () => {
    // filter and opacity apply to an element's OWN border and box-shadow, so
    // fading .profile-card greys out the accent ring on .profile-card.active -
    // the one mark saying which account is serving requests, gone exactly when
    // that account hits 95% and somebody comes looking for it. A descendant
    // cannot undo an ancestor's filter, so the fade must be scoped to the
    // card's children.
    expect(landingHtml).toContain(".profile-card.spend-fading > *, .profile-card.spend-spent > *")
    expect(landingHtml).toContain(
      ".profile-card.spend-fading:hover > *, .profile-card.spend-spent:hover > *",
    )
    // ...and never as a rule on the card itself, in either state.
    expect(landingHtml).not.toContain(".profile-card.spend-fading, .profile-card.spend-spent {")
    expect(landingHtml).not.toContain(".profile-card.spend-fading:hover, .profile-card.spend-spent:hover {")
  })

  test("account cards come from configured profiles, not synthetic cost buckets", () => {
    // With profiles configured, only pl.profiles render (no "default" card);
    // the single-account fallback labels the card with the login email.
    expect(landingHtml).toContain("configured.length>0")
    expect(landingHtml).toContain("k==='default'?(email||'account')")
  })
})

describe("design-system conformance (DESIGN.md)", () => {
  const pageSources = [
    "src/telemetry/landing.ts",
    "src/telemetry/dashboard.ts",
    "src/telemetry/settingsPage.ts",
    "src/telemetry/profilePage.ts",
    "src/telemetry/loginCallbackPage.ts",
    "src/proxy/plugins/pluginPage.ts",
  ]

  test("pages contain no hardcoded hex colors — tokens only", async () => {
    for (const path of pageSources) {
      const src = await Bun.file(path).text()
      const hexes = src.match(/#[0-9a-fA-F]{6}\b/g) ?? []
      expect(hexes, `${path} must use theme tokens, found: ${hexes.join(", ")}`).toEqual([])
    }
  })

  test("pages do not set their own body background (backsplash is shared)", async () => {
    for (const path of pageSources) {
      const src = await Bun.file(path).text()
      const bodyRule = src.match(/body \{[^}]*\}/)?.[0] ?? ""
      expect(bodyRule.includes("background"), `${path} body rule must not set background`).toBe(false)
    }
  })
})

describe("profiles page — the sign-in control is a real link", () => {
  // Someone signed into several Claude accounts needs the browser's own
  // context menu — "Open Link in Incognito Window", "Copy Link Address" — to
  // choose which session answers the sign-in. Chrome and Firefox offer that
  // for an anchor with an href and for nothing else, so these assertions are
  // the feature, not decoration.
  test("renders an anchor with an href, not a button", () => {
    expect(profilePageHtml).toContain('<a class="login-btn login-link"')
    expect(profilePageHtml).toContain("loginHrefFor(p.id)")
    expect(profilePageHtml).toContain('rel="noopener noreferrer"')
    expect(profilePageHtml).not.toContain('<button class="login-btn" onclick="startLogin')
  })

  test("nothing in the login flow opens a window from script", () => {
    // A scripted window.open is exactly what denies the context menu, and it
    // also ignores ctrl-click and middle-click. Scoped to the login section so
    // this says something precise about THIS flow rather than policing every
    // other feature on the page.
    const start = profilePageHtml.indexOf("// --- Browser login ---")
    expect(start).toBeGreaterThan(-1)
    const next = profilePageHtml.indexOf("// --- ", start + 24)
    const loginSection = next === -1 ? profilePageHtml.slice(start) : profilePageHtml.slice(start, next)
    expect(loginSection).not.toContain("window.open(")
  })

  test("the fallback to pasting a code is also a real link", () => {
    expect(profilePageHtml).toContain('onclick="switchToPaste();return true;"')
    expect(profilePageHtml).not.toContain('href="#" onclick="switchToPaste()')
  })

  test("hrefs survive a re-render and are refreshed before they expire", () => {
    expect(profilePageHtml).toContain("applyLoginHrefs()")
    expect(profilePageHtml).toContain("ensureLoginLinks(profiles)")
  })

  test("no PKCE material is ever put in a link", () => {
    expect(profilePageHtml).not.toContain("codeVerifier")
    expect(profilePageHtml).not.toContain("code_verifier")
  })
})

describe("per-page titles do not repeat the brand", () => {
  test("dashboard h1 is the page name, not the brand", () => {
    expect(dashboardHtml).not.toContain("<h1>Meridian</h1>")
    expect(dashboardHtml).toContain("<h1>Telemetry</h1>")
  })

  test("plugins page drops the redundant back-link", () => {
    expect(pluginPageHtml).not.toContain("Back to Meridian")
  })
})
