#!/usr/bin/env node
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { invokePlatformAction } from './platforms.mjs';
import { ChatGPTQueue } from './chatgpt/chatgpt-queue.mjs';
import { idleUrlFromIdentity, sameIdleUrl, staleSession } from './session-lifecycle.mjs';
import { stopMatchingSessions } from './session-control.mjs';
import { ensureManagedChrome } from './chrome.mjs';
import { ensureExtensionLoaded } from './extension-manager.mjs';
import { createManagedChromeGuard } from './managed-chrome-guard.mjs';
import { PROFILE_DIR, RUNTIME_DIR, requireMigratedConfig } from './config-paths.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_VERSION=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url),'utf8')).version;
const HOME = os.homedir();
export { PROFILE_DIR };
const DEFAULT_RUNTIME = RUNTIME_DIR;
const RUNTIME = process.env.WEBHELM_RUNTIME_DIR || DEFAULT_RUNTIME;
const SOCKET = process.env.WEBHELM_SOCKET || path.join(RUNTIME, 'session-node.sock');
const LOCK = process.env.WEBHELM_LOCK || path.join(RUNTIME, 'session-node.lock');
const sessions = new Map();
const targets = new Map();
const pending = new Map();
let socket, nextId = 1, browserWs, connected = false, reconnecting = false, shuttingDown = false;
let chatgptQueue, managedChrome;
let connectingBrowser=null;
const delay = ms => new Promise(r => setTimeout(r, ms));

class Mutex { constructor(){this.tail=Promise.resolve()} async run(fn){let release;const gate=new Promise(r=>release=r);const prev=this.tail;this.tail=prev.then(()=>gate);await prev;try{return await fn()}finally{release()}} }
class Cdp {
  constructor(url){this.url=url;this.events=new Map();this.closed=false;}
  async connect(){
    if (this.ws && this.ws.readyState===WebSocket.OPEN) return;
    const ws=new WebSocket(this.url); this.ws=ws;
    await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
    this.closed=false;
    ws.addEventListener('message',e=>{let m;try{m=JSON.parse(e.data)}catch{return} if(m.id){const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(new Error(m.error.message||'CDP error')):p.resolve(m.result||{})}}else if(m.method){for(const fn of this.events.get(m.method)||[])fn(m.params||{},m.sessionId)}});
    ws.addEventListener('close',()=>{this.closed=true;connected=false;for(const [id,item] of pending){pending.delete(id);item.reject(Error('CDP WebSocket disconnected'));}});
  }
  on(method,fn){if(!this.events.has(method))this.events.set(method,new Set());this.events.get(method).add(fn);return()=>this.events.get(method)?.delete(fn)}
  async send(method,params={},sessionId){await this.connect();const id=nextId++;return new Promise((resolve,reject)=>{const timeout=method==='Runtime.evaluate'||method==='Page.captureScreenshot'?60000:15000;const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`CDP timeout after ${timeout}ms: ${method}`))},timeout);pending.set(id,{sessionId,resolve:v=>{clearTimeout(timer);resolve(v)},reject:e=>{clearTimeout(timer);reject(e)}});this.ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}))})}
}
// Extension workspace acquisition is not atomic across concurrent RPC calls.
// Serialize only the short lease transaction, not browser Session operations.
const leaseMutexes=new Map();
function leaseMutex(workspace) {
  if(!leaseMutexes.has(workspace))leaseMutexes.set(workspace,new Mutex());
  return leaseMutexes.get(workspace);
}
async function acquireIdentityLease(session) {
  return leaseMutex(session.workspace).run(async()=>{
    await reconcileWorkspaceSessions(session.workspace);
    const lease=await extensionCall(session,'workspace.acquireIdentity',{name:session.workspace});
    const targetId=await targetForUrl(lease.identityUrl);
    if(!targetId){
      await extensionCall(session,'workspace.release',{name:session.workspace,tabId:lease.tabId}).catch(()=>{});
      throw Error('Workspace extension leased a tab without a matching CDP target');
    }
    if(targets.has(targetId)){
      // Do not navigate/release a tab still owned by another Session.
      throw Error('Workspace extension returned a target already owned by another Session');
    }
    lease.idleUrl ||= idleUrlFromIdentity(lease.identityUrl);
    return {lease,targetId};
  });
}

async function connectBrowser() {
  // Never expose a CDP connection before Extension initialization finishes.
  if(connectingBrowser)return connectingBrowser;
  if(browserWs && !browserWs.closed)return browserWs;
  connectingBrowser=(async()=>{
    managedChrome=await ensureManagedChrome();
    const endpoint=managedChrome.endpoint;
    let version;
    try{version=await (await fetch(`${endpoint}/json/version`)).json();}
    catch{throw Error(`Managed Chrome CDP unavailable at ${endpoint}`);}
    const browser=new Cdp(version.webSocketDebuggerUrl);
    await browser.connect();
    browserWs=browser;
    debuggerSession=null;
    browser.on('Target.targetCreated',info=>adoptPopup(info.targetInfo));
    browser.on('Target.targetInfoChanged',info=>adoptPopup(info.targetInfo));
    browser.on('Target.targetDestroyed',({targetId})=>{
      if(debuggerSession?.targetId===targetId)debuggerSession=null;
      targets.delete(targetId);
      for(const s of sessions.values())if(s.targets.has(targetId)){
        const ownerSid=s.attachments.get(targetId);
        for(const [id,item] of pending)if(item.sessionId===ownerSid){
          pending.delete(id);
          item.reject(Error(`CDP target closed: ${targetId}. Verify external side effects before retrying.`));
        }
        s.targets.delete(targetId);
        s.attachments.delete(targetId);
        for(const dispose of s.eventDisposers.get(targetId)||[])dispose();
        s.eventDisposers.delete(targetId);
        if(s.targetId===targetId)s.targetId=s.targets.values().next().value;
      }
    });
    await browser.send('Target.setDiscoverTargets',{discover:true});
    try{await ensureExtensionLoaded(browser,{skip:process.env.WEBHELM_NO_PROFILE_EXTENSION_PROBE==='1',allowUpdate:sessions.size===0});}
    catch(error){browserWs=null;browser.ws?.close();throw error;}
    connected=true;
    if(!reconnecting){
      reconnecting=true;
      try{
        const {targetInfos=[]}=await browser.send('Target.getTargets');
        const available=new Set(targetInfos.filter(t=>t.type==='page').map(t=>t.targetId));
        for(const session of sessions.values())for(const id of [...session.targets]){
          if(available.has(id)){
            try{await attach(session,id,browser);}catch{session.attachments.delete(id);}
          }else {session.targets.delete(id);session.attachments.delete(id);}
        }
      }finally{reconnecting=false;}
    }
    return browser;
  })();
  try{return await connectingBrowser;}
  finally{connectingBrowser=null;}
}

