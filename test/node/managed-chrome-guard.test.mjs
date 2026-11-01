import test from 'node:test';
import assert from 'node:assert/strict';
import {createManagedChromeGuard} from '../../runtime/managed-chrome-guard.mjs';

test('Chrome guard checks immediately and periodically, recovering after failure',async()=>{
  let count=0,notify=0;
  const g=createManagedChromeGuard(async()=>{
    if(++count===1)throw Error('Chrome updating');
    return {pid:42,group_id:8};
  },{intervalMs:10,onError:()=>notify++});
  g.start();
  await new Promise(r=>setTimeout(r,55));
  assert.ok(count>=2);
  assert.equal(notify,1);
  assert.deepEqual(g.status(),{status:'healthy',pid:42,group_id:8});
  g.stop();
  const ended=count;
  await new Promise(r=>setTimeout(r,30));
  assert.equal(count,ended);
});

test('Chrome guard never overlaps health checks, stops safely',async()=>{
  let release, concurrent=0, max=0, calls=0;
  const g=createManagedChromeGuard(async()=>{
    concurrent++;max=Math.max(max,concurrent);calls++;
    await new Promise(r=>{release=r});
    concurrent--;
    return {pid:123};
  },{intervalMs:10});
  g.start();
  await new Promise(r=>setTimeout(r,40));
  assert.equal(calls,1);
  assert.equal(max,1);
  g.stop();release();
  await new Promise(r=>setTimeout(r,25));
  assert.equal(calls,1);
});
