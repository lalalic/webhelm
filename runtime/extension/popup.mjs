import {readKeptSites, setStoredSite, readMenuWorkspaces, formatQueueElapsed} from './popup-data.mjs';
const el = id => document.getElementById(id);
el('extension-version').textContent = `v${chrome.runtime.getManifest().version}`;
let confirming = false;
let chosen = null;
let lastSignature = '';
let lastQueueSignature = '';
let lastSiteSignature = '';
let currentSites = [];
let refreshRunning = false;
let canControlSites = false;
let canEnableDesign = false;
let currentQueue = [];
let queueBusy = false;
let queueConnected = false;
const queueRows = new Map();
const queueGroups = new Map();
const queueThreadGroups = new Map();
const queueOpenedAtSeconds=Math.floor(Date.now()/1000);

async function rpc(method, args = {}) {
  const response = await chrome.runtime.sendMessage({method, args});
  if (!response?.ok) throw new Error(response?.error?.message || 'WebHelm request failed');
  return response.result;
}

function showConfirmation(action, params = {}) {
  chosen = {action, ...params};
  confirming = true;
  el('confirmation').hidden = false;
  if (action === 'stop-workspace') {
    el('confirm-text').textContent = `Stop all sessions in "${params.workspace}"? Other workspaces are unaffected.`;
  } else if (action === 'stop') {
    el('confirm-text').textContent = `Stop session ${params.sessionId.slice(0,12)}…? Active work may be interrupted.`;
  } else {
    throw new Error('Unsupported stop action');
  }
}

function actionButton(label, disabled, onClick, className = '') {
  const button = document.createElement('button');
  button.textContent = label;
  if (className) button.className = className;
  button.disabled = disabled;
  button.addEventListener('click', onClick);
  return button;
}

function iconButton(kind, disabled, onClick, title, active = false) {
  const activeClass = active ? (kind === 'keepalive' ? ' site-enabled' : ' design-active') : '';
  const button = actionButton('', disabled, onClick, 'icon-button' + activeClass);
  button.title=title;
  button.setAttribute('aria-label',title);
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
  svg.setAttribute('viewBox','0 0 24 24');
  svg.setAttribute('width','16');
  svg.setAttribute('height','16');
  svg.setAttribute('fill','none');
  svg.setAttribute('stroke','currentColor');
  svg.setAttribute('stroke-width','1.8');
  svg.setAttribute('stroke-linecap','round');
  svg.setAttribute('stroke-linejoin','round');
  svg.setAttribute('aria-hidden','true');
  const paths=kind==='split'
    ? ['M12 3v18','M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z']
    : kind==='keepalive'
      ? ['M22 12h-4l-3 9L9 3l-3 9H2']
      : ['M6 6h12v12H6z','M9 9l6 6','M15 9l-6 6'];
  for(const d of paths){
    const path=document.createElementNS('http://www.w3.org/2000/svg','path');
    path.setAttribute('d',d);
    svg.append(path);
  }
  button.append(svg);
  return button;
}

function originForTab(url) {
  try { const site=new URL(url); return site.protocol === 'https:' ? site.origin : null; }
  catch { return null; }
}

function siteLabel(url) {
  const page = new URL(url);
  return page.hostname + (page.pathname === '/' ? '' : page.pathname);
}

