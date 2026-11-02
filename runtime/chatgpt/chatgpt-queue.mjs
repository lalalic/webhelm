import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { classifyProbe, PROBE_JS, targetUrl } from "./chatgpt-probe.mjs";
import { CLICK_SEND_JS, SEND_ENABLED_JS } from "./lifecycle-common.mjs";
import { DurableQueueCore } from "../durable-queue-core.mjs";

const transitions = new Set([
  "CHECKING>WAITING",
  "CHECKING>SENDING",
  "CHECKING>BLOCKED",
  "SENDING>SENT",
  "SENDING>UNCERTAIN",
  "UNCERTAIN>SENT",
  "UNCERTAIN>WAITING",
  "BLOCKED>WAITING",
]);

// ChatGPT owns its legacy turns/merged_requests schema and all turn payload,
// idempotency, merge, FIFO partition, and recovery semantics.
const chatgptQueuePolicy = {
  one(db, sql, ...args) { return db.prepare(sql).get(...args) || null; },
  rows(db) { return db.prepare("SELECT * FROM turns ORDER BY seq").all(); },
  enqueue(db, request = {}, now) {
    const {thread_id, message, idempotency_key, idempotencyKey, project_id=null, mergeable=false} = request;
    const key=idempotency_key ?? idempotencyKey;
    if (!thread_id || !message || !key) throw new TypeError("thread_id, message, idempotency_key required");
    if (typeof mergeable !== "boolean") throw new TypeError("mergeable must be a boolean");
    const merged=this.one(db, "SELECT * FROM merged_requests WHERE idem_key=?", key);
    if (merged) {
      if (merged.thread_id!==thread_id || merged.message!==message || merged.project_id!==project_id) throw new Error("idempotency key reused with different payload");
      const row=this.one(db, "SELECT * FROM turns WHERE id=?", merged.queue_id);
      return {ok:true,status:"queued",queue_id:row.id,thread_id:row.thread_id,state:row.state};
    }
    const same=this.one(db, "SELECT * FROM turns WHERE idem_key=?", key);
    if (same) {
      if (same.thread_id!==thread_id || same.message!==message || same.project_id!==project_id) throw new Error("idempotency key reused with different payload");
      return {ok:true,status:"queued",queue_id:same.id,thread_id:same.thread_id,state:same.state};
    }
    const tail=mergeable ? this.one(db, "SELECT * FROM turns WHERE thread_id=? ORDER BY seq DESC LIMIT 1", thread_id) : null;
    // WAITING denotes admitted work being retried; only QUEUED is cancellable
    // and eligible for a new enqueue-time merge.
    if (tail && tail.mergeable && tail.project_id===project_id && tail.state==="QUEUED") {
      db.prepare("INSERT OR IGNORE INTO merged_requests VALUES(?,?,?,?,?)").run(tail.idem_key,tail.project_id,thread_id,tail.message,tail.id);
      db.prepare("INSERT INTO merged_requests VALUES(?,?,?,?,?)").run(key,project_id,thread_id,message,tail.id);
      db.prepare("UPDATE turns SET message=message || ? WHERE id=?").run("\n"+message,tail.id);
      const row=this.one(db, "SELECT * FROM turns WHERE id=?", tail.id);
      return {ok:true,status:"queued",queue_id:row.id,thread_id:row.thread_id,state:row.state};
    }
    const id=randomUUID();
    db.prepare("INSERT INTO turns(id,idem_key,project_id,thread_id,message,state,next_check_at,created_at,mergeable) VALUES(?,?,?,?,?,'QUEUED',?,?,?)").run(id,key,project_id,thread_id,message,now,now,mergeable?1:0);
    return {ok:true,status:"queued",queue_id:id,thread_id,state:"QUEUED"};
  },
  claim(db, owner, now, leaseSeconds) {
    db.prepare("UPDATE turns SET state='UNCERTAIN',lease_owner=NULL,lease_until=NULL WHERE state='SENDING' AND lease_until<=?").run(now);
    db.prepare("UPDATE turns SET state='WAITING',lease_owner=NULL,lease_until=NULL,next_check_at=? WHERE state='CHECKING' AND lease_until<=?").run(now,now);
    const row=this.one(db, `SELECT t.* FROM turns t WHERE t.state IN ('QUEUED','WAITING') AND t.next_check_at<=? AND NOT EXISTS(SELECT 1 FROM turns older WHERE older.thread_id=t.thread_id AND older.seq<t.seq AND (older.state NOT IN ('SENT','CANCELLED') OR (older.state='SENT' AND older.next_check_at>?))) ORDER BY t.seq LIMIT 1`,now,now);
    if (!row) return null;
    db.prepare("UPDATE turns SET state='CHECKING',lease_owner=?,lease_until=?,attempts=attempts+1 WHERE id=?").run(owner,now+leaseSeconds,row.id);
    return this.one(db, "SELECT * FROM turns WHERE id=?", row.id);
  },
  // A queue adapter registers a display description; Actions stay unaware of queues.
  describe(row) {
    const firstLine = row.message.split(/\r?\n/, 1)[0].replace(/\s+/g, ' ').trim();
    const title = firstLine ? (firstLine.length > 52 ? `${firstLine.slice(0, 51)}…` : firstLine) : 'ChatGPT message';
    const prefix = row.project_id ? `/g/${encodeURIComponent(row.project_id)}` : '';
    return {platform:'ChatGPT', title, url:`https://chatgpt.com${prefix}/c/${encodeURIComponent(row.thread_id)}`};
  },
  cancel(db, id) {
    const row=this.one(db, "SELECT * FROM turns WHERE id=?", id);
    if (!row) return {ok:false,queue_id:id,error:"queue item not found"};
    if (!["QUEUED","WAITING","BLOCKED","UNCERTAIN"].includes(row.state)) return {ok:false,queue_id:id,state:row.state,error:"cannot remove a running or completed item"};
    db.prepare("UPDATE turns SET state='CANCELLED',lease_owner=NULL,lease_until=NULL WHERE id=? AND state IN ('QUEUED','WAITING','BLOCKED','UNCERTAIN')").run(id);
    return {ok:true,queue_id:id,state:"CANCELLED"};
  },
  list(db) {
    return {ok:true,items:this.rows(db).filter(row=>!["SENT","CANCELLED"].includes(row.state)).map(({id,thread_id,state,attempts,created_at,receipt})=>({id,queue_id:id,thread_id,state,attempts,created_at,receipt}))};
  },
};

