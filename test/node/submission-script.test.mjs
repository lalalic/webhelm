import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { submissionScript } from '../../runtime/chatgpt/submission-script.mjs';
import { STOP_VISIBLE_JS } from '../../runtime/chatgpt/lifecycle-common.mjs';

test('queue submission verifies target thread without unavailable URL global', async () => {
  for (const [observed, expected] of [
    ['thread-1234', 'pre_send_gate_not_ready'],
    ['wrong-thread', 'thread_redirect_mismatch'],
  ]) {
    const calls = [];
    const script = submissionScript({ thread_id: 'thread-1234', message: 'hi' });
    const result = await vm.runInNewContext(`(async () => { ${script} })()`, {
      js: async code => {
        calls.push(code);
        if (code.includes('location.pathname')) return observed;
        return { state: 'NOT_READY' };
      },
      page_info: async () => ({url: 'https://chatgpt.com/c/' + observed}),
    });
    assert.equal(result.diagnostic, expected);
    assert.ok(calls.some(code => code.includes('location.pathname')));
  }
});

test('submission selects a visible enabled Send behind disabled duplicates', async () => {
  const item = {thread_id:'thread-1234',message:'hi'};
  const mark = 'data-webhelm-queue-send';
  const btn = (disabled) => ({
    disabled,
    attrs: new Map(),
    getClientRects: () => [{}],
    getAttribute(k) { return this.attrs.get(k) ?? null; },
    setAttribute(k,v) {this.attrs.set(k,v);},
    removeAttribute(k) {this.attrs.delete(k);},
  });
  const buttons = [btn(true),btn(false)];
  const document = {querySelectorAll(q) {
    return q.includes(mark) && !q.includes('button[')
      ? buttons.filter(b => b.getAttribute(mark) !== null)
      : buttons;
  }};
  let clicked = false;
  const js = async source => {
    if (source.includes('location.pathname')) return item.thread_id;
    if (source.includes('composer_text')) return {state:'READY',composer_text:item.message};
    if (source.includes('const selector=')) return vm.runInNewContext(source,{document});
    if (source.includes('buttons.find')) return true;
    if (source.includes('stop-button')) return clicked;
    throw new Error('Unknown browser script');
  };
  const result = await vm.runInNewContext(`(async()=>{ ${submissionScript(item)} })()`, {
    js,
    click: async selector => {
      assert.equal(selector, '[data-webhelm-queue-send="1"]');
      assert.equal(buttons[0].getAttribute(mark), null);
      assert.equal(buttons[1].getAttribute(mark), '1');
      clicked=true;
    },
    sleep: async () => {},
  });
  assert.deepEqual({...result}, {verified_by:'stop-button-visible'});
  assert.equal(clicked,true);
});

test('Stop button is the only post-click confirmation, without user turn or Send-disabled fallback', async()=>{
  const item={thread_id:'thread-1234',message:'hi'};
  const script=submissionScript(item);
  assert.ok(!script.includes('user-turn') && !script.includes('send-button-disabled') && !script.includes('h4[data-conversation-role'));
  let clicked=false, stopChecks=0;
  const result=await vm.runInNewContext('(async()=>{ '+script+' })()',{
    js:async source=>{
      if(source.includes('location.pathname'))return item.thread_id;
      if(source.includes('composer_text'))return {state:'READY',composer_text:item.message};
      if(source.includes('const selector='))return '#send';
      if(source.includes('buttons.find'))return true;
      if(source.includes('stop-button')){stopChecks++;return false;}
      throw Error('Unexpected verification source');
    },
    click:async()=>{clicked=true;},sleep:async()=>{},
  });
  assert.equal(clicked,true);
  assert.equal(stopChecks,60);
  assert.equal(result.diagnostic,'post_submit_stop_not_observed_no_resend');
});

test('post-click Stop visibility requires a visible generating control',()=>{
  const button=(attrs={},shown=true)=>({
    attrs,shown,
    getClientRects(){return this.shown?[{}]:[];},
    getAttribute(k){return this.attrs[k]||null;},
  });
  let buttons=[];
  const run=()=>vm.runInNewContext(STOP_VISIBLE_JS,{
    document:{querySelectorAll:()=>buttons},
    getComputedStyle:()=>({visibility:'visible'}),
  });
  buttons=[button({'data-testid':'stop-button'},false)];
  assert.equal(run(),false,'hidden Stop is not confirmation');
  buttons=[button({'data-testid':'stop-button'},true)];
  assert.equal(run(),true);
  buttons=[button({'aria-label':'Stop generating'},true)];
  assert.equal(run(),true);
  buttons=[button({'aria-label':'Send'},true)];
  assert.equal(run(),false,'Send button alone is not confirmation');
});
