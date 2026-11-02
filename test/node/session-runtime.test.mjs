import test from 'node:test';
import assert from 'node:assert/strict';
import {handle} from '../../runtime/node-daemon.mjs';
process.env.WEBHELM_CDP_URL='http://127.0.0.1:9222';
process.env.WEBHELM_NO_PROFILE_EXTENSION_PROBE='1';

const base='chrome-extension://kkkpgmhpoeceojalkpfdidffdfnlgdog/workspace.html';
const idle=()=>`${base}?workspace=Harness&role=idle`;
const lease=(id)=>`${base}?workspace=Harness&role=lease&tabId=${id}`;
class FakeBrowser extends EventTarget {
  static OPEN=1;
  readyState=0;
  static inst;
  constructor(){super();FakeBrowser.inst=this;this.targets=[{targetId:'worker',type:'service_worker',url:'chrome-extension://kkkpgmhpoeceojalkpfdidffdfnlgdog/service-worker.mjs'},{targetId:'control',type:'page',url:base},{targetId:'slot1',type:'page',url:idle(1)}];this.attachments=new Map();this.nextAttachment=0;this.nextTab=1;this.operations=[];queueMicrotask(()=>{this.readyState=1;this.dispatchEvent(new Event('open'))});}
  send(data){
    const req=JSON.parse(data),{method,params={},sessionId}=req;
    let result={};
    const target=this.targets.find(t=>t.targetId===this.attachments.get(sessionId));
    if(method==='Target.getTargets')result={targetInfos:[...this.targets]};
    if(method==='Target.getTargetInfo')result={targetInfo:this.targets.find(t=>t.targetId===params.targetId)};
    if(method==='Target.attachToTarget'){
      const id=`att${++this.nextAttachment}`;this.attachments.set(id,params.targetId);result={sessionId:id};
    }
    if(method==='Target.detachFromTarget')this.attachments.delete(params.sessionId);
    if(method==='Page.navigate'){
      if(this.failIdle && params.url.includes('role=idle'))result={errorText:'failure'};
      else {this.operations.push({method,url:params.url,target:target?.targetId});if(target)target.url=params.url;}
    }
    if(method==='Target.closeTarget'){
      this.operations.push({method,target:params.targetId});this.targets=this.targets.filter(t=>t.targetId!==params.targetId);
    }
    if(method==='Runtime.evaluate'){
      const src=params.expression;
      if(src.startsWith('chrome.runtime.sendMessage(')||src.startsWith('globalThis.browserWorkspaceManagerRpc(')){
        const prefix=src.startsWith('globalThis')?'globalThis.browserWorkspaceManagerRpc(':'chrome.runtime.sendMessage(';
        const request=JSON.parse(src.slice(prefix.length,-1));
        if(request.method==='workspace.acquireIdentity'){
          let tab=this.targets.find(t=>t.type==='page'&&/role=idle/.test(t.url));
          if(!tab){const id=++this.nextTab;tab={targetId:`slot${id}`,type:'page',url:idle(id)};this.targets.push(tab);}
          const id=Number(tab.targetId.replace('slot',''));tab.url=lease(id);
          result={result:{value:{ok:true,result:{workspace:'Harness',tabId:id,identityUrl:lease(id),idleUrl:idle(id)}}}};
        } else result={result:{value:{ok:true,result:{}}}};
      }else if(src.startsWith('({url:location.href'))result={result:{value:{url:target?.url,title:'test',readyState:'complete'}}};
      else result={result:{value:true}};
    }
    const respond=()=>this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({id:req.id,result})}));
    if((method==='Runtime.evaluate' && ((params.expression?.includes('data-ref') && this.delaySnapshot) || (params.expression?.includes('workspace.acquireIdentity') && this.delayAcquire)))
       || (method==='Page.navigate' && params.url?.includes('role=idle') && this.delayIdleNavigate)){setTimeout(respond,250)}
    else queueMicrotask(respond);
  }
}

