# ChatGPT (Codex) Upstream Router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Codex client point `OPENAI_BASE_URL` at one long-lived Meridian and have its request served by a ChatGPT subscription that Meridian itself owns, rotates and refreshes - the same operational shape Meridian already gives Claude subscriptions.

**Architecture:** ChatGPT becomes a SECOND UPSTREAM BACKEND behind a new `UpstreamBackend` seam, with an INDEPENDENTLY OWNED account pool. Provider is resolved from the requested model before any profile, routing or session work, then dispatched to a backend that owns one complete provider request. The Claude backend wraps today's Agent SDK path unchanged. ChatGPT never enters the SDK path, never enters Claude's env construction, and never enters Claude's token refresh.

**Tech Stack:** TypeScript, Bun tests, Hono, `proper-lockfile` (or equivalent filesystem lease), ChatGPT Responses API over SSE, systemd user units, Caddy.

**Base commit:** every line reference in this document was verified against `upstream/main` at `9d22324`. Re-check them if that tip has moved; `src/proxy/server.ts` line numbers in particular drift on almost every upstream commit.

**Prerequisite:** this document is committed on a branch off `upstream/main`, where `src/proxy/codex/**` DOES NOT EXIST. That tree is the read-only ChatGPT usage-card integration, which lives on `feat/codex-account-usage` (7 commits, pushed to `origin`, not merged upstream). Tasks 1-11 do not depend on it. Task 12 does, and the "do not break the read-only guarantee" constraints below only bite once that branch is in the base. Branch the implementation off whichever base includes it, or treat Task 12 as blocked until it lands.

---

## What This Plan Is Not

This plan does NOT extend the read-only ChatGPT usage cards on `feat/codex-account-usage`. That feature reads `~/.opencode/oc-codex-multi-auth-accounts.json` and is structurally forbidden from writing it or refreshing a token (`src/proxy/codex/pool.ts`, pinned by `src/__tests__/codex-no-write.test.ts` - both on that branch, see Prerequisite). Every constraint in that module stays exactly as it is. This plan builds a SEPARATE, WRITABLE, Meridian-owned credential store beside it.

This plan does NOT retire upstream's Codex-CLI-on-Claude feature. F1 notes that `docs/superpowers/specs/2026-07-08-codex-responses-api-design.md` runs in the opposite direction to this one; both survive. An instance that owns no ChatGPT accounts keeps translating a GPT model name onto Claude exactly as it does today, byte-identically. See D6.

This plan does NOT propose putting the ChatGPT backend upstream. See "PR Decomposition": only the provider-neutral seam is upstream-shaped.

---

## Findings That Set The Shape

Each finding was verified against this tree at `9d22324` or against the live pool. They are recorded because three of them invalidate the obvious approach.

### F1. ChatGPT-as-upstream is greenfield, not wiring

Every existing OpenAI/Codex file is INBOUND - client-facing format translation. None makes a request to OpenAI:

- `src/proxy/adapters/codex.ts` - Codex CLI identity for `/v1/responses`. No fetch, no upstream URL.
- `src/proxy/adapters/openai.ts` - generic OpenAI-compatible client identity. No remote request.
- `src/proxy/openaiResponses.ts` - converts Responses -> Anthropic `/v1/messages`, and Anthropic SSE -> Responses. Forwards INTERNALLY.
- `src/proxy/openai.ts` - "Pure functions - no I/O"; produces `AnthropicRequestBody`.
- `src/proxy/transforms/codex.ts` - only forces `passthrough: true`.

`docs/superpowers/specs/2026-07-08-codex-responses-api-design.md` states the intent plainly: let the Codex CLI run ON CLAUDE via a Claude Max subscription. That is the opposite direction from this plan.

Confirmed mechanically:

```
grep -rn -E 'chatgpt\.com|api\.openai\.com|auth\.openai\.com' src --include='*.ts' | grep -v __tests__
(no matches)
```

**Consequence:** do not budget this as "wire up the existing Codex support". There is no outbound provider client in this repo at all.

### F2. oc-codex-multi-auth is a per-process provider hook, not a proxy

The operator's read that it is "just a router" is correct in spirit and important in detail. It is an OpenCode plugin that registers an auth provider whose `loader` returns an OpenAI SDK config carrying a custom `fetch` (`index.ts:1835-1853`, `index.ts:2060-2082`). The outbound inference call is made by the OpenCode process itself (`index.ts:2640-2652`). There is no listening socket, no forwarding process, and no shared server.

Architecturally that is the opposite of Meridian: N opencode processes each hold credentials, each rotate accounts, and each may refresh tokens. Meridian is one long-lived process every client points at. The operator's stated preference - "one app, always serving everybody" - is not a cosmetic difference here: it is what makes single-use refresh tokens safe, because it collapses N writers to one.

Its outbound contract, which the ChatGPT backend must reproduce:

| Element | Value | Source |
|---|---|---|
| Base | `https://chatgpt.com/backend-api` | `lib/constants.ts:22-23` |
| Path rewrite | `/responses` -> `/codex/responses` | `lib/constants.ts:57-61`, `lib/request/fetch-helpers.ts:774-791` |
| Auth | `Authorization: Bearer <ChatGPT OAuth access token>` | `fetch-helpers.ts:952-1012` |
| Account scope | `chatgpt-account-id: <accountId>` | same |
| Beta | `OpenAI-Beta: responses=experimental` | `lib/constants.ts:41-55` |
| Client identity | `originator: codex_cli_rs` (plus a responses-lite header for GPT-5.6 / GPT-6 Astra / Daybreak tiers) | `fetch-helpers.ts:952-1012` |
| Streaming | `accept: text/event-stream` | same |
| Cache affinity | `conversation_id` and `session_id`, both set to the prompt cache key | same |
| Org header | `openai-organization` deliberately OMITTED unless explicitly enabled | same |
| Inbound key | `x-api-key` is DELETED before send | same |

### F3. The inference upstream is not HTTP

`src/proxy/server.ts:3178` resolves `claudeExecutable` and calls the Claude Agent SDK, wrapped in Anthropic-specific retry. There is no completions URL in production `src/` at all.

**Consequence:** a provider-neutral boundary must abstract over "spawn the Claude Agent SDK" versus "HTTP POST to ChatGPT". That asymmetry is the single biggest obstacle in this plan, and it is why the seam has to sit HIGH (one complete provider request) rather than deep inside the SDK query loop.

### F4. Refresh tokens are single-use, and the existing lock is per-file

`lib/auth/auth.ts:17-24` names the endpoint `https://auth.openai.com/oauth/token`; `auth.ts:258-267` performs `grant_type=refresh_token`; `auth.ts:283-296` rotates to `json.refresh_token` when the provider returns one. The plugin's own comments state the hazard directly (`lib/storage/coordinated-refresh.ts:34-38`, `:287-294`, `:299-303`): the provider invalidates the exchanged token, so losing the replacement kills the account until a human logs in again.

Its coordination protocol is real and worth understanding before rejecting it:

- Lease file `<storagePath>.refresh.lock` (`lib/storage/transaction-lock.ts:101-106`), `proper-lockfile`, 60s stale, 5s heartbeat, 15 retries (`transaction-lock.ts:48-56`).
- Critical section (`coordinated-refresh.ts:278-335`): acquire lease -> re-read storage -> ADOPT if another process already rotated and left a live access token (`:117-126`) -> otherwise exchange -> commit through a storage transaction -> retry commit contention up to 3 times.
- Ordinary saves also adopt newer on-disk credentials by comparing `tokenRotatedAt` (`lib/accounts/persistence.ts:88-115`, `:252-289`).

Two properties matter for the decision in D3: the lease is **per accounts file, not per account** (`transaction-lock.ts:204-221`), and the whole protocol is versioned by a project Meridian does not control.

Measured on this machine during QA of the read-only feature: with Meridian completely idle, the pool took **80 writes in 12 seconds** from the operator's own opencode processes. The plugin is a continuously active writer, not an occasional one.

### F5. Meridian's own refresh dedup is in-process only

`src/proxy/tokenRefresh.ts:237-238`:

```ts
const inflightRefreshByKey = new Map<string, Promise<boolean>>()
const inflightRefreshByStore = new WeakMap<CredentialStore, Promise<boolean>>()
```

