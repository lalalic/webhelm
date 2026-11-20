import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { submissionScript } from '../../runtime/chatgpt/submission-script.mjs';
import { SEND_ENABLED_JS } from '../../runtime/chatgpt/lifecycle-common.mjs';

async function run(item, {thread=item.thread_id, enabled=true, click=async()=>{}}={}) {
  const probes=[];
  const result=await vm.runInNewContext('(async()=>{ '+submissionScript(item)+' })()',{
    js:async source=>{
      probes.push(source);
      if(source.includes('location.pathname'))return thread;
      if(source===SEND_ENABLED_JS)return enabled;
      if(source.includes('const selector='))return '[data-webhelm-queue-send="1"]';
      throw Error('Unexpected content or post-send probe');
    },
    click,
  });
  return {result,probes};
}

test('queue rejects wrong thread before clicking, even if Send is enabled',async()=>{
  let clicks=0;
  const item={thread_id:'thread-1234',message:'irrelevant'};
  const {result}=await run(item,{thread:'other-thread',click:async()=>{clicks++}});
  assert.equal(result.diagnostic,'thread_redirect_mismatch');
  assert.equal(clicks,0);
});

test('queue requires enabled Send; no click when disabled',async()=>{
  let clicks=0;
  const {result}=await run({thread_id:'thread-1234',message:'irrelevant'},{
    enabled:false,click:async()=>{clicks++},
  });
  assert.equal(result.diagnostic,'pre_send_gate_not_ready');
  assert.equal(clicks,0);
});

test('successful single Send click is SENT without reading content or Stop status',async()=>{
  let clicks=0;
  const item={thread_id:'thread-1234',message:'expected but not compared'};
  const {result,probes}=await run(item,{click:async selector=>{
    assert.equal(selector,'[data-webhelm-queue-send="1"]');
    clicks++;
  }});
  assert.equal(result.verified_by,'send-clicked');
  assert.equal(clicks,1);
  assert.equal(probes.length,3);
  assert.ok(!submissionScript(item).includes('composer_text'));
  assert.ok(!submissionScript(item).includes(item.message));
  assert.ok(!submissionScript(item).includes('stop-button'));
});

test('a failed Send click is not classified as success',async()=>{
  await assert.rejects(
    ()=>run({thread_id:'thread-1234',message:'x'},{click:async()=>{throw Error('click rejected')}}),
    /click rejected/,
  );
});

test('submission selector skips disabled duplicates',async()=>{
  const mark='data-webhelm-queue-send';
  const button=disabled=>({
    disabled,attrs:new Map(),getClientRects:()=>[{}],
    getAttribute(k){return this.attrs.get(k)??null},
    setAttribute(k,v){this.attrs.set(k,v)},
    removeAttribute(k){this.attrs.delete(k)},
  });
  const buttons=[button(true),button(false)];
  const document={querySelectorAll(q){
    return q.includes(mark)&&!q.includes('button[')
      ? buttons.filter(b=>b.getAttribute(mark)!==null):buttons;
  }};
  const script=submissionScript({thread_id:'t',message:'private content'});
  let clicks=0;
  const result=await vm.runInNewContext('(async()=>{ '+script+' })()',{
    js:async source=>{
      if(source.includes('location.pathname'))return 't';
      if(source===SEND_ENABLED_JS)return true;
      if(source.includes('const selector='))return vm.runInNewContext(source,{document});
      throw Error('Unexpected content probe');
    },
    click:async selector=>{
      assert.equal(selector,'[data-webhelm-queue-send="1"]');
      assert.equal(buttons[0].getAttribute(mark),null);
      assert.equal(buttons[1].getAttribute(mark),'1');
      clicks++;
    },
  });
  assert.equal(result.verified_by,'send-clicked');
  assert.equal(clicks,1);
});
