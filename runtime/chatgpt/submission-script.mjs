import { PROBE_JS } from "./chatgpt-probe.mjs";
import { SEND_ENABLED_JS } from "./lifecycle-common.mjs";

/** Source executed inside a caller-owned WebHelm Session, never a separate tab. */
export function submissionScript(item) {
  const prompt = item.message.slice(0, 120);
  const selectorJS = "(() => { const selector=\'button[aria-label=\"Send\"],button[data-testid=\"send-button\"],button[aria-label=\"Send prompt\"],form button[type=\"submit\"]\'; for(const b of document.querySelectorAll(\'[data-webhelm-queue-send]\'))b.removeAttribute(\'data-webhelm-queue-send\'); for(const b of document.querySelectorAll(selector)){if(!b.getClientRects().length||b.disabled||b.getAttribute(\'aria-disabled\')===\'true\')continue;b.setAttribute(\'data-webhelm-queue-send\',\'1\');return \'[data-webhelm-queue-send=\"1\"]\';} return null; })()";
  const userTurnsJS = "(() => [...document.querySelectorAll('h4[data-conversation-role=\"user\"]')].filter(h=>(h.parentElement?.innerText||'').includes(" +
    JSON.stringify(prompt) + ")).length)()";
  return [
    "return await (async()=>{",
    "const gate=await js("+JSON.stringify(PROBE_JS)+");",
    "const actualId=await js("+JSON.stringify("location.pathname.split('/c/')[1]?.split('/')[0]||''")+");",
    "if(actualId!=="+JSON.stringify(item.thread_id)+
      ")return {diagnostic:'thread_redirect_mismatch'};",
    "if(gate?.state!=='READY'||!(await js("+JSON.stringify(SEND_ENABLED_JS)+")))",
    "  return {diagnostic:'pre_send_gate_not_ready'};",
    "if((gate.composer_text||'').replace(/\\s+/g,' ').trim()!=="+
      JSON.stringify(item.message.replace(/\s+/g,' ').trim())+")",

    "  return {diagnostic:'pre_send_gate_not_ready'};",
    "const selector=await js("+JSON.stringify(selectorJS)+");",
    "if(!selector)return {diagnostic:'send_control_not_found'};",
    "const before=(await js("+JSON.stringify(userTurnsJS)+"))||0;",
    "await click(selector);",
    "for(let i=0;i<140;i++){",
    " const count=(await js("+JSON.stringify(userTurnsJS)+"))||0;",
    " if(count>before)return {verified_by:'user-turn'};",
    " if(!(await js("+JSON.stringify(SEND_ENABLED_JS)+")))",
    "   return {verified_by:'send-button-disabled'};",
    " await sleep(250);",
    "}",
    "return {diagnostic:'post_submit_user_turn_not_confirmed_no_resend'};",
    "})()",
  ].join("\n");
}
