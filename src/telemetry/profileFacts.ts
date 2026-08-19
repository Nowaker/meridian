/**
 * What a profile card states about an account, in one place.
 *
 * Two surfaces render the same list — the detail grid on /profiles and the
 * hover overlay on the landing page — so the list lives here instead of being
 * written twice and drifting apart the first time a row is added.
 *
 * Emitted as browser source rather than a TypeScript function because the
 * pages are string templates concatenated at import time, the same arrangement
 * `profileBarJs` uses. The unit tests evaluate this exact text, so what they
 * assert is what the browser runs.
 *
 * Values are plain text; escaping is the page's job, since only the page knows
 * whether it is filling a grid cell or an overlay row.
 */
export const profileFactsJs = `
// Display strings, not the stored vocabulary: the server stores own/loaner,
// which every consuming scheduler already speaks. Here rather than on either
// page because both a <select> and a read-only row have to say the same words.
var OWNER_OPTIONS = [['', 'Not set'], ['own', 'Mine'], ['loaner', 'Borrowed']];

function ownerLabel(owner) {
  var current = owner || '';
  for (var i = 0; i < OWNER_OPTIONS.length; i++) {
    if (OWNER_OPTIONS[i][0] === current) return OWNER_OPTIONS[i][1];
  }
  return 'Not set';
}

// Mirrors src/telemetry/cachedFacts.ts, which is where these are unit-tested.
// Here rather than in either page because BOTH render the same fact list, and a
// marker that existed on only one of them would say a value is remembered on
// /profiles and current in the landing overlay.
function factProvenance(value, stale) {
  if (value == null || value === '') return 'never';
  return stale ? 'cached' : 'live';
}

function cachedTag(provenance) {
  return provenance === 'cached' ? '<span class="cached-tag">(cached)</span>' : '';
}

function timeAgo(ts) {
  if (!ts) return '\u2014';
  var s = Math.floor((Date.now() - ts) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return new Date(ts).toLocaleString();
}

function profileFacts(p) {
  var facts = [];
  // Status, Email and Plan are the three the auth check produces, so ONE failed
  // check makes all three remembered at once - which is why the provenance is
  // read off the profile rather than carried per fact. Everything below it
  // comes from elsewhere and is unaffected.
  var authProvenance = p.authProvenance || 'live';
  var authStale = authProvenance !== 'live';
  facts.push({
    label: 'Status',
    value: authProvenance === 'never'
      ? null
      : (p.loggedIn ? '\u2713 Authenticated' : '\u2717 Not logged in'),
    tone: p.loggedIn ? 'ok' : 'err',
    stale: authStale
  });
  facts.push({ label: 'Owner', value: ownerLabel(p.owner), tone: '' });
  if (p.email) facts.push({ label: 'Email', value: p.email, tone: '', stale: authStale });
  if (p.organizationName) facts.push({ label: 'Organization', value: p.organizationName, tone: '' });
  // Two rows, because two fields answer two questions and either can be known
  // without the other: a Team seat whose seat_tier is missing has a
  // trustworthy family and an unknowable plan.
  if (p.accountType) facts.push({ label: 'Account', value: p.accountType, tone: '' });
  var planName = p.planName || p.planLabel || p.subscriptionType;
  if (planName) {
    facts.push({
      label: 'Plan',
      value: planName,
      tone: '',
      hint: p.seatTier || p.rateLimitTier || '',
      stale: authStale
    });
  }
  if (p.allowance) {
    // The number that says how much work the account can do. The plan alone
    // does not: Max 5x and Max 20x both report "max" and differ 4x.
    facts.push({
      label: 'Allowance',
      value: p.allowance,
      tone: '',
      note: 'of a Pro plan’s Claude Code usage',
      hint: p.rateLimitTier || ''
    });
  }
  // Here rather than on the /profiles card alone: a name that still routes is
  // a fact about the account, so the landing page's overlay has to state it
  // too - somebody reading a card is entitled to know it answers to more names.
  if (p.aliases && p.aliases.length > 0) {
    facts.push({
      label: 'Former names',
      value: p.aliases.join(', '),
      tone: '',
      hint: 'Requests naming these are served by this profile, until the name is added again'
    });
  }
  if (p.lastSuccessAt) facts.push({ label: 'Last Verified', value: timeAgo(p.lastSuccessAt), tone: 'ok' });
  if (p.lastCheckedAt && p.lastCheckedAt !== p.lastSuccessAt) {
    facts.push({ label: 'Last Checked', value: timeAgo(p.lastCheckedAt), tone: '' });
  }
  return facts;
}
`
