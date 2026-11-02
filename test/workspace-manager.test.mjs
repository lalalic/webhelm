import assert from "node:assert/strict";
import test from "node:test";

import { WorkspaceManager } from "../runtime/extension/workspace-manager.mjs";

function fakeChrome() {
  let nextTabId = 1;
  let nextGroupId = 100;
  const tabs = new Map();
  const groups = new Map();
  const storage = {};

  const clone = (value) =>
    value === undefined ? undefined : JSON.parse(JSON.stringify(value));

  const api = {
    runtime: {
      getURL(path) {
        return `chrome-extension://test-extension/${path}`;
      },
    },
    storage: {
      local: {
        async get(key) {
          return { [key]: clone(storage[key]) };
        },
        async set(values) {
          Object.assign(storage, clone(values));
        },
      },
    },
    tabs: {
      async query(query = {}) {
        let values = [...tabs.values()];
        if (Number.isInteger(query.groupId)) {
          values = values.filter((tab) => tab.groupId === query.groupId);
        }
        if (Number.isInteger(query.windowId)) values = values.filter(tab => tab.windowId === query.windowId);
        return values.sort((a,b) => a.index-b.index).map(clone);
      },
      async get(tabId) {
        const tab = tabs.get(tabId);
        if (!tab) throw new Error(`Unknown tab ${tabId}`);
        return clone(tab);
      },
      async create(options) {
        const tab = {
          id: nextTabId++,
          groupId: -1,
          windowId: Number.isInteger(options.windowId) ? options.windowId : 1,
          pinned: Boolean(options.pinned),
          index: [...tabs.values()].filter(t => t.windowId === (options.windowId ?? 1)).length,
          title: "Browser Workspace",
          url: options.url || "about:blank",
          active: Boolean(options.active),
          ...(Number.isInteger(options.openerTabId) ? { openerTabId: options.openerTabId } : {}),
        };
        tabs.set(tab.id, tab);
        return clone(tab);
      },
      async group(options) {
        const groupId = Number.isInteger(options.groupId)
          ? options.groupId
          : nextGroupId++;
        if (!groups.has(groupId)) {
          groups.set(groupId, {
            id: groupId,
            title: "",
            collapsed: false,
          });
        }
        for (const tabId of options.tabIds || []) {
          tabs.get(tabId).groupId = groupId;
        }
        return groupId;
      },
      async ungroup(tabIds) {
        for (const tabId of Array.isArray(tabIds) ? tabIds : [tabIds]) {
          const tab = tabs.get(tabId);
          if (tab) tab.groupId = -1;
        }
      },
      async update(tabId, options) {
        const tab = tabs.get(tabId);
        if (!tab) throw new Error(`Unknown tab ${tabId}`);
        if (options.url !== undefined) tab.url = options.url;
        if (options.active !== undefined) tab.active = Boolean(options.active);
        return clone(tab);
      },
      async remove(tabIds) {
        for (const tabId of Array.isArray(tabIds) ? tabIds : [tabIds]) {
          tabs.delete(tabId);
        }
      },
    },
    tabGroups: {
      async query() {
        return [...groups.values()].map(clone);
      },
      async move(groupId, options) {
        const grouped = [...tabs.values()].filter(t => t.groupId === groupId).sort((a,b)=>a.index-b.index);
        if (!grouped.length) throw Error('Unknown group');
        const windowId = grouped[0].windowId;
        const inWindow = [...tabs.values()].filter(t => t.windowId === windowId).sort((a,b)=>a.index-b.index);
        const other = inWindow.filter(t => t.groupId !== groupId);
        const firstUnpinned = other.filter(t => t.pinned).length;
        if (options.index < firstUnpinned) throw Error('Pinned tabs must precede groups');
        other.splice(options.index,0,...grouped);
        other.forEach((tab,index)=>{tab.index=index});
        return clone(groups.get(groupId));
      },
      async update(groupId, options) {
        const group = groups.get(groupId) || {
          id: groupId,
          title: "",
          collapsed: false,
        };
        Object.assign(group, options);
        groups.set(groupId, group);
        return clone(group);
      },
    },
    __dropEmptyGroups() {
      for (const groupId of [...groups.keys()]) {
        if (![...tabs.values()].some((tab) => tab.groupId === groupId)) {
          groups.delete(groupId);
        }
      }
    },
    __moveGroup(oldGroupId, newGroupId) {
      const group = groups.get(oldGroupId);
      if (!group) throw new Error("group missing");
      groups.delete(oldGroupId);
      groups.set(newGroupId, { ...group, id: newGroupId });
      for (const tab of tabs.values()) {
        if (tab.groupId === oldGroupId) tab.groupId = newGroupId;
      }
    },
    __duplicateGroupTitle(title) {
      groups.set(nextGroupId++, {
        id: nextGroupId,
        title,
        collapsed: true,
      });
    },
    __setTab(tabId, patch) {
      const tab = tabs.get(tabId);
      if (!tab) throw new Error("Unknown tab " + tabId);
      Object.assign(tab, clone(patch));
    },
  };

  return api;
}

