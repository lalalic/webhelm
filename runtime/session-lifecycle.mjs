// A Session is live only while its owner performs operations or renews its heartbeat.
export const SESSION_IDLE_MS = 5 * 60 * 1000;

export function staleSession(session, now = Date.now(), ttl = SESSION_IDLE_MS) {
  return !session.closing && !(session.inFlight > 0) &&
    now - session.last_used_at >= ttl;
}

export function idleUrlFromIdentity(identityUrl, tabId) {
  const url = new URL(identityUrl);
  if (url.protocol !== 'chrome-extension:' || !url.pathname.endsWith('/workspace.html')) {
    throw new Error('invalid extension identity URL');
  }
  url.searchParams.set('role', 'idle');
  url.searchParams.set('slot', String(tabId));
  return url.href;
}

export function sameIdleUrl(actual, expected) {
  try {
    const url = new URL(actual), idle = new URL(expected);
    return url.protocol === 'chrome-extension:' && url.href === idle.href;
  } catch { return false; }
}
