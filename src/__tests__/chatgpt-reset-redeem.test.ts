/**
 * Redeeming a ChatGPT seat's banked resets (chatgpt/resetRedeem.ts and
 * codex/resetCredits.ts) against a fake chatgpt.com: which credit is spent,
 * what the consume sends, what the ledger keeps, and that no credit is ever
 * tried twice.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { consumeResetCredit, listResetCredits, redeemRequestId } from "../proxy/chatgpt/resetCredits"
import { createResetRedeemer, resetCreditKey, type ResetRedeemerDeps } from "../proxy/chatgpt/resetRedeem"

const NOW = Date.UTC(2026, 10, 28, 12)
const HOUR = 3_600_000
const SEAT = "user-1__workspace-1"
const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
const TOKEN = `${part({ alg: "none" })}.${part({
  exp: Math.floor(NOW / 1000) + 3600,
  "https://api.openai.com/auth": { chatgpt_account_id: "workspace-1", chatgpt_account_user_id: SEAT, chatgpt_user_id: "user-1" },
})}.sig`
const CREDENTIALS = { accountId: "workspace-1", accountUserId: SEAT, accessToken: TOKEN, email: null }
const LIST_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits"
const CONSUME_URL = `${LIST_URL}/consume`
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"

interface Call { url: string; method: string; body: unknown; authorization: string | null; accountId: string | null; redirect: RequestInit["redirect"] }

/** A chatgpt.com that lists `credits` and removes a credit once it is consumed. */
function fakeChatGpt(initial: Array<{ id?: string; status?: string; expires_at?: string }>, consume: (body: { credit_id: string }) => Response = () => Response.json({ code: "ok", windows_reset: ["primary", "secondary"], credit: { redeemed_at: new Date(NOW).toISOString() } })) {
  let credits = [...initial]
  let used = 100
  const calls: Call[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const headers = new Headers(init?.headers)
    const body = init?.body ? JSON.parse(String(init.body)) as { credit_id: string } : null
    calls.push({ url, method: init?.method ?? "GET", body, authorization: headers.get("authorization"), accountId: headers.get("chatgpt-account-id"), redirect: init?.redirect })
    if (url === LIST_URL) return Response.json({ available_count: credits.filter(c => c.status === "available").length, credits })
    if (url === USAGE_URL) {
      // A limited seat: its weekly window is spent until a reset clears it.
      const available = credits.filter(c => c.status === "available").length
      return Response.json({
        user_id: "user-1", account_id: "workspace-1",
        rate_limit: { limit_reached: used >= 100, primary_window: { used_percent: used, limit_window_seconds: 604_800, reset_at: Math.floor((NOW + 4 * 24 * HOUR) / 1000) } },
        rate_limit_reset_credits: { available_count: available, applicable_available_count: used >= 100 ? available : 0 },
      })
    }
    if (url === CONSUME_URL && body) {
      const answer = consume(body)
      if (answer.ok) {
        credits = credits.filter(c => c.id !== body.credit_id)
        used = 0
      }
      return answer
    }
    return new Response("{}", { status: 404 })
  }) as typeof fetch
  return { calls, fetchImpl, consumed: () => calls.filter(c => c.url === CONSUME_URL) }
}

const at = (hours: number) => new Date(NOW + hours * HOUR).toISOString()

let dir: string
let ledgerPath: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chatgpt-reset-redeem-"))
  ledgerPath = join(dir, "meridian", "chatgpt-reset-ledger.json")
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function redeemer(fetchImpl: typeof fetch, overrides: Partial<ResetRedeemerDeps> = {}) {
  return createResetRedeemer({
    source: { credentials: async seat => ({ ok: true, account: { ...CREDENTIALS, accountUserId: seat } }) },
    ledgerPath,
    canRedeem: () => true,
    fetchImpl,
    now: () => NOW,
    ...overrides,
  })
}