A `Map` and a `WeakMap` protect against concurrent refresh WITHIN one process. They protect against nothing across processes. Anthropic tolerates this because its refresh tokens are not single-use. ChatGPT will not.

The token endpoint and client id are hardcoded to Anthropic (`tokenRefresh.ts:27-28`, POST at `:290-295`). The only injected abstraction is `CredentialStore` - storage, not an OAuth-provider strategy. It is not pluggable as written.

### F6. Identity keys are not what they look like

`accountId` is NOT unique. In the operator's live pool, `accountId` `05cd9f04...` is shared by two different emails belonging to two different users. `accountUserId` is the only safe key. This is recorded in `CodexPoolAccount` in `src/proxy/codex/pool.ts` (on `feat/codex-account-usage`; see Prerequisite) and was confirmed against the real file.

The claim names are `chatgpt_account_user_id` (the seat) and `chatgpt_account_id` (the workspace), both under the `https://api.openai.com/auth` namespace - `lib/auth/token-utils.ts:432-436`, `:446-452`. An earlier revision of this finding named the seat claim `chatgpt_user_id`, which does not exist; a wrong claim name in the contract is worse than no claim name.

Worse, upstream ignores a mismatched scope header: a `GET /backend-api/wham/usage` sent with an `ChatGPT-Account-ID` that disagrees with the bearer token returns **HTTP 200 carrying the token's own account**, not an error. Any code that trusts the response without comparing `account_id` AND the token's `chatgpt_account_user_id` claim will silently attribute one account's state to another. Verified live against all six accounts: a request whose scope header MATCHES the token always returns that account, so a test that only ever sends matching headers proves nothing - the validation test must send a deliberately mismatched header and assert the 200 is rejected.

### F7. `MERIDIAN_CONFIG_DIR` does not isolate an instance; `HOME` does

Verified empirically: a Meridian started with `MERIDIAN_CONFIG_DIR` pointed at an EMPTY directory still reported `loggedIn: true` for the ambient `~/.claude` account, because `src/proxy/profiles.ts:187-192` falls back to `{ id: DEFAULT_PROFILE_ID, type: "claude-max", env: {} }` and the SDK subprocess then resolves the host credentials.

`MERIDIAN_CONFIG_DIR` is honoured by only three modules (`settings.ts:29-32`, `sdkFeatures.ts:137`, `priorityAttestation.ts:45`). It is IGNORED by, among others:

`adapterInstances.ts:33`, `profileCli.ts:22`, `profileCli.ts:23`, `profileCli.ts:244`, `profiles.ts:23`, `profiles.ts:225`, `sessionStore.ts:656-657`, `server.ts:872-873`, `telemetry/pricingStore.ts:32`, `telemetry/index.ts:9`, `setup.ts:77`, and the credential writer itself at `tokenRefresh.ts:30-31`.

`systemd/user/meridian-og.service` in the operator's dotfiles already documents this conclusion and overrides `HOME` instead.

### F8. The outbound contract, measured against the provider

Every other finding here was read out of the reference implementation's source. This one is different in kind: it was captured by firing Meridian's own `buildCodexRequest` at `https://chatgpt.com/backend-api/codex/responses` for real.

**Scope, stated so it is not over-read.** 2026-09-05. Four requests, ONE account (`e1dde4`, `plan_type: pro`), model `gpt-5.6-sol`. An existing access token read from the pool; no refresh, no write, no other account touched. Probe at `opencode-tools/tmp/ai-codex-wire-probe.ts`, which imports `readFileSync` and no write primitive.

**F8.1 The contract in F2 is accepted as built.** HTTP 200, full stream, usage block. `authorization`, `chatgpt-account-id`, `openai-beta: responses=experimental`, `originator: codex_cli_rs`, `accept: text/event-stream`, `conversation_id` + `session_id` from the cache key, `openai-organization` absent. This was the largest unproven assumption in the plan and it is no longer an assumption.

**F8.2 `x-openai-internal-codex-responses-lite` is a MODE, not a hint.** Sent with an ordinary body it is refused, and each refusal names the next precondition: `requires reasoning.context to be all_turns`, then `requires parallel_tool_calls to be false`. Selecting it from the model name alone therefore 400s EVERY request on all seven lite-set tiers - including `gpt-5.6-sol`, and including this repo's own captured Codex 0.143 shape (`parallel_tool_calls: true`, no `reasoning.context`; see the "Verified wire format" section of `docs/superpowers/specs/2026-07-08-codex-responses-api-design.md`). Fixed by sending it only when the client's body ALREADY satisfies both. The body is never adjusted to fit: both preconditions are behavioural, and rewriting them would break the byte-for-byte passthrough Task 6 Step 4 pins.

**F8.3 The success SSE sequence, observed.** Nine events, no `[DONE]` sentinel:

`response.created` -> `response.in_progress` -> `response.output_item.added` -> `response.content_part.added` -> `response.output_text.delta` -> `response.output_text.done` -> `response.content_part.done` -> `response.output_item.done` -> `response.completed` (carrying `usage`).

This CONFIRMS Task 7's premise rather than qualifying it: `response.created` is the first frame on the SUCCESS path too, identical to the failure path, so "the first frame is not an error" cannot mean success. That is exactly the trap the Anthropic sniffer at `server.ts:1043` would fall into, and it is why the ChatGPT sniffer scans the whole preamble.

**F8.4 The full rate-limit state comes back ON the inference response.** The same state `/wham/usage` reports, delivered free on a request already being made and always current rather than as-of-last-poll: `x-codex-primary-used-percent`, `-window-minutes`, `-reset-at`, `-reset-after-seconds`, the matching `secondary` set, `x-codex-plan-type`, and a `x-codex-bengalfox-*` set. Present on 400s as well as 200s. This is the structural analogue of recording SDK `rate_limit_info` on the Claude path, and it is what lets the ChatGPT backend mark exhaustion without a second HTTP call.

IMPLEMENTED in Task 6b, not deferred. `chatGptRateLimitFromHeaders` (`chatgpt/windows.ts`) reads this set off every provider answer; the backend hands it to the bench on a refusal and to `noteSeatLimits` on a success, so a seat that reports itself spent on the turn it just SERVED sits out the next one instead of having to refuse one first. All four traps below were observed rather than inferred, and each now names the guard that answers it:

- **Width is MINUTES in these headers and SECONDS in `/wham/usage`.** `10080` is the weekly window here; `604800` is the same window there. Mixing the units is silently wrong by 60x. Converted once, at `windowFromHeaders`, so every other line in the module speaks seconds.
- **`x-codex-secondary-reset-at` arrives as an EMPTY STRING when there is no secondary window, not absent.** `Number("")` is `0`, which reads as epoch 0, which reads as "reset long ago", which reads as "available". `headerNumber` refuses a blank before any arithmetic, and `x-codex-secondary-window-minutes: 0` yields no window at all.
- **The `bengalfox` set is a SECOND, INDEPENDENT limit** with its own primary and secondary windows - the `additional_rate_limits` entry `/wham/usage` names `GPT-5.3-Codex-Spark`. An account can sit at 0% on its weekly primary while bengalfox is spent, so collapsing them loses a usable window. Only the account-wide `primary`/`secondary` pair is read; bengalfox is parsed past and acted on nowhere, which means Spark-specific exhaustion has no handling at all - absent by choice, and the honest remainder of this finding.
- **`x-codex-turn-state` MUST NOT be logged.** It is opaque Fernet material carrying per-turn server state. Not an auth credential - a request still needs the bearer - but unverifiable opaque material has no place in a log line, a test fixture or an error body. Nothing under `chatgpt/` logs a header at all, and the backend forwards only `content-type` and `cache-control` back to the client.

---

## Global Constraints

