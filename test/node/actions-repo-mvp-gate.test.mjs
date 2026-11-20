import {test} from 'node:test';
import assert from 'node:assert/strict';
import {needsChatGPTRealMvp} from '../../runtime/actions-repo.mjs';

test('only ChatGPT delivery sources require the 3 REAL browser MVPs before publishing',()=>{
  for(const path of [
    ' M platforms/chatgpt/actions/_new_turn.mjs',
    'A  platforms/chatgpt/actions/_validate_new_turn_ready.mjs',
    '?? platforms/chatgpt/queues/',
    ' M platforms/chatgpt/runtime/lifecycle-common.mjs',
    ' M platforms/chatgpt/manifest.yaml',
    '?? platforms/chatgpt/',
  ]) assert.equal(needsChatGPTRealMvp(path),true,path);
  for(const path of [
    '', ' M platforms/chatgpt/README.md',
    ' M platforms/NEW_PLATFORM.md',
    ' M platforms/claude/actions/_new_turn.mjs',
    ' M platforms/chatgpt/tests-js/actions.test.mjs',
    ' M README.md',
  ]) assert.equal(needsChatGPTRealMvp(path),false,path);
});
