/**
 * Task 2 — resolving the provider from the requested model.
 *
 * The safety property under test is asymmetric, and deliberately so: an
 * unrecognized model resolves to "anthropic". Every request that exists today
 * therefore keeps its provider, and the only way to reach a non-Claude
 * upstream is to name a model on the pinned list. A matcher that guessed
 * (say, anything starting "gpt-") would route a model nobody has verified at
 * a credential set nobody intended.
 *
 * The pinned list is the model families present in the live account pool.
 */
import { describe, test, expect } from "bun:test"
import { providerForModel } from "../proxy/upstream/provider"
import { createProxyServer } from "../proxy/server"

const OPENAI_MODELS = [
  "gpt-5-codex",
  "codex-max",
  "codex",
  "gpt-6-astra",
  "gpt-daybreak-blue",
  "gpt-daybreak-red",
  "gpt-5.6-cyber",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.4-pro",
  "gpt-5.2",
  "gpt-5.1",
]

const CLAUDE_MODELS = [
  "sonnet",
  "sonnet[1m]",
  "opus",
  "opus[1m]",
  "haiku",
  "fable",
  "fable[1m]",
  "mythos",
  "mythos[1m]",
  "claude-sonnet-5",
  "claude-opus-4-8",
  "claude-mythos-5-1",
]

describe("providerForModel — pinned GPT families", () => {
  for (const model of OPENAI_MODELS) {
    test(`${model} resolves to openai`, () => {
      expect(providerForModel(model)).toBe("openai")
    })
  }

  test("matching is case- and whitespace-insensitive", () => {
    expect(providerForModel("  GPT-5.6-Sol  ")).toBe("openai")
    expect(providerForModel("CODEX")).toBe("openai")
  })
})

describe("providerForModel — Claude stays Claude", () => {
  for (const model of CLAUDE_MODELS) {
    test(`${model} resolves to anthropic`, () => {
      expect(providerForModel(model)).toBe("anthropic")
    })
  }
})

describe("providerForModel — anything unrecognized defaults to anthropic", () => {
  test("absent, null and empty models", () => {
    expect(providerForModel(undefined)).toBe("anthropic")
    expect(providerForModel(null)).toBe("anthropic")
    expect(providerForModel("")).toBe("anthropic")
    expect(providerForModel("   ")).toBe("anthropic")
  })

  test("a GPT model that is NOT on the pinned list stays on Claude", () => {
    // gpt-4o is not in any live pool account. Meridian already serves it by
    // mapping it onto Claude, and nothing in this task may change that.
    expect(providerForModel("gpt-4o")).toBe("anthropic")
    expect(providerForModel("gpt-3.5-turbo")).toBe("anthropic")
  })

  test("a provider-qualified name is not unwrapped", () => {
    // Exact-match by design. Unwrapping prefixes would widen the surface that
    // can reach a non-Claude credential on the strength of a guess; failing
    // closed onto Claude is the conservative direction.
    expect(providerForModel("openai/gpt-5.6-sol")).toBe("anthropic")
  })

  test("a family name is not matched as a prefix or substring", () => {
    expect(providerForModel("gpt-5.6-sol-experimental")).toBe("anthropic")
    expect(providerForModel("not-codex")).toBe("anthropic")
  })
})