- EXACTLY ONE PROCESS may hold refresh authority for a given ChatGPT account, at any instant, forever. This is the constraint the whole plan exists to satisfy.
- Meridian MUST NOT write `~/.opencode/oc-codex-multi-auth-accounts.json`, and MUST NOT refresh a token read from it. The read-only guarantee in `src/proxy/codex/pool.ts` and `src/__tests__/codex-no-write.test.ts` stays intact and unmodified.
- Provider MUST be resolved from the requested model BEFORE profile resolution, routing, session lookup or transcript work.
- A ChatGPT request MUST NEVER reach the Claude Agent SDK path, Claude env construction (`profiles.ts:216-242`), or Claude token refresh (`tokenRefresh.ts`).
- An OpenAI profile MUST NEVER reach ANY Anthropic credential path. This is not only the `/auth/refresh` route (`server.ts:7215`): the background loop `ensureFreshTokenForProfiles` (`server.ts:340`) walks EVERY profile into `ensureFreshToken`, gated by no route and no header, and would send a single-use ChatGPT refresh token to the Anthropic token endpoint on its own schedule. Every all-profiles loop MUST be provider-filtered BEFORE it calls `resolveProfile` - see the table in Task 3.
- A missing or provider-mismatched profile MUST error. It MUST NOT fall through to the "Unknown profile ... Using first configured profile" path at `profiles.ts:202-208`.
- Account identity is `accountUserId`. `accountId` alone is forbidden as a key anywhere in rotation, caching, cooldown or storage.
- Every upstream response MUST be validated to name the account it was requested for before its contents are used or cached.
- Outbound headers are an ALLOWLIST. Client `authorization` / `x-api-key` are dropped and replaced with the selected profile's credentials. No inbound header reaches the provider unless explicitly listed.
- The ChatGPT origin is a compile-time constant. No operator-supplied base URL may aim a bearer token at an arbitrary host.
- Credential writes are temp-file + fsync + atomic rename, under a cross-process exclusive lease. A partial write must be impossible.
- Meridian MUST fail startup - not degrade - if it cannot acquire the ChatGPT writer lease.
- Meridian MUST NOT serve ChatGPT inference while any other process holds refresh authority for the same accounts. Serving read-only from a valid access token is NOT a safe intermediate state; see R4.
- Implement every behavior test-first and commit each independently reviewable task.
- No change to the observable behavior of any Claude request in Tasks 1-3.

---

## Architecture Decisions

### D1. The execution boundary is one complete provider request

**Decision:** introduce `UpstreamBackend.handle(request): Promise<Response>`, meaning one COMPLETE provider request including provider-specific credentials, streaming, failure classification and account rotation.

Dispatch happens after common request validation and BEFORE the existing profile/session/priority machinery:

- `/v1/messages`: before `resolveProfile(...)` at `src/proxy/server.ts:1729`.
- `/v1/responses`: at the route (`src/proxy/server.ts:7420`), before the lossy Responses -> Anthropic translation.

**Rejected: reuse `AgentAdapter`.** `ARCHITECTURE.md:139-165` defines it as a description of the INBOUND client (session header extraction, tool mappings, CWD parsing). Provider selection is an outbound concern. Overloading it would make "which client is talking to us" and "which vendor serves it" the same axis, which they are not: a Codex CLI client may legitimately be served by Claude today and by ChatGPT tomorrow.

**Rejected: a common abstraction inside `runSdkQueryAttempt`.** A seam that deep would force the ChatGPT backend to synthesize Claude SDK events, session ids, `rate_limit_info` records and resume/fork semantics it does not have. That spreads provider conditionals through thousands of lines of Claude-specific state handling, and every one of them is a place a ChatGPT request could leak into Claude machinery. The high seam costs some duplication and buys a hard wall.

The Claude backend initially just wraps the existing handler, including `server.ts:3178`, with no behavior change.

### D2. Profiles get a provider discriminator, in two layers

Today `ProfileType` is `"claude-max" | "api" | "oauth-token"` (`profiles.ts:55`) - three ANTHROPIC auth mechanisms, not three providers. `subscriptionType` (`models.ts:89-100`) is Claude entitlement metadata and is likewise not a provider field.

**Decision:** two distinct shapes.

*Persisted* (what `profiles.json` may contain): a discriminated union whose legacy Anthropic arm PERMITS `provider` to be absent, so every existing installation keeps working untouched.

*Normalized runtime*: a STRICT union with a required `provider: "anthropic" | "openai"`.

Normalization rules, non-negotiable:

- An omitted `provider` normalizes to `"anthropic"`. Every profile that exists today is Anthropic-only.
- A new ChatGPT entry must say `provider: "openai"` explicitly and use a distinct auth type, `"chatgpt-oauth"`.
- `"api"` and `"oauth-token"` are NEVER reinterpreted. They keep their current Anthropic meaning forever.

`ResolvedProfile` likewise splits: the Anthropic arm keeps `{ provider, id, authType, env }`; the OpenAI arm is `{ provider, id, accountMeta, credentialRef }` with **no `env` field at all**, so it is structurally impossible to feed an OpenAI profile into the Claude env builder.

Resolution becomes provider-scoped: keep `resolveProfile()` as an Anthropic compatibility wrapper, add `resolveProfileForProvider(provider, ...)`.

### D3. Meridian takes SOLE ownership of the migrated accounts

The operator asked for an explicit choice between (a) sole ownership with oc-codex retired for these accounts, (b) coordinated ownership with a lock, or (c) something else.

**Decision: (a), sole ownership.**

Option (b) is genuinely available - the lease protocol in F4 is well built, documented in its own source, and Meridian could implement the same probe/exchange/commit dance. It is rejected on four grounds:

1. **Bit-compatibility with a foreign protocol.** Meridian would have to reimplement `coordinated-refresh.ts` semantics exactly, including the adoption predicate at `:117-126` and the `tokenRotatedAt` stamp. There is no shared test suite and no version handshake. The failure mode of drift is not a retry - it is a permanently dead account.
2. **The lease is per accounts FILE.** All six accounts serialize on one lock (`transaction-lock.ts:204-221`). Meridian fanning out across accounts would contend with every opencode process on this machine for a single global lock.
3. **Write volume.** 80 pool writes in 12 seconds with Meridian idle (F4). Co-writing multiplies an already busy file.
4. **It does not deliver what was asked.** The stated goal is "one app, always serving everybody". Option (b) preserves N writers and merely makes them politer.

Option (c), a Meridian refresh SERVICE that hands tokens to a slimmed plugin, is really (a) plus an API. It is recorded as the migration path for anyone who still wants the plugin in the loop, and is explicitly out of scope for the MVP.

**Consequence, stated plainly:** this is a TAKEOVER. It requires a brief outage and an explicit ownership transfer, executed in the order given in the Cutover Runbook. Meridian cannot proxy ChatGPT while oc-codex still refreshes the same pool.

### D4. Rotation is provider-partitioned; the algorithms are already neutral

`choosePriorityProfile()` and `ProfileExhaustion` (`src/proxy/routing.ts:139-187`) operate on opaque string ids and absolute `until` timestamps. They need NO algorithmic change.

What is Anthropic-coupled is the INPUT: `CooldownWindowType = "five_hour" | "seven_day"` and `COOLDOWN_WINDOWS` (`routing.ts:250-269`), fed by SDK `rate_limit_info`. ChatGPT reports window WIDTH in seconds, and the widths observed live are 18000 (5h), 604800 (weekly) and **2592000 (30d, free tier)**.

**Confirmed empirically 2026-09-05**, against all six of the operator's real accounts and independently re-captured by the integrator an hour later. The windows are nested under `rate_limit`, NOT at the top level of the `/backend-api/wham/usage` payload - read from the top level they are null on every account:

| `plan_type` | `rate_limit.primary_window` width | `rate_limit.secondary_window` |
|---|---|---|
| `pro` | 604800 (weekly) | null |
| `self_serve_business_prolite` | 604800 (weekly) | null |
| `team` | 18000 (5h) | 604800 (weekly) |
| `free` | 2592000 (30d) | null |

Three of the four distinct plan shapes report the WEEKLY window as `primary_window`; only `team` uses the 5h-primary / weekly-secondary layout, so reading "primary" as "the 5h window" is wrong on four of the six live accounts. **Position must never imply width** - every window MUST be labelled from `limit_window_seconds` and NEVER from which key it arrived under. The 30d free-tier width also rules out the reference implementation's rule of treating anything at or above six days as "weekly", which understates that allowance more than fourfold.

**Decision:** keep one profile catalog for the UI, but partition pools and state by provider. Resolve model -> provider first, then derive that provider's candidate order, active profile, assignment store and exhaustion tracker. A GPT request with no OpenAI account FAILS; it does not borrow an Anthropic one. Provider-specific code converts each vendor's window vocabulary into an absolute `until` before calling `mark()`.

