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

export async function listKeptSites(chromeApi) {
  const record = (await chromeApi.storage.local.get(SITE_STORAGE_KEY))[SITE_STORAGE_KEY];
  return Array.isArray(record) ? record.filter(site => site && typeof site.id === 'string' &&
    typeof site.url === 'string' && site.id === site.url && site.enabled === true) : [];
}

export async function setKeptSite(chromeApi, url, enabled) {
  const id = siteOrigin(url);
  const sites = (await listKeptSites(chromeApi)).filter(site => site.id !== id);
  if (enabled) sites.push({id, url:id, enabled:true, addedAt:Date.now(), revision:crypto.randomUUID()});
  sites.sort((a,b) => a.id.localeCompare(b.id));
  await chromeApi.storage.local.set({[SITE_STORAGE_KEY]: sites});
  if (!enabled) {
    const states = (await chromeApi.storage.session.get(SITE_STATUS_KEY))[SITE_STATUS_KEY] || {};
    delete states[id];
    await chromeApi.storage.session.set({[SITE_STATUS_KEY]: states});
  }
  return {id, enabled:Boolean(enabled), sites};
}

export async function sitesWithStatus(chromeApi) {
  const [sites, stored] = await Promise.all([listKeptSites(chromeApi),chromeApi.storage.session.get(SITE_STATUS_KEY)]);
  const states = stored[SITE_STATUS_KEY] || {};
  return sites.map(site => ({...site, status:states[site.id]?.status || 'pending',
    ...(states[site.id]?.checkedAt ? {checkedAt:states[site.id].checkedAt} : {}),
    ...(states[site.id]?.platform ? {platform:states[site.id].platform} : {})}));
}

export async function reportKeptSite(chromeApi, report) {
  const registered = (await listKeptSites(chromeApi)).some(site => site.id === report?.id && site.revision === report?.revision);
  if (!registered || !['alive','login_required','unknown','error','unsupported'].includes(report?.status))
    return {ignored:true};
  const states = (await chromeApi.storage.session.get(SITE_STATUS_KEY))[SITE_STATUS_KEY] || {};
  states[report.id] = {status:report.status,checkedAt:Date.now(),
    ...(typeof report.platform === 'string' ? {platform:report.platform} : {})};
  await chromeApi.storage.session.set({[SITE_STATUS_KEY]:states});
  return {ok:true};
}