test("pool size is a maximum and acquire grows the pool lazily", async () => {
  const chrome = fakeChrome();
  const manager = new WorkspaceManager(chrome);

  const state = await manager.create("MDB", 4);
  assert.equal(state.poolSize, 4);
  assert.equal(state.tabIds.length, 1);
  assert.equal(state.idleTabIds.length, 1);
  assert.equal(state.leasedTabIds.length, 0);

  const leased = await manager.acquire("MDB", "https://example.com/");
  assert.ok(state.tabIds.includes(leased.tabId));

  const active = await manager.status("MDB");
  assert.equal(active.tabIds.length, 1);
  assert.equal(active.idleTabIds.length, 0);
  assert.equal(active.leasedTabIds.length, 1);

  await manager.release("MDB", leased.tabId);
  const released = await manager.status("MDB");
  assert.equal(released.tabIds.length, 1);
  assert.equal(released.idleTabIds.length, 1);

  const second = await manager.acquire("MDB", "https://example.com/second");
  assert.equal(second.tabId, leased.tabId);
  const grown = await manager.acquire("MDB", "https://example.com/third");
  assert.notEqual(grown.tabId, leased.tabId);
  assert.equal((await manager.status("MDB")).tabIds.length, 2);
});

test("acquireIdentity exposes tabId through controlled lease page", async () => {
  const chrome = fakeChrome();
  const manager = new WorkspaceManager(chrome);

  await manager.create("Harness", 2);
  const leased = await manager.acquireIdentity("Harness");

  assert.equal(leased.identityTitle, `__WEBHELM_TAB_${leased.tabId}__`);
  assert.match(leased.identityUrl, /helm\.html\?/);
  assert.match(leased.identityUrl, /role=lease/);
  assert.match(leased.identityUrl, new RegExp(`tabId=${leased.tabId}(?:&|$)`));

  const state = await manager.status("Harness");
  assert.deepEqual(state.leasedTabIds, [leased.tabId]);
});

test("multiple workspaces have independent exact pool sizes", async () => {
  const chrome = fakeChrome();
  const manager = new WorkspaceManager(chrome);

  const alpha = await manager.create("Alpha", 2);
  const beta = await manager.create("Beta", 3);

  assert.equal(alpha.tabIds.length, 1);
  assert.equal(beta.tabIds.length, 1);
  assert.notEqual(alpha.groupId, beta.groupId);

  const resized = await manager.resize("Beta", 1);
  assert.equal(resized.poolSize, 1);
  assert.equal(resized.tabIds.length, 1);
});

test("create is idempotent and resizes an existing workspace", async () => {
  const chrome = fakeChrome();
  const manager = new WorkspaceManager(chrome);

  const initial = await manager.create("Relay", 3);
  const same = await manager.create("Relay", 3);
  const resized = await manager.create("Relay", 6);

  assert.equal(initial.groupId, same.groupId);
  assert.equal(resized.groupId, initial.groupId);
  assert.equal(resized.poolSize, 6);
  assert.equal(resized.maxCapacity, 6);
});