### D5. ChatGPT gets prompt-cache affinity, not Claude's transcript machinery

Claude's durable transcript assignment exists to own SDK session generations, forks and rollback authority. A ChatGPT request has none of those. Simple affinity keyed on the raw Responses `prompt_cache_key` - which is exactly what the plugin already puts in `conversation_id` / `session_id` - is sufficient and far cheaper.

### D6. Provider dispatch is gated on INSTANCE-LEVEL ownership

Resolving a GPT model name to `provider: "openai"` and dispatching on that unconditionally would retire upstream's Codex-CLI-on-Claude feature for every deployment that never configures a ChatGPT account. F1 records that feature; nothing else in this plan reconciled it. The cost is not hypothetical: this branch is destined for `main-nowaker`, which is what the operator's `meridian-dev` on 3457 runs from, and that instance will own zero ChatGPT accounts.

**Decision:** dispatch consults the provider only when this Meridian OWNS ChatGPT accounts. Resolve `chatgptUpstreamEnabled` ONCE at startup from Meridian's OWN store - never the plugin pool.

- **Enabled:** GPT families resolve to `"openai"` with NO per-request fallback, ever. Every account exhausted or failed means the request FAILS. Task 8 Step 2's guarantee holds in full.
- **Disabled:** `providerForModel` is not consulted for dispatch at all, and a GPT name keeps today's translate-onto-Claude meaning byte-identically.

The distinction that makes this safe rather than a cross-provider fallback is that the gate is INSTANCE-LEVEL and resolved once, not per-request availability. A per-request fallback would be R8. An instance that was never given ChatGPT credentials is not falling back to anything - it is running its pre-existing behavior, unchanged.

`providerForModel` itself stays pure and exactly as specified: 15 families to `"openai"`, unknown and absent to `"anthropic"`. The gate is a separate predicate at the dispatch point.

**The mode MUST be observable.** Log it with its account count at startup and report it on `/health`. An operator has to be able to answer "will this instance serve GPT from ChatGPT or from Claude?" without reading source. An invisible mode is exactly how the 13-hour outage of 2026-09-04 happened: an instance served plausible answers from a state nobody could see.

---

## File Structure

### New

- Create `src/proxy/upstream/backend.ts`: the `UpstreamBackend` interface and registry. Provider-neutral, no vendor names.
- Create `src/proxy/upstream/anthropic.ts`: Claude backend; initially a thin wrapper over today's handler.
- Create `src/proxy/upstream/provider.ts`: pure `providerForModel(model): "anthropic" | "openai"`.
- Create `src/proxy/chatgpt/backend.ts`: the ChatGPT backend - request construction, dispatch, rotation, retry.
- Create `src/proxy/chatgpt/credentials.ts`: Meridian-owned ChatGPT credential store; atomic writes under an exclusive cross-process lease.
- Create `src/proxy/chatgpt/importPool.ts`: the importer's own reader and writer, in `src/` rather than in `bin/` because `bin/` sits outside the tsconfig `include` and is checked by nothing. The entry point stays argv parsing and printing.
- Create `src/proxy/chatgpt/lease.ts`: the writer lease. Startup acquisition, heartbeat, fail-closed release.
- Create `src/proxy/chatgpt/paths.ts`: the owned store's path and its lock, defined ONCE. A lock derived one way by the importer and another by the server is not a lock: both processes take one happily and each believes it holds refresh authority.
- Create `src/proxy/chatgpt/refresh.ts`: single-writer OAuth refresh against `https://auth.openai.com/oauth/token`.
- Create `src/proxy/chatgpt/request.ts`: pure header/URL construction for `/backend-api/codex/responses`.
- Create `src/proxy/chatgpt/stream.ts`: Responses SSE failure classification (the analogue of `sniffAccountFailure`).
- Create `src/proxy/chatgpt/upstream.ts`: what an instance that OWNS ChatGPT accounts may do with them - lease lifecycle, seat selection, cooldown and affinity. Returns `undefined` when the store holds nothing, so an instance owning none has no method with which to take a lease.
- Create `src/proxy/chatgpt/windows.ts`: ChatGPT rate-limit windows -> absolute `until` timestamps.
- Create `bin/import-codex-pool.ts`: ONE-SHOT importer, pool -> Meridian store. Run once, at cutover, by a human.

### Modified

- Modify `src/proxy/profiles.ts`: persisted/normalized split, `provider` discriminator, `resolveProfileForProvider()`, error instead of fallback on provider mismatch.
- Modify `src/proxy/server.ts`: dispatch at `:1729` and `:7420`; reject OpenAI profiles at `/auth/refresh` (`:7215`); audit the remaining `resolveProfile` call sites at `:7548` and `:7858`.
- Modify `src/proxy/routing.ts`: provider-partitioned exhaustion instances or provider-qualified keys; generalize the window vocabulary.
- Modify `src/proxy/settings.ts`: nothing for the MVP. Recorded so an implementer does not add ChatGPT routing settings prematurely.
- Modify `src/telemetry/landing.ts`: after cutover, source ChatGPT cards from Meridian's own store rather than the plugin pool. See Task 12.

### Untouched by contract

- `src/proxy/codex/*` - the read-only dashboard integration. Do not make it writable. Do not give it refresh capability.
- `src/proxy/adapters/codex.ts`, `src/proxy/adapters/openai.ts`, `src/proxy/openaiResponses.ts`, `src/proxy/openai.ts`, `src/proxy/transforms/codex.ts` - all INBOUND. Unchanged.

---

### Task 1: Provider-neutral `UpstreamBackend` seam (behavior-preserving)

**Files:**
- Create: `src/proxy/upstream/backend.ts`
- Create: `src/proxy/upstream/anthropic.ts`
- Modify: `src/proxy/server.ts:1729`, `src/proxy/server.ts:7420`
- Create: `src/__tests__/upstream-backend.test.ts`

**Interfaces:**
- Produces: `interface UpstreamBackend { readonly provider: ProviderId; handle(ctx: UpstreamRequest): Promise<Response> }`
- Produces: `registerBackend(b: UpstreamBackend): void`, `backendFor(provider: ProviderId): UpstreamBackend`
- Consumes: the existing `/v1/messages` and `/v1/responses` handlers, unchanged, as the Anthropic backend body.

- [ ] **Step 1:** Write contract tests asserting that with only the Anthropic backend registered, every existing request path produces byte-identical responses to `main`. Watch them pass against unmodified code (characterization).
- [ ] **Step 2:** Write a failing test asserting `backendFor("openai")` throws a typed `UnknownProviderError` rather than returning the Anthropic backend.
- [ ] **Step 3:** Extract the seam. Route both endpoints through `backendFor(...)`. No provider resolution yet - hardcode `"anthropic"`.
- [ ] **Step 4:** Full suite green, `bun run typecheck` clean, and a live smoke of `/v1/messages` and `/v1/responses` proving unchanged behavior.

**This task alone is the upstream-PR candidate.** No ChatGPT terminology appears in it.

---

### Task 2: Resolve provider from the requested model

**Files:**
- Create: `src/proxy/upstream/provider.ts`
- Create: `src/__tests__/upstream-provider.test.ts`
- Modify: `src/proxy/server.ts:1729`, `src/proxy/server.ts:7420`

**Interfaces:**
- Produces: `providerForModel(model: string | null | undefined): ProviderId` - pure, no I/O.

- [ ] **Step 1:** Failing tests pinning the live GPT family list to `"openai"`. The families present in the operator's pool are: `gpt-5-codex`, `codex-max`, `codex`, `gpt-6-astra`, `gpt-daybreak-blue`, `gpt-daybreak-red`, `gpt-5.6-cyber`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.4-pro`, `gpt-5.2`, `gpt-5.1`. **This list is a rotation key set, not a verified capability list - see Open Question 5.** `gpt-5.4` is refused by the endpoint on at least one plan, so the list must be re-measured before D6 is enabled anywhere.
- [ ] **Step 2:** Failing tests pinning every Claude alias (`sonnet`, `opus`, `haiku`, `fable`, `mythos`, and their `[1m]` variants) to `"anthropic"`, INCLUDING an unknown/absent model, which must default to `"anthropic"` so no existing request changes provider.
- [ ] **Step 3:** Implement. Dispatch on the result at both seams.
- [ ] **Step 4:** Regression: full suite plus a live Claude request, proving default-to-anthropic held.