describe("codex reset credit endpoints", () => {
  it("lists available credits with their ids, soonest expiry first", async () => {
    const { fetchImpl, calls } = fakeChatGpt([
      { id: "c-late", status: "available", expires_at: at(48) },
      { id: "c-used", status: "redeemed", expires_at: at(1) },
      { id: "c-soon", status: "available", expires_at: at(5) },
    ])
    const listed = await listResetCredits(CREDENTIALS, { fetchImpl, now: NOW })
    expect(listed).toEqual({ ok: true, credits: [
      { id: "c-soon", status: "available", expiresAt: NOW + 5 * HOUR },
      { id: "c-late", status: "available", expiresAt: NOW + 48 * HOUR },
    ] })
    expect(calls[0]).toMatchObject({ method: "GET", authorization: `Bearer ${TOKEN}`, accountId: "workspace-1", redirect: "error" })
  })

  it("consumes with the credit id and the idempotency key oc-codex-multi-auth derives for it", async () => {
    const { fetchImpl, consumed } = fakeChatGpt([{ id: "c-1", status: "available", expires_at: at(5) }])
    const outcome = await consumeResetCredit(CREDENTIALS, "c-1", { fetchImpl, now: NOW })
    expect(outcome).toEqual({ kind: "redeemed", code: "ok", windowsReset: ["primary", "secondary"], redeemedAt: NOW })
    expect(consumed()[0]).toMatchObject({ method: "POST", body: { credit_id: "c-1", redeem_request_id: redeemRequestId("c-1") }, redirect: "error" })
    // What oc-codex-multi-auth's createRedeemRequestId("c-1") returns.
    expect(redeemRequestId("c-1")).toBe("3d15362c-edda-580b-b3c4-a3ec2dd6d39f")
    expect(redeemRequestId("c-1")).not.toBe(redeemRequestId("c-2"))
  })

  it("tells a refusal, which leaves the credit, from an answer that may have spent it", async () => {
    const refusal = fakeChatGpt([], () => Response.json({ error: { code: "reset_not_applicable", message: "free text <script>" } }, { status: 409 }))
    expect(await consumeResetCredit(CREDENTIALS, "c-1", { fetchImpl: refusal.fetchImpl, now: NOW }))
      .toEqual({ kind: "refused", status: 409, error: "refused", code: "reset_not_applicable" })
    const unsafe = fakeChatGpt([], () => Response.json({ detail: "Your credit <b>could not</b> be used" }, { status: 400 }))
    expect(await consumeResetCredit(CREDENTIALS, "c-1", { fetchImpl: unsafe.fetchImpl, now: NOW }))
      .toEqual({ kind: "refused", status: 400, error: "refused", code: null })
    const crashed = fakeChatGpt([], () => new Response("upstream", { status: 502 }))
    expect(await consumeResetCredit(CREDENTIALS, "c-1", { fetchImpl: crashed.fetchImpl, now: NOW })).toEqual({ kind: "indeterminate", status: 502 })
    const garbled = fakeChatGpt([], () => new Response("not json", { status: 200 }))
    expect(await consumeResetCredit(CREDENTIALS, "c-1", { fetchImpl: garbled.fetchImpl, now: NOW })).toEqual({ kind: "indeterminate", status: 200 })
  })

  it("sends nothing with a token that has expired or belongs to another account", async () => {
    const { fetchImpl, calls } = fakeChatGpt([])
    expect(await consumeResetCredit(CREDENTIALS, "c-1", { fetchImpl, now: NOW + 2 * HOUR })).toEqual({ kind: "not_sent", error: "token_expired" })
    expect(await consumeResetCredit({ ...CREDENTIALS, accountId: "workspace-2" }, "c-1", { fetchImpl, now: NOW })).toEqual({ kind: "not_sent", error: "identity_mismatch" })
    expect(calls).toHaveLength(0)
  })
})