function renderKeptSites(sites, busy, connected) {
  const signature = JSON.stringify(sites) + `:${busy}:${connected}`;
  if (signature === lastSiteSignature) return;
  lastSiteSignature = signature;
  const target = el('keepalive-list');
  target.replaceChildren();
  if (!sites.length) {
    target.textContent='Enable Keep Alive from a WebHelm Session.';
    return;
  }
  const labels={alive:'Logged in',failed:'Heartbeat failed',login_required:'Login required',unknown:'Login not confirmed',
    error:'Heartbeat failed',release_error:'Tab release failed',unsupported:'No heartbeat action',pending:'Checking login'};
  for (const site of sites) {
    const row=document.createElement('div'); row.className='keepalive-row';
    const loggedIn=site.status==='alive';
    const statusText=(labels[site.status] || labels.pending)+(site.paused?' · Paused':'')+(site.reason&&site.reason!==site.status?' · '+(labels[site.reason]||site.reason):'');
    const status=document.createElement('span'); status.className='keepalive-status';
    status.dataset.status=loggedIn?'alive':'inactive';
    status.title=statusText;
    status.setAttribute('aria-hidden','true');
    const name=actionButton(siteLabel(site.url),false,async()=>{
      try {
        if (canControlSites) await rpc('workspace.control.site.open',{siteId:site.id});
        else await chrome.tabs.create({url:site.url,active:true});
      } catch(error){el('message').textContent=error.message;}
    },`tab-title keepalive-name ${loggedIn?'is-logged-in':''}`);
    name.title=`${siteLabel(site.url)} · ${statusText} · Click to open site`;
    name.setAttribute('aria-label',`${siteLabel(site.url)}: ${statusText}. Open site`);
    const remove=actionButton('×',false,async()=>{
      try {
        if (canControlSites) await rpc('workspace.control.site.remove',{siteId:site.id});
        else await setStoredSite(chrome,site.url,false);
        lastSiteSignature='';lastSignature='';refresh();
      } catch(error){el('message').textContent=error.message;}
    },'keepalive-remove');
    remove.title=`Remove ${siteLabel(site.url)} from Keep Alive`;
    remove.setAttribute('aria-label',remove.title);
    row.append(status,name);
    if (site.paused) {
      const resume=actionButton('↻',!connected,async()=>{
        try {await rpc('workspace.control.site.resume',{siteId:site.id});lastSiteSignature='';refresh();}
        catch(error){el('message').textContent=error.message;}
      },'keepalive-remove');
      resume.title=resume.getAttribute('aria-label') || 'Resume heartbeat after signing in';
      resume.setAttribute('aria-label',resume.title);
      row.append(resume);
    }
    row.append(remove);
    target.append(row);
  }
}

function renderWorkspaces(workspaces, busy, connected) {
  const signature = JSON.stringify(workspaces.map(w => [
    w.name,w.initialized,w.available,w.poolSize,w.idleTabs,w.leasedTabs,w.sessions.map(s => [s.session_id,s.tab_title,s.tabId,s.tab_url,s.designActive]),
  ])) + ':' + JSON.stringify(currentSites.map(site=>site.id)) + ':' + canControlSites + ':' + canEnableDesign + ':' + busy + ':' + connected;
  if (signature === lastSignature) return;
  lastSignature = signature;
  const target = el('workspace-list');
  target.replaceChildren();
  if (!workspaces.length) {
    target.textContent = 'No configured workspaces';
    return;
  }
  for (const workspace of workspaces) {
    const row = document.createElement('section');
    row.className = 'workspace-row';
    const header = document.createElement('div');
    header.className = 'workspace-title';
    const heading = document.createElement('strong');
    heading.textContent = workspace.name;
    header.append(heading, actionButton('Clear sessions', busy || !connected || !workspace.sessions.length,
      () => showConfirmation('stop-workspace', {workspace:workspace.name})));
    const info = document.createElement('div');
    info.className = 'workspace-details';
    info.textContent = workspace.initialized
      ? `${workspace.available}/${workspace.poolSize} available · ${workspace.idleTabs} idle · ${workspace.sessions.length} session${workspace.sessions.length === 1 ? "" : "s"}`
      : `Unavailable · ${workspace.sessions.length} session${workspace.sessions.length === 1 ? "" : "s"}`;
    row.append(header, info);
    for (const session of workspace.sessions) {
      const sessionRow = document.createElement('div');
      sessionRow.className = 'session-row';
      const details = document.createElement('div');
      details.className = 'session-info';
      const title = actionButton(session.tab_title || 'Untitled tab', busy || !connected || !session.tabId, async () => {
        try { await rpc('workspace.control.activateTab', {sessionId:session.session_id}); }
        catch(error) { el('message').textContent=error.message; }
      }, 'tab-title');
      title.title = session.tab_title || 'Untitled tab';
      details.append(title);
      const siteId=originForTab(session.tab_url);
      sessionRow.append(details);
      if (workspace.name === 'WebHelm' && siteId) {
        const enabled=currentSites.some(site=>site.id===siteId);
        const toggle=iconButton('keepalive',busy||!connected||!canControlSites,async()=>{
          try {
            await rpc('workspace.control.site.toggle',{sessionId:session.session_id,enabled:!enabled});
            lastSignature='';refresh();
          } catch(error){el('message').textContent=error.message;}
        },!canControlSites
          ? 'Update the running WebHelm daemon to manage Keep Alive sites'
          : enabled ? 'Disable Keep Alive for this site' : 'Enable Keep Alive for this site',enabled);
        sessionRow.append(toggle);
      }
      if (session.tabId && (session.designActive || canEnableDesign)) {
        const designButton=iconButton('split',
          busy || !connected,async()=>{
            try {
              await rpc('workspace.control.design.toggle',{sessionId:session.session_id});
              lastSignature='';
              refresh();
            } catch(error){el('message').textContent=error.message;}
          },session.designActive
          ? 'Exit Design Mode: restore ChatGPT tab'
          : 'Design Mode: split Session with active ChatGPT thread',session.designActive);
        sessionRow.append(designButton);
      }
      sessionRow.append(iconButton('stop', busy || !connected,
        () => showConfirmation('stop', {sessionId:session.session_id}),
        'Stop Session'));
      row.append(sessionRow);
    }
    target.append(row);
  }
}