test("delete rejects leased tabs unless forced and removes persisted workspace", async () => {
  const chrome = fakeChrome();
  const manager = new WorkspaceManager(chrome);

  await manager.create("Relay");
  const leased = await manager.acquire("Relay", "https://example.com/");
  await assert.rejects(
    () => manager.delete("Relay"),
    /has 1 leased tabs/,
  );

  const deleted = await manager.delete("Relay", true);
  assert.deepEqual(deleted, { name: "Relay", deleted: true });
  assert.equal((await manager.status("Relay")).initialized, false);
  assert.equal((await manager.list()).workspaces.length, 0);
  await assert.rejects(
    () => chrome.tabs.get(leased.tabId),
    /Unknown tab/,
  );
});

test("Chrome group deletion removes the persisted workspace", async () => {
  const chrome = fakeChrome();
  const manager = new WorkspaceManager(chrome);

  const workspace = await manager.create("Relay", 3);
  await chrome.tabs.remove(workspace.tabIds);
  chrome.__dropEmptyGroups();

  assert.deepEqual(
    await manager.removeDeletedGroup({ id: workspace.groupId, title: "Relay" }),
    { name: "Relay", deleted: true },
  );
  assert.equal((await manager.status("Relay")).initialized, false);
  assert.equal((await manager.list()).workspaces.length, 0);
});

test("Chrome group move does not remove persisted workspace", async () => {
  const chrome = fakeChrome();
  const manager = new WorkspaceManager(chrome);

  const workspace = await manager.create("Relay", 3);
  chrome.__moveGroup(workspace.groupId, 777);

  assert.equal(
    await manager.removeDeletedGroup({ id: workspace.groupId, title: "Relay" }),
    null,
  );
  assert.equal((await manager.status("Relay")).initialized, true);
});

test("workspace identity survives groupId changes via unique group title", async () => {
  const chrome = fakeChrome();
  const manager = new WorkspaceManager(chrome);

  const before = await manager.create("Research", 2);
  chrome.__moveGroup(before.groupId, 777);

  const after = await manager.status("Research");
  assert.equal(after.initialized, true);
  assert.equal(after.groupId, 777);
  assert.equal(after.tabIds.length, 1);
});

test("duplicate workspace titles fail closed", async () => {
  const chrome = fakeChrome();
  const manager = new WorkspaceManager(chrome);

  await manager.create("Research", 2);
  chrome.__duplicateGroupTitle("Research");

  await assert.rejects(
    () => manager.status("Research"),
    /ambiguous/,
  );
});



test("workspace can lease a chrome-extension page inside the existing group", async () => {
  const chrome = fakeChrome();
  const manager = new WorkspaceManager(chrome);

  const state = await manager.create("Harness", 5);
  const leased = await manager.acquire(
    "Harness",
    "chrome-extension://teammate/main.html",
  );

  assert.equal(leased.groupId, state.groupId);
  const after = await manager.status("Harness");
  assert.equal(after.tabIds.length, 1);
  assert.ok(after.tabs.some((tab) => tab.url === "chrome-extension://teammate/main.html"));
});

test("delayed native grouping ejects an unowned user tab", async () => {
  const chrome = fakeChrome();
  const manager = new WorkspaceManager(chrome);

  const workspace = await manager.create("Harness", 5);
  const userTab = await chrome.tabs.create({ url: "chrome://newtab/", active: true });

  chrome.__setTab(userTab.id, { groupId: workspace.groupId });
  const result = await manager.reconcileCreatedTab(userTab.id);

  assert.equal(result.releasedUnexpected, true);
  assert.equal((await chrome.tabs.get(userTab.id)).groupId, -1);
});

test("acquire keeps a newly-created owned tab grouped during reconciliation race", async () => {
  const chrome = fakeChrome();
  const manager = new WorkspaceManager(chrome);

  await manager.create("Harness", 2);
  await manager.acquire("Harness", "https://example.com/first");

  const originalGroup = chrome.tabs.group.bind(chrome.tabs);
  chrome.tabs.group = async (options) => {
    const groupId = await originalGroup(options);
    const tabId = options.tabIds?.[0];
    if (Number.isInteger(options.groupId) && Number.isInteger(tabId)) {
      const before = await chrome.tabs.get(tabId);
      chrome.__setTab(tabId, { url: "about:blank" });
      await manager.reconcileCreatedTab(tabId);
      chrome.__setTab(tabId, { url: before.url });
    }
    return groupId;
  };

  const leased = await manager.acquire("Harness", "https://example.com/second");
  const state = await manager.status("Harness");

  assert.equal((await chrome.tabs.get(leased.tabId)).groupId, state.groupId);
  assert.ok(state.tabIds.includes(leased.tabId));
});

