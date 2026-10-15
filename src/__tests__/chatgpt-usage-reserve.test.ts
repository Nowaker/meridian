/**
 * Usage reserves on ChatGPT seats: a seat its reserve holds back takes no
 * work while its plan has quota left - nor credits work, because the plan is
 * billed first and the turn would spend the share kept back. A seat whose
 * plan is spent outright has nothing left to keep.
 *
 * Each guarantee is paired with a control in which the same seat serves.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createChatGptBackend, type ChatGptRoute, type ChatGptTurnEvent } from "../proxy/backends/chatgpt"
import { createExternalCredentialSource } from "../proxy/chatgpt/external"
import type { ChatGptCreditsPolicy } from "../proxy/chatgpt/features"
import type { CodexCredits, CodexUsageWindow } from "../proxy/codex/types"
import { ProfileExhaustion } from "../proxy/routing"
import type { UsageReserve } from "../proxy/usageReserve"

const NOW = 1_800_000_000_000
const DAY = 86_400_000
const WEEK_S = 7 * 24 * 3600

const seatId = (n: number) => `user-${n}__workspace-${n}`
function account(n: number, extra: Record<string, unknown> = {}) {
  return {
    accountId: `workspace-${n}`, accountUserId: seatId(n), email: `seat${n}@example.test`, planType: "pro",
    refreshToken: `rt-${n}`, accessToken: `at-${n}`, expiresAt: NOW + 3_600_000, addedAt: 1, lastUsed: 1, ...extra,
  }
}
const stamped = (n: number) => account(n, { quotaExhaustedUntil: NOW + 3 * DAY, quotaExhaustedStampAt: NOW - 1 })

const PAYABLE: CodexCredits = { hasCredits: true, unlimited: false, overageLimitReached: false, balance: 62_500 }
const FLAT_WEEK_95: UsageReserve = { seven_day: { floor: 95, ceiling: 95 } }

/** The weekly window as the usage read states it, resetting in three days. */
const weekly = (utilization: number): CodexUsageWindow[] => [
  { type: "7d", utilization, resetsAt: NOW + 3 * DAY, limitWindowSeconds: WEEK_S },
]

/** The weekly window as a response's own headers state it. */
const weeklyHeaders = (usedPercent: number): Record<string, string> => ({
  "x-codex-primary-window-minutes": String(WEEK_S / 60),
  "x-codex-primary-used-percent": String(usedPercent),
  "x-codex-primary-reset-at": String(Math.floor(NOW / 1000) + 3 * 24 * 3600),
})

function served(headers: Record<string, string> = {}): Response {
  const events = [
    { type: "response.created", response: { id: "r1", output: [] } },
    { type: "response.output_text.delta", delta: "pong" },
    { type: "response.completed", response: { id: "r1", model: "gpt-5.6-luna", output: [], usage: { input_tokens: 16, input_tokens_details: { cached_tokens: 0 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 } } } },
  ]
  return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), {
    status: 200, headers: { "content-type": "text/event-stream", ...headers },
  })
}

let dir: string
let poolPath: string
function writePool(accounts: unknown[]) {
  writeFileSync(poolPath, JSON.stringify({ version: 3, accounts, activeIndex: 0 }))
}

interface Harness {
  calls: string[]
  events: ChatGptTurnEvent[]
  turn(): Promise<Response>
}

/** The profile id a seat is known by: `user-0` for seat 0. */
const profileOf = (seat: string) => seat.split("__")[0]!

