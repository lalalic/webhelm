import { randomUUID } from "node:crypto";

/**
 * Queue-neutral transaction boundary for durable queue policies.
 *
 * Policies own their persistence schema, idempotency and payload semantics,
 * merge rules, partition ordering, recovery rules, and public receipts. Every
 * mutating operation is run in one immediate transaction so policy decisions
 * (including optional enqueue-time merges) are atomic with persistence.
 */
export class DurableQueueCore {
  constructor(db, policy, now = () => Date.now() / 1000, {concurrency = 1, intervalMs = 1000} = {}) {
    if (!db || !policy) throw new TypeError("db and queue policy are required");
    this.db = db;
    this.policy = policy;
    this.now = now;
    this.concurrency = Math.max(1, Number(concurrency) || 1);
    this.intervalMs = intervalMs;
    this.active = new Map();
    this.started = false;
    this.closed = false;
    this.wakeTimer = null;
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
  rows() { return this.policy.rows(this.db); }
  enqueue(request) {
    return this._transaction(() => this.policy.enqueue(this.db, request, this.now()));
  }
  claim(owner, now = this.now(), ...policyArgs) {
    return this._transaction(() => this.policy.claim(this.db, owner, now, ...policyArgs));
  }
  cancel(id) {
    return this._transaction(() => this.policy.cancel(this.db, id));
  }
  list() { return this.policy.list(this.db); }
  start() {
    if (this.started) return this;
    this.started = true;
    this.closed = false;
    this._wake(0);
    return this;
  }
  _wake(ms = this.intervalMs) {
    if (this.closed) return;
    clearTimeout(this.wakeTimer);
    this.wakeTimer = setTimeout(() => this._tick(), ms);
    this.wakeTimer.unref?.();
  }
  async _tick() {
    if (this.closed) return;
    while (this.active.size < this.concurrency) {
      const owner = `queue-worker-${process.pid}-${randomUUID()}`;
      const item = this.claim(owner);
      if (!item) break;
      const promise = Promise.resolve().then(() => this.process(item)).catch(error => {
        this.onDispatchError(error);
      }).finally(() => {
        this.active.delete(item.id);
        this._wake(0);
      });
      this.active.set(item.id, promise);
    }
    if (!this.closed) this._wake(this.intervalMs);
  }
  async process() { throw new Error("queue process handler is not implemented"); }
  onDispatchError() {}
  async stopScheduler() {
    this.closed = true;
    clearTimeout(this.wakeTimer);
    await Promise.allSettled([...this.active.values()]);
  }
}
