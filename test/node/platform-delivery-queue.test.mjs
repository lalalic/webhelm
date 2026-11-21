import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PlatformDeliveryQueue} from '../../runtime/platform-delivery-queue.mjs';

const policy={
  group:c=>c.thread_id,
  title:c=>String(c.message||'').split('\n')[0]||'Message',
  url:c=>`https://example.org/c/${encodeURIComponent(c.thread_id)}`,
  validate:'validate_new_turn_ready',action:'new-turn',concurrency:4,intervalMs:10000,
  success:value=>value?.verified_by==='send-clicked',
  merge:(a,b)=>a.mergeable&&b.mergeable&&!a.file?.length&&!b.file?.length ? {...a,message:a.message+'\n'+b.message} : null,
};
function fixture(definition=policy) {
  const root=mkdtempSync(join(tmpdir(),'webhelm-queue-neutral-'));
  let clock=100, ready=true, starts=0,stops=0;
  const calls=[];
  const options={platform:'chatgpt',queue:'new-turn',definition,persistenceRoot:root,
    now:()=>clock,startSession:async()=>({session_id:'session-'+(++starts)}),
    stopSession:async()=>{stops++;},
    runAction:async request=>{
      calls.push(request);
      return {result:{ok:true,value:request.action===definition.validate?ready:
        {status:'submitted',verified_by:'send-clicked'}}};
    },
  };
  const q=new PlatformDeliveryQueue(options);
  return {q,root,calls,options,advance:time=>clock=time,ready:value=>ready=value,
    counts:()=>({starts,stops}),clean:async()=>{await q.shutdown();rmSync(root,{recursive:true,force:true});}};
}
const add=(q,thread_id,message,idempotency_key,mergeable=false)=>q.enqueue({thread_id,message,idempotency_key,mergeable});

test('queue persistence, idempotency, cancellation and immutable claimed actions',async t=>{
  const f=fixture();t.after(f.clean);
  const a=add(f.q,'A','first','key1');
  assert.equal(add(f.q,'A','first','key1').queue_id,a.queue_id);
  assert.throws(()=>add(f.q,'A','different','key1'),/idempotency key reused/);
  assert.equal(f.q.list().items[0].title,'first');
  assert.equal(f.q.list().items[0].group,'A');
  const b=add(f.q,'B','second','key2');
  assert.equal(f.q.cancel(b.queue_id).state,'CANCELLED');
  assert.equal(f.q.claim('workerA').id,a.queue_id);
  assert.equal(f.q.cancel(a.queue_id).state,'CANCELLED','pre-send validation is cancellable');
  assert.deepEqual(f.q.cancel(a.queue_id),{ok:true,queue_id:a.queue_id,skipped:true});
  assert.deepEqual(f.q.cancel('missing'),{ok:true,queue_id:'missing',skipped:true});
  const again=new PlatformDeliveryQueue(f.options);t.after(()=>again.shutdown());
  assert.equal(again.has(a.queue_id),true);
  assert.equal(again.enqueue({thread_id:'A',message:'first',idempotency_key:'key1',mergeable:false}).queue_id,a.queue_id);
});

test('best-effort cancellation never interrupts an already sending action',async t=>{
  const f=fixture();t.after(f.clean);
  const a=add(f.q,'A','one','key1');
  f.q.claim('owner');
  f.q.transition(a.queue_id,'owner','CHECKING','SENDING',{incrementAttempt:true});
  assert.deepEqual(f.q.cancel(a.queue_id),{ok:true,queue_id:a.queue_id,skipped:true});
  assert.equal(f.q.rows()[0].state,'SENDING');
  assert.equal(f.q.list().items.length,1);
});

test('cancel during validation prevents delivery even if validation later succeeds',async t=>{
  const f=fixture();t.after(f.clean);
  const a=add(f.q,'A','one','key1');
  let releaseValidation,startedValidation;
  const entered=new Promise(resolve=>{startedValidation=resolve;});
  const calls=[];
  f.q.runAction=async request=>{
    calls.push(request.action);
    if(request.action===policy.validate){
      startedValidation();
      return new Promise(resolve=>{releaseValidation=()=>resolve({result:{ok:true,value:true}});});
    }
    return {result:{ok:true,value:{verified_by:'send-clicked'}}};
  };
  const process=f.q.process(f.q.claim('owner'));
  await entered;
  assert.equal(f.q.cancel(a.queue_id).state,'CANCELLED');
  releaseValidation();
  await process;
  assert.deepEqual(calls,['validate_new_turn_ready'],'cancelled validation must never proceed to send');
  assert.equal(f.q.list().items.length,0);
});

test('NOT_READY returns to QUEUED, tail merges atomically, READY sends once',async t=>{
  const f=fixture();t.after(f.clean);
  f.ready(false);
  const first=add(f.q,'A','one','k1',true);
  await f.q.process(f.q.claim('worker-1'));
  assert.equal(f.q.list().items[0].state,'QUEUED');
  assert.deepEqual(f.counts(),{starts:1,stops:1});
  const merged=add(f.q,'A','two','k2',true);
  assert.equal(merged.queue_id,first.queue_id);
  assert.equal(JSON.parse(f.q.rows()[0].payload_json).message,'one\ntwo');
  assert.equal(add(f.q,'A','two','k2',true).queue_id,first.queue_id);
  f.advance(112);
  assert.equal(f.q.claim('worker-2').id,first.queue_id);
  f.ready(true);
  await f.q.process(f.q.rows()[0]);
  assert.equal(f.q.rows()[0].state,'SENT');
  assert.deepEqual(f.calls.map(x=>x.action),['validate_new_turn_ready','validate_new_turn_ready','new-turn']);
  assert.equal(f.calls.at(-1).config.message,'one\ntwo');
  assert.equal(f.calls[1].session_id,f.calls[2].session_id,'readiness and send reuse the same Session');
  assert.deepEqual(f.counts(),{starts:2,stops:2});
});