test('session lifecycle: managed stop reuses physical tab; orphan reclaimed; heartbeat/inflight protect active sessions',async()=>{
  const previousFetch=globalThis.fetch, previousWs=globalThis.WebSocket, previousNow=Date.now;
  let logicalNow=previousNow();
  globalThis.fetch=async()=>({json:async()=>({webSocketDebuggerUrl:'ws://fake'})});
  globalThis.WebSocket=FakeBrowser;
  Date.now=()=>logicalNow;
  try {
    const a=await handle({op:'start',url:'https://test.invalid/a'});
    const browser=FakeBrowser.inst;
    assert.equal(a.target_id,'slot1');
    const stopA=await handle({op:'stop',session_id:a.session_id});
    assert.equal(stopA.returned_to_idle,true);
    assert.equal(browser.targets.find(t=>t.targetId==='slot1')?.url,idle(1));
    assert.equal(browser.operations.some(o=>o.method==='Target.closeTarget'&&o.target==='slot1'),false);
    const b=await handle({op:'start',url:'https://test.invalid/b'});
    assert.equal(b.target_id,a.target_id,'reuses physical Chrome tab');
    logicalNow+=5*60*1000+1;
    const c=await handle({op:'start',url:'https://test.invalid/c'});
    assert.equal(c.target_id,b.target_id,'start reclaimed stale Session and reused its Tab');
    await assert.rejects(handle({op:'exec',session_id:b.session_id,code:'true'}),/unknown session_id/);
    logicalNow+=4*60*1000;
    const heartbeat=await handle({op:'heartbeat',session_id:c.session_id});
    assert.equal(heartbeat.alive,true);
    logicalNow+=2*60*1000;
    const d=await handle({op:'start',url:'https://test.invalid/d'});
    assert.notEqual(d.target_id,c.target_id,'heartbeat prevents reclaim');
    const exec=handle({op:'exec',session_id:d.session_id,code:'await sleep(60);\ntrue'});
    logicalNow+=6*60*1000;
    const e=await handle({op:'start',url:'https://test.invalid/e'});
    assert.notEqual(e.target_id,d.target_id,'an in-flight operation must not be reclaimed');
    assert.equal((await exec).ok,true);
    await handle({op:'stop',session_id:e.session_id});
    await handle({op:'stop',session_id:d.session_id});
    const f=await handle({op:'start',url:'https://test.invalid/f'});
    browser.failIdle=true;
    await assert.rejects(handle({op:'stop',session_id:f.session_id}),/idle navigation not confirmed/);
    assert.equal((await handle({op:'list'})).sessions.some(s=>s.session_id===f.session_id),true,'failed release retains ownership');
    browser.failIdle=false;
    await handle({op:'stop',session_id:f.session_id});
    const g=await handle({op:'start',url:'https://test.invalid/g'});
    const work=handle({op:'exec',session_id:g.session_id,code:'await new_tab("https://test.invalid/child");\ntrue'});
    const close=handle({op:'stop',session_id:g.session_id});
    const resolved=await Promise.race([Promise.allSettled([work,close]),new Promise((_,reject)=>setTimeout(()=>reject(Error('deadlock')),3500))]);
    assert.equal(resolved[1].status,'fulfilled');
    assert.equal(resolved[1].value.returned_to_idle,true);

    process.env.WEBHELM_SESSION_EXEC_TIMEOUT_MS='75';
    const hung=await handle({op:'start',url:'https://test.invalid/hung'});
    const failed=await handle({op:'exec',session_id:hung.session_id,code:'await new Promise(()=>{})'});
    assert.equal(failed.ok,false);
    assert.match(failed.error,/SessionDeadlineError: Session exec exceeded/);
    assert.equal((await handle({op:'stop',session_id:hung.session_id})).returned_to_idle,true);

    const orphan=await handle({op:'start',url:'https://test.invalid/orphan'});
    browser.delaySnapshot=true;
    const snap=await handle({op:'exec',session_id:orphan.session_id,code:'await snapshot()'});
    assert.equal(snap.ok,false,'A delayed snapshot must return timeout');
    process.env.WEBHELM_SESSION_STOP_TIMEOUT_MS='60';
    await assert.rejects(handle({op:'stop',session_id:orphan.session_id}),
      /Session stop effects exceeded/,'stop must fail without releasing an in-flight CDP effect');
    delete process.env.WEBHELM_SESSION_STOP_TIMEOUT_MS;
    browser.delaySnapshot=false;
    const replacement=await handle({op:'start',url:'https://test.invalid/replacement'});
    assert.notEqual(replacement.target_id,orphan.target_id,
      'Do not reassign a Tab while its expired Session has a CDP operation in flight');
    assert.equal((await handle({op:'list'})).sessions.some(x=>x.session_id===orphan.session_id),true);
    await new Promise(resolve=>setTimeout(resolve,280));
    const afterSnapshot=await handle({op:'start',url:'https://test.invalid/after-snapshot'});
    assert.equal((await handle({op:'list'})).sessions.some(x=>x.session_id===orphan.session_id),false,
      'Reclaim poisoned Session on next allocation after pending effects settle');
    await handle({op:'stop',session_id:replacement.session_id});
    await handle({op:'stop',session_id:afterSnapshot.session_id});

    // Timeout must revoke helpers retained by the still-running async script.
    const late=await handle({op:'start',url:'https://test.invalid/late'});
    const expired=await handle({op:'exec',session_id:late.session_id,
      code:'await sleep(250); await goto_url("https://test.invalid/unsafe-late-operation");'});
    assert.equal(expired.ok,false);
    const next=await handle({op:'start',url:'https://test.invalid/safe-next'});
    await new Promise(resolve=>setTimeout(resolve,300));
    assert.equal(browser.operations.some(x=>x.url==='https://test.invalid/unsafe-late-operation'),false,
      'Late callback must not navigate after Session expired');
    await handle({op:'stop',session_id:next.session_id});

    // Explicit stop can time out while a legitimate exec still holds its
    // mutex. It must clear closing, poison the lease and allow next-Tab GC.
    process.env.WEBHELM_SESSION_EXEC_TIMEOUT_MS='250';
    process.env.WEBHELM_SESSION_STOP_TIMEOUT_MS='60';
    const blocked=await handle({op:'start',url:'https://test.invalid/blocked'});
    const execution=handle({op:'exec',session_id:blocked.session_id,code:'await new Promise(()=>{})'});
    await new Promise(resolve=>setTimeout(resolve,35));
    await assert.rejects(handle({op:'stop',session_id:blocked.session_id}),/Session stop drain exceeded/);
    assert.equal((await execution).ok,false);
    const recycled=await handle({op:'start',url:'https://test.invalid/recycled'});
    assert.equal(recycled.target_id,blocked.target_id,'Timed-out stop must not block next allocation');
    await handle({op:'stop',session_id:recycled.session_id});

    // A second exec queued behind a timed-out first exec cannot run even
    // though it passed the initial state check before obtaining the mutex.
    process.env.WEBHELM_SESSION_EXEC_TIMEOUT_MS='100';
    const queued=await handle({op:'start',url:'https://test.invalid/queued'});
    const first=handle({op:'exec',session_id:queued.session_id,code:'await sleep(250)'});
    await new Promise(resolve=>setTimeout(resolve,15));
    const second=handle({op:'exec',session_id:queued.session_id,
      code:'await goto_url("https://test.invalid/queued-must-not-run")'});
    assert.equal((await first).ok,false);
    await assert.rejects(second,/session closing or expired/);
    assert.equal(browser.operations.some(x=>x.url==='https://test.invalid/queued-must-not-run'),false);
    await assert.rejects(handle({op:'heartbeat',session_id:queued.session_id}),/expired/);
    await handle({op:'stop',session_id:queued.session_id});

    // Force a release wait under a different allocation's workspace lock.
    // Its timed-out stop must not execute late when that mutex becomes free.
    process.env.WEBHELM_SESSION_STOP_TIMEOUT_MS='60';
    const victim=await handle({op:'start',url:'https://test.invalid/victim'});
    browser.delayAcquire=true;
    const holdLock=handle({op:'start',url:'https://test.invalid/holding-lock'});
    await new Promise(resolve=>setTimeout(resolve,30));
    await assert.rejects(handle({op:'stop',session_id:victim.session_id}),/Session stop release exceeded/);
    const holder=await holdLock;
    browser.delayAcquire=false;
    await new Promise(resolve=>setTimeout(resolve,30));
    assert.equal((await handle({op:'list'})).sessions.some(x=>x.session_id===victim.session_id),true,
      'Timed-out queued release must not execute after its caller returned an error');
    const recovered=await handle({op:'start',url:'https://test.invalid/recovered'});
    assert.equal((await handle({op:'list'})).sessions.some(x=>x.session_id===victim.session_id),false,
      'Next allocation safely reclaims the poisoned victim');
    await handle({op:'stop',session_id:holder.session_id});
    await handle({op:'stop',session_id:recovered.session_id});

    // Physical release may outlive the stop caller's deadline. While it is
    // running, retain closing=true to avoid racing a new Tab allocation.
    const slowRelease=await handle({op:'start',url:'https://test.invalid/slow-release'});
    browser.delayIdleNavigate=true;
    await assert.rejects(handle({op:'stop',session_id:slowRelease.session_id}),
      /Session stop release exceeded/);
    await assert.rejects(handle({op:'heartbeat',session_id:slowRelease.session_id}),/closing/);
    browser.delayIdleNavigate=false;
    await new Promise(resolve=>setTimeout(resolve,320));
    assert.equal((await handle({op:'list'})).sessions.some(x=>x.session_id===slowRelease.session_id),false,
      'Timed-out caller must not race the in-progress physical tab release');
  } finally {delete process.env.WEBHELM_SESSION_STOP_TIMEOUT_MS;delete process.env.WEBHELM_SESSION_EXEC_TIMEOUT_MS;Date.now=previousNow;globalThis.fetch=previousFetch;globalThis.WebSocket=previousWs;}
});
