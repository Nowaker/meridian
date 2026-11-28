---
id: profiles-routing
type: module-design
status: active
title: Profiles, auth and account routing
parent: architecture
---

## Responsibility

Own the operator's **Claude accounts** and decide which one serves a request:

- profiles — resolve, list, add, rename, switch, browser/pasted-code OAuth
  login, token refresh/health, plan and usage facts, and the cross-process
  profile config store (`profile*.ts`, `auth*.ts`, `tokenHealth.ts`,
  `tokenRefresh.ts`, `oauth*.ts`,
  `planAllowance.ts`, `credentialsMode.ts`), the account each profile is
  signed in to (`organizationName.ts`), the models that account may use
  (`accountModels.ts`), the models it holds Cyber Verification Program
  access on (`cvpAccess.ts`), profiles signed in to one account
  (`duplicateProfiles.ts`) the post-sign-in re-read state
  (`profileFactsRefresh.ts`) and each credential's login history
  (`authLifecycle.ts`);
- routing modes (`routing.ts`): `active` (default), `sticky` (rendezvous
  hashing), `priority` (fail-over pool) and `active+priority`, plus
  follow-another-instance mode (`followActive.ts`, with its usage figures in
  `followUsage.ts`);
- per-profile rate-limit and exhaustion tracking (`rateLimitStore.ts`,
  `limitDetection.ts`) and human-turn attestation verification for priority
  failback (`priorityAttestation.ts`).

## Boundary

- Does not import `server.ts`, `session/` or adapters. The core supplies the
  session/assignment key and performs dispatch and failover. One deliberate
  exception to the downward flow: `profileCli.ts` (the `meridian profile` CLI)
  calls `chatgpt/seatCli`, because one CLI covers Claude profiles and ChatGPT
  seats.
- Rate-limit facts are **keyed per profile**, and `profileId` is a required
  argument, so no call site can read one account's window for another. A
  profile switch clears nothing; `/auth/refresh` clears only its own profile.
  The one fact scoped wider is a priority exhaustion mark from a quota
  refusal, which also lands on the profiles verified at that moment to hold
  the same account (see *A quota refusal speaks for every profile signed in
  to that account*); the windows, spent records and usage snapshots behind it
  stay per profile.
- The `x-meridian-profile` pin always wins over any routing mode.
- Claude profiles never hold ChatGPT credentials (those live in
  [`chatgpt-backend`](chatgpt/SPEC.md)); routing never crosses providers.

User-facing behavior: `docs/profiles.md`. Throttling and `[1m]` bench scope:
[`architecture`](../../ARCHITECTURE.md) → *Throttling Contract*.

## Decisions

- **Automatic account switching is opt-in.** Several users explicitly do not
  want it, so the default stays `active`. `MERIDIAN_ROUTING` /
  `MERIDIAN_PROFILE_ORDER` fall back to settings; unknown ids are logged and
  unlisted profiles go last — a typo must never change routing.
- **Priority keeps cache affinity.** An existing session stays on a healthy
  account (prompt cache is per account); each profile is tried at most once per
  request; an exhausted pool answers `no_routable_account` (below); only new
  conversations drain back to a recovered preferred account
  (`priorityFailback: next-user-turn` additionally allows an attested human turn
  to fail back).
- **`active+priority`** puts the manually active profile first and the priority
  order behind it, and the active profile **outranks** an existing session
  assignment: here the head moves only because a human or supervisor moved it,
  and moving running conversations is what they moved it for. Affinity still
  applies below the active profile, so an outage costs one cold cache rather
  than one per turn.
- **Keyless affinity.** The priority assignment key is the root session id, else
  `fp:<fingerprint>`, else none. It is only an *account* key, never a session
  key, so a collision merely shares an account. Subagents use their root
  session and stay on the parent's account. Assignments are an LRU (cap 5000);
  keyed routes are additionally durable in SQLite bookkeeping.
- **A restart keeps a running conversation on its account.** The LRU lives in
  process memory, so after a restart an unattested session (Pi, Oh My Pi,
  OpenCode without its plugin) has no assignment. The account holding the most
  recently used mapping (`<profile>:<session>`) of the conversation's root or
  of the request's own key stands in for it; otherwise the conversation would
  start on the head of the order and replay its whole history there, though
  its prompt cache is warm on the old account. The root counts because a
  subagent keyed apart has no mapping on its first request, and its dispatch
  would assign the head of the order to the whole conversation. The stand-in
  only retains, like the lost assignment: a benched or removed account still
  falls through to the order, and it never grants promotion authority. A store
  read error answers 503, like the durable route lookups beside it, rather
  than guessing an account.
- **Keyless forks share the parent's account on purpose.** This deliberately
  diverges from the session-resume guard, which forces keyless `fork-` /
  `subagent-` requests to replay fresh: a *session* collision would
  cross-contaminate history, while an *assignment* collision only pins two
  conversations to one account and keeps its prompt cache warm. Do not "fix"
  the two into consistency.
- **The weekly reserve is approximate and never fetches.** A profile with a
  `weeklyReserve` percentage (`MERIDIAN_WEEKLY_RESERVE` wins over the setting)
  leaves the pool-routing candidate list once the newest observed `seven_day`
  utilization, from SDK rate-limit events or the cached OAuth snapshot, reaches
  100% minus the reserve. It adds no usage requests, because the usage endpoint
  rate-limits. A reading past its reset is ignored, so the hold lifts at the
  reset without new data; a reading with no reset counts for one hour, because
  a held profile gets no traffic that could refresh it. A profile with no
  reading is never held, and a newer reading without a utilization figure does
  not lift a hold, since it says nothing about the level. Unlike exhaustion, a
  held profile is not a last resort: when every pool member is held the request
  gets 429 with the earliest reset as a capped `Retry-After`. Retain-only work
  (no promotion authority) keeps its route even while held, because the
  alternative is failing it. Cache-keepalive beats skip held profiles. Pins and
  the `active` / `sticky` modes ignore the reserve. Invalid values and reserves
  naming no profile are logged once and ignored.