test('FIFO by group, cooldown, no merging claimed work, independent groups',async t=>{
  const f=fixture();t.after(f.clean);
  const a=add(f.q,'A','one','a');
  const b=add(f.q,'A','two','b');
  const c=add(f.q,'B','three','c');
  assert.equal(f.q.claim('first').id,a.queue_id);
  assert.equal(f.q.claim('second').id,c.queue_id);
  assert.equal(f.q.claim('third'),null);
  await f.q.process(f.q.rows()[0]);
  assert.equal(f.q.claim('third'),null,'SENT cooldown blocks same group');
  f.advance(111);
  assert.equal(f.q.claim('third').id,b.queue_id);
});

test('policy retries once by default after interrupted send, then drops without replay',async t=>{
  const f=fixture();t.after(f.clean);
  const a=add(f.q,'A','one','key1');const b=add(f.q,'A','two','key2');
  f.q.claim('old');f.q.transition(a.queue_id,'old','CHECKING','SENDING',{incrementAttempt:true});
  f.advance(1000);
  assert.equal(f.q.claim('new'),null,'failure retries after interval, preserving FIFO');
  assert.equal(f.q.rows()[0].state,'QUEUED');
  assert.equal(f.q.rows()[0].receipt,'send_interrupted');
  f.advance(1011);
  const retried=f.q.claim('retry');
  assert.equal(retried.id,a.queue_id);
  f.q.transition(a.queue_id,'retry','CHECKING','SENDING',{incrementAttempt:true});
  f.advance(2000);
  assert.equal(f.q.claim('next').id,b.queue_id);
  assert.equal(f.q.rows()[0].state,'FAILED');
  assert.equal(f.q.list().items.length,1,'terminal failed message leaves the active queue');
  assert.equal(f.q.list().items[0].id,b.queue_id);
  assert.equal(add(f.q,'A','one','key1').state,'FAILED','duplicate key is not replayed');
  assert.equal(f.calls.length,0);
});

test('policy retries:0 drops an interrupted send immediately',async t=>{
  const f=fixture({...policy,retries:0});t.after(f.clean);
  const a=add(f.q,'A','one','key1');const b=add(f.q,'A','two','key2');
  f.q.claim('worker');f.q.transition(a.queue_id,'worker','CHECKING','SENDING',{incrementAttempt:true});
  f.advance(1000);
  assert.equal(f.q.claim('next').id,b.queue_id);
  assert.equal(f.q.rows()[0].state,'FAILED');
  assert.equal(f.q.list().items.length,1);
});

test('failed sends retry once on the policy interval then drop after budget',async t=>{
  const f=fixture();t.after(f.clean);
  const a=add(f.q,'A','one','key1');
  f.q.runAction=async request=>({result:request.action===policy.validate
    ?{ok:true,value:true}:{ok:false,error:'send failed'}});
  await f.q.process(f.q.claim('first'));
  assert.equal(f.q.rows()[0].state,'QUEUED');
  assert.equal(f.q.rows()[0].attempts,1);
  assert.equal(f.q.claim('too-early'),null);
  f.advance(111);
  await f.q.process(f.q.claim('second'));
  assert.equal(f.q.rows()[0].state,'FAILED');
  assert.equal(f.q.rows()[0].attempts,2);
  assert.equal(f.q.list().items.length,0);
  assert.equal(f.q.enqueue({thread_id:'A',message:'one',idempotency_key:'key1',mergeable:false}).queue_id,a.queue_id);
});

test('NOT_READY does not spend failure retry budget',async t=>{
  const f=fixture({...policy,retries:0});t.after(f.clean);
  const a=add(f.q,'A','one','key1');f.ready(false);
  await f.q.process(f.q.claim('first'));
  assert.equal(f.q.rows()[0].state,'QUEUED');
  assert.equal(f.q.rows()[0].attempts,0);
  f.advance(112);f.ready(true);
  await f.q.process(f.q.claim('second'));
  assert.equal(f.q.rows()[0].state,'SENT');
});

test('two registered queues can persist independently under one root',async t=>{
  const f=fixture();t.after(f.clean);
  const other=new PlatformDeliveryQueue({...f.options,platform:'z',queue:'new-turn'});
  t.after(()=>other.shutdown());
  const first=add(f.q,'X','alpha','same-key');
  const second=add(other,'X','beta','same-key');
  assert.notEqual(first.queue_id,second.queue_id);
  assert.equal(f.q.rows().length,1);
  assert.equal(other.rows().length,1);
});

test('failed validation stays QUEUED and blocks later actions in the same FIFO group',async t=>{
  const f=fixture();t.after(f.clean);
  const first=add(f.q,'same','first','gate-a');
  const second=add(f.q,'same','second','gate-b');
  f.q.runAction=async request=>({result:{ok:false,error:'offline'}});
  await f.q.process(f.q.claim('worker-1'));
  const row=f.q.rows().find(r=>r.id===first.queue_id);
  assert.equal(row.state,'QUEUED');
  assert.match(row.receipt,/^Error;fingerprint=/);
  assert.equal(f.q.claim('worker-2'),null,'successor must not run while validation is unconfirmed');
  assert.equal(f.q.rows().find(r=>r.id===second.queue_id).state,'QUEUED');
});
