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
    if (!threads.has(key)) threads.set(key,{head:item,index,count:0});
    threads.get(key).count++;
  }
  const heads=[...threads.values()].sort((a,b)=>
    (priority[a.head.state]??5)-(priority[b.head.state]??5)||a.index-b.index);
  const visible=expanded ? all : heads.slice(0,Math.max(1,maxHeads)).map(x=>x.head);
  const behind=new Map(heads.map(x=>[x.head.id,x.count-1]));
  const uncertain=all.filter(x=>x.state==='UNCERTAIN').length;
  const blocked=all.filter(x=>x.state==='BLOCKED').length;
  return {visible,total:all.length,threads:threads.size,behind,
    hidden:all.length-visible.length,uncertain,blocked};
}