// The daemon owns both the managed Chrome process and the default WebHelm
// group. Chrome auto-updates can terminate the browser while the Node daemon
// survives; an RPC-only health check cannot recover that loss.
const defaultWorkspaceMutex=new Mutex();
async function defaultWorkspaceName() {
  if (process.env.WEBHELM_NO_PROFILE_EXTENSION_PROBE === '1') return 'WebHelm';
  return defaultWorkspaceMutex.run(async()=>{
    const activeLegacySessions=[...sessions.values()].filter(s=>s.workspace==='Harness').length;
    const result=await extensionCall(null,'workspace.migrateDefault',{activeLegacySessions});
    return result.name;
  });
}
async function guardManagedChrome(){
  if(shuttingDown || process.env.WEBHELM_CDP_URL || process.env.WEBHELM_NO_PROFILE_EXTENSION_PROBE==='1')
    return {skipped:true};
  const actual=await ensureManagedChrome();
  if(!browserWs || browserWs.closed || managedChrome?.pid!==actual.pid || managedChrome?.endpoint!==actual.endpoint){
    const old=browserWs;
    browserWs=null;connected=false;debuggerSession=null;
    if(old && !old.closed)old.ws?.close();
    await connectBrowser();
  }
  managedChrome=actual;
  // Session leasing also creates missing workspaces. Serialize this short
  // identity transaction with session start so one group is created, not two.
  const name=await defaultWorkspaceName();
  const state=await leaseMutex(name).run(async()=>{
    let current;
    try {current=await extensionCall(null,'workspace.status',{name});}
    catch(error){
      if(sessions.size)throw error; // Never hot reload an Extension used by active Sessions.
      const browser=await connectBrowser();
      await ensureExtensionLoaded(browser);
      current=await extensionCall(null,'workspace.status',{name});
    }
    if(!current?.initialized || !Number.isInteger(current.physicalTabs) || current.physicalTabs<1)
      current=await extensionCall(null,'workspace.ensure',{name});
    return current;
  });
  return {managed_chrome_pid:actual.pid,group_id:state.groupId,physical_tabs:state.physicalTabs};
}
const managedChromeGuard=createManagedChromeGuard(guardManagedChrome,{
  intervalMs:Number(process.env.WEBHELM_CHROME_GUARD_INTERVAL_MS||15000),
  onError:error=>console.warn(`WebHelm managed Chrome health check: ${error.message}`),
});

