/**
 * Provider groups, chips and brand colours on / and /profiles.
 *
 * profileProviders.ts ships browser source, so the module tests evaluate that
 * exact text, as profile-facts.test.ts does. The page tests run each page's
 * own inline script against a stub document and call its render functions,
 * so what is asserted about a card is the markup the browser receives.
 */
import { describe, expect, test } from "bun:test"
import { createContext, runInContext } from "node:vm"
import { landingHtml } from "../telemetry/landing"
import { themeCss } from "../telemetry/profileBar"
import { profilePageHtml } from "../telemetry/profilePage"
import {
  HIDDEN_PROVIDERS_KEY,
  PROFILE_PROVIDERS,
  PROVIDERS_NONE_SHOWN_HTML,
  profileProvidersCss,
  profileProvidersJs,
} from "../telemetry/profileProviders"
import {
  HIDDEN_LOGIN_STATES_KEY,
  LOGIN_STATES,
  LOGIN_STATES_NONE_SHOWN_HTML,
  profileLoginStatesJs,
} from "../telemetry/profileLoginStates"
import { isUnusableJs } from "../telemetry/profileSpent"

interface Group { provider: string; items: unknown[] }
interface Slot { item: unknown; provider: string; place: number; size: number }
interface Providers {
  providerOf(p: unknown): string
  group(items: unknown[], keyOf: (item: never) => string): Group[]
  slots(groups: Group[]): Slot[]
  readHidden(storage: unknown): string[]
  visibleIn(id: string, present: string[], hidden: string[]): boolean
  isHidden(id: string): boolean
  visible(id: string, present: string[]): boolean
  setHidden(id: string, hide: boolean): void
  showAll(): void
  anyShown(present: string[]): boolean
  chipsHtml(groups: Group[]): string
  headingHtml(group: Group, hidden: boolean): string
  badgeHtml(id: string, extraClass?: string): string
  syncChips(root: unknown): void
  onClick(target: unknown): string | null
}

class MemoryStorage {
  readonly data = new Map<string, string>()
  getItem(key: string): string | null { return this.data.has(key) ? this.data.get(key)! : null }
  setItem(key: string, value: string): void { this.data.set(key, String(value)) }
  removeItem(key: string): void { this.data.delete(key) }
}

function loadProviders(storage?: unknown): Providers {
  return new Function("localStorage", profileProvidersJs + "\nreturn meridianProviders;")(storage) as Providers
}

const claude = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: "claude-max", loggedIn: true, ...extra })
const seat = (id: string, extra: Record<string, unknown> = {}) => ({ id, provider: "chatgpt", type: "chatgpt", seat: `seat-${id}`, loggedIn: true, ...extra })
/** The saved order interleaves the providers on purpose: the pages must group it anyway. */
const mixed = () => [seat("g1"), claude("c1", { isActive: true }), seat("g2", { isActive: true }), claude("c2")]

describe("which provider an account belongs to", () => {
  const p = loadProviders()

  test("a seat says chatgpt; a Claude account says nothing and is Claude", () => {
    expect(p.providerOf({ provider: "chatgpt" })).toBe("chatgpt")
    expect(p.providerOf({ type: "chatgpt" })).toBe("chatgpt")
    expect(p.providerOf({ type: "claude-max" })).toBe("claude")
    expect(p.providerOf({ type: "api" })).toBe("claude")
    expect(p.providerOf({})).toBe("claude")
    expect(p.providerOf(null)).toBe("claude")
  })

  test("a provider id no entry claims is not a provider", () => {
    expect(p.providerOf({ provider: "constructor" })).toBe("claude")
    expect(p.providerOf({ provider: "toString" })).toBe("claude")
  })
})

describe("grouping", () => {
  const p = loadProviders()
  const ids = (groups: Group[]) => JSON.parse(JSON.stringify(groups.map(g => [g.provider, g.items.map(i => (i as { id: string }).id)])))

  test("groups come in registry order, each keeping its items' order", () => {
    expect(ids(p.group(mixed(), p.providerOf))).toEqual([["claude", ["c1", "c2"]], ["chatgpt", ["g1", "g2"]]])
  })

  test("a provider with no accounts has no group", () => {
    expect(ids(p.group([seat("a"), seat("b")], p.providerOf))).toEqual([["chatgpt", ["a", "b"]]])
  })

  test("a key no provider claims keeps its cards, after the known groups", () => {
    const items = [{ id: "x", k: "elsewhere" }, { id: "y", k: "chatgpt" }, { id: "z", k: "claude" }]
    expect(ids(p.group(items, (i: { k: string }) => i.k))).toEqual([["claude", ["z"]], ["chatgpt", ["y"]], ["elsewhere", ["x"]]])
  })

  test("slots flatten the groups in drawing order, with each card's place in its own group", () => {
    const slots = p.slots(p.group(mixed(), p.providerOf)).map(s => [(s.item as { id: string }).id, s.provider, s.place, s.size])
    expect(JSON.parse(JSON.stringify(slots))).toEqual([
      ["c1", "claude", 0, 2], ["c2", "claude", 1, 2], ["g1", "chatgpt", 0, 2], ["g2", "chatgpt", 1, 2],
    ])
  })
})

