import test from 'node:test';
import assert from 'node:assert/strict';
import {compactQueue,queueStatusText,formatQueueElapsed,mergeKeptSites,readKeptSites,setStoredSite,menuWorkspaces,readMenuWorkspaces,WORKSPACE_STORAGE_KEY,SITE_STORAGE_KEY,SITE_STATUS_KEY} from '../../runtime/extension/popup-data.mjs';

test('elapsed queue metadata uses frozen compact s/m/h/d units and handles unknown timestamps',()=>{
  const now=1_800_000;
  for(const [age,expected] of [
    [0,'0s'],[1,'1s'],[59,'59s'],[60,'1m'],[119,'1m'],[3599,'59m'],
    [3600,'1h'],[86399,'23h'],[86400,'1d'],[172800,'2d'],[-10,'0s'],
  ]) assert.equal(formatQueueElapsed(now-age,now),expected,'age='+age);
  assert.equal(formatQueueElapsed(null,now),null);
  assert.equal(formatQueueElapsed('',now),null);
  assert.equal(formatQueueElapsed('invalid',now),null);
});

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

test('same-thread unconfirmed send is one thread with a blocked follow-up, not independent queued work',()=>{
  const rows=[
    {id:'first',thread_id:'same',platform:'ChatGPT',state:'UNCERTAIN',attempts:1},
    {id:'second',thread_id:'same',platform:'ChatGPT',state:'QUEUED',attempts:0},
  ];
  const folded=compactQueue(rows);
  assert.equal(folded.threads,1);
  assert.deepEqual(folded.visible.map(x=>x.id),['first']);
  assert.equal(queueStatusText(rows[0],{remaining:folded.behind.get('first')}),
    'Legacy unconfirmed send — pending migration · 1 later message waiting');
  const full=compactQueue(rows,{expanded:true});
  assert.deepEqual(full.visible.map(x=>x.id),['first','second']);
  assert.equal(full.headFor.get('second'),rows[0]);
  assert.equal(queueStatusText(rows[1],{head:full.headFor.get('second')}),
    'Waiting — previous send unconfirmed');
  assert.equal(rows[0].attempts,1);
  assert.equal(rows[1].attempts,0);
});

test('expanded queue keeps each thread contiguous under its head',()=>{
  const rows=[
    {id:'first',thread_id:'a',platform:'ChatGPT',state:'UNCERTAIN'},
    {id:'second',thread_id:'b',platform:'ChatGPT',state:'QUEUED'},
    {id:'third',thread_id:'a',platform:'ChatGPT',state:'QUEUED'},
    {id:'fourth',thread_id:'b',platform:'ChatGPT',state:'QUEUED'},
  ];
  assert.deepEqual(compactQueue(rows,{expanded:true}).visible.map(x=>x.id),
    ['first','third','second','fourth']);
  assert.deepEqual(rows.map(x=>x.id),['first','second','third','fourth'],
    'presentation must not reorder the durable queue');
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


test('FAILED is terminal and does not imply that a later queued turn is blocked',()=>{
  const items=[
    {id:'failed',thread_id:'same',platform:'ChatGPT',state:'FAILED'},
    {id:'next',thread_id:'same',platform:'ChatGPT',state:'QUEUED'},
  ];
  const queue=compactQueue(items,{expanded:true});
  assert.equal(queue.failed,1);
  assert.equal(queueStatusText(items[0],{remaining:1}),
    'Failed — Send click not confirmed; not retried · 1 later message queued');
  assert.equal(queueStatusText(items[1],{head:items[0]}),
    'Queued to send — previous attempt failed');
});
