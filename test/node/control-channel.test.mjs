import test from 'node:test';
import assert from 'node:assert/strict';
import {ControlChannel} from '../../runtime/extension/control-channel.mjs';
import {summarizeWorkspaces} from '../../runtime/extension/workspace-summary.mjs';

const sessions = [
  {session_id:'a123456',workspace:'Harness',last_used_at:100},
  {session_id:'b567890',workspace:'Other',last_used_at:100},
  {session_id:'c345678',workspace:'Other',last_used_at:100},
];
function build() {
  let currentTime = 100000, nextId = 0;
  const storage = {};
  const chrome = {storage:{session:{
    async get(key){return {[key]:structuredClone(storage[key])};},
    async set(record){Object.assign(storage,structuredClone(record));},
  }}};
  const channel = new ControlChannel(chrome,()=>currentTime,()=>`request-${++nextId}`);
  return {channel,advance(ms){currentTime+=ms},storage};
}

test('daemon heartbeat reports only fresh session state',async()=>{
  const {channel,advance} = build();
  assert.equal((await channel.status()).connected,false);
  assert.equal((await channel.status()).sessionCount,null);
  await channel.poll(sessions);
  const status=await channel.status();
  assert.equal(status.connected,true);
  assert.equal(status.sessionCount,3);
  assert.deepEqual(status.sessions,sessions);
  advance(8000);
  assert.equal((await channel.status()).connected,false);
  await assert.rejects(channel.requestStop('stop-all'),/not responding/);
});

test('stop group targets only requested group and is not silently repeated',async()=>{
  const {channel} = build();
  await channel.poll(sessions);
  const command=await channel.requestStop('stop-workspace',undefined,'Other');
  assert.equal(command.id,'request-1');
  const first=await channel.poll(sessions);
  assert.deepEqual(first,{id:'request-1',action:'stop-workspace',workspace:'Other'});
  assert.equal(await channel.poll(sessions),null);
  assert.equal((await channel.status()).request.state,'processing');
  const done=await channel.complete(command.id,{ok:true,stopped_count:2,errors:[]});
  assert.equal(done.ok,true);
  assert.equal(done.stoppedCount,2);
  assert.equal((await channel.status()).request,null);
  assert.equal(await channel.poll([sessions[0]]),null);
});

test('session stop, stop-all, errors, unknown session and expiration',async()=>{
  const {channel,advance} = build();
  await channel.poll(sessions);
  await assert.rejects(channel.requestStop('stop','missing'),/no longer active/);
  await assert.rejects(channel.requestStop('stop-workspace',undefined,'Absent'),/No active sessions/);
  const one=await channel.requestStop('stop','a123456');
  await assert.rejects(channel.requestStop('stop-all'),/already running/);
  assert.deepEqual(await channel.poll(sessions),{id:one.id,action:'stop',sessionId:'a123456'});
  const error=await channel.complete(one.id,{ok:false,error:'Target unavailable'});
  assert.equal(error.error,'Target unavailable');
  const all=await channel.requestStop('stop-all');
  advance(21000);
  assert.equal((await channel.status()).request,null);
  assert.match((await channel.status()).lastResult.error,/expired/);
  assert.equal((await channel.complete(all.id,{ok:true})).ignored,true);
});

test('simultaneous daemon poll and popup command preserve a single command',async()=>{
  const {channel} = build();
  await channel.poll(sessions);
  const [command,polled] = await Promise.all([
    channel.requestStop('stop-workspace',undefined,'Harness'),
    channel.poll(sessions),
  ]);
  assert.equal(command.id,polled.id);
  assert.equal(polled.workspace,'Harness');
});

test('workspace summary aggregates multiple groups without hiding orphan sessions',()=>{
  const groups=[
    {name:'Harness',initialized:true,poolSize:8,idle:2,leased:3},
    {name:'Other',initialized:true,poolSize:5,idle:1,leased:2},
  ];
  const out=summarizeWorkspaces(groups,sessions);
  assert.equal(out.totalAvailable,8); // 5+3, including lazy capacity
  assert.equal(out.totalPhysicalIdle,3);
  assert.equal(out.totalSessions,3);
  assert.equal(out.workspaces[0].sessions.length,1);
  assert.equal(out.workspaces[1].sessions.length,2);
  const partial=summarizeWorkspaces(groups.concat({name:'Missing',initialized:false,reason:'group-missing'}),sessions);
  assert.equal(partial.totalAvailable,null);
  assert.equal(partial.partial,true);
  const orphan=summarizeWorkspaces(groups,[...sessions,{session_id:'o',workspace:'Deleted'}]);
  assert.equal(orphan.totalAvailable,null);
  assert.equal(orphan.workspaces.at(-1).name,'Deleted');
});

test('daemon heartbeat during cleanup retains state and does not consume pending action',async()=>{
  const {channel,advance}=build();
  await channel.poll(sessions);
  const command=await channel.requestStop('stop-workspace',undefined,'Other');
  const pending=await channel.poll(sessions);
  assert.equal(pending.id,command.id);
  advance(4000);
  assert.deepEqual(await channel.heartbeat(sessions),{updated:true});
  assert.equal((await channel.status()).connected,true);
  assert.equal(await channel.poll(sessions),null);
});

test('abandoned processing action reports uncertainty without replay',async()=>{
  const {channel,advance}=build();
  await channel.poll(sessions);
  const command=await channel.requestStop('stop-all');
  await channel.poll(sessions);
  advance(10*60_000+1000);
  const status=await channel.status();
  assert.equal(status.request,null);
  assert.equal(status.lastResult.id,command.id);
  assert.match(status.lastResult.error,/did not confirm completion/);
  assert.equal((await channel.complete(command.id,{ok:true})).ignored,true);
});