describe("the chip choice is remembered", () => {
  test("hiding a provider persists it, and the next page load reads it back", () => {
    const storage = new MemoryStorage()
    const first = loadProviders(storage)
    expect(first.isHidden("chatgpt")).toBe(false)
    first.setHidden("chatgpt", true)
    expect(storage.getItem(HIDDEN_PROVIDERS_KEY)).toBe('["chatgpt"]')
    const reloaded = loadProviders(storage)
    expect(reloaded.isHidden("chatgpt")).toBe(true)
    expect(reloaded.isHidden("claude")).toBe(false)
    reloaded.showAll()
    expect(storage.getItem(HIDDEN_PROVIDERS_KEY)).toBe("[]")
    expect(loadProviders(storage).isHidden("chatgpt")).toBe(false)
  })

  test("garbage, unknown ids and duplicates in storage hide nothing they should not", () => {
    const p = loadProviders()
    const stored = (raw: string | null) => JSON.parse(JSON.stringify(p.readHidden({ getItem: () => raw })))
    expect(stored(null)).toEqual([])
    expect(stored("{not json")).toEqual([])
    expect(stored('{"chatgpt":true}')).toEqual([])
    expect(stored('["chatgpt","chatgpt","antigravity",7,"constructor"]')).toEqual(["chatgpt"])
    expect(JSON.parse(JSON.stringify(p.readHidden({ getItem: () => { throw new Error("blocked") } })))).toEqual([])
  })

  test("blocked storage still toggles for the page in hand", () => {
    const blocked = { getItem: () => { throw new Error("blocked") }, setItem: () => { throw new Error("blocked") } }
    const p = loadProviders(blocked)
    p.setHidden("claude", true)
    expect(p.isHidden("claude")).toBe(true)
  })
})

describe("chips", () => {
  test("a lone provider gets no chips and cannot be hidden", () => {
    const storage = new MemoryStorage()
    storage.setItem(HIDDEN_PROVIDERS_KEY, '["chatgpt"]')
    const p = loadProviders(storage)
    const groups = p.group([seat("a"), seat("b")], p.providerOf)
    expect(p.chipsHtml(groups)).toBe("")
    expect(p.visible("chatgpt", ["chatgpt"])).toBe(true)
    expect(p.anyShown(["chatgpt"])).toBe(true)
  })

  test("one chip per provider with accounts, pressed while shown, with its count", () => {
    const storage = new MemoryStorage()
    storage.setItem(HIDDEN_PROVIDERS_KEY, '["chatgpt"]')
    const p = loadProviders(storage)
    const html = p.chipsHtml(p.group([...mixed(), seat("g3")], p.providerOf))
    const chips = [...html.matchAll(/data-provider-chip="([^"]+)" aria-pressed="(true|false)"/g)].map(m => [m[1], m[2]])
    expect(chips).toEqual([["claude", "true"], ["chatgpt", "false"]])
    expect(html).toContain('class="provider-chip provider-chatgpt"')
    expect(html).toContain('<span class="provider-chip-count">3</span>')
    expect(html).toContain('title="Show ChatGPT seats"')
    expect(html).toContain('title="Hide Claude accounts"')
  })

  test("with every chip off nothing is shown, and Show all brings everything back", () => {
    const storage = new MemoryStorage()
    const p = loadProviders(storage)
    const present = ["claude", "chatgpt"]
    p.setHidden("claude", true)
    expect(p.visible("claude", present)).toBe(false)
    expect(p.visible("chatgpt", present)).toBe(true)
    p.setHidden("chatgpt", true)
    expect(p.anyShown(present)).toBe(false)
    const showAll = { closest: () => ({ getAttribute: () => "*" }) }
    expect(p.onClick(showAll)).toBe("*")
    expect(p.anyShown(present)).toBe(true)
    expect(storage.getItem(HIDDEN_PROVIDERS_KEY)).toBe("[]")
    expect(PROVIDERS_NONE_SHOWN_HTML).toContain('data-provider-chip="*"')
  })

  test("a click on a chip toggles its provider; a click elsewhere is not a chip click", () => {
    const p = loadProviders(new MemoryStorage())
    const chip = { closest: () => ({ getAttribute: () => "chatgpt" }) }
    expect(p.onClick(chip)).toBe("chatgpt")
    expect(p.isHidden("chatgpt")).toBe(true)
    expect(p.onClick(chip)).toBe("chatgpt")
    expect(p.isHidden("chatgpt")).toBe(false)
    expect(p.onClick({ closest: () => null })).toBeNull()
  })

  test("syncChips updates the chips in place", () => {
    const p = loadProviders(new MemoryStorage())
    const attrs: Record<string, Record<string, string>> = { claude: {}, chatgpt: {} }
    const chip = (id: string) => ({
      getAttribute: (k: string) => (k === "data-provider-chip" ? id : null),
      setAttribute: (k: string, v: string) => { attrs[id]![k] = v },
    })
    const root = { querySelectorAll: () => [chip("claude"), chip("chatgpt")] }
    p.setHidden("claude", true)
    p.syncChips(root)
    expect(attrs.claude).toEqual({ "aria-pressed": "false", title: "Show Claude accounts" })
    expect(attrs.chatgpt).toEqual({ "aria-pressed": "true", title: "Hide ChatGPT seats" })
  })
})

