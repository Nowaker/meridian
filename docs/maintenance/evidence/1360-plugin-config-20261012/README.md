# Config-local plugin loading — source #1360

Disposition: accept with corrections, pending full and affected-flow acceptance.
Current-main e0f9feab defaults plugin paths to the user's global Meridian tree
although MERIDIAN_CONFIG_DIR selects a separate instance. The original manifest
assertion and added discovery-isolation control both fail there; the same
assertions pass after the actual authored cherry-pick. Explicit plugin directory
and manifest settings retain precedence. No exported configuration type, route,
or lifecycle interface changes.

Source219160f2796422b31a54f2ed52ad101a44137f5a -> cherry-pick13abefad5 preserves
Nowaker's Author and AuthorDate2026-10-13T00:05:10Z. Maintainer corrections add
CLI help consistency and controls for distinct configuration roots, retained
per-instance plugin lists and explicit directory/manifest precedence.
[Regression receipt](regression.json): baseline2 failures; corrected34 tests /
79 assertions and typecheck pass. The baseline loader read existing global
plugin names; no /v1/messages or live inference was invoked by those assertions.

Full local `npm test`, standalone typecheck and build passed on frozen
584bd172826e192282b20bb1a586a04fc6447da7; see [receipt](full-local-gates.json).

Remaining: actual source/independently installed CLI isolation, final-head CI
and affected client/model/plugin evidence.
Current account credentials are unavailable; no refresh or paid-usage workaround.
Source #1360 stays open until completed incorporation is verified.
