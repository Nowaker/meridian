/**
 * `meridian profile ...` on ChatGPT seats (chatgpt/seatCli.ts): every command
 * goes through the running instance's routes, never the store.
 */
import { describe, expect, it } from "bun:test"
import { findSeat, loginChatGptSeat, printChatGptSeats, removeChatGptSeat, renameChatGptSeat, type SeatCliIo } from "../proxy/chatgpt/seatCli"

function io(answers: Record<string, Array<{ status: number; body: unknown }>>) {
  const calls: Array<{ path: string; body: unknown }> = []
  const out: string[] = []
  const err: string[] = []
  const fake: SeatCliIo = {
    fetch: async (url, init) => {
      const path = new URL(url).pathname + new URL(url).search
      calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      const key = Object.keys(answers).find(prefix => path.startsWith(prefix))
      const queue = key ? answers[key]! : []
      const next = queue.length > 1 ? queue.shift()! : queue[0]
      if (!next) throw new Error("connection refused")
      return Response.json(next.body, { status: next.status })
    },
    log: line => out.push(line),
    error: line => err.push(line),
    sleep: async () => {},
  }
  return { fake, calls, out, err }
}

describe("ChatGPT seats from the CLI", () => {
  it("removes a seat through /profiles/remove and says where the active pointer went", async () => {
    const h = io({ "/profiles/remove": [{ status: 200, body: { success: true, profile: "dead-one", provider: "chatgpt", activeProfile: "two" } }] })
    expect(await removeChatGptSeat("dead-one", h.fake)).toBe(true)
    expect(h.calls).toEqual([{ path: "/profiles/remove", body: { profile: "dead-one" } }])
    expect(h.out.join("\n")).toContain("Active ChatGPT seat is now \"two\"")
  })

  it("reports the instance's refusal, and an instance that is not running", async () => {
    const refused = io({ "/profiles/remove": [{ status: 409, body: { error: "oc-codex-multi-auth owns it" } }] })
    expect(await removeChatGptSeat("x", refused.fake)).toBe(false)
    expect(refused.err.join("\n")).toContain("oc-codex-multi-auth owns it")
    const down = io({})
    expect(await renameChatGptSeat("a", "b", down.fake)).toBe(false)
    expect(down.err.join("\n")).toContain("Is it running?")
  })

  it("renames through /profiles/rename and names the alias left behind", async () => {
    const h = io({ "/profiles/rename": [{ status: 200, body: { success: true, from: "a", to: "b", aliases: ["a"], provider: "chatgpt" } }] })
    expect(await renameChatGptSeat("a", "b", h.fake)).toBe(true)
    expect(h.out.join("\n")).toContain("\"a\" are served by \"b\"")
  })

  it("signs a seat in again by device code, polling until the instance says it is done", async () => {
    const h = io({
      "/profiles/chatgpt/connect/device": [{ status: 200, body: { connectId: "c1", userCode: "ABCD-1234", verificationUrl: "https://auth.openai.com/codex/device" } }],
      "/profiles/chatgpt/connect/status": [{ status: 200, body: { status: "waiting" } }, { status: 200, body: { status: "completed", email: "s@x.test" } }],
    })
    expect(await loginChatGptSeat("dead-one", h.fake, 0)).toBe(true)
    expect(h.calls[0]).toEqual({ path: "/profiles/chatgpt/connect/device", body: { profile: "dead-one" } })
    expect(h.out.join("\n")).toContain("ABCD-1234")
    expect(h.out.join("\n")).toContain("signed in again as s@x.test")
  })

  it("reports a re-login refused as another account", async () => {
    const h = io({
      "/profiles/chatgpt/connect/device": [{ status: 200, body: { connectId: "c1", userCode: "C", verificationUrl: "https://auth.openai.com/codex/device" } }],
      "/profiles/chatgpt/connect/status": [{ status: 200, body: { status: "failed", message: "You signed in as other@x.test" } }],
    })
    expect(await loginChatGptSeat("dead-one", h.fake, 0)).toBe(false)
    expect(h.err.join("\n")).toContain("You signed in as other@x.test")
  })

  it("finds a seat by its id or a former id, and lists the free seat's deferral", () => {
    const seats = [{ id: "of-n-p20-gpt", aliases: ["oferty-c487c4"] }, { id: "free-one", planName: "Free", planTier: "free" as const, isActive: true, loggedIn: true, email: "f@x.test", freeSeatDeferred: { servedFirstBy: ["of-n-p20-gpt"] } }]
    expect(findSeat(seats, "oferty-c487c4")?.id).toBe("of-n-p20-gpt")
    expect(findSeat(seats, "nope")).toBeUndefined()
    const h = io({})
    printChatGptSeats(seats, h.fake)
    const text = h.out.join("\n")
    expect(text).toContain("free-one")
    expect(text).toContain("(Free, free)")
    expect(text).toContain("[active]")
    expect(text).toContain("of-n-p20-gpt serves unpinned work first")
  })
})