- **Extra Usage is a last resort under pool routing** (`claudeExtraUsage` /
  `MERIDIAN_CLAUDE_EXTRA_USAGE`, default `reserve`). An account whose next
  turn would be paid with Extra Usage moves behind every account with plan
  allowance and is no home for an existing assignment, so a conversation on
  it moves on its next turn; when no account with plan allowance can take
  work, the pool keeps its order. The evidence is already observed, never
  fetched (the usage endpoint rate-limits): the newest of the SDK's
  `isUsingOverage` and a cached OAuth snapshot whose `five_hour` or
  `seven_day` window is at 100% with `extraUsage.isEnabled`. A reading past
  its reset, or one with no reset older than an hour, says nothing. `never`
  drops such accounts and answers 429 with the earliest plan reset as
  `Retry-After` when none is left; `immediately` changes nothing. Retain-only
  work keeps its route, as with the weekly reserve. Cache-keepalive beats
  skip such accounts under every mode. The three words match the ChatGPT
  Codex credits policy.
- **A pool no Claude account can serve answers `no_routable_account`.** Under
  pool routing, when every candidate refused before exposure with at least one
  quota refusal among them, or when nothing is sent because every candidate is
  held (usage reserve, weekly reserve, Extra Usage `never`), the client gets
  `rate_limit_error` with `code: "no_routable_account"`, a message starting
  `No routable Claude account: ` and ending `(incident <id>)`, `reset_at` (the
  soonest profile reset, ISO, or null), `incident_id`, `request_id` and
  `profiles[{id, reason, resets_at}]`: 429 with `Retry-After` before the
  stream, the same `error` object in the SSE error frame after it. The
  incident is the message's last token because client SDKs keep only `type`
  and `message` of a stream error. `reason` is `excluded`, `held`,
  `no_cvp`, `no_restricted`, `reserve_held`, `weekly_held`, `spent`,
  `model_benched` or `extra_usage_off`, first match in that order; `logged_out` is reserved and
  no skip path produces it, since an auth failure is not a failover error. A
  profile with none of them (outside a retained route's single candidate) is
  left out. Unpinned `active`/`sticky` work every eligible profile of which is
  reserve-held gets the same error, and so does unpinned work in any mode
  whose pool is empty while at least one profile is out only because the
  supervisor's `routingManagedExcludedProfiles` names it: the supervisor
  allows no account, which is a capacity wait. `excluded` and `held` entries
  carry the profile's known usage reset (a refused window it is spent on,
  from SDK events or the cached usage snapshot) or null. A pool the user's
  own `routingExcludedProfiles` (with held profiles) empties alone stays 503
  `no_eligible_profiles`, a configuration error. `GET /settings/api/routing`
  lists `managed-exclusion-no-routable` in `capabilities` so a supervisor can
  tell this build from one that answers 503. An account's own refusal in
  `active`/`sticky`, a retained route's own hold, and pins keep their own
  errors. A pool only
  billing refusals ran out keeps the last-tried account's error and status:
  waiting will not reopen it, so it is not a rate limit.
- **A pin passes the supervisor's exclusions, never the user's.** Work pinned
  with `x-meridian-profile` to a profile that only
  `routingManagedExcludedProfiles` names is served on that profile, Claude
  and ChatGPT alike: the managed list is a supervisor's policy for work
  nobody assigned, and a pin is the user choosing the account. The user's own
  `routingExcludedProfiles` still answers 409 `profile_excluded` for a pin,
  whether or not the managed list names it too. Unpinned work, the active
  pointer (`POST /profiles/active`) and warms keep treating both lists alike.
  `GET /settings/api/routing` lists `pin-bypasses-managed-exclusion` in
  `capabilities`.
- **Forcing a forbidden profile.** A supervisor may write
  `routingManagedReasons` (`{profileId: text}`, whole map, at most 300
  characters each) beside its lists; it is shown, verbatim, when someone tries
  to activate that profile. Every refusal of `POST /profiles/active` carries
  `refusal {kind, profile, by, reason, forceable, forceAllowed, forceNote,
  forced?, releaseAndForce?}` beside its existing fields; `kind` is `managed_excluded`,
  `excluded`, `held`, `usage_reserve`, `needs_login`, `following` or
  `forced_elsewhere`. With `allowForcingForbiddenProfile` on (a boolean set
  through `PUT /settings/api/routing`, same-origin only, off by default),
  `{profile, force: true}` activates a Claude profile kept out only by the
  supervisor (managed exclusion, hold or usage reserve) and saves
  `forcedActiveProfile {profile, forcedAt, until}`, five hours out. The
  user's own `routingExcludedProfiles`, a missing login, follow mode and
  ChatGPT seats are never forced; a force while the setting is off answers 409
  `force_disabled`. While a force holds and its profile is the active pointer,
  that profile is read out of `routingManagedExcludedProfiles`,
  `routingHeldProfiles` and its usage reserve everywhere they are judged (the
  pointer reconcile, unpinned dispatch, failover), while the lists themselves
  keep what the supervisor wrote; `cvpManagedExcludedProfiles` is untouched.
  A switch away from a live force without `releaseForce: true` answers 409 `profile_forced` (`refusal.kind: "forced_elsewhere"`, with `forceable` and `forceAllowed` both false). If the target is also blocked only by a supervisor exclusion, hold or usage reserve and forcing is enabled, the same refusal names both reasons, includes the source force in `refusal.forced`, and adds `releaseAndForce: true`, even on a `force: true` request. Confirming that combined action sends `releaseForce: true` and `force: true` together in a same-origin request.
  Release consent can also carry `releaseForceFor: {profile, forcedAt}` from the displayed force. A supplied value must contain a non-empty profile string and a finite timestamp number or the Claude switch returns 400. With `releaseForce: true`, the pair must match the live force on another profile both before and after the auth check; a mismatch returns a fresh 409 `profile_forced` describing that force. If no force stands in the way, activation continues under the ordinary rules. Omitting `releaseForceFor` retains the plain boolean behavior. The route changes the pointer and releases or replaces the old force only after the login and current policy checks pass; a refused switch leaves both unchanged.
  Before startup reconciliation, a CLI restart with `MERIDIAN_PROFILES` clears an unexpired saved force if forcing is off or the saved `activeProfile` differs from the force's profile. Selecting that profile as an ordinary fallback cannot then revive the force. For a matching force with forcing enabled, the CLI restores the local active pointer in memory only if the profile's exact ID is configured. An existing local active pointer, follow mode or a personal exclusion prevents restoration. A matching force is neither rewritten nor renewed. Disk discovery and programmatic startup are unchanged.
  The force also ends at `until`, on `POST /profiles/forced/release`, and when the setting is
  turned off; each puts the ordinary rules back at once, so the pointer moves
  off a profile the supervisor still keeps out. `GET /settings/api/routing`
  reports `allowForcingForbiddenProfile`, `routingManagedReasons` and
  `forcedActiveProfile` (null unless live) and lists `forced-active-profile`
  and `managed-exclusion-reasons` in `capabilities`; `/profiles/list` adds
  `forcedActiveProfile` and per entry `forced {forcedAt, until}` or null.
