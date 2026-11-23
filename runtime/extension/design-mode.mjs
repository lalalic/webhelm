// Optional, user-initiated Chrome Split View pairing for an existing WebHelm
// Session and the user's existing ChatGPT thread tab. Never adopt the chat tab
// as an agent Session, navigate it or close it.
const KEY = 'webhelm.design-mode.v1';

export function isChatThread(url) {
  try {
    const u = new URL(url);
    return ['chatgpt.com', 'chat.openai.com'].includes(u.hostname) &&
      /^\/(?:g\/[^/]+\/)?c\/[a-z0-9-]+\/?$/i.test(u.pathname);
  } catch { return false; }
}

function validId(id) { return Number.isSafeInteger(id) && id >= 0; }
function isMissingTab(error) { return /No tab with id|Invalid tab ID|No window with id/i.test(String(error?.message || error)); }

// Only pair the user's currently active ChatGPT conversation, never guess
// among background or recently visited threads.
export async function activeChatThread(chromeApi) {
  const window = await chromeApi.windows.getLastFocused({windowTypes:['normal']});
  if (!window || !validId(window.id)) return null;
  const tabs = await chromeApi.tabs.query({windowId:window.id,active:true});
  return tabs.find(tab => isChatThread(tab.url)) || null;
}


export class DesignMode {
  constructor(chromeApi, manager, control) {
    this.chrome = chromeApi;
    this.manager = manager;
    this.control = control;
    this.records = new Map();
    this.serial = Promise.resolve();
    this.ready = this.load();
  }

  async load() {
    const saved = (await this.chrome.storage.session.get(KEY))[KEY] || {};
    for (const [id, value] of Object.entries(saved)) {
      if (!value || !validId(value.chatTabId) || !validId(value.agentTabId)) continue;
      this.records.set(id, value);
      this.manager.designCompanionTabIds.add(value.chatTabId);
      if (validId(value.groupId)) this.manager.designActiveGroupIds.add(value.groupId);
    }
  }

  async save() {
    await this.chrome.storage.session.set({[KEY]:Object.fromEntries(this.records)});
  }

  hasSession(sessionId) { return this.records.has(sessionId); }
  activeSessionIds() { return [...this.records].filter(([,r]) => r.state === 'active').map(([id]) => id); }
  allSessionIds() { return [...this.records.keys()]; }

  serialize(fn) {
    const result = this.serial.then(fn);
    this.serial = result.catch(() => {});
    return result;
  }

  async toggle(sessionId) {
    await this.ready;
    return this.serialize(() => this.records.has(sessionId) ? this.disable(sessionId) : this.enable(sessionId));
  }

  async enableSession(sessionId) {
    await this.ready;
    return this.serialize(async () => {
      const record=this.records.get(sessionId);
      if(record) {
        if(record.state!=='active') throw Error('Design Mode restore is pending; cannot enable');
        return {active:true,sessionId,alreadyActive:true};
      }
      return this.enable(sessionId);
    });
  }

  async enable(sessionId) {
    if (typeof this.chrome.tabs.createSplit !== 'function' || typeof this.chrome.tabs.unsplit !== 'function')
      throw Error('Design Mode requires Chrome 155+ Split View APIs');
    const daemon = await this.control.status();
    if (!daemon.connected) throw Error('WebHelm daemon is offline');
    const session = daemon.sessions.find(s => s.session_id === sessionId);
    if (!session || !validId(session.tabId)) throw Error('Session tab not found');
    const agent = await this.chrome.tabs.get(session.tabId);
    if (!validId(agent.groupId) || !validId(agent.windowId))
      throw Error('Agent Session has no managed Chrome tab group');
    if (validId(agent.splitViewId) && agent.splitViewId !== -1)
      throw Error('Agent tab is already in a Split View');
    if (agent.pinned) throw Error('Pinned Session tabs are not supported');

    const chat = await activeChatThread(this.chrome);
    if (!chat) throw Error('Activate a ChatGPT conversation tab before enabling Design Mode');
    const leased = new Set(daemon.sessions.flatMap(s => Array.isArray(s.tabIds) ? s.tabIds : [s.tabId]));
    if (leased.has(chat.id) || [...this.records.values()].some(r => r.chatTabId === chat.id) ||
        (validId(chat.splitViewId) && chat.splitViewId !== -1) || chat.pinned)
      throw Error('Active ChatGPT tab is already owned, split or pinned');
    const allTabs = await this.chrome.tabs.query({});
    const group = chat.groupId >= 0
      ? await this.chrome.tabGroups.get(chat.groupId).catch(() => null) : null;
    const agentGroup = await this.chrome.tabGroups.get(agent.groupId);
    const original = {
      windowId:chat.windowId, index:chat.index, groupId:chat.groupId,
      group:group ? {title:group.title, color:group.color, collapsed:group.collapsed} : null,
    };
    const record = {
      sessionId, agentTabId:agent.id, chatTabId:chat.id, groupId:agent.groupId,
      agentGroupCollapsed:agentGroup.collapsed, original, state:'preparing',
      splitViewId:null, placeholderTabId:null,
    };
    this.records.set(sessionId,record);
    this.manager.designCompanionTabIds.add(chat.id);
    this.manager.designActiveGroupIds.add(agent.groupId);
    await this.save();
    try {
      if (chat.windowId !== agent.windowId) {
        const windowTabs = allTabs.filter(t => t.windowId === chat.windowId);
        // Keep the original window alive so restoring this exact tab remains possible.
        if (windowTabs.length === 1) {
          const placeholder = await this.chrome.tabs.create({
            windowId: chat.windowId, url:'about:blank', active:false,
          });
          record.placeholderTabId = placeholder.id;
          await this.save();
        }
        await this.chrome.tabs.move(chat.id,{windowId:agent.windowId,index:agent.index+1});
      }
      await this.chrome.tabs.group({groupId:agent.groupId,tabIds:[chat.id]});
      const currentAgent = await this.chrome.tabs.get(agent.id);
      await this.chrome.tabs.move(chat.id,{index:currentAgent.index+1});
      const left = await this.chrome.tabs.get(agent.id);
      const right = await this.chrome.tabs.get(chat.id);
      if (left.windowId !== right.windowId || left.groupId !== right.groupId ||
          right.index !== left.index+1)
        throw Error('Chrome could not place ChatGPT adjacent to the Session tab');
      await this.chrome.tabGroups.update(agent.groupId,{collapsed:false});
      record.splitViewId = await this.chrome.tabs.createSplit([agent.id,chat.id]);
      record.state='active';
      await this.save();
      await this.chrome.tabs.update(chat.id,{active:true});
      await this.chrome.windows.update(agent.windowId,{focused:true});
      return {active:true,sessionId,agentTabId:agent.id,chatTabId:chat.id,splitViewId:record.splitViewId};
    } catch (error) {
      try { await this.disable(sessionId); }
      catch (recovery) { throw Error(error.message + '; restore failed: ' + recovery.message); }
      throw error;
    }
  }

