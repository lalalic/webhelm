import { WorkspaceManager } from "./workspace-manager.mjs";
import { ControlChannel } from "./control-channel.mjs";
import { summarizeWorkspaces } from "./workspace-summary.mjs";
import { sessionBadge } from "./session-badge.mjs";

const manager = new WorkspaceManager(chrome);
const control = new ControlChannel(chrome);
const closingWindowIds = new Set();
let badgeTimer = null;

async function refreshBadge() {
  const {connected, sessionCount} = await control.status();
  const badge = sessionBadge({connected, sessionCount});
  await chrome.action.setBadgeText({text: badge.text});
  await chrome.action.setBadgeBackgroundColor({color: badge.color});
  await chrome.action.setTitle({title: badge.title});
}

function scheduleBadge() {
  if (badgeTimer !== null) clearTimeout(badgeTimer);
  badgeTimer = setTimeout(() => {
    badgeTimer = null;
    refreshBadge().catch(error => console.warn("WebHelm badge update failed", error));
  }, 100);
}

const BADGE_ALARM = "webhelm.badge-refresh";
async function scheduleBadgeAlarm() {
  await chrome.alarms.create(BADGE_ALARM, {periodInMinutes: 0.5});
}
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === BADGE_ALARM) scheduleBadge();
});
scheduleBadgeAlarm().catch(error => console.warn("WebHelm badge alarm failed", error));

async function removeLegacyContextMenu() {
  // Legacy release-all operated on extension tabs but did not stop Node Sessions.
  try { await chrome.contextMenus.remove("browser-workspace.release-all"); }
  catch { /* already absent */ }
}

manager.restoreConfiguredWorkspaces()
  .then(scheduleBadge)
  .catch(error => console.warn("WebHelm failed to restore configured workspaces", error));
removeLegacyContextMenu().catch(() => {});
chrome.runtime.onInstalled.addListener(() => {
  removeLegacyContextMenu().catch(() => {});
  scheduleBadge();
});
chrome.runtime.onStartup.addListener(() => {
  removeLegacyContextMenu().catch(() => {});
  scheduleBadge();
});

async function controlRpc(method, args) {
  switch (method) {
    case "workspace.control.status": {
      const state = await control.status();
      const summary = summarizeWorkspaces((await manager.list()).workspaces, state.sessions);
      return {...state,...summary};
    }
    case "workspace.control.requestStop":
      return control.requestStop(args.action, args.sessionId, args.workspace);
    case "workspace.control.heartbeat":
      return control.heartbeat(args.sessions);
    case "workspace.control.poll": {
      const result = await control.poll(args.sessions);
      scheduleBadge();
      return result;
    }
    case "workspace.control.complete":
      return control.complete(args.id, args.response);
    default:
      throw new Error("Unknown workspace control method");
  }
}

globalThis.browserWorkspaceManagerRpc = async (request) => {
  try {
    const method = String(request?.method || "");
    const result = method.startsWith("workspace.control.")
      ? await controlRpc(method, request.args || {})
      : await manager.rpc(request);
    if (["workspace.acquireIdentity", "workspace.acquire", "workspace.release",
         "workspace.releaseAll", "workspace.resize", "workspace.ensure",
         "workspace.delete", "workspace.create"].includes(method)) scheduleBadge();
    return {ok: true, result};
  } catch (error) {
    return {
      ok: false,
      error: {
        message: error?.message || String(error),
        name: error?.name || "Error",
      },
    };
  }
};

// Only the daemon's direct Service Worker RPC may provision, resize, delete,
// or restore Workspace identities. A browser Session on an extension page must
// not gain management rights through chrome.runtime.sendMessage().
const APPLICATION_ONLY_METHODS = new Set([
  "workspace.create", "workspace.resize", "workspace.delete",
  "workspace.ensure", "workspace.migrateDefault",
]);
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (APPLICATION_ONLY_METHODS.has(request?.method)) {
    sendResponse({ok:false,error:{message:"Workspace management requires an application daemon API"}});
    return false;
  }
  if (request?.method?.startsWith("workspace.control.") &&
      (sender?.url !== chrome.runtime.getURL("popup.html") ||
        !["workspace.control.requestStop", "workspace.control.status"].includes(request.method))) {
    sendResponse({ok:false,error:{message:"WebHelm control actions require the toolbar popup"}});
    return false;
  }
  globalThis.browserWorkspaceManagerRpc(request).then(sendResponse);
  return true;
});

chrome.tabs.onCreated.addListener((tab) => {
  manager.inheritWorkspaceForCreatedTab(tab).then(scheduleBadge).catch((error) => {
    console.warn("WebHelm failed to inherit child tab group", error);
  });

  setTimeout(() => {
    manager.reconcileCreatedTab(tab.id).then(scheduleBadge).catch((error) => {
      if (!/No tab with id|Invalid tab ID/i.test(String(error?.message || error))) {
        console.warn("WebHelm failed delayed created-tab reconciliation", error);
      }
    });
  }, 150);
});

chrome.webNavigation.onCreatedNavigationTarget.addListener((details) => {
  manager.inheritNavigationTarget(details).then(scheduleBadge).catch((error) => {
    console.warn("WebHelm failed to inherit navigation target", error);
  });
});

chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.url || Object.prototype.hasOwnProperty.call(changeInfo, "groupId")) scheduleBadge();
  if (!Object.prototype.hasOwnProperty.call(changeInfo, "groupId")) return;
  manager.inheritWorkspaceForCreatedTab(tab).then(scheduleBadge).catch((error) => {
    console.warn("WebHelm failed to reconcile tab group ownership", error);
  });
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  manager.noteActivatedTab(activeInfo).catch((error) => {
    console.warn("WebHelm failed to record active tab context", error);
  });
});

chrome.tabs.onRemoved.addListener((_tabId, removeInfo) => {
  scheduleBadge();
  if (!removeInfo?.isWindowClosing) return;
  closingWindowIds.add(removeInfo.windowId);
  setTimeout(() => closingWindowIds.delete(removeInfo.windowId), 1000);
});

chrome.tabGroups.onRemoved.addListener((group) => {
  // Chrome also emits onRemoved while moving a group between windows, and
  // while a whole window is closing. Defer one turn so a moved group can
  // reappear, and preserve persisted workspaces across normal window closes.
  setTimeout(() => {
    if (closingWindowIds.has(group.windowId)) return;
    manager.removeDeletedGroup(group).then(scheduleBadge).catch((error) => {
      console.warn("WebHelm failed to remove deleted workspace", error);
    });
  }, 100);
});