describe("dispatch — a pinned GPT model leaves Claude only where ChatGPT is owned", () => {
  const boot = () => createProxyServer({ port: 0, host: "127.0.0.1", silent: true })

  const bootOwningChatGpt = () => createProxyServer({
    port: 0,
    host: "127.0.0.1",
    silent: true,
    profiles: [
      { id: "claude-personal", type: "claude-max" },
      { id: "chatgpt-work", provider: "openai", type: "chatgpt-oauth", accountUserId: "user_AAA" },
    ],
  })

  const post = (path: string, body: unknown) =>
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })

  // The behavior change is scoped to an instance that OWNS ChatGPT accounts
  // (D6). There, a Codex CLI request naming gpt-5-codex stops being translated
  // onto Claude and says the model is unserved rather than quietly borrowing a
  // Claude account. Task 6 turns this 404 into a served ChatGPT request; the
  // half that must survive that change is that Claude is not the answer.
  test("/v1/responses with gpt-5-codex reports the model as unserved", async () => {
    const { app } = bootOwningChatGpt()
    const res = await app.fetch(post("/v1/responses", { model: "gpt-5-codex", input: "hi" }))

    expect(res.status).toBe(404)
    const body = await res.json() as { error?: { type?: string; message?: string } }
    expect(body.error?.type).toBe("not_found_error")
    expect(body.error?.message).toContain("gpt-5-codex")
  })

  test("/v1/messages with gpt-5-codex reports the model as unserved", async () => {
    const { app } = bootOwningChatGpt()
    const res = await app.fetch(post("/v1/messages", {
      model: "gpt-5-codex",
      messages: [{ role: "user", content: "hi" }],
    }))

    expect(res.status).toBe(404)
    const body = await res.json() as { error?: { type?: string; message?: string } }
    expect(body.error?.type).toBe("not_found_error")
    expect(body.error?.message).toContain("gpt-5-codex")
  })

  test("a Claude model still reaches the translation layer untouched", async () => {
    const { app } = boot()
    const res = await app.fetch(post("/v1/responses", { model: "claude-sonnet-5" }))

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: { type: "invalid_request_error", message: "input: Field required", code: null },
    })
  })

  test("an unrecognized model still reaches the translation layer untouched", async () => {
    const { app } = boot()
    const res = await app.fetch(post("/v1/responses", { model: "gpt-4o" }))

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: { type: "invalid_request_error", message: "input: Field required", code: null },
    })
  })

  test("a malformed body still produces the canonical 400, not a dispatch error", async () => {
    // The dispatch peek reads the body before the queue wrapper does. If that
    // peek consumed the stream or leaked its own parse failure, this canonical
    // envelope would change shape.
    const { app } = boot()
    const res = await app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ this is not json",
    }))

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      type: "error",
      error: { type: "invalid_request_error", message: "Request body must be valid JSON" },
    })
  })
})

/**
 * The gate (D6). `providerForModel` is consulted for dispatch only on an
 * instance that OWNS ChatGPT accounts. An instance that owns none keeps
 * upstream's Codex-CLI-on-Claude behavior byte for byte, which is what
 * meridian-dev and every existing deployment are.
 *
 * Both directions are proved without the Agent SDK by using the translation
 * layer's own "input: Field required" as the marker for "reached the Claude
 * path". A request dispatched away never produces it.
 */
describe("provider dispatch — instance ownership gate", () => {
  const CHATGPT_PROFILE = {
    id: "chatgpt-work",
    provider: "openai" as const,
    type: "chatgpt-oauth" as const,
    accountUserId: "user_gate_AAA",
  }
  const CLAUDE_PROFILE = { id: "claude-personal", type: "claude-max" as const }

  const responses = (body: unknown) =>
    new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })

  test("owning no ChatGPT account leaves a GPT model on the translate-to-Claude path", async () => {
    const { app } = createProxyServer({
      port: 0,
      host: "127.0.0.1",
      silent: true,
      profiles: [CLAUDE_PROFILE],
    })
    const res = await app.fetch(responses({ model: "gpt-5-codex" }))

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: { type: "invalid_request_error", message: "input: Field required", code: null },
    })
  })

  test("a Claude model still reaches Claude on an enabled instance", async () => {
    const { app } = createProxyServer({
      port: 0,
      host: "127.0.0.1",
      silent: true,
      profiles: [CLAUDE_PROFILE, CHATGPT_PROFILE],
    })
    const res = await app.fetch(responses({ model: "claude-sonnet-5" }))

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: { type: "invalid_request_error", message: "input: Field required", code: null },
    })
  })

  test("an unpinned model stays on Claude even on an enabled instance", async () => {
    const { app } = createProxyServer({
      port: 0,
      host: "127.0.0.1",
      silent: true,
      profiles: [CLAUDE_PROFILE, CHATGPT_PROFILE],
    })
    const res = await app.fetch(responses({ model: "gpt-4o" }))

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: { type: "invalid_request_error", message: "input: Field required", code: null },
    })
  })
})
