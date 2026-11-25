// Site keep-alive configuration lives in the managed Chrome profile, not a
// leased WebHelm Session. No cookies, credentials, or page contents are stored.
export const SITE_STORAGE_KEY = 'webhelm.keepalive.sites.v1';
export const SITE_STATUS_KEY = 'webhelm.keepalive.status.v1';

export function siteOrigin(rawUrl) {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password)
    throw Error('Keep Alive requires a normal HTTPS website');
  return parsed.origin;
}

// Keep one registration per origin, but retain the exact page path for opening
// and for display. Never persist query parameters or fragments.
export function sitePage(rawUrl) {
  const parsed = new URL(rawUrl);
  const origin = siteOrigin(rawUrl);
  return parsed.pathname === '/' ? origin : origin + parsed.pathname;
}

export async function listKeptSites(chromeApi) {
  const record = (await chromeApi.storage.local.get(SITE_STORAGE_KEY))[SITE_STORAGE_KEY];
  return Array.isArray(record) ? record.filter(site => {
    if (!site || typeof site.id !== 'string' || typeof site.url !== 'string' || site.enabled !== true) return false;
    try { return site.id === siteOrigin(site.url) && site.url === sitePage(site.url); }
    catch { return false; }
  }) : [];
}

export async function setKeptSite(chromeApi, url, enabled) {
  const id = siteOrigin(url);
  const sites = (await listKeptSites(chromeApi)).filter(site => site.id !== id);
  if (enabled) sites.push({id, url:sitePage(url), enabled:true, addedAt:Date.now(), revision:crypto.randomUUID()});
  sites.sort((a,b) => a.id.localeCompare(b.id));
  await chromeApi.storage.local.set({[SITE_STORAGE_KEY]: sites});
  if (!enabled) {
    for (const storage of [chromeApi.storage.local,chromeApi.storage.session]) {
      const states = (await storage.get(SITE_STATUS_KEY))[SITE_STATUS_KEY] || {};
      delete states[id];
      await storage.set({[SITE_STATUS_KEY]: states});
    }
  }
  return {id, enabled:Boolean(enabled), sites};
}

export async function sitesWithStatus(chromeApi) {
  const [sites, stored, legacy] = await Promise.all([listKeptSites(chromeApi),
    chromeApi.storage.local.get(SITE_STATUS_KEY),chromeApi.storage.session.get(SITE_STATUS_KEY)]);
  return sites.map(site => {
    const durable=stored[SITE_STATUS_KEY]?.[site.id];
    const old=legacy[SITE_STATUS_KEY]?.[site.id];
    const state=durable?.revision===site.revision ? durable :
      (!durable && old && (!old.checkedAt || old.checkedAt>=site.addedAt) ? old : {});
    const failed=['failed','login_required','unknown','error','release_error'].includes(state.status);
    return {...site,status:failed?'failed':state.status || 'pending',
      paused:failed || state.paused===true,
      ...(failed ? {reason:state.reason || state.status} : {}),
      ...(state.checkedAt ? {checkedAt:state.checkedAt} : {}),
      ...(state.platform ? {platform:state.platform} : {})};
  });
}

export async function reportKeptSite(chromeApi, report) {
  const registered = (await listKeptSites(chromeApi)).some(site => site.id === report?.id && site.revision === report?.revision);
  if (!registered || !['alive','login_required','unknown','error','unsupported','release_error','failed'].includes(report?.status))
    return {ignored:true};
  const states = (await chromeApi.storage.local.get(SITE_STATUS_KEY))[SITE_STATUS_KEY] || {};
  states[report.id] = {revision:report.revision,status:report.status,checkedAt:Date.now(),
    paused:report.paused===true,
    ...(['login_required','unknown','error','release_error'].includes(report.reason)?{reason:report.reason}:{}),
    ...(typeof report.platform === 'string' ? {platform:report.platform} : {})};
  await chromeApi.storage.local.set({[SITE_STATUS_KEY]:states});
  return {ok:true};
}