---

### Task 3: Provider-scoped profile model

**Files:**
- Modify: `src/proxy/profiles.ts:55-75`, `:187-214`, `:216-242`
- Modify: ALL EIGHT `resolveProfile` call sites in `src/proxy/server.ts` - enumerated below
- Create: `src/__tests__/profiles-provider.test.ts`

**Every `resolveProfile` call site at `9d22324`.** Four of them iterate over EVERY profile, so an OpenAI entry in `profiles.json` reaches those with no route and no header to gate it. A constraint written against a route does not cover them.

| Line | Site | All profiles? | What it does with the result | Hazard once an OpenAI profile exists |
|---|---|---|---|---|
| 340 | `ensureFreshTokenForProfiles` | YES | `credentialStoreForProfile(resolved)` -> `ensureFreshToken(store)` | **CREDENTIAL LOSS.** Sends the single-use ChatGPT refresh token to `platform.claude.com`. See R11 |
| 1729 | `/v1/messages` | no | request path | Superseded by the Task 1 seam |
| 7016 | `/health` | no (active only) | `Object.keys(healthProfile.env).length` | THROWS. Caddy's probe requires literal `"status":"healthy"`, so the instance silently leaves rotation |
| 7092 | `/profiles/list` | YES | `Object.keys(resolved.env).length` | THROWS. Dashboard and header chip dead |
| 7215 | `/auth/refresh` | no | `credentialStoreForProfile(profile)` at `:7220` | Anthropic refresh of a ChatGPT token |
| 7548 | audit | no | - | Audit for the same hazard |
| 7858 | audit | no | `credentialStore: credentialStoreForProfile(profile)` at `:7870` | Anthropic credential store built for an OpenAI profile |
| 8082 | auth keepalive, every 45s | YES | `Object.keys(resolved.env).length` | THROWS every 45s inside a background timer |

`ResolvedOpenAI` deliberately has NO `env` field (D2). That is what makes the credential leak structurally impossible, and it is exactly why the three `Object.keys(...env)` sites throw rather than quietly misbehave. Do not "fix" this by giving the OpenAI arm an empty `env`.

**Filter BEFORE you resolve.** In each all-profiles loop the provider filter must sit ahead of the `resolveProfile` call itself, not between that call and the `env` read. Step 2 requires a provider-mismatched resolution to THROW, so a loop that resolves first and filters afterwards is filtering after the exception has already been raised. This is an ordering requirement, not a stylistic one.

**Interfaces:**
- Produces: `type PersistedProfile = LegacyAnthropicProfile | OpenAIProfile` (legacy arm: `provider?: "anthropic"`)
- Produces: `type ResolvedProfile = ResolvedAnthropic | ResolvedOpenAI` (the OpenAI arm has NO `env`)
- Produces: `resolveProfileForProvider(provider, profiles, ...): ResolvedProfile`

- [ ] **Step 1:** Failing test: an existing `profiles.json` with no `provider` key normalizes every entry to `provider: "anthropic"` and resolves byte-identically to today.
- [ ] **Step 2:** Failing test: `resolveProfileForProvider("openai", ...)` with no OpenAI profile THROWS, and specifically does not emit the `Unknown profile ... Using first configured profile` warning from `profiles.ts:206`.
- [ ] **Step 3:** Failing test: `buildResolvedProfile` cannot be reached with an OpenAI profile - assert at the type level and with a runtime guard test that no `CLAUDE_CONFIG_DIR` / `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` is ever produced for `provider: "openai"`.
- [ ] **Step 4:** Failing test: `POST /auth/refresh` with `x-meridian-profile` naming an OpenAI profile returns 4xx and makes NO outbound request. Today that path would POST a ChatGPT refresh token to `https://platform.claude.com/v1/oauth/token`.
- [ ] **Step 5:** Failing test for the four unrouted loops - the one that catches `:340`. Put an OpenAI profile in `profiles.json` beside an Anthropic one, spy on the outbound Anthropic token endpoint, then assert ALL of: `GET /health` returns 200 carrying literal `"status":"healthy"`; `GET /profiles/list` returns 200 and lists BOTH profiles; one `ensureFreshTokenForProfiles` pass and one 45s keepalive tick each complete without throwing; and the spy recorded ZERO requests for the OpenAI profile. This must fail against today's code before it passes.
- [ ] **Step 6:** Implement. In every all-profiles loop (`:340`, `:7092`, `:8082`) the provider filter MUST precede the `resolveProfile` call, not merely precede the `env` read or the credential-store construction - Step 2 makes a mismatched resolution throw, so filtering after the call is filtering after the exception. Give `/health` (`:7016`) an OpenAI-safe path. Audit `:7548` and `:7858` for the same hazard.

---

### Task 4: Meridian-owned ChatGPT credential store with a cross-process writer lease

**Files:**
- Create: `src/proxy/chatgpt/credentials.ts`
- Create: `src/proxy/chatgpt/lease.ts`
- Create: `src/__tests__/chatgpt-credentials.test.ts`
- Create: `src/__tests__/chatgpt-lease.test.ts`

**Interfaces:**
- Produces: `interface ChatGptAccount { accountUserId: string; accountId: string; email: string | null; refreshToken: string; accessToken: string | null; expiresAt: number | null; tokenRotatedAt: number | null }`
- Produces: `acquireWriterLease(): Promise<Lease>` - fail-closed, heartbeat, `assertValid()`
- Produces: `readAccounts()`, `commitAccount(accountUserId, mutator)` - atomic, lease-guarded

- [ ] **Step 1:** Failing test: the store is keyed by `accountUserId`, and two accounts sharing one `accountId` remain distinct (F6). Use synthetic ids that COLLIDE on `accountId`, mirroring the live pool - a fixture with unique ids would not catch this.
- [ ] **Step 2:** Failing test: a write is temp-file + rename; a reader concurrent with a write observes either the old or the new complete document, never a partial one.
- [ ] **Step 3:** Failing test: a second process that cannot take the lease FAILS rather than proceeding. Exercise with a real second OS process, not an in-process mock - `tokenRefresh.ts:237-238` shows exactly how an in-process-only guard looks correct and protects nothing.
- [ ] **Step 4:** Failing test: a lease holder killed with SIGKILL is reclaimed after the stale interval, and the reclaiming process observes the last durably committed state.
- [ ] **Step 5:** Implement. File mode 0600.

---

### Task 5: Single-writer ChatGPT OAuth refresh

**Files:**
- Create: `src/proxy/chatgpt/refresh.ts`
- Create: `src/__tests__/chatgpt-refresh.test.ts`

**Interfaces:**
- Produces: `refreshChatGptAccount(accountUserId): Promise<RefreshOutcome>`
- Consumes: `acquireWriterLease`, `commitAccount`

- [ ] **Step 1:** Failing test against a mock token endpoint: on success the ROTATED `refresh_token` is durably committed BEFORE the new access token is returned to any caller. Assert commit-then-return ordering explicitly.
- [ ] **Step 2:** Failing test: when the provider response omits `refresh_token`, the previous token is retained (matching `auth.ts:283-296`).
- [ ] **Step 3:** Failing test: an injected crash between a successful exchange and the durable commit is detected on restart and reported as a REQUIRES-REAUTH state for that account - never silently retried with the dead token.
- [ ] **Step 4:** Failing test: concurrent refresh requests for one account within one process collapse to a single exchange, AND a second process is excluded by the lease.
- [ ] **Step 5:** Implement. Endpoint and `client_id` are constants. Never log a token, a body, or an upstream `detail` string.

**Do not point this at a production account until Task 10.** Test with mocks, or with an account oc-codex has never loaded.

---

### Task 6: ChatGPT backend - raw `/v1/responses` passthrough

**Files:**
- Create: `src/proxy/chatgpt/backend.ts`
- Create: `src/proxy/chatgpt/request.ts`
- Create: `src/__tests__/chatgpt-request.test.ts`
- Create: `src/__tests__/chatgpt-backend.test.ts`

**Interfaces:**
- Produces: `buildCodexRequest(body, account, opts): { url: string; headers: Headers }` - pure
- Produces: `chatGptBackend: UpstreamBackend`