function adoptPopup(info){if(info?.type!=='page'||!info.openerId)return;const owner=targets.get(info.openerId);if(owner){owner.targets.add(info.targetId);targets.set(info.targetId,owner)}}
async function attach(s,targetId,b=null){b ||= await connectBrowser();const {sessionId}=await b.send('Target.attachToTarget',{targetId,flatten:true});s.targets.add(targetId);s.attachments.set(targetId,sessionId);targets.set(targetId,s);for(const d of ['Page','DOM','Runtime','Network'])await b.send(`${d}.enable`,{},sessionId);for(const dispose of s.eventDisposers?.get(targetId)||[])dispose();const removers=[];for(const method of ['Page.loadEventFired','Page.domContentEventFired','Page.javascriptDialogOpening','Page.javascriptDialogClosed','Runtime.exceptionThrown','Network.requestWillBeSent','Network.responseReceived'])removers.push(b.on(method,(params,owner)=>{if(owner===sessionId){if(s.events.length>=500)s.events.shift();s.events.push({method,params,session_id:sessionId,target_id:targetId})}}));s.eventDisposers?.set(targetId,removers);return sessionId}
function sidFor(s,targetId=s.targetId){const sid=s.attachments.get(targetId);if(!sid)throw new Error(`target ${targetId} is not attached to this session`);return sid}
async function evaluate(s,expression,targetId=s.targetId,awaitPromise=true){if(!s.targets.has(targetId))throw Error('cannot evaluate a target outside the active WebHelm session');const b=await connectBrowser();const r=await b.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise,userGesture:true},sidFor(s,targetId));if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result?.value}
async function cdp(s,method,params={},targetId=s.targetId){if(method==='Target.createTarget')throw Error('Target.createTarget is disabled; use new_tab(url)');if(method==='Target.attachToTarget'||method==='Target.detachFromTarget')throw Error('direct target attachment changes are disabled in WebHelm sessions');if(['Target.closeTarget','Target.activateTarget'].includes(method)&&!s.targets.has(params.targetId))throw Error('cannot operate on a tab outside the active WebHelm session');if(method.startsWith('Target.')||method.startsWith('Browser.')||method.startsWith('ServiceWorker.'))return connectBrowser().then(b=>b.send(method,params));return connectBrowser().then(b=>b.send(method,params,sidFor(s,targetId)))}
function makeHelpers(s){
 const h={
  js:(expression,target_id)=>evaluate(s,expression,target_id||s.targetId),
  cdp:(method,params={})=>cdp(s,method,params),
  async goto_url(url){await cdp(s,'Page.navigate',{url});await h.wait_for_load();return h.page_info()},
  async current_tab(){const info=await cdp(s,'Target.getTargetInfo',{targetId:s.targetId});return info.targetInfo},
  async new_tab(url='about:blank') {
    const browser=await connectBrowser();
    let targetId,lease;
    if(s.workspaceSupported){
      ({lease,targetId}=await acquireIdentityLease(s));
      s.leasedTabs.set(targetId,lease.tabId);
      s.idleUrls.set(targetId,lease.idleUrl);
    }else ({targetId}=await browser.send('Target.createTarget',{url:'about:blank'}));
    await attach(s,targetId);
    s.targetId=targetId;
    if(url!=='about:blank')await browser.send('Page.navigate',{url},sidFor(s,targetId));
    else if(lease)await browser.send('Page.navigate',{url:'about:blank'},sidFor(s,targetId));
    return targetId;
  },
  async close_tab(target) {
    const tid=typeof target==='string'?target:(target?.targetId||target?.target_id)||s.targetId;
    if(!s.targets.has(tid))throw Error('cannot close a tab outside the active WebHelm Session');
    return leaseMutex(s.workspace).run(async()=>{
      const browser=await connectBrowser();
      if(s.leasedTabs.has(tid))await navigateIdle(browser,s,tid,s.idleUrls.get(tid));
      else await browser.send('Target.closeTarget',{targetId:tid}); // Popup without pool slot.
      const attachment=s.attachments.get(tid);
      if(attachment)await browser.send('Target.detachFromTarget',{sessionId:attachment}).catch(()=>{});
      s.leasedTabs.delete(tid);s.idleUrls.delete(tid);s.targets.delete(tid);s.attachments.delete(tid);
      for(const dispose of s.eventDisposers.get(tid)||[])dispose();
      s.eventDisposers.delete(tid);targets.delete(tid);
      if(s.targetId===tid)s.targetId=s.targets.values().next().value;
      return {closed:true,target_id:tid,returned_to_idle:true};
    });
  },
  async page_info(){return evaluate(s,'({url:location.href,title:document.title,readyState:document.readyState})')},
  async wait_for_load(timeout=15000){const end=Date.now()+timeout;while(Date.now()<end){try{if(await evaluate(s,'document.readyState')==='complete')return true}catch{}await delay(100)}throw Error('page load timed out')},
  async wait_for_element(selector, options={}) {
    const timeout = typeof options === 'number' ? options * 1000 : (options.timeout ?? 10) * 1000;
    const visible = typeof options === 'object' ? !!options.visible : false;
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      try {
        if (await evaluate(s, `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;if(!${visible})return true;const r=e.getBoundingClientRect();return r.width>0&&r.height>0})()`)) return true;
      } catch {}
      await delay(100);
    }
    return false;
  },
  async fill_input(selector,text){if(!await h.wait_for_element(selector))throw Error(`element not found: ${selector}`);return evaluate(s,`(()=>{const e=document.querySelector(${JSON.stringify(selector)});const set=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(e),'value')?.set;if(set)set.call(e,${JSON.stringify(String(text))});else e.textContent=${JSON.stringify(String(text))};e.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:${JSON.stringify(String(text))}}));e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`)},
  async click(selector){if(!await h.wait_for_element(selector))throw Error(`element not found: ${selector}`);return evaluate(s,`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.click();return true})()`)},
  async capture_screenshot(pathname){const b=await connectBrowser();const data=await b.send('Page.captureScreenshot',{format:'png'},sidFor(s));if(pathname)fs.writeFileSync(pathname,Buffer.from(data.data,'base64'));return data.data},
  async snapshot(interactive_only=false){const result=await evaluate(s,`(()=>{let n=0;const xs=[...document.querySelectorAll('button,a,input,textarea,select,[role],[tabindex]')].filter(e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width&&r.height&&s.visibility!=='hidden'&&s.display!=='none'});return xs.map(e=>{const id='e'+(++n);e.setAttribute('data-ref',id);const role=e.getAttribute('role')||({BUTTON:'button',A:'link',INPUT:'textbox',TEXTAREA:'textbox',SELECT:'combobox'}[e.tagName]||e.tagName.toLowerCase());const name=e.getAttribute('aria-label')||e.innerText||e.value||e.placeholder||'';return '- '+role+' '+JSON.stringify(name.trim().slice(0,100))+' [ref='+id+']'}).join('\\n')})()`);return result||''},
  async workspace_status(){return extensionCall(s,'workspace.status',{name:s.workspace})},
  async workspace_capacity(){const r=await h.workspace_status();const idle=Array.isArray(r.idleTabIds)?r.idleTabIds.length:null,leased=Array.isArray(r.leasedTabIds)?r.leasedTabIds.length:null;return {name:r.name,poolSize:r.poolSize??null,maxCapacity:r.maxCapacity??r.poolSize??null,physicalTabs:r.physicalTabs??(idle!==null&&leased!==null?idle+leased:null),idle,leased,available:Number.isInteger(r.maxCapacity??r.poolSize)&&leased!==null?Math.max(0,(r.maxCapacity??r.poolSize)-leased):null}} ,
  async workspace_list(){return extensionCall(s,'workspace.list')},
  async wait(seconds){return delay(seconds*1000)},
  async sleep(milliseconds){return delay(milliseconds)},
  async type_text(text){return cdp(s,'Input.insertText',{text:String(text)})},
  async upload_file(selector, filename){
    if (!fs.existsSync(filename)) throw Error(`upload file does not exist: ${filename}`);
    const root=await cdp(s,'DOM.getDocument',{depth:-1});
    const {nodeId}=await cdp(s,'DOM.querySelector',{nodeId:root.root.nodeId,selector});
    if (!nodeId) throw Error(`upload input not found: ${selector}`);
    await cdp(s,'DOM.setFileInputFiles',{nodeId,files:[path.resolve(filename)]});
    return {uploaded:true};
  },
  async list_tabs(){
    const {targetInfos=[]}=await connectBrowser().then(b=>b.send('Target.getTargets'));
    return targetInfos.filter(t=>t.type==='page'&&s.targets.has(t.targetId));
  },
  async switch_tab(target){
    const tid=typeof target==='string'?target:target?.targetId||target?.target_id;
    if (!s.targets.has(tid)) throw Error('cannot switch to a tab outside the active WebHelm session');
    if (!s.attachments.has(tid)) await attach(s,tid);
    s.targetId=tid;
    return tid;
  },
  async activate_tab(target){
    const tid=typeof target==='string'?target:target?.targetId||target?.target_id||s.targetId;
    if (!s.targets.has(tid)) throw Error('cannot activate a tab outside the active WebHelm session');
    return cdp(s,'Target.activateTarget',{targetId:tid});
  },
  events(){const e=s.events.splice(0);return e},
  async current_url(){return (await h.page_info()).url},
  async title(){return (await h.page_info()).title}
 };
 Object.defineProperty(h,'target_id',{get:()=>s.targetId});
 Object.defineProperty(h,'targetId',{get:()=>s.targetId});
 return h;
}
const EXTENSION_ID='kkkpgmhpoeceojalkpfdidffdfnlgdog';
const EXTENSION_PREFIX=`chrome-extension://${EXTENSION_ID}/`;
let debuggerSession=null;
function extensionConfigured(){
  if(process.env.WEBHELM_NO_PROFILE_EXTENSION_PROBE==='1')return false;
  // A sleeping MV3 worker has no CDP target. Chrome records the installed
  // extension in Secure Preferences even when no extension page is open.
  for(const filename of ['Default/Secure Preferences','Default/Preferences']){
    try{
      const config=JSON.parse(fs.readFileSync(path.join(PROFILE_DIR,filename),'utf8'));
      const extension=config.extensions?.settings?.[EXTENSION_ID];
      if(extension)return extension.state!==0;
    }catch{}
  }
  return false;
}
async function evaluateExtension(browser,sessionId,expression){
  const result=await browser.send('Runtime.evaluate',{
    expression,returnByValue:true,awaitPromise:true},sessionId);
  if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text||'extension evaluation failed');
  const value=result.result?.value;
  if(!value?.ok)throw Error(value?.error?.message||'workspace extension RPC failed');
  return value.result;
}
// Extension service-worker RPC uses one debugger attachment and must not
// race concurrent capacity polls, migration and browser Session allocation.
const extensionRpcMutex=new Mutex();
async function extensionCall(session,method,args={}) {
  return extensionRpcMutex.run(()=>extensionCallSerialized(session,method,args));
}
async function extensionCallSerialized(_session,method,args={}) {
  const browser=await connectBrowser();
  const request=JSON.stringify({method,args});
  const {targetInfos=[]}=await browser.send('Target.getTargets');
  const worker=targetInfos.find(t=>t.type==='service_worker'&&t.url.startsWith(EXTENSION_PREFIX));
  if(worker){
    if(debuggerSession?.targetId!==worker.targetId){
      debuggerSession=null;
      const {sessionId}=await browser.send('Target.attachToTarget',{targetId:worker.targetId,flatten:true});
      debuggerSession={targetId:worker.targetId,sessionId};
    }
    try{return await evaluateExtension(browser,debuggerSession.sessionId,
      `globalThis.browserWorkspaceManagerRpc(${request})`);
    }catch(error){debuggerSession=null;throw error;}
  }
  const page=targetInfos.find(t=>t.type==='page'&&t.url.startsWith(EXTENSION_PREFIX)&&(t.url.includes('/workspace.html')||t.url.includes('/helm.html')));
  if(page){
    const {sessionId}=await browser.send('Target.attachToTarget',{targetId:page.targetId,flatten:true});
    try{return await evaluateExtension(browser,sessionId,`chrome.runtime.sendMessage(${request})`);}
    finally{await browser.send('Target.detachFromTarget',{sessionId}).catch(()=>{});}
  }
  if(!extensionConfigured())throw Error('WebHelm workspace extension is not installed or enabled');
  // Wake a suspended MV3 worker from a temporary background extension page.
  // Only this temporary target is closed; no user tab is reused or modified.
  const {targetId}=await browser.send('Target.createTarget',{
    url:`${EXTENSION_PREFIX}helm.html?webhelm_wakeup=1`,background:true});
  let sessionId;
  try{
    ({sessionId}=await browser.send('Target.attachToTarget',{targetId,flatten:true}));
    let ready=false;
    for(let attempt=0;attempt<20;attempt++){
      try{
        const reply=await browser.send('Runtime.evaluate',{
          expression:`typeof chrome!=='undefined'&&chrome.runtime?.id===${JSON.stringify(EXTENSION_ID)}`,
          returnByValue:true},sessionId);
        if(reply.result?.value===true){ready=true;break;}
      }catch{}
      await delay(100);
    }
    if(!ready)throw Error('WebHelm installed extension did not initialize its background page');
    return await evaluateExtension(browser,sessionId,`chrome.runtime.sendMessage(${request})`);
  }finally{
    if(sessionId)await browser.send('Target.detachFromTarget',{sessionId}).catch(()=>{});
    await browser.send('Target.closeTarget',{targetId}).catch(()=>{});
  }
}