  async restoreChat(record) {
    const id=record.chatTabId, original=record.original;
    let chat;
    try { chat=await this.chrome.tabs.get(id); }
    catch(error) { if (isMissingTab(error)) return; throw error; }

    if (validId(chat.splitViewId) && chat.splitViewId !== -1) {
      await this.chrome.tabs.unsplit(chat.splitViewId);
    } else if (validId(record.splitViewId)) {
      await this.chrome.tabs.unsplit(record.splitViewId).catch(()=>{});
    }
    chat=await this.chrome.tabs.get(id);
    if (chat.groupId >= 0) await this.chrome.tabs.ungroup([id]);
    if (validId(original.windowId)) {
      const windowExists = await this.chrome.windows.get(original.windowId).then(()=>true,()=>false);
      if (windowExists) await this.chrome.tabs.move(id,{
        windowId:original.windowId,index:Math.max(0,original.index),
      });
    }
    if (original.groupId >= 0 && original.group) {
      const oldGroup = await this.chrome.tabGroups.get(original.groupId).catch(()=>null);
      const groupId = oldGroup
        ? await this.chrome.tabs.group({groupId:oldGroup.id,tabIds:[id]})
        : await this.chrome.tabs.group({tabIds:[id]});
      if (!oldGroup) await this.chrome.tabGroups.update(groupId,original.group);
      await this.chrome.tabs.move(id,{index:Math.max(0,original.index)});
    }
    if (validId(record.placeholderTabId)) {
      await this.chrome.tabs.remove(record.placeholderTabId).catch(()=>{});
    }
  }

  async disable(sessionId) {
    const record=this.records.get(sessionId);
    if (!record) return {active:false,sessionId};
    try {
      await this.restoreChat(record);
    } catch (error) {
      // Keep the recovery record and companion protection for the next attempt.
      record.state='restore-failed';
      await this.save();
      throw error;
    }
    this.records.delete(sessionId);
    this.manager.designCompanionTabIds.delete(record.chatTabId);
    if (![...this.records.values()].some(r => r.groupId === record.groupId))
      this.manager.designActiveGroupIds.delete(record.groupId);
    await this.save();
    if (validId(record.groupId) && !this.manager.designActiveGroupIds.has(record.groupId)) {
      await this.chrome.tabGroups.update(record.groupId,
        {collapsed:Boolean(record.agentGroupCollapsed)}).catch(()=>{});
    }
    return {active:false,sessionId,chatTabId:record.chatTabId,restored:true};
  }

  async closeSession(sessionId) {
    await this.ready;
    return this.serialize(()=>this.disable(sessionId));
  }

  async reconcile() {
    await this.ready;
    return this.serialize(async()=>{
      const daemon=await this.control.status();
      if (!daemon.connected) return;
      const live=new Set(daemon.sessions.map(s=>s.session_id));
      for(const id of [...this.records.keys()]){
        if (!live.has(id)) await this.disable(id).catch(()=>{});
      }
    });
  }
}
