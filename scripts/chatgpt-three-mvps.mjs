#!/usr/bin/env node
// Mandatory real-browser ChatGPT Actions release gate. Makes four deliberate
// external sends (one new-thread, one direct new-turn, two queued new-turns).
// Never executes during npm test; requires explicit opt-in and a signed-in
// owned Chrome Session. Queue messages use a brand-new test thread only.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {existsSync,mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir,homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {request} from '../runtime/node-daemon.mjs';
import {PlatformDeliveryQueue} from '../runtime/platform-delivery-queue.mjs';
import {RUNTIME_DIR} from '../runtime/config-paths.mjs';

if(process.env.WEBHELM_MVP_ALLOW_SEND!=='1') {
  throw Error('REAL ChatGPT send test: export WEBHELM_MVP_ALLOW_SEND=1 to authorize four test messages');
}
const isolatedManual=process.argv.includes('--isolated-manual-queue');
const actionsRoot=resolve(process.env.WEBHELM_PLATFORM_DIR || join(homedir(),'.local/webhelm/platforms'));
const evidenceDir=resolve(process.env.WEBHELM_MVP_EVIDENCE_DIR || join(tmpdir(),'webhelm-chatgpt-mvp-evidence'));
mkdirSync(evidenceDir,{recursive:true});
const tag=`WEBHELM_MVP_${Date.now().toString(36).toUpperCase()}_${randomUUID().slice(0,8).toUpperCase()}`;
const evidenceFile=join(evidenceDir,`${tag}.json`);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const evidence={tag,mode:isolatedManual?'isolated-real-browser-queue':'live-daemon-queue',
  started_at:new Date().toISOString(),checks:[],session_ids:[],mvp1:null,mvp2:null,mvp3:null,pass:false};
const record=(name,data={})=>{
  evidence.checks.push({at:new Date().toISOString(),name,...data});
  writeFileSync(evidenceFile,JSON.stringify(evidence,null,2),{mode:0o600});
  console.log(JSON.stringify({stage:name,...data}));
};
async function ipc(op,args={}) {
  const value=await request({op,...args});
  if(value?.error) throw Error(`${op} failed: ${value.error}`);
  return value;
}
async function sessions() {
  return (await ipc('list')).sessions||[];
}
const existing=new Set((await sessions()).map(x=>x.session_id));
const initial=await ipc('ping');
record('preflight',{daemon_pid:initial.pid,daemon_version:initial.version,
  existing_sessions:[...(await sessions())].map(x=>x.workspace),
  source:'real Chrome, same signed-in profile'});
