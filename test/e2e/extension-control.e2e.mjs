import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import {setTimeout as sleep} from 'node:timers/promises';
import {stageExtension,EXTENSION_ID} from '../../runtime/extension-manager.mjs';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'webhelm-rename-e2e-'));
const browserLog=fs.openSync(path.join(root,'browser.log'),'a');
const daemonLog=fs.openSync(path.join(root,'daemon.log'),'a');
const extension=stageExtension(path.join(root,'extension'));
// One explicitly opted-in mock platform verifies the full daemon -> platform
// Action -> Extension status path without contacting a real authenticated site.
const mockPlatforms=path.join(root,'platforms');
const mockPlatform=path.join(mockPlatforms,'e2e-platform');
fs.mkdirSync(path.join(mockPlatform,'actions'),{recursive:true});
fs.writeFileSync(path.join(mockPlatform,'manifest.yaml'),`platform: e2e-platform
url_patterns:
  - https://example.invalid/*
actions:
  heartbeat: actions/_heartbeat.mjs
keep_alive:
  action: heartbeat
  interval_minutes: 30
  url: https://example.invalid/
`);
fs.writeFileSync(path.join(mockPlatform,'actions','_heartbeat.mjs'),
  `export default async function heartbeat(){return {status:'login_required'};}\n`);
const port=await new Promise((resolve,reject)=>{
  const server=net.createServer();server.once('error',reject);
  server.listen(0,'127.0.0.1',()=>{const p=server.address().port;server.close(()=>resolve(p));});
});
const env={...process.env,WEBHELM_CONFIG_ROOT:path.join(root,'config'),
  WEBHELM_LOCAL_ROOT:path.join(root,'local'),WEBHELM_RUNTIME_DIR:path.join(root,'runtime'),
  WEBHELM_SOCKET:path.join(root,'runtime','session-node.sock'),
  WEBHELM_LOCK:path.join(root,'runtime','session-node.lock'),
  WEBHELM_CDP_URL:`http://127.0.0.1:${port}`,
  WEBHELM_EXTENSION_HOME:extension.path,
  WEBHELM_CHATGPT_QUEUE_PAUSED:'1',
  WEBHELM_PLATFORM_DIR:mockPlatforms,WEBHELM_SITE_HEARTBEAT_POLL_MS:'1000'};
const browserPath=process.env.WEBHELM_TEST_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const chrome=spawn(browserPath,[
  `--user-data-dir=${path.join(root,'chrome')}`,`--remote-debugging-port=${port}`,
  '--no-first-run','--no-default-browser-check','--headless=new','--disable-gpu','about:blank'],
  {stdio:['ignore',browserLog,browserLog]});
