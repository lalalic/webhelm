import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PlatformQueueRegistry} from '../../runtime/queue-registry.mjs';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function register(root,platform,name='new-turn',suffix='v1') {
  const dir=join(root,'platforms',platform);
  mkdirSync(join(dir,'queues'),{recursive:true});
  mkdirSync(join(dir,'actions'),{recursive:true});
  writeFileSync(join(dir,'manifest.yaml'),`platform: ${platform}\nactions:\n  new-turn: actions/_new_turn.mjs\n  validate_new_turn_ready: actions/_validate_new_turn_ready.mjs\n`);
  writeFileSync(join(dir,'actions/_new_turn.mjs'),'export async function run(){return {status:"submitted"};}');
  writeFileSync(join(dir,'actions/_validate_new_turn_ready.mjs'),'export async function run(){return true;}');
  writeFileSync(join(dir,`queues/${name}.mjs`),policySource(suffix));
}
function policySource(suffix) {
  return `export default {action:'new-turn',validate:'validate_new_turn_ready',group:c=>c.thread_id,title:c=>${JSON.stringify(suffix)}+' '+c.message,url:c=>'https://example.org/c/'+encodeURIComponent(c.thread_id),concurrency:2,intervalMs:1000};\n`;
}
function fixture() {
  const root=mkdtempSync(join(tmpdir(),'webhelm-registry-watch-'));
  const errors=[];
  const registry=new PlatformQueueRegistry({platformsRoot:join(root,'platforms'),persistenceRoot:root,
    paused:true,pollMs:1000,logger:entry=>errors.push(entry),
    startSession:async()=>({session_id:'mock'}),stopSession:async()=>{},runAction:async()=>({result:{ok:true,value:true}})});
  const cleanup=async()=>{await registry.shutdown();rmSync(root,{recursive:true,force:true});};
  return {root,registry,errors,cleanup};
}

test('platform scanner discovers any queues/*.mjs and exposes action title/group/URL',async t=>{
  const f=fixture();t.after(f.cleanup);
  register(f.root,'chatgpt');register(f.root,'z');
  await f.registry.start();
  const first=f.registry.enqueue({platform:'chatgpt',queue:'new-turn',config:{thread_id:'T',message:'hello',idempotency_key:'1'}});
  const second=f.registry.enqueue({platform:'z',queue:'new-turn',config:{thread_id:'T',message:'world',idempotency_key:'1'}});
  assert.notEqual(first.queue_id,second.queue_id);
  const items=f.registry.list().items;
  assert.equal(items.length,2);
  assert.equal(items.find(x=>x.platform==='chatgpt').title,'v1 hello');
  assert.equal(items.find(x=>x.platform==='z').title,'v1 world');
  assert.equal(items[0].group,'T');
  assert.equal(f.registry.cancel(first.queue_id).state,'CANCELLED');
  assert.equal(f.registry.list().items.length,1);
});

test('watcher discovers new folders, hot reloads valid modules, preserves existing on invalid change',async t=>{
  const f=fixture();t.after(f.cleanup);
  mkdirSync(join(f.root,'platforms'),{recursive:true});
  await f.registry.start();
  register(f.root,'chatgpt');
  const deadline=Date.now()+3000;
  while(Date.now()<deadline && !f.registry.records.has('chatgpt/new-turn')) await sleep(50);
  assert.equal(f.registry.records.has('chatgpt/new-turn'),true);
  const id=f.registry.enqueue({platform:'chatgpt',queue:'new-turn',config:{thread_id:'A',message:'subject',idempotency_key:'one'}}).queue_id;
  const file=join(f.root,'platforms/chatgpt/queues/new-turn.mjs');
  writeFileSync(file,policySource('v2'));
  await f.registry.refresh();
  assert.equal(f.registry.list().items.find(i=>i.id===id).title,'v2 subject');
  writeFileSync(file,'export default {action:"new-turn",validate:"bad-action"};');
  await f.registry.refresh();
  assert.equal(f.registry.list().items.find(i=>i.id===id).title,'v2 subject');
  assert.ok(f.errors.some(e=>e.event==='queue_policy_load_failed'));
  unlinkSync(file);
  await f.registry.refresh();
  assert.equal(f.registry.list().items.length,1,'deleting registration does not erase durable rows');
  assert.throws(()=>f.registry.enqueue({platform:'chatgpt',queue:'new-turn',config:{thread_id:'A',message:'new',idempotency_key:'two'}}),/not registered/);
});
