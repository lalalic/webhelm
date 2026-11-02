const STORAGE_KEY = "browserWorkspaceManager.v1";
const MIN_POOL_SIZE = 1;
const MAX_POOL_SIZE = 64;
const EXTENSION_MANAGEMENT_RECENCY_MS = 15_000;

export function normalizeWorkspaceName(value) {
  const name = String(value || "").trim();
  if (!name) throw new Error("Workspace name is required");
  if (name.length > 80) throw new Error("Workspace name must be at most 80 characters");
  return name;
}

export function normalizePoolSize(value, fallback = 8) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < MIN_POOL_SIZE || number > MAX_POOL_SIZE) {
    throw new Error(`Pool size must be an integer between ${MIN_POOL_SIZE} and ${MAX_POOL_SIZE}`);
  }
  return number;
}

function queryString(workspace, slot) {
  return new URLSearchParams({ workspace, role: "idle", slot: String(slot) }).toString();
}

export class WorkspaceManager {
  constructor(chromeApi) {
    this.chrome = chromeApi;
    this.recentExtensionManagementByWindow = new Map();
    this.ownedTabIds = new Set();
  }

  isOwnedTab(tab) {
    const tabId = Number(tab?.id);
    if (Number.isInteger(tabId) && this.ownedTabIds.has(tabId)) return true;
    const meta = this.parseManagedUrl(this.tabUrl(tab));
    return Boolean(meta?.workspace);
  }

  markOwned(tabId) {
    const id = Number(tabId);
    if (Number.isInteger(id)) this.ownedTabIds.add(id);
  }

  idleUrl(workspace, slot) {
    return this.chrome.runtime.getURL(`helm.html?${queryString(workspace, slot)}`);
  }

  identityTitle(tabId) {
    return `__WEBHELM_TAB_${tabId}__`;
  }

  identityUrl(workspace, tabId) {
    const query = new URLSearchParams({
      workspace,
      role: "lease",
      slot: String(tabId),
    }).toString();
    return this.chrome.runtime.getURL(`helm.html?${query}`);
  }

  parseManagedUrl(url) {
    try {
      const parsed = new URL(url);
      const own = new URL(this.chrome.runtime.getURL("helm.html"));
      if (parsed.origin !== own.origin ||
          !["/helm.html", "/workspace.html"].includes(parsed.pathname)) return null;
      return {
        workspace: parsed.searchParams.get("workspace") || "",
        role: parsed.searchParams.get("role") || "",
        slot: parsed.searchParams.get("slot") || "",
      };
    } catch {
      return null;
    }
  }

