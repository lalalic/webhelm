import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGPTQueue } from "../../runtime/chatgpt/chatgpt-queue.mjs";

function fixture(now = 100) {
  const root = mkdtempSync(join(tmpdir(), "chatgpt-queue-"));
  const q = new ChatGPTQueue({
    persistenceRoot: root,
    startSession: async () => ({ session_id: "mock" }),
    execSession: async () => ({ ok: true, value: null }),
    stopSession: async () => {},
    now: () => now,
  });
  return { q, root };
}

test("enqueue is durable, idempotent and rejects a changed payload", async (t) => {
  const { q, root } = fixture();
  t.after(async () => {
    await q.shutdown();
    rmSync(root, { recursive: true, force: true });
  });
  const first = q.enqueue({
    thread_id: "t1",
    project_id: "p1",
    message: "one",
    idempotency_key: "k1",
  });
  assert.equal(first.status, "queued");
  assert.ok(first.queue_id);
  const reopened = new ChatGPTQueue({
    persistenceRoot: root,
    startSession: async () => ({ session_id: "mock" }),
    execSession: async () => ({}),
    stopSession: async () => {},
    now: () => 101,
  });
  t.after(async () => reopened.shutdown());
  assert.equal(reopened.rows()[0].id, first.queue_id);
  assert.equal(
    reopened.enqueue({
      thread_id: "t1",
      project_id: "p1",
      message: "one",
      idempotency_key: "k1",
    }).queue_id,
    first.queue_id,
  );
  assert.throws(
    () =>
      reopened.enqueue({
        thread_id: "t1",
        project_id: "p1",
        message: "different",
        idempotency_key: "k1",
      }),
    /idempotency key reused/,
  );
});

test("per-thread FIFO, independent heads and mergeable request keys", async (t) => {
  const { q, root } = fixture();
  t.after(async () => {
    await q.shutdown();
    rmSync(root, { recursive: true, force: true });
  });
  const a =
    q.enqueue({ thread_id: "A", message: "first", idempotency_key: "a1" })
      .queue_id;
  const a2 =
    q.enqueue({ thread_id: "A", message: "second", idempotency_key: "a2" })
      .queue_id;
  const b =
    q.enqueue({ thread_id: "B", message: "other", idempotency_key: "b" })
      .queue_id;
  assert.equal(q.claim("wA").id, a);
  assert.equal(q.claim("wB").id, b);
  assert.equal(q.claim("wC"), null);
  q.transition(a, "wA", "CHECKING", "SENDING");
  q.transition(a, "wA", "SENDING", "SENT", { delay: 0, receipt: "verified" });
  assert.equal(q.claim("wC").id, a2);
  const m1 = q.enqueue({
    thread_id: "M",
    message: "alpha",
    idempotency_key: "m1",
    mergeable: true,
  });
  const m2 = q.enqueue({
    thread_id: "M",
    message: "beta",
    idempotency_key: "m2",
    mergeable: true,
  });
  assert.equal(m1.queue_id, m2.queue_id);
  assert.equal(
    q.rows().find((r) => r.id === m1.queue_id).message,
    "alpha\nbeta",
  );
  assert.equal(
    q.enqueue({
      thread_id: "M",
      message: "beta",
      idempotency_key: "m2",
      mergeable: true,
    }).queue_id,
    m1.queue_id,
  );
  assert.throws(
    () =>
      q.enqueue({
        thread_id: "X",
        message: "bad",
        idempotency_key: "m2",
        mergeable: true,
      }),
    /idempotency key reused/,
  );
});

test("crash recovery retries CHECKING but marks expired SENDING uncertain and never resends", async (t) => {
  const { q, root } = fixture(100);
  t.after(async () => {
    await q.shutdown();
    rmSync(root, { recursive: true, force: true });
  });
  const one =
    q.enqueue({ thread_id: "T", message: "one", idempotency_key: "one" })
      .queue_id;
  const two =
    q.enqueue({ thread_id: "T", message: "two", idempotency_key: "two" })
      .queue_id;
  q.claim("worker", 100);
  q.transition(one, "worker", "CHECKING", "SENDING", { now: 101 });
  const restart = new ChatGPTQueue({
    persistenceRoot: root,
    startSession: async () => ({ session_id: "mock" }),
    execSession: async () => ({}),
    stopSession: async () => {},
    now: () => 300,
    leaseSeconds: 10,
  });
  t.after(async () => restart.shutdown());
  assert.equal(restart.claim("new", 300), null);
  assert.equal(restart.rows()[0].state, "UNCERTAIN");
  assert.throws(
    () =>
      restart.transition(one, "reconciler", "UNCERTAIN", "WAITING", {
        receipt: "",
      }),
    /reconciliation evidence/,
  );
  restart.reconcile({
    queue_id: one,
    evidence: "read-only: user turn absent after checking conversation",
    accepted: false,
  });
  assert.equal(restart.claim("new", 300).id, one);
  assert.equal(restart.rows().find((r) => r.id === two).state, "QUEUED");
});