function jsonSafe(value){try{JSON.stringify(value);return {value}}catch{return {value_repr:String(value)}}}
async function createSession(req={}) {
  const browser=await connectBrowser();
  const sid=crypto.randomBytes(8).toString('hex');
  const s={session_id:sid, workspace:req.workspace||await defaultWorkspaceName(), targetId:null,
    rootTargetId:null, workspaceSupported:false,targets:new Set(), attachments:new Map(), eventDisposers:new Map(),
    leasedTabs:new Map(), idleUrls:new Map(), mutex:new Mutex(), events:[], namespace:null,context:null,
    inFlight:0, closing:false, last_used_at:Date.now()};
  let targetId,lease;
  try {
    if(await extensionSupported()) {
      ({lease,targetId}=await acquireIdentityLease(s));
      s.leasedTabs.set(targetId,lease.tabId);
      s.idleUrls.set(targetId,lease.idleUrl);
      s.workspaceSupported=true;
    } else {
      if(process.env.WEBHELM_NO_PROFILE_EXTENSION_PROBE!=='1')throw Error('Managed WebHelm Extension unavailable; refusing unmanaged Tab allocation');
      ({targetId}=await browser.send('Target.createTarget',{url:'about:blank'}));
    }
    s.targetId=targetId;
    s.rootTargetId=targetId;
    await attach(s,targetId);
    if(req.url && req.url!=='about:blank')await browser.send('Page.navigate',{url:req.url},sidFor(s,targetId));
    else if (lease) await browser.send('Page.navigate',{url:'about:blank'},sidFor(s,targetId));
    const h=makeHelpers(s);
    s.namespace={...h,helpers:h,session_id:sid};
    s.context=vm.createContext(s.namespace);
    sessions.set(sid,s);
    return {session_id:sid,workspace:s.workspace,target_id:targetId,
      url:req.url||'about:blank',workspace_supported:!!lease};
  }catch(error){
    if(lease){
      try{await extensionCall(s,'workspace.release',{name:s.workspace,tabId:lease.tabId});}
      catch{if(targetId)await browser.send('Target.closeTarget',{targetId}).catch(()=>{});}
    }else if(targetId)await browser.send('Target.closeTarget',{targetId}).catch(()=>{});
    throw error;
  }
}