- **Refreshing a profile's usage on request.** `POST /profiles/:id/usage/refresh`
  (API key, same-origin browser writes) reads the profile's usage now: a
  Claude profile through the OAuth usage cache with `force` (the 429 cooldown
  still applies, a followed instance's copy is skipped), every ChatGPT seat
  through one forced usage call. The fresh snapshot replaces the shared cache,
  so `/v1/usage/quota/all`, reserves and dispatch see it at once, and the
  windows it shows below their limit clear the refusals remembered for them as
  a redeemed free reset does (rate-limit buckets, the spent mark, a quota
  bench). One read per profile, and one for all seats, per 30 seconds; another
  answers 429 `refresh_too_soon` with `Retry-After`. 200 answers
  `{profile, refreshed, note, usage}`, `usage` in the `/v1/usage/quota/all`
  entry shape; 404 `profile_not_found`, 400 `not_oauth` for an API-key
  profile. `GET /settings/api/routing` lists `usage-refresh` in
  `capabilities`. A note never says "the last reading stays" for a profile
  Meridian holds no reading of: there is none to stay.
- **Refreshing a profile.** `POST /profiles/:id/refresh` (API key, same-origin
  browser writes) re-reads everything Meridian can about one profile, for a
  reset, top-up or re-login made outside it, and answers
  `{profile, parts: {login, usage, models?, cvp?}}`, each part
  `{state, note, retryAfterMs?}` with `state` one of `fresh`, `rate_limited`
  (the provider's limit or the part's own budget), `failed`, `skipped` (the
  login it needs is gone) or `unavailable` (nothing Meridian can read for it).
  One endpoint, so the card has one control and one outcome; each part keeps
  its own 30-second slot, so a part refused as too soon does not hold the
  others back, and the usage slot is the one `usage/refresh` uses.
  The login part runs first: `claude auth status` again for that profile only,
  waited for rather than served from its cache (`recheckClaudeAuthStatus`);
  the stored credential read as `/profiles/list` reads it; and, signed in,
  the account read again (`refreshOrganizationNow`). A login that now holds
  another account drops the previous one's usage, health, model list and CVP
  map (`clearSignedInProfileFacts`) before the other parts run. With no usable
  login, usage and models are `skipped`. The models part re-lists the
  account's `/v1/models` past its ten-minute cache; a failed forced read keeps
  the list read before and says how old it is. The cvp part is always
  `unavailable` (see "CVP access is learned, never fetched") and names the age
  of the last claude.ai reading, which the next one replaces. A ChatGPT seat
  answers `login` and `usage` from one forced usage call, which is also what
  says whether its token is accepted. An API-key profile answers `login` and
  `usage` `unavailable` and re-lists its models. 404 `profile_not_found`;
  `capabilities` lists `profile-refresh`.
- **A pinned model list is that account's own.** `GET /v1/models` with
  `x-meridian-profile` naming a Claude profile answers the Claude models
  Anthropic's `GET /v1/models?limit=1000` lists for that profile's own
  credential (OAuth with `anthropic-beta: oauth-2025-04-20`, or its API key),
  read through the same store, expiry renewal and one 401 refresh as every
  other account call. Accounts differ: Team accounts list Claude Mythos and
  personal Max accounts do not. Each entry keeps the static shape (`id`,
  `object`, `created`, `owned_by: "anthropic"`, `display_name`,
  `context_window` from `max_input_tokens`, capped at 200k under
  `CLAUDE_CODE_DISABLE_1M_CONTEXT`) plus `max_output_tokens` from
  `max_tokens`; a model the static list knows keeps its static
  capabilities. The list is cached per profile for 10 minutes, a failed read
  for 1 minute, and dropped when the profile's credential is cleared. A read
  that fails answers the static list. `x-meridian-models-source` reads
  `account` or `static`. An unknown pin answers 400 `unknown_profile`;
  exclusions do not hide the list, since a pin may be served on a managed
  exclusion. Without the header, or with one naming a ChatGPT seat, the
  answer is unchanged. The credential is never logged or returned.
  `GET /settings/api/routing` lists `profile-model-list` in `capabilities`.
- **CVP access is learned, never fetched.** Anthropic tells which models an
  account holds Cyber Verification Program access on only in claude.ai's
  model selector (`GET /api/organizations/{org}/model_selector/{surface}` and
  `/api/bootstrap/{org}/app_start`, `models[].badge.message` "CVP: Defense
  Access", sent only with `anthropic-client-platform: web_claude_ai` or
  `desktop_app`). The same paths on `api.anthropic.com` with an OAuth
  credential answer the same lists without badges, and the program endpoints
  refuse OAuth tokens (verified 2026-11-18), so Meridian keeps a per-profile,
  per-model map (`cvp-access.json` beside settings, replaced atomically) fed
  by two sources. `POST /profiles/:id/cvp-access` takes one surface's
  `models[]` from something holding that account's claude.ai session: a
  badged model is `active` with the badge's tier (Defense `c`, Red Team `b`,
  Specialized `a`), an unbadged one `inactive`, and it replaces that
  profile's previous reading. A refusal's `stop_details.cyber_verification`
  (`{type: "active", tier}` or `{type: "inactive", reason}`, subagent rows
  included) is recorded for the model the refusal names, or for the
  requested model when the row names none or one that is not a Claude model
  id: Claude Code's synthetic messages carry `<synthetic>`, which no request
  names. Entries already stored under such an id are ignored on read and
  pruned on the profile's next write. A claude.ai reading under 24 hours old
  decides; past that the newer of the two does. Model ids are compared
  lowercase without `[1m]` or a `-YYYYMMDD` snapshot date, and never by
  family: Mythos holds access where Fable, its tier, does not. A Meridian
  sign-in forgets the profile's map, since it may be another account; a token
  refresh does not. `/profiles/list` lists each profile's map as `cvpAccess`.
