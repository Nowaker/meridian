/**
 * Task 6 - the ChatGPT backend, serving /v1/responses as a raw passthrough.
 *
 * "Raw" is the whole design. Meridian's existing Responses support translates
 * INTO Anthropic and back out again, because its upstream is Claude. Here the
 * upstream already speaks Responses, so translating would mean lowering a
 * format into a lossier one and lifting it back for no reason - and every
 * lossy step is somewhere a tool call or a reasoning block quietly changes
 * shape. The bytes go out as they arrived and come back as they were sent.
 *
 * The other half is containment. Nothing the client sends may reach ChatGPT
 * except the body, and nothing ChatGPT sends back may reach the client except
 * the stream: a client's own credentials must not be forwarded to a provider
 * it is not authenticated against, and a provider's cookies must not be set
 * on a client that never spoke to it.
 */
import { describe, expect, it } from "bun:test"
import { createChatGptBackend } from "../proxy/chatgpt/backend"
import type { UpstreamRequest } from "../proxy/upstream/backend"

const ACCOUNT = {
  accountUserId: "seat-C0RSu9",
  accountId: "05cd9f04-1111-2222-3333-444444989a40",
  accessToken: "access-token-for-this-seat",
}

const BODY = JSON.stringify({ model: "gpt-5-codex", input: "hello", prompt_cache_key: "conv-9f04" })

interface RecordedCall {
  url: string
  init: RequestInit
}

function inbound(headers: Record<string, string> = {}, body = BODY): Request {
  return new Request("http://127.0.0.1:3459/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  })
}

function responsesRequest(request: Request): UpstreamRequest<Request> {
  return { context: request, endpoint: "responses", route: "/v1/responses" }
}

function backendWith(
  reply: () => Response | Promise<Response>,
  account: typeof ACCOUNT | null = ACCOUNT,
) {
  const calls: RecordedCall[] = []
  const backend = createChatGptBackend<Request>({
    inboundRequest: context => context,
    // A pool of exactly one, so these keep testing what ONE request does to
    // the wire. Rotation across several seats is chatgpt-rotation.test.ts.
    candidateSeats: () => account ? [account.accountUserId] : [],
    seatCredentials: () => account,
    benchSeat: () => {},
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return reply()
    },
  })
  return { backend, calls }
}

function sseStream(chunks: string[]): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder()
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  )
}

describe("chatGptBackend - identity", () => {
  it("answers for the openai provider", () => {
    const { backend } = backendWith(() => sseStream([]))

    expect(backend.provider).toBe("openai")
  })
})

describe("chatGptBackend - what leaves for the provider", () => {
  it("posts the untouched body to the constant endpoint with this account's credentials", async () => {
    const { backend, calls } = backendWith(() => sseStream(["data: {}\n\n"]))

    await backend.handle(responsesRequest(inbound()))

    expect(calls).toHaveLength(1)
    const [call] = calls
    expect(call!.url).toBe("https://chatgpt.com/backend-api/codex/responses")
    expect(call!.init.method).toBe("POST")
    expect(call!.init.body).toBe(BODY)
    expect(call!.init.redirect).toBe("error")
    const sent = new Headers(call!.init.headers)
    expect(sent.get("authorization")).toBe(`Bearer ${ACCOUNT.accessToken}`)
    expect(sent.get("chatgpt-account-id")).toBe(ACCOUNT.accountId)
    expect(sent.get("conversation_id")).toBe("conv-9f04")
  })

  it("drops every inbound header and REPLACES the client's own credentials", async () => {
    const { backend, calls } = backendWith(() => sseStream(["data: {}\n\n"]))

    await backend.handle(responsesRequest(inbound({
      authorization: "Bearer client-supplied-token",
      "x-api-key": "client-supplied-key",
      cookie: "session=client-supplied",
      "x-meridian-profile": "some-profile",
      "x-unrecognized-junk": "junk",
    })))

    const sent = new Headers(calls[0]!.init.headers)
    // Replaced, never appended: Headers.get comma-joins duplicates, so an
    // appended client token would still be visible in this one value.
    expect(sent.get("authorization")).toBe(`Bearer ${ACCOUNT.accessToken}`)
    expect(sent.get("authorization")).not.toContain("client-supplied-token")
    for (const dropped of ["x-api-key", "cookie", "x-meridian-profile", "x-unrecognized-junk"]) {
      expect(sent.get(dropped)).toBeNull()
    }
  })
})