- [ ] **Step 1:** Failing test pinning the full outbound contract from F2: URL `https://chatgpt.com/backend-api/codex/responses`; `Authorization`, `chatgpt-account-id`, `OpenAI-Beta: responses=experimental`, `originator`, `accept: text/event-stream`, `conversation_id` + `session_id` from the prompt cache key; `openai-organization` ABSENT by default.
- [ ] **Step 2:** Failing test: the outbound header set is an ALLOWLIST. Send an inbound request carrying `authorization`, `x-api-key`, `cookie` and a junk header; assert none reaches the provider and that the client's `authorization` is REPLACED, not appended.
- [ ] **Step 3:** Failing test: `redirect: "error"`. A bearer credential must never be replayed to a redirect target.
- [ ] **Step 4:** Failing test: the response body streams through byte-for-byte, with no Responses -> Anthropic translation on this path.
- [ ] **Step 5:** Implement. Origin is a constant; no operator base-URL override.
- [ ] **Step 6:** The responses-lite header is a MODE with body preconditions, not a free hint (F8.2). Send it only when the client's body ALREADY carries `reasoning.context: "all_turns"` AND `parallel_tool_calls: false`; never write those into the body to earn it. Selecting it from the model name alone 400s every request on all seven lite-set tiers, ordinary Codex traffic included.

---

### Task 6b: Compose the sniffer and the windows into the response path

Tasks 7 and 8 each produced exactly the interface their own steps specify, and nothing called either one: `sniffChatGptFailure` and `chatGptCooldownUntil` had a single non-test occurrence apiece, their own definition. So a spent seat failed the request while every other owned seat sat unused - strictly worse than the plugin this replaces, which rotates. No step between Task 6 and Task 10 asked for the composition, which is how it came to be missing rather than wrong. Task 10 cannot run until this is true.

**Files:**
- Modify: `src/proxy/chatgpt/backend.ts`, `src/proxy/chatgpt/upstream.ts`, `src/proxy/chatgpt/windows.ts`, `src/proxy/server.ts`
- Create: `src/__tests__/chatgpt-rotation.test.ts`

**Interfaces:**
- Produces: `chatGptRateLimitFromHeaders(headers): ChatGptRateLimit | null` - pure
- Modifies: `ChatGptBackendOptions` - the single `selectAccount` becomes `candidateSeats` + `seatCredentials` + `benchSeat` + `noteSeatLimits` + `noteServed`, so the backend owns the loop and the host owns the pool

Two commits, each independently reviewable and each droppable on its own.

**Commit 1 - rotation.**

- [ ] **Step 1:** Failing test: a 429 on the leading seat is served by the NEXT seat, and the client sees one clean stream with nothing of the refusal in it.
- [ ] **Step 2:** Failing test: a `response.failed` behind the preamble fails over; a `response.failed` AFTER any output or tool-call frame does NOT. Task 7 Step 2 draws that line and the loop must not undo it - retrying there bills a second account for work the client already holds.
- [ ] **Step 3:** Failing test: a mid-content transport drop passes through untouched. Never yank a stream a client is consuming.
- [ ] **Step 4:** Failing test: with every owned seat spent, the request FAILS and no Anthropic profile is selected. R8, pinned at the backend as well as at the routing layer.
- [ ] **Step 5:** Failing test: each attempt carries ITS OWN seat's bearer and scope header, and the SAME original bytes. A second seat must be offered the request the first one refused, not a re-encoding of it.
- [ ] **Step 6:** Implement. Candidate order comes from the OPENAI partition of the provider-scoped tracker, skipping benched seats. Affinity is keyed on the raw Responses `prompt_cache_key` (D5): a conversation stays on the seat that already holds its prompt prefix for as long as that seat can serve, and only NEW conversations drain back once it returns.

**Commit 2 - header-driven exhaustion (F8.4).**

- [ ] **Step 1:** Failing test per trap: width in MINUTES not seconds, a present-and-empty `reset-at`, bengalfox as a separate allowance, and `x-codex-turn-state` reaching neither a log, a fixture, nor the client.
- [ ] **Step 2:** Failing test: a seat that reports its window spent on a response that SUCCEEDED sits out the next turn without having to refuse one first.
- [ ] **Step 3:** Failing test: a refusal's own stated reset is what benches the seat; the conservative default applies only where the refusal said nothing.
- [ ] **Step 4:** Implement. Nothing is marked unless a window is genuinely spent - a healthy account reports its windows too, and presence is not exhaustion.

**Four calls made inside the above, recorded so they are not read as oversights:**

- A provider **5xx does not rotate**. A provider-side fault says nothing about a seat, so trying all six during an incident multiplies load and leaves the whole pool benched once it passes.
- Once every seat has refused, the **last seat's own answer** is returned rather than a synthesized error, so its status and whatever wait it stated both survive.
- A seat whose credentials cannot be produced is **skipped without being benched**. A seat mid-reauth was already reported by whatever discovered that; benching it here would restate the fact and reset its clock on every request.
- A proactive bench is recorded with reason `quota_spent`, so an exhaustion snapshot distinguishes "the seat told us" from "the seat refused us".

**Not proven by any of it.** The loop has never met a real 429 from `chatgpt.com`: every test is against a mocked upstream, and F8's probe proved the outbound contract rather than the failover. That closes at Runbook step 6, not here.

---

### Task 7: Responses SSE failure classification

**Files:**
- Create: `src/proxy/chatgpt/stream.ts`
- Create: `src/__tests__/chatgpt-stream.test.ts`

**Interfaces:**
- Produces: `sniffChatGptFailure(res: Response): Promise<{ failure: ChatGptFailure | null; body: ReadableStream }>`

Today's failover sniffer (`server.ts:1043`) recognizes an Anthropic `event: error` as the FIRST frame, and the failover-eligible set is exactly two Anthropic classifications: `ACCOUNT_FAILOVER_ERROR_TYPES = { "rate_limit_error", "billing_error" }` (`errors.ts:507-510`). A Responses stream emits neither shape.

The observed nine-event success sequence is in F8.3. It confirms rather than qualifies Step 1: `response.created` opens the SUCCESS path too, so a first frame that is not an error proves nothing at all, and there is no `[DONE]` sentinel to lean on either.

- [ ] **Step 1:** Failing test: a stream of `response.created` followed by `response.failed` is classified as a FAILURE. Naive reuse of the existing sniffer reads the first frame as content and reports success.
- [ ] **Step 2:** Failing test: a failure arriving AFTER any output or tool-call frame is NOT retried on another account. Retrying there duplicates work the client has already seen.
- [ ] **Step 3:** Failing test: a mid-content transport drop passes through to the client untouched - never yank a stream a client is already consuming (the existing rule at `server.ts:1043`).
- [ ] **Step 4:** Failing test: 401/403 marks the account for re-auth, 429 marks a cooldown, 5xx is a transient retry. Each maps to a distinct outcome.
- [ ] **Step 5:** Implement.

---

### Task 8: Provider-partitioned rotation and window generalization

**Files:**
- Modify: `src/proxy/routing.ts:139-187`, `:250-269`
- Create: `src/proxy/chatgpt/windows.ts`
- Create: `src/__tests__/chatgpt-windows.test.ts`
- Modify: `src/__tests__/routing.test.ts`

**Interfaces:**
- Produces: `chatGptCooldownUntil(rateLimit): number | null`
- Modifies: exhaustion tracking to be per-provider (separate instances, or provider-qualified keys)

- [ ] **Step 1:** Failing test: an Anthropic exhaustion mark does NOT bench an OpenAI profile and vice versa. Use ids that COLLIDE across providers - unique synthetic ids would miss a shared-tracker bug.
- [ ] **Step 2:** Failing test: on an instance that OWNS ChatGPT accounts, zero AVAILABLE OpenAI accounts FAILS with a clear error and never selects an Anthropic profile. An instance that owns none is a different case entirely and is governed by D6, not by this step.
- [ ] **Step 3:** Failing test: window widths 18000, 604800 and 2592000 each produce a correct absolute `until`. The 30d free-tier width must not be collapsed into "weekly" - that understates the window by more than fourfold.
- [ ] **Step 4:** Failing test: a Business Standard payload (5h primary + weekly secondary) and a Pro payload (weekly primary, secondary null) both bench correctly. Position must never imply width.
- [ ] **Step 5:** Implement. `choosePriorityProfile` and `ProfileExhaustion` keep their current algorithms; only their inputs change.

