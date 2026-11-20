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
  assert.equal(f.q.cancel(a.queue_id).ok,false);
  const again=new PlatformDeliveryQueue(f.options);t.after(()=>again.shutdown());
  assert.equal(again.has(a.queue_id),true);
  assert.equal(again.enqueue({thread_id:'A',message:'first',idempotency_key:'key1',mergeable:false}).queue_id,a.queue_id);
});

test('NOT_READY waits, WAITING tail merges atomically, READY invokes same delivery Action once',async t=>{
  const f=fixture();t.after(f.clean);
  f.ready(false);
  const first=add(f.q,'A','one','k1',true);
  await f.q.process(f.q.claim('worker-1'));
  assert.equal(f.q.list().items[0].state,'WAITING');
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

test('expired SENDING is terminal FAILED and does not retry the action',async t=>{
  const f=fixture();t.after(f.clean);
  const a=add(f.q,'A','one','key1');const b=add(f.q,'A','two','key2');
  const claimed=f.q.claim('old');f.q.transition(a.queue_id,'old','CHECKING','SENDING');
  f.advance(1000);
  assert.equal(f.q.claim('new').id,b.queue_id);
  assert.equal(f.q.rows()[0].state,'FAILED');
  assert.equal(f.q.rows()[0].receipt,'send_interrupted');
  assert.equal(f.calls.length,0);
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

test('failed validation remains WAITING and blocks later actions in the same FIFO group',async t=>{
  const f=fixture();t.after(f.clean);
  const first=add(f.q,'same','first','gate-a');
  const second=add(f.q,'same','second','gate-b');
  f.q.runAction=async request=>({result:{ok:false,error:'offline'}});
  await f.q.process(f.q.claim('worker-1'));
  const row=f.q.rows().find(r=>r.id===first.queue_id);
  assert.equal(row.state,'WAITING');
  assert.equal(row.receipt,'validate_error');
  assert.equal(f.q.claim('worker-2'),null,'successor must not run while validation is unconfirmed');
  assert.equal(f.q.rows().find(r=>r.id===second.queue_id).state,'QUEUED');
});
