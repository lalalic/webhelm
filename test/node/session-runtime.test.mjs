import test from 'node:test';
import assert from 'node:assert/strict';
import {handle} from '../../runtime/node-daemon.mjs';
process.env.WEBHELM_CDP_URL='http://127.0.0.1:9222';
process.env.WEBHELM_NO_PROFILE_EXTENSION_PROBE='1';

const base='chrome-extension://kkkpgmhpoeceojalkpfdidffdfnlgdog/workspace.html';
const idle=(id)=>`${base}?workspace=Harness&role=idle&slot=${id}`;
const lease=(id)=>`${base}?workspace=Harness&role=lease&slot=${id}`;
class FakeBrowser extends EventTarget {
  static OPEN=1;
  readyState=0;
  static inst;
  constructor(){super();FakeBrowser.inst=this;this.targets=[{targetId:'control',type:'page',url:base},{targetId:'slot1',type:'page',url:idle(1)}];this.attachments=new Map();this.nextAttachment=0;this.nextTab=1;this.operations=[];queueMicrotask(()=>{this.readyState=1;this.dispatchEvent(new Event('open'))});}
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
      if(src.startsWith('chrome.runtime.sendMessage(')){
        const request=JSON.parse(src.slice('chrome.runtime.sendMessage('.length,-1));
        if(request.method==='workspace.acquireIdentity'){
          let tab=this.targets.find(t=>t.type==='page'&&/role=idle/.test(t.url));
          if(!tab){const id=++this.nextTab;tab={targetId:`slot${id}`,type:'page',url:idle(id)};this.targets.push(tab);}
          const id=Number(tab.targetId.replace('slot',''));tab.url=lease(id);
          result={result:{value:{ok:true,result:{workspace:'Harness',tabId:id,identityUrl:lease(id),idleUrl:idle(id)}}}};
        } else result={result:{value:{ok:true,result:{}}}};
      }else if(src.startsWith('({url:location.href'))result={result:{value:{url:target?.url,title:'test',readyState:'complete'}}};
      else result={result:{value:true}};
    }
    queueMicrotask(()=>this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({id:req.id,result})})));
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
  } finally {Date.now=previousNow;globalThis.fetch=previousFetch;globalThis.WebSocket=previousWs;}
});