if(!isolatedManual) {
  const expectedVersion=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version;
  if(initial.version!==expectedVersion)
    throw Error(`native Queue MVP requires active daemon version ${expectedVersion}; running ${initial.version}; no messages sent`);
  const listed=await ipc('queue-list');
  if((listed.items||[]).some(x=>!x.queue || !x.platform)) {
    throw Error('native 3-MVP queue requires new generic daemon; old Queue detected; no messages sent');
  }
}
let sid=null,temporaryQueue=null,storeDir=null;
try {
  const started=await ipc('start',{url:'https://chatgpt.com/',workspace:'WebHelm'});
  sid=started.session_id;
  assert.ok(sid,'failed to create owned real Chrome Session');
  evidence.session_ids.push(sid);
  record('session_started',{session_id:sid});
  async function runDirect(action,config,session_id=sid) {
    const value=await ipc('platform-run',{platform:'chatgpt',action,config,session_id,workspace:'WebHelm'});
    const result=value?.result;
    assert.equal(result?.ok,true,`${action} failed: ${JSON.stringify(result)}`);
    assert.equal(result.value?.status,'submitted',`${action} missing submission receipt`);
    return result.value;
  }
  const one=await runDirect('new-thread',{
    message:`${tag}_MVP1_NEW_THREAD. This is an automated browser Actions acceptance test. Reply ${tag}_MVP1_ACK.`,
  });
  assert.ok(one.thread_id && one.thread_url,'new-thread must return a durable thread ID');
  evidence.thread_id=one.thread_id;evidence.thread_url=one.thread_url;
  evidence.mvp1={status:'PASS',thread_id:one.thread_id,verified_by:one.verified_by};
  record('MVP1_PASS',evidence.mvp1);
  const two=await runDirect('new-turn',{
    thread_id:one.thread_id,
    message:`${tag}_MVP2_DIRECT_TURN. Reply exactly ${tag}_MVP2_ACK.`,
  });
  assert.equal(two.thread_id,one.thread_id,'new-turn redirected to another thread');
  assert.equal(two.verified_by,'send-clicked','new-turn must be confirmed by exactly one Send click');
  evidence.mvp2={status:'PASS',thread_id:two.thread_id,verified_by:two.verified_by};
  record('MVP2_PASS',evidence.mvp2);
  await ipc('stop',{session_id:sid});
  record('direct_session_released',{session_id:sid});
  sid=null;
  // Two distinct messages under one FIFO group; explicitly disable merge.
  const payloads=['A','B'].map(suffix=>({
    thread_id:one.thread_id,
    message:`${tag}_MVP3_QUEUE_${suffix}. Reply exactly ${tag}_MVP3_${suffix}_ACK.`,
    idempotency_key:`${tag}-mvp3-${suffix}`,mergeable:false,
  }));
  let enqueued;
  if(isolatedManual) {
    // This is the actual generic queue implementation (not a mocked worker)
    // delivering through the existing real daemon. Isolated on a disposable
    // SQLite database, never reading/claiming the old ChatGPT queue #281/#282.
    // It is NOT a substitute for the live daemon queue-enqueue RPC cutover.
    storeDir=mkdtempSync(join(tmpdir(),'webhelm-mvp-manual-'));
    const policy=(await import(pathToFileURL(join(actionsRoot,'chatgpt/queues/new-turn.mjs')).href)).default;
    temporaryQueue=new PlatformDeliveryQueue({platform:'chatgpt',queue:'new-turn',definition:policy,
      persistenceRoot:storeDir,
      startSession:async ({url,workspace})=>{
        const session=await ipc('start',{url,workspace});
        if(session.session_id)evidence.session_ids.push(session.session_id);
        return session;
      },
      stopSession:async session_id=>ipc('stop',{session_id}),
      runAction:async ({platform,action,config,session_id})=>ipc('platform-run',{
        platform,action:action==='validate_new_turn_ready' ? 'validate-new-turn-ready' : action,
        config,session_id,workspace:'WebHelm',
      }),
    });
    enqueued=payloads.map(x=>temporaryQueue.enqueue(x));
  } else {
    enqueued=[];
    for(const config of payloads) enqueued.push(await ipc('queue-enqueue',{
      platform:'chatgpt',queue:'new-turn',config,
    }));
  }
  assert.equal(new Set(enqueued.map(x=>x.queue_id)).size,2,'two requests must not merge');
  for(const outcome of enqueued) {
    assert.equal(outcome.group,one.thread_id,'both actions must have same FIFO group');
  }
  record('MVP3_QUEUED',{queue_ids:enqueued.map(x=>x.queue_id),group:one.thread_id});
  const dbPath=isolatedManual?temporaryQueue.dbPath:join(
    process.env.WEBHELM_RUNTIME_DIR||RUNTIME_DIR,'queues/chatgpt/new-turn.sqlite3');
  const deadline=Date.now()+180000;
  const states=new Map();
  const claimed=[];
  while(Date.now()<deadline) {
    if(isolatedManual) {
      const next=temporaryQueue.claim(`mvp-worker-${randomUUID()}`);
      if(next) {
        claimed.push(next.id);
        await temporaryQueue.process(next);
      }
    }
    const db=isolatedManual?temporaryQueue.db:new DatabaseSync(dbPath,{readOnly:true});
    try {
      for(const id of enqueued.map(x=>x.queue_id)) {
        const row=db.prepare('SELECT id,seq,group_key,state,receipt,attempts FROM items WHERE id=?').get(id);
        if(row) states.set(id,row);
      }
    } finally {if(!isolatedManual)db.close();}
    const rows=enqueued.map(x=>states.get(x.queue_id));
    if(rows.some(x=>x?.state==='FAILED'||x?.state==='CANCELLED')) throw Error('MVP3 queue failure: '+JSON.stringify(rows));
    if(rows.every(x=>x?.state==='SENT')) break;
    await sleep(2000);
  }
  const a=states.get(enqueued[0].queue_id),b=states.get(enqueued[1].queue_id);
  assert.ok(a&&b,'missing persisted queue receipts');
  assert.equal(a.group_key,one.thread_id);
  assert.equal(b.group_key,one.thread_id);
  assert.ok(a.seq<b.seq,'FIFO seq order reversed');
  assert.equal(a.state,'SENT','queue item A was not sent');
  assert.equal(b.state,'SENT','queue item B was not sent');
  assert.equal(a.receipt,'send-clicked');
  assert.equal(b.receipt,'send-clicked');
  if(isolatedManual)assert.deepEqual(claimed,enqueued.map(x=>x.queue_id),'queue processing order violated');
  evidence.mvp3={status:'PASS',same_thread:one.thread_id,queue_ids:enqueued.map(x=>x.queue_id),
    states:[a.state,b.state],receipts:[a.receipt,b.receipt],
    ordered_seq:[a.seq,b.seq],isolated_harness:isolatedManual};
  record('MVP3_PASS',evidence.mvp3);
  // Let any returned-to-idle queue Session disappear before claiming cleanup.
  for(let i=0;i<10;i++) {
    const remaining=(await sessions()).filter(x=>!existing.has(x.session_id));
    if(!remaining.length) break;
    await sleep(1000);
  }
  const leftovers=(await sessions()).filter(x=>!existing.has(x.session_id));
  assert.equal(leftovers.length,0,'owned Sessions not cleaned: '+JSON.stringify(leftovers));
  evidence.pass=true;
  record('ALL_3_MVPS_PASS',{thread_url:evidence.thread_url,real_browser:true,
    live_daemon_queue:!isolatedManual});
} catch(error) {
  evidence.error=String(error);
  record('MVP_FAILED',{error:String(error)});
  process.exitCode=1;
} finally {
  if(sid) {
    try {await ipc('stop',{session_id:sid});record('finally_stopped_session',{session_id:sid});}
    catch(error) {record('session_release_error',{error:String(error)});process.exitCode=1;}
  }
  if(temporaryQueue) {
    await temporaryQueue.shutdown();
    // Store only sanitized evidence outside the repository, never prompts.
    if(storeDir)rmSync(storeDir,{recursive:true,force:true});
  }
  record('finish',{pass:evidence.pass,evidence_file:evidenceFile});
}
