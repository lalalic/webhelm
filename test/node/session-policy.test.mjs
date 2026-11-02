import {test} from 'node:test';
import assert from 'node:assert/strict';
import {staleSession,idleUrlFromIdentity,sameIdleUrl,SESSION_IDLE_MS} from '../../runtime/session-lifecycle.mjs';

test('session heartbeat and inflight operations prevent reclaim',()=>{
  const s={last_used_at:100,inFlight:0,closing:false};
  assert.equal(staleSession(s,100+SESSION_IDLE_MS-1),false);
  assert.equal(staleSession(s,100+SESSION_IDLE_MS),true);
  s.inFlight=1;
  assert.equal(staleSession(s,100+SESSION_IDLE_MS*10),false);
  s.inFlight=0;s.last_used_at=100+SESSION_IDLE_MS*10;
  assert.equal(staleSession(s,100+SESSION_IDLE_MS*10),false);
  s.closing=true;
  assert.equal(staleSession(s,100+SESSION_IDLE_MS*20),false);
});
test('idle URL retains workspace and original tab identity',()=>{
  const identity='chrome-extension://abc/workspace.html?workspace=Neo&role=lease&tabId=31';
  const idle=idleUrlFromIdentity(identity);
  assert.equal(idle,'chrome-extension://abc/workspace.html?workspace=Neo&role=idle');
  assert.equal(sameIdleUrl(idle,idle),true);
  assert.equal(sameIdleUrl(identity,idle),false);
  assert.throws(()=>idleUrlFromIdentity('https://example.com'),/invalid/);
  assert.throws(()=>idleUrlFromIdentity('chrome-extension://abc/helm.html?role=lease&tabId=31'),/workspace/);
});

test('new Lease tabId is absent from idle URL',()=>{
  const lease = 'chrome-extension://abc/helm.html?workspace=WebHelm&role=lease&tabId=483';
  const idle = 'chrome-extension://abc/helm.html?workspace=WebHelm&role=idle';
  assert.equal(idleUrlFromIdentity(lease), idle);
  assert.equal(idleUrlFromIdentity(lease.replace('483','999')), idle);
});

test('unrelated Lease query parameters are never carried into idle URLs',()=>{
  const lease='chrome-extension://abc/helm.html?workspace=WebHelm&role=lease&tabId=41&trace=hello';
  assert.equal(idleUrlFromIdentity(lease),'chrome-extension://abc/helm.html?workspace=WebHelm&role=idle');
});