describe("brand colours", () => {
  const token = (name: string) => themeCss.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1]?.trim()
  const rgbOf = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))

  test("Claude is #c15f3c and ChatGPT #74aa9c, the latter clear of the violet --accent2", () => {
    expect(token("claude")).toBe("#c15f3c")
    expect(token("chatgpt")).toBe("#74aa9c")
    expect(token("accent2")).toBe("#bc8cff")
  })

  test("every provider has its three tokens, and -rgb and -bright derive from the brand", () => {
    for (const { id } of PROFILE_PROVIDERS) {
      const brand = token(id)
      expect(brand, `--${id}`).toMatch(/^#[0-9a-f]{6}$/)
      expect(token(`${id}-rgb`), `--${id}-rgb`).toBe(rgbOf(brand!).join(","))
      // 30% toward white, each channel rounded either way.
      const bright = rgbOf(token(`${id}-bright`)!)
      rgbOf(brand!).forEach((c, i) => expect(Math.abs(bright[i]! - (c + (255 - c) * 0.3)), `--${id}-bright channel ${i}`).toBeLessThanOrEqual(0.5))
    }
  })

  test("a card's provider class points --brand at that provider's tokens", () => {
    for (const { id } of PROFILE_PROVIDERS) {
      expect(profileProvidersCss).toContain(
        `.provider-${id} { --brand: var(--${id}); --brand-bright: var(--${id}-bright); --brand-rgb: var(--${id}-rgb); }`,
      )
    }
  })

  for (const [name, html] of [["landing", landingHtml], ["profiles", profilePageHtml]] as const) {
    test(`${name}: the active card's border and ring are its provider's brand`, () => {
      const rule = html.slice(html.indexOf("  .profile-card.active {"), html.indexOf("}", html.indexOf("  .profile-card.active {")))
      expect(rule).toContain("border-color: var(--brand, var(--accent))")
      expect(rule).toContain("box-shadow: 0 0 0 1px var(--brand, var(--accent))")
    })

    test(`${name}: embeds the provider module and its CSS exactly once`, () => {
      expect(html.split("var meridianProviders = (function () {").length - 1).toBe(1)
      expect(html.split(".provider-chips { display: flex;").length - 1).toBe(1)
    })
  }

  test("landing: hovering a switchable card lights it in the brighter brand", () => {
    expect(landingHtml).toContain(".profile-card.switchable:hover { border-color: var(--brand-bright, var(--accent));")
  })

  test("landing: the activation strip is a 12px band of the card's brand, inked to read on every brand", () => {
    const css = landingHtml.slice(0, landingHtml.indexOf("</style>"))
    const rule = (selector: string) => css.slice(css.indexOf(`  ${selector} {`), css.indexOf("}", css.indexOf(`  ${selector} {`)))
    const strip = rule(".card-strip")
    for (const decl of ["position: absolute;", "top: 0; left: 0; right: 0;", "height: 12px;", "background: var(--brand, var(--accent));",
      "color: var(--on-brand);", "font-size: 9px;", "text-transform: uppercase;", "text-align: center;"]) expect(strip).toContain(decl)
    const hint = rule(".card-strip.strip-hint")
    expect(hint).toContain("background: var(--brand-bright, var(--accent));")
    expect(hint).toContain("clip-path: inset(0 0 100% 0);")
    expect(css).toContain(".profile-card.switchable:hover > .strip-hint, .profile-card.switchable:focus-visible > .strip-hint { clip-path: inset(0); }")
    // The fade dims a card's children; the active strip is spared with the name row.
    expect(css).toContain(".profile-card.active.spend-fading > .card-strip, .profile-card.active.spend-spent > .card-strip { filter: none; opacity: 1; }")
    expect(css).not.toContain(".switch-hint")
    expect(themeCss).toContain("--on-brand:       #000000;")
  })

  test("landing: the strip's ink clears WCAG AA on each brand and its hover tint", () => {
    const hex = (name: string) => themeCss.match(new RegExp(`--${name}:\\s+(#[0-9a-f]{6});`))![1]!
    const luminance = (h: string) => {
      const [r, g, b] = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255)
        .map(v => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
    }
    const contrast = (a: string, b: string) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
      return (hi! + 0.05) / (lo! + 0.05)
    }
    for (const p of PROFILE_PROVIDERS) {
      expect(contrast(hex(p.id), hex("on-brand"))).toBeGreaterThanOrEqual(4.5)
      expect(contrast(hex(`${p.id}-bright`), hex("on-brand"))).toBeGreaterThanOrEqual(4.5)
    }
  })

  test("landing: on a phone, a card that can show a strip has room for it above its name row", () => {
    expect(landingHtml).toContain("  @media (max-width: 720px) {\n    .profile-card.active, .profile-card.switchable { padding-top: 18px; }\n  }")
  })

  test("landing: a needs-login border is solid red, and an active card keeps its brand ring outside it", () => {
    // Beside the Claude brand the red differs in hue alone, which a protanope
    // cannot see; the active card's ring, which this rule leaves alone, is what
    // still says which account is active.
    const css = landingHtml.slice(0, landingHtml.indexOf("</style>"))
    expect(css).toContain(".profile-card.needs-login { border-color: var(--red); }")
    expect(css).not.toContain(".profile-card.active.needs-login")
    expect(css).not.toContain("dashed")
    // Declared after the active rule, so red wins the border and the ring stays.
    expect(css.indexOf(".profile-card.needs-login {")).toBeGreaterThan(css.indexOf(".profile-card.active {"))
  })

  test("landing: a spent active card dims its figures, never its name row", () => {
    // The spent badge lives in that row, and with the Active strip it is what
    // says which account is serving and why the rest of the card is dimmed.
    const spare = ".profile-card.active.spend-fading > .profile-head, .profile-card.active.spend-spent > .profile-head { filter: none; opacity: 1; }"
    expect(landingHtml).toContain(spare)
    expect(landingHtml.indexOf(spare)).toBeGreaterThan(landingHtml.indexOf(".profile-card.spend-fading > *, .profile-card.spend-spent > * {"))
  })

  test("profiles: under the wide layout a provider heading spans the card grid and leaves spacing to its gap", () => {
    expect(profileProvidersCss).toContain("grid-column: 1 / -1;")
    expect(profilePageHtml).toContain('html[data-layout="wide"] #content > .provider-group-head { margin-bottom: 0; }')
  })

  test("profiles: the switch button is in the brand of the account it switches to", () => {
    expect(profilePageHtml).toContain(".switch-btn.switch-to { color: var(--brand-bright, var(--accent)); border-color: var(--brand, var(--accent)); }")
  })
})

// ---------------------------------------------------------------------------
// The pages themselves, run against a stub document.
// ---------------------------------------------------------------------------

type Stub = Record<string, unknown> & { innerHTML: string; hidden: boolean; attrs: Map<string, string> }