test("closing a workspace tab does not eagerly recreate it", async () => {
  const chrome = fakeChrome();
  const manager = new WorkspaceManager(chrome);

  await manager.create("Harness");
  const leased = await manager.acquire("Harness", "https://example.com/");
  await chrome.tabs.remove(leased.tabId);

  const afterClose = await manager.status("Harness");
  assert.equal(afterClose.physicalTabs, 0);
  assert.equal(afterClose.leased, 0);

  const replacement = await manager.acquire("Harness", "https://example.com/replacement");
  assert.equal((await manager.status("Harness")).physicalTabs, 1);
  assert.equal(replacement.url, "https://example.com/replacement");
});

test("Chrome-created unrelated tab is removed from a configured workspace group", async () => {
  const chrome = fakeChrome();
  const manager = new WorkspaceManager(chrome);

  const state = await manager.create("Harness", 5);
  const unrelated = await chrome.tabs.create({ url: "chrome://newtab/" });
  await chrome.tabs.group({ groupId: state.groupId, tabIds: [unrelated.id] });
  const grouped = await chrome.tabs.get(unrelated.id);

  assert.deepEqual(await manager.inheritWorkspaceForCreatedTab(grouped), {
    workspace: "Harness",
    groupId: state.groupId,
    tabId: unrelated.id,
    releasedUnexpected: true,
  });
  assert.equal((await chrome.tabs.get(unrelated.id)).groupId, -1);
});

test("inactive tabs are not reclaimed by the Extension and explicit release returns idle", async () => {
  const chrome = fakeChrome();
  const manager = new WorkspaceManager(chrome);
  await manager.create("Harness");
  const leased = await manager.acquireIdentity("Harness");
  chrome.__setTab(leased.tabId, { lastAccessed: 1, active: false });
  assert.equal(typeof manager.reclaimStaleTabs, "undefined");
  assert.equal((await manager.status("Harness")).leased, 1);
  assert.equal(leased.idleUrl, chrome.runtime.getURL(`helm.html?workspace=Harness&role=idle`));
  await manager.release("Harness", leased.tabId);
  assert.equal((await manager.status("Harness")).idle, 1);
});

test("acquire exhausts at max capacity and reports allocatable slots", async () => {
  const chrome = fakeChrome();
  const manager = new WorkspaceManager(chrome);

  await manager.create("Harness", 2);
  const first = await manager.acquire("Harness", "https://example.com/one");
  const second = await manager.acquire("Harness", "https://example.com/two");
  const full = await manager.status("Harness");
  assert.equal(full.physicalTabs, 2);
  assert.equal(full.idle, 0);
  assert.equal(full.leased, 2);
  assert.equal(full.maxCapacity - full.leased, 0);
  assert.notEqual(first.tabId, second.tabId);
  await assert.rejects(
    () => manager.acquire("Harness", "https://example.com/three"),
    /pool is exhausted at size 2/,
  );
});

test("restoreConfiguredWorkspaces recreates missing groups from config", async () => {
  const chrome = fakeChrome();
  const manager = new WorkspaceManager(chrome);

  await manager.create("Harness", 5);
  await manager.create("Tutor", 3);

  const harnessBefore = await manager.status("Harness");
  const tutorBefore = await manager.status("Tutor");
  await chrome.tabs.remove(harnessBefore.tabIds);
  await chrome.tabs.remove(tutorBefore.tabIds);

  // Simulate Chrome dropping empty tab groups after an extension reload.
  chrome.__dropEmptyGroups?.();

  const restored = await manager.restoreConfiguredWorkspaces();
  assert.equal(restored.workspaces.length, 2);

  const harness = await manager.status("Harness");
  const tutor = await manager.status("Tutor");
  assert.equal(harness.initialized, true);
  assert.equal(tutor.initialized, true);
  assert.equal(harness.idle, 1);
  assert.equal(tutor.idle, 1);
});