async function targetForUrl(url){for(let i=0;i<100;i++){const {targetInfos=[]}=await connectBrowser().then(b=>b.send('Target.getTargets'));const match=targetInfos.find(t=>t.type==='page'&&t.url===url);if(match)return match.targetId;await delay(50)}return null}
async function extensionSupported() {
  const browser=await connectBrowser();
  const {targetInfos=[]}=await browser.send('Target.getTargets');
  const installed=targetInfos.some(t=>t.url?.startsWith(EXTENSION_PREFIX))||extensionConfigured();
  if(!installed)return false;
  let error;
  for(let attempt=0;attempt<3;attempt++){
    try{await extensionCall({workspace:'WebHelm'},'workspace.list');return true;}
    catch(e){error=e;if(attempt<2)await delay(150);}
  }
  throw Error(`WebHelm extension installed but RPC unavailable: ${error?.message||'unknown'}`);
}

async function execute(req) {
  const s=sessions.get(req.session_id);
  if(!s || s.closing)throw Error(`unknown session_id: ${req.session_id} (missing or closing)`);
  s.inFlight++;
  try {return await s.mutex.run(async()=>{
    if(s.closing)throw Error('session closing');
    s.last_used_at=Date.now();
    const logs=[],errors=[];
    const sandbox={...s.namespace};
    sandbox.console={log:(...x)=>logs.push(x.map(v=>typeof v==='string'?v:JSON.stringify(v)).join(' ')),error:(...x)=>errors.push(x.map(v=>typeof v==='string'?v:JSON.stringify(v)).join(' ')),warn:(...x)=>errors.push(x.map(v=>typeof v==='string'?v:JSON.stringify(v)).join(' '))};
    s.context=vm.createContext(sandbox);
    try {
      let source=String(req.code||'').replace(/(^|\n)\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g,'$1globalThis.$2 =');
      const lines=source.trimEnd().split('\n');
      const last=lines.at(-1)?.trim()||'';
      if(last&&!last.endsWith(';')&&!/^(return|throw|if|for|while|function|class|\}|\/\/)/.test(last))lines[lines.length-1]=`return (${last})`;
      source=lines.join('\n');
      const script=new vm.Script(`(async()=>{${source}\n})()`,{filename:'<webhelm-session>'});
      const result=await script.runInContext(s.context,{timeout:30000});
      Object.assign(s.namespace,sandbox);
      const out={session_id:s.session_id,workspace:s.workspace,target_id:s.targetId,ok:true,stdout:logs.join('\n'),stderr:errors.join('\n')};
      if(result!==undefined)Object.assign(out,jsonSafe(result));
      return out;
    }catch(e){return {session_id:s.session_id,workspace:s.workspace,target_id:s.targetId,ok:false,stdout:logs.join('\n'),stderr:errors.join('\n'),error:`${e.name}: ${e.message}`}}
  });} finally {s.inFlight--;s.last_used_at=Date.now();}
}

