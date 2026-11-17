import test from 'node:test';
import assert from 'node:assert/strict';
import {compactQueue,mergeKeptSites,readKeptSites,setStoredSite,menuWorkspaces,readMenuWorkspaces,WORKSPACE_STORAGE_KEY,SITE_STORAGE_KEY,SITE_STATUS_KEY} from '../../runtime/extension/popup-data.mjs';

function fakeChrome(sites=[],states={}) {
  const local={[SITE_STORAGE_KEY]:sites};
  const session={[SITE_STATUS_KEY]:states};
  return {storage:{
    local:{get:async key=>({[key]:local[key]}),set:async data=>Object.assign(local,data)},
    session:{get:async key=>({[key]:session[key]}),set:async data=>Object.assign(session,data)},
  },snapshot:{local,session}};
}

test('popup displays persisted Keep Alive sites even if old worker omits keptSites',async()=>{
  const site={id:'https://studio.youtube.com',url:'https://studio.youtube.com',enabled:true,revision:'abc'};
  const chrome=fakeChrome([site],{[site.id]:{status:'alive'}});
  assert.deepEqual(await readKeptSites(chrome,undefined),[{...site,status:'alive'}]);
  assert.equal((await readKeptSites(chrome,[])).length,1,'empty RPC snapshot must not hide persisted sites');
  assert.deepEqual((await readKeptSites(chrome,[{...site,status:'login_required'}]))[0].status,'login_required');
});

test('Keep Alive site fallback ignores invalid state and removes only requested site',async()=>{
  const a={id:'https://channels.weixin.qq.com',url:'https://channels.weixin.qq.com',enabled:true};
  const b={id:'https://www.tiktok.com',url:'https://www.tiktok.com',enabled:true};
  const chrome=fakeChrome([a,b,{id:'https://fake.com',url:'http://fake.com',enabled:true}],{
    [a.id]:{status:'alive'},[b.id]:{status:'unknown'},
  });
  assert.equal(mergeKeptSites(chrome.snapshot.local[SITE_STORAGE_KEY],{},[]).length,2);
  await setStoredSite(chrome,a.url,false);
  assert.deepEqual(chrome.snapshot.local[SITE_STORAGE_KEY].map(x=>x.id),['https://fake.com',b.id]);
  assert.equal(chrome.snapshot.session[SITE_STATUS_KEY][a.id],undefined);
  assert.equal(chrome.snapshot.session[SITE_STATUS_KEY][b.id].status,'unknown');
});

test('queue defaults to distinct thread heads; preserves every pending record unchanged',()=>{
  const rows=[{id:'a',thread_id:'one',state:'UNCERTAIN',attempts:1,platform:'ChatGPT'},
    ...Array.from({length:99},(_,i)=>({id:`q${i}`,thread_id:'one',state:'QUEUED',attempts:0,platform:'ChatGPT'})),
    {id:'b',thread_id:'two',state:'BLOCKED',platform:'ChatGPT'},
    {id:'c',thread_id:'three',state:'UNCERTAIN',platform:'ChatGPT'}];
  const before=JSON.stringify(rows);
  const compact=compactQueue(rows);
  assert.equal(compact.total,102);
  assert.equal(compact.threads,3);
  assert.deepEqual(compact.visible.map(x=>x.id),['a','c','b']);
  assert.equal(compact.behind.get('a'),99);
  assert.equal(compact.hidden,99);
  assert.equal(compact.uncertain,2);
  assert.equal(compact.blocked,1);
  assert.equal(JSON.stringify(rows),before,'display folding must never mutate the durable queue');
  const expanded=compactQueue(rows,{expanded:true});
  assert.equal(expanded.visible.length,102);
  assert.equal(expanded.hidden,0);
});

test('queue preview limits many threads but preserves row actions when expanded',()=>{
  const items=Array.from({length:22},(_,i)=>({id:`m${i}`,thread_id:`t${i}`,state:'QUEUED',platform:'ChatGPT'}));
  const preview=compactQueue(items,{maxHeads:8});
  assert.equal(preview.visible.length,8);
  assert.equal(preview.hidden,14);
  assert.equal(compactQueue(items,{expanded:true}).visible.length,22);
  assert.equal(compactQueue([],{}).visible.length,0);
});

test('legacy running worker menu respects persisted hidden groups',async()=>{
  const workspaces=[{name:'WeChat',showInMenu:true,sessions:[{session_id:'active'}]},
    {name:'Relay',showInMenu:true},{name:'WebHelm',showInMenu:true}];
  const config={workspaces:{WeChat:{poolSize:1,showInMenu:false},Relay:{poolSize:6},WebHelm:{poolSize:8}}};
  const chrome={storage:{local:{get:async()=>({[WORKSPACE_STORAGE_KEY]:config})}}};
  const result=await readMenuWorkspaces(chrome,workspaces);
  assert.deepEqual(result.map(w=>w.name),['Relay','WebHelm']);
  assert.equal(workspaces.length,3,'read operation must not modify daemon session list');
  assert.deepEqual(menuWorkspaces([{name:'WeChat',showInMenu:false}],{}),[]);
});