test("releaseAll releases every leased tab across workspaces", async () => {
  const chrome = fakeChrome();
  const manager = new WorkspaceManager(chrome);

  await manager.create("Harness");
  await manager.create("Research");
  const a1 = await manager.acquire("Harness", "https://example.com/a1");
  const a2 = await manager.acquire("Harness", "https://example.com/a2");
  const b1 = await manager.acquire("Research", "https://example.com/b1");

  const result = await manager.releaseAll();
  assert.equal(result.releasedCount, 3);
  assert.deepEqual(
    new Set(result.released.map((item) => item.tabId)),
    new Set([a1.tabId, a2.tabId, b1.tabId]),
  );

  const harness = await manager.status("Harness");
  const research = await manager.status("Research");
  assert.equal(harness.leased, 0);
  assert.equal(research.leased, 0);
  assert.equal(harness.idle, 2);
  assert.equal(research.idle, 1);
});

test("workspace still rejects unsupported URL schemes", async () => {
  const chrome = fakeChrome();
  const manager = new WorkspaceManager(chrome);

  await manager.create("Harness", 2);
  await assert.rejects(
    () => manager.acquire("Harness", "file:///tmp/test.html"),
    /http\(s\) or chrome-extension/,
  );
});

test("webNavigation target inherits ownership from an owned source tab", async () => {
  const chrome = fakeChrome();
  const manager = new WorkspaceManager(chrome);

  await manager.create("Harness");
  const source = await manager.acquire("Harness", "https://news.sina.com.cn/china/");
  const target = await chrome.tabs.create({
    url: "https://news.sina.com.cn/c/target-blank.shtml",
  });

  assert.deepEqual(
    await manager.inheritNavigationTarget({
      sourceTabId: source.tabId,
      tabId: target.id,
    }),
    {
      workspace: "Harness",
      groupId: source.groupId,
      tabId: target.id,
      sourceTabId: source.tabId,
      adoptionReason: "navigation-target",
    },
  );
  assert.equal((await chrome.tabs.get(target.id)).groupId, source.groupId);
});

test("webNavigation target from an unowned source is not adopted", async () => {
  const chrome = fakeChrome();
  const manager = new WorkspaceManager(chrome);

  await manager.create("Harness", 5);
  const source = await chrome.tabs.create({ url: "https://example.com/" });
  const target = await chrome.tabs.create({ url: "https://example.com/child" });

  assert.equal(
    await manager.inheritNavigationTarget({
      sourceTabId: source.id,
      tabId: target.id,
    }),
    null,
  );
  assert.equal((await chrome.tabs.get(target.id)).groupId, -1);
});

test("child tab inherits workspace group and consumes an idle pool slot", async () => {
  const chrome = fakeChrome();
  const manager = new WorkspaceManager(chrome);

  const state = await manager.create("Harness", 5);
  const leased = await manager.acquire("Harness", "https://teams.cloud.microsoft/");
  const child = await chrome.tabs.create({
    url: "chrome-extension://teammate/main.html",
    active: false,
    openerTabId: leased.tabId,
  });

  const inherited = await manager.inheritWorkspaceForCreatedTab(child);
  assert.deepEqual(inherited, {
    workspace: "Harness",
    groupId: state.groupId,
    tabId: child.id,
    inheritedFromTabId: leased.tabId,
    workspaceAncestorTabId: leased.tabId,
  });

  const after = await manager.status("Harness");
  assert.equal(after.tabIds.length, 2);
  assert.ok(after.tabIds.includes(child.id));
  assert.equal(after.idleTabIds.length, 0);
  assert.equal(after.leasedTabIds.length, 2);
});


