import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { submissionScript } from '../../runtime/chatgpt/submission-script.mjs';

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
    if (source.includes('h4[data-conversation-role')) return clicked ? 1 : 0;
    if (source.includes('buttons.find')) return !clicked;
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
  assert.deepEqual({...result}, {verified_by:'user-turn'});
  assert.equal(clicked,true);
});
