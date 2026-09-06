/**
 * Task 6b - rotation: what the backend does when a seat cannot serve.
 *
 * Tasks 7 and 8 built a sniffer and a cooldown calculator and nothing called
 * them, so a spent account failed the request while five healthy accounts sat
 * unused. That is strictly worse than the plugin this replaces, which rotates.
 * These tests are the composition.
 *
 * WHERE THE SCAN STOPS IS ALSO WHERE RETRYING STOPS. The sniffer reports a
 * failure only while the stream has produced nothing a client could render, so
 * a failure arriving after output is not a failure it reports - and the loop
 * below must not invent one. Retrying there would bill a second account for
 * work the client already holds, and would deliver it twice.
 *
 * Every seat pair here COLLIDES on accountId, mirroring the operator's real
 * pool where one workspace id is shared by two people (F6). A rotation keyed
 * on the workspace would treat these two seats as one and pass every assertion
 * that used unique synthetic ids.
 */
import { describe, expect, it } from "bun:test"
import { createChatGptBackend, type ChatGptServingAccount } from "../proxy/chatgpt/backend"
import type { ChatGptFailure } from "../proxy/chatgpt/stream"
import type { ChatGptRateLimit } from "../proxy/chatgpt/windows"
import type { UpstreamRequest } from "../proxy/upstream/backend"

const SHARED_ACCOUNT_ID = "05cd9f04-1111-2222-3333-444444989a40"

const SEAT_A: ChatGptServingAccount = {
  accountUserId: "seat-C0RSu9",
  accountId: SHARED_ACCOUNT_ID,
  accessToken: "token-for-seat-a",
}
const SEAT_B: ChatGptServingAccount = {
  accountUserId: "seat-zStirX",
  accountId: SHARED_ACCOUNT_ID,
  accessToken: "token-for-seat-b",
}

const BY_SEAT: Record<string, ChatGptServingAccount> = {
  [SEAT_A.accountUserId]: SEAT_A,
  [SEAT_B.accountUserId]: SEAT_B,
}
const BY_TOKEN: Record<string, string> = {
  [SEAT_A.accessToken]: SEAT_A.accountUserId,
  [SEAT_B.accessToken]: SEAT_B.accountUserId,
}

const BODY = JSON.stringify({ model: "gpt-5-codex", input: "hello", prompt_cache_key: "conv-9f04" })