function stubElement(): Stub {
  const attrs = new Map<string, string>()
  let text = ""
  const el = {
    attrs, hidden: false, value: "", innerHTML: "", style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {},
    setAttribute: (k: string, v: string) => { attrs.set(k, String(v)) },
    getAttribute: (k: string) => (attrs.has(k) ? attrs.get(k)! : null),
    removeAttribute: (k: string) => { attrs.delete(k) },
    querySelector: () => null, querySelectorAll: () => [],
    replaceChildren() {}, appendChild() {}, focus() {}, closest: () => null,
    getBoundingClientRect: () => ({ top: 0, height: 0 }),
  }
  Object.defineProperty(el, "textContent", { get: () => text, set: (v: unknown) => { text = String(v) } })
  return el as unknown as Stub
}

interface Page {
  run<T>(expression: string): T
  element(id: string): Stub
  select(selector: string, elements: unknown[]): void
}

function loadPage(html: string, storage: MemoryStorage): Page {
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1] ?? "").join("\n")
  const elements = new Map<string, Stub>()
  const selections = new Map<string, unknown[]>()
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, stubElement())
    return elements.get(id)!
  }
  const document = {
    getElementById: element,
    querySelector: (s: string) => selections.get(s)?.[0] ?? null,
    querySelectorAll: (s: string) => selections.get(s) ?? [],
    addEventListener() {},
    activeElement: null,
    // What esc() relies on: textContent in, escaped markup out.
    createElement: () => {
      let text = ""
      return {
        set textContent(v: unknown) { text = String(v) },
        get textContent() { return text },
        get innerHTML() { return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") },
      }
    },
  }
  const sandbox: Record<string, unknown> = {
    document, localStorage: storage, URL, AbortController, console,
    location: { pathname: "/", hash: "", href: "http://127.0.0.1:3459/", origin: "http://127.0.0.1:3459", port: "3459", hostname: "127.0.0.1", host: "127.0.0.1:3459" },
    history: { state: null, replaceState() {} },
    navigator: { clipboard: { writeText() {} } },
    fetch: () => new Promise(() => {}),
    setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
    requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    MutationObserver: class { observe() {} disconnect() {} },
    addEventListener() {}, alert() {}, innerHeight: 800, scrollY: 0, scrollTo() {},
  }
  sandbox.window = sandbox
  // One context for the page's life: Bun's runInNewContext makes a new one
  // per call, and a later call would not see what the page's functions see.
  const context = createContext(sandbox)
  runInContext(script, context)
  return {
    run: <T>(expression: string) => runInContext(expression, context) as T,
    element,
    select: (selector, list) => { selections.set(selector, list) },
  }
}

/** Opening tags of the cards, in drawing order: their classes and attributes. */
function cardsOf(html: string) {
  return [...html.matchAll(/<div class="profile-card ([^"]*)"([^>]*)>/g)].map(m => {
    const attr = (name: string) => m[2]!.match(new RegExp(` ${name}="([^"]*)"`))?.[1] ?? null
    return { classes: m[1]!.split(" "), id: attr("data-id"), group: attr("data-group"), index: attr("data-index"), loginState: attr("data-login-state"), hidden: / hidden(\s|$)/.test(m[2]!) }
  })
}

const headingsOf = (html: string) => [...html.matchAll(/<div class="provider-group-head provider-(\w+)" data-group="\w+" role="heading" aria-level="3"( hidden)?>/g)].map(m => [m[1], !!m[2]])
const orderIndexes = (html: string) => [...html.matchAll(/<span class="order-index">(\d+)<\/span>/g)].map(m => Number(m[1]))

describe("the landing page draws one grid, grouped by provider", () => {
  const section = (storage: MemoryStorage, profiles: unknown[]) =>
    loadPage(landingHtml, storage).run<{ html: string }>(
      `profileSection(null, {}, ${JSON.stringify({ profiles, routing: "active" })}, { auth: { loggedIn: true } })`,
    ).html

  test("Claude first, then ChatGPT, each under its heading, in the saved order", () => {
    const html = section(new MemoryStorage(), mixed())
    expect(cardsOf(html).map(c => [c.id, c.group])).toEqual([["c1", "claude"], ["c2", "claude"], ["g1", "chatgpt"], ["g2", "chatgpt"]])
    expect(headingsOf(html)).toEqual([["claude", false], ["chatgpt", false]])
    expect(html.indexOf('data-group="chatgpt" role="heading"')).toBeLessThan(html.indexOf('data-id="g1"'))
    expect(html.indexOf('data-id="c2"')).toBeLessThan(html.indexOf('data-group="chatgpt" role="heading"'))
  })

  test("one active card per provider, each carrying its provider's class, stripe and badge", () => {
    const cards = cardsOf(section(new MemoryStorage(), mixed()))
    expect(cards.filter(c => c.classes.includes("active")).map(c => [c.id, c.classes[0]])).toEqual([["c1", "provider-claude"], ["g2", "provider-chatgpt"]])
    for (const c of cards) expect(c.classes[0]).toBe(`provider-${c.group}`)
    const html = section(new MemoryStorage(), mixed())
    expect(html).toContain('<span class="provider-pill provider-badge">Claude</span>')
    expect(html).toContain('<span class="provider-pill provider-badge">ChatGPT</span>')
  })

  test("handles number each provider from 1, while indexes run across the page", () => {
    const html = section(new MemoryStorage(), mixed())
    expect(orderIndexes(html)).toEqual([1, 2, 1, 2])
    expect(cardsOf(html).map(c => c.index)).toEqual(["0", "1", "2", "3"])
    expect(html).toContain("a card moves only among its provider")
  })

  test("chips show both providers, and a hidden one's cards stay in the page, hidden", () => {
    const storage = new MemoryStorage()
    storage.setItem(HIDDEN_PROVIDERS_KEY, '["chatgpt"]')
    const html = section(storage, mixed())
    expect(html).toContain('data-provider-chip="claude" aria-pressed="true"')
    expect(html).toContain('data-provider-chip="chatgpt" aria-pressed="false"')
    expect(cardsOf(html).map(c => [c.id, c.hidden])).toEqual([["c1", false], ["c2", false], ["g1", true], ["g2", true]])
    expect(headingsOf(html)).toEqual([["claude", false], ["chatgpt", true]])
    expect(html).toContain('<div class="provider-none" hidden>')
  })

  test("with every provider hidden, the page says so and offers Show all", () => {
    const storage = new MemoryStorage()
    storage.setItem(HIDDEN_PROVIDERS_KEY, '["claude","chatgpt"]')
    const html = section(storage, mixed())
    expect(html).toContain(`<div class="provider-none">${PROVIDERS_NONE_SHOWN_HTML}</div>`)
  })

  test("a ChatGPT-only instance: no chips or headings, the brand still on every card", () => {
    const storage = new MemoryStorage()
    storage.setItem(HIDDEN_PROVIDERS_KEY, '["chatgpt"]')
    const html = section(storage, [seat("a"), seat("b", { isActive: true }), seat("c")])
    expect(html).not.toContain("data-provider-chip")
    expect(headingsOf(html)).toEqual([])
    expect(cardsOf(html).map(c => [c.id, c.classes.includes("provider-chatgpt"), c.classes.includes("active"), c.hidden]))
      .toEqual([["a", true, false, false], ["b", true, true, false], ["c", true, false, false]])
  })

  test("a provider's only card gets no handle", () => {
    const html = section(new MemoryStorage(), [claude("c1", { isActive: true }), seat("g1"), seat("g2", { isActive: true })])
    expect(orderIndexes(html)).toEqual([1, 2])
    expect(html.indexOf('class="drag-handle"')).toBeGreaterThan(html.indexOf('data-id="g1"'))
  })
})

