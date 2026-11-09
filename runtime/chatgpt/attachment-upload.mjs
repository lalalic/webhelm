// Browser-side upload source for the existing WebHelm owned Session.
// Pure string generation; JSON encoding protects filenames and selector quotes.
const SELECTOR_JS = "(() => ['#upload-files','#upload-media','input[name=\"upload-media\"]','input[type=\"file\"]'].find(s=>document.querySelector(s))||null)()";
const OPEN_JS = "(() => {const b=[...document.querySelectorAll('button')].find(b=>(b.getAttribute('aria-label')||'').trim()==='Add files and more');if(b)b.click();return !!b;})()";
const STATE_JS = "(() => ({names:[...document.querySelectorAll('button[aria-label^=\"Remove \"]')].map(b=>(b.getAttribute('aria-label')||'').replace(/^Remove file\\s+\\d+:\\s*/,'').replace(/^Remove\\s+/,'')),pending:[...document.querySelectorAll('[role=\"progressbar\"],[aria-busy=\"true\"],[data-state=\"loading\"]')].some(e=>e.getClientRects().length>0)}))()";

export function attachmentUploadScript(paths) {
  if (!Array.isArray(paths) || !paths.length) return "({ready:true})";
  return [
    "return await (async()=>{",
    "const files="+JSON.stringify(paths)+";",
    "const locate=()=>js("+JSON.stringify(SELECTOR_JS)+");",
    "let input=await locate();",
    "if(!input){",
    " await js("+JSON.stringify(OPEN_JS)+");",
    " for(let i=0;i<40&&!input;i++){await sleep(150);input=await locate();}",
    "}",
    "if(!input)throw Error('ChatGPT file input unavailable');",
    "const names=[];",
    "for(const file of files){",
    " await upload_file(input,file);",
    " const name=file.split('/').pop();names.push(name);",
    " const expected=names.filter(n=>n===name).length;",
    " let ready=false;",
    " for(let i=0;i<480;i++){",
    "  const state=await js("+JSON.stringify(STATE_JS)+");",
    "  if(!state.pending&&state.names.filter(n=>n===name).length>=expected){ready=true;break;}",
    "  await sleep(250);",
    " }",
    " if(!ready)throw Error('ChatGPT attachment upload not confirmed: '+name);",
    "}",
    "return {ready:true,names};",
    "})()",
  ].join("\n");
}
