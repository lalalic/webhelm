import test from 'node:test';
import assert from 'node:assert/strict';
import {DesignMode,isChatThread} from '../../runtime/extension/design-mode.mjs';
import {WorkspaceManager} from '../../runtime/extension/workspace-manager.mjs';

function mockChrome({crossWindow=false,chatUrl='https://chatgpt.com/c/6b01e2f1-d7f4-83e9-a409-bcef3a6ef801'}={}) {
  let splitId=91, nextId=200;
  const groups=new Map([
    [6,{id:6,windowId:1,title:'WebHelm',color:'blue',collapsed:true}],
    [9,{id:9,windowId:crossWindow?2:1,title:'Chats',color:'green',collapsed:false}],
  ]);
  const tabs=[
    {id:10,index:0,windowId:1,groupId:6,pinned:false,
      url:'https://www.motionlex.online/',title:'MotionLex',lastAccessed:20,splitViewId:-1},
    {id:11,index:crossWindow?0:1,windowId:crossWindow?2:1,groupId:9,pinned:false,
      url:chatUrl,title:'Current Chat',lastAccessed:100,splitViewId:-1},
    {id:12,index:crossWindow?1:2,windowId:crossWindow?2:1,groupId:-1,pinned:false,
      url:'https://example.com/',title:'Other',lastAccessed:10,splitViewId:-1},
  ];
  let lastSplitCalls=0;
  const methods={
    query:async(query={})=>tabs.filter(t=>query.groupId===undefined||t.groupId===query.groupId).map(t=>({...t})),
    get:async(id)=>{const t=tabs.find(x=>x.id===id);if(!t)throw Error('No tab with id: '+id);return {...t}},
    create:async(props)=>{const t={id:nextId++,index:tabs.length,windowId:props.windowId??1,groupId:-1,pinned:false,url:props.url,splitViewId:-1};tabs.push(t);return {...t}},
    move:async(id,p)=>{const t=tabs.find(x=>x.id===id);t.windowId=p.windowId??t.windowId;t.index=p.index;return {...t}},
    group:async({groupId,tabIds})=>{
      const id=groupId??nextId++;if(!groups.has(id))groups.set(id,{id,windowId:tabs.find(x=>x.id===tabIds[0]).windowId,title:'',color:'grey',collapsed:false});
      for(const tabId of tabIds)tabs.find(x=>x.id===tabId).groupId=id;
      return id;
    },
    ungroup:async(ids)=>{for(const id of ids)tabs.find(x=>x.id===id).groupId=-1},
    update:async(id,props)=>{Object.assign(tabs.find(x=>x.id===id),props)},
    createSplit:async([left,right])=>{
      const a=tabs.find(t=>t.id===left),b=tabs.find(t=>t.id===right);
      assert.equal(a.windowId,b.windowId);assert.equal(a.groupId,b.groupId);assert.equal(a.index+1,b.index);
      a.splitViewId=splitId;b.splitViewId=splitId;lastSplitCalls++;return splitId;
    },
    unsplit:async(id)=>{for(const t of tabs)if(t.splitViewId===id)t.splitViewId=-1},
    remove:async(id)=>{const i=tabs.findIndex(t=>t.id===id);if(i>=0)tabs.splice(i,1)},
  };
  const sessionState={};
  const chrome={
    tabs:methods,tabGroups:{
      get:async(id)=>{if(!groups.has(id))throw Error('No group');return {...groups.get(id)}},
      update:async(id,p)=>Object.assign(groups.get(id),p),
    },
    windows:{
      get:async(id)=>({id}),
      update:async()=>{},
    },
    storage:{
      session:{get:async key=>({[key]:sessionState[key]}),set:async x=>Object.assign(sessionState,x)},
      local:{get:async()=>({}),set:async()=>{}},
    },
    runtime:{getURL:path=>'chrome-extension://abcdefghijklmnop/'+path},
  };
  const manager=new WorkspaceManager(chrome);
  const control={status:async()=>({
    connected:true,sessions:[{session_id:'s1',tabId:10,tabIds:[10],workspace:'WebHelm'}],
  })};
  return {chrome,manager,control,tabs,groups,sessionState,splitCalls:()=>lastSplitCalls};
}

