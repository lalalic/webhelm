import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DurableQueueCore } from './durable-queue-core.mjs';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, canonical(value[key])]),
  );
  return value;
}
export function fingerprint(config) {
  return createHash('sha256').update(JSON.stringify(canonical(config))).digest('hex');
}
function normalize(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw TypeError('queue action config must be an object');
  const value = {...config};
  if (typeof value.idempotency_key !== 'string' || !value.idempotency_key.trim()) throw TypeError('idempotency_key required');
  if (value.mergeable !== undefined && typeof value.mergeable !== 'boolean') throw TypeError('mergeable must be boolean');
  return value;
}
function requiredString(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw TypeError(`${name} must return a nonempty string`);
  return value;
}
function display(policy, config) {
  const title = requiredString(policy.title(config), 'title');
  const group = requiredString(policy.group(config), 'group');
  let url = null;
  if (typeof policy.url === 'function') {
    url = policy.url(config);
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash)
      throw TypeError('queue url must be HTTPS without credentials, query or fragment');
  }
  return {title,group,url};
}

// Queue-neutral persistence: every policy runs in its own SQLite database.
// No browser/site rules live in this adapter.
const dbPolicy = {
  rows(db) { return db.prepare('SELECT * FROM items ORDER BY seq').all(); },
  enqueue(db, request, now) {
    const config = normalize(request);
    const key = config.idempotency_key;
    const hash = fingerprint(config);
    const same = db.prepare('SELECT queue_id,payload_hash FROM request_keys WHERE idem_key=?').get(key);
    if (same) {
      if (same.payload_hash !== hash) throw Error('idempotency key reused with different payload');
      const row = db.prepare('SELECT id,state,group_key FROM items WHERE id=?').get(same.queue_id);
      if (!row) throw Error('orphaned idempotency reference');
      return {ok:true,status:'queued',queue_id:row.id,state:row.state,group:row.group_key};
    }
    const meta = display(this.definition, config);
    const tail = db.prepare('SELECT * FROM items WHERE group_key=? ORDER BY seq DESC LIMIT 1').get(meta.group);
    if (tail && config.mergeable === true && ['QUEUED','WAITING'].includes(tail.state) &&
        tail.lease_owner === null && typeof this.definition.merge === 'function') {
      const previous = JSON.parse(tail.payload_json);
      if (previous.mergeable === true) {
        const merged = this.definition.merge(previous, config);
        if (merged !== null && merged !== undefined) {
          if (!merged || typeof merged !== 'object' || Array.isArray(merged)) throw TypeError('merge must return config or null');
          const mergedMeta = display(this.definition, merged);
          if (mergedMeta.group !== meta.group) throw Error('merge must preserve group');
          if (merged.idempotency_key!==previous.idempotency_key) throw Error('merge must preserve original idempotency key');
          if (merged.mergeable!==true) throw Error('merge must preserve mergeable eligibility');
          db.prepare('UPDATE items SET payload_json=?,title=?,url=? WHERE id=?')
            .run(JSON.stringify(merged),mergedMeta.title,mergedMeta.url,tail.id);
          db.prepare('INSERT INTO request_keys(idem_key,queue_id,payload_hash) VALUES(?,?,?)').run(key,tail.id,hash);
          return {ok:true,status:'queued',queue_id:tail.id,state:tail.state,group:meta.group};
        }
      }
    }
    const id = randomUUID();
    db.prepare(`INSERT INTO items(id,group_key,payload_json,title,url,state,next_check_at,created_at)
                VALUES(?,?,?,?,?,'QUEUED',?,?)`)
      .run(id,meta.group,JSON.stringify(config),meta.title,meta.url,now,now);
    db.prepare('INSERT INTO request_keys(idem_key,queue_id,payload_hash) VALUES(?,?,?)').run(key,id,hash);
    return {ok:true,status:'queued',queue_id:id,state:'QUEUED',group:meta.group};
  },
  claim(db, owner, now, leaseSeconds) {
    db.prepare("UPDATE items SET state='FAILED',lease_owner=NULL,lease_until=NULL,receipt=COALESCE(receipt,'send_interrupted') WHERE state='SENDING' AND lease_until<=?").run(now);
    db.prepare("UPDATE items SET state='WAITING',lease_owner=NULL,lease_until=NULL,next_check_at=? WHERE state='CHECKING' AND lease_until<=?").run(now,now);
    const row = db.prepare(`SELECT item.* FROM items item WHERE item.state IN ('QUEUED','WAITING') AND item.next_check_at<=?
      AND NOT EXISTS (SELECT 1 FROM items older WHERE older.group_key=item.group_key AND older.seq<item.seq
        AND (older.state NOT IN ('SENT','FAILED','CANCELLED') OR (older.state='SENT' AND older.next_check_at>?)))
      ORDER BY item.seq LIMIT 1`).get(now,now);
    if (!row) return null;
    db.prepare("UPDATE items SET state='CHECKING',lease_owner=?,lease_until=?,attempts=attempts+1 WHERE id=?")
      .run(owner,now+leaseSeconds,row.id);
    return db.prepare('SELECT * FROM items WHERE id=?').get(row.id);
  },
  cancel(db, id) {
    const row = db.prepare('SELECT state FROM items WHERE id=?').get(id);
    if (!row) return {ok:false,queue_id:id,error:'queue item not found'};
    if (!['QUEUED','WAITING'].includes(row.state)) return {ok:false,queue_id:id,state:row.state,error:'cannot remove a running or completed item'};
    db.prepare("UPDATE items SET state='CANCELLED' WHERE id=? AND state IN ('QUEUED','WAITING') AND lease_owner IS NULL").run(id);
    return {ok:true,queue_id:id,state:'CANCELLED'};
  },
  list(db) {
    const items = db.prepare("SELECT * FROM items WHERE state NOT IN ('SENT','CANCELLED') ORDER BY seq").all();
    return {ok:true,items:items.map(row => ({id:row.id,queue_id:row.id,group:row.group_key,
      state:row.state,attempts:row.attempts,created_at:row.created_at,
      receipt:row.receipt,title:row.title,url:row.url}))};
  },
};