describe("chatGptBackend - what comes back for the client", () => {
  it("streams the Responses body through byte for byte", async () => {
    const frames = [
      "event: response.created\ndata: {\"type\":\"response.created\"}\n\n",
      "event: response.output_text.delta\ndata: {\"delta\":\"hel\"}\n\n",
      "event: response.output_text.delta\ndata: {\"delta\":\"lo\"}\n\n",
      "event: response.completed\ndata: {\"type\":\"response.completed\"}\n\n",
    ]
    const { backend } = backendWith(() => sseStream(frames))

    const response = await backend.handle(responsesRequest(inbound()))

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("text/event-stream")
    // Byte-identical: no Responses -> Anthropic translation on this path, so
    // no frame is renamed, reordered, merged or dropped.
    expect(await response.text()).toBe(frames.join(""))
  })

  it("preserves the upstream status without forwarding its cookies", async () => {
    const { backend } = backendWith(() => new Response("{\"error\":{}}", {
      status: 418,
      headers: {
        "content-type": "application/json",
        "set-cookie": "provider_session=leaked; Path=/",
        "x-provider-internal": "should-not-be-relayed",
      },
    }))

    const response = await backend.handle(responsesRequest(inbound()))

    expect(response.status).toBe(418)
    expect(response.headers.get("content-type")).toBe("application/json")
    // A client that never authenticated against chatgpt.com must not be
    // handed chatgpt.com's cookies by a proxy standing in the middle.
    expect(response.headers.get("set-cookie")).toBeNull()
    expect(response.headers.get("x-provider-internal")).toBeNull()
  })
})

describe("chatGptBackend - what it refuses", () => {
  it("refuses the Messages surface rather than sending an Anthropic body to ChatGPT", async () => {
    const { backend, calls } = backendWith(() => sseStream([]))

    const response = await backend.handle({
      context: inbound(),
      endpoint: "messages",
      route: "/v1/messages",
    })

    expect(response.status).toBe(404)
    expect(calls).toEqual([])
  })

  it("fails when no account can serve, and borrows nothing", async () => {
    const { backend, calls } = backendWith(() => sseStream([]), null)

    const response = await backend.handle(responsesRequest(inbound()))

    expect(response.status).toBe(503)
    expect(calls).toEqual([])
    const body = await response.json() as { error?: { message?: string } }
    expect(body.error?.message).toBeTruthy()
  })

  it("reports an upstream transport failure without leaking its detail", async () => {
    const { backend } = createChatGptBackendThatThrows()

    const response = await backend.handle(responsesRequest(inbound()))

    expect(response.status).toBe(502)
    expect(await response.text()).not.toContain("ECONNREFUSED at 10.0.0.1")
  })

  function createChatGptBackendThatThrows() {
    const backend = createChatGptBackend<Request>({
      inboundRequest: context => context,
      candidateSeats: () => [ACCOUNT.accountUserId],
      seatCredentials: () => ACCOUNT,
      benchSeat: () => {},
      fetchImpl: () => { throw new Error("ECONNREFUSED at 10.0.0.1") },
    })
    return { backend }
  }
})

describe("chatGptBackend - the body it is given has usually been read already", () => {
  // Measured, not assumed: Hono's `c.req.json()` resolves through `raw.json()`,
  // so once the dispatch seam has peeked at `model` to choose a provider, the
  // underlying Request answers `Body already used`. A backend that reaches for
  // that stream itself fails EVERY request that arrives through dispatch while
  // passing every test that hands it a fresh Request.
  it("serves when the host rebuilds the request it already consumed", async () => {
    const consumed = inbound()
    await consumed.text()

    const calls: RecordedCall[] = []
    const backend = createChatGptBackend<Request>({
      // What a host with a consumed original must be able to do: rebuild an
      // equivalent one. Rebuilding needs the bytes back, and getting them back
      // is asynchronous, so the contract has to permit it.
      inboundRequest: async () => inbound(),
      candidateSeats: () => [ACCOUNT.accountUserId],
      seatCredentials: () => ACCOUNT,
      benchSeat: () => {},
      fetchImpl: async (url, init) => {
        calls.push({ url, init })
        return sseStream(["event: response.created\ndata: {}\n\n"])
      },
    })

    const response = await backend.handle(responsesRequest(consumed))

    expect(response.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.init.body).toBe(BODY)
  })

  it("fails loudly rather than posting an empty body when the host hands over a spent request", async () => {
    // An empty body would be a real, billable request for nothing, answered
    // with a shape no client asked for. Refusing to send is the safe failure.
    const consumed = inbound()
    await consumed.text()

    const { backend, calls } = backendWith(() => sseStream([]))

    await expect(backend.handle(responsesRequest(consumed))).rejects.toThrow()
    expect(calls).toHaveLength(0)
  })
})
