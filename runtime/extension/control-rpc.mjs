import {siteOrigin, setKeptSite, listKeptSites, sitesWithStatus, reportKeptSite} from "./site-registry.mjs";
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
              return {...session, tab_title: tab.title || 'Untitled tab', tab_url:tab.url || ''};
            } catch { return {...session, tabId:null}; }
          })),
        })));
        return {...state,...summary,workspaces,keptSites:chromeApi.storage?.local ? await sitesWithStatus(chromeApi) : []};
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
        const existing = (await chromeApi.tabs.query({})).find(tab => {
          try { return new URL(tab.url).href === url; } catch { return false; }
        });
        if (existing) {
          await chromeApi.tabs.update(existing.id,{active:true});
          await chromeApi.windows.update(existing.windowId,{focused:true});
          return {ok:true,tabId:existing.id,focused:true};
        }
        const opened = await chromeApi.tabs.create({url, active:true});
        return {ok:true,tabId:opened.id,opened:true};
      }
      case "workspace.control.site.toggle": {
        const state = await control.status();
        if (!state.connected) throw Error('WebHelm daemon is not responding');
        const session = state.sessions.find(s => s.session_id === args.sessionId);
        if (!session || !validTabId(session.tabId)) throw Error('Session tab is no longer leased');
        if (session.workspace !== 'WebHelm')
          throw Error('Keep Alive can be enabled only from a WebHelm Session');
        const tab = await chromeApi.tabs.get(session.tabId);
        const id = siteOrigin(tab.url || '');
        return setKeptSite(chromeApi,id,Boolean(args.enabled));
      }
      case "workspace.control.site.remove": {
        const site = (await listKeptSites(chromeApi)).find(s => s.id === args.siteId);
        if (!site) throw Error('Keep Alive site is no longer registered');
        return setKeptSite(chromeApi,site.url,false);
      }
      case "workspace.control.site.open": {
        const site = (await listKeptSites(chromeApi)).find(s => s.id === args.siteId);
        if (!site) throw Error('Keep Alive site is no longer registered');
        const url = siteOrigin(site.url);
        const daemon = await control.status();
        const leasedIds = new Set(daemon.connected ? daemon.sessions.flatMap(session =>
          Array.isArray(session.tabIds) ? session.tabIds : [session.tabId]) : []);
        // Never hand a human-login operation an active agent-owned leased Tab.
        const existing = daemon.connected && (await chromeApi.tabs.query({})).find(tab => {
          if (leasedIds.has(tab.id)) return false;
          try { return siteOrigin(tab.url) === url; } catch { return false; }
        });
        if (existing) {
          await chromeApi.tabs.update(existing.id,{active:true});
          await chromeApi.windows.update(existing.windowId,{focused:true});
          return {ok:true,tabId:existing.id,focused:true};
        }
        const opened = await chromeApi.tabs.create({url,active:true});
        return {ok:true,tabId:opened.id,opened:true};
      }
      // Daemon-only control RPCs, unavailable to extension pages.
      case "workspace.control.site.list":
        return listKeptSites(chromeApi);
      case "workspace.control.site.report":
        return reportKeptSite(chromeApi,args);
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