  async loadConfig() {
    const stored = (await this.chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
    return stored && typeof stored === "object" ? stored : { workspaces: {} };
  }

  async saveConfig(config) {
    await this.chrome.storage.local.set({ [STORAGE_KEY]: config });
  }

  async configuredWorkspace(name) {
    const config = await this.loadConfig();
    return { config, entry: config.workspaces[name] || null };
  }

  async setPoolSize(name, poolSize) {
    const { config, entry } = await this.configuredWorkspace(name);
    config.workspaces[name] = { ...(entry || {}), poolSize };
    await this.saveConfig(config);
  }

  async removeConfig(name) {
    const config = await this.loadConfig();
    delete config.workspaces[name];
    await this.saveConfig(config);
  }

  async removeDeletedGroup(group) {
    const name = String(group?.title || "").trim();
    if (!name) return null;

    const { entry } = await this.configuredWorkspace(name);
    if (!entry) return null;

    const remaining = await this.workspaceGroup(name);
    if (remaining) return null;

    await this.removeConfig(name);
    return { name, deleted: true };
  }

  async workspaceGroup(name) {
    const groups = await this.chrome.tabGroups.query({});
    const matches = groups.filter((group) => group.title === name);
    if (matches.length > 1) {
      throw new Error(`Workspace ${name} is ambiguous: ${matches.length} groups have that title`);
    }
    return matches[0] || null;
  }

  async groupTabs(groupId) {
    if (!Number.isInteger(groupId) || groupId < 0) return [];
    return await this.chrome.tabs.query({ groupId });
  }

  tabUrl(tab) {
    return String(tab?.pendingUrl || tab?.url || "");
  }

  isExtensionManagementUrl(url) {
    return /^chrome:\/\/extensions(?:\/|\?|#|$)/.test(String(url || ""));
  }

  isExtensionPageUrl(url) {
    return /^chrome-extension:\/\//.test(String(url || ""));
  }

  async noteActivatedTab(activeInfo, now = Date.now()) {
    const tabId = Number(activeInfo?.tabId);
    const windowId = Number(activeInfo?.windowId);
    if (!Number.isInteger(tabId) || !Number.isInteger(windowId)) return null;
    if (typeof this.chrome.tabs.get !== "function") return null;

    const tab = await this.chrome.tabs.get(tabId);
    if (!this.isExtensionManagementUrl(this.tabUrl(tab))) return null;

    this.recentExtensionManagementByWindow.set(windowId, now);
    return { windowId, tabId, recordedAt: now };
  }

  async uniqueConfiguredWorkspace() {
    const config = await this.loadConfig();
    const names = Object.keys(config.workspaces || {});
    if (!names.length) return null;

    const groups = await this.chrome.tabGroups.query({});
    const candidates = [];
    for (const name of names) {
      const matches = groups.filter((group) => group.title === name);
      if (matches.length > 1) {
        throw new Error(`Workspace ${name} is ambiguous: ${matches.length} groups have that title`);
      }
      if (matches[0]) {
        candidates.push({
          group: matches[0],
          entry: config.workspaces[name],
        });
      }
    }
    return candidates.length === 1 ? candidates[0] : null;
  }

  async inheritNavigationTarget(details) {
    const sourceTabId = Number(details?.sourceTabId);
    const tabId = Number(details?.tabId);
    if (!Number.isInteger(sourceTabId) || !Number.isInteger(tabId)) return null;

    const [source, target] = await Promise.all([
      this.chrome.tabs.get(sourceTabId),
      this.chrome.tabs.get(tabId),
    ]);
    if (!this.isOwnedTab(source)) return null;

    const groupId = Number(source.groupId);
    if (!Number.isInteger(groupId) || groupId < 0) return null;

    const groups = await this.chrome.tabGroups.query({});
    const group = groups.find((candidate) => candidate.id === groupId);
    if (!group?.title) return null;

    const { entry } = await this.configuredWorkspace(group.title);
    if (!entry) return null;

    this.markOwned(tabId);
    await this.chrome.tabs.group({ groupId, tabIds: [tabId] });

    const tabs = await this.groupTabs(groupId);
    if (tabs.length > entry.poolSize) {
      const { idle } = this.classify(group.title, tabs);
      const removable = idle.find((candidate) => candidate.id !== tabId);
      if (removable) await this.chrome.tabs.remove(removable.id);
    }

    await this.chrome.tabGroups.update(groupId, {
      title: group.title,
      collapsed: true,
    });

    return {
      workspace: group.title,
      groupId,
      tabId,
      sourceTabId,
      adoptionReason: "navigation-target",
    };
  }

  async inheritWorkspaceForCreatedTab(tab) {
    const tabId = Number(tab?.id);
    const openerTabId = Number(tab?.openerTabId);
    if (!Number.isInteger(tabId)) return null;

    const allTabs = await this.chrome.tabs.query({});
    const tabsById = new Map(allTabs.map((candidate) => [candidate.id, candidate]));
    const groups = await this.chrome.tabGroups.query({});
    const groupsById = new Map(groups.map((candidate) => [candidate.id, candidate]));

    let ancestor = Number.isInteger(openerTabId) ? tabsById.get(openerTabId) : null;
    const visited = new Set();
    let inherited = null;
    let extensionManagementAncestor = null;

    while (ancestor && !visited.has(ancestor.id)) {
      visited.add(ancestor.id);

      if (this.isExtensionManagementUrl(this.tabUrl(ancestor))) {
        extensionManagementAncestor = ancestor;
      }

      if (this.isOwnedTab(ancestor) && Number.isInteger(ancestor.groupId) && ancestor.groupId >= 0) {
        const group = groupsById.get(ancestor.groupId);
        if (group?.title) {
          const { entry } = await this.configuredWorkspace(group.title);
          if (entry) {
            inherited = { ancestor, group, entry };
            break;
          }
        }
      }

      const parentId = Number(ancestor.openerTabId);
      ancestor = Number.isInteger(parentId) ? tabsById.get(parentId) : null;
    }

    let adoptionReason = "workspace-opener";
    if (!inherited && this.isExtensionPageUrl(this.tabUrl(tab))) {
      const windowId = Number(tab?.windowId);
      const recentManagementAt = Number.isInteger(windowId)
        ? this.recentExtensionManagementByWindow.get(windowId)
        : null;
      const hasRecentManagementContext =
        Number.isFinite(recentManagementAt) &&
        Date.now() - recentManagementAt <= EXTENSION_MANAGEMENT_RECENCY_MS;

      if (extensionManagementAncestor || hasRecentManagementContext) {
        const candidate = await this.uniqueConfiguredWorkspace();
        if (candidate) {
          inherited = {
            ancestor: extensionManagementAncestor,
            group: candidate.group,
            entry: candidate.entry,
          };
          adoptionReason = extensionManagementAncestor
            ? "extension-management-opener"
            : "recent-extension-management";
        }
      }
    }

    if (!inherited) {
      if (this.isOwnedTab(tab)) return {
        tabId,
        owned: true,
      };

      const groupId = Number(tab?.groupId);
      const group = Number.isInteger(groupId) && groupId >= 0
        ? groupsById.get(groupId)
        : null;
      if (group?.title) {
        const { entry } = await this.configuredWorkspace(group.title);
        const meta = this.parseManagedUrl(this.tabUrl(tab));
        if (entry && meta?.workspace !== group.title) {
          await this.chrome.tabs.ungroup([tabId]);
          return {
            workspace: group.title,
            groupId,
            tabId,
            releasedUnexpected: true,
          };
        }
      }
      return null;
    }

    const { ancestor: workspaceAncestor, group, entry } = inherited;
    this.markOwned(tabId);
    await this.chrome.tabs.group({ groupId: group.id, tabIds: [tabId] });

    const tabs = await this.groupTabs(group.id);
    if (tabs.length > entry.poolSize) {
      const { idle } = this.classify(group.title, tabs);
      const removable = idle.find((candidate) => candidate.id !== tabId);
      if (removable) await this.chrome.tabs.remove(removable.id);
    }

    await this.chrome.tabGroups.update(group.id, {
      title: group.title,
      collapsed: true,
    });

    const result = {
      workspace: group.title,
      groupId: group.id,
      tabId,
      inheritedFromTabId: Number.isInteger(openerTabId) ? openerTabId : null,
      workspaceAncestorTabId: workspaceAncestor?.id ?? null,
    };
    if (adoptionReason !== "workspace-opener") result.adoptionReason = adoptionReason;
    return result;
  }

  async reconcileCreatedTab(tabId) {
    const id = Number(tabId);
    if (!Number.isInteger(id)) return null;
    const tab = await this.chrome.tabs.get(id);
    return await this.inheritWorkspaceForCreatedTab(tab);
  }

  classify(name, tabs) {
    const idle = [];
    const leased = [];
    for (const tab of tabs) {
      const meta = this.parseManagedUrl(tab.url || "");
      if (meta?.workspace === name && ["idle", "marker"].includes(meta.role)) idle.push(tab);
      else leased.push(tab);
    }
    return { idle, leased };
  }

  async waitForIdleTab(tabId, workspace, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const tabs = await this.chrome.tabs.query({});
      const tab = tabs.find((candidate) => candidate.id === tabId);
      const meta = this.parseManagedUrl(tab?.url || "");
      if (tab && meta?.workspace === workspace && meta.role === "idle") return tab;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for workspace ${workspace} idle tab ${tabId}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  async createGroup(name, poolSize) {
    // Chrome groups are created by grouping a tab. Keep one seed tab so the
    // workspace has an identity, then grow the physical pool on demand.
    const created = [await this.chrome.tabs.create({
      url: this.idleUrl(name, 0),
      active: false,
    })];
    for (const tab of created) this.markOwned(tab.id);
    const groupId = await this.chrome.tabs.group({ tabIds: created.map((tab) => tab.id) });
    await this.chrome.tabGroups.update(groupId, { title: name, collapsed: true });
    for (const tab of created) await this.waitForIdleTab(tab.id, name);
    return await this.status(name);
  }

  async ensureWorkspace(name, poolSize = null) {
    const normalizedName = normalizeWorkspaceName(name);
    const { entry } = await this.configuredWorkspace(normalizedName);
    const wanted = normalizePoolSize(poolSize, entry?.poolSize ?? 8);
    if (!entry || entry.poolSize !== wanted) await this.setPoolSize(normalizedName, wanted);

    const group = await this.workspaceGroup(normalizedName);
    if (!group) return await this.createGroup(normalizedName, wanted);

    await this.chrome.tabGroups.update(group.id, { title: normalizedName, collapsed: true });
    await this.reconcilePool(normalizedName, group.id, wanted);
    return await this.status(normalizedName);
  }

  async reconcilePool(name, groupId, poolSize) {
    const tabs = await this.groupTabs(groupId);
    const { idle } = this.classify(name, tabs);

    // poolSize is a maximum concurrent capacity, not a target tab count.
    // Only remove surplus idle tabs when shrinking; never refill a lazy pool.
    if (tabs.length > poolSize && idle.length) {
      const removable = Math.min(idle.length, tabs.length - poolSize);
      await this.chrome.tabs.remove(idle.slice(0, removable).map((tab) => tab.id));
    }

    await this.chrome.tabGroups.update(groupId, { title: name, collapsed: true });
  }

  async status(name) {
    const normalizedName = normalizeWorkspaceName(name);
    const { entry } = await this.configuredWorkspace(normalizedName);
    if (!entry) return { name: normalizedName, initialized: false };

    const group = await this.workspaceGroup(normalizedName);
    if (!group) {
      return {
        name: normalizedName,
        initialized: false,
        poolSize: entry.poolSize,
        reason: "group-missing",
      };
    }

    const tabs = await this.groupTabs(group.id);
    const { idle, leased } = this.classify(normalizedName, tabs);
    return {
      name: normalizedName,
      initialized: true,
      groupId: group.id,
      poolSize: entry.poolSize,
      maxCapacity: entry.poolSize,
      physicalTabs: tabs.length,
      idle: idle.length,
      leased: leased.length,
      tabIds: tabs.map((tab) => tab.id),
      idleTabIds: idle.map((tab) => tab.id),
      leasedTabIds: leased.map((tab) => tab.id),
      tabs: tabs.map((tab) => ({
        tabId: tab.id,
        groupId: tab.groupId,
        title: tab.title || "",
        url: tab.url || "",
        active: Boolean(tab.active),
      })),
      collapsed: Boolean(group.collapsed),
    };
  }

  async restoreConfiguredWorkspaces() {
    const config = await this.loadConfig();
    const restored = [];
    for (const name of Object.keys(config.workspaces || {}).sort()) {
      restored.push(await this.ensureWorkspace(name));
    }
    return { workspaces: restored };
  }

  async list() {
    const config = await this.loadConfig();
    const result = [];
    for (const name of Object.keys(config.workspaces).sort()) {
      result.push(await this.status(name));
    }
    return { workspaces: result };
  }

  // The legacy default group is only renamed after all its tabs return idle.
  // Preserve configured custom workspaces, old leased tabs and Chrome tab IDs.
  async migrateDefaultWorkspace(activeLegacySessions = 0) {
    const oldName = "Harness", newName = "WebHelm";
    const config = await this.loadConfig();
    if (!config.workspaces[oldName]) return {name: newName, migrated: false};
    if (config.workspaces[newName]) return {name: newName, migrated: false, legacyPreserved: true};
    if (activeLegacySessions > 0) return {name: oldName, deferred: "active-sessions"};
    const group = await this.workspaceGroup(oldName);
    const tabs = group ? await this.groupTabs(group.id) : [];
    if (group && this.classify(oldName, tabs).leased.length)
      return {name: oldName, deferred: "leased-tabs"};

    // URL ownership and group identity change together. If navigation fails,
    // restore both before retrying so no lease is silently adopted.
    const updated = [];
    try {
      // Mark existing legacy tabs as owned before their URLs change. Chrome
      // can emit grouping callbacks mid-migration.
      for (const tab of tabs) this.markOwned(tab.id);
      if (group) await this.chrome.tabGroups.update(group.id, {title: newName});
      for (const tab of tabs) {
        await this.chrome.tabs.update(tab.id, {url: this.idleUrl(newName, tab.id), active: false});
        updated.push(tab);
      }
      config.workspaces[newName] = config.workspaces[oldName];
      delete config.workspaces[oldName];
      await this.saveConfig(config);
      return {name: newName, migrated: true, migratedTabs: updated.length};
    } catch(error) {
      if (group) await this.chrome.tabGroups.update(group.id, {title: oldName}).catch(() => {});
      for (const tab of updated) {
        await this.chrome.tabs.update(tab.id,{url: tab.url,active:false}).catch(() => {});
      }
      throw error;
    }
  }

  async ensure(name, defaultPoolSize = 8) {
    const normalizedName = normalizeWorkspaceName(name);
    const { entry } = await this.configuredWorkspace(normalizedName);
    if (entry) return await this.ensureWorkspace(normalizedName);
    return await this.ensureWorkspace(
      normalizedName,
      normalizePoolSize(defaultPoolSize),
    );
  }

  async create(name, poolSize = 8) {
    return await this.ensureWorkspace(name, normalizePoolSize(poolSize));
  }

  async resize(name, poolSize) {
    const normalizedName = normalizeWorkspaceName(name);
    const wanted = normalizePoolSize(poolSize);
    await this.setPoolSize(normalizedName, wanted);
    return await this.ensureWorkspace(normalizedName, wanted);
  }

  async acquireIdentity(name) {
    const normalizedName = normalizeWorkspaceName(name);
    const ready = await this.ensureWorkspace(normalizedName);
    const tabs = await this.groupTabs(ready.groupId);
    const { idle, leased } = this.classify(normalizedName, tabs);
    if (!idle.length && leased.length >= ready.poolSize) {
      throw new Error(`Workspace ${normalizedName} pool is exhausted at size ${ready.poolSize}`);
    }

    let tab = idle[0];
    if (!tab) {
      tab = await this.chrome.tabs.create({
        url: this.idleUrl(normalizedName, tabs.length),
        active: false,
      });
      this.markOwned(tab.id);
      await this.chrome.tabs.group({ groupId: ready.groupId, tabIds: [tab.id] });
      tab = await this.waitForIdleTab(tab.id, normalizedName);
    }

    this.markOwned(tab.id);
    const identityTitle = this.identityTitle(tab.id);
    const identityUrl = this.identityUrl(normalizedName, tab.id);
    const updated = await this.chrome.tabs.update(tab.id, { url: identityUrl, active: false });
    await this.chrome.tabGroups.update(ready.groupId, { title: normalizedName, collapsed: true });
    return {
      workspace: normalizedName,
      groupId: ready.groupId,
      tabId: updated.id,
      identityTitle,
      identityUrl,
      idleUrl: this.idleUrl(normalizedName, updated.id),
      active: Boolean(updated.active),
    };
  }

  async acquire(name, url) {
    const normalizedName = normalizeWorkspaceName(name);
    const parsed = new URL(String(url || ""));
    if (!["http:", "https:", "chrome-extension:"].includes(parsed.protocol)) {
      throw new Error("Workspace acquire requires an http(s) or chrome-extension URL");
    }

    const ready = await this.ensureWorkspace(normalizedName);
    const tabs = await this.groupTabs(ready.groupId);
    const { idle, leased } = this.classify(normalizedName, tabs);
    if (!idle.length && leased.length >= ready.poolSize) {
      throw new Error(`Workspace ${normalizedName} pool is exhausted at size ${ready.poolSize}`);
    }

    let tab = idle[0];
    if (!tab) {
      tab = await this.chrome.tabs.create({
        url: this.idleUrl(normalizedName, tabs.length),
        active: false,
      });
      // Group reconciliation can fire before the extension idle URL is visible.
      // Mark ownership first so a legitimate WebHelm lease is not ejected.
      this.markOwned(tab.id);
      await this.chrome.tabs.group({ groupId: ready.groupId, tabIds: [tab.id] });
      tab = await this.waitForIdleTab(tab.id, normalizedName);
    }
    this.markOwned(tab.id);
    const updated = await this.chrome.tabs.update(tab.id, { url: parsed.href, active: false });
    await this.chrome.tabGroups.update(ready.groupId, { title: normalizedName, collapsed: true });
    return {
      workspace: normalizedName,
      groupId: ready.groupId,
      tabId: updated.id,
      url: updated.url || parsed.href,
      active: Boolean(updated.active),
    };
  }

  async release(name, tabId) {
    const normalizedName = normalizeWorkspaceName(name);
    const ready = await this.ensureWorkspace(normalizedName);
    const wanted = Number(tabId);
    const tabs = await this.groupTabs(ready.groupId);
    if (!tabs.some((tab) => tab.id === wanted)) {
      throw new Error(`Tab ${wanted} is not owned by workspace ${normalizedName}`);
    }

    if (tabs.length > ready.poolSize) {
      await this.chrome.tabs.remove(wanted);
    } else {
      try {
        await this.chrome.tabs.update(wanted, {
          url: this.idleUrl(normalizedName, wanted),
          active: false,
        });
        await this.waitForIdleTab(wanted, normalizedName);
      } catch {
        // Legacy/unowned leases may refuse or fail to finish navigation back to
        // the extension idle page. Preserve pool capacity by creating a clean
        // idle replacement in the same group before removing the stale tab.
        const replacement = await this.chrome.tabs.create({
          url: this.idleUrl(normalizedName, wanted),
          active: false,
        });
        this.markOwned(replacement.id);
        await this.chrome.tabs.group({ groupId: ready.groupId, tabIds: [replacement.id] });
        await this.waitForIdleTab(replacement.id, normalizedName);
        await this.chrome.tabs.remove(wanted);
      }
    }
    await this.chrome.tabGroups.update(ready.groupId, { title: normalizedName, collapsed: true });
    return { workspace: normalizedName, tabId: wanted, released: true };
  }

  async releaseAll() {
    const config = await this.loadConfig();
    const released = [];

    for (const name of Object.keys(config.workspaces || {}).sort()) {
      const group = await this.workspaceGroup(name);
      if (!group) continue;

      // Snapshot first because release() mutates the group as tabs return idle
      // or are removed when the group is above its configured capacity.
      const tabs = await this.groupTabs(group.id);
      const { leased } = this.classify(name, tabs);
      for (const tab of leased) {
        await this.release(name, tab.id);
        released.push({ workspace: name, tabId: tab.id });
      }

      // Chrome destroys a tab group when it becomes empty. Release-all must
      // preserve workspace identity, so re-ensure the workspace after the
      // release pass and leave at least one idle seed tab if necessary.
      await this.ensureWorkspace(name);
    }

    return {
      released,
      releasedCount: released.length,
    };
  }

  async delete(name, force = false) {
    const normalizedName = normalizeWorkspaceName(name);
    const state = await this.status(normalizedName);
    if (!state.initialized) {
      await this.removeConfig(normalizedName);
      return { name: normalizedName, deleted: true };
    }
    if (state.leasedTabIds.length && !force) {
      throw new Error(`Workspace ${normalizedName} has ${state.leasedTabIds.length} leased tabs`);
    }

    const tabs = await this.groupTabs(state.groupId);
    if (tabs.length) await this.chrome.tabs.remove(tabs.map((tab) => tab.id));
    await this.removeConfig(normalizedName);
    return { name: normalizedName, deleted: true };
  }

  async rpc(request) {
    const method = String(request?.method || "");
    const args = request?.args || {};
    if (method === "workspace.create") return await this.create(args.name, args.poolSize);
    if (method === "workspace.ensure") return await this.ensure(args.name, args.poolSize);
    if (method === "workspace.status") return await this.status(args.name);
    if (method === "workspace.list") return await this.list();
    if (method === "workspace.migrateDefault") return await this.migrateDefaultWorkspace(Number(args.activeLegacySessions || 0));
    if (method === "workspace.acquire") return await this.acquire(args.name, args.url);
    if (method === "workspace.acquireIdentity") return await this.acquireIdentity(args.name);
    if (method === "workspace.release") return await this.release(args.name, args.tabId);
    if (method === "workspace.releaseAll") return await this.releaseAll();
    if (method === "workspace.resize") return await this.resize(args.name, args.poolSize);
    if (method === "workspace.delete") return await this.delete(args.name, Boolean(args.force));
    throw new Error(`Unknown workspace method: ${method}`);
  }
}