let daemon, ws, seq=0;
const pending=new Map();
async function waitFor(fn,label,retries=80){
  for(let i=0;i<retries;i++){
    try {const result=await fn();if(result)return result;} catch{}
    await sleep(170);
  }
  throw Error('Timed out waiting for '+label);
}
function connect(wsUrl){
  return new Promise((resolve,reject)=>{
    ws=new WebSocket(wsUrl);
    ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});
    ws.addEventListener('message',event=>{
      const data=JSON.parse(event.data);if(!data.id)return;
      const task=pending.get(data.id);if(!task)return;pending.delete(data.id);
      data.error?task.reject(Error(data.error.message)):task.resolve(data.result);
    });
  });
}
async function cdp(method,params={},sid){
  const id=++seq;
  const promise=new Promise((resolve,reject)=>pending.set(id,{resolve,reject}));
  ws.send(JSON.stringify({id,method,params,...(sid?{sessionId:sid}:{})}));
  return Promise.race([promise,sleep(12000).then(()=>{pending.delete(id);throw Error('CDP timeout: '+method)})]);
}
const attach=async tid=>(await cdp('Target.attachToTarget',{targetId:tid,flatten:true})).sessionId;
async function evaluate(sid,expr){
  const result=await cdp('Runtime.evaluate',{expression:expr,returnByValue:true,awaitPromise:true},sid);
  if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));
  return result.result?.value;
}
async function mouseClick(sid,selector){
  const rect=await evaluate(sid,`(()=>{const r=document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect();return r&&{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  assert.ok(rect,`visible element ${selector}`);
  await cdp('Input.dispatchMouseEvent',{type:'mouseMoved',x:rect.x,y:rect.y},sid);
  await cdp('Input.dispatchMouseEvent',{type:'mousePressed',x:rect.x,y:rect.y,button:'left',clickCount:1},sid);
  await sleep(1_700); // Cross the popup's 1.5-second refresh while the press is held.
  await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',x:rect.x,y:rect.y,button:'left',clickCount:1},sid);
}
async function rpc(workerSid,method,args={}){
  const value=await evaluate(workerSid,`globalThis.browserWorkspaceManagerRpc(${JSON.stringify({method,args})})`);
  if(!value?.ok)throw Error('Extension RPC '+method+' '+JSON.stringify(value));
  return value.result;
}
async function request(payload){
  return new Promise((resolve,reject)=>{
    const connection=net.createConnection(env.WEBHELM_SOCKET);
    let data='';
    connection.setEncoding('utf8');
    connection.on('connect',()=>connection.write(JSON.stringify(payload)+'\n'));
    connection.on('data',chunk=>data+=chunk);
    connection.on('end',()=>{
      try {const item=JSON.parse(data);item.error?reject(Error(item.error)):resolve(item);}
      catch(error){reject(error);}
    });
    connection.on('error',reject);
  });
}
try {
  const wsUrl=await waitFor(async()=>{
    const res=await fetch(env.WEBHELM_CDP_URL+'/json/version');
    return (await res.json()).webSocketDebuggerUrl;
  },'isolated Chrome');
  await connect(wsUrl);
  const loaded=await cdp('Extensions.loadUnpacked',{path:extension.path});
  assert.equal(loaded.id,EXTENSION_ID);

  const worker=await waitFor(async()=>(await cdp('Target.getTargets')).targetInfos.find(
    target=>target.type==='service_worker' && target.url.includes(EXTENSION_ID)), 'Extension worker');
  let workerSid=await attach(worker.targetId);
  await waitFor(()=>rpc(workerSid,'workspace.list'),'extension worker ready');
  const pinned=await evaluate(workerSid,"chrome.tabs.create({url:'about:blank',pinned:true,active:false})");
  assert.equal(pinned.pinned,true);
  const legacy=await waitFor(()=>rpc(workerSid,'workspace.ensure',{name:'Harness',poolSize:4}),'legacy Harness created');
  console.log('Legacy Harness group created');
  const ordinary=await evaluate(workerSid,"chrome.tabs.create({url:'about:blank',active:false})");
  const beforeMigration=await evaluate(workerSid,`chrome.tabs.query({windowId:${pinned.windowId}}).then(tabs=>tabs.map(({id,index,groupId})=>({id,index,groupId})).sort((a,b)=>a.index-b.index))`);
  const legacyIndex=beforeMigration.find(tab=>tab.groupId===legacy.groupId)?.index;
  assert.ok(Number.isInteger(legacyIndex),'legacy group exists in the original tab strip');
  await cdp('Target.detachFromTarget',{sessionId:workerSid});

  fs.mkdirSync(env.WEBHELM_RUNTIME_DIR,{recursive:true});
  daemon=spawn(process.execPath,[path.join(repo,'runtime/node-daemon.mjs'),'daemon'],{
    env,stdio:['ignore',daemonLog,daemonLog]
  });
  await waitFor(async()=>fs.existsSync(env.WEBHELM_SOCKET) && (await request({op:'ping'})).ok, 'daemon');
  const first=await Promise.race([request({op:'start'}),sleep(15000).then(()=>{throw Error('Isolated daemon Session did not start');})]);
  assert.equal(first.workspace,'WebHelm');
  workerSid=await attach(worker.targetId);
  const badgeText=()=>evaluate(workerSid,'chrome.action.getBadgeText({})');
  assert.equal(await waitFor(async()=>await badgeText()==='1'?'1':null,'badge one Session'),'1');
  await waitFor(async()=>{
    const status=await rpc(workerSid,'workspace.control.status');
    return status.sessions?.some(session=>session.session_id===first.session_id && Number.isInteger(session.tabId))?true:null;
  },'daemon tab ownership snapshot');
  const liveGroup=(await rpc(workerSid,'workspace.list')).workspaces.find(w=>w.name==='WebHelm');
  // Model an abandoned daemon lease, not an unowned Chrome-created blank tab
  // (the extension deliberately ungroups unrelated blank tabs).
  const orphanLease=await rpc(workerSid,'workspace.acquireIdentity',{name:'WebHelm'});
  const orphanTab=await evaluate(workerSid,`chrome.tabs.update(${orphanLease.tabId},{url:'about:blank',active:false})`);
  const firstLease=await rpc(workerSid,'workspace.acquireIdentity',{name:'WebHelm'});
  await rpc(workerSid,'workspace.release',{name:'WebHelm',tabId:firstLease.tabId});
  const beforeRecovery=(await rpc(workerSid,'workspace.status',{name:'WebHelm'})).physicalTabs;
  await sleep(61_000);
  const recoveryLease=await rpc(workerSid,'workspace.acquireIdentity',{name:'WebHelm'});
  await rpc(workerSid,'workspace.release',{name:'WebHelm',tabId:recoveryLease.tabId});
  const recoveredOrphan=await evaluate(workerSid,`chrome.tabs.get(${orphanTab.id})`);
  assert.equal(recoveredOrphan.url,`chrome-extension://${EXTENSION_ID}/helm.html?workspace=WebHelm&role=idle`);
  assert.equal(recoveredOrphan.id,orphanTab.id,'orphan recovery navigates the original Chrome tab');
  assert.equal((await rpc(workerSid,'workspace.status',{name:'WebHelm'})).physicalTabs,beforeRecovery,
    'orphan recovery neither replaces nor adds a managed tab');
  const activeTarget=(await cdp('Target.getTargetInfo',{targetId:first.target_id})).targetInfo;
  assert.equal(activeTarget.targetId,first.target_id,'daemon-owned active Session tab was not recovered');
  console.log('ORPHAN RECOVERY PASS: same tab identity retained; daemon-owned Session excluded');
  let groups=await rpc(workerSid,'workspace.list');
  assert.ok(groups.workspaces.some(w=>w.name==='WebHelm'));
  assert.ok(!groups.workspaces.some(w=>w.name==='Harness'));
  const webhelmId=groups.workspaces.find(w=>w.name==='WebHelm').groupId;
  const order=await evaluate(workerSid,`chrome.tabs.query({}).then(tabs=>tabs.filter(tab=>tab.windowId===${pinned.windowId}).map(({id,index,pinned,groupId})=>({id,index,pinned,groupId})).sort((a,b)=>a.index-b.index))`);
  assert.equal(order[0].id,pinned.id,'pinned tab remains leftmost');
  assert.equal(order.find(tab=>tab.groupId===webhelmId)?.index,legacyIndex,
    'legacy migration preserves the actual Chrome tab group position');
  const ordinaryBefore=beforeMigration.find(tab=>tab.id===ordinary.id)?.index;
  const ordinaryAfter=order.find(tab=>tab.id===ordinary.id)?.index;
  assert.ok(Number.isInteger(ordinaryAfter),'unowned ordinary tab is not removed');
  assert.equal(Math.sign(ordinaryAfter-order.find(tab=>tab.groupId===webhelmId).index),
    Math.sign(ordinaryBefore-legacyIndex),'migration preserves ordinary tab relative to the group');
  console.log('GROUP MIGRATION ORDER PASS:',JSON.stringify(order.slice(0,4)));
  const preservedTargetId=first.target_id;
  const stopped=await request({op:'stop',session_id:first.session_id});
  assert.equal(stopped.returned_to_idle,true);
  assert.equal(stopped.returned_tabs,1);
  assert.equal(stopped.closed_tabs,0);
  const info=(await cdp('Target.getTargetInfo',{targetId:preservedTargetId})).targetInfo;
  assert.equal(info.targetId,preservedTargetId);
  assert.equal(info.url,`chrome-extension://${EXTENSION_ID}/helm.html?workspace=WebHelm&role=idle`);
  assert.equal(await waitFor(async()=>await badgeText()==='0'?'0':null,'badge zero Sessions'),'0');
  console.log('SESSION CLOSE PASS: original CDP tab retained at helm.html idle:',preservedTargetId);

  const preLease=await rpc(workerSid,'workspace.acquireIdentity',{name:'WebHelm'});
  assert.match(preLease.identityUrl,new RegExp('tabId='+preLease.tabId+'(?:&|$)'));
  assert.equal(preLease.idleUrl,`chrome-extension://${EXTENSION_ID}/helm.html?workspace=WebHelm&role=idle`);
  await rpc(workerSid,'workspace.release',{name:'WebHelm',tabId:preLease.tabId});

  await assert.rejects(request({op:'start',workspace:'VlogMusic'}),/does not exist|must provision/);
  const missing=(await rpc(workerSid,'workspace.list')).workspaces;
  assert.ok(!missing.some(w=>w.name==='VlogMusic'),'refused start did not create a Workspace');
  // An extension page used by a browser Session must not provision groups.
  const untrustedPage=(await cdp('Target.createTarget',{url:`chrome-extension://${EXTENSION_ID}/popup.html`})).targetId;
  const untrustedSid=await attach(untrustedPage);
  const untrusted=await waitFor(async()=>evaluate(untrustedSid,`chrome.runtime.sendMessage({method:'workspace.create',args:{name:'VlogMusic'}})`),'restricted extension management');
  assert.equal(untrusted.ok,false);
  assert.match(untrusted.error.message,/application daemon API/);
  await cdp('Target.closeTarget',{targetId:untrustedPage});
  const appCreated=await request({op:'workspace-create',name:'Custom',pool_size:8});
  assert.equal(appCreated.name,'Custom');
  const afterCreate=await evaluate(workerSid,`chrome.tabs.query({windowId:${pinned.windowId}}).then(tabs=>tabs.map(({id,index,groupId})=>({id,index,groupId})).sort((a,b)=>a.index-b.index))`);
  const leftmostUnpinned = afterCreate.find(tab => tab.id === pinned.id).index + 1;
  assert.equal(afterCreate[leftmostUnpinned].groupId,appCreated.groupId,'new custom group is leftmost after pinned tabs');
  assert.ok(afterCreate.find(tab=>tab.id===ordinary.id).index > leftmostUnpinned);
  console.log('NEW GROUP LEFTMOST PASS:',JSON.stringify(afterCreate.slice(0,4)));
  const maliciousPage=(await cdp('Target.createTarget',{url:`chrome-extension://${EXTENSION_ID}/helm.html`})).targetId;
  const maliciousSid=await attach(maliciousPage);
  await waitFor(async()=>evaluate(maliciousSid,"typeof chrome !== 'undefined' && !!chrome.runtime"),'extension page ready');
  for (const method of ['workspace.acquireIdentity','workspace.acquire','workspace.releaseAll','workspace.resize']) {
    const denied=await evaluate(maliciousSid,`chrome.runtime.sendMessage({method:${JSON.stringify(method)},args:{name:'Custom',poolSize:16}})`);
    assert.equal(denied.ok,false,method+' cannot mutate application workspaces through an extension page');
    assert.match(denied.error.message,/application daemon API/);
  }
  await cdp('Target.closeTarget',{targetId:maliciousPage});

  const main=await request({op:'start'});
  const custom=await request({op:'start',workspace:'Custom'});
  assert.equal(main.workspace,'WebHelm');
  assert.equal(custom.workspace,'Custom');
  const runCli=(...args)=>spawnSync(process.execPath,[path.join(repo,'runtime/cli.mjs'),...args],{
    encoding:'utf8',env,timeout:12000,
  });
  const listed=runCli('session','list');
  assert.equal(listed.status,0,listed.stderr);
  assert.deepEqual(JSON.parse(listed.stdout).sessions.map(s=>s.session_id),[main.session_id]);
  const denied=runCli('session','stop',custom.session_id);
  assert.equal(denied.status,1,'CLI may not stop an application-owned Session');
  assert.match(denied.stderr,/not owned by the WebHelm CLI workspace/);
  const helpers=await request({op:'exec',session_id:main.session_id,code:"console.log(typeof workspace_create,typeof workspace_resize,typeof workspace_delete)"});
  assert.equal(helpers.stdout,'undefined undefined undefined');
  assert.equal(await waitFor(async()=>await badgeText()==='2'?'2':null,'badge two Sessions'),'2');
  const popupTarget=(await cdp('Target.createTarget',{url:`chrome-extension://${EXTENSION_ID}/popup.html`})).targetId;
  const popupSid=await attach(popupTarget);
  const displayed=await waitFor(async()=>{
    const v=await evaluate(popupSid,`({
      text:document.body.innerText,
      daemon:document.querySelector('#daemon-status')?.textContent,
      duplicateTitle:!!document.querySelector('header h1'),
      groups:[...document.querySelectorAll('.workspace-row')].map(row=>({
        label:row.querySelector('.workspace-title strong')?.textContent,
        stats:row.querySelector('.workspace-details')?.textContent,
        action:row.querySelector('.workspace-title button')?.textContent,
      })),
      hasGlobalStop:!!document.querySelector('#clear'),
      hasTotals:!!document.querySelector('.stats'),
      height:document.body.scrollHeight,
    })`);
    return v?.daemon==='Online' && v.groups.length===2?v:null;
  },'two-group popup');
  assert.equal(displayed.duplicateTitle,false,'the workspace name appears only in its own row');
  assert.equal(displayed.hasGlobalStop,false);
  assert.equal(displayed.hasTotals,false);
  assert.ok(displayed.groups.every(group=>group.action==='Clear sessions'));
  assert.ok(displayed.groups.every(group=>/1 session$/.test(group.stats)));
  assert.ok(displayed.height<450,'popup remains compact with two active workspaces');
  console.log('COMPACT WORKSPACE UI',JSON.stringify({groups:displayed.groups,height:displayed.height}));
  // Keep Alive is attached to the site URL, not to a Session. The Session can
  // subsequently navigate away or stop without removing the registered site.
  const registeredOrigin='https://example.invalid';
  const firstSite=await request({op:'exec',session_id:main.session_id,
    code:"await cdp('Page.navigate',{url:'https://example.invalid/account?token=not-saved'})"});
  assert.equal(firstSite.ok,true,JSON.stringify(firstSite));
  // A Custom-Workspace Session visiting the same HTTPS site must not expose
  // Keep Alive, and must be rejected by the Service Worker even if invoked
  // directly (UI hiding alone is insufficient).
  const customSite=await request({op:'exec',session_id:custom.session_id,
    code:"await cdp('Page.navigate',{url:'https://example.invalid/custom'})"});
  assert.equal(customSite.ok,true,JSON.stringify(customSite));
  await waitFor(async()=>{
    const state=await rpc(workerSid,'workspace.control.status');
    return state.workspaces.find(w=>w.name==='Custom')?.sessions[0]?.tab_url?.startsWith('https://example.invalid');
  },'Custom Session HTTPS navigation');
  await assert.rejects(rpc(workerSid,'workspace.control.site.toggle',{sessionId:custom.session_id,enabled:true}),
    /only from a WebHelm Session/);
  await waitFor(async()=>evaluate(popupSid,`(()=>{const sections=[...document.querySelectorAll('.workspace-row')];const custom=sections.find(r=>r.querySelector('.workspace-title strong')?.textContent==='Custom');return custom && ![...custom.querySelectorAll('.session-row button')].some(b=>b.textContent==='Keep Alive'||b.textContent==='On')})()`),
    'Custom workspace has no Keep Alive toggle');
  await waitFor(async()=>evaluate(popupSid,`[...document.querySelectorAll('.session-row button')].some(button=>button.textContent==='Keep Alive')`),
    'site Keep Alive button on leased tab');
  await evaluate(popupSid,`[...document.querySelectorAll('.session-row button')].find(button=>button.textContent==='Keep Alive').click()`);
  const siteAdded=await waitFor(async()=>{
    const state=await rpc(workerSid,'workspace.control.status');
    return state.keptSites.find(site=>site.id===registeredOrigin);
  },'site registered');
  assert.equal(siteAdded.url,registeredOrigin);
  assert.equal(JSON.stringify(siteAdded).includes('not-saved'),false);
  assert.equal(await waitFor(async()=>evaluate(popupSid,"document.querySelector('.keepalive-row .tab-title')?.textContent==='example.invalid'"),'site shown in Extension popup'),true);
  const loginRequired=await waitFor(async()=>{
    const state=await rpc(workerSid,'workspace.control.status');
    return state.keptSites.find(entry=>entry.id===registeredOrigin && entry.status==='login_required') || null;
  },'platform heartbeat reports login required');
  assert.equal(loginRequired.platform,'e2e-platform');
  const compact=await waitFor(async()=>evaluate(popupSid,`(()=>{const row=document.querySelector('.keepalive-row'),dot=row?.querySelector('.keepalive-status'),label=row?.querySelector('.keepalive-name'),remove=row?.querySelector('.keepalive-remove');return dot?.dataset.status==='inactive'&&label&&remove?{rowHeight:row.getBoundingClientRect().height,dotColor:getComputedStyle(dot).backgroundColor,greenLabel:label.classList.contains('is-logged-in'),removeLabel:remove.getAttribute('aria-label'),text:row.innerText,children:row.children.length}:null})()`),
    'compact gray login-required site row');
  assert.ok(compact.rowHeight <= 32,'one-line site row stays compact');
  assert.equal(compact.children,3,'dot, hostname and remove share one row');
  assert.equal(compact.greenLabel,false);
  assert.match(compact.removeLabel,/Remove example.invalid/);
  assert.ok(!compact.text.includes('Login required'),'status is shown by color, not a second line');
  const markedAlive=await rpc(workerSid,'workspace.control.site.report',{
    id:siteAdded.id,revision:siteAdded.revision,status:'alive',platform:'e2e-platform'});
  assert.equal(markedAlive.ok,true);
  const green=await waitFor(async()=>evaluate(popupSid,`(()=>{const dot=document.querySelector('.keepalive-status'),label=document.querySelector('.keepalive-name');return dot?.dataset.status==='alive'&&label?.classList.contains('is-logged-in')?{color:getComputedStyle(dot).backgroundColor,title:label.title}:null})()`),
    'green logged-in site row');
  assert.notEqual(green.color,compact.dotColor);
  assert.match(green.title,/Logged in/);
  console.log('COMPACT KEEP ALIVE UI PASS: one-line gray/green status and accessible remove');
  await waitFor(async()=>(await request({op:'list'})).session_count===2,
    'temporary heartbeat Session released');
  console.log('PLATFORM HEARTBEAT PASS: optional Action returned login_required, temporary Session released');
  console.log('KEEP ALIVE SITE TOGGLE PASS: website registered without token or Session binding');
  // Real isolated Chrome: title resolution and tab activation use the leased tab,
  // not a generated session identifier. Do not touch signed-in Chrome tabs.
  const titlePage='data:text/html,%3Ctitle%3EReview%20Target%20Tab%3C%2Ftitle%3E';
  const navigation=await request({op:'exec',session_id:main.session_id,
    code:`console.log(await goto_url(${JSON.stringify(titlePage)}));`});
  assert.equal(navigation.ok,true,JSON.stringify(navigation));
  const tabTitle=await waitFor(async()=>evaluate(popupSid,
    `[...document.querySelectorAll('.tab-title')].some(button=>button.textContent==='Review Target Tab')`),
    'popup real tab title');
  assert.equal(tabTitle,true);
  await evaluate(popupSid,`[...document.querySelectorAll('.tab-title')].find(button=>button.textContent==='Review Target Tab').click()`);
  const activated=await waitFor(async()=>{
    const tabs=await evaluate(workerSid,"chrome.tabs.query({active:true})");
    return tabs.some(tab=>tab.title==='Review Target Tab');
  },'Session tab activation');
  assert.equal(activated,true);
  console.log('SESSION TITLE ACTIVATION PASS');

  const receipt=await request({op:'chatgpt-new-turn-enqueue',config:{
    thread_id:'webhelm-e2e-title-test',message:'Review this draft\nprivate next line',idempotency_key:'webhelm-e2e-title-entry',mergeable:true,
  }});
  assert.equal(receipt.ok,true);
  const queueDisplayed=await waitFor(async()=>evaluate(popupSid,
    `({title:document.querySelector('.queue-title')?.textContent, heading:document.querySelector('.queue-platform-title')?.textContent, remove:document.querySelector('.queue-row button:last-child')?.textContent})`)
    .then(row=>row.title==='Review this draft' && row.remove==='Remove'?row:null), 'queue title and remove');
  assert.equal(queueDisplayed.title,'Review this draft');
  assert.equal(queueDisplayed.heading,'ChatGPT Queue');
  await evaluate(popupSid,'globalThis.__queueTitleNode=document.querySelector(".queue-title")');
  await mouseClick(popupSid,'.queue-title');
  assert.equal(await evaluate(popupSid,'document.querySelector(".queue-title")===globalThis.__queueTitleNode'),true,
    'the popup retains the clicked queue node across a refresh');
  const opened=await waitFor(async()=>{
    const tabs=await evaluate(workerSid,'chrome.tabs.query({})');
    return tabs.some(tab=>tab.url?.startsWith('https://chatgpt.com/c/webhelm-e2e-title-test'));
  },'queue title opens thread');
  assert.equal(opened,true);
  await mouseClick(popupSid,'.queue-title');
  const focusedQueueTabs=await evaluate(workerSid,"chrome.tabs.query({}).then(tabs=>tabs.filter(tab=>tab.url?.startsWith('https://chatgpt.com/c/webhelm-e2e-title-test')).map(tab=>({id:tab.id,active:tab.active})))");
  assert.equal(focusedQueueTabs.length,1,'repeated title click focuses the existing destination instead of opening a duplicate');
  assert.equal(focusedQueueTabs[0].active,true);
  await mouseClick(popupSid,'.queue-row button:last-child');
  await waitFor(async()=>{
    const queue=await request({op:'queue-list'});
    return !queue.items.some(item=>item.id===receipt.queue_id);
  },'queue item removal');
  const removalMessage=await waitFor(async()=>{
    const msg=await evaluate(popupSid,"document.querySelector('#message').textContent");
    return /Queue entry removed/.test(msg)?msg:null;
  },'Queue removal acknowledgement');
  assert.match(removalMessage,/Queue entry removed/);
  console.log('QUEUE SHORT TITLE / NAVIGATE / REMOVE PASS');
  await waitFor(async()=>evaluate(popupSid,"[...document.querySelectorAll('.workspace-title button')].every(button=>!button.disabled)"),'popup operations ready');

  await evaluate(popupSid,`[...document.querySelectorAll('.workspace-title button')].find(button=>button.parentElement.innerText.includes('Custom')).click()`);
  const chosen=await evaluate(popupSid,`document.querySelector('#confirm-text').textContent`);
  assert.match(chosen,/Custom/);
  await evaluate(popupSid,`document.querySelector('#cancel').click()`);
  assert.equal((await request({op:'list'})).sessions.length,2,'cancel does not stop sessions');
  await evaluate(popupSid,`[...document.querySelectorAll('.workspace-title button')].find(button=>button.parentElement.innerText.includes('Custom')).click()`);
  await evaluate(popupSid,`document.querySelector('#confirm').click()`);
  const after=await waitFor(async()=>(await request({op:'list'})).sessions, 'group stop').then(async()=>
    waitFor(async()=>{const r=await request({op:'list'});return r.sessions.length===1?r:null;},'Custom stop'));
  assert.equal(after.sessions[0].session_id,main.session_id);
  assert.equal(await waitFor(async()=>await badgeText()==='1'?'1':null,'badge one remaining Session'),'1');
  const stillMain=(await cdp('Target.getTargetInfo',{targetId:main.target_id})).targetInfo;
  assert.equal(stillMain.targetId,main.target_id);
  const customIdle=(await cdp('Target.getTargetInfo',{targetId:custom.target_id})).targetInfo;
  assert.equal(customIdle.url,`chrome-extension://${EXTENSION_ID}/helm.html?workspace=Custom&role=idle`);
  console.log('GROUP CLEAN PASS: Custom session stopped; WebHelm session preserved');

  const status=await waitFor(async()=>{
    const v=await evaluate(popupSid,`document.querySelector('#message').textContent`);
    return v.includes('stopped 1')?v:null;
  },'UI status');
  console.log('POPUP RESULT:',status);
  const stopMain=await request({op:'stop',session_id:main.session_id});
  assert.equal(stopMain.returned_to_idle,true);
  assert.equal(await waitFor(async()=>await badgeText()==='0'?'0':null,'badge final zero'),'0');
  assert.equal((await rpc(workerSid,'workspace.control.status')).keptSites.length,1,
    'Keep Alive site persists after its original browser Session stops');
  await evaluate(popupSid,"document.querySelector('.keepalive-row .tab-title').click()");
  await waitFor(async()=>{
    const tabs=await evaluate(workerSid,'chrome.tabs.query({})');
    return tabs.some(tab=>tab.url?.startsWith('https://example.invalid'));
  },'saved site reopened for manual login');
  await evaluate(popupSid,"document.querySelector('.keepalive-row button:last-child').click()");
  await waitFor(async()=>{
    const state=await rpc(workerSid,'workspace.control.status');
    return !state.keptSites.length;
  },'Keep Alive site removed');
  console.log('KEEP ALIVE RESTORE PASS: saved site survives Session stop, opens for login, and removes cleanly');
  const buttonsDisabled=await waitFor(async()=>await evaluate(popupSid,`[...document.querySelectorAll('.workspace-title button')].length>0 && [...document.querySelectorAll('.workspace-title button')].every(button=>button.disabled)`)?true:null,'disabled clear-session buttons at zero');
  assert.equal(buttonsDisabled,true);
  console.log('BADGE PASS: 1 → 0 → 2 → 1 → 0 across real daemon sessions');
  const appOwned=await request({op:'start',workspace:'Custom'});
  const cliOwned=await request({op:'start',workspace:'WebHelm'});
  const stoppedByCli=runCli('session','stop','--all');
  assert.equal(stoppedByCli.status,0,stoppedByCli.stderr);
  const remaining=(await request({op:'list'})).sessions;
  assert.deepEqual(remaining.map(s=>s.session_id),[appOwned.session_id]);
  assert.ok(!remaining.some(s=>s.session_id===cliOwned.session_id));
  await request({op:'stop',session_id:appOwned.session_id});
  console.log('CLI SCOPE PASS: CLI stop --all stops WebHelm, leaves app-owned Custom intact');
  console.log('E2E PASS');
} finally {
  ws?.close();
  if(daemon){daemon.kill('SIGTERM');await sleep(350);if(daemon.exitCode===null)daemon.kill('SIGKILL');}
  chrome.kill('SIGTERM');await sleep(350);if(chrome.exitCode===null)chrome.kill('SIGKILL');
  for(const item of pending.values())item.reject(Error('test closed'));
  fs.closeSync(browserLog);fs.closeSync(daemonLog);
  const log=fs.readFileSync(path.join(root,'daemon.log'),'utf8');
  if(log.includes('WebHelm extension control sync failed'))console.log('DAEMON WARNINGS:',log.slice(-2000));
  fs.rmSync(root,{recursive:true,force:true});
}
