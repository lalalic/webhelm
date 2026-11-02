import test from 'node:test';
import assert from 'node:assert/strict';
import {stopMatchingSessions} from '../../runtime/session-control.mjs';

test('clearing one workspace does not stop any other workspace',async()=>{
  const entries=new Map([
    ['a',{workspace:'Harness'}],
    ['b',{workspace:'Other'}],
    ['c',{workspace:'Other'}],
  ]);
  const stopped=[];
  const result=await stopMatchingSessions(entries, s=>s.workspace==='Other',async id=>{
    stopped.push(id);return {session_id:id};
  });
  assert.deepEqual(stopped,['b','c']);
  assert.equal(result.stopped_count,2);
  assert.equal(result.error_count,0);
  assert.equal(result.ok,true);
});

test('cleanup reports partial failure without losing other stops',async()=>{
  const entries=new Map([['a',{workspace:'Harness'}],['b',{workspace:'Harness'}]]);
  const result=await stopMatchingSessions(entries,()=>true,async id=>{
    if(id==='a')throw Error('Tab navigation failed');
    return {session_id:id};
  });
  assert.equal(result.ok,false);
  assert.equal(result.stopped_count,1);
  assert.equal(result.error_count,1);
  assert.match(result.errors[0].error,/Tab navigation failed/);
});
