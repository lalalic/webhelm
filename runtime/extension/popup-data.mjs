// Pure display shaping. Keep pending work intact: folding never acknowledges,
// cancels, retries or removes an entry from the durable queue.
export const SITE_STORAGE_KEY = 'webhelm.keepalive.sites.v1';
export const SITE_STATUS_KEY = 'webhelm.keepalive.status.v1';

function validSite(site) {
  if (!site || typeof site.id !== 'string' || site.id !== site.url || site.enabled !== true) return false;
  try { const url = new URL(site.url); return url.protocol === 'https:' && url.origin === site.id; }
  catch { return false; }
}

export function mergeKeptSites(persisted, statusById, reported) {
  const sites = new Map();
  for (const site of Array.isArray(persisted) ? persisted : []) {
    if (validSite(site)) sites.set(site.id, {...site, status:statusById?.[site.id]?.status || 'pending'});
  }
  for (const site of Array.isArray(reported) ? reported : []) {
    if (validSite(site)) sites.set(site.id, {...sites.get(site.id), ...site});
  }
  return [...sites.values()].sort((a,b)=>a.id.localeCompare(b.id));
}

export async function readKeptSites(chromeApi, reported) {
  let persisted=[], statuses={};
  try {
    const stored=await chromeApi.storage.local.get(SITE_STORAGE_KEY);
    persisted=stored[SITE_STORAGE_KEY];
    const latest=await chromeApi.storage.session.get(SITE_STATUS_KEY);
    statuses=latest[SITE_STATUS_KEY] || {};
  } catch { /* Keep any site entries returned by the current service worker. */ }
  return mergeKeptSites(persisted,statuses,reported);
}

export async function setStoredSite(chromeApi, url, enabled) {
  const origin = new URL(url).origin;
  if (!/^https:\/\//.test(origin)) throw Error('Keep Alive requires HTTPS');
  const stored=await chromeApi.storage.local.get(SITE_STORAGE_KEY);
  const current=Array.isArray(stored[SITE_STORAGE_KEY]) ? stored[SITE_STORAGE_KEY] : [];
  const next=current.filter(site=>site?.id!==origin);
  if (enabled) next.push({id:origin,url:origin,enabled:true,addedAt:Date.now(),revision:crypto.randomUUID()});
  await chromeApi.storage.local.set({[SITE_STORAGE_KEY]: next.sort((a,b)=>a.id.localeCompare(b.id))});
  if (!enabled) {
    const storedStates=await chromeApi.storage.session.get(SITE_STATUS_KEY);
    const states=storedStates[SITE_STATUS_KEY] || {};
    delete states[origin];
    await chromeApi.storage.session.set({[SITE_STATUS_KEY]:states});
  }
  return {id:origin,enabled:Boolean(enabled)};
}

const priority = {UNCERTAIN:0,BLOCKED:1,SENDING:2,CHECKING:2,WAITING:3,QUEUED:4};
function threadKey(item) {
  // Old queue adapters might not identify threads; don't merge unrelated IDs.
  return `${item.platform||'Queue'}\u0000${item.thread_id||item.id}`;
}

export function compactQueue(items, {expanded=false,maxHeads=8}={}) {
  const all=Array.isArray(items) ? items : [];
  const threads=new Map();
  for (const [index,item] of all.entries()) {
    const key=threadKey(item);
    if (!threads.has(key)) threads.set(key,{head:item,index,count:0,items:[]});
    threads.get(key).count++;
    threads.get(key).items.push(item);
  }
  const heads=[...threads.values()].sort((a,b)=>
    (priority[a.head.state]??5)-(priority[b.head.state]??5)||a.index-b.index);
  const visible=expanded ? heads.flatMap(x=>x.items) : heads.slice(0,Math.max(1,maxHeads)).map(x=>x.head);
  const headFor=new Map(heads.flatMap(x=>x.items.map(item=>[item.id,x.head])));
  const behind=new Map(heads.map(x=>[x.head.id,x.count-1]));
  const uncertain=all.filter(x=>x.state==='UNCERTAIN').length;
  const blocked=all.filter(x=>x.state==='BLOCKED').length;
  return {visible,total:all.length,threads:threads.size,behind,headFor,
    hidden:all.length-visible.length,uncertain,blocked};
}

// Statuses describe what the user can do, not internal retry counters.
// A later QUEUED item cannot be sent until earlier items in the same thread resolve.
export function queueStatusText(item,{head=item,remaining=0}={}) {
  const state=String(item.state||'QUEUED').toUpperCase();
  const following=head.id!==item.id;
  let message;
  if(following && ['UNCERTAIN','BLOCKED'].includes(head.state))
    message=head.state==='UNCERTAIN' ? 'Waiting — previous send unconfirmed' : 'Waiting — previous message blocked';
  else if(following) message='Waiting behind earlier message';
  else message=({
    UNCERTAIN:'Send unconfirmed — open thread to check',
    BLOCKED:'Blocked — needs attention',
    SENDING:'Sending',
    CHECKING:'Checking delivery',
    WAITING:'Waiting to send',
    QUEUED:'Queued to send',
  })[state]||state.toLowerCase();
  if(!following && remaining>0)
    message+=' · '+remaining+' later message'+(remaining===1?'':'s')+' waiting';
  return message;
}

// Snapshot elapsed time once when the extension menu opens.
export function formatQueueElapsed(createdAt, snapshotSeconds) {
  const created=Number(createdAt);
  if(!Number.isFinite(created)||created<=0)return null;
  const elapsed=Math.max(0,Math.floor(snapshotSeconds-created));
  if(elapsed<60)return elapsed+'s';
  if(elapsed<3600)return Math.floor(elapsed/60)+'m';
  if(elapsed<86400)return Math.floor(elapsed/3600)+'h';
  return Math.floor(elapsed/86400)+'d';
}

// Keep hidden groups out of the toolbar even if a running older worker has
// not yet reloaded its control RPC. Do not mutate the persisted configuration.
export const WORKSPACE_STORAGE_KEY='browserWorkspaceManager.v1';
export function menuWorkspaces(workspaces,config={}) {
  return (Array.isArray(workspaces)?workspaces:[]).filter(workspace =>
    workspace.showInMenu !== false && config?.workspaces?.[workspace.name]?.showInMenu !== false);
}
export async function readMenuWorkspaces(chromeApi,workspaces) {
  try {
    const record=await chromeApi.storage.local.get(WORKSPACE_STORAGE_KEY);
    return menuWorkspaces(workspaces,record[WORKSPACE_STORAGE_KEY]);
  } catch { return menuWorkspaces(workspaces); }
}