async function targetUrl(browser,targetId) {
  const reply=await browser.send('Target.getTargetInfo',{targetId});
  return reply.targetInfo?.url||'';
}

async function navigateIdle(browser,s,targetId,idleUrl){
  if(!idleUrl)throw Error('missing idle URL for owned tab');
  if(sameIdleUrl(await targetUrl(browser,targetId),idleUrl))return;
  await browser.send('Page.navigate',{url:idleUrl},sidFor(s,targetId));
  for(let i=0;i<60;i++){
    if(sameIdleUrl(await targetUrl(browser,targetId),idleUrl))return;
    await delay(50);
  }
  throw Error('idle navigation not confirmed; Session retained');
}

// Must be invoked while the workspace's allocation mutex is held.
async function closeSessionOwned(s){
  if(sessions.get(s.session_id)!==s)return {session_id:s.session_id,already_closed:true};
  s.closing=true;
  let release_error=null;
  try {
    const returnedTabs=s.leasedTabs.size;
    const closedChildTabs=s.targets.size - returnedTabs;
    await s.mutex.run(async()=>{
      const browser=await connectBrowser();
      // Return managed tabs to their original Extension pool; keep their CDP targets.
      for(const tid of [...s.targets]){
        if(s.leasedTabs.has(tid)){
          await navigateIdle(browser,s,tid,s.idleUrls.get(tid));
        } else {
          // Unleased child popup targets have no managed pool slot.
          await browser.send('Target.closeTarget',{targetId:tid});
        }
      }
      for(const [,attachment] of s.attachments)await browser.send('Target.detachFromTarget',{sessionId:attachment}).catch(()=>{});
      for(const [tid,disposers] of s.eventDisposers){for(const dispose of disposers)dispose();targets.delete(tid);}
      for(const tid of s.targets)targets.delete(tid);
      s.targets.clear();s.attachments.clear();s.leasedTabs.clear();s.idleUrls.clear();s.eventDisposers.clear();
      sessions.delete(s.session_id);
    });
    return {session_id:s.session_id,workspace:s.workspace,target_id:s.rootTargetId,closed_tabs:closedChildTabs,returned_tabs:returnedTabs,returned_to_idle:true,release_error};
  }catch(error){
    s.closing=false; // Keep ownership for a future retry; never reassign on unconfirmed navigation.
    throw error;
  }
}

async function reconcileWorkspaceSessions(workspace){
  const browser=await connectBrowser();
  for(const s of [...sessions.values()]){
    if(s.workspace!==workspace||s.closing||s.inFlight>0)continue;
    let alreadyIdle=false;
    for(const [tid,idleUrl] of s.idleUrls){
      try {if(sameIdleUrl(await targetUrl(browser,tid),idleUrl)){alreadyIdle=true;break;}}
      catch {alreadyIdle=true;break;} // Lost target means this Session is no longer valid.
    }
    if(!alreadyIdle&&!staleSession(s))continue;
    try {await closeSessionOwned(s);}
    catch(error){console.error(JSON.stringify({component:'session-gc',session_id:s.session_id,error:String(error)}));}
  }
}

async function stopSession(sid){
  const s=sessions.get(sid);
  if(!s)throw Error(`unknown session_id: ${sid}`);
  s.closing=true;
  // Do not hold the workspace allocation lock while an in-flight operation
  // might be acquiring a new tab: that would deadlock its Session mutex.
  await s.mutex.run(async()=>{});
  return leaseMutex(s.workspace).run(()=>closeSessionOwned(s));
}

function heartbeatSession(sid){
  const s=sessions.get(sid);
  if(!s||s.closing)throw Error(`unknown session_id: ${sid} (missing or closing)`);
  s.last_used_at=Date.now();
  return {session_id:sid,alive:true,last_used_at:s.last_used_at};
}

// Applications (Relay, Neo, etc.) provision Workspaces through the daemon IPC,
// never through the agent-facing CLI or its session JavaScript namespace.
async function workspaceOp(req) {
  if (typeof req.name !== 'string' || !req.name.trim()) throw Error('workspace name required');
  if (req.op === 'workspace-create')
    return extensionCall(null,'workspace.create',{name:req.name,poolSize:req.pool_size ?? 8});
  if (req.op === 'workspace-resize')
    return extensionCall(null,'workspace.resize',{name:req.name,poolSize:req.pool_size});
  if (req.op === 'workspace-delete')
    return extensionCall(null,'workspace.delete',{name:req.name,force:Boolean(req.force)});
  throw Error(`unknown workspace operation: ${req.op}`);
}
function getChatGPTQueue() {
  if (chatgptQueue) return chatgptQueue;
  chatgptQueue = new ChatGPTQueue({
    persistenceRoot: RUNTIME,
    startSession: ({url}) => createSession({url}),
    execSession: (session_id, code) => execute({session_id, code}),
    stopSession,
    logger: entry => console.error(JSON.stringify({component:'chatgpt-queue',...entry})),
  });
  // Keep the durable queue intact during a cutover smoke check. A paused
  // daemon accepts queue writes but never starts its dispatcher.
  if(process.env.WEBHELM_CHATGPT_QUEUE_PAUSED!=='1')chatgptQueue.start();
  return chatgptQueue;
}

