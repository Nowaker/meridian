---
id: telemetry-ui
type: module-design
status: active
title: Telemetry and web UI
parent: architecture
references: [design-language]
---

## Responsibility

Record what Meridian did and show it to the operator:

- request metrics (bounded in-memory ring; optional SQLite history via libsql
  with `MERIDIAN_TELEMETRY_PERSIST=1`) and the diagnostic log ring buffer;
- the telemetry JSON API, `/metrics` (Prometheus view of retained records) and
  API-equivalent cost estimates (static Claude rates, generated OpenAI rates,
  user overrides);
- the server-rendered HTML pages (except `/plugins`, owned by `plugins`) — landing, `/telemetry`, `/profiles`,
  `/providers`, `/settings`, login callback, the terminal landing — and the
  shared site header (`profileBar.ts`), which is the single home of the color
  tokens;
- pure presentation shared with the desktop app (`providerView.ts`,
  `providerSetup.ts`, `settingRow.ts`), and the pure cost valuation in
  `pricing.ts`, whose `resolveRequestPricing` the desktop uses to value each
  request exactly as `computeCostEstimate` does;
- the shared `settingRow` presentation (`settingRow.ts`) every `/settings`
  row renders through: label and control on one line, description, status and
  env-override lines below. The override line credits an env var only when the
  resolver used it (`telemetryEnvSources` applies the resolver's own parse); a
  set but unusable variable is named as such.

## Boundary

- **Leaf module:** its only in-repo imports are `src/settings`, `src/env` and
  `src/configDir` (externally: Hono for the route sub-app in `routes.ts` that
  `server.ts` mounts, and libsql for persistence). Never imports `server.ts`, `session/`, adapters or provider backends; callers
  push data in and register its routes.
- Pages are self-contained template strings with **no UI build step**; every
  page follows [`design-language`](../../DESIGN.md) (tokens only, shared header,
  no page-level body background).
- Shared presentation used by `desktop-app` stays **pure** (no I/O, no Electron);
  neither UI executes a generated setup command.
- Cost figures are **estimates**, never an invoice or remaining-budget claim;
  unpriced models are excluded and labeled, never shown as zero.

## Decisions

- **Client conversation identity is not SDK session identity.** `/telemetry/requests` may include `clientSessionId`, the conversation key resolved from the client's adapter or the unscoped thread ID in Responses metadata, falling back to a valid `x-meridian-session` header. The fallback never enters session resume, lineage, leases, or route selection. It is retained across requests and profile attempts even when the provider creates a new SDK session or the request uses a side-flow routing key. `sdkSessionId` still identifies the SDK transcript. Warm requests, keepalive beats, requests without a client ID, and legacy rows omit `clientSessionId`; a prompt fingerprint or cache key alone is not a conversation identifier.

- **Client attribution is self-reported telemetry.** `/telemetry/requests` and ChatGPT turn events carry optional `client: {name, version?, installation?, device?}` and `purpose`; SQLite stores these in nullable `client_name`, `client_version`, `client_installation`, `client_device`, and `purpose` columns. Old rows omit the new fields. See the [client contract](../../docs/client-attribution.md) for validation and internal attribution; it does not change `requestSource` or any routing decision.

- **`/` and `/profiles` update in place.** Their polls patch `#content` from
  the fresh markup (`domPatch.ts`) instead of replacing it: nodes are matched
  by `data-key`/`id` (cards by profile id) or by position among unkeyed
  siblings of one tag, and only changed attributes, text and added, moved or
  removed nodes are touched, so find-in-page, a selection, focus and scroll
  survive a refresh. A node marked `data-patch-own` (an open sign-in panel)
  keeps its script-owned children.
- **Profile table preferences are presentation-only.** `profileTable.ts` owns the shared table, column definitions and browser-local presets. Both pages project the same profile and quota responses they already read into keyed rows and reuse their existing action paths. The table receives the current filters; changing its columns or sort does not change the profile pool or trigger a provider read.
- **Card status is shared between both pages** (`profileCardStatus.ts`): the
  informational duplicate badge and the post-sign-in *updating* / *failed*
  line. The page remembers a sign-in it finished, so an answer requested
  before it cannot clear the updating state; `/profiles` polls every 1.5s
  while a card updates, drops an answer older than one already drawn, and
  exempts an updating card from the search and the login-state chips (not
  from the provider chips), because a sign-in changes both under it. An
  updating card dims only its figures; its name row and active border never
  dim.
- **Login-state chips use the pages' own rules** (`profileLoginStates.ts`).
  Each account is in exactly one state: *Needs auth* is `isUnusable()`
  (`profileSpent.ts`, the rule behind the red needs-login border), *Expires
  soon* is a logged-in account with `renewalRequiredSoon` from
  `/profiles/list`, and every other account is *Authenticated*. A spent or
  unreachable account is not in *Needs auth*, and a ChatGPT seat, which states
  no login deadline, never expires soon. `?login=` names the chips that are on
  exactly as `?provider=` does (`profileFilterUrl.ts`): an absent or
  unknown-only parameter keeps the remembered choice, an empty one turns
  every chip off, and opening a link never saves a preference.
- **`/`, `/profiles` and `/providers` stop polling while their tab is
  hidden.** All three read `/v1/usage/quota/all` (`/providers` through
  `/providers/view`, whose Claude card re-reads it at most every 10 s), and
  Meridian caches each Claude profile's usage for only 30 s by default. One forgotten
  background tab polling every 10 s therefore asks Anthropic's OAuth usage
  endpoint for every profile about twice a minute, enough to keep it
  answering 429 for the CLIs and widgets that share it. A hidden tab skips its
  timed polls, and `visibilitychange` refreshes the page as soon as it is
  shown again.

- **Free resets are counted from Meridian's own reading** (`freeResets.ts`).
  Each Claude entry of `/v1/usage/quota/all` carries the provider's
  `bankedResets`, which Meridian reads per profile with that profile's
  credentials; neither page asks anyone else. One view feeds both pages, and
  it counts resets **per kind**, because each kind clears something different:
  *Full reset* (`kind: "full"`, the whole week), *Fable reset*
  (`kind: "fable"`, only Fable usage back to the weekly allowance, never the
  week) and *Unrecognised reset* (anything else). Either known kind may also
  clear the 5-hour window: Meridian says so only when the grant's own `clears`
  lists `five_hour` (observed on Team grants, not on personal ones), never by
  guessing from the plan.
  The grant's `kind` decides, never the provider's raw `type` (the observed
  Fable launch grant has `type: "full"`). A reading without `kind` (one taken
  before Meridian read grant scope) labels only the known ids:
  `full-reset-2611` is full, `launch-2610-fable` and its `-6mo`/`-12mo`
  grants are Fable; every other grant is unrecognised. Unrecognised grants
  are grouped by the provider's `description` and `providerType`, or by raw
  grant id when the provider gives neither; that name is shown escaped and
  the grants are never offered for redeeming. A grant id listed twice
  counts once; the six- and twelve-month Fable grants are distinct grants.
  Within a kind, resets on unexpired grants are *available*, and those on
  grants the provider marks `usableNow`, unpaused and already started are
  *usable*; each kind shows its own soonest expiry.
- **A kind offers a grant only when redeeming it would do something.** The
  grant is the provider's `nextGrantId` when that grant is usable and of the
  same kind, else the usable grant of that kind expiring soonest. A full
  reset needs nothing more. A Fable reset also needs a current reading of
  Fable usage above zero: the grant's `percentUsed.seven_day_overage_included`
  (0-100), else the profile's `seven_day_fable` window (0-1). A stale reading
  confirms nothing. At zero, unknown or stale usage the Fable count stays
  visible but muted, with the reason ("no Fable usage to give back right
  now", "Fable usage unknown", "Fable usage not confirmed: the last reading is
  stale") and no redeem button. A known zero is shown even while Anthropic
  holds every Fable grant back. Muted also means none of that kind is usable.
- **Only `/profiles` redeems.** A card on `/` shows one "resets" row per kind
  (its name, count, and the reason or usable count with its soonest expiry)
  and never redeems. `/profiles` shows one block per kind, each with its own
  "Redeem full reset" / "Redeem Fable reset" button while that kind offers a
  grant. The button acts only after a confirmation that names the kind, the
  grant (provider label and id) and only that kind's effect (a Fable reset
  gives back Fable usage and leaves the week as it is), plus the 5-hour window
  when that grant's scope lists it, and posts that grant
  to `POST /v1/usage/quota/reset` with a fresh `requestId`; nothing redeems
  on its own, and a refusal never falls back to another kind or grant. The
  poll is held while a redeem is in flight, and the outcome stays in the
  block of the kind it was for (or in a block of its own once that kind is
  used up) for two minutes, so the poll that follows does not wipe it. The
  route clears the profile's cached usage after a reset, so the next read of
  `/v1/usage/quota/all` (the page's refresh, or Vibeterm's re-check) shows
  the new state.

- **A ChatGPT seat's banked resets on `/profiles`** (`chatGptResets.ts`): a
  "Banked resets" block under the seat's usage, with the count and the
  soonest expiry, and a "Redeem closest-expiring reset" button. It acts only
  after an in-page confirmation naming that expiry, and posts
  `POST /profiles/:id/chatgpt-resets/redeem`. The button is disabled with a
  tooltip on an instance that does not own the seat's login and absent on a
  seat with none banked. The outcome stays in the block for two minutes.

- **Refresh is one click per card.** Every profile card and ChatGPT seat on
  `/` and `/profiles` carries a refresh icon that posts
  `POST /profiles/:id/refresh` (`profileActions.ts`): login, usage, model
  list, and where CVP access comes from. The icon spins and is disabled while
  the reads run, the poll is held meanwhile, and the outcome stays on the card
  for a minute as one inline line per part (`outcomeHtml`): the part, its
  state in words and colour, and the route's note. Never a dialog.

- **No native dialogs.** No page calls `alert`, `confirm` or `prompt`. The
  shared header carries `window.meridianDialog` (`dialog.ts`): a queued,
  focus-trapped modal and a corner toast, text set with `textContent`. Error
  replies are read with `dialogErrorText`, which takes both envelopes
  (`{error: "...", code}` and `{error: {type, message}}`), so an object is
  never shown as `[object Object]`. `no-native-dialogs.test.ts` fails on a
  native dialog call in any served page.

- **A refused switch says why and who.** Activation on `/` and `/profiles` goes through `meridianProfileActions.activate`: a refusal opens a dialog with the route's reason, who keeps the profile out, and what forcing would take. It offers "Activate anyway" when only forcing is needed and allowed, "Release and switch" when the refusal only asks for a release, or one `Release <profile> and activate anyway` button when both are needed and forcing is allowed. When forcing is possible but disabled, the dialog links to the setting. Retries carry consent across separate dialogs for the same switch. Release consent applies only to the force shown in the dialog, and a failed switch does not release it. A forced card shows a yellow "forced" badge with its expiry and, on `/profiles`, a release link.

- **Keepalive beats are not requests.** Rows with
  `requestSource: "cache-keepalive"` answered no client, so `computeSummary`
  (both stores), the route summary and Prometheus request series exclude
  them, and `getLastForSession` skips them so token-anomaly checks compare
  turn to turn. They are totalled apart in `TelemetrySummary.cacheKeepalive`
  (beats, reached, not reached, tokens, estimated USD), a dashboard section
  and `meridian_cache_keepalive_beats_total{outcome}`. A beat that never
  reached upstream carries status `0` and its reason in `error`, and is shown
  as skipped, not as an error.

- **`/telemetry/timeseries` buckets what `/summary` counts.** It serves the
  desktop app's history charts: `start`/`end`/`bucket` (or `window` instead of
  `start`), buckets aligned to `start` over `[start, end)` so a client's local
  midnight yields local-hour buckets, every bucket present. Rows are the raw
  store rows with keepalive beats excluded, NOT collapsed route chains, because
  `computeSummary` does not collapse either; a failover's hops count once each,
  so the buckets of a range sum to the summary's requests, errors and token
  totals. Hit rate is summary's mean per-row rate, p50 uses
  `computePercentiles`, cost is `computeCostEstimate` with the user overrides:
  `costUsd` is `null` only when every request in the bucket is unpriced, and
  `unpricedRequests` labels a partial figure (an empty bucket costs `0`).
  Ranges over 31 days or 1,000 buckets are refused, which bounds the response;
  the read goes through `getRecent` with an exclusive `until`, so rows after
  `end` do not spend the 100,000-row bound (summary's SQLite bound).
  `truncated` is set when that bound is hit, when a full memory ring's oldest
  row is newer than `start`, or when `start` reaches past SQLite retention and
  the oldest held row is newer than it. A ring that is not full has dropped
  nothing, so a range before the first request is empty, not truncated. The
  bucketing is pure (`timeseries.ts`); the route only parses and reads.

User-facing behavior is documented in `MONITORING.md`.

## Known limitations

- **History is volatile by default**; without persistence, metrics and logs
  vanish on restart, and a failed SQLite initialization silently falls back to
  memory (announced only at startup).
- **`/metrics` is not monotonic**: values come from up to 10,000 retained
  records and can fall as records age out, so `rate()`-style alerting is
  unreliable.
- **Cost totals can be incomplete** (unpriced models) and OpenAI Fast-mode
  requests are underestimated.
- **The persistence banner cannot be silenced by the `silent` config option**,
  because the stores are created at module load before config exists; only
  `MERIDIAN_QUIET=1` suppresses it.