test("ordinary web child tab inherits workspace from its opener", async () => {
  const chrome = fakeChrome();
  const manager = new WorkspaceManager(chrome);

  const state = await manager.create("Harness", 5);
  const leased = await manager.acquire("Harness", "chrome-extension://teammate/main.html");
  const teams = await chrome.tabs.create({
    url: "https://teams.cloud.microsoft/",
    openerTabId: leased.tabId,
  });

  assert.deepEqual(await manager.inheritWorkspaceForCreatedTab(teams), {
    workspace: "Harness",
    groupId: state.groupId,
    tabId: teams.id,
    inheritedFromTabId: leased.tabId,
    workspaceAncestorTabId: leased.tabId,
  });
  const after = await manager.status("Harness");
  assert.ok(after.tabIds.includes(teams.id));
});

test("grandchild inherits workspace through opener ancestry", async () => {
  const chrome = fakeChrome();
  const manager = new WorkspaceManager(chrome);

  const state = await manager.create("Harness", 5);
  const root = await manager.acquire("Harness", "https://example.com/root");
  const child = await chrome.tabs.create({
    url: "https://example.com/child",
    openerTabId: root.tabId,
  });
  const grandchild = await chrome.tabs.create({
    url: "https://example.com/grandchild",
    openerTabId: child.id,
  });

  const inherited = await manager.inheritWorkspaceForCreatedTab(grandchild);
  assert.deepEqual(inherited, {
    workspace: "Harness",
    groupId: state.groupId,
    tabId: grandchild.id,
    inheritedFromTabId: child.id,
    workspaceAncestorTabId: root.tabId,
  });
  const after = await manager.status("Harness");
  assert.ok(after.tabIds.includes(grandchild.id));
});

test("tab opened outside a workspace is not adopted", async () => {
  const chrome = fakeChrome();
  const manager = new WorkspaceManager(chrome);

  await manager.create("Harness", 5);
  const outside = await chrome.tabs.create({ url: "https://example.com/" });
  const child = await chrome.tabs.create({
    url: "chrome-extension://teammate/setup.html",
    openerTabId: outside.id,
  });

  assert.equal(await manager.inheritWorkspaceForCreatedTab(child), null);
  assert.equal(child.groupId, -1);
});


test("extension page opened from chrome://extensions is adopted into the unique workspace", async () => {
  const chrome = fakeChrome();
  const manager = new WorkspaceManager(chrome);

  const state = await manager.create("Harness", 5);
  const extensions = await chrome.tabs.create({
    url: "chrome://extensions/",
    active: true,
  });
  const setup = await chrome.tabs.create({
    url: "chrome-extension://teammate/setup.html",
    active: true,
    openerTabId: extensions.id,
  });

  assert.deepEqual(await manager.inheritWorkspaceForCreatedTab(setup), {
    workspace: "Harness",
    groupId: state.groupId,
    tabId: setup.id,
    inheritedFromTabId: extensions.id,
    workspaceAncestorTabId: extensions.id,
    adoptionReason: "extension-management-opener",
  });
});

test("extension page without opener uses recent chrome://extensions activation", async () => {
  const chrome = fakeChrome();
  const manager = new WorkspaceManager(chrome);

  const state = await manager.create("Harness", 5);
  const extensions = await chrome.tabs.create({
    url: "chrome://extensions/",
    active: true,
    windowId: 7,
  });
  await manager.noteActivatedTab({ tabId: extensions.id, windowId: 7 }, Date.now());

  const setup = await chrome.tabs.create({
    url: "chrome-extension://teammate/setup.html",
    active: true,
    windowId: 7,
  });
  assert.deepEqual(await manager.inheritWorkspaceForCreatedTab(setup), {
    workspace: "Harness",
    groupId: state.groupId,
    tabId: setup.id,
    inheritedFromTabId: null,
    workspaceAncestorTabId: null,
    adoptionReason: "recent-extension-management",
  });
});

test("extension page without install context is not adopted", async () => {
  const chrome = fakeChrome();
  const manager = new WorkspaceManager(chrome);

  await manager.create("Harness", 5);
  const setup = await chrome.tabs.create({
    url: "chrome-extension://teammate/setup.html",
    active: true,
  });

  assert.equal(await manager.inheritWorkspaceForCreatedTab(setup), null);
  assert.equal(setup.groupId, -1);
});