async function workspaceCapacity(req={}) {
  const name=typeof req.workspace==='string'&&req.workspace.trim()?req.workspace.trim():await defaultWorkspaceName();
  const observedAt=new Date().toISOString();
  try {
    const state=await extensionCall(null,'workspace.status',{name});
    const idle=Array.isArray(state.idleTabIds)?state.idleTabIds.length:
      Number.isInteger(state.idle)?state.idle:null;
    const leased=Array.isArray(state.leasedTabIds)?state.leasedTabIds.length:
      Number.isInteger(state.leased)?state.leased:null;
    const poolSize=Number.isInteger(state.poolSize)?state.poolSize:null;
    const maximum=Number.isInteger(state.maxCapacity)?state.maxCapacity:poolSize;
    const available=maximum!==null&&leased!==null?Math.max(0,maximum-leased):null;
    return {name,poolSize,idle,leased,available,observedAt,reason:null};
  } catch(error) {
    return {name,poolSize:null,idle:null,leased:null,available:null,
      observedAt,reason:`WebHelm capacity unavailable: ${error.message}`};
  }
}

// The popup never runs commands. The daemon is the only actor that consumes
// Extension control requests, over the already-authenticated CDP channel.
let controlPollActive = false;
function visibleSessions() {
  return [...sessions.values()].map(s => ({
    session_id:s.session_id,workspace:s.workspace,last_used_at:s.last_used_at,
  }));
}
async function pollExtensionControl() {
  if (controlPollActive || shuttingDown) return;
  controlPollActive = true;
  try {
    const pendingAction = await extensionCall(null,'workspace.control.poll',{sessions:visibleSessions()});
    if (!pendingAction) return;
    const {id,action,sessionId} = pendingAction;
    // Keep the status panel fresh while a lengthy Session stop waits for
    // browser navigation or an in-flight task.
    const controlHeartbeat=setInterval(()=>{
      extensionCall(null,'workspace.control.heartbeat',{sessions:visibleSessions()})
        .catch(error=>console.warn(`WebHelm control heartbeat: ${error.message}`));
    },3000);
    let response;
    try {
      if (action === 'stop-all') {
        response = await stopAllSessions();
      } else if (action === 'stop-workspace') {
        response = await stopWorkspaceSessions(pendingAction.workspace);
      } else if (action === 'stop') {
        response = {ok:true,stopped:await stopSession(sessionId)};
      } else {
        throw Error('Unknown extension control action');
      }
    } catch(error) {
      response = {ok:false,error:String(error?.message||error)};
    } finally {
      clearInterval(controlHeartbeat);
    }
    await extensionCall(null,'workspace.control.complete',{id,response});
    await extensionCall(null,'workspace.control.poll',{sessions:visibleSessions()});
  } catch(error) {
    console.warn(`WebHelm extension control sync failed: ${error.message}`);
  } finally {
    controlPollActive = false;
  }
}
function stopWorkspaceSessions(workspace) {
  return stopMatchingSessions(sessions, session => session.workspace === workspace, stopSession);
}
function stopAllSessions() {
  return stopMatchingSessions(sessions, () => true, stopSession);
}

/** Emit one canonical machine-readable action receipt as the final stdout line. */
export function actionOutput(logs, value) {
  const entries=Array.isArray(logs)?logs:[];
  const receipt=value===undefined?null:JSON.stringify(value);
  const output=receipt!==null&&entries.at(-1)!==receipt?[...entries,receipt]:entries;
  return output.join('\n').slice(-40000);
}

async function runPlatform(req) {
  const platform=req.platform, action=req.action, config=req.config || {};
  const auto=Boolean(req.auto_session);
  const started=auto ? await createSession({url:req.url,workspace:req.workspace}) : {session_id:req.session_id};
  const sid=started.session_id;
  if (!sid) throw Error('platform run requires a session_id or auto_session');
  const session=sessions.get(sid);
  if (!session) throw Error(`unknown session_id: ${sid}`);
  let result, cleanup;
  session.inFlight++;
  try {
    result=await session.mutex.run(async()=>{
      const logs=[];
      const helpers=makeHelpers(session);
      helpers.enqueueChatGPTTurn=request=>getChatGPTQueue().enqueue(request);
      helpers.chatgptQueue=getChatGPTQueue();
      try {
        const value=await invokePlatformAction(platform,action,{
          helpers, config,
          log:(...items)=>logs.push(items.map(v=>typeof v==='string'?v:JSON.stringify(v)).join(' ')),
        });
        // Keep the legacy stdout JSON receipt for NeoY/Relay callers, while
        // retaining the structured `value` for new integrations. Do not print
        // a duplicate receipt if the Action already logged its JSON result.
        return {ok:true,stdout:actionOutput(logs,value),stderr:'',value};
      } catch(error) {
        return {ok:false,stdout:logs.join('\n').slice(-40000),stderr:'',error:`${error.name}: ${error.message}`};
      }
    });
  } finally {
    session.inFlight--;session.last_used_at=Date.now();
    cleanup=auto ? await stopSession(sid).catch(e=>({release_error:e.message})) : {caller_owned_session:true};
  }
  result.cleanup=cleanup;
  if (platform==='chatgpt' && action==='new-turn' && config.mode==='sync' && result.ok) {
    if (result.value?.status!=='submitted' || result.value?.thread_id!==String(config.thread_id) || !result.value?.verified_by) {
      result={ok:false,error:'synchronous ChatGPT new-turn did not return a verified submission receipt',cleanup};
    } else Object.assign(result,result.value);
  }
  return {platform,action,workspace_supported:started.workspace_supported??null,
    session_mode:auto?'auto_session_no_self_heal':'caller_owned_self_heal_capable',
    self_heal_capable:!auto,result};
}

