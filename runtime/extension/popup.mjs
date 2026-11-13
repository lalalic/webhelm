const el = id => document.getElementById(id);
let confirming = false;
let chosen = null;
let lastSignature = '';
let lastQueueSignature = '';
let lastSiteSignature = '';
let currentSites = [];
let refreshRunning = false;
const queueRows = new Map();
const queueGroups = new Map();

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

function originForTab(url) {
  try { const site=new URL(url); return site.protocol === 'https:' ? site.origin : null; }
  catch { return null; }
}

function renderKeptSites(sites, busy, connected) {
  const signature = JSON.stringify(sites) + `:${busy}:${connected}`;
  if (signature === lastSiteSignature) return;
  lastSiteSignature = signature;
  const target = el('keepalive-list');
  target.replaceChildren();
  if (!sites.length) {
    target.textContent='Toggle Keep Alive on a leased website to add it here.';
    return;
  }
  const labels={alive:'Logged in',login_required:'Login required',unknown:'Login unknown',
    error:'Check failed',unsupported:'No heartbeat action',pending:'Pending check'};
  for (const site of sites) {
    const row=document.createElement('div'); row.className='keepalive-row';
    const details=document.createElement('div'); details.className='keepalive-info';
    const name=actionButton(new URL(site.url).hostname,false,async()=>{
      try {await rpc('workspace.control.site.open',{siteId:site.id});}
      catch(error){el('message').textContent=error.message;}
    },'tab-title');
    const status=document.createElement('span'); status.className='keepalive-status';
    status.textContent=labels[site.status] || 'Pending check';
    status.dataset.status=site.status;
    details.append(name,status);
    row.append(details,actionButton('Remove',false,async()=>{
      try {await rpc('workspace.control.site.remove',{siteId:site.id});lastSignature='';refresh();}
      catch(error){el('message').textContent=error.message;}
    }));
    target.append(row);
  }
}

function renderWorkspaces(workspaces, busy, connected) {
  const signature = JSON.stringify(workspaces.map(w => [
    w.name,w.initialized,w.available,w.poolSize,w.idleTabs,w.leasedTabs,w.sessions.map(s => [s.session_id,s.tab_title,s.tabId,s.tab_url]),
  ])) + ':' + busy + ':' + connected;
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
      if (siteId) {
        const enabled=currentSites.some(site=>site.id===siteId);
        sessionRow.append(actionButton(enabled?'On':'Keep Alive',busy||!connected,async()=>{
          try {
            await rpc('workspace.control.site.toggle',{sessionId:session.session_id,enabled:!enabled});
            lastSignature='';refresh();
          } catch(error){el('message').textContent=error.message;}
        },enabled?'site-enabled':''));
      }
      sessionRow.append(actionButton('Stop', busy || !connected,
        () => showConfirmation('stop', {sessionId:session.session_id})));
      row.append(sessionRow);
    }
    target.append(row);
  }
}

function renderQueue(items, busy, connected) {
  const signature=JSON.stringify(items.map(item=>[item.id,item.platform,item.title,item.url,item.state,item.attempts]))+`:${busy}:${connected}`;
  if (signature===lastQueueSignature) return;
  lastQueueSignature=signature;
  const target=el('queue-list');
  const grouped = new Map();
  for (const item of items) {
    const platform = String(item.platform || 'Queue');
    if (!grouped.has(platform)) grouped.set(platform, []);
    grouped.get(platform).push(item);
  }
  const activeGroupKeys = new Set(grouped.keys());
  const activeRowKeys = new Set(items.map(item => `${item.platform || 'Queue'}:${item.id}`));
  for (const [key, group] of queueGroups) if (!activeGroupKeys.has(key)) {
    group.remove(); queueGroups.delete(key);
  }
  for (const [key, row] of queueRows) if (!activeRowKeys.has(key)) {
    row.remove(); queueRows.delete(key);
  }
  if (!items.length) {
    target.replaceChildren();
    const empty=document.createElement('div'); empty.className='empty-queue'; empty.textContent='No queue entries';
    target.append(empty);
    return;
  }
  target.querySelector('.empty-queue')?.remove();
  for (const [platform, entries] of grouped) {
    let group = queueGroups.get(platform);
    if (!group) {
      group = document.createElement('section'); group.className='queue-platform';
      const heading = document.createElement('strong'); heading.className='queue-platform-title';
      heading.textContent=platform==='Queue'?'Queue':`${platform} Queue`;
      const rows = document.createElement('div'); rows.className='queue-platform-rows';
      group.append(heading, rows); queueGroups.set(platform, group); target.append(group);
    }
    for (const item of entries) {
      const key = `${platform}:${item.id}`;
      let row = queueRows.get(key);
      if (!row) {
        row=document.createElement('div'); row.className='queue-row';
        const info=document.createElement('div'); info.className='queue-info';
        const title=actionButton('', false, async()=>{
          try { await rpc('workspace.control.openQueue',{queueId:item.id}); el('message').textContent='Queue destination opened.'; }
          catch(error) { el('message').textContent=error.message; }
        }, 'queue-title');
        const detail=document.createElement('span'); detail.className='queue-detail';
        const remove=actionButton('Remove', false, async()=>{
          try { const result=await rpc('workspace.control.queueCancel',{queueId:item.id}); if(!result.id) throw new Error('Missing queue request ID'); el('message').textContent='Waiting for WebHelm daemon…'; }
          catch(error) { el('message').textContent=error.message; }
          refresh();
        });
        row.append(info, remove); info.append(title, detail);
        queueRows.set(key,row);
      }
      const title=row.querySelector('.queue-title');
      title.textContent=item.title || `${platform} message`;
      title.title=item.title || `${platform} message`;
      title.disabled=!connected || !item.url;
      row.querySelector('.queue-detail').textContent=`${item.state.toLowerCase()} · ${item.attempts} attempt${item.attempts===1?'':'s'}`;
      const remove=row.querySelector('button:last-child');
      const safe=['QUEUED','WAITING','BLOCKED','UNCERTAIN'].includes(item.state);
      remove.disabled=!safe || busy || !connected;
      remove.title=safe?'':'Cannot remove a running or completed submission';
      const rows=group.querySelector('.queue-platform-rows');
      if (row.parentElement!==rows) rows.append(row);
    }
    if (group.parentElement!==target) target.append(group);
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
    currentSites=state.keptSites || [];
    renderKeptSites(currentSites,busy,state.connected);
    renderWorkspaces(state.workspaces || [], busy, state.connected);
    renderQueue(state.queue || [], busy, state.connected);
    el('confirm').disabled = !state.connected || busy;
    if (busy) {
      el('message').textContent = 'Applying WebHelm action…';
    } else if (state.lastResult) {
      el('message').textContent = state.lastResult.ok
        ? (state.lastResult.queue_id ? 'Queue entry removed.' : `Last action: stopped ${state.lastResult.stoppedCount} session(s).`)
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
