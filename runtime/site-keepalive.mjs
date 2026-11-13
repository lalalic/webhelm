import {listPlatforms, platformManifest, actionPath} from './platforms.mjs';

const MAX_INTERVAL_MINUTES = 24 * 60;
const MIN_INTERVAL_MINUTES = 5;

function matchingOrigin(pattern, origin) {
  try { return new URL(String(pattern).replaceAll('*','webhelm-wildcard')).origin === origin; }
  catch { return false; }
}

// A platform opts in through a manifest keep_alive declaration. There is NO
// generic web request or URL ping: only its own read-only Action can decide
// whether a login is alive, expired, or unknown.
export function resolveSiteHeartbeat(site, names=listPlatforms, manifestFor=platformManifest, actionFor=actionPath) {
  let origin;
  try {
    const url = new URL(site?.url);
    if (!site?.enabled || url.protocol !== 'https:' || url.origin !== site.id || url.href !== `${url.origin}/`) return null;
    origin = url.origin;
  } catch { return null; }
  for (const platform of names()) {
    const manifest = manifestFor(platform);
    const conf = manifest.keep_alive;
    if (!conf || conf.enabled === false || !Array.isArray(manifest.url_patterns) ||
        !manifest.url_patterns.some(pattern => matchingOrigin(pattern,origin))) continue;
    const action = conf.action || 'heartbeat';
    actionFor(platform,action); // Ensure only declared local Actions execute.
    const minutes = Number(conf.interval_minutes ?? 30);
    if (!Number.isFinite(minutes) || minutes < MIN_INTERVAL_MINUTES || minutes > MAX_INTERVAL_MINUTES)
      throw Error(`Invalid keep_alive interval for ${platform}`);
    const target = new URL(conf.url || site.url);
    if (target.protocol !== 'https:' || target.origin !== origin || target.username || target.password ||
        target.search || target.hash) throw Error(`Invalid keep_alive URL for ${platform}`);
    return {platform,action,url:target.href,intervalMs:minutes*60000};
  }
  return null;
}

export function createSiteKeepaliveScheduler({listSites, report, run, resolve=resolveSiteHeartbeat,
  now=Date.now, canRun=async()=>true}) {
  const next = new Map();
  let active = false;
  return {
    async tick() {
      if (active) return {busy:true};
      active=true;
      try {
        const sites=await listSites();
        const known=new Set(sites.map(s=>s.id));
        for (const id of next.keys()) if (!known.has(id)) next.delete(id);
        for (const site of sites) {
          const nextCheck=next.get(site.id);
          if (nextCheck && nextCheck.revision === site.revision && now() < nextCheck.at) continue;
          let plan;
          try {plan = resolve(site);} catch {plan=null; }
          if (!plan) {
            next.set(site.id,{at:now()+5*60000,revision:site.revision});
            await report({id:site.id,revision:site.revision,status:'unsupported'});
            continue;
          }
          if (!await canRun()) return {deferred:true};
          // Set deadline before running to prevent concurrent retries during
          // slow site actions. No automatic replay of timed-out actions.
          next.set(site.id,{at:now()+plan.intervalMs,revision:site.revision});
          let status='error';
          try {
            const result=await run({...plan,site});
            status=['alive','login_required','unknown'].includes(result?.status)?result.status:'unknown';
          } catch { /* No secret URLs, cookies, or Action traces in the popup. */ }
          if (status !== 'alive') next.set(site.id,{at:now()+Math.min(plan.intervalMs,5*60000),revision:site.revision});
          await report({id:site.id,revision:site.revision,platform:plan.platform,status});
          return {id:site.id,status}; // At most one site check per scheduler tick.
        }
        return {idle:true};
      } finally {active=false;}
    },
  };
}
