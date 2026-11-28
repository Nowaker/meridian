/**
 * A ChatGPT seat's banked resets on its /profiles card: the view and outcome
 * functions (telemetry/chatGptResets.ts), and the page's own render and
 * redeem functions cut out of the served HTML and run against fixtures.
 */
import { describe, expect, it } from "bun:test"
import { createContext, runInContext } from "node:vm"
import { chatGptRedeemOutcomeText, chatGptResetCardView } from "../telemetry/chatGptResets"
import { profilePageHtml } from "../telemetry/profilePage"

const NOW = 1_795_900_000_000
const DAY = 86_400_000
const SOON = NOW + 2 * DAY
const LATER = NOW + 5 * DAY

describe("chatGptResetCardView", () => {
  it("names the soonest expiry and offers the redeem only on an owned seat holding a reset", () => {
    expect(chatGptResetCardView({ available: 2, expiresAt: [SOON, LATER] }, "owned")).toEqual({ available: 2, nextExpiresAt: SOON, redeemable: true, reason: null })
    expect(chatGptResetCardView({ available: 1, expiresAt: null }, "owned")).toEqual({ available: 1, nextExpiresAt: null, redeemable: true, reason: null })
    expect(chatGptResetCardView({ available: 0, expiresAt: [] }, "owned")).toMatchObject({ redeemable: false, reason: "This seat has no banked reset." })
    expect(chatGptResetCardView({ available: 2, expiresAt: [SOON] }, "follow-external")).toMatchObject({ redeemable: false })
    expect(chatGptResetCardView(null, "owned")).toBeNull()
    expect(chatGptResetCardView({ available: -1 }, "owned")).toBeNull()
  })

  it("is self-contained, so the page's embedded copies answer the same", () => {
    const view = new Function(`return (${chatGptResetCardView.toString()})`)() as typeof chatGptResetCardView
    const outcome = new Function(`return (${chatGptRedeemOutcomeText.toString()})`)() as typeof chatGptRedeemOutcomeText
    expect(view({ available: 2, expiresAt: [SOON] }, "owned")).toEqual(chatGptResetCardView({ available: 2, expiresAt: [SOON] }, "owned"))
    for (const [status, body] of [[200, { result: "redeemed", remaining: 1 }], [502, { error: "x", indeterminate: true }], [0, null]] as const) {
      expect(outcome(status, body)).toEqual(chatGptRedeemOutcomeText(status, body))
    }
  })
})

describe("chatGptRedeemOutcomeText", () => {
  it("says what happened, and warns when the outcome is unknown", () => {
    expect(chatGptRedeemOutcomeText(200, { result: "redeemed", remaining: 1 })).toEqual({ ok: true, text: "Reset redeemed; the seat's windows are cleared. 1 left." })
    expect(chatGptRedeemOutcomeText(502, { error: "ChatGPT gave no usable answer (HTTP 503); the reset may or may not be spent", indeterminate: true }).text)
      .toBe("Not redeemed: ChatGPT gave no usable answer (HTTP 503); the reset may or may not be spent. It may have gone through - check the seat's resets before trying again.")
    expect(chatGptRedeemOutcomeText(0, null)).toEqual({ ok: false, text: "Not redeemed: Meridian did not answer." })
  })
})