- **A profile without a reading takes its organization's.** CVP access is
  granted to an organization, and the claude.ai reading reaches Meridian only
  for the accounts of whoever runs the reader, so a profile with neither a
  claude.ai nor an observed reading for a model takes the effective reading
  that the other profiles of the same organization (equal `organizationUuid`
  in `organizations.json`, never the name) hold there from their own
  readings, never from an inferred one. When those siblings disagree on
  `active` and `inactive` nothing is inferred; a profile whose organization
  is unknown infers nothing. The freshest sibling reading supplies tier,
  reason and time, with `source: "organization"` and `inferredFrom` naming
  that sibling. The map is a routing hint, not a grant: Anthropic checks
  access on every request, so the first cyber refusal on an inferred holder
  records the profile's own observed reading, which decides from then on.
  Inference is computed on read and never stored. It applies everywhere the
  map is read: `cvpAccess` on `/profiles/list`, `cyber_verification` on
  `/v1/models`, `cvpHolders`, cvp routing and the pin check.
- **`x-meridian-require: cvp` routes unpinned work to CVP access, in its own
  order.** Two switchers run side by side: the general one owns
  `activeProfile`, `profileOrder` and `routingManagedExcludedProfiles`, a
  cybersec one owns `cvpActiveProfile`, `cvpProfileOrder` and
  `cvpManagedExcludedProfiles`. cvp work walks `cvpProfileOrder` (empty or
  unset: the pool order), skips the user's `routingExcludedProfiles`, the held
  profiles and `cvpManagedExcludedProfiles` but not
  `routingManagedExcludedProfiles` (an account rested from general work may
  still take cvp work), and is cut to profiles whose map shows `active` access
  on the requested model before any other rule runs. `cvpActiveProfile` heads
  it when it qualifies, else the first that does; the general active profile
  never heads cvp work. Reserve, weekly, bench and Extra Usage skips apply and
  failover stays in that set; a retained route that does not qualify is
  refused. Under `active` and `sticky` a resolved profile without access (or
  outside that set) is replaced by `cvpActiveProfile`, else the first in the
  cvp order, that qualifies and is not reserve-held; sticky keeps its hashed
  profile while it qualifies. Unflagged work reads none of the three cvp
  settings. A profile out by an exclusion reports reason `excluded`. With none, the request is refused unsent with
  `no_routable_account` and reason `no_cvp` (null `resets_at`: waiting will
  not grant access). Pins, warms and priority hops are exempt from that
  routing, but a pin carrying the header whose account's map shows the model
  `inactive` is refused unsent with `403 profile_no_cvp` (a profile with no
  reading for the model is sent, and its refusal teaches the map); an unknown
  requirement token is 400, so a newer client's requirement is never routed
  as if met. `GET /v1/models` with the header lists only models with access:
  a pinned account's own, or unpinned every reachable account's, each with
  `cvp_profiles` in that order; every pinned entry the map knows carries
  `cyber_verification`. `GET /settings/api/routing` lists `cvp-routing` and
  `cvp-order` in `capabilities` and reports `cvpProfileOrder` (as saved, `[]`
  when unset), `cvpEffectiveProfileOrder` (what cvp work walks),
  `cvpActiveProfile` (`null` when unset), `cvpManagedExcludedProfiles` and
  `cvpHolders` (per normalized model, the profiles whose map shows `active`
  access, in the effective order, exclusions not applied) with
  `cvpInferredHolders` (per model, those of them holding it by organization
  inference, each mapped to its `inferredFrom` sibling; capability
  `cvp-organization-inference`). `PUT` takes each
  independently, atomically with the rest of the body: the order and the
  pointer name Claude profiles only (400 otherwise; `null` clears the pointer,
  `[]` the order), the managed list any strings. A rename rewrites the order
  and pointer, a removal drops the profile from them. They are an instance's
  own and `meridian instance import` leaves them behind, as it does every
  Claude-profile setting. Telemetry rows record the known tokens a request
  named as `routingRequire` (absent without the header).
- **`x-meridian-require: restricted` keeps unpinned work off every CVP
  holder.** A CVP-holding account spends one weekly allowance on every model,
  so work that needs no exemption is kept off all of them and leaves that
  allowance to cvp work. A holder is a profile whose map, organization
  inference included, shows `active` access on any model, the same reading
  `cvpHolders` reports; the test is account-wide, not per model. `cvp` and
  `restricted` in one header answer 400 `invalid_request_error`, as an
  unknown token does. Unpinned restricted work is cut to the other profiles
  before any other rule runs, and within them the general switcher's routing
  applies unchanged: `activeProfile` (a pointer on a holder is passed for the
  first in `profileOrder`), `profileOrder`, `routingExcludedProfiles`,
  `routingManagedExcludedProfiles`, held profiles, reserve, weekly, bench and
  Extra Usage skips, retained routes, failover inside the set and route-refusal
  attestation over the set alone. It reads none of the three cvp settings.
  Holders are left out of every refusal's `profiles`, so their resets never
  name the wait. When every profile is a holder, the request is refused
  unsent with `no_routable_account` and reason `no_restricted` for every
  profile (null `resets_at`: waiting will not take access away); a retained
  route on a holder is refused the same way. With some outside but all spent
  or out, the refusal is the ordinary one with its reasons and resets. A pin
  carrying the header to a holder is refused unsent with `403
  profile_has_cvp`; a pin with no reading is sent. Warms and priority hops are
  exempt. `GET /v1/models` with the header lists unpinned only the models some
  reachable restricted profile (not excluded or held) serves, each with
  `restricted_profiles` in the general order; pinned, the account's own list,
  or an empty one for a holder. `GET /profiles/route-availability` with it
  judges a Claude return over the restricted profiles alone.
  `GET /settings/api/routing` lists `restricted-routing` in `capabilities`
  and reports `restrictedProfiles`: the profiles that are not holders, in the
  effective general order, exclusions not applied. Telemetry records the
  token in `routingRequire`.