test("extension install fallback fails closed when multiple workspaces are configured", async () => {
  const chrome = fakeChrome();
  const manager = new WorkspaceManager(chrome);

  await manager.create("Harness", 5);
  await manager.create("Research", 5);
  const extensions = await chrome.tabs.create({
    url: "chrome://extensions/",
    active: true,
  });
  const setup = await chrome.tabs.create({
    url: "chrome-extension://teammate/setup.html",
    active: true,
    openerTabId: extensions.id,
  });

  assert.equal(await manager.inheritWorkspaceForCreatedTab(setup), null);
  assert.equal(setup.groupId, -1);
});

test("default Harness migration renames only an idle legacy group and keeps tab identity", async()=>{
  const chrome=fakeChrome(),manager=new WorkspaceManager(chrome);
  const before=await manager.create("Harness",4);
  await manager.create("Custom",2);
  const originalId=before.tabIds[0];
  const migrated=await manager.migrateDefaultWorkspace();
  assert.deepEqual(migrated,{name:"WebHelm",migrated:true,migratedTabs:1});
  const current=await manager.status("WebHelm");
  assert.equal(current.initialized,true);
  assert.equal(current.groupId,before.groupId);
  assert.deepEqual(current.tabIds,[originalId]);
  assert.match(current.tabs[0].url,/helm\.html\?workspace=WebHelm&role=idle/);
  assert.equal((await manager.status("Harness")).initialized,false);
  assert.equal((await manager.status("Custom")).initialized,true);
  const leased=await manager.acquireIdentity("WebHelm");
  assert.match(leased.identityUrl,/helm\.html\?workspace=WebHelm&role=lease/);
  await manager.release("WebHelm",leased.tabId);
  const released=await chrome.tabs.get(originalId);
  assert.match(released.url,/helm\.html\?workspace=WebHelm&role=idle/);
});

test("default migration defers on live leases and on session count", async()=>{
  const chrome=fakeChrome(),manager=new WorkspaceManager(chrome);
  await manager.create("Harness",3);
  assert.deepEqual(await manager.migrateDefaultWorkspace(1),{name:"Harness",deferred:"active-sessions"});
  const lease=await manager.acquireIdentity("Harness");
  assert.deepEqual(await manager.migrateDefaultWorkspace(),{name:"Harness",deferred:"leased-tabs"});
  assert.equal((await manager.status("Harness")).initialized,true);
  await manager.release("Harness",lease.tabId);
  const result=await manager.migrateDefaultWorkspace();
  assert.equal(result.migrated,true);
  assert.equal((await manager.status("WebHelm")).initialized,true);
});

test("migration never overwrites an existing custom WebHelm group",async()=>{
  const chrome=fakeChrome(),manager=new WorkspaceManager(chrome);
  await manager.create("Harness",4);
  const webhelm=await manager.create("WebHelm",3);
  const result=await manager.migrateDefaultWorkspace();
  assert.equal(result.legacyPreserved,true);
  assert.equal((await manager.status("Harness")).initialized,true);
  assert.equal((await manager.status("WebHelm")).groupId,webhelm.groupId);
});

test("legacy extension URL remains managed and releasable during migration",async()=>{
  const chrome=fakeChrome(),manager=new WorkspaceManager(chrome);
  const group=await manager.create("Harness",3);
  const id=group.tabIds[0];
  await chrome.tabs.update(id,{url:chrome.runtime.getURL("workspace.html?workspace=Harness&role=idle")});
  assert.equal((await manager.status("Harness")).idle,1);
  const lease=await manager.acquireIdentity("Harness");
  await manager.release("Harness",lease.tabId);
  assert.equal((await manager.status("Harness")).idle,1);
});