function harness(options: {
  respond?: (token: string) => Response
  credits?: Record<string, CodexCredits>
  route?: ChatGptRoute
  policy?: ChatGptCreditsPolicy
  /** Plan windows from the usage read, per seat. */
  windows?: Record<string, CodexUsageWindow[]>
  /** Usage reserves, per seat. */
  reserves?: Record<string, UsageReserve>
} = {}): Harness {
  const h: Harness = {
    calls: [], events: [],
    turn: () => backend.handle({ context: {}, endpoint: "responses", route: "/v1/responses" }),
  }
  const backend = createChatGptBackend<object>({
    source: createExternalCredentialSource({ path: poolPath, now: () => NOW }),
    exhaustion: new ProfileExhaustion(() => NOW),
    now: () => NOW,
    inboundRequest: () => new Request("http://localhost/v1/responses", {
      method: "POST", body: JSON.stringify({ model: "gpt-5.6-luna", stream: true, input: "Hi" }),
    }),
    route: options.route ? () => options.route! : undefined,
    credits: (seat) => options.credits?.[seat] ? { credits: options.credits[seat]!, at: NOW - 60_000 } : null,
    creditsPolicy: () => options.policy ?? "reserve",
    planWindows: (seat) => options.windows?.[seat] ? { windows: options.windows[seat]!, at: NOW - 60_000 } : null,
    usageReserve: (seat) => options.reserves?.[seat] ? { profile: profileOf(seat), reserve: options.reserves[seat]! } : null,
    hooks: { onTurn: (event) => h.events.push(event) },
    fetchImpl: async (_url, init) => {
      const token = new Headers(init.headers).get("authorization")!.replace("Bearer ", "")
      h.calls.push(token)
      return (options.respond ?? (() => served()))(token)
    },
  })
  return h
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chatgpt-usage-reserve-"))
  poolPath = join(dir, "oc-codex-multi-auth-accounts.json")
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe("a ChatGPT seat its usage reserve holds back", () => {
  it("is passed over while its plan has quota left", async () => {
    writePool([account(0), account(1)])
    const held = harness({ windows: { [seatId(0)]: weekly(0.96) }, reserves: { [seatId(0)]: FLAT_WEEK_95 } })
    await (await held.turn()).text()
    expect(held.calls).toEqual(["at-1"])

    const control = harness({ windows: { [seatId(0)]: weekly(0.94) }, reserves: { [seatId(0)]: FLAT_WEEK_95 } })
    await (await control.turn()).text()
    expect(control.calls).toEqual(["at-0"])
  })

  it("leaves a turn with nowhere else to go refused, unsent, as a rate limit naming it", async () => {
    writePool([account(0)])
    const h = harness({ windows: { [seatId(0)]: weekly(0.96) }, reserves: { [seatId(0)]: FLAT_WEEK_95 } })

    const response = await h.turn()

    expect(response.status).toBe(429)
    // Three days to the reset, clamped to the longest wait a client is told.
    expect(response.headers.get("retry-after")).toBe("86400")
    const body = await response.json() as { error: { type: string; message: string } }
    expect(body.error.type).toBe("rate_limit_error")
    expect(body.error.message).toContain("user-0 (weekly at 96%, capped at 95%)")
    expect(h.calls).toEqual([])
    expect(h.events[0]).toMatchObject({ status: 429, error: "chatgpt_usage_reserve" })
  })

  it("is not served on its credits either, whatever its credits policy", async () => {
    writePool([account(0)])
    const held = harness({
      credits: { [seatId(0)]: PAYABLE }, policy: "immediately",
      windows: { [seatId(0)]: weekly(0.96) }, reserves: { [seatId(0)]: FLAT_WEEK_95 },
    })
    expect((await held.turn()).status).toBe(429)
    expect(held.calls).toEqual([])

    const control = harness({ credits: { [seatId(0)]: PAYABLE }, policy: "immediately", windows: { [seatId(0)]: weekly(0.96) } })
    await (await control.turn()).text()
    expect(control.calls).toEqual(["at-0"])
  })

  it("keeps its credits policy once its plan is spent: there is no share left to keep", async () => {
    writePool([stamped(0)])
    const h = harness({ credits: { [seatId(0)]: PAYABLE }, windows: { [seatId(0)]: weekly(1) }, reserves: { [seatId(0)]: FLAT_WEEK_95 } })

    const response = await h.turn()
    await response.text()

    expect(response.status).toBe(200)
    expect(h.events[0]).toMatchObject({ seat: seatId(0), servedOnCredits: true })
  })

  it("still takes a warm, and refuses work pinned to it", async () => {
    writePool([account(0), account(1)])
    const held = { windows: { [seatId(0)]: weekly(0.97) }, reserves: { [seatId(0)]: FLAT_WEEK_95 } }

    const warm = harness({ ...held, route: { kind: "pinned", seat: seatId(0), spendCredits: false, warm: true } })
    await (await warm.turn()).text()
    expect(warm.calls).toEqual(["at-0"])

    const pinned = harness({ ...held, route: { kind: "pinned", seat: seatId(0) } })
    expect((await pinned.turn()).status).toBe(429)
    expect(pinned.calls).toEqual([])
  })

  it("is judged on its newest reading: a response's headers after the usage read", async () => {
    writePool([account(0), account(1)])
    const h = harness({
      windows: { [seatId(0)]: weekly(0.5) },
      reserves: { [seatId(0)]: FLAT_WEEK_95 },
      respond: (token) => token === "at-0" ? served(weeklyHeaders(96)) : served(),
    })

    await (await h.turn()).text()
    await (await h.turn()).text()

    expect(h.calls).toEqual(["at-0", "at-1"])
  })
})
