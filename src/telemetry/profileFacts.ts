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
 *
 * A ChatGPT seat (`provider: "chatgpt"` from /profiles/list) is a profile like
 * any other and gets the same facts. Where the vendor differs the words do:
 * its allowance is a multiple of ChatGPT Plus rather than of Claude Pro, its
 * banked rate-limit resets are a fact of their own, and its login belongs to
 * whatever owns the seat's credentials, which is usually not Meridian.
 */
export const profileFactsJs = `
function timeAgo(ts) {
  if (!ts) return '\\u2014';
  var s = Math.floor((Date.now() - ts) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return new Date(ts).toLocaleString();
}

function isChatGptProfile(p) {
  return !!p && (p.provider === 'chatgpt' || p.type === 'chatgpt');
}

// How long until a banked reset expires, in its largest whole unit: 13d, 5h, 40m.
function resetExpiryIn(ts, now) {
  var ms = ts - now;
  if (!(ms > 0)) return 'now';
  var minutes = Math.floor(ms / 60000);
  if (minutes < 60) return Math.max(1, minutes) + 'm';
  var hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + 'h';
  return Math.floor(hours / 24) + 'd';
}

// "1 (expires 13d)", "2 (expire 3d, 11d)", "0" - or "unknown" when the seat
// had no valid token to ask with. An expiry the list did not state reads as
// "unknown" in its place rather than shortening the list.
function formatResets(resets, now) {
  if (!resets || typeof resets.available !== 'number') return 'unknown';
  var count = resets.available;
  if (count <= 0) return '0';
  var expiries = Array.isArray(resets.expiresAt) ? resets.expiresAt : [];
  if (expiries.length === 0) return count + ' (expiry unknown)';
  var parts = expiries.map(function (ts) { return ts == null ? 'unknown' : resetExpiryIn(ts, now); });
  return count + ' (' + (parts.length === 1 ? 'expires ' : 'expire ') + parts.join(', ') + ')';
}

var CHATGPT_TOKEN_STATUS = {
  expired: '\\u2717 Access token expired',
  refused: '\\u2717 Token refused by chatgpt.com',
  no_token: '\\u2717 No access token',
  requires_reauth: '\\u2717 Needs sign-in',
  unknown: '\\u2717 Not in the credential store'
};

var CHATGPT_OWNER_STATE = {
  quota_exhausted: 'quota exhausted',
  cooling_down: 'cooling down',
  disabled: 'disabled',
  no_authority: 'no refresh authority'
};

function ownerName(owner) {
  if (!owner) return '';
  if (owner.name === 'meridian') return 'Meridian';
  return owner.name + (owner.account ? ' \\u00b7 account ' + owner.account : '');
}

function profileFacts(p) {
  var facts = [];
  var chatgpt = isChatGptProfile(p);
  var authStale = p.authProvenance && p.authProvenance !== 'live';
  var statusValue = p.authProvenance === 'never' ? 'never read'
    : p.loggedIn ? '\\u2713 Authenticated'
    : (chatgpt && CHATGPT_TOKEN_STATUS[p.tokenState]) || '\\u2717 Not logged in';
  facts.push({
    label: 'Status',
    value: statusValue,
    tone: p.loggedIn ? 'ok' : 'err',
    cached: authStale && p.authProvenance !== 'never'
  });
  if (p.email) facts.push({ label: 'Email', value: p.email, tone: '', cached: authStale });
  if (p.organizationName) facts.push({ label: 'Organization', value: p.organizationName, tone: '' });
  if (p.accountType) facts.push({ label: 'Account', value: p.accountType, tone: '' });
  var plan = p.planName || p.planLabel || p.subscriptionType;
  if (plan) facts.push({ label: 'Plan', value: plan, tone: '', cached: authStale, title: p.seatTier || p.rateLimitTier || (chatgpt ? p.subscriptionType || '' : '') });
  if (chatgpt) {
    facts.push({
      label: 'Resets',
      value: formatResets(p.resets, Date.now()),
      tone: '',
      title: 'Banked rate-limit resets, as chatgpt.com lists them. Each clears the seat\\u2019s windows once when redeemed '
        + '(oc-codex-multi-auth\\u2019s codex-reset tool); Meridian only reads them.'
    });
  }
  if (p.allowance) {
    facts.push({
      label: 'Allowance',
      value: p.allowance + (chatgpt ? ' of a ChatGPT Plus plan\\u2019s Codex usage' : ' of a Pro plan\\u2019s Claude Code usage'),
      shortValue: p.allowance,
      tone: '',
      title: p.rateLimitTier || ''
    });
  }
  if (chatgpt && p.owner) {
    facts.push({
      label: 'Owner',
      value: ownerName(p.owner),
      tone: '',
      title: p.owner.name === 'meridian'
        ? 'Meridian holds this seat\\u2019s login and renews its token.'
        : 'Meridian reads this seat\\u2019s login from ' + p.owner.name + ' and never changes it: sign-in, renewal and removal happen there.'
    });
  }
  if (chatgpt && CHATGPT_OWNER_STATE[p.unavailable]) {
    facts.push({ label: 'Owner state', value: CHATGPT_OWNER_STATE[p.unavailable], tone: '' });
  }
  if (p.aliases && p.aliases.length > 0) facts.push({ label: 'Former names', value: p.aliases.join(', '), tone: '', title: 'Requests naming these are served by this profile, until the name is added again' });
  if (p.lastSuccessAt) facts.push({ label: 'Last Verified', value: timeAgo(p.lastSuccessAt), tone: 'ok' });
  if (p.lastCheckedAt && p.lastCheckedAt !== p.lastSuccessAt) {
    facts.push({ label: 'Last Checked', value: timeAgo(p.lastCheckedAt), tone: '' });
  }
  return facts;
}

// How to give a profile that cannot serve back its access, in the words of
// whoever holds its login: Meridian's own command for a Claude profile, the
// owning tool's for a ChatGPT seat Meridian only follows. \`pill\` is the short
// label a card shows, \`reason\` why, \`summary\` the reason with the command
// to run - a tooltip's worth.
function profileAccessHelp(p) {
  if (!isChatGptProfile(p)) {
    return { pill: 'needs login', reason: 'Cannot serve requests.', summary: 'Cannot serve requests \\u2014 run: meridian profile login ' + p.id };
  }
  var owner = p.owner || {};
  if (owner.name === 'meridian') {
    var owned = 'Meridian holds this seat\\u2019s login and cannot renew it.';
    return { pill: 'needs login', reason: owned, summary: owned + ' Bring a fresh one in with: ' + owner.importCommand };
  }
  var signIn = owner.login + ' \\u2192 ' + owner.loginMethod + ' \\u2192 ' + (p.label || p.id) + ' \\u2192 Refresh account';
  if (p.tokenState === 'expired') {
    var expired = 'The access token expired. ' + owner.name + ' owns this login and renews it; Meridian only reads it.';
    return { pill: 'token expired', reason: expired, summary: expired + ' Renew it now: ' + owner.refresh };
  }
  if (p.tokenState === 'refused') {
    var refused = 'chatgpt.com refused this seat\\u2019s access token. ' + owner.name + ' owns this login; sign the seat in again there.';
    return { pill: 'token refused', reason: refused, summary: refused + ' Run: ' + signIn };
  }
  var missing = 'No usable access token. ' + owner.name + ' owns this login; sign the seat in there.';
  return { pill: 'needs login', reason: missing, summary: missing + ' Run: ' + signIn };
}

// Why a ChatGPT seat shows no usage windows, in a phrase; '' when nothing
// explains it yet. Claude profiles keep their own wording on each page.
var CHATGPT_USAGE_GAP = {
  token_expired: 'the access token expired, and Meridian never renews a token it follows',
  unauthorized: 'chatgpt.com refused this seat\\u2019s access token',
  no_token: 'there is no access token in the owner\\u2019s store',
  disabled: 'the seat is disabled at its owner',
  rate_limited: 'the usage endpoint is rate limiting, retrying',
  upstream_error: 'the usage endpoint failed, retrying',
  invalid_response: 'the usage endpoint answered with something unreadable, retrying',
  identity_mismatch: 'the stored token belongs to another account, so its usage is not shown',
  invalid_token: 'the stored access token could not be decoded'
};

function chatGptUsageGap(error) {
  return (error && CHATGPT_USAGE_GAP[error]) || '';
}

// Which vendor is refusing a profile, and what the page calls it.
function refusalSubject(p) {
  return isChatGptProfile(p) ? { vendor: 'ChatGPT', noun: 'seat' } : { vendor: 'Anthropic', noun: 'account' };
}
`
