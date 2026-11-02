// A Session is live only while its owner performs operations or renews its heartbeat.
export const SESSION_IDLE_MS = 5 * 60 * 1000;

export class SessionDeadlineError extends Error {
  constructor(operation, milliseconds) {
    super(operation + ' exceeded ' + milliseconds + 'ms deadline');
    this.name = 'SessionDeadlineError';
  }
}

// A VM timeout cannot terminate an unresolved async Promise.
// Callers must revoke Session helpers when a deadline expires.
export async function withinDeadline(promise, milliseconds, operation) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new SessionDeadlineError(operation, milliseconds)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function staleSession(session, now = Date.now(), ttl = SESSION_IDLE_MS) {
  return !session.closing && !(session.inFlight > 0) && !(session.pendingEffects > 0) &&
    (session.poisoned === true || now - session.last_used_at >= ttl);
}

export function idleUrlFromIdentity(identityUrl) {
  const url = new URL(identityUrl);
  if (url.protocol !== 'chrome-extension:' || !['/workspace.html', '/helm.html'].includes(url.pathname)) {
    throw new Error('invalid extension identity URL');
  }
  const workspace = url.searchParams.get('workspace');
  if (!workspace) throw new Error('missing workspace in extension identity URL');
  // Construct the canonical idle URL from scratch. Never copy lease identity
  // or unrelated query parameters into an idle tab.
  url.search = new URLSearchParams({workspace, role:'idle'}).toString();
  return url.href;
}

export function sameIdleUrl(actual, expected) {
  try {
    const url = new URL(actual), idle = new URL(expected);
    return url.protocol === 'chrome-extension:' && url.href === idle.href;
  } catch { return false; }
}
