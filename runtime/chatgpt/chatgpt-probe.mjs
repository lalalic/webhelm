export const PROMPT_FILE_THRESHOLD = 2000;
export const PROMPT_FILE_MESSAGE = 'Read prompt.md and execute the task in that file.';

// When a prompt is attached as prompt.md, retain its leading reporting
// contract in the visible composer. Otherwise ChatGPT may never read the
// attachment, leaving the caller waiting for chat_report indefinitely.
export function inlineTopInstructions(message) {
  const open='<top-instructions>', close='</top-instructions>';
  if (!message.startsWith(open)) return null;
  const end=message.indexOf(close,open.length);
  if (end<=open.length||end>1800) return null;
  const header=message.slice(0,end+close.length);
  const next=message.slice(end+close.length,end+close.length+250);
  const responseId=next.match(/Neo model request: resp_[0-9a-f]{40}/)?.[0]||'';
  const preview=header+(responseId?'\n\n'+responseId:'')+'\n\n'+PROMPT_FILE_MESSAGE;
  return preview.length<=PROMPT_FILE_THRESHOLD?preview:null;
}
export function deliveryMessage(message) {
  if (message.length<=PROMPT_FILE_THRESHOLD) return message;
  return inlineTopInstructions(message)??PROMPT_FILE_MESSAGE;
}

export function targetUrl(projectId, threadId, message) {
  if (!threadId || !message) {
    throw new Error("thread_id and message are required");
  }
  // A thread identity is global; ChatGPT may redirect /c/id to a
  // Project-scoped /g/project-id[-slug]/c/id. Use the ordinary URL.
  return "https://chatgpt.com/c/" + encodeURIComponent(threadId) +
    "?" + new URLSearchParams({ prompt: deliveryMessage(message) });
}
export const PROBE_JS = `(() => {
  const visible = e => !!e && !!e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
  const body = (document.body?.innerText || '').toLowerCase();
  if (body.includes('could not load this chatgpt conversation'))
    return {state: 'BLOCKED', error: 'thread_load_failed'};
  if (body.includes('log in to chatgpt') || body.includes('sign in to chatgpt'))
    return {state: 'BLOCKED', error: 'authentication_required'};
  const stop = [...document.querySelectorAll('button')].some(b => {
    if (!visible(b)) return false;
    const label = (b.getAttribute('aria-label') || '').trim().toLowerCase();
    const title = (b.getAttribute('title') || '').trim().toLowerCase();
    const testId = (b.getAttribute('data-testid') || '').trim().toLowerCase();
    return ['stop generating', 'stop answering', 'stop response', 'stop'].includes(label) ||
      ['stop generating', 'stop answering'].includes(title) ||
      ['stop-button', 'stop-generating-button'].includes(testId);
  });
  if (stop) return {state: 'RUNNING', stop_visible: true};
  const e = [...document.querySelectorAll('#prompt-textarea,[contenteditable="true"][data-lexical-editor="true"],[role="textbox"][contenteditable="true"],textarea')].find(visible);
  const editable = e?.getAttribute?.('contenteditable') === 'true';
  // ProseMirror uses <p> for each visual line, including empty lines.
  // e.textContent and, in some Chrome builds, e.innerText omit those line
  // boundaries, so a correctly prefilled multiline prompt never matches.
  const paragraphs = editable ? [...e.children] : [];
  const composerText = editable && paragraphs.length && paragraphs.every(p => p.tagName === 'P')
    ? paragraphs.map(p => p.textContent || '').join('\\n')
    : editable ? (e.innerText || e.textContent || '') : (e?.value || e?.textContent || e?.innerText || '');
  return {state: visible(e) ? 'READY' : 'NOT_READY', stop_visible: false, composer_text: composerText};
})()`;
export function classifyProbe(observedUrl, expectedUrl, state) {
  const actual = new URL(observedUrl), expected = new URL(expectedUrl);
  const thread = url => {
    const match = url.pathname.split('/c/')[1]?.split('/')[0] || null;
    return match ? decodeURIComponent(match) : null;
  };
  if (actual.protocol !== "https:" || actual.host !== "chatgpt.com" ||
      !thread(actual) || thread(actual) !== thread(expected)) return "BLOCKED";
  if (["RUNNING", "BLOCKED"].includes(state?.state)) return state.state;
  const prompt = expected.searchParams.get("prompt") || "";
  const normalize = text => String(text || "").replace(/\s+/g, " ").trim();
  if (actual.search && actual.searchParams.get("prompt") !== prompt) return "NOT_READY";
  return state?.state === "READY" && normalize(state.composer_text) === normalize(prompt)
    ? "READY"
    : "NOT_READY";
}