test("expired CHECKING lease recovers to WAITING for a fresh probe", async (t) => {
  const { q, root } = fixture(10);
  t.after(async () => {
    await q.shutdown();
    rmSync(root, { recursive: true, force: true });
  });
  const id =
    q.enqueue({ thread_id: "T", message: "m", idempotency_key: "k" }).queue_id;
  q.claim("old", 10);
  assert.equal(q.claim("new", 200).id, id);
  assert.equal(q.rows()[0].state, "CHECKING");
  assert.equal(q.rows()[0].attempts, 2);
});

test("queued items can be cancelled but active work cannot", async (t) => {
  const {q,root}=fixture();
  t.after(async()=>{await q.shutdown();rmSync(root,{recursive:true,force:true});});
  const first=q.enqueue({thread_id:"A",message:"first",idempotency_key:"cancel-me"}).queue_id;
  const second=q.enqueue({thread_id:"B",message:"second",idempotency_key:"keep-me"}).queue_id;
  assert.deepEqual(q.cancel(first),{ok:true,queue_id:first,state:"CANCELLED"});
  assert.equal(q.claim("worker").id,second);
  assert.match(q.cancel(second).error,/only queued/);
  assert.equal(q.list().items.length,1);
});

test("dispatcher runs distinct threads in parallel and caps concurrency at four", async (t) => {
  const root=mkdtempSync(join(tmpdir(),"chatgpt-parallel-"));
  let active=0, maximum=0, release;
  const gate=new Promise(resolve=>{release=resolve;});
  const q=new ChatGPTQueue({
    persistenceRoot:root, intervalMs:10, concurrency:9,
    startSession:async()=>({session_id:`session-${Math.random()}`}),
    execSession:async()=>{
      active++; maximum=Math.max(maximum,active);
      await gate;
      active--;
      return {ok:true,value:{url:"https://chatgpt.com/c/t",state:{state:"READY",composer_text:"hello"}}};
    },
    stopSession:async()=>{},
  });
  t.after(async()=>{release();await q.shutdown();rmSync(root,{recursive:true,force:true});});
  for(let i=0;i<6;i++) q.enqueue({thread_id:`thread-${i}`,message:"hello",idempotency_key:`k-${i}`});
  q.start();
  const until=Date.now()+1500;
  while(Date.now()<until && maximum<4) await new Promise(r=>setTimeout(r,5));
  assert.equal(maximum,4);
});

test("dispatcher uses one private session and accepts only a verified send receipt", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "chatgpt-dispatch-"));
  let starts = 0, stops = 0, sends = 0, execs = 0;
  const q = new ChatGPTQueue({
    persistenceRoot: root,
    intervalMs: 10,
    concurrency: 2,
    startSession: async () => ({ session_id: `session-${++starts}` }),
    execSession: async () => {
      execs++;
      if (execs === 1) {
        return {
          ok: true,
          value: {
            url: "https://chatgpt.com/c/t",
            state: { state: "READY", composer_text: "hello" },
          },
        };
      }
      sends++;
      return { ok: true, value: { verified_by: "send-button-disabled" } };
    },
    stopSession: async () => {
      stops++;
    },
  });
  t.after(async () => {
    await q.shutdown();
    rmSync(root, { recursive: true, force: true });
  });
  q.start();
  const queued = q.enqueue({
    thread_id: "t",
    message: "hello",
    idempotency_key: "k",
  });
  const until = Date.now() + 2000;
  while (Date.now() < until && q.rows()[0].state !== "SENT") {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(q.rows()[0].state, "SENT");
  assert.equal(queued.queue_id, q.rows()[0].id);
  assert.equal(starts, 1);
  assert.equal(stops, 1);
  assert.equal(sends, 1);
});

test("uncertain send receipt blocks successors and never retries the submitted item", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "chatgpt-uncertain-"));
  let executions = 0;
  const q = new ChatGPTQueue({
    persistenceRoot: root,
    intervalMs: 10,
    startSession: async () => ({ session_id: "private" }),
    execSession: async () => {
      executions++;
      return {
        ok: true,
        value: executions === 1
          ? {
            url: "https://chatgpt.com/c/t",
            state: { state: "READY", composer_text: "first" },
          }
          : { diagnostic: "post_submit_send_state_unverified" },
      };
    },
    stopSession: async () => {},
  });
  t.after(async () => {
    await q.shutdown();
    rmSync(root, { recursive: true, force: true });
  });
  q.enqueue({ thread_id: "t", message: "first", idempotency_key: "first" });
  q.enqueue({ thread_id: "t", message: "second", idempotency_key: "second" });
  q.start();
  const until = Date.now() + 2000;
  while (Date.now() < until && q.rows()[0].state !== "UNCERTAIN") {
    await new Promise((r) => setTimeout(r, 5));
  }
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(q.rows()[0].state, "UNCERTAIN");
  assert.equal(q.rows()[1].state, "QUEUED");
  assert.equal(executions, 2);
});
