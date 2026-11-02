import {spawn} from 'node:child_process';
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
  WEBHELM_CHATGPT_QUEUE_PAUSED:'1'};
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
  await waitFor(()=>rpc(workerSid,'workspace.ensure',{name:'Harness',poolSize:4}),'legacy Harness created');
  console.log('Legacy Harness group created');
  await cdp('Target.detachFromTarget',{sessionId:workerSid});

  fs.mkdirSync(env.WEBHELM_RUNTIME_DIR,{recursive:true});
  daemon=spawn(process.execPath,[path.join(repo,'runtime/node-daemon.mjs'),'daemon'],{
    env,stdio:['ignore',daemonLog,daemonLog]
  });
  await waitFor(async()=>fs.existsSync(env.WEBHELM_SOCKET) && (await request({op:'ping'})).ok, 'daemon');
  const first=await Promise.race([request({op:'start'}),sleep(15000).then(()=>{throw Error('Isolated daemon Session did not start');})]);
  assert.equal(first.workspace,'WebHelm');
  workerSid=await attach(worker.targetId);
  let groups=await rpc(workerSid,'workspace.list');
  assert.ok(groups.workspaces.some(w=>w.name==='WebHelm'));
  assert.ok(!groups.workspaces.some(w=>w.name==='Harness'));
  const preservedTargetId=first.target_id;
  const stopped=await request({op:'stop',session_id:first.session_id});
  assert.equal(stopped.returned_to_idle,true);
  assert.equal(stopped.returned_tabs,1);
  assert.equal(stopped.closed_tabs,0);
  const info=(await cdp('Target.getTargetInfo',{targetId:preservedTargetId})).targetInfo;
  assert.equal(info.targetId,preservedTargetId);
  assert.match(info.url,/\/helm\.html\?workspace=WebHelm&role=idle/);
  console.log('SESSION CLOSE PASS: original CDP tab retained at helm.html idle:',preservedTargetId);

  const main=await request({op:'start'});
  const custom=await request({op:'start',workspace:'Custom'});
  assert.equal(main.workspace,'WebHelm');
  assert.equal(custom.workspace,'Custom');
  const popupTarget=(await cdp('Target.createTarget',{url:`chrome-extension://${EXTENSION_ID}/popup.html`})).targetId;
  const popupSid=await attach(popupTarget);
  const displayed=await waitFor(async()=>{
    const v=await evaluate(popupSid,`({text:document.body.innerText,sessions:document.querySelector('#sessions').textContent,available:document.querySelector('#available').textContent})`);
    return v?.text.includes('Custom') && v.text.includes('WebHelm') && v.sessions==='2'?v:null;
  },'two-group popup');
  console.log('TWO WORKSPACE UI',JSON.stringify({sessions:displayed.sessions,available:displayed.available}));
  await evaluate(popupSid,`[...document.querySelectorAll('.workspace-title button')].find(button=>button.parentElement.innerText.includes('Custom')).click()`);
  const chosen=await evaluate(popupSid,`document.querySelector('#confirm-text').textContent`);
  assert.match(chosen,/Custom/);
  await evaluate(popupSid,`document.querySelector('#confirm').click()`);
  const after=await waitFor(async()=>(await request({op:'list'})).sessions, 'group stop').then(async()=>
    waitFor(async()=>{const r=await request({op:'list'});return r.sessions.length===1?r:null;},'Custom stop'));
  assert.equal(after.sessions[0].session_id,main.session_id);
  const stillMain=(await cdp('Target.getTargetInfo',{targetId:main.target_id})).targetInfo;
  assert.equal(stillMain.targetId,main.target_id);
  const customIdle=(await cdp('Target.getTargetInfo',{targetId:custom.target_id})).targetInfo;
  assert.match(customIdle.url,/\/helm\.html\?workspace=Custom&role=idle/);
  console.log('GROUP CLEAN PASS: Custom session stopped; WebHelm session preserved');

  const status=await waitFor(async()=>{
    const v=await evaluate(popupSid,`document.querySelector('#message').textContent`);
    return v.includes('stopped 1')?v:null;
  },'UI status');
  console.log('POPUP RESULT:',status);
  const stopMain=await request({op:'stop',session_id:main.session_id});
  assert.equal(stopMain.returned_to_idle,true);
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