---

### Task 9: One-shot pool importer

**Files:**
- Create: `bin/import-codex-pool.ts`
- Create: `src/__tests__/import-codex-pool.test.ts`

**Interfaces:**
- Produces: a CLI that reads the plugin pool and writes Meridian's ChatGPT store, once.

The dashboard reader deliberately does not project `refreshToken` into Meridian's model (`src/proxy/codex/pool.ts`, asserted by `codex-no-write.test.ts`). The importer therefore CANNOT reuse it and must be its own reader.

- [ ] **Step 1:** Failing test: import is keyed by `accountUserId` and preserves two accounts that share an `accountId`.
- [ ] **Step 2:** Failing test: the importer REFUSES to run if the Meridian store already exists, unless `--force` plus an explicit backup path is given.
- [ ] **Step 3:** Failing test: the importer takes the writer lease, and refuses if it cannot.
- [ ] **Step 4:** Failing test: the source pool is byte-identical after import (hash + mtime), proving the importer is a reader of the plugin's file.
- [ ] **Step 5:** Implement. Print a summary naming accounts by `email` + last-6 of `accountId`, never a token.

---

### Task 10: Execute the cutover

See the Cutover Runbook below. This task is a human-supervised operational procedure, not a code change. It is listed as a task because it MUST happen between Task 9 and any production traffic.

- [ ] **Step 1-7:** the seven ordered steps of the runbook, each with its stated verification.

---

### Task 11: `meridian-gpt` deployment

