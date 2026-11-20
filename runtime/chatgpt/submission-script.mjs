import { SEND_ENABLED_JS } from "./lifecycle-common.mjs";

/** Source executed inside a caller-owned WebHelm Session, never a separate tab. */
// Called only in a queue-owned browser Session. Do not check composer content
// or look for a Stop/user-turn/Send-disabled receipt after clicking.
export function submissionScript(item) {
  const selectorJS = "(() => { const selector='button[aria-label=\"Send\"],button[data-testid=\"send-button\"],button[aria-label=\"Send prompt\"],form button[type=\"submit\"]'; for(const b of document.querySelectorAll('[data-webhelm-queue-send]'))b.removeAttribute('data-webhelm-queue-send'); for(const b of document.querySelectorAll(selector)){if(!b.getClientRects().length||b.disabled||b.getAttribute('aria-disabled')==='true')continue;b.setAttribute('data-webhelm-queue-send','1');return '[data-webhelm-queue-send=\"1\"]';} return null; })()";
  return [
    "return await (async()=>{",
    "const actualId=await js("+JSON.stringify("location.pathname.split('/c/')[1]?.split('/')[0]||''")+");",
    "if(actualId!=="+JSON.stringify(item.thread_id)+")return {diagnostic:'thread_redirect_mismatch'};",
    "if(!(await js("+JSON.stringify(SEND_ENABLED_JS)+")))",
    "  return {diagnostic:'pre_send_gate_not_ready'};",
    "const selector=await js("+JSON.stringify(selectorJS)+");",
    "if(!selector)return {diagnostic:'send_control_not_found'};",
    "await click(selector);",
    "return {verified_by:'send-clicked'};",
    "})()",
  ].join("\n");
}