function inbound(body = BODY): Request {
  return new Request("http://127.0.0.1:3971/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  })
}

function responsesRequest(request: Request): UpstreamRequest<Request> {
  return { context: request, endpoint: "responses", route: "/v1/responses" }
}

function sse(...frames: string[]): Response {
  return new Response(frames.join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
}

const CREATED = "event: response.created\ndata: {\"type\":\"response.created\"}\n\n"
const FAILED = "event: response.failed\ndata: {\"type\":\"response.failed\"}\n\n"
const DELTA = "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"hi\"}\n\n"

/** A stream that delivers its chunks and only then breaks, as a dropped socket does. */
function dropsAfter(...frames: string[]): Response {
  const encoder = new TextEncoder()
  let sent = 0
  return new Response(
    new ReadableStream<Uint8Array>({
      // Delivered from `pull`: controller.error() resets the queue, so enqueuing
      // everything upfront and then erroring would discard the content and
      // reject on the first read - the opposite of a mid-content drop.
      pull(controller) {
        if (sent < frames.length) {
          controller.enqueue(encoder.encode(frames[sent]!))
          sent++
          return
        }
        controller.error(new Error("connection reset"))
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  )
}

interface Harness {
  backend: ReturnType<typeof createChatGptBackend<Request>>
  /** One entry per upstream attempt, naming the seat it was made with. */
  attempts: string[]
  benched: Array<{ seat: string; kind: ChatGptFailure["kind"] }>
  served: string[]
}

function harness(
  reply: (seat: string) => Response,
  seats: readonly string[] = [SEAT_A.accountUserId, SEAT_B.accountUserId],
): Harness {
  const attempts: string[] = []
  const benched: Array<{ seat: string; kind: ChatGptFailure["kind"] }> = []
  const served: string[] = []

  const backend = createChatGptBackend<Request>({
    inboundRequest: context => context,
    candidateSeats: () => seats,
    seatCredentials: id => BY_SEAT[id] ?? null,
    benchSeat: (id, failure) => { benched.push({ seat: id, kind: failure.kind }) },
    noteServed: (_body, id) => { served.push(id) },
    fetchImpl: async (_url, init) => {
      // The seat is read back off the outbound credential rather than tracked
      // separately, so these assertions also prove each attempt carried ITS
      // OWN seat's token instead of replaying the first one.
      const bearer = new Headers(init.headers).get("authorization")?.replace("Bearer ", "") ?? ""
      const seat = BY_TOKEN[bearer]
      expect(seat).toBeDefined()
      attempts.push(seat!)
      return reply(seat!)
    },
  })

  return { backend, attempts, benched, served }
}

describe("rotation - a seat that cannot serve hands the request on", () => {
  it("gives a rate-limited seat's request to the next seat", async () => {
    const h = harness(seat => seat === SEAT_A.accountUserId
      ? new Response("{\"error\":\"rate limited\"}", { status: 429, headers: { "content-type": "application/json" } })
      : sse(CREATED, DELTA))

    const response = await h.backend.handle(responsesRequest(inbound()))

    expect(response.status).toBe(200)
    expect(h.attempts).toEqual([SEAT_A.accountUserId, SEAT_B.accountUserId])
    expect(h.benched).toEqual([{ seat: SEAT_A.accountUserId, kind: "rate_limited" }])
    expect(h.served).toEqual([SEAT_B.accountUserId])
  })

  it("hands the client one clean stream, with nothing of the failed attempt in it", async () => {
    const h = harness(seat => seat === SEAT_A.accountUserId
      ? new Response("{\"error\":\"rate limited\"}", { status: 429, headers: { "content-type": "application/json" } })
      : sse(CREATED, DELTA))

    const response = await h.backend.handle(responsesRequest(inbound()))
    const text = await response.text()

    expect(text).toBe(CREATED + DELTA)
    expect(text).not.toContain("rate limited")
  })

  it("gives a refused credential's request to the next seat too", async () => {
    const h = harness(seat => seat === SEAT_A.accountUserId
      ? new Response("{}", { status: 401, headers: { "content-type": "application/json" } })
      : sse(CREATED, DELTA))

    const response = await h.backend.handle(responsesRequest(inbound()))

    expect(response.status).toBe(200)
    expect(h.benched).toEqual([{ seat: SEAT_A.accountUserId, kind: "requires_reauth" }])
  })

  it("fails over on a response.failed hiding behind the preamble", async () => {
    // The reason Task 7 exists: this arrives as HTTP 200 with a healthy-looking
    // first frame, so a status check or a first-frame check both call it fine.
    const h = harness(seat => seat === SEAT_A.accountUserId
      ? sse(CREATED, FAILED)
      : sse(CREATED, DELTA))

    const response = await h.backend.handle(responsesRequest(inbound()))

    expect(response.status).toBe(200)
    expect(await response.text()).toBe(CREATED + DELTA)
    expect(h.attempts).toEqual([SEAT_A.accountUserId, SEAT_B.accountUserId])
    expect(h.benched).toEqual([{ seat: SEAT_A.accountUserId, kind: "stream_failed" }])
  })

  it("skips a seat whose credentials cannot be produced, without benching it", async () => {
    // A seat mid-reauth has no usable token. It is not this request's business
    // to bench it - the refresher already reported it - but the request must
    // still be served by somebody.
    const h = harness(() => sse(CREATED, DELTA), ["seat-unknown-to-the-store", SEAT_B.accountUserId])

    const response = await h.backend.handle(responsesRequest(inbound()))

    expect(response.status).toBe(200)
    expect(h.attempts).toEqual([SEAT_B.accountUserId])
    expect(h.benched).toEqual([])
  })
})

describe("rotation - what must NOT be retried", () => {
  it("does not retry a failure that arrives after output the client has seen", async () => {
    // Task 7 Step 2. The client holds a delta already; serving the same turn
    // from a second account bills twice and delivers the work twice.
    const h = harness(() => sse(CREATED, DELTA, FAILED))

    const response = await h.backend.handle(responsesRequest(inbound()))

    expect(h.attempts).toEqual([SEAT_A.accountUserId])
    expect(h.benched).toEqual([])
    expect(await response.text()).toBe(CREATED + DELTA + FAILED)
  })

  it("does not retry a tool call followed by a failure", async () => {
    const toolCall = "event: response.output_item.added\ndata: {\"type\":\"response.output_item.added\"}\n\n"
    const h = harness(() => sse(CREATED, toolCall, FAILED))

    await h.backend.handle(responsesRequest(inbound()))

    expect(h.attempts).toEqual([SEAT_A.accountUserId])
    expect(h.benched).toEqual([])
  })

  it("passes a mid-content transport drop through rather than yanking the stream", async () => {
    const h = harness(() => dropsAfter(CREATED, DELTA))

    const response = await h.backend.handle(responsesRequest(inbound()))

    expect(h.attempts).toEqual([SEAT_A.accountUserId])
    expect(h.benched).toEqual([])
    // The bytes already delivered reach the client; the break reaches it as a
    // broken stream, which is what actually happened.
    await expect(response.text()).rejects.toThrow()
  })

  it("treats a provider 5xx as the provider's problem, not the seat's", async () => {
    // Rotation routes around an ACCOUNT problem. A provider-wide outage is not
    // one, and trying all six seats would multiply load during an incident
    // while benching six healthy accounts.
    const h = harness(() => new Response("{}", { status: 503, headers: { "content-type": "application/json" } }))

    const response = await h.backend.handle(responsesRequest(inbound()))

    expect(response.status).toBe(503)
    expect(h.attempts).toEqual([SEAT_A.accountUserId])
    expect(h.benched).toEqual([])
  })
})

describe("rotation - when nothing can serve", () => {
  it("makes no request at all once every owned seat is benched", async () => {
    const h = harness(() => sse(CREATED, DELTA), [])

    const response = await h.backend.handle(responsesRequest(inbound()))
    const body = await response.json() as { error?: { type?: string; message?: string } }

    expect(response.status).toBe(503)
    expect(h.attempts).toEqual([])
    // Says which provider ran out. "No account available" with no provider named
    // reads, to an operator, exactly like a Claude problem.
    expect(body.error?.message).toContain("ChatGPT")
  })

  it("returns the last seat's own answer once every seat has been tried", async () => {
    // Not a synthesized error: the provider's own 429 carries a status and
    // whatever retry information it chose to send, and inventing a replacement
    // would discard both.
    const h = harness(() => new Response("{\"error\":\"spent\"}", {
      status: 429,
      headers: { "content-type": "application/json" },
    }))

    const response = await h.backend.handle(responsesRequest(inbound()))

    expect(response.status).toBe(429)
    expect(h.attempts).toEqual([SEAT_A.accountUserId, SEAT_B.accountUserId])
    expect(h.benched).toEqual([
      { seat: SEAT_A.accountUserId, kind: "rate_limited" },
      { seat: SEAT_B.accountUserId, kind: "rate_limited" },
    ])
  })

  it("never reports a seat as having served when none did", async () => {
    const h = harness(() => new Response("{}", { status: 429 }))

    await h.backend.handle(responsesRequest(inbound()))

    expect(h.served).toEqual([])
  })
})

describe("rotation - containment survives it", () => {
  it("sends each attempt with its own seat's credentials and scope", async () => {
    const seen: Array<{ authorization: string | null; account: string | null }> = []
    const backend = createChatGptBackend<Request>({
      inboundRequest: context => context,
      candidateSeats: () => [SEAT_A.accountUserId, SEAT_B.accountUserId],
      seatCredentials: id => BY_SEAT[id] ?? null,
      benchSeat: () => {},
      fetchImpl: async (_url, init) => {
        const headers = new Headers(init.headers)
        seen.push({
          authorization: headers.get("authorization"),
          account: headers.get("chatgpt-account-id"),
        })
        return seen.length === 1
          ? new Response("{}", { status: 429 })
          : sse(CREATED, DELTA)
      },
    })

    await backend.handle(responsesRequest(inbound()))

    expect(seen).toEqual([
      { authorization: `Bearer ${SEAT_A.accessToken}`, account: SHARED_ACCOUNT_ID },
      { authorization: `Bearer ${SEAT_B.accessToken}`, account: SHARED_ACCOUNT_ID },
    ])
  })

  it("posts the client's original bytes on every attempt, not just the first", async () => {
    const bodies: Array<unknown> = []
    const h = harness(seat => {
      return seat === SEAT_A.accountUserId
        ? new Response("{}", { status: 429 })
        : sse(CREATED, DELTA)
    })
    const withCapture = createChatGptBackend<Request>({
      inboundRequest: context => context,
      candidateSeats: () => [SEAT_A.accountUserId, SEAT_B.accountUserId],
      seatCredentials: id => BY_SEAT[id] ?? null,
      benchSeat: () => {},
      fetchImpl: async (_url, init) => {
        bodies.push(init.body)
        return bodies.length === 1 ? new Response("{}", { status: 429 }) : sse(CREATED, DELTA)
      },
    })

    await withCapture.handle(responsesRequest(inbound()))
    void h

    expect(bodies).toEqual([BODY, BODY])
  })

  it("still forwards no provider cookie to the client after a failover", async () => {
    const h = harness(seat => seat === SEAT_A.accountUserId
      ? new Response("{}", { status: 429 })
      : new Response(CREATED + DELTA, {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            "set-cookie": "session=provider-secret",
            "x-codex-turn-state": "gAAAAABopaque",
          },
        }))

    const response = await h.backend.handle(responsesRequest(inbound()))

    expect(response.headers.get("set-cookie")).toBeNull()
    expect(response.headers.get("x-codex-turn-state")).toBeNull()
  })
})

/**
 * The provider states this seat's remaining allowance on the response it just
 * answered with - refusals and successes alike. Reading it there is what lets
 * a spent seat be benched from the turn it COMPLETED rather than from the next
 * turn it fails, which is one wasted request per account per window.
 */
describe("rotation - what the answer says about the seat that gave it", () => {
  const SPENT: Record<string, string> = {
    "x-codex-primary-used-percent": "100",
    "x-codex-primary-window-minutes": "10080",
    "x-codex-primary-reset-at": String(Math.floor((Date.now() + 3 * 86_400_000) / 1000)),
    "x-codex-secondary-window-minutes": "0",
    "x-codex-secondary-reset-at": "",
  }

  function observing(reply: (seat: string) => Response) {
    const benched: Array<{ seat: string; weeklySpent: boolean }> = []
    const noted: Array<{ seat: string; weeklySpent: boolean }> = []
    const record = (seat: string, limits: ChatGptRateLimit | null) => ({
      seat,
      weeklySpent: limits?.primary_window?.used_percent === 100
        && limits?.primary_window?.limit_window_seconds === 604_800,
    })

    const backend = createChatGptBackend<Request>({
      inboundRequest: context => context,
      candidateSeats: () => [SEAT_A.accountUserId, SEAT_B.accountUserId],
      seatCredentials: id => BY_SEAT[id] ?? null,
      benchSeat: (id, _failure, limits) => { benched.push(record(id, limits)) },
      noteSeatLimits: (id, limits) => { noted.push(record(id, limits)) },
      fetchImpl: async (_url, init) => {
        const bearer = new Headers(init.headers).get("authorization")?.replace("Bearer ", "") ?? ""
        return reply(BY_TOKEN[bearer]!)
      },
    })
    return { backend, benched, noted }
  }

  it("reports a spent window from a response that SERVED, before it ever fails", async () => {
    const h = observing(() => new Response(CREATED + DELTA, {
      status: 200,
      headers: { "content-type": "text/event-stream", ...SPENT },
    }))

    await h.backend.handle(responsesRequest(inbound()))

    expect(h.noted).toEqual([{ seat: SEAT_A.accountUserId, weeklySpent: true }])
    expect(h.benched).toEqual([])
  })

  it("hands the refusal's own window to the bench, so the seat sits out until it frees", async () => {
    const h = observing(seat => seat === SEAT_A.accountUserId
      ? new Response("{}", { status: 429, headers: { "content-type": "application/json", ...SPENT } })
      : new Response(CREATED + DELTA, { status: 200, headers: { "content-type": "text/event-stream" } }))

    await h.backend.handle(responsesRequest(inbound()))

    expect(h.benched).toEqual([{ seat: SEAT_A.accountUserId, weeklySpent: true }])
    // The seat that served said nothing about its allowance, which is not the
    // same as saying it is spent.
    expect(h.noted).toEqual([{ seat: SEAT_B.accountUserId, weeklySpent: false }])
  })

  it("says nothing about a seat whose answer carried no limit headers", async () => {
    const h = observing(() => new Response("{}", { status: 429, headers: { "content-type": "application/json" } }))

    await h.backend.handle(responsesRequest(inbound()))

    expect(h.benched).toEqual([
      { seat: SEAT_A.accountUserId, weeklySpent: false },
      { seat: SEAT_B.accountUserId, weeklySpent: false },
    ])
  })
})
