export const PROMPT_FILE_THRESHOLD = 2000;
export const PROMPT_FILE_MESSAGE = 'Read prompt.md and execute the task in that file.';

// Optional caller-supplied per-request constraints. No service-specific tags,
// response IDs, or protocol parsing belong in WebHelm.
export function enforcementContext(value = '') {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || !value.trim() || value.length > 1500 ||
      value.includes('</top-instructions>')) {
    throw new TypeError('enforcement_context must be a non-empty string of at most 1500 characters without closing tag');
  }
  return `<top-instructions>\n${value}\n</top-instructions>`;
}
export function fullDeliveryMessage(message, context = '') {
  const header = enforcementContext(context);
  return (header ? header+'\n\n' : '') + message;
}
export function requiresPromptFile(message, context = '') {
  return fullDeliveryMessage(message, context).length > PROMPT_FILE_THRESHOLD;
}
export function deliveryMessage(message, context = '') {
  const full = fullDeliveryMessage(message, context);
  if (full.length <= PROMPT_FILE_THRESHOLD) return full;
  const header = enforcementContext(context);
  if (!header) return PROMPT_FILE_MESSAGE;
  const short = header+'\n\n'+PROMPT_FILE_MESSAGE;
  if (short.length > PROMPT_FILE_THRESHOLD) throw new TypeError('enforcement_context exceeds the short message limit');
  return short;
}
export function targetUrl(projectId, threadId, message, enforcement_context = '') {
  if (!threadId || !message) {
    throw new Error("thread_id and message are required");
  }
  return "https://chatgpt.com/c/" + encodeURIComponent(threadId) +
    "?" + new URLSearchParams({ prompt: deliveryMessage(message, enforcement_context) });
}
// The target URL is supplied by ?prompt=. Do not inspect composer text or
// compare any rendered user message; only Send readiness controls submission.
export const PROBE_JS = `(() => {
  const body = (document.body?.innerText || '').toLowerCase();
  if (body.includes('could not load this chatgpt conversation'))
    return {state: 'BLOCKED', error: 'thread_load_failed'};
  if (body.includes('log in to chatgpt') || body.includes('sign in to chatgpt'))
    return {state: 'BLOCKED', error: 'authentication_required'};
  const ready = [...document.querySelectorAll('button[data-testid="send-button"],button[aria-label="Send prompt"],button[aria-label="Send"],form button[type="submit"]')]
    .some(b=>b.getClientRects().length>0 && !b.disabled && b.getAttribute('aria-disabled')!=='true');
  return {state: ready ? 'READY' : 'NOT_READY'};
})()`;
export function classifyProbe(observedUrl, expectedUrl, state) {
  const actual = new URL(observedUrl), expected = new URL(expectedUrl);
  const thread = url => {
    const match = url.pathname.split('/c/')[1]?.split('/')[0] || null;
    return match ? decodeURIComponent(match) : null;
  };
  if (actual.protocol !== "https:" || actual.host !== "chatgpt.com" ||
      !thread(actual) || thread(actual) !== thread(expected)) return "BLOCKED";
  if (state?.state === "BLOCKED") return "BLOCKED";
  return state?.state === "READY" ? "READY" : "NOT_READY";
}