function pageFunctions(html: string, names: readonly string[]): string {
  return names.map(name => {
    const source = html.match(new RegExp(`^(?:async )?function ${name}\\((?:.*\\}$|[^]*?^\\})`, "m"))?.[0]
    if (!source) throw new Error(`Missing rendered page function ${name}`)
    return source
  }).join("\n")
}
const textEsc = (s: unknown) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
const decode = (s: string) => s.replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
const buttonsIn = (html: string) => [...html.matchAll(/<button\b([^>]*)>([^<]*)<\/button>/g)].map(m => ({
  text: m[2] ?? "",
  disabled: /\sdisabled(\s|$)/.test(m[1] ?? ""),
  attrs: Object.fromEntries([...(m[1] ?? "").matchAll(/([\w-]+)="([^"]*)"/g)].map(a => [a[1] ?? "", decode(a[2] ?? "")])),
}))

function page(ownerMode: string, answer: { status: number; body: unknown } = { status: 200, body: { result: "redeemed", remaining: 1 } }) {
  const asked: Array<Record<string, unknown>> = []
  const posted: Array<{ url: string; method: string }> = []
  const sandbox: Record<string, unknown> = {
    chatGptResetCardView, chatGptRedeemOutcomeText, esc: textEsc, Date, JSON, Number, Math, String, Object, encodeURIComponent,
    chatGptOwnerInfo: { mode: ownerMode }, redeemingReset: null, resetOutcomes: Object.create(null), refreshes: 0, confirm: true,
    meridianDialog: { ask: async (opts: Record<string, unknown>) => { asked.push(opts); return sandbox.confirm } },
    fetch: async (url: string, init: { method: string }) => {
      posted.push({ url, method: init.method })
      return { status: answer.status, json: async () => answer.body }
    },
  }
  sandbox.refresh = async () => { sandbox.refreshes = (sandbox.refreshes as number) + 1 }
  const context = createContext(sandbox)
  runInContext(pageFunctions(profilePageHtml, ["attr", "renderChatGptResets", "redeemChatGptReset"]), context)
  const render = (resets: unknown, id = "d-n-vk5-gpt"): string =>
    runInContext("renderChatGptResets({ id: id, label: id, resets: resets })", Object.assign(context, { resets, id })) as string
  const redeem = async (attrs: Record<string, string>) => {
    const button = { disabled: false, textContent: "", getAttribute: (name: string) => attrs[name] ?? null }
    await (runInContext("redeemChatGptReset", context) as (b: unknown) => Promise<void>)(button)
  }
  return { render, redeem, asked, posted, sandbox }
}

describe("/profiles: a seat's banked resets", () => {
  it("offers the redeem naming the soonest expiry, confirms in the page, and posts to the seat's route", async () => {
    const target = page("owned")
    const html = target.render({ available: 2, expiresAt: [SOON, LATER] })
    expect(html).toContain(">Banked resets<")
    const [button] = buttonsIn(html)
    expect(button).toMatchObject({ text: "Redeem closest-expiring reset", disabled: false })
    expect(button!.attrs["data-expiry"]).toBe(new Date(SOON).toLocaleString())
    await target.redeem(button!.attrs)
    expect(target.asked).toHaveLength(1)
    expect(target.asked[0]).toMatchObject({ title: "Redeem a banked reset on d-n-vk5-gpt now?", confirmText: "Redeem reset", danger: true, note: "1 banked reset would be left." })
    expect(String(target.asked[0]!.message)).toContain(`expires soonest (${new Date(SOON).toLocaleString()})`)
    expect(target.posted).toEqual([{ url: "/profiles/d-n-vk5-gpt/chatgpt-resets/redeem", method: "POST" }])
    expect(target.sandbox.refreshes).toBe(1)
    expect(target.render({ available: 1, expiresAt: [LATER] })).toContain("Reset redeemed; the seat's windows are cleared. 1 left.")
  })

  it("sends nothing when the confirmation is declined", async () => {
    const target = page("owned")
    target.sandbox.confirm = false
    await target.redeem(buttonsIn(target.render({ available: 1, expiresAt: [SOON] }))[0]!.attrs)
    expect(target.posted).toEqual([])
  })

  it("disables the redeem on a seat this instance does not own, and offers none on a seat without resets", () => {
    const borrowed = page("follow-external")
    const [button] = buttonsIn(borrowed.render({ available: 2, expiresAt: [SOON] }))
    expect(button).toMatchObject({ disabled: true })
    expect(button!.attrs.title).toContain("Only the instance that owns")
    expect(buttonsIn(page("owned").render({ available: 0, expiresAt: [] }))).toEqual([])
    expect(page("owned").render(null)).toBe("")
  })

  it("escapes a hostile seat id in its attributes", () => {
    const html = page("owned").render({ available: 1, expiresAt: [SOON] }, "<img src=x onerror=alert(1)>\"")
    expect(html).not.toContain("<img")
  })
})
