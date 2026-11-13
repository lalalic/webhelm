import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveSiteHeartbeat,createSiteKeepaliveScheduler} from '../../runtime/site-keepalive.mjs';
import {siteOrigin,listKeptSites,setKeptSite,reportKeptSite,sitesWithStatus} from '../../runtime/extension/site-registry.mjs';
import {ControlChannel} from '../../runtime/extension/control-channel.mjs';
import {createControlRpc} from '../../runtime/extension/control-rpc.mjs';
import {summarizeWorkspaces} from '../../runtime/extension/workspace-summary.mjs';

function mockChrome() {
  const local={},session={},calls=[];
  const store = obj => ({async get(key){return {[key]:structuredClone(obj[key])};},
    async set(value){Object.assign(obj,structuredClone(value));}});
  const chrome={storage:{local:store(local),session:store(session)},
    tabs:{async get(id){if(id!==11)throw Error('bad tab');return {id,windowId:1,url:'https://creator.xiaohongshu.com/publish?private=secret',title:'Creator'};},
      async query(){return [];},async create(options){calls.push(['create',options]);return {id:41};}},
    windows:{async update(){}}};
  return {chrome,local,session,calls};
}

const site={id:'https://creator.xiaohongshu.com',url:'https://creator.xiaohongshu.com',enabled:true};
const manifests={xhs:{url_patterns:['https://creator.xiaohongshu.com/*'],actions:{heartbeat:'actions/_heartbeat.mjs'},
  keep_alive:{action:'heartbeat',interval_minutes:30,url:'https://creator.xiaohongshu.com/'}}};
const resolve = entry=>resolveSiteHeartbeat(entry,()=>['xhs'],p=>manifests[p],()=>'/mock/action');

test('kept website registers origin only, never query tokens or lease state',async()=>{
  const {chrome,local}=mockChrome();
  assert.equal(siteOrigin('https://creator.xiaohongshu.com/a?token=secret'),site.id);
  assert.throws(()=>siteOrigin('javascript:alert(1)'),/HTTPS/);
  assert.throws(()=>siteOrigin('https://username:password@example.com/'),/HTTPS/);
  await setKeptSite(chrome,'https://creator.xiaohongshu.com/publish?private=secret',true);
  assert.deepEqual((await listKeptSites(chrome)).map(s=>s.url),[site.url]);
  assert.equal(JSON.stringify(local).includes('secret'),false);
  const saved=(await listKeptSites(chrome))[0];
  await reportKeptSite(chrome,{id:site.id,revision:saved.revision,status:'login_required',platform:'xhs'});
  assert.equal((await sitesWithStatus(chrome))[0].status,'login_required');
  await setKeptSite(chrome,site.url,false);
  assert.equal((await listKeptSites(chrome)).length,0);
  await setKeptSite(chrome,site.url,true);
  assert.deepEqual(await reportKeptSite(chrome,{id:site.id,revision:saved.revision,status:'alive'}),{ignored:true});
});

test('platform must explicitly opt in; heartbeat declaration is per site and read-only',()=>{
  assert.deepEqual(resolve(site),{platform:'xhs',action:'heartbeat',url:'https://creator.xiaohongshu.com/',intervalMs:1800000});
  assert.equal(resolve({...site,url:'https://wrong.example',id:'https://wrong.example'}),null);
  assert.equal(resolve({...site,url:'https://creator.xiaohongshu.com/?token=secret'}),null);
  const prior=manifests.xhs.keep_alive;
  delete manifests.xhs.keep_alive;
  try {assert.equal(resolve(site),null);}finally{manifests.xhs.keep_alive=prior;}
});

test('scheduler checks one site at a time, handles login-required, throttles retries and defers on busy pool',async()=>{
  let timestamp=1000, allowed=false, runs=0;
  const reports=[];
  const scheduler=createSiteKeepaliveScheduler({listSites:async()=>[site],report:async r=>reports.push(r),
    resolve,now:()=>timestamp,canRun:async()=>allowed,run:async()=>{runs++;return {status:'login_required'};}});
  assert.deepEqual(await scheduler.tick(),{deferred:true});
  assert.equal(runs,0);
  allowed=true;
  assert.equal((await scheduler.tick()).status,'login_required');
  assert.equal(runs,1);
  assert.equal(reports[0].status,'login_required');
  timestamp+=299999;
  assert.deepEqual(await scheduler.tick(),{idle:true});
  timestamp++;
  assert.equal((await scheduler.tick()).status,'login_required');
  assert.equal(runs,2);
});

test('scheduler does not guess login success if platform returns no recognized status',async()=>{
  const reports=[];
  const scheduler=createSiteKeepaliveScheduler({listSites:async()=>[site],report:async r=>reports.push(r),
    resolve,run:async()=>({ok:true})});
  await scheduler.tick();
  assert.equal(reports[0].status,'unknown');
});

test('extension popup can toggle only a live leased tab; inactive entry opens only registered HTTPS origin',async()=>{
  const {chrome,calls}=mockChrome();
  let time=5000;
  const channel=new ControlChannel(chrome,()=>time,()=>`request-${time}`);
  await channel.poll([{session_id:'abc',workspace:'WebHelm',tabId:11}]);
  const rpc=createControlRpc({control:channel,chromeApi:chrome,
    manager:{async list(){return {workspaces:[{name:'WebHelm',initialized:true,poolSize:4,idle:3,leased:1}]};}},
    summarizeWorkspaces,scheduleBadge(){}});
  const enabled=await rpc('workspace.control.site.toggle',{sessionId:'abc',enabled:true});
  assert.equal(enabled.id,site.id);
  const state=await rpc('workspace.control.status');
  assert.equal(state.keptSites[0].id,site.id);
  assert.equal(state.workspaces[0].sessions[0].tab_url,'https://creator.xiaohongshu.com/publish?private=secret');
  assert.deepEqual(await rpc('workspace.control.site.open',{siteId:site.id}),{ok:true,tabId:41,opened:true});
  assert.deepEqual(calls,[['create',{url:site.url,active:true}]]);
  // An already-open website may belong to an agent's leased Tab. Manual
  // login must open a separate Tab instead of hijacking that Session.
  chrome.tabs.query=async()=>[{id:11,windowId:1,url:site.url}];
  await rpc('workspace.control.site.open',{siteId:site.id});
  assert.equal(calls.filter(([kind])=>kind==='create').length,2);
  await assert.rejects(rpc('workspace.control.site.toggle',{sessionId:'missing',enabled:true}),/no longer leased/);
  await assert.rejects(rpc('workspace.control.site.open',{siteId:'https://other.example'}),/no longer registered/);
  await rpc('workspace.control.site.remove',{siteId:site.id});
  assert.equal((await rpc('workspace.control.status')).keptSites.length,0);
});
