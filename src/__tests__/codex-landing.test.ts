/**
 * The ChatGPT account section of the landing page.
 *
 * The landing page ships as one self-contained template string, so these tests
 * lift the renderer out of it and run it. That is worth the small amount of
 * extraction machinery: asserting that the page *contains* a substring proves
 * nothing about what a browser would draw, and the two properties that matter
 * most here — that the section disappears entirely when there is nothing to
 * say, and that an account's email is escaped before it reaches the DOM — are
 * only observable in the output.
 */

import { describe, expect, test } from "bun:test"
import { landingHtml } from "../telemetry/landing"

/**
 * Lift a function declaration out of the page by brace matching.
 *
 * Safe for this file because none of the extracted functions contain an
 * unbalanced brace inside a string or regex literal; a future one that did
 * would fail loudly here rather than silently truncating.
 */
function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`)
  if (start === -1) throw new Error(`landingHtml declares no function ${name}`)

  let depth = 0
  for (let i = source.indexOf("{", start); i < source.length; i++) {
    if (source[i] === "{") depth++
    else if (source[i] === "}") {
      depth--
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error(`function ${name} is unterminated in landingHtml`)
}

const RENDERER_DEPS = [
  "esc",
  "utilColor",
  "resetIn",
  "codexErrorText",
  "codexErrorTone",
  "codexPoolNote",
  "codexCredits",
  "codexSection",
]

const codexSection = (() => {
  const src = RENDERER_DEPS.map((name) => extractFunction(landingHtml, name)).join("\n")
  return new Function(`${src}\nreturn codexSection;`)() as (payload: unknown) => string
})()

const HOUR = 3_600_000

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "user-ONE__aaaaaaaa-1111-4111-8111-aaaaaaa1b2c3",
    type: "codex",
    identity: "someone@example.com, id:a1b2c3",
    email: "someone@example.com",
    plan: { slug: "pro", label: "ChatGPT Pro", multiplier: "20x" },
    // Deliberately not a whole number of days away: the countdown rounds up to
    // the minute, so an exact 6d offset sits on a boundary that a slow test run
    // could tip either side of.
    windows: [
      { type: "7d", utilization: 0.05, resetsAt: Date.now() + 6 * 24 * HOUR + HOUR, limitWindowSeconds: 604800 },
    ],
    resetCredits: null,
    fetchedAt: Date.now(),
    stale: false,
    error: null,
    ...overrides,
  }
}

describe("codex section visibility", () => {
  test("renders nothing when the endpoint could not be reached", () => {
    expect(codexSection(null)).toBe("")
  })

  test("renders nothing when the operator turned the integration off", () => {
    expect(codexSection({ entries: [], error: "disabled", asOf: Date.now() })).toBe("")
  })

  test("renders nothing when oc-codex is simply not installed", () => {
    // The silent case the whole error taxonomy exists to protect: a Meridian
    // user who has never heard of oc-codex must see no trace of this feature.
    expect(codexSection({ entries: [], error: "not_configured", asOf: Date.now() })).toBe("")
  })

  test("renders nothing when the pool holds no accounts", () => {
    expect(codexSection({ entries: [], error: null, asOf: Date.now() })).toBe("")
  })

  test("says so calmly when the pool is present but unusable", () => {
    for (const error of ["pool_unreadable", "invalid_pool"]) {
      const html = codexSection({ entries: [], error, asOf: Date.now() })
      expect(html).toContain("ChatGPT Accounts")
      expect(html).toContain("oc-codex")
      // An empty state is never an alarm.
      expect(html).not.toContain("var(--red)")
    }
  })
})

describe("codex account cards", () => {
  test("shows identity, plan, consumption and remaining allowance", () => {
    const html = codexSection({ entries: [entry()], error: null, asOf: Date.now() })

    expect(html).toContain("ChatGPT Accounts")
    expect(html).toContain("someone@example.com, id:a1b2c3")
    expect(html).toContain("ChatGPT Pro")
    expect(html).toContain("20x")
    // 5% consumed of the weekly window, so 95% of the allowance is left.
    expect(html).toContain(">5%<")
    expect(html).toContain(">95%<")
    expect(html).toContain("7d")
    expect(html).toContain("in 6d")
  })

  test("keeps the free tier's 30-day window labelled as thirty days", () => {
    // The reference implementation calls anything past six days "Weekly",
    // which understates this allowance by more than fourfold.
    const html = codexSection({
      entries: [entry({
        plan: { slug: "free", label: "ChatGPT Free", multiplier: null },
        windows: [{ type: "30d", utilization: 1, resetsAt: Date.now() + 24 * HOUR, limitWindowSeconds: 2592000 }],
      })],
      error: null,
      asOf: Date.now(),
    })
    expect(html).toContain("30d")
    expect(html).not.toContain("Weekly")
    expect(html).toContain(">0%<")
  })

  test("colours consumption by how much is gone", () => {
    const low = codexSection({ entries: [entry({ windows: [{ type: "7d", utilization: 0.1, resetsAt: null, limitWindowSeconds: 604800 }] })], error: null, asOf: 0 })
    const high = codexSection({ entries: [entry({ windows: [{ type: "7d", utilization: 0.95, resetsAt: null, limitWindowSeconds: 604800 }] })], error: null, asOf: 0 })
    expect(low).toContain("var(--green)")
    expect(high).toContain("var(--red)")
  })

  test("renders both windows when an account still has a 5h limit", () => {
    // team accounts keep the older 5h-primary/weekly-secondary shape while pro
    // reports the weekly limit alone, so both must render from their widths.
    const html = codexSection({
      entries: [entry({
        windows: [
          { type: "5h", utilization: 0, resetsAt: Date.now() + HOUR, limitWindowSeconds: 18000 },
          { type: "7d", utilization: 1, resetsAt: Date.now() + 30 * HOUR, limitWindowSeconds: 604800 },
        ],
      })],
      error: null,
      asOf: Date.now(),
    })
    expect(html).toContain("5h")
    expect(html).toContain("7d")
    // The headline is the widest window — the subscription allowance, not the
    // burst limit inside it.
    expect(html).toContain("of 7d allowance left")
  })

  test("lists redeemable rate-limit resets and the earliest expiry", () => {
    const html = codexSection({
      entries: [entry({
        resetCredits: {
          availableCount: 2,
          applicableAvailableCount: 2,
          credits: [
            { status: "available", expiresAt: Date.now() + 28 * 24 * HOUR + HOUR },
            { status: "available", expiresAt: Date.now() + 29 * 24 * HOUR },
          ],
          error: null,
        },
      })],
      error: null,
      asOf: Date.now(),
    })
    expect(html).toContain("2 usage resets available")
    expect(html).toContain("redeemable now")
    expect(html).toContain("earliest expires in 28d")
  })

  test("holds a credit count without an expiry list", () => {
    const html = codexSection({
      entries: [entry({
        resetCredits: { availableCount: 1, applicableAvailableCount: 0, credits: null, error: "upstream_error" },
      })],
      error: null,
      asOf: Date.now(),
    })
    expect(html).toContain("1 usage reset available")
    expect(html).not.toContain("redeemable now")
    expect(html).not.toContain("earliest expires")
  })
})

describe("codex card failure states", () => {
  test("an expired token is reported as routine, not as a fault", () => {
    const html = codexSection({
      entries: [entry({ windows: [], plan: null, error: "token_expired", fetchedAt: null })],
      error: null,
      asOf: Date.now(),
    })
    expect(html).toContain("token expired")
    expect(html).toContain("oc-codex")
    expect(html).not.toContain("var(--red)")
  })

  test("a refusal and an identity mismatch are drawn as real problems", () => {
    for (const error of ["unauthorized", "identity_mismatch"]) {
      const html = codexSection({ entries: [entry({ windows: [], error })], error: null, asOf: Date.now() })
      expect(html).toContain("codex-note bad")
    }
  })

  test("one failing account leaves the others rendered", () => {
    const html = codexSection({
      entries: [
        entry({ identity: "good@example.com, id:aaaaaa" }),
        entry({ identity: "bad@example.com, id:bbbbbb", windows: [], error: "unauthorized" }),
      ],
      error: null,
      asOf: Date.now(),
    })
    expect(html).toContain("good@example.com, id:aaaaaa")
    expect(html).toContain("bad@example.com, id:bbbbbb")
    expect(html).toContain(">95%<")
    expect((html.match(/profile-card/g) ?? []).length).toBe(2)
  })

  test("names an unknown error rather than rendering a blank card", () => {
    const html = codexSection({ entries: [entry({ windows: [], error: "some_future_error" })], error: null, asOf: Date.now() })
    expect(html).toContain("some future error")
  })
})

describe("codex card escaping", () => {
  test("escapes the account identity", () => {
    const html = codexSection({
      entries: [entry({ identity: '<img src=x onerror="alert(1)">' })],
      error: null,
      asOf: Date.now(),
    })
    expect(html).not.toContain("<img")
    expect(html).toContain("&lt;img")
  })

  test("escapes a plan label the vendor invented", () => {
    const html = codexSection({
      entries: [entry({ plan: { slug: "x", label: "<b>Pwn</b>", multiplier: null } })],
      error: null,
      asOf: Date.now(),
    })
    expect(html).not.toContain("<b>Pwn</b>")
    expect(html).toContain("&lt;b&gt;")
  })
})

describe("landing page wiring", () => {
  test("fetches the codex endpoint alongside the other dashboard reads", () => {
    expect(landingHtml).toContain("/v1/usage/codex")
  })

  test("renders the codex section as part of the page", () => {
    expect(landingHtml).toContain("codexSection(")
  })

  test("styles the new elements from theme tokens only", () => {
    for (const rule of [".codex-note", ".codex-credits"]) {
      expect(landingHtml).toContain(rule)
    }
    // Scoped to the block this feature added. Widening it to the whole style
    // element would assert against the shared header's CSS, which carries hex
    // literals of its own and is not this feature's to police.
    const css = landingHtml.slice(landingHtml.indexOf(".codex-note"), landingHtml.indexOf("/* Traffic strip"))
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })
})
