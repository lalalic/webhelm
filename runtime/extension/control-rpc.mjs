function validTabId(tabId) { return Number.isSafeInteger(tabId) && tabId > 0; }
function validateQueueUrl(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !parsed.hostname) throw Error('Queue target must be an HTTPS URL');
  return parsed.href;
}

export function createControlRpc({control, manager, summarizeWorkspaces, scheduleBadge, chromeApi=globalThis.chrome ?? control.chrome}) {
  return async function controlRpc(method, args = {}) {
    switch (method) {
      case "workspace.control.status": {
        const state = await control.status();
        const summary = summarizeWorkspaces((await manager.list()).workspaces, state.sessions);
        const workspaces = await Promise.all(summary.workspaces.map(async workspace => ({
          ...workspace,
          sessions: await Promise.all(workspace.sessions.map(async session => {
            if (!validTabId(session.tabId)) return session;
            try {
              const tab = await chromeApi.tabs.get(session.tabId);
              return {...session, tab_title: tab.title || 'Untitled tab'};
            } catch { return {...session, tabId:null}; }
          })),
        })));
        return {...state,...summary,workspaces};
      }
      case "workspace.control.activateTab": {
        const state = await control.status();
        if (!state.connected) throw Error('WebHelm daemon is not responding');
        const session = state.sessions.find(s => s.session_id === args.sessionId);
        if (!session || !validTabId(session.tabId)) throw Error('Session tab is no longer active');
        const tab = await chromeApi.tabs.get(session.tabId);
        await chromeApi.tabs.update(tab.id,{active:true});
        await chromeApi.windows.update(tab.windowId,{focused:true});
        return {ok:true};
      }
      case "workspace.control.openQueue": {
        const state = await control.status();
        if (!state.connected) throw Error('WebHelm daemon is not responding');
        const item = state.queue.find(item => item.id === args.queueId);
        if (!item || typeof item.url !== 'string') throw Error('Queue entry no longer available');
        const url = validateQueueUrl(item.url);
        await chromeApi.tabs.create({url, active:true});
        return {ok:true};
      }
      case "workspace.control.requestStop":
        return control.requestStop(args.action, args.sessionId, args.workspace);
      case "workspace.control.queueCancel":
        return control.requestQueueCancel(args.queueId);
      case "workspace.control.heartbeat":
        return control.heartbeat(args.sessions, args.queue);
      case "workspace.control.poll": {
        const result = await control.poll(args.sessions, args.queue);
        scheduleBadge();
        return result;
      }
      case "workspace.control.complete":
        return control.complete(args.id, args.response);
      default:
        throw new Error("Unknown workspace control method");
    }
  };
}