describe("the landing page marks activation with a strip across a card's top", () => {
  const render = (q: unknown, pl: unknown) =>
    loadPage(landingHtml, new MemoryStorage()).run<{ html: string }>(
      `profileSection(${JSON.stringify(q)}, {}, ${JSON.stringify(pl)}, { auth: { loggedIn: true } })`,
    ).html
  /** Each card's id and the strip drawn as its first child, if any. */
  const strips = (html: string) =>
    [...html.matchAll(/<div class="profile-card [^"]*"[^>]* data-id="(\w+)"[^>]*>(?:<div class="(card-strip[^"]*)">([^<]*)<\/div>)?/g)]
      .map(m => [m[1], m[2] ?? null, m[3] ?? null])

  test("the active card of each provider says Active; every switchable one offers Click to activate", () => {
    const html = render(null, { profiles: mixed(), routing: "active" })
    expect(strips(html)).toEqual([
      ["c1", "card-strip", "Active"],
      ["c2", "card-strip strip-hint", "Click to activate"],
      ["g1", "card-strip strip-hint", "Click to activate"],
      ["g2", "card-strip", "Active"],
    ])
    expect(html).not.toContain("switch-hint")
  })

  test("the strip is the active card's only Active label: no pill repeats it in the name row", () => {
    const html = render(null, { profiles: mixed(), routing: "active" })
    expect(html.split('<div class="card-strip">Active</div>').length - 1).toBe(2)
    expect(html).not.toContain("active-pill")
    expect(landingHtml.slice(0, landingHtml.indexOf("</style>"))).not.toContain(".active-pill")
  })

  test("name row badges sit one container gap apart, with no margin of their own to stack on it", () => {
    // The row's gap alone spaces the name from the first badge and each badge
    // from the next; a badge margin would add to it between badges only.
    const rules = (html: string, selector: string) => {
      const css = html.slice(0, html.indexOf("</style>")) + profileProvidersCss
      return [...css.matchAll(new RegExp(`(?:^|[\\s,}])${selector.replace(/[.-]/g, "\\$&")}(?:[\\s,][^{]*)?\\{([^}]*)\\}`, "g"))].map(m => m[1]!)
    }
    const nameRow = rules(landingHtml, ".profile-name").join("")
    expect(nameRow).toContain("display: flex;")
    expect(nameRow).toContain("gap: 8px;")
    for (const badge of [".provider-pill", ".provider-badge", ".plan-chip", ".pool-chip", ".spend-pill"]) {
      expect(rules(landingHtml, badge).length).toBeGreaterThan(0)
      for (const body of rules(landingHtml, badge)) expect(body).not.toMatch(/margin/)
    }
    expect(rules(profilePageHtml, ".profile-card-header").join("")).toContain("gap: 8px 12px;")
    for (const body of rules(profilePageHtml, ".profile-badge")) expect(body).not.toMatch(/margin/)
  })

  test("pure priority routing gives a Claude card no strip, while a seat keeps its own", () => {
    const html = render(null, { profiles: mixed(), routing: "priority", profileOrder: ["c1", "c2", "g1", "g2"] })
    expect(strips(html)).toEqual([
      ["c1", null, null],
      ["c2", null, null],
      ["g1", "card-strip strip-hint", "Click to activate"],
      ["g2", "card-strip", "Active"],
    ])
  })

  test("an active card that needs a login keeps its strip beside the needs-login flag", () => {
    const html = render(null, { profiles: [claude("c1", { isActive: true, loggedIn: false }), claude("c2")], routing: "active" })
    expect(strips(html)[0]).toEqual(["c1", "card-strip", "Active"])
    expect(html).toMatch(/<div class="profile-card provider-claude active needs-login"/)
  })

  test("a seat's credits pace takes the row's full width, with no label", () => {
    const quota = {
      id: "g1",
      credits: { hasCredits: true, unlimited: false, overageLimitReached: false, balance: 62500 },
      creditsPolicy: "reserve",
      creditsBurn: { status: "burning", creditsPerHour: 40000, windowMinutes: 60, turns: 12, mix: [{ model: "gpt-6-sol", share: 1 }], approximate: [] },
    }
    const html = render({ profiles: [quota] }, { profiles: mixed(), routing: "active" })
    expect(html).toContain('"><span class="w-credits-note credits-pace">after all seats\u2019 plan limits; lasts ~1h34m at current pace</span></div>')
    expect(html).not.toContain('<span class="w-label">lasts</span>')
  })
})