test('independent leased tab IDs return to identical idle URLs without losing ownership', async()=>{
  const chrome=fakeChrome(),manager=new WorkspaceManager(chrome);
  await manager.create('WebHelm');
  const a=await manager.acquireIdentity('WebHelm');
  const b=await manager.acquireIdentity('WebHelm');
  assert.notEqual(a.tabId,b.tabId);
  assert.notEqual(a.identityUrl,b.identityUrl);
  assert.equal(a.idleUrl,b.idleUrl);
  assert.equal(a.idleUrl,chrome.runtime.getURL('helm.html?workspace=WebHelm&role=idle'));
  assert.match(a.identityUrl,new RegExp('tabId='+a.tabId+'(?:&|$)'));
  assert.match(b.identityUrl,new RegExp('tabId='+b.tabId+'(?:&|$)'));
  await manager.release('WebHelm',a.tabId);
  await manager.release('WebHelm',b.tabId);
  const state=await manager.status('WebHelm');
  assert.equal(state.leased,0);
  assert.equal(state.idle,2);
});

test("new default WebHelm group moves immediately after pinned tabs", async () => {
  const chrome = fakeChrome();
  const pinned = await chrome.tabs.create({url:"https://pinned.test",pinned:true});
  const other = await chrome.tabs.create({url:"https://other.test"});
  const custom = await chrome.tabs.create({url:"https://custom.test"});
  const manager = new WorkspaceManager(chrome);
  const created = await manager.create("WebHelm",3);
  const [tab] = await chrome.tabs.query({groupId:created.groupId});
  assert.equal(tab.index,1);
  assert.deepEqual((await chrome.tabs.query({windowId:1})).map(t=>t.id),
    [pinned.id, tab.id, other.id, custom.id]);
  assert.equal((await manager.status("WebHelm")).collapsed,true);
});

test("routine Session acquisition does not undo user's manual group order; restore does", async () => {
  const chrome=fakeChrome(),manager=new WorkspaceManager(chrome);
  await chrome.tabs.create({url:"https://before.test"});
  const group=await manager.create("WebHelm",3);
  const groupTab=group.tabIds[0];
  await chrome.tabGroups.move(group.groupId,{index:1});
  assert.equal((await chrome.tabs.get(groupTab)).index,1);
  await manager.ensureWorkspace("WebHelm");
  const lease=await manager.acquireIdentity("WebHelm");
  await manager.release("WebHelm",lease.tabId);
  assert.equal((await chrome.tabs.get(groupTab)).index,1);
  await manager.restoreConfiguredWorkspaces();
  assert.equal((await chrome.tabs.get(groupTab)).index,0);
});

test("custom workspace creation and restoration never move the default WebHelm group", async () => {
  const chrome=fakeChrome(),manager=new WorkspaceManager(chrome);
  const a=await manager.create("WebHelm");
  const b=await manager.create("Custom");
  assert.equal((await chrome.tabs.get(a.tabIds[0])).index,0);
  assert.equal((await chrome.tabs.get(b.tabIds[0])).index,1);
  await manager.restoreConfiguredWorkspaces();
  assert.equal((await chrome.tabs.get(a.tabIds[0])).index,0);
});

test("legacy Harness migration positions the renamed default group at the front", async () => {
  const chrome=fakeChrome(),manager=new WorkspaceManager(chrome);
  await chrome.tabs.create({url:"https://existing.test"});
  const harness=await manager.create("Harness");
  assert.equal((await chrome.tabs.get(harness.tabIds[0])).index,1);
  const migrated=await manager.migrateDefaultWorkspace();
  assert.equal(migrated.migrated,true);
  assert.equal((await chrome.tabs.get(harness.tabIds[0])).index,0);
  assert.equal((await manager.status("WebHelm")).groupId,harness.groupId);
});

test('agent lease never creates an unknown or missing app Workspace', async()=>{
  const chrome=fakeChrome(),manager=new WorkspaceManager(chrome);
  const before=(await manager.list()).workspaces;
  assert.deepEqual(before,[]);
  await assert.rejects(()=>manager.acquireIdentity('VlogMusic'),/does not exist/);
  await assert.rejects(()=>manager.acquire('VlogMusic','https://example.com'),/does not exist/);
  assert.deepEqual((await manager.list()).workspaces,[]);
  await manager.create('Neo',4);
  await assert.rejects(()=>manager.acquireIdentity('VlogMusic'),/does not exist/);
  const lease=await manager.acquireIdentity('Neo');
  assert.equal(lease.workspace,'Neo');
  await manager.release('Neo',lease.tabId);
});