**Files:**
- Create: `systemd/user/meridian-gpt.service` (in the operator's dotfiles repo)
- Modify: `caddy/Caddyfile` (in the operator's dotfiles repo)

- [ ] **Step 1:** Unit with `HOME` overridden to a dedicated directory - NOT `MERIDIAN_CONFIG_DIR` (F7).
- [ ] **Step 2:** Set `CLAUDE_CONFIG_DIR` explicitly inside that isolated home, as defence in depth against the ambient-credential fallback at `profiles.ts:187-192`.
- [ ] **Step 3:** Bind `MERIDIAN_HOST=127.0.0.1` and a distinct port (3457 and 3458 are taken by `meridian-dev` and `meridian-og`).
- [ ] **Step 4:** Set `MERIDIAN_CODEX_POOL_PATH` to the real pool ONLY if the dashboard cards are wanted on this instance; an isolated `HOME` otherwise hides `~/.opencode`.
- [ ] **Step 5:** Pin `MERIDIAN_CHATGPT_STORE_PATH`, and put it OUTSIDE the isolated home. The ChatGPT store does not honour `MERIDIAN_CONFIG_DIR` and defaults to `homedir()/.config/meridian/`, so leaving it unset splits three ways at once: this instance resolves a store inside its own isolated `HOME`, an importer run from a login shell writes the real `~/.config/meridian/`, and `meridian-dev` - which does not override `HOME` - resolves that same real path. The first two never meet, so the import looks successful while this instance finds nothing; the third is R12. Naming the path states ownership instead of deriving it, and leaves every other instance resolving a path that is never created, so none of them can take the writer lease whatever code they are running. Outside the isolated home because that tree is disposable by design - the unit's own `ExecStartPre` rebuilds it from nothing - and the store holds the only copy of single-use refresh tokens. Do NOT create its directory with an `ExecStartPre`: the store's writer creates it `0700`, and a `mkdir -p` running first leaves it `0755` under the usual umask, after which the later `0700` request is a silent no-op.
- [ ] **Step 6:** Add the `@meridian_gpt host meridian-gpt.desktop.ts.nowaker.net` block reverse-proxying to that port, matching the existing `@meridian` / `@meridian_dev` convention. A plain `reverse_proxy`, NOT a leg of `(meridian_upstreams)`: an instance owning no Anthropic account answers `/health` with `degraded` by definition, and a `health_body` gate would drop it out of a rotation it was never meant to join.
- [ ] **Step 7:** Verify with `/health` over the tailnet hostname, and confirm the instance did NOT resolve the ambient Anthropic account. Before the cutover the same probe must report `gptModels: "claude"` and `chatgptAccounts: 0` - the ownership gate is shut until a store exists at the pinned path, and an instance reporting otherwise on an empty store has resolved a different path than the one it was pinned to.

---

### Task 12: Point the dashboard at the owned store

**Files:**
- Modify: `src/proxy/codex/service.ts`, `src/telemetry/landing.ts`

After cutover the plugin pool is stale for migrated accounts, so the read-only cards would show frozen numbers.

- [ ] **Step 1:** Failing test: when Meridian owns ChatGPT accounts, cards are sourced from the owned store; when it owns none, behavior is exactly today's pool-reading path.
- [ ] **Step 2:** Implement, preserving the no-write guarantee for the pool path.

---

## Cutover Runbook

Ordered. Do not reorder. Each step names its own verification.

1. **Prove the writer with non-production credentials.** Tasks 4-5 complete and green against mocks, or against an account oc-codex has NEVER loaded. Production-account refresh stays disabled. *Verify: refresh test suite green; no production account in the store.*
2. **Remove the plugin from every configuration source.** Editing config does NOT unload running processes. *Verify: grep every opencode config scope; no new process can load it.*
3. **Stop every process that may already hold the plugin.** *Verify: zero matching processes. This is the ZERO-WRITER interval - Meridian is not yet a writer either, so no one can spend a refresh token.*
4. **Import under an exclusive lease, naming the destination explicitly.** Acquire Meridian's writer lease, take a restricted-permission backup of the pool, run `bin/import-codex-pool.ts` atomically. PASS `--store` WITH THE SAME PATH THE OWNING UNIT PINS IN `MERIDIAN_CHATGPT_STORE_PATH`, and `--pool` with the source. Neither default is safe here: the importer resolves its store from the LOGIN home of whoever runs it, giving `~/.config/meridian/chatgpt-accounts.json`, and that is the path `meridian-dev` resolves too, because that unit does not override `HOME`. A default-argument import therefore hands ChatGPT refresh authority to the instance that already owns the Anthropic credentials - the one-writer rule inverted, in one command, with no error and nothing to notice. See R12. *Verify: six accounts present in the owned store AT THE PINNED PATH, keyed by `accountUserId`, with the two `accountId`-colliding accounts distinct; and nothing created at the importer's default path.*
5. **Retire the plugin pool and start Meridian fail-closed.** Rename the old pool. Start Meridian with readiness CONDITIONAL on holding the lease and being able to persist credentials. *Verify: a deliberately started second Meridian FAILS STARTUP rather than becoming a co-writer.*
6. **Canary, then the rest.** Refresh ONE account. Persist via temp-file + fsync + rename. RESTART Meridian. Prove that account still serves a real request. Then validate the remaining five sequentially. Only then point plugin-free clients at Meridian and exercise streaming, tools and a forced failover. *Verify: canary serves after restart, proving the rotated token was durable and not merely in memory.*
7. **Rollback is another ownership transfer, not a restore.** If it must be undone: STOP Meridian FIRST, EXPORT its current credentials, and only then start one replacement writer from that export. **NEVER restore the pre-cutover backup** - its refresh tokens went stale the instant Meridian rotated them, and restoring it hands every account a dead token.

**There is no safe read-only serving phase.** Meridian may stay read-only for dashboard telemetry - that is the already-shipped feature - but it must not advertise inference readiness or serve production traffic while another process owns refresh. A valid access token buys plausible success for a few hours and then an expiry outage. This is the exact shape of the 13-hour silent outage recorded on 2026-09-04, where a read-only standby served convincing 200s from tokens it could not renew.

---

## Risks and Irreversibility

| # | Risk | Blast radius | Mitigation |
|---|---|---|---|
| R1 | Two writers exchange the same single-use refresh token | Account PERMANENTLY dead, `refresh_token_reused`, manual re-login. Already happened twice to this operator on 2026-09-05 | Sole ownership (D3); fail-closed lease (Task 4); zero-writer interval (Runbook 3) |
| R2 | Crash between a successful exchange and the durable commit | Same as R1 - the only valid refresh token is lost | Commit-then-return ordering (Task 5 Step 1); crash-injection test (Task 5 Step 3); restart reports REQUIRES-REAUTH rather than retrying a dead token |
| R3 | A surviving opencode process, or a second Meridian | Same as R1, arriving silently hours later | Runbook 2-3 verify process absence, not just config; Meridian fails startup without the lease |
| R4 | Read-only Meridian serves inference while the plugin still refreshes | Plausible 200s, then a cliff at token expiry. The 2026-09-04 outage shape | No read-only inference phase; readiness gated on write capability |
| R5 | Rollback by restoring the pre-cutover backup | Every account gets a stale token: total loss | Runbook 7 - export from Meridian, never restore the backup |
| R6 | False success on a Responses SSE stream | Failover fires on a healthy stream, or a failure is reported as success | Task 7, with explicit `response.created` -> `response.failed` coverage |
| R7 | Cross-account collision via `accountId` | One account's quota state suppresses another's; one user's usage shown on another's card | `accountUserId` everywhere; colliding-id fixtures mandated in Tasks 4, 8, 9 |
| R8 | Cross-provider fallback | A GPT request served by a Claude account, or vice versa | Provider resolved first (Task 2); mismatch ERRORS (Task 3) |
| R9 | `HOME` not isolated on the new host | The new instance becomes a second writer of the operator's ANTHROPIC credentials - R1 for the other vendor | Task 11 Steps 1-2; `MERIDIAN_CONFIG_DIR` is explicitly NOT sufficient (F7) |
| R10 | A bearer token sent to the wrong host | Credential disclosure | Constant origin; `redirect: "error"`; outbound allowlist (Task 6) |
| R11 | `ensureFreshTokenForProfiles` (`server.ts:340`) walks an OpenAI profile into the Anthropic refresh | R1-class. The single-use ChatGPT refresh token is spent against `platform.claude.com` and the account dies. No route, no header, no ChatGPT traffic required - a background loop does it unprompted | Provider-filter every all-profiles loop (Task 3 Step 6); the Task 3 Step 5 spy test asserts zero Anthropic token requests for an OpenAI profile |
| R12 | The cutover import is run with default arguments | R1-class, and it inverts the whole design. `chatGptStorePath()` resolves from `homedir()`, so an importer run from a login shell writes `~/.config/meridian/chatgpt-accounts.json` - which is exactly what `meridian-dev` resolves, because that unit does not override `HOME`. The instance that owns the ANTHROPIC credentials silently becomes the ChatGPT writer too, in one command, with no error and nothing to notice until two writers spend one token | Runbook step 4 requires an explicit `--store`; Task 11 Step 5 pins `MERIDIAN_CHATGPT_STORE_PATH` on the owning unit so every other instance resolves a path that is never created; Task 11 Step 7 verifies `chatgptAccounts: 0` on the pre-cutover instance, which fails loudly if it resolved a different path than it was pinned to |

**Irreversible if wrong:** R1, R2, R3, R5, R11, R12 all end in the same place - a ChatGPT account that cannot be recovered by any amount of retrying, only by a human logging in again. Everything else in this plan is a bug; those six are data loss. R11 and R12 are the easiest to ship by accident, and for the same reason: neither needs a ChatGPT request. R11 needs only an OpenAI entry in `profiles.json` and one tick of a timer that is already running; R12 needs only a command typed without its arguments.

---

## PR Decomposition

**Upstream-PR candidate (Task 1 only).** A behavior-preserving `UpstreamBackend` registration/dispatch seam with only the existing Claude backend, plus contract tests. No ChatGPT terminology, no profile migration, no UI, no token storage. It is additive, it violates none of the interfaces in `AGENTS.md` -> "Stable API Contract", and it is defensible on its own merits as an extensibility point.

**Fork-only (Tasks 2-12).** `ARCHITECTURE.md:1-3` declares Meridian to be an Anthropic-to-Claude-Agent-SDK bridge. A ChatGPT backend does not fit that stated purpose, and the honest thing is to keep it in the fork or behind the plugin system rather than lobbying to widen the project's mission. Keep ChatGPT auth, storage, endpoint behavior and rotation in one isolated module tree (`src/proxy/chatgpt/`) so the boundary stays obvious and a future extraction is mechanical.

**MVP cut list - explicitly out of scope for the first working version:**

- `/v1/chat/completions` against ChatGPT.
- GPT models through `/v1/messages`.
- Shared internal event normalization between the two providers.
- Profile-management UI for ChatGPT accounts.
- Option (c) from D3: a Meridian refresh service with the plugin retained as a client.

Cut them until ownership and the raw Responses path are proven end to end.

---

## Verification Summary

- Tasks 1-3 change no observable Claude behavior: full suite green plus a live `/v1/messages` and `/v1/responses` smoke.
- Task 4 lease exclusion is proven with a real second OS process, not an in-process mock.
- Task 5 durability is proven by restarting Meridian and re-serving the canary account.
- Tasks 4, 6b, 8 and 9 all use fixtures whose `accountId` values COLLIDE, because unique synthetic ids cannot catch the real bug.
- Task 6 outbound contract is proven against a recording proxy, asserting the exact header set - including the headers that must be ABSENT.
- Task 6b rotation is proven against a MOCKED upstream only: failover, no-retry-after-output, mid-content drop and every-seat-spent, each pinned by a mutation that fails that test alone. The loop has never met a real 429 from `chatgpt.com` - that closes at Runbook step 6, not in the suite.
- Task 7 is proven with recorded Responses SSE transcripts covering created-then-failed, failure-after-output, and mid-content drop.
- The pool file is byte-identical (hash + mtime) after Task 9 runs.
- No test, log line, error body or dashboard response ever contains a token.

---

## Open Questions

1. **Does the ChatGPT backend need Meridian's telemetry envelope auditing?** The envelope integrity checks are written against Anthropic wire contracts. Passing a raw Responses stream through them may be meaningless or actively wrong. Recommend: exclude for the MVP, revisit once the path is stable.
2. **Should `x-meridian-profile` be able to name an OpenAI profile explicitly?** It would be useful for testing a specific account, but it lets a client override provider partitioning. Recommend: allow, but validate that the named profile's provider matches the model-derived provider, and error on mismatch.
3. **What happens to the plugin after cutover?** D3 retires it for the migrated accounts. If the operator wants opencode to keep working without pointing at Meridian, that is option (c) and needs its own design.
4. **Per-model quota keys.** The plugin tracks reset times per model family and per `family:model` pair. Task 6b built the one-bucket shape: an exhaustion mark is keyed on `accountUserId` alone, so a seat benched after a `gpt-5.6-sol` refusal is benched for every model. That is the right shape for what the backend actually reads - `primary`/`secondary` are account-wide windows and say nothing per family - but it cannot express a per-family allowance, and one exists: `bengalfox` (`GPT-5.3-Codex-Spark`) carries its own two windows and is deliberately parsed past (F8.4). So today a seat spent on Spark alone is not benched at all, which is correct and also the whole of the handling. Acting on a per-family limit REQUIRES the exhaustion key to carry the family first; marking one from a family-scoped window against a seat-scoped key would sideline an account that can still serve everything else.
5. **Which GPT families does the Codex endpoint actually serve?** Task 2 pins fifteen families to `"openai"`, taken from `activeIndexByFamily` in the plugin pool. That is the plugin's ROTATION KEY SET, not a capability list for `/backend-api/codex/responses`, and the two are not the same question. Measured 2026-09-05 (F8, same single pro account), `gpt-5.4` is refused outright: `The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account.` Under D6-enabled ownership that family - and possibly `gpt-5.4-mini`, `gpt-5.4-pro`, `gpt-5.2`, `gpt-5.1` - would route to ChatGPT and fail, where today they are served by Claude through the translation layer. **This is not grounds to prune the list.** One account proves one account; support may be plan-dependent, and deleting a family that a Business or Team plan does serve would be the same mistake in the other direction. VERIFICATION REQUIRED BEFORE D6 IS ENABLED ANYWHERE: one request per pinned family across at least two plan tiers, recording accepted-or-refused per family, and the list rebuilt from that table. Until it exists, Task 2's list is an assumption wearing the clothes of a measurement.