describe("the profiles page draws the same groups", () => {
  const rendered = (storage: MemoryStorage, profiles: unknown[]) => {
    const page = loadPage(profilePageHtml, storage)
    page.run(`lastProfiles = ${JSON.stringify({ profiles })}; render(lastProfiles, null)`)
    return { page, html: page.element("content").innerHTML, chips: page.element("profiles-provider-chips").innerHTML }
  }

  test("grouped cards, one active per provider, chips beside the search", () => {
    const { html, chips } = rendered(new MemoryStorage(), mixed())
    const cards = cardsOf(html)
    expect(cards.map(c => [c.id, c.group, c.index])).toEqual([["c1", "claude", "0"], ["c2", "claude", "1"], ["g1", "chatgpt", "2"], ["g2", "chatgpt", "3"]])
    expect(cards.filter(c => c.classes.includes("active")).map(c => [c.id, c.classes[0]])).toEqual([["c1", "provider-claude"], ["g2", "provider-chatgpt"]])
    expect(headingsOf(html)).toEqual([["claude", false], ["chatgpt", false]])
    expect(orderIndexes(html)).toEqual([1, 2, 1, 2])
    expect(chips).toContain('data-provider-chip="claude" aria-pressed="true"')
    expect(chips).toContain('data-provider-chip="chatgpt" aria-pressed="true"')
  })

  test("the provider badge replaces a seat's type badge; a Claude account keeps its type", () => {
    const { html } = rendered(new MemoryStorage(), mixed())
    expect(html).toContain('<span class="profile-badge provider-badge">Claude</span><span class="profile-badge badge-type">claude-max</span>')
    expect(html).toContain('<span class="profile-badge provider-badge">ChatGPT</span>')
    expect(html).not.toContain('badge-type">chatgpt<')
    expect(html).toContain('class="switch-btn switch-to"')
  })

  test("a chip and the search compose; the count covers only the providers on screen", () => {
    const storage = new MemoryStorage()
    const { page } = rendered(storage, mixed())
    const card = (id: string, group: string) => {
      const el = stubElement()
      el.attrs.set("data-id", id)
      el.attrs.set("data-group", group)
      return el
    }
    const cards = [card("c1", "claude"), card("c2", "claude"), card("g1", "chatgpt"), card("g2", "chatgpt")]
    const head = (group: string) => { const el = stubElement(); el.attrs.set("data-group", group); return el }
    const heads = [head("claude"), head("chatgpt")]
    page.select("#content .profile-card[data-id]", cards)
    page.select("#content .provider-group-head", heads)
    const shown = () => cards.filter(c => !c.hidden).map(c => c.attrs.get("data-id"))

    page.run("meridianProviders.setHidden('chatgpt', true); applyProfileFilter()")
    expect(shown()).toEqual(["c1", "c2"])
    expect(heads.map(h => h.hidden)).toEqual([false, true])
    expect(page.element("profiles-provider-none").hidden).toBe(true)

    page.run("setProfileQuery('c2')")
    expect(shown()).toEqual(["c2"])
    expect(page.element("profiles-filter-count").textContent).toBe("1 of 2")

    page.run("setProfileQuery('g1')")
    expect(shown()).toEqual([])
    expect(heads.map(h => h.hidden)).toEqual([true, true])
    expect(page.element("profiles-no-match").hidden).toBe(false)

    page.run("setProfileQuery(''); meridianProviders.setHidden('claude', true); applyProfileFilter()")
    expect(shown()).toEqual([])
    expect(page.element("profiles-provider-none").hidden).toBe(false)
    expect(storage.getItem(HIDDEN_PROVIDERS_KEY)).toBe('["chatgpt","claude"]')
  })

  test("a link to an account of a hidden provider shows that provider again", () => {
    const storage = new MemoryStorage()
    storage.setItem(HIDDEN_PROVIDERS_KEY, '["chatgpt"]')
    const page = loadPage(profilePageHtml, storage)
    page.run(`lastProfiles = ${JSON.stringify({ profiles: mixed() })}; render(lastProfiles, null)`)
    const target = stubElement()
    target.attrs.set("data-group", "chatgpt")
    page.element("profile-g1").getAttribute = target.getAttribute
    page.run("location.hash = '#g1'; jumpToProfileAnchor()")
    expect(page.run<boolean>("meridianProviders.isHidden('chatgpt')")).toBe(false)
    expect(storage.getItem(HIDDEN_PROVIDERS_KEY)).toBe("[]")
  })
})

// ---------------------------------------------------------------------------
// Login-state chips: Authenticated, Expires soon, Needs auth.
// ---------------------------------------------------------------------------

interface LoginStates {
  stateOf(p: unknown): string
  counts(states: string[]): Record<string, number>
  isHidden(id: string): boolean
  visible(id: string, total: number): boolean
  setHidden(id: string, hide: boolean): void
  showAll(): void
  chipsHtml(counts: Record<string, number>, total: number): string
  onClick(target: unknown): string | null
}

