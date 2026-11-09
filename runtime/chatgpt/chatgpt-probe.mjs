export function targetUrl(projectId, threadId, message) {
  if (!threadId || !message) {
    throw new Error("thread_id and message are required");
  }
  // A thread identity is global; ChatGPT may redirect /c/id to a
  // Project-scoped /g/project-id[-slug]/c/id. Use the ordinary URL.
  return "https://chatgpt.com/c/" + encodeURIComponent(threadId) +
    "?" + new URLSearchParams({ prompt: message });
}
export const PROBE_JS =
  `(() => { const visible=e=>!!e&&!!e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden'; const body=(document.body?.innerText||'').toLowerCase(); if(body.includes('could not load this chatgpt conversation'))return {state:'BLOCKED',error:'thread_load_failed'}; if(body.includes('log in to chatgpt')||body.includes('sign in to chatgpt'))return {state:'BLOCKED',error:'authentication_required'}; const stop=[...document.querySelectorAll('button')].some(b=>{if(!visible(b))return false;const l=(b.getAttribute('aria-label')||'').trim().toLowerCase(),t=(b.getAttribute('title')||'').trim().toLowerCase(),d=(b.getAttribute('data-testid')||'').trim().toLowerCase();return ['stop generating','stop answering','stop response','stop'].includes(l)||['stop generating','stop answering'].includes(t)||['stop-button','stop-generating-button'].includes(d)}); if(stop)return {state:'RUNNING',stop_visible:true}; const e=document.querySelector('#prompt-textarea,[contenteditable="true"][data-lexical-editor="true"],[role="textbox"][contenteditable="true"],textarea'); const editable=e?.getAttribute?.('contenteditable')==='true'; return {state:visible(e)?'READY':'NOT_READY',stop_visible:false,composer_text:e?(editable?(e.textContent||''):(e.value||e.textContent||e.innerText||'')):''}; })()`;
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