- **`x-meridian-cybersec-preservation` decides per request whether plain work keeps off preserved holders.** A supervisor keeping CVP holders for cybersec work lists them in `routingManagedExcludedProfiles` with evidence value `cybersec-preserved`. Whether unpinned Claude work with no `x-meridian-require` meets those exclusions is the request's preservation: the header's `on` or `off` (case-insensitive), else `cybersecPreservationDefault`, a boolean on `GET/PUT /settings/api/routing` written atomically with the rest of the body (`null` clears it; unset is `true`, which is how every earlier build behaved). Any other header value answers 400 `invalid_request_error`. On, those exclusions apply as written. Off, the profiles the evidence names `cybersec-preserved` are not managed-excluded for that request, and every other rule still applies: the user's own list, holds, every other managed value, reserve, weekly, bench and Extra Usage skips. Which managed exclusions are preserved is read from the last evidence the supervisor wrote, whatever its age, because a policy describes the list as written and the evidence goes with any write of the lists that does not replace it; with no evidence (after a restart, until the next write) nothing is bypassed. A pointer an `on` request keeps off is passed for the first eligible in `profileOrder`, as restricted work does. Refusal `profiles` and route-refusal attestation follow the request's set, so `off` work on a pool where only preserved holders are left is served there rather than attested. cvp and restricted work ignore the header, since cvp work never reads the general managed list and restricted work keeps off every holder; pins, warms and priority hops are exempt. The default also governs the pointer: while it is `false`, `POST /profiles/active` may activate a preserved holder, the reconcile after a routing write leaves the pointer on one and `/profiles/list` reports it active; while it is `true` they treat preserved holders as managed-excluded, as before. `GET /profiles/route-availability` judges a plain Claude return under the request's preservation and answers unavailable for an invalid value; `GET /v1/models` refuses an invalid value and otherwise answers as before, since the plain list never depends on exclusions. `GET /settings/api/routing` lists `cybersec-preservation-per-request` in `capabilities` and reports `cybersecPreservationDefault` (effective: `true` when unset) and `cybersecPreservedProfiles` (the profiles the last evidence names `cybersec-preserved`). Telemetry rows of unpinned Claude work with no requirement record `cybersecPreservation` (`on` or `off`) and `cybersecPreservationSource` (`header` or `default`); pinned, warm and `x-meridian-require` rows carry neither.
- **One incident per outage.** The first `pool_exhausted` event on
  `/profiles/events` since a Claude account last served work opens an
  incident `inc_<epoch ms>_<seq>` (that event's own `at` and `seq`); every
  later one carries it, with `requestId`, `profiles[{id, reason, resetsAt}]`
  and `resetAt` (ISO) beside the existing fields, until the next Claude
  request served by any account appends `pool_recovered` with the same
  `incidentId` and closes it. Warm hops do not close it. In memory only, like
  the event ring.
- **Cooldowns are layered:** Anthropic's named reset first, then the profile's
  own observed window (5-hour or 7-day, capped per window), then a 10-minute
  default. An OAuth-usage refinement may only *extend* a cooldown, runs only at
  full utilization, is not awaited, and is skipped for non-`claude-max` and
  billing refusals.
- **A per-model weekly refusal benches only that model.** When Anthropic
  names a per-model weekly bucket (`seven_day_opus`, `seven_day_sonnet`,
  `seven_day_fable`) for a refused request of that same model family, pool
  routing skips the profile only for requests of that family (the tier
  `mapModelToClaudeModel` sends the request to; Mythos is fable), until that
  bucket's named reset, else its own exhausted window, capped like `seven_day`,
  else the 10-minute default. Other models keep using the profile. An inferred
  (`cached_usage`) bucket, an unknown one, or one naming another family keeps
  the profile-wide bench: a wrong per-model guess would keep sending every
  other request into an account that refuses them all. A confirmed reset that
  clears the bucket lifts its model bench. `/profiles/list` (pool modes) and
  `/profiles/health` list these as `exhaustedModels`
  (`{id, modelFamily, until, reason}`); `exhausted` keeps profile-wide marks
  only. The `spent` record (`/v1/usage/quota/all`, `/profiles/list`,
  `/profiles/health`) keeps its fields and adds `modelFamily`
  (`"opus" | "sonnet" | "fable" | null`): non-null exactly when this refusal
  took the per-model path, so the profile is benched for that family alone.
  `diagnosis.bucket` cannot say that on its own, because a rejected SDK event
  from an earlier refusal can name a bucket this refusal was not benched for.
- **Account identity is Meridian's own record, re-read per credential.**
  `GET /api/oauth/profile` supplies the organization name, account and
  organization UUIDs and email; they are kept in `organizations.json` beside
  settings (never in a credential file, which Claude Code owns and rewrites),
  keyed by profile, with the stored access token's expiry they were read for.
  The page path only reads the file; a record is refreshed in the background
  when it is a day old or when the stored token changes (login, re-login,
  renewal), and a finished Meridian sign-in reads it at once. The file is
  replaced atomically (temporary file + rename, owner-only).
- **Only a record read for the current token is trusted.** The shown email
  comes from that account read in preference to `claude auth status`, whose
  cached email still names the previous account after a Meridian sign-in; a
  record read for an earlier (or unreadable) token falls back to
  `claude auth status` and contributes nothing to duplicate detection, so a
  profile re-logged into another account with `claude login` is never flagged
  from its previous account's record.
- **Login history is Meridian's own record, per credential.**
  `auth-lifecycle.json` beside settings (Claude Code owns and wipes the
  credential file) keeps, keyed by the credential store's `refreshKey`: when
  the current grant was obtained and whether Meridian performed the login
  (`login`) or found it on disk (`observed`, timed when noticed), Meridian's
  last renewal of that grant, the last deadline seen, a truncated SHA-256 of
  the refresh token (never the token), and when and why authentication was
  first found failing. A rename that moves the credential directory moves
  the record, and removing a profile deletes the records of the credential
  directories it removed. Every transition is logged and stored in
  diagnostics under `auth`.
- **Writers serialize across processes.** The server and
  `meridian profile login` both write the file. Each update reads, applies
  and publishes under one exclusive lock file (`lockedFile.ts`, shared with
  `profileConfigStore.ts`), so no transition is overwritten by a stale copy.
  A file that cannot be parsed is never replaced, and a held or failed lock
  leaves the file as it was. Reads for display take no lock.
- **The history never holds up a request.** Token refreshes and
  `/profiles/list` queue their history writes in the background, one at a
  time, and never await them; `/profiles/list` shows the record the
  observation leads to before it is written. A lock left behind by an
  interrupted writer therefore costs only skipped history entries, never a
  slower refresh or page. Only `meridian profile login`, a rename and a
  removal wait for the lock.
- **Only a grant rejection is a logout.** A refresh answered with RFC 6749
  `invalid_grant` is `refresh_rejected`, and only when a successful re-read
  shows the refused refresh token is still the stored one, twice, 750 ms
  apart (another Claude Code process may have just rotated it). Other OAuth
  errors, statuses without that code, outages and unreadable stores record
  nothing: unknown stays unknown. A credential read successfully with no
  access token is `credentials_cleared`.
- **A new grant replaces the record.** The refresh token identifies the
  grant: a different one with a different deadline, nearer or later, is a
  new login (`new_grant`, `observed`); with the same deadline it is the same
  grant rotated elsewhere; where either side's token or deadline is unknown
  and what is known differs, the record keeps no login time
  (`credential_replaced`) rather than a wrong one. A new grant or a Meridian
  login drops the previous grant's renewal time, deadline and logout.
- **A refused renewal still serves.** Its access token keeps working until it
  expires, so until then `/profiles/list` keeps `loggedIn` and the card says
  "Renewal refused, stops in …" next to the access-token countdown. Only
  after that expiry, or for a cleared credential, is the account logged out
  (`loggedIn: false`, "Logged out … ago").
- **Duplicate badges are informational.** `duplicateOf` /
  `duplicateBasis` on `/profiles/list` name profiles holding one account: a
  Claude account is account UUID **and** organization UUID (email **and**
  organization name only while the UUIDs are unknown); a ChatGPT seat is its
  seat id, or the same email in the same workspace; email alone never matches,
  and providers never match each other. Nothing is removed, renamed or
  excluded because of a badge.
- **A quota refusal speaks for every profile signed in to that account.**
  Profiles holding one Claude account hold one quota, so under pool routing a
  quota refusal on one marks every other such profile exhausted until the same
  reset (and the OAuth-usage refinement extends them with it), and the
  request's remaining candidates skip them instead of spending an attempt each
  to hear the same answer. The proof is stricter than the badge's: the account
  UUID **and** organization UUID only, never email and organization name, and
  only from records read for the access token each profile stores at the
  moment of the refusal, the refused profile's own included
  (`organizationRecordCurrent`). A profile re-logged into another account with
  `claude login` still carries its previous account's record until the
  background re-read lands, and benching it on that record would park a
  healthy account until someone else's reset. Credentials are read only for
  profiles whose saved record already names the refused account, so a fleet
  without twins pays no read. A failed lookup benches no one beyond the
  refused profile. Billing and other refusals stay per profile: only a quota
  refusal carries a reset that is the account's own.
  A per-model weekly refusal benches each such profile for that model family
  only, the same way it benches the refused profile.
- **A finished sign-in reports its re-read.** Every completed sign-in marks the
  profile `factsRefresh: updating` before the route answers, re-reads account,
  usage and auth status, then clears it or reports `failed` with the reason for
  five minutes; a newer sign-in supersedes an older run, and rename/removal
  forgets it.
- **Sticky routing is stateless** (rendezvous hashing): stickiness survives
  restarts without a persisted map, and adding a profile moves only the
  sessions that hash to it.
- **The default Claude context is checked only while a request can reach it**
  (#1471). With profiles configured, `resolveProfile` never yields the implicit
  `default`, so the CLI's start-up `claude auth status` pre-flight runs only
  when no profile exists or an effective profile has no credential override of
  its own (a bare `claude-max` profile, or an `api`/`oauth-token` one without
  its key or token), and the 45 s auth keepalive refreshes the default context
  only once no profile is left (`usesDefaultAuthContext`,
  `authKeepaliveTargets`). A signed-out host login therefore neither stops nor
  warns a profiles-only instance; the active profile's sign-in state surfaces
  on `/health`, and every profile's on `/profiles/list` and in the keepalive's
  log. A profile without an override is cached under its own id, which the
  default-context refresh never served, so the keepalive skips it and requests
  refresh it.
- **Banked resets are explicit-only** (owner-approved 2026-10-26, #1429).
  `GET /v1/usage/quota/all` lists each Claude profile's grants; only
  `POST /v1/usage/quota/reset` with an explicit `profile`, `grantId` and
  `requestId` redeems one. Meridian never redeems automatically (not on a
  refusal, failover, cooldown or poll) and never retries the mutation: a reset
  spends a scarce grant, and Anthropic does not promise to deduplicate it.
- **One redemption per profile, remembered per request ID.** While a
  redemption is in flight for a profile, any other for that profile gets 409
  `reset_in_progress` with no upstream call. Once the mutation POST has been
  dispatched, its outcome — confirmed, rejected *or uncertain* — is remembered
  in memory by (profile, requestId), bounded (256 entries, oldest evicted) and
  for 15 minutes. A repeat with the same requestId and grantId replays that
  response with `replayed: true` and sends nothing; the same requestId with a
  different grantId is 409 `request_id_conflict`. Uncertain outcomes are
  reported as `indeterminate: true`, never as success or failure, and replaying
  them is the point: a blind client retry after a lost response must not spend
  a second grant. Failures before dispatch (no token, unreadable organization)
  are not remembered, since nothing was sent. A restart forgets the ledger.
- **A confirmed reset is an explicit exception to "refinement may only extend
  a cooldown" and "a profile switch clears nothing".** Only a fresh (not
  replayed) `result: "reset"` may clear local state, and only the SDK buckets
  the provider lists in `cleared`, plus spent/exhaustion marks for that same
  profile whose reported bucket was cleared and that are quota refusals within
  the expected window. Uncleared weekly/model buckets, independent overage
  state, unknown-bucket and non-quota refusals, and other profiles are
  untouched; `already_used`, other results and uncertain outcomes clear
  nothing.
- **Usage reads resolve the profile type first.** `/v1/usage/quota`,
  `/v1/usage/quota/all`, cooldown refinement and redemption run
  `resolveProfile` before touching credentials, so a profile whose type is
  inferred from `oauthToken` (or mislabelled `claude-max` with a token) reports
  type `oauth-token` / `not_oauth` instead of reading the host's on-disk OAuth
  account under its id, and `/v1/usage/quota` returns `oauth: null` for any
  non-`claude-max` target.
- **A follower reads usage from the instance it follows.** Under
  `MERIDIAN_FOLLOW_ACTIVE`, unforced usage reads serve the followed
  instance's `/v1/usage/quota/all` figures (matched by profile id, polled every
  two minutes, marked `stale` after five, withdrawn after ten) and make no
  Anthropic call. Forced reads, and profiles the followed instance could not
  read, use this instance's own credentials; a forced read newer than the
  followed copy is not replaced by it.
- **OAuth usage request identity.** Usage, identity and reset requests send
  `User-Agent: claude-cli/<version> (external, cli)`, where `<version>` is the
  `@anthropic-ai/claude-code` package installed with Meridian
  (`bundledClaudeCodeVersion`), because Anthropic gates banked-reset
  eligibility by client version (`ineligible_reason: "cli_version"`) and the
  identity should match the client Meridian actually ships. Only when that
  package cannot be read does it fall back to a pinned `2.1.304`, the client
  the cedar_ember contract was read from; bump it with that contract. The usage
  GET adds only `?cedar_ember=1` (not Claude Code's `skip_spend=1`, which would
  drop `extra_usage`); it is on every usage read because all reads share one
  per-profile snapshot cache, and it only adds the `cedar_ember` block —
  windows and `extraUsage` parse identically with or without it. The identity
  and reset requests carry no query flags.
- **Extra Usage amounts are served in major units.** The usage endpoint's
  `extra_usage.monthly_limit` / `used_credits` are minor units (cents):
  claude.ai's admin API reports the same member's limit as
  `{amount_minor: 500, exponent: 2}` where this endpoint says `500`.
  `extraUsage.monthlyLimit` / `usedCredits` are divided by
  `10^decimal_places` (2 when absent) and carry that as `exponent`, whose
  presence tells a consumer the amounts are dollars; a followed instance or
  service without it still serves cents and is converted. Used may exceed the
  limit (a turn that starts under it can finish past it), and Anthropic clamps
  `utilization` at 100, so displays take the share from the amounts and show
  the overshoot.
- **Grant-selection fields are passed through, not computed.** `bankedResets`
  exposes the provider's `nextGrantId` (null unless it names a listed grant)
  and `ineligibleReason`, and per grant `startsAt`, `paused` and `usableNow`;
  malformed values become `null`. Meridian never picks a grant itself.

### Banked reset scope

- `kind: "full"` means the provider lists `seven_day` in `clears`. For example, `full-reset-2611` has `type: "weekly"` and clears `seven_day` and `seven_day_overage_included`. A Team grant with `type: "full"` also counts as full if it clears `seven_day`; the raw type does not determine scope.
- `kind: "fable"` identifies the known Fable launch grants (`launch-2610-fable`, `launch-2610-fable-6mo`, `launch-2610-fable-12mo`) when `clears` contains `seven_day_overage_included` and no other window except optional `five_hour`, and `gives_back_weekly` is not explicitly false. Personal grants have been observed clearing only the former; Team grants clear both. The observed grants have `type: "full"` and `gives_back_weekly: true`. Order and repeated window IDs do not affect classification or change the reported `clears`. Other grant IDs do not become Fable grants just because they share these windows and flags.
- If `clears` is absent or null, those exact IDs are a fallback when `gives_back_weekly` does not contradict the known scope. An explicit empty or different list, or an unreadable list, does not trigger that fallback. If no rule identifies the scope, `kind` is `"unknown"` and the provider's ID, type and label remain available.
- `providerType`, `clears`, `givesBackWeekly`, `description` and `percentUsed` preserve the corresponding readable provider metadata. `description` is the provider's `label`, not a scope rule. `percentUsed` keeps finite numeric values from 0 through 100 inclusive, including `seven_day_overage_included` and unfamiliar window IDs, without rescaling or coercing them. These fields describe the inventory only; 0% does not override the provider's `usableNow` flag.

## Cross-provider evidence

- Direct `POST /v1/responses` ChatGPT requests opt in with `x-meridian-route-refusal: 1` and a fresh UUID v4 `x-request-id`. Before any inference dispatch, Meridian can answer an OpenAI-envelope HTTP 429 JSON with response header `x-meridian-route-refusal: 1` and `error: {type:"rate_limit_error",code:"no_routable_account",request_id,route_refusal:{version:1,phase:"before_inference",sent:false,provider:"chatgpt",model,variant,reason}}`. `model` and explicitly present `reasoning.effort` are the exact wire strings; `reason` is `quota_exhausted` or `reserve_held`. Trust only the configured Meridian connection, HTTP status/content type, local response marker, matching UUID and exact route together. The marker is never forwarded from the upstream. No SSE, internal hop, image or translated format carries GPT proof.
- GPT proof is emitted only when the normal work queue, including eligible free/loaner seats and any allowed purchased credits, cannot dispatch. The full known fleet must be in scope, with exact catalog model/effort support and successful account-wide usage evidence tied to current seat credentials, at most two minutes old. Model/generic cooldowns, unknown/stale usage or allowed credit balance, manual exclusions/holds, pins, CVP, mixed causes, fallback models, budget policy and any already-attempted dispatch cannot attest. Failure to prove leaves the ordinary route and response unchanged.
- A supervisor can send `routingManagedChatGptExclusionEvidence: {version:1,observedAt,reasons}` to the authenticated same-origin `PUT /settings/api/routing` if GET advertises `managed-chatgpt-exclusion-evidence-v1`. Use epoch milliseconds for `observedAt` (oldest trustworthy governing observation), and canonical ChatGPT public profile IDs from the resulting managed exclusion list as keys. Typed values: `spent`, `usage-reserve`, `weekly-reserve`, `loaner-gate`. Evidence is process-local, expires after two minutes, and is cleared by `null` or a related policy write without replacement. If a governing poll is inconclusive and GET reports `routingManagedChatGptExclusionEvidenceActive: true`, the supervisor sends `null` even if the exclusions are unchanged. Delayed samples cannot restore cleared or broader evidence at an equal or older timestamp. Partial evidence may be published but cannot attest; every seat must be managed-excluded for the same typed reason and still pass the model, authentication and policy guards. No Claude IDs or display text are accepted on this field.

- A Claude client can supply `x-meridian-route-refusal: 1` and a fresh UUID v4 in `x-request-id`, then verify the same value in the refusal's existing `error.request_id`. Before dispatch the normal unpinned pool can answer HTTP 429 JSON `error.route_refusal: {version:1, phase:"before_inference", sent:false, provider:"claude", model, reason}`. `model` is the incoming wire model verbatim. `reserve_held` means every profile has the same usage-reserve or weekly-reserve hold. `quota_exhausted` requires at least one eligible Claude Max profile and every eligible profile's latest account-wide five-hour or weekly reading to be 100% with a future reset and no more than two minutes old; accounts excluded by the supervisor do not participate. A manual exclusion, forced account, unknown or stale quota, and any available or uncertain Extra Usage leave ordinary dispatch in place. This treats model-specific limits as insufficient evidence of an account-wide cap. No attestation is added to SSE frames, account retries already dispatched, retained or pinned routes, no-CVP, no-restricted, or billing refusals; restricted work attests over the restricted profiles alone. Clients without the request binding keep their existing behavior.
- `GET /profiles/route-availability?provider=chatgpt&model=<wire model>&variant=<wire effort>` uses the existing `/profiles/*` API-key gate and returns `Cache-Control: no-store`. Its response is `{version:1,provider,model,variant,available,routable_allotment,observed_at}`. A positive answer requires the upstream catalog to list that exact effort and the eligible seat's plan, a currently routable unpinned seat, and successful identity-confirmed plan windows at most 30 seconds old from that seat's current credential. Pins, forced routes, routing requirements, and unknown, stale or missing evidence return `available:false`, zero and null; invalid queries return 400. `routable_allotment` is the largest eligible seat's remaining fraction in its tightest observed plan window; `observed_at` is that seat's usage-read epoch milliseconds. The read does not refresh a token, spend/reset credits, send inference, reveal seats, or reserve admission. Ordinary target admission still applies and can disagree if conditions change.
- Preferred-return checks use the same endpoint with `provider=claude`. It accepts exact lowercase, numerically versioned Claude wire IDs for Opus, Fable, Mythos, Sonnet and Haiku, and requires a literal SDK effort (`low`, `medium`, `high`, `xhigh`, `max`) explicitly supported for that model in the account's upstream catalog. No missing, default, or guessed effort is attested. An omitted query value returns 400; a well-formed query without proof returns false, zero and null. The same wire ID qualification applies to the opt-in Claude refusal; it neither certifies GPT origin nor changes legacy dispatch or error shape.
- Claude return evidence requires a normal unpinned subscription pool account with a present, unexpired credential and no known auth failure. Both the successful OAuth usage reading and the catalog must come from the currently stored credential; a followed instance's display quota does not prove credential ownership. Governing windows are the account's five-hour and weekly limits plus reported family and exact model windows. Mythos retains its exact model entitlement but follows Fable's routing bench and weekly allowance, which Anthropic may report as `seven_day_fable` or `seven_day_overage_included` (included allowance, not purchased Extra Usage). Fable-tier allowance must be observed; a reported unreadable or exhausted governing window, stale evidence, newer governing SDK refusal, routing bench, reserve hold, exclusion, or drawing or unknown Extra Usage disqualifies the account. Forced routes, pins, CVP requirements and the `immediately` Extra Usage policy do not qualify. A missing or obsolete catalog may start a bounded account-model read without refreshing credentials; the current request stays unavailable until there is positive evidence. The probe never reads usage upstream, spends paid credits, or sends inference.
- A supervisor on a build advertising `managed-exclusion-evidence-v1` can include `routingManagedExclusionEvidence: {version:1,observedAt,reasons}` in its authenticated `PUT /settings/api/routing`. Keys are canonical Claude IDs on the resulting managed exclusion list. Values are `spent`, `usage-reserve`, `weekly-reserve`, `extra-usage`, `loaner-gate`, `unmeasured-loaner` or `unmeasured-loaner-cap`; display reason text is not evidence. `observedAt` is the oldest governing source observation in epoch milliseconds. A process keeps this evidence at most two minutes from observation and forgets it on restart or an exclusion/hold/reserve write without replacement evidence. Explicit `null` also clears it. Invalid and future samples return 400; an out-of-order update returns 409. Partial submissions are accepted, but automatic switching requires positive coverage for each managed-excluded account and no manual hold, pin or CVP requirement. Full managed capacity exclusion can attest `quota_exhausted` without changing the existing refusal; without fresh complete evidence it remains an ordinary park. A build advertising `managed-exclusion-cybersec-preserved` also accepts the policy value `cybersec-preserved`: a CVP holder the supervisor keeps out of general work so its allowance stays for cvp work. It covers that account but proves nothing spent, so an attestation still needs every other managed-excluded account to carry a capacity value and at least one account in the pool to prove capacity; a pool only preserved accounts empty stays an ordinary park. A preserved account's own usage reset never names the refusal's `reset_at` or its `resets_at` (null), since it reopens nothing. Evidence changes routing only through per-request preservation (`x-meridian-cybersec-preservation`, above): with preservation on a preserved holder stays out of unflagged work, and cvp work, which does not read `routingManagedExcludedProfiles`, is unchanged. A build without the capability rejects the whole payload carrying the value, as it does any unknown value.

## Known limitations

- A refresh token rotated by another process and given a new deadline in the
  same rotation reads as a new login found on disk. Rotations measured so
  far keep the deadline.
- A refresh Claude Code performs itself is not a Meridian renewal, so it
  never sets `lastRefreshAt`.
- Exhaustion and cooldown state is in memory; a restart forgets it.
- A twin benched by a shared-quota refusal and then signed in to another
  account with `claude login` stays benched until that reset, exactly as the
  refused profile itself would; a Meridian sign-in or `/auth/refresh` clears
  it.
- A twin whose access token was renewed after its account was last read is not
  recognized until that record is read again, which happens when something
  polls `/profiles/list` (any open Meridian page does). On an instance with no
  page open, the busy twin has usually renewed, so the request still tries it
  once and hears the same refusal, as it did before.
- **No failover after content streams.** A rate limit arriving after the first
  real SSE frame is relayed to the client instead of failing over —
  deliberately, so a stream the client is consuming is never yanked.
- A followed instance behind `MERIDIAN_API_KEY` always fails the follow poll
  (no credentials are sent) and the follower falls back to its local profile.
- Clients with no session identity bench `[1m]` profile-wide on a rate limit,
  because there is nothing narrower to scope it to.
