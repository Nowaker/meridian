/**
 * Task 1 — the provider-neutral UpstreamBackend seam.
 *
 * The new behavior: a registry that refuses an unregistered provider with a
 * TYPED error instead of quietly handing back the only backend it happens to
 * have. That silent fallback is R8 (a GPT request served by a Claude
 * account), so "does not return the Anthropic backend" is asserted
 * explicitly rather than left implied by the throw.
 *
 * The other half of this task — proving the two spliced endpoints still
 * answer exactly as they did — lives in upstream-seam-characterization.test.ts
 * because it has to run GREEN against unmodified code, which it cannot do
 * from a file that imports these not-yet-existing modules.
 */
import { describe, test, expect } from "bun:test"
import {
  createUpstreamRegistry,
  UnknownProviderError,
  type UpstreamBackend,
} from "../proxy/upstream/backend"
import { createAnthropicBackend } from "../proxy/upstream/anthropic"

/** A backend whose only job is to be identifiable in an assertion. */
function stubBackend<Ctx>(provider: "anthropic" | "openai", marker: string): UpstreamBackend<Ctx> {
  return {
    provider,
    handle: async () => new Response(marker),
  }
}

describe("upstream registry", () => {
  test("returns the backend registered for a provider", async () => {
    const registry = createUpstreamRegistry<string>()
    registry.registerBackend(stubBackend("anthropic", "claude"))

    const backend = registry.backendFor("anthropic")
    expect(backend.provider).toBe("anthropic")
    expect(await (await backend.handle({ context: "ctx", endpoint: "messages", route: "/v1/messages" })).text())
      .toBe("claude")
  })

  test("throws a typed UnknownProviderError for an unregistered provider", () => {
    const registry = createUpstreamRegistry<string>()
    registry.registerBackend(stubBackend("anthropic", "claude"))

    expect(() => registry.backendFor("openai")).toThrow(UnknownProviderError)
    try {
      registry.backendFor("openai")
      throw new Error("expected backendFor to throw")
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownProviderError)
      expect((error as UnknownProviderError).provider).toBe("openai")
    }
  })

  test("NEVER falls back to another provider's backend (R8)", () => {
    const registry = createUpstreamRegistry<string>()
    const anthropic = stubBackend<string>("anthropic", "claude")
    registry.registerBackend(anthropic)

    let returned: unknown
    try {
      returned = registry.backendFor("openai")
    } catch {
      returned = undefined
    }
    expect(returned).toBeUndefined()
  })

  test("reports which providers are registered", () => {
    const registry = createUpstreamRegistry<string>()
    expect(registry.registeredProviders()).toEqual([])
    registry.registerBackend(stubBackend("anthropic", "claude"))
    expect(registry.registeredProviders()).toEqual(["anthropic"])
  })

  test("registries are independent instances, not process-global state", () => {
    const a = createUpstreamRegistry<string>()
    const b = createUpstreamRegistry<string>()
    a.registerBackend(stubBackend("anthropic", "claude"))

    expect(a.registeredProviders()).toEqual(["anthropic"])
    expect(b.registeredProviders()).toEqual([])
    expect(() => b.backendFor("anthropic")).toThrow(UnknownProviderError)
  })
})

describe("anthropic backend", () => {
  test("dispatches on the inbound endpoint and forwards the route string", async () => {
    const seen: string[] = []
    const backend = createAnthropicBackend<string>({
      messages: async (request) => { seen.push(`messages:${request.route}`); return new Response("m") },
      responses: async (request) => { seen.push(`responses:${request.route}`); return new Response("r") },
    })

    expect(backend.provider).toBe("anthropic")
    await backend.handle({ context: "c", endpoint: "messages", route: "/v1/messages" })
    await backend.handle({ context: "c", endpoint: "messages", route: "/messages" })
    await backend.handle({ context: "c", endpoint: "responses", route: "/v1/responses" })

    expect(seen).toEqual(["messages:/v1/messages", "messages:/messages", "responses:/v1/responses"])
  })
})
