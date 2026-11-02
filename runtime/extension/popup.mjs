const el = id => document.getElementById(id);
let confirming = false;
let chosen = null;
let lastSignature = '';
let refreshRunning = false;

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

function actionButton(label, disabled, onClick) {
  const button = document.createElement('button');
  button.textContent = label;
  button.disabled = disabled;
  button.addEventListener('click', onClick);
  return button;
}

function renderWorkspaces(workspaces, busy, connected) {
  const signature = JSON.stringify(workspaces.map(w => [
    w.name,w.initialized,w.available,w.poolSize,w.idleTabs,w.leasedTabs,w.sessions.map(s => s.session_id),
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
      const identifier = document.createElement('span');
      identifier.textContent = `Session ${session.session_id.slice(0, 12)}…`;
      details.append(identifier);
      sessionRow.append(details, actionButton('Stop', busy || !connected,
        () => showConfirmation('stop', {sessionId:session.session_id})));
      row.append(sessionRow);
    }
    target.append(row);
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
    renderWorkspaces(state.workspaces || [], busy, state.connected);
    el('confirm').disabled = !state.connected || busy;
    if (busy) {
      el('message').textContent = 'Stopping sessions…';
    } else if (state.lastResult) {
      el('message').textContent = state.lastResult.ok
        ? `Last action: stopped ${state.lastResult.stoppedCount} session(s).`
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