export async function handle(req){switch(req.op){case'ping':return {ok:true,pid:process.pid,version:PACKAGE_VERSION,queue_paused:process.env.WEBHELM_CHATGPT_QUEUE_PAUSED==='1',session_count:sessions.size,managed_chrome:managedChrome||{profile_dir:PROFILE_DIR, endpoint:process.env.WEBHELM_CDP_URL||'http://127.0.0.1:9222',reused:true},chrome_guard:managedChromeGuard.status()};case'guard-check':{let status=await managedChromeGuard.tick();for(let retry=0;retry<6 && status.status!=='healthy' && !status.skipped;retry++){await delay(800);status=await managedChromeGuard.tick();}if(status.status!=='healthy' && !status.skipped)throw Error(`WebHelm Chrome health degraded: ${status.error||status.status}`);return {ok:true,chrome_guard:status};}case'heartbeat':return heartbeatSession(req.session_id);case'list':return {session_count:sessions.size,sessions:[...sessions.values()].map(s=>({session_id:s.session_id,workspace:s.workspace,target_id:s.targetId,last_used_at:s.last_used_at}))};case'start':return createSession(req);case'exec':return execute(req);case'stop':return stopSession(req.session_id);case'stop-all':return stopAllSessions();case'stop-workspace':{if(typeof req.workspace!=='string'||!req.workspace.trim())throw Error('workspace required');return stopWorkspaceSessions(req.workspace)}case'capacity':return workspaceCapacity(req);case'workspace-create':case'workspace-resize':case'workspace-delete':return workspaceOp(req);case'chatgpt-new-turn-enqueue':return getChatGPTQueue().enqueue(req.config);case'platform-run':return runPlatform(req);default:throw Error(`unknown op: ${req.op}`)}}
function serve(conn) {
  let buffer = '';
  conn.setEncoding('utf8');
  conn.on('data', async (chunk) => {
    buffer += chunk;
    const newline = buffer.indexOf('\n');
    if (newline < 0) return;
    const raw = buffer.slice(0, newline);
    try {
      const reply = await handle(JSON.parse(raw));
      conn.end(JSON.stringify(reply) + '\n');
    } catch (error) {
      conn.end(JSON.stringify({ error: `${error.name}: ${error.message}` }) + '\n');
    }
  });
}

async function main(){fs.mkdirSync(RUNTIME,{recursive:true,mode:0o700});let lockfd;try{lockfd=fs.openSync(LOCK,'wx',0o600);fs.writeFileSync(lockfd,String(process.pid))}catch{throw Error(`Node pilot lock exists: ${LOCK}`)}if(fs.existsSync(SOCKET)){try{const c=net.createConnection(SOCKET);await new Promise((res,rej)=>{c.once('connect',res);c.once('error',rej)});c.destroy();fs.closeSync(lockfd);fs.unlinkSync(LOCK);throw Error(`Node daemon socket already active: ${SOCKET}`)}catch(e){if(e.message.includes('already active'))throw e;fs.unlinkSync(SOCKET)}}socket=net.createServer(serve);await new Promise((res,rej)=>socket.listen(SOCKET,res).once('error',rej));fs.chmodSync(SOCKET,0o600);connectBrowser().catch(()=>{});managedChromeGuard.start();getChatGPTQueue();
  const controlTimer=setInterval(()=>pollExtensionControl(),3000);
  pollExtensionControl().catch(()=>{});
  const cleanup=async()=>{if(shuttingDown)return;shuttingDown=true;clearInterval(controlTimer);managedChromeGuard.stop();if(chatgptQueue)await chatgptQueue.shutdown().catch(()=>{});await handle({op:'stop-all'}).catch(()=>{});socket?.close();try{if(fs.existsSync(SOCKET))fs.unlinkSync(SOCKET)}catch{}try{fs.closeSync(lockfd);fs.unlinkSync(LOCK)}catch{}process.exit(0)};process.on('SIGTERM',cleanup);process.on('SIGINT',cleanup)}
async function request(payload,ensure=true){if(ensure)await ensureDaemon();return new Promise((resolve,reject)=>{const c=net.createConnection(SOCKET);let data='';c.setEncoding('utf8');c.on('connect',()=>c.write(JSON.stringify(payload)+'\n'));c.on('data',x=>{data+=x;if(!data.includes('\n'))return;c.end();try{const r=JSON.parse(data);r.error?reject(Error(r.error)):resolve(r)}catch(e){reject(e)}});c.on('error',reject)})}
export async function ensureDaemon(){try{const p=await request({op:'ping'},false);if(p.ok)return p}catch{}if(!process.env.WEBHELM_CDP_URL)requireMigratedConfig();fs.mkdirSync(RUNTIME,{recursive:true,mode:0o700});if(fs.existsSync(LOCK)){let owner=0;try{owner=Number(fs.readFileSync(LOCK,'utf8').trim())}catch{};let alive=false;if(owner>0)try{process.kill(owner,0);alive=true}catch{};if(alive)throw Error(`daemon owner lock exists but socket is unreachable; refusing duplicate startup (${LOCK})`);fs.unlinkSync(LOCK)}const child=await import('node:child_process');const log=fs.openSync(path.join(RUNTIME,'session-node.log'),'a');child.spawn(process.execPath,[fileURLToPath(import.meta.url),'daemon'],{detached:true,stdio:['ignore',log,log],env:process.env}).unref();for(let i=0;i<100;i++){await delay(100);try{const p=await request({op:'ping'},false);if(p.ok)return p}catch{}}throw Error(`WebHelm Node daemon did not start; see ${path.join(RUNTIME,'session-node.log')}`)}
if(process.argv[2]==='daemon')main().catch(e=>{console.error(e);process.exit(1)});
export {request,SOCKET,RUNTIME};