function renderQueue(items, busy, connected) {
  const signature=JSON.stringify({
    items:items.map(item=>[item.id,item.platform,item.group,item.title,item.url,item.state,item.attempts,item.created_at]),
    busy,connected,
  });
  if(signature===lastQueueSignature)return;
  lastQueueSignature=signature;
  const target=el('queue-list');
  target.hidden=!items.length;
  const grouped=new Map();
  for(const item of items) {
    const platform=String(item.platform||'Queue');
    const threadId=String(item.group||item.id);
    if(!grouped.has(platform))grouped.set(platform,new Map());
    const threads=grouped.get(platform);
    if(!threads.has(threadId))threads.set(threadId,[]);
    threads.get(threadId).push(item);
  }
  const activePlatforms=new Set(grouped.keys());
  const activeRows=new Set(items.map(item=>(item.platform||'Queue')+':'+item.id));
  for(const [key,row] of queueRows)if(!activeRows.has(key)){row.remove();queueRows.delete(key);}
  for(const [key,group] of queueThreadGroups)
    if(!grouped.has(key.split('\u0000')[0])||!grouped.get(key.split('\u0000')[0]).has(key.split('\u0000')[1])){
      group.remove();queueThreadGroups.delete(key);
    }
  for(const [key,group] of queueGroups)if(!activePlatforms.has(key)){
    group.remove();queueGroups.delete(key);
  }
  if(!items.length){target.replaceChildren();queueGroups.clear();queueThreadGroups.clear();queueRows.clear();return;}
  for(const [platform,threads] of grouped){
    let group=queueGroups.get(platform);
    if(!group){
      group=document.createElement('section');group.className='queue-platform';
      const heading=document.createElement('strong');heading.className='queue-platform-title';
      heading.textContent=platform==='Queue'?'Queue':platform+' Queue';
      const list=document.createElement('div');list.className='queue-platform-threads';
      group.append(heading,list);queueGroups.set(platform,group);
    }
    const list=group.querySelector('.queue-platform-threads');
    for(const [threadId,entries] of threads){
      const threadKey=platform+'\u0000'+threadId;
      let thread=queueThreadGroups.get(threadKey);
      if(!thread){
        thread=document.createElement('section');thread.className='queue-thread';
        const link=document.createElement('a');link.className='queue-thread-link';
        link.textContent=threadId;
        link.addEventListener('click',async event=>{
          event.preventDefault();
          const queueId=thread.querySelector('.queue-row')?.dataset.queueId;
          if(!queueId)return;
          try{await rpc('workspace.control.openQueue',{queueId});}
          catch(error){el('message').textContent=error.message;}
        });
        const rows=document.createElement('div');rows.className='queue-thread-rows';
        thread.append(link,rows);queueThreadGroups.set(threadKey,thread);
      }
      const link=thread.querySelector('.queue-thread-link');
      const url=entries.find(item=>item.url)?.url;
      if(connected&&url)link.href=url;
      else link.removeAttribute('href');
      link.title=threadId;
      const rows=thread.querySelector('.queue-thread-rows');
      for(const item of entries){
        const key=platform+':'+item.id;
        let row=queueRows.get(key);
        if(!row){
          row=document.createElement('div');row.className='queue-row';
          const info=document.createElement('div');info.className='queue-info';
          const title=document.createElement('span');title.className='queue-title';
          const meta=document.createElement('span');meta.className='queue-meta';
          const remove=actionButton('×',false,async()=>{
            try{
              const result=await rpc('workspace.control.queueCancel',{queueId:item.id});
              if(result.id)el('message').textContent='Waiting for WebHelm daemon…';
            }catch(error){el('message').textContent=error.message;}
            refresh();
          },'queue-remove');
          info.append(title,meta);row.append(info,remove);queueRows.set(key,row);
        }
        const title=row.querySelector('.queue-title');
        title.textContent=item.title||platform+' message';
        title.title=item.title||platform+' message';
        row.dataset.queueId=item.id;
        row.dataset.state=item.state;
        const elapsed=formatQueueElapsed(item.created_at,queueOpenedAtSeconds);
        const attempts=Math.max(0,Number(item.attempts)||0);
        row.querySelector('.queue-meta').textContent='('+(elapsed??'–')+'/'+attempts+')';
        const remove=row.querySelector('.queue-remove');
        remove.disabled=busy||!connected;
        remove.title='Cancel '+title.textContent+' (best effort before sending)';
        remove.setAttribute('aria-label',remove.title);
        if(row.parentElement!==rows)rows.append(row);
      }
      if(thread.parentElement!==list)list.append(thread);
    }
    if(group.parentElement!==target)target.append(group);
  }
}