describe("redeeming a seat's banked reset", () => {
  it("spends the soonest-expiring credit, records it before sending, and confirms it is gone", async () => {
    const chatgpt = fakeChatGpt([
      { id: "c-late", status: "available", expires_at: at(48) },
      { id: "c-soon", status: "available", expires_at: at(5) },
    ])
    const result = await redeemer(chatgpt.fetchImpl).redeem(SEAT, "manual")
    expect(result).toEqual({
      kind: "redeemed", creditKey: resetCreditKey(SEAT, "c-soon"), expiresAt: NOW + 5 * HOUR,
      windowsReset: ["primary", "secondary"], redeemedAt: NOW, remaining: 1,
    })
    expect(chatgpt.consumed().map(c => (c.body as { credit_id: string }).credit_id)).toEqual(["c-soon"])
    const doc = JSON.parse(readFileSync(ledgerPath, "utf8"))
    expect(doc.attempts).toEqual([{
      creditKey: resetCreditKey(SEAT, "c-soon"), seat: SEAT, expiresAt: NOW + 5 * HOUR, trigger: "manual",
      attemptedAt: NOW, outcome: "redeemed", error: null, settledAt: NOW,
    }])
    expect(statSync(ledgerPath).mode & 0o777).toBe(0o600)
    // The ledger names credits by key only.
    expect(readFileSync(ledgerPath, "utf8")).not.toContain("c-soon")
  })

  it("never tries a credit twice automatically, and lets a person retry only one that was refused", async () => {
    let answer = () => Response.json({ code: "reset_not_applicable" }, { status: 409 })
    const chatgpt = fakeChatGpt([{ id: "c-1", status: "available", expires_at: at(5) }], () => answer())
    const target = redeemer(chatgpt.fetchImpl)
    expect(await target.redeem(SEAT, "usage")).toMatchObject({ kind: "failed", indeterminate: false, error: "ChatGPT refused the redemption: HTTP 409 reset_not_applicable" })
    expect(await target.redeem(SEAT, "deadline")).toEqual({ kind: "no_credit", available: 1 })
    expect(chatgpt.consumed()).toHaveLength(1)

    answer = () => new Response("", { status: 503 })
    expect(await target.redeem(SEAT, "manual")).toMatchObject({ kind: "failed", indeterminate: true })
    // Indeterminate: it may be spent, so not even a person's redeem tries it again.
    expect(await target.redeem(SEAT, "manual")).toEqual({ kind: "no_credit", available: 1 })
    expect(chatgpt.consumed()).toHaveLength(2)
  })

  it("leaves the credit marked as tried when the process dies between sending and the answer", async () => {
    const chatgpt = fakeChatGpt([{ id: "c-1", status: "available", expires_at: at(5) }])
    const first = redeemer(chatgpt.fetchImpl)
    await first.redeem(SEAT, "usage")
    const doc = JSON.parse(readFileSync(ledgerPath, "utf8"))
    doc.attempts[0].outcome = "dispatching"
    doc.attempts[0].settledAt = null
    writeFileSync(ledgerPath, JSON.stringify(doc))
    // The backend still lists it (as it would if the consume never landed).
    const again = fakeChatGpt([{ id: "c-1", status: "available", expires_at: at(5) }])
    expect(await redeemer(again.fetchImpl).redeem(SEAT, "manual")).toEqual({ kind: "no_credit", available: 1 })
    expect(again.consumed()).toHaveLength(0)
  })

  it("reports a success the backend does not show as unconfirmed", async () => {
    const chatgpt = fakeChatGpt([{ id: "c-1", status: "available", expires_at: at(5) }], () => new Response(JSON.stringify({ code: "ok" }), { status: 202, headers: { "content-type": "application/json" } }))
    const stubborn = (async (input: string | URL | Request, init?: RequestInit) => {
      const answer = await chatgpt.fetchImpl(input, init)
      return String(input) !== LIST_URL ? answer : Response.json({ credits: [{ id: "c-1", status: "available", expires_at: at(5) }] })
    }) as typeof fetch
    expect(await redeemer(stubborn).redeem(SEAT, "usage")).toMatchObject({ kind: "failed", indeterminate: true, error: "ChatGPT answered success but still lists the reset as available" })
    expect(JSON.parse(readFileSync(ledgerPath, "utf8")).attempts[0].outcome).toBe("unconfirmed")
  })

  it("redeems only the credit asked for, when one is named", async () => {
    const chatgpt = fakeChatGpt([{ id: "c-soon", status: "available", expires_at: at(5) }, { id: "c-late", status: "available", expires_at: at(48) }])
    expect(await redeemer(chatgpt.fetchImpl).redeem(SEAT, "deadline", { creditKey: resetCreditKey(SEAT, "c-late") })).toMatchObject({ kind: "redeemed", expiresAt: NOW + 48 * HOUR })
    expect(await redeemer(chatgpt.fetchImpl).redeem(SEAT, "deadline", { creditKey: "gone" })).toEqual({ kind: "no_credit", available: 1 })
  })

  it("runs one redemption per seat, and none on an instance without the seats' login", async () => {
    let release = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    const chatgpt = fakeChatGpt([{ id: "c-1", status: "available", expires_at: at(5) }])
    const slow = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === CONSUME_URL) await gate
      return chatgpt.fetchImpl(input, init)
    }) as typeof fetch
    const target = redeemer(slow)
    const first = target.redeem(SEAT, "manual")
    expect(await target.redeem(SEAT, "manual")).toEqual({ kind: "in_progress" })
    release()
    expect(await first).toMatchObject({ kind: "redeemed" })
    expect(target.running(SEAT)).toBe(false)

    const readOnly = fakeChatGpt([{ id: "c-1", status: "available", expires_at: at(5) }])
    expect(await redeemer(readOnly.fetchImpl, { canRedeem: () => false }).redeem(SEAT, "manual")).toEqual({ kind: "not_owned" })
    expect(readOnly.calls).toHaveLength(0)
  })

  it("sends nothing when the seat's credentials or the credit list are unavailable", async () => {
    const chatgpt = fakeChatGpt([{ id: "c-1", status: "available", expires_at: at(5) }])
    expect(await redeemer(chatgpt.fetchImpl, { source: { credentials: async () => ({ ok: false, reason: "requires_reauth" }) } }).redeem(SEAT, "manual"))
      .toEqual({ kind: "unavailable", error: "the seat's credentials cannot be used (requires_reauth)" })
    const down = (async () => new Response("", { status: 401 })) as unknown as typeof fetch
    expect(await redeemer(down).redeem(SEAT, "manual")).toEqual({ kind: "unavailable", error: "ChatGPT did not list the seat's resets (unauthorized)" })
    expect(chatgpt.calls).toHaveLength(0)
    expect(existsSync(ledgerPath)).toBe(false)
  })
})
