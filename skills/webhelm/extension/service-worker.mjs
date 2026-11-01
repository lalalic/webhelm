import { WorkspaceManager } from "./workspace-manager.mjs";

const manager = new WorkspaceManager(chrome);
const closingWindowIds = new Set();


manager.restoreConfiguredWorkspaces().catch((error) => {
  console.warn("Browser Workspace failed to restore configured workspaces", error);
});

const RELEASE_ALL_MENU_ID = "browser-workspace.release-all";

async function ensureContextMenus() {
  try {
    await chrome.contextMenus.remove(RELEASE_ALL_MENU_ID);
  } catch {
    // Menu does not exist yet.
  }
  chrome.contextMenus.create({
    id: RELEASE_ALL_MENU_ID,
    title: "Release all tabs",
    contexts: ["action"],
  });
}

chrome.runtime.onInstalled.addListener(() => {
  ensureContextMenus().catch((error) => {
    console.warn("Browser Workspace failed to create extension menu", error);
  });
});

chrome.runtime.onStartup.addListener(() => {
  ensureContextMenus().catch((error) => {
    console.warn("Browser Workspace failed to create extension menu", error);
  });
});

ensureContextMenus().catch((error) => {
  console.warn("Browser Workspace failed to initialize extension menu", error);
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId !== RELEASE_ALL_MENU_ID) return;
  manager.releaseAll().catch((error) => {
    console.warn("Browser Workspace failed to release all tabs", error);
  });
});

globalThis.browserWorkspaceManagerRpc = async (request) => {
  try {
    return { ok: true, result: await manager.rpc(request) };
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

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  globalThis.browserWorkspaceManagerRpc(request).then(sendResponse);
  return true;
});

chrome.tabs.onCreated.addListener((tab) => {
  manager.inheritWorkspaceForCreatedTab(tab).catch((error) => {
    console.warn("Browser Workspace failed to inherit child tab group", error);
  });

  setTimeout(() => {
    manager.reconcileCreatedTab(tab.id).catch((error) => {
      if (!/No tab with id|Invalid tab ID/i.test(String(error?.message || error))) {
        console.warn("Browser Workspace failed delayed created-tab reconciliation", error);
      }
    });
  }, 150);
});

chrome.webNavigation.onCreatedNavigationTarget.addListener((details) => {
  manager.inheritNavigationTarget(details).catch((error) => {
    console.warn("Browser Workspace failed to inherit navigation target", error);
  });
});

chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (!Object.prototype.hasOwnProperty.call(changeInfo, "groupId")) return;
  manager.inheritWorkspaceForCreatedTab(tab).catch((error) => {
    console.warn("Browser Workspace failed to reconcile tab group ownership", error);
  });
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  manager.noteActivatedTab(activeInfo).catch((error) => {
    console.warn("Browser Workspace failed to record active tab context", error);
  });
});

chrome.tabs.onRemoved.addListener((_tabId, removeInfo) => {
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
    manager.removeDeletedGroup(group).catch((error) => {
      console.warn("Browser Workspace failed to remove deleted workspace", error);
    });
  }, 100);
});
