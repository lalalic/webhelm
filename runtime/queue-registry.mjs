import {watch, existsSync, readdirSync, readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {parse as parseYaml} from 'yaml';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {PLATFORMS} from './platforms.mjs';
import {PlatformDeliveryQueue} from './platform-delivery-queue.mjs';

const validName=/^[a-z0-9][a-z0-9-]*$/;
function definitions(root) {
  const files=new Map();
  if (!existsSync(root)) return files;
  for (const platform of readdirSync(root,{withFileTypes:true})) {
    if (!platform.isDirectory() || !validName.test(platform.name)) continue;
    const site=join(root,platform.name);
    if (!existsSync(join(site,'manifest.yaml'))) continue;
    const dir=join(site,'queues');
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir,{withFileTypes:true})) {
      if (!entry.isFile() || !entry.name.endsWith('.mjs')) continue;
      const queue=entry.name.slice(0,-4);
      if (!validName.test(queue)) continue;
      const file=join(dir,entry.name);
      const hash=createHash('sha256').update(readFileSync(file)).digest('hex');
      files.set(`${platform.name}/${queue}`,{platform:platform.name,queue,file,signature:hash});
    }
  }
  return files;
}
function validPolicy(definition, platform, root) {
  if (!definition || typeof definition!=='object') throw TypeError('queue policy must export an object');
  if (typeof definition.group!=='function' || typeof definition.title!=='function') throw TypeError('queue policy needs group(action) and title(action)');
  if (typeof definition.action!=='string' || typeof definition.validate!=='string') throw TypeError('queue policy needs action and validate action names');
  const manifest=parseYaml(readFileSync(join(root,platform,'manifest.yaml'),'utf8'));
  if (manifest?.platform!==platform) throw Error('queue platform manifest mismatch');
  for (const name of [definition.action,definition.validate]) {
    const relative=manifest.actions?.[name];
    if (typeof relative!=='string' || !/^actions\/[\w-]+\.mjs$/.test(relative) ||
        !existsSync(join(root,platform,relative))) throw Error(`unknown or missing queue action: ${platform}/${name}`);
  }
  for (const name of ['merge','execute','url','success']) {
    if (definition[name]!==undefined && typeof definition[name]!=='function') throw TypeError(`${name} must be a function`);
  }
  if (definition.concurrency!==undefined && (!Number.isInteger(definition.concurrency) || definition.concurrency<1 || definition.concurrency>32)) throw TypeError('concurrency must be 1..32');
  if (definition.intervalMs!==undefined && (!Number.isInteger(definition.intervalMs) || definition.intervalMs<100 || definition.intervalMs>3600000)) throw TypeError('intervalMs must be 100..3600000');
}

export class PlatformQueueRegistry {
  constructor({platformsRoot=PLATFORMS,persistenceRoot,startSession,stopSession,runAction,
    logger=()=>{},pollMs=10000,paused=false}={}) {
    this.platformsRoot=resolve(platformsRoot);
    this.persistenceRoot=persistenceRoot;
    this.startSession=startSession;
    this.stopSession=stopSession;
    this.runAction=runAction;
    this.logger=logger;
    this.pollMs=pollMs;
    this.paused=paused;
    this.records=new Map();
    this.watchers=new Map();
    this.refreshing=Promise.resolve();
    this.timer=null;
    this.interval=null;
    this.closed=false;
  }
  async refresh() {
    this.refreshing=this.refreshing.catch(()=>{}).then(()=>this._refresh());
    return this.refreshing;
  }
  async _refresh() {
    if (this.closed) return;
    const found=definitions(this.platformsRoot);
    for (const [key,entry] of found) {
      const existing=this.records.get(key);
      if (existing && existing.signature===entry.signature) {
        existing.instance.enabled=true;
        continue;
      }
      try {
        const module=await import(pathToFileURL(entry.file).href+`?version=${encodeURIComponent(entry.signature)}`);
        const definition=module.default;
        validPolicy(definition,entry.platform,this.platformsRoot);
        if (existing) {
          existing.instance.setDefinition(definition);
          existing.signature=entry.signature;
          continue;
        }
        const instance=new PlatformDeliveryQueue({platform:entry.platform,queue:entry.queue,definition,
          persistenceRoot:this.persistenceRoot,startSession:this.startSession,stopSession:this.stopSession,
          runAction:this.runAction,logger:this.logger});
        this.records.set(key,{instance,signature:entry.signature});
        if (!this.paused) instance.start();
      } catch(error) {
        this.logger({event:'queue_policy_load_failed',key,error:String(error)});
      }
    }
    for (const [key,record] of this.records) {
      if (!found.has(key)) record.instance.enabled=false; // Preserve data; do not drop an in-flight worker.
    }
    this._syncWatchers();
  }
  _syncWatchers() {
    const dirs=new Set([this.platformsRoot]);
    if (existsSync(this.platformsRoot)) for (const item of readdirSync(this.platformsRoot,{withFileTypes:true})) {
      if (!item.isDirectory()) continue;
      const dir=join(this.platformsRoot,item.name);
      dirs.add(dir);
      if (existsSync(join(dir,'queues'))) dirs.add(join(dir,'queues'));
    }
    for (const [dir,watcher] of this.watchers) if (!dirs.has(dir)) {
      watcher.close();this.watchers.delete(dir);
    }
    for (const dir of dirs) {
      if (this.watchers.has(dir) || !existsSync(dir)) continue;
      try {
        const watcher=watch(dir,()=>this._scheduleRefresh());
        watcher.on('error',error=>this.logger({event:'queue_watch_error',dir,error:String(error)}));
        this.watchers.set(dir,watcher);
      } catch(error) { this.logger({event:'queue_watch_error',dir,error:String(error)}); }
    }
  }
  _scheduleRefresh() {
    if (this.closed) return;
    clearTimeout(this.timer);
    this.timer=setTimeout(()=>this.refresh().catch(error=>this.logger({event:'queue_refresh_error',error:String(error)})),100);
    this.timer.unref?.();
  }
  async start() {
    await this.refresh();
    this.interval=setInterval(()=>this._scheduleRefresh(),this.pollMs);
    this.interval.unref?.();
    return this;
  }
  setPaused(paused) {
    this.paused=Boolean(paused);
    for (const {instance} of this.records.values()) {
      if (this.paused) { instance.started=false;clearTimeout(instance.wakeTimer); }
      else {instance.started=false;instance.start();}
    }
  }
  get(platform,queue) {
    const entry=this.records.get(`${platform}/${queue}`);
    if (!entry || !entry.instance.enabled) throw Error(`queue not registered: ${platform}/${queue}`);
    return entry.instance;
  }
  enqueue({platform,queue,config}) { return this.get(platform,queue).enqueue(config); }
  list() { return {ok:true,items:[...this.records.values()].flatMap(({instance})=>instance.list().items)}; }
  cancel(id) {
    for (const {instance} of this.records.values()) if (instance.has(id)) return instance.cancel(id);
    return {ok:false,queue_id:id,error:'queue item not found'};
  }
  activeCount() { return [...this.records.values()].reduce((sum,{instance})=>sum+instance.active.size,0); }
  async stopScheduler() { this.paused=true;await Promise.all([...this.records.values()].map(({instance})=>instance.stopScheduler())); }
  async shutdown() {
    this.closed=true;
    clearTimeout(this.timer);clearInterval(this.interval);
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    await this.refreshing.catch(()=>{});
    await Promise.all([...this.records.values()].map(({instance})=>instance.shutdown()));
  }
}