function loadLoginStates(storage?: unknown): LoginStates {
  return new Function("localStorage", isUnusableJs + "\n" + profileLoginStatesJs + "\nreturn meridianLoginStates;")(storage) as LoginStates
}

/** Two of each state, split across the providers; the saved order interleaves them. */
const byState = () => [
  claude("c-ok", { isActive: true }),
  seat("g-out", { loggedIn: false }),
  claude("c-soon", { renewalRequiredSoon: true }),
  seat("g-ok", { isActive: true }),
  claude("c-out", { loggedIn: false, renewalRequiredSoon: true }),
  seat("g-ok2"),
]
const STATE_OF: Record<string, string> = {
  "c-ok": "authenticated", "g-ok": "authenticated", "g-ok2": "authenticated",
  "c-soon": "expires-soon",
  "c-out": "needs-auth", "g-out": "needs-auth",
}

describe("login states", () => {
  const s = loadLoginStates()

  test("each account is in exactly one state, from the shared needs-login rule and renewalRequiredSoon", () => {
    expect(s.stateOf({ loggedIn: true })).toBe("authenticated")
    expect(s.stateOf({ loggedIn: true, renewalRequiredSoon: true })).toBe("expires-soon")
    expect(s.stateOf({ loggedIn: false })).toBe("needs-auth")
    // Needs auth outranks an expiring deadline, and a missing token is a needed login.
    expect(s.stateOf({ loggedIn: false, renewalRequiredSoon: true })).toBe("needs-auth")
    expect(s.stateOf({ loggedIn: true, error: "no_token", renewalRequiredSoon: true })).toBe("needs-auth")
    // A seat states no login deadline: logged in is authenticated.
    expect(s.stateOf({ loggedIn: true, renewalRequiredSoon: false })).toBe("authenticated")
  })

  test("every chip is on by default, with a count per state", () => {
    const html = s.chipsHtml(s.counts(["authenticated", "needs-auth", "authenticated"]), 3)
    expect([...html.matchAll(/data-login-chip="([\w-]+)" aria-pressed="(\w+)"/g)].map(m => [m[1], m[2]]))
      .toEqual([["authenticated", "true"], ["expires-soon", "true"], ["needs-auth", "true"]])
    expect([...html.matchAll(/>([^<>]+)<span class="provider-chip-count">(\d+)</g)].map(m => [m[1], m[2]]))
      .toEqual([["Authenticated", "2"], ["Expires soon", "0"], ["Needs auth", "1"]])
    expect(html).toContain('class="provider-chip login-needs-auth"')
  })

  test("one account draws no chips and hides nothing", () => {
    const storage = new MemoryStorage()
    storage.setItem(HIDDEN_LOGIN_STATES_KEY, '["authenticated"]')
    const one = loadLoginStates(storage)
    expect(one.chipsHtml(one.counts(["authenticated"]), 1)).toBe("")
    expect(one.visible("authenticated", 1)).toBe(true)
    expect(one.visible("authenticated", 2)).toBe(false)
  })

  test("the choice is remembered, and storage holding garbage hides nothing", () => {
    const storage = new MemoryStorage()
    const first = loadLoginStates(storage)
    first.setHidden("needs-auth", true)
    expect(storage.getItem(HIDDEN_LOGIN_STATES_KEY)).toBe('["needs-auth"]')
    expect(loadLoginStates(storage).isHidden("needs-auth")).toBe(true)
    storage.setItem(HIDDEN_LOGIN_STATES_KEY, '["bogus","expires-soon","expires-soon"]')
    expect(LOGIN_STATES.map(x => loadLoginStates(storage).isHidden(x.id))).toEqual([false, true, false])
    storage.setItem(HIDDEN_LOGIN_STATES_KEY, "{not json")
    expect(LOGIN_STATES.some(x => loadLoginStates(storage).isHidden(x.id))).toBe(false)
  })

  test("a click toggles its chip, and Show all states turns every one back on", () => {
    const storage = new MemoryStorage()
    const st = loadLoginStates(storage)
    const target = (id: string) => ({ closest: () => ({ getAttribute: () => id }) })
    expect(st.onClick(target("expires-soon"))).toBe("expires-soon")
    expect(st.isHidden("expires-soon")).toBe(true)
    st.onClick(target("needs-auth"))
    expect(st.onClick(target("*"))).toBe("*")
    expect(storage.getItem(HIDDEN_LOGIN_STATES_KEY)).toBe("[]")
    expect(st.onClick({ closest: () => null })).toBeNull()
  })

  for (const [name, html] of [["landing", landingHtml], ["profiles", profilePageHtml]] as const) {
    test(`${name}: embeds the login-state module and its CSS exactly once`, () => {
      expect(html.split("var meridianLoginStates = (function () {").length - 1).toBe(1)
      expect(html.split(".chip-row { display: flex;").length - 1).toBe(1)
    })
  }
})

