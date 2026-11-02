import { randomUUID } from "node:crypto";

/** Durable FIFO queue primitives shared by Runtime queue adapters. */
export class DurableQueueCore {
  constructor(db, now = () => Date.now() / 1000) {
    this.db = db;
    this.now = now;
  }
  _transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  _one(sql, ...args) { return this.db.prepare(sql).get(...args) || null; }
  rows() { return this.db.prepare("SELECT * FROM turns ORDER BY seq").all(); }
  enqueue({thread_id, message, idempotency_key, idempotencyKey, project_id=null, mergeable=false}={}) {
    const key=idempotency_key ?? idempotencyKey;
    if (!thread_id || !message || !key) throw new TypeError("thread_id, message, idempotency_key required");
    if (typeof mergeable !== "boolean") throw new TypeError("mergeable must be a boolean");
    const now=this.now();
    const row=this._transaction(()=>{
      const merged=this._one("SELECT * FROM merged_requests WHERE idem_key=?",key);
      if (merged) {
        if (merged.thread_id!==thread_id || merged.message!==message || merged.project_id!==project_id) throw new Error("idempotency key reused with different payload");
        return this._one("SELECT * FROM turns WHERE id=?",merged.queue_id);
      }
      const same=this._one("SELECT * FROM turns WHERE idem_key=?",key);
      if (same) {
        if (same.thread_id!==thread_id || same.message!==message || same.project_id!==project_id) throw new Error("idempotency key reused with different payload");
        return same;
      }
      const tail=mergeable ? this._one("SELECT * FROM turns WHERE thread_id=? ORDER BY seq DESC LIMIT 1",thread_id) : null;
      if (tail && tail.mergeable && tail.project_id===project_id && ["QUEUED","WAITING"].includes(tail.state)) {
        this.db.prepare("INSERT OR IGNORE INTO merged_requests VALUES(?,?,?,?,?)").run(tail.idem_key,tail.project_id,thread_id,tail.message,tail.id);
        this.db.prepare("INSERT INTO merged_requests VALUES(?,?,?,?,?)").run(key,project_id,thread_id,message,tail.id);
        this.db.prepare("UPDATE turns SET message=message || ? WHERE id=?").run("\n"+message,tail.id);
        return this._one("SELECT * FROM turns WHERE id=?",tail.id);
      }
      const id=randomUUID();
      this.db.prepare("INSERT INTO turns(id,idem_key,project_id,thread_id,message,state,next_check_at,created_at,mergeable) VALUES(?,?,?,?,?,'QUEUED',?,?,?)").run(id,key,project_id,thread_id,message,now,now,mergeable?1:0);
      return this._one("SELECT * FROM turns WHERE id=?",id);
    });
    return {ok:true,status:"queued",queue_id:row.id,thread_id:row.thread_id,state:row.state};
  }
  claim(owner, now=this.now(), leaseSeconds=120) {
    return this._transaction(()=>{
      this.db.prepare("UPDATE turns SET state='UNCERTAIN',lease_owner=NULL,lease_until=NULL WHERE state='SENDING' AND lease_until<=?").run(now);
      this.db.prepare("UPDATE turns SET state='WAITING',lease_owner=NULL,lease_until=NULL,next_check_at=? WHERE state='CHECKING' AND lease_until<=?").run(now,now);
      const row=this._one(`SELECT t.* FROM turns t WHERE t.state IN ('QUEUED','WAITING') AND t.next_check_at<=? AND NOT EXISTS(SELECT 1 FROM turns older WHERE older.thread_id=t.thread_id AND older.seq<t.seq AND (older.state NOT IN ('SENT','CANCELLED') OR (older.state='SENT' AND older.next_check_at>?))) ORDER BY t.seq LIMIT 1`,now,now);
      if (!row) return null;
      this.db.prepare("UPDATE turns SET state='CHECKING',lease_owner=?,lease_until=?,attempts=attempts+1 WHERE id=?").run(owner,now+leaseSeconds,row.id);
      return this._one("SELECT * FROM turns WHERE id=?",row.id);
    });
  }
  cancel(id) {
    return this._transaction(()=>{
      const row=this._one("SELECT * FROM turns WHERE id=?",id);
      if (!row) return {ok:false,queue_id:id,error:"queue item not found"};
      if (row.state!=="QUEUED") return {ok:false,queue_id:id,state:row.state,error:"only queued items can be cancelled"};
      this.db.prepare("UPDATE turns SET state='CANCELLED',lease_owner=NULL,lease_until=NULL WHERE id=? AND state='QUEUED'").run(id);
      return {ok:true,queue_id:id,state:"CANCELLED"};
    });
  }
  list() {
    return {ok:true,items:this.rows().filter(row=>!["SENT","CANCELLED"].includes(row.state)).map(({id,thread_id,state,attempts,created_at,receipt})=>({id,queue_id:id,thread_id,state,attempts,created_at,receipt}))};
  }
}