async function refresh() {
  if (refreshRunning) return;
  refreshRunning = true;
  try {
    const state = await rpc('workspace.control.status');
    el('daemon-status').textContent = state.connected ? 'Online' : 'Offline';
    el('daemon-status').className = `daemon-state ${state.connected ? 'online' : 'offline'}`;
    const busy = Boolean(state.request);
    canControlSites=Array.isArray(state.keptSites);
    canEnableDesign=Boolean(state.canEnableDesign);
    currentSites=await readKeptSites(chrome,state.keptSites);
    renderKeptSites(currentSites,busy,state.connected);
    renderWorkspaces(await readMenuWorkspaces(chrome,state.workspaces || []),busy,state.connected);
    currentQueue=state.queue||[];
    queueBusy=busy;queueConnected=state.connected;
    renderQueue(currentQueue,busy,state.connected);
    el('confirm').disabled = !state.connected || busy;
    if (busy) {
      el('message').textContent = 'Applying WebHelm action…';
    } else if (state.lastResult) {
      el('message').textContent = state.lastResult.ok
        ? (state.lastResult.queue_id ? '' : `Last action: stopped ${state.lastResult.stoppedCount} session(s).`)
        : `Last action failed: ${state.lastResult.error}`;
    }
  } catch (error) {
    el('confirm').disabled = true;
    el('daemon-status').textContent = 'Offline';
    el('daemon-status').className = 'daemon-state offline';
    el('message').textContent = error.message;
  } finally {
    refreshRunning = false;
  }
}

el('cancel').addEventListener('click', () => {
  confirming = false;
  el('confirmation').hidden = true;
  refresh();
});
el('confirm').addEventListener('click', async () => {
  if (!confirming) return;
  el('confirm').disabled = true;
  try {
    const result = await rpc('workspace.control.requestStop', chosen);
    if (!result.id) throw new Error('Missing WebHelm stop request ID');
    el('message').textContent = 'Waiting for WebHelm daemon…';
  } catch (error) {
    el('message').textContent = error.message;
  } finally {
    confirming = false;
    el('confirmation').hidden = true;
      refresh();
  }
});

refresh();
setInterval(refresh, 1500);