describe("the landing page filters by login state", () => {
  const section = (storage: MemoryStorage) =>
    loadPage(landingHtml, storage).run<{ html: string }>(
      `profileSection(null, {}, ${JSON.stringify({ profiles: byState(), routing: "active" })}, { auth: { loggedIn: true } })`,
    ).html
  const visible = (html: string) => cardsOf(html).filter(c => !c.hidden).map(c => c.id).sort()

  test("every card is tagged with its state, all chips on, every card shown, beside the provider chips", () => {
    const html = section(new MemoryStorage())
    expect(Object.fromEntries(cardsOf(html).map(c => [c.id, c.loginState]))).toEqual(STATE_OF)
    expect(visible(html)).toEqual(Object.keys(STATE_OF).sort())
    expect(html).toMatch(/<div class="chip-row"><div class="provider-chips" [^>]*>.*<\/div><div class="provider-chips login-chips"/)
    expect([...html.matchAll(/data-login-chip="([\w-]+)" aria-pressed="(\w+)"[^>]*>.*?<span class="provider-chip-count">(\d+)</g)].map(m => [m[1], m[2], m[3]]))
      .toEqual([["authenticated", "true", "3"], ["expires-soon", "true", "1"], ["needs-auth", "true", "2"]])
    expect(html).toContain('<div class="provider-none login-none" hidden>')
  })

  for (const state of LOGIN_STATES.map(x => x.id)) {
    test(`turning off ${state} hides exactly its cards`, () => {
      const storage = new MemoryStorage()
      storage.setItem(HIDDEN_LOGIN_STATES_KEY, JSON.stringify([state]))
      const html = section(storage)
      expect(visible(html)).toEqual(Object.keys(STATE_OF).filter(id => STATE_OF[id] !== state).sort())
      expect(html).toContain(`data-login-chip="${state}" aria-pressed="false"`)
    })
  }

  test("provider and login state combine with AND; a heading hides with its last card", () => {
    const storage = new MemoryStorage()
    storage.setItem(HIDDEN_PROVIDERS_KEY, '["chatgpt"]')
    storage.setItem(HIDDEN_LOGIN_STATES_KEY, '["needs-auth"]')
    let html = section(storage)
    expect(visible(html)).toEqual(["c-ok", "c-soon"])
    storage.setItem(HIDDEN_PROVIDERS_KEY, "[]")
    storage.setItem(HIDDEN_LOGIN_STATES_KEY, '["authenticated","needs-auth"]')
    html = section(storage)
    expect(visible(html)).toEqual(["c-soon"])
    expect(headingsOf(html)).toEqual([["claude", false], ["chatgpt", true]])
  })

  test("with every state hidden, the page says so and offers Show all states", () => {
    const storage = new MemoryStorage()
    storage.setItem(HIDDEN_LOGIN_STATES_KEY, JSON.stringify(LOGIN_STATES.map(x => x.id)))
    const html = section(storage)
    expect(visible(html)).toEqual([])
    expect(html).toContain(`<div class="provider-none login-none">${LOGIN_STATES_NONE_SHOWN_HTML}</div>`)
  })
})

describe("the profiles page filters by login state", () => {
  const rendered = (storage: MemoryStorage) => {
    const page = loadPage(profilePageHtml, storage)
    page.run(`lastProfiles = ${JSON.stringify({ profiles: byState() })}; render(lastProfiles, null)`)
    return { page, html: page.element("content").innerHTML, chips: page.element("profiles-login-chips").innerHTML }
  }
  const stubCards = (page: Page) => {
    const cards = Object.entries(STATE_OF).map(([id, state]) => {
      const el = stubElement()
      el.attrs.set("data-id", id)
      el.attrs.set("data-group", id.startsWith("c") ? "claude" : "chatgpt")
      el.attrs.set("data-login-state", state)
      return el
    })
    page.select("#content .profile-card[data-id]", cards)
    return () => cards.filter(c => !c.hidden).map(c => c.attrs.get("data-id")).sort()
  }

  test("cards carry their state and the chips sit in their own slot, all on", () => {
    const { html, chips } = rendered(new MemoryStorage())
    expect(Object.fromEntries(cardsOf(html).map(c => [c.id, c.loginState]))).toEqual(STATE_OF)
    expect([...chips.matchAll(/data-login-chip="([\w-]+)" aria-pressed="(\w+)"[^>]*>.*?<span class="provider-chip-count">(\d+)</g)].map(m => [m[1], m[2], m[3]]))
      .toEqual([["authenticated", "true", "3"], ["expires-soon", "true", "1"], ["needs-auth", "true", "2"]])
    expect(profilePageHtml).toContain('<div class="chip-row"><div id="profiles-provider-chips"></div><div id="profiles-login-chips"></div></div>')
  })

  test("each chip hides exactly its state's cards, AND the provider chips, AND the search", () => {
    const storage = new MemoryStorage()
    const { page } = rendered(storage)
    const shown = stubCards(page)
    page.run("applyProfileFilter()")
    expect(shown()).toEqual(Object.keys(STATE_OF).sort())
    for (const state of LOGIN_STATES.map(x => x.id)) {
      page.run(`meridianLoginStates.showAll(); meridianLoginStates.setHidden('${state}', true); applyProfileFilter()`)
      expect(shown()).toEqual(Object.keys(STATE_OF).filter(id => STATE_OF[id] !== state).sort())
    }
    page.run("meridianLoginStates.showAll(); meridianLoginStates.setHidden('authenticated', true); meridianProviders.setHidden('claude', true); applyProfileFilter()")
    expect(shown()).toEqual(["g-out"])
    page.run("setProfileQuery('g-out')")
    expect(page.element("profiles-filter-count").textContent).toBe("1 of 1")
    page.run("setProfileQuery(''); meridianLoginStates.setHidden('needs-auth', true); applyProfileFilter()")
    expect(shown()).toEqual([])
    expect(page.element("profiles-login-none").hidden).toBe(false)
    expect(page.element("profiles-provider-none").hidden).toBe(true)
    expect(storage.getItem(HIDDEN_LOGIN_STATES_KEY)).toBe('["authenticated","needs-auth"]')
  })

  test("a link to an account in a hidden state shows that state again", () => {
    const storage = new MemoryStorage()
    storage.setItem(HIDDEN_LOGIN_STATES_KEY, '["needs-auth"]')
    const { page } = rendered(storage)
    const target = stubElement()
    target.attrs.set("data-group", "claude")
    target.attrs.set("data-login-state", "needs-auth")
    page.element("profile-c-out").getAttribute = target.getAttribute
    page.run("location.hash = '#c-out'; jumpToProfileAnchor()")
    expect(storage.getItem(HIDDEN_LOGIN_STATES_KEY)).toBe("[]")
  })
})
