/**
 * Task 1 — characterization of the two endpoints the UpstreamBackend seam is
 * spliced into.
 *
 * These are written to pass against UNMODIFIED code and to keep passing after
 * the seam lands. That order is the whole point: a test that has only ever
 * run against the new code proves the new code is self-consistent, not that
 * it kept its promise.
 *
 * The cases are deliberately the ones reachable WITHOUT the Agent SDK, since
 * those are exactly what the refactor puts at risk — it moves route
 * registration, adds a dispatch hop ahead of the queue wrapper, and (from
 * Task 2) reads the request body before the handler does. Route identity,
 * body-parse ordering and error envelope shape are all pinned here.
 */
import { describe, test, expect } from "bun:test"
import { createProxyServer } from "../proxy/server"

const boot = () => createProxyServer({ port: 0, host: "127.0.0.1", silent: true })

const post = (path: string, body: string) =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  })

describe("seam characterization — /v1/messages", () => {
  test("rejects a malformed body with the canonical 400 envelope", async () => {
    const { app } = boot()
    const res = await app.fetch(post("/v1/messages", "{ this is not json"))

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      type: "error",
      error: { type: "invalid_request_error", message: "Request body must be valid JSON" },
    })
  })

  test("the /messages alias reaches the same handler with the same 400", async () => {
    const { app } = boot()
    const res = await app.fetch(post("/messages", "{ this is not json"))

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      type: "error",
      error: { type: "invalid_request_error", message: "Request body must be valid JSON" },
    })
  })
})

describe("seam characterization — /v1/responses", () => {
  test("rejects a body with no input", async () => {
    const { app } = boot()
    const res = await app.fetch(post("/v1/responses", JSON.stringify({ model: "gpt-5-codex" })))

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: { type: "invalid_request_error", message: "input: Field required", code: null },
    })
  })

  test("rejects a body with input but no model", async () => {
    const { app } = boot()
    const res = await app.fetch(post("/v1/responses", JSON.stringify({ input: "hello" })))

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: { type: "invalid_request_error", message: "model: Field required", code: null },
    })
  })
})