export class PlatformDeliveryQueue extends DurableQueueCore {
  constructor({platform,queue,definition,persistenceRoot,startSession,stopSession,runAction,
    intervalMs,concurrency,leaseSeconds=600,now=()=>Date.now()/1000,logger=()=>{}}) {
    if (!/^[a-z0-9-]+$/.test(platform) || !/^[a-z0-9-]+$/.test(queue)) throw TypeError('invalid queue identity');
    const dir=join(persistenceRoot,'queues',platform);
    mkdirSync(dir,{recursive:true});
    const dbPath=join(dir,`${queue}.sqlite3`);
    const db=new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000');
    db.exec(`CREATE TABLE IF NOT EXISTS items(
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, group_key TEXT NOT NULL,
      payload_json TEXT NOT NULL, title TEXT NOT NULL, url TEXT, state TEXT NOT NULL,
      lease_owner TEXT, lease_until REAL, next_check_at REAL NOT NULL, created_at REAL NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, receipt TEXT);
      CREATE INDEX IF NOT EXISTS queue_group_fifo ON items(group_key,seq);
      CREATE TABLE IF NOT EXISTS request_keys(idem_key TEXT PRIMARY KEY,queue_id TEXT NOT NULL,payload_hash TEXT NOT NULL);`);
    const adapter=Object.create(dbPolicy);
    super(db,adapter,now,{concurrency:concurrency??definition.concurrency??1,intervalMs:intervalMs??definition.intervalMs??10000});
    adapter.definition=definition;
    this.definition=definition;
    this.platform=platform;
    this.queue=queue;
    this.dbPath=dbPath;
    this.startSession=startSession;
    this.stopSession=stopSession;
    this.runAction=runAction;
    this.leaseSeconds=leaseSeconds;
    this.logger=logger;
    this.enabled=true;
    this.databaseClosed=false;
  }
  setDefinition(definition) {
    this.definition=definition;
    this.policy.definition=definition;
    this.concurrency=Math.max(1,Math.min(32,definition.concurrency??1));
    this.intervalMs=definition.intervalMs??10000;
    this.enabled=true;
    if (this.started) this._wake(0);
  }
  enqueue(config) {
    if (!this.enabled) throw Error('queue registration not active');
    const result=super.enqueue(config);
    if (this.started) this._wake(0);
    return {...result,platform:this.platform,queue:this.queue};
  }
  claim(owner, now=this.now()) {
    if (!this.enabled) return null;
    return super.claim(owner,now,this.leaseSeconds);
  }
  list() {
    const result=super.list();
    return {...result,items:result.items.map(item=>{
      const row=this.db.prepare('SELECT payload_json FROM items WHERE id=?').get(item.id);
      let title=item.title,url=item.url;
      try {
        const config=JSON.parse(row.payload_json);
        const displayValue=display(this.definition,config);
        title=displayValue.title;url=displayValue.url;
      } catch { /* Preserve the previously validated display data. */ }
      return {...item,title,url,platform:this.platform,queue:this.queue};
    })};
  }
  has(id) { return Boolean(this.db.prepare('SELECT 1 FROM items WHERE id=?').get(id)); }
  transition(id,owner,from,to,{delay=0,receipt=null}={}) {
    const now=this.now();
    return this._transaction(()=>{
      const row=this.db.prepare('SELECT state,lease_owner,lease_until FROM items WHERE id=?').get(id);
      if (!row || row.state!==from || row.lease_owner!==owner || row.lease_until<=now) throw Error('stale queue lease');
      this.db.prepare('UPDATE items SET state=?,lease_owner=?,lease_until=?,next_check_at=?,receipt=? WHERE id=?')
        .run(to,['SENT','FAILED','WAITING'].includes(to)?null:owner,
          ['SENT','FAILED','WAITING'].includes(to)?null:now+this.leaseSeconds,
          now+delay,receipt,id);
    });
  }
  process(item) { return this._process(item); }
  onDispatchError(error) { this.logger({event:'queue_dispatch_error',platform:this.platform,queue:this.queue,error:String(error)}); }
  async _process(item) {
    const definition=this.definition;
    const config=JSON.parse(item.payload_json);
    let sid;
    // Renew a live worker lease while it is inside the browser Action Runner.
    // A slow but active Action must not unblock a second send in the same group.
    const heartbeat=setInterval(()=>{
      try {
        this.db.prepare(`UPDATE items SET lease_until=? WHERE id=? AND lease_owner=? AND state IN ('CHECKING','SENDING')`)
          .run(this.now()+this.leaseSeconds,item.id,item.lease_owner);
      } catch(error) { this.onDispatchError(error); }
    },Math.min(30000,Math.max(1000,this.leaseSeconds*250)));
    heartbeat.unref?.();
    try {
      const started=await this.startSession({url:item.url||'about:blank',workspace:'WebHelm'});
      sid=started.session_id??started.sessionId;
      if (!sid) throw Error('queue Session creation did not return session_id');
      const checked=await this.runAction({platform:this.platform,action:definition.validate,config,session_id:sid});
      if (checked?.result?.ok !== true) {
        // A failed read-only gate must not silently drop its FIFO head.
        this.transition(item.id,item.lease_owner,'CHECKING','WAITING',{
          delay:this.intervalMs/1000,receipt:'validate_error',
        });
        return;
      }
      const value=checked.result.value;
      const ready=checked?.result?.ok === true && (value === true || value?.ready === true || value?.status === 'ready');
      if (!ready) {
        this.transition(item.id,item.lease_owner,'CHECKING','WAITING',{
          delay:this.intervalMs/1000,
          receipt:'not_ready',
        });
        return;
      }
      this.transition(item.id,item.lease_owner,'CHECKING','SENDING');
      const outcome=await this.runAction({platform:this.platform,action:definition.action,
        config:typeof definition.execute==='function'?definition.execute(config):config,session_id:sid});
      if (outcome?.result?.ok!==true ||
          (typeof definition.success==='function' && definition.success(outcome.result.value)!==true))
        throw Error('action_failed');
      this.transition(item.id,item.lease_owner,'SENDING','SENT',{
        delay:this.intervalMs/1000,receipt:outcome.result.value?.verified_by || 'action_completed',
      });
    } catch(error) {
      const diagnostic='Error;fingerprint='+createHash('sha256').update(String(error)).digest('hex').slice(0,16);
      try {
        const row=this.db.prepare('SELECT state FROM items WHERE id=?').get(item.id);
        if (row?.state==='SENDING') this.transition(item.id,item.lease_owner,'SENDING','FAILED',{receipt:diagnostic});
        else if (row?.state==='CHECKING') this.transition(item.id,item.lease_owner,'CHECKING','WAITING',{delay:this.intervalMs/1000,receipt:diagnostic});
      } catch(transitionError) { this.onDispatchError(transitionError); }
    } finally {
      clearInterval(heartbeat);
      if (sid) try { await this.stopSession(sid); }
      catch(error) { this.logger({event:'queue_session_release_failed',platform:this.platform,error:String(error)}); }
    }
  }
  async shutdown() {
    if (this.databaseClosed) return;
    await this.stopScheduler();
    this.db.close();
    this.databaseClosed=true;
  }
}