export class ChatGPTQueue extends DurableQueueCore {
  constructor(
    {
      persistenceRoot,
      startSession,
      execSession,
      stopSession,
      intervalMs = 60000,
      concurrency = 4,
      leaseSeconds = 120,
      now = () => Date.now() / 1000,
      logger = () => {},
    } = {},
  ) {
    if (!persistenceRoot) throw new TypeError("persistenceRoot is required");
    for (
      const [name, fn] of Object.entries({
        startSession,
        execSession,
        stopSession,
      })
    ) {
      if (typeof fn !== "function") {
        throw new TypeError(`${name} callback is required`);
      }
    }
    const root = resolve(persistenceRoot);
    mkdirSync(root, { recursive: true });
    const dbPath = join(root, "chatgpt-new-turn.sqlite3");
    const db = new DatabaseSync(dbPath);
    db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000",
    );
    db.exec(
      `CREATE TABLE IF NOT EXISTS turns(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,idem_key TEXT NOT NULL UNIQUE,project_id TEXT,thread_id TEXT NOT NULL,message TEXT NOT NULL,state TEXT NOT NULL,lease_owner TEXT,lease_until REAL,next_check_at REAL NOT NULL,created_at REAL NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,receipt TEXT,mergeable INTEGER NOT NULL DEFAULT 0); CREATE INDEX IF NOT EXISTS turns_thread_order ON turns(thread_id,seq); CREATE TABLE IF NOT EXISTS merged_requests(idem_key TEXT PRIMARY KEY,project_id TEXT,thread_id TEXT NOT NULL,message TEXT NOT NULL,queue_id TEXT NOT NULL);`,
    );
    super(db, chatgptQueuePolicy, now, {
      concurrency: Math.min(4, Math.max(1, Number(concurrency) || 4)), intervalMs,
    });
    this.root = root;
    this.dbPath = dbPath;
    this.db = db;
    this.startSession = startSession;
    this.execSession = execSession;
    this.stopSession = stopSession;
    this.leaseSeconds = leaseSeconds;
    this.logger = logger;
    this.sessions = new Map();
  }
  enqueue(request) {
    const result = super.enqueue(request);
    if (this.started) this._wake(0);
    return result;
  }
  _one(sql, ...args) { return this.db.prepare(sql).get(...args) || null; }
  claim(owner, now = this.now()) { return super.claim(owner, now, this.leaseSeconds); }
  transition(
    id,
    owner,
    source,
    target,
    { now = this.now(), delay = 60, receipt = null } = {},
  ) {
    if (!transitions.has(`${source}>${target}`)) {
      throw new Error("invalid transition");
    }
    if (source === "UNCERTAIN" && !receipt) {
      throw new Error("UNCERTAIN requires reconciliation evidence");
    }
    if (source === "BLOCKED" && !receipt) {
      throw new Error("BLOCKED requires unblock evidence");
    }
    return this._transaction(() => {
      const row = this._one("SELECT * FROM turns WHERE id=?", id);
      if (!row || row.state !== source) throw new Error("stale state");
      if (
        ["CHECKING", "SENDING"].includes(source) && row.lease_owner !== owner
      ) throw new Error("stale owner");
      if (["CHECKING", "SENDING"].includes(source) && row.lease_until <= now) {
        throw new Error("expired lease");
      }
      const release = ["WAITING", "SENT", "UNCERTAIN", "BLOCKED"].includes(
        target,
      );
      this.db.prepare(
        "UPDATE turns SET state=?,lease_owner=?,lease_until=?,next_check_at=?,receipt=? WHERE id=?",
      ).run(
        target,
        release ? null : owner,
        release ? null : now + 120,
        ["WAITING", "SENT"].includes(target) ? now + delay : now,
        receipt,
        id,
      );
    });
  }
  inspect() { return this.list(); }
  reconcile({ queue_id, evidence, accepted } = {}) {
    if (!queue_id || !evidence || typeof accepted !== "boolean") {
      throw new TypeError("queue_id, evidence and boolean accepted required");
    }
    this.transition(
      queue_id,
      "reconciler",
      "UNCERTAIN",
      accepted ? "SENT" : "WAITING",
      { receipt: evidence, delay: 0 },
    );
    if (this.started) this._wake(0);
    return { ok: true, queue_id, state: accepted ? "SENT" : "WAITING" };
  }
  process(item) { return this._process(item); }
  onDispatchError(error) { this.logger({event:"dispatcher_error",error:String(error)}); }
  async _exec(sid, code) {
    const response = await this.execSession(sid, code);
    if (response?.ok === false) {
      throw new Error(
        response.error || response.stderr || "browser action failed",
      );
    }
    return response?.value ?? response;
  }
  async _probe(item) {
    const url = targetUrl(item.project_id, item.thread_id, item.message);
    const session = await this.startSession({ url });
    const sid = session.session_id ?? session.sessionId;
    if (!sid) throw new Error("session start returned no session_id");
    this.sessions.set(item.id, sid);
    const deadline = Date.now() + 45000;
    let state = "NOT_READY";
    while (Date.now() < deadline) {
      const source =
        `await (async()=>{ const page=await page_info(); const state=await js(${
          JSON.stringify(PROBE_JS)
        }); if(state?.state==='READY' && !(await js(${
          JSON.stringify(SEND_ENABLED_JS)
        }))) state.state='NOT_READY'; return {url:page.url||'',state}; })()`;
      const result = await this._exec(sid, source);
      state = classifyProbe(result.url, url, result.state);
      if (["READY", "RUNNING", "BLOCKED"].includes(state)) return state;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    return state;
  }
  async _send(item) {
    const sid = this.sessions.get(item.id);
    if (!sid) throw new Error("missing prepared browser session");
    const expected =
      targetUrl(item.project_id, item.thread_id, item.message).split("?")[0];
    const source = `await (async()=>{ const gate=await js(${
      JSON.stringify(PROBE_JS)
    }); const gateUrl=(await page_info()).url||''; let receipt={diagnostic:'pre_send_gate_not_ready'}; if(gate?.state==='READY' && await js(${
      JSON.stringify(SEND_ENABLED_JS)
    }) && Boolean((gate.composer_text||'').trim()) && gateUrl===${
      JSON.stringify(expected)
    } && await js(${
      JSON.stringify(CLICK_SEND_JS)
    })){ const until=Date.now()+30000; let disabled=false; while(Date.now()<until){ disabled=!(await js(${
      JSON.stringify(SEND_ENABLED_JS)
    })); if(disabled) break; await new Promise(resolve=>setTimeout(resolve,200)); } receipt=disabled?{verified_by:'send-button-disabled'}:{diagnostic:'post_submit_send_state_unverified'}; } return receipt; })()`;
    return this._exec(sid, source);
  }
  async _finish(id) {
    const sid = this.sessions.get(id);
    this.sessions.delete(id);
    if (sid) {
      try {
        await this.stopSession(sid);
      } catch (e) {
        this.logger({ event: "stop_session_error", error: String(e) });
      }
    }
  }
  _safeDiagnostic(error) {
    const raw = String(error);
    const safe =
      /^(?:workspace\.acquireIdentity|session_identity_timeout|chatgpt_queue_unavailable|daemon_retiring)(?::[A-Za-z0-9_.-]{1,32})?$/
          .test(raw)
        ? raw
        : "redacted";
    const fingerprint = createHash("sha256").update(raw).digest("hex").slice(
      0,
      16,
    );
    return `${
      error?.name || "Error"
    };message=${safe};fingerprint=${fingerprint}`.slice(0, 480);
  }
  async _process(item) {
    const owner = item.lease_owner;
    try {
      const state = await this._probe(item);
      if (state === "RUNNING") {
        this.transition(item.id, owner, "CHECKING", "WAITING", {
          delay: this.intervalMs / 1000,
          receipt: "stop_visible",
        });
        return;
      }
      if (state === "BLOCKED") {
        this.transition(item.id, owner, "CHECKING", "BLOCKED", {
          receipt: "page blocked",
        });
        return;
      }
      if (state !== "READY") {
        this.transition(item.id, owner, "CHECKING", "WAITING", {
          delay: this.intervalMs / 1000,
          receipt: `probe_${state.toLowerCase()}`,
        });
        return;
      }
      this.transition(item.id, owner, "CHECKING", "SENDING");
      const receipt = await this._send(item);
      if (receipt?.verified_by !== "send-button-disabled") {
        this.transition(item.id, owner, "SENDING", "UNCERTAIN", {
          receipt: receipt?.diagnostic || "missing_user_turn_receipt",
        });
      } else {this.transition(item.id, owner, "SENDING", "SENT", {
          receipt: "send-button-disabled",
        });}
    } catch (e) {
      const diagnostic = this._safeDiagnostic(e),
        current = this._one("SELECT * FROM turns WHERE id=?", item.id);
      if (current?.state === "SENDING") {
        this.transition(item.id, owner, "SENDING", "UNCERTAIN", {
          receipt: diagnostic,
        });
      } else if (current?.state === "CHECKING") {
        this.transition(item.id, owner, "CHECKING", "WAITING", {
          delay: this.intervalMs / 1000,
          receipt: `probe_error_${diagnostic}`,
        });
      }
    } finally {
      await this._finish(item.id);
    }
  }
  async shutdown() {
    if (this.closed) return;
    await this.stopScheduler();
    for (const id of [...this.sessions.keys()]) await this._finish(id);
    this.db.close();
  }
  close() {
    return this.shutdown();
  }
}
export function createChatGPTQueue(options) {
  return new ChatGPTQueue(options);
}