test('recognizes actual ChatGPT thread pages, not homepage or shares',()=>{
  assert.equal(isChatThread('https://chatgpt.com/c/6b01e2f1-d7f4-83e9-a409-bcef3a6ef801'),true);
  assert.equal(isChatThread('https://chatgpt.com/g/g-testing/c/6b01e2f1-d7f4-83e9-a409-bcef3a6ef801'),true);
  assert.equal(isChatThread('https://chatgpt.com/'),false);
  assert.equal(isChatThread('https://chatgpt.com/share/foo'),false);
  assert.equal(isChatThread('https://lookalike-chatgpt.com/c/test'),false);
});

test('Design Mode splits existing tabs and restores exactly the same user tab',async()=>{
  const m=mockChrome();
  const mode=new DesignMode(m.chrome,m.manager,m.control);
  await mode.ready;
  const result=await mode.toggle('s1');
  assert.equal(result.active,true);
  assert.equal(result.chatTabId,11);
  assert.equal(m.splitCalls(),1);
  assert.equal(m.tabs.find(t=>t.id===11).splitViewId,91);
  assert.deepEqual(m.manager.classify('WebHelm',await m.chrome.tabs.query({groupId:6})).leased.map(t=>t.id),[10]);
  assert.equal(m.manager.poolTabCount(await m.chrome.tabs.query({groupId:6})),1);
  assert.equal(m.groups.get(6).collapsed,false);
  assert.equal(mode.activeSessionIds().length,1);
  assert.equal((await mode.toggle('s1')).restored,true);
  assert.equal(m.tabs.find(t=>t.id===11).groupId,9);
  assert.equal(m.tabs.find(t=>t.id===11).splitViewId,-1);
  assert.equal(m.manager.designCompanionTabIds.size,0);
  assert.equal(m.groups.get(6).collapsed,true);
});

test('cross-window thread moves to Session window and back',async()=>{
  const m=mockChrome({crossWindow:true});
  const mode=new DesignMode(m.chrome,m.manager,m.control);
  await mode.ready;
  await mode.toggle('s1');
  assert.equal(m.tabs.find(t=>t.id===11).windowId,1);
  await mode.toggle('s1');
  assert.equal(m.tabs.find(t=>t.id===11).windowId,2);
});

test('does not create a ChatGPT thread if none is open',async()=>{
  const m=mockChrome({chatUrl:'https://chatgpt.com/'});
  const mode=new DesignMode(m.chrome,m.manager,m.control);
  await assert.rejects(()=>mode.toggle('s1'),/Open a ChatGPT conversation/);
  assert.equal(m.splitCalls(),0);
  assert.equal(m.manager.designCompanionTabIds.size,0);
});

test('reloaded extension recovers design companion protection from session state',async()=>{
  const m=mockChrome();
  const first=new DesignMode(m.chrome,m.manager,m.control);
  await first.toggle('s1');
  // Simulate the extension service-worker restarting with an empty manager.
  const replacementManager=new WorkspaceManager(m.chrome);
  const replacement=new DesignMode(m.chrome,replacementManager,m.control);
  await replacement.ready;
  assert.equal(replacement.activeSessionIds()[0],'s1');
  assert.equal(replacementManager.designCompanionTabIds.has(11),true);
  await replacement.toggle('s1');
  assert.equal(m.tabs.find(t=>t.id===11).groupId,9);
});

test('design state is per Session, not a global Chrome mode',async()=>{
  const m=mockChrome();
  const mode=new DesignMode(m.chrome,m.manager,m.control);
  await mode.toggle('s1');
  assert.equal(mode.hasSession('s1'),true);
  assert.equal(mode.hasSession('unrelated'),false);
  await mode.toggle('s1');
});
