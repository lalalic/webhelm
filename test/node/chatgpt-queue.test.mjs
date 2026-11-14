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
    now: () => typeof now === 'function' ? now() : now,
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
  assert.match(q.cancel(second).error,/running or completed/);
  assert.equal(q.list().items.length,1);
});

test("queue description supplies a short title and safe thread URL without payload", async (t) => {
  const {q,root}=fixture();
  t.after(async()=>{await q.shutdown();rmSync(root,{recursive:true,force:true});});
  const first=q.enqueue({thread_id:'t /123',project_id:'p /456',message:'Summarize this video\nprivate next line',idempotency_key:'display-1'});
  const item=q.list().items.find(item=>item.id===first.queue_id);
  assert.equal(item.title,'Summarize this video');
  assert.equal(item.platform,'ChatGPT');
  assert.equal(item.url,'https://chatgpt.com/g/p%20%2F456/c/t%20%2F123');
  assert.doesNotMatch(item.url,/Summarize|private|prompt/);
  const long=q.enqueue({thread_id:'long',message:'A'.repeat(200),idempotency_key:'display-2'});
  const title=q.list().items.find(item=>item.id===long.queue_id).title;
  assert.ok(title.length<=52);
  assert.ok(title.endsWith('…'));
});

test("remove permits non-running WAITING, BLOCKED and UNCERTAIN, but never SENDING", async (t) => {
  const {q,root}=fixture();
  t.after(async()=>{await q.shutdown();rmSync(root,{recursive:true,force:true});});
  const waiting=q.enqueue({thread_id:'waiting',message:'a',idempotency_key:'wait'}).queue_id;
  q.claim('worker');
  q.transition(waiting,'worker','CHECKING','WAITING',{receipt:'page busy'});
  assert.equal(q.cancel(waiting).state,'CANCELLED');
  const blocked=q.enqueue({thread_id:'blocked',message:'b',idempotency_key:'blocked'}).queue_id;
  q.claim('worker2');
  q.transition(blocked,'worker2','CHECKING','BLOCKED',{receipt:'page blocked'});
  assert.equal(q.cancel(blocked).state,'CANCELLED');
  const sending=q.enqueue({thread_id:'sending',message:'c',idempotency_key:'sending'}).queue_id;
  q.claim('worker3');
  q.transition(sending,'worker3','CHECKING','SENDING');
  assert.equal(q.cancel(sending).ok,false);
  q.transition(sending,'worker3','SENDING','UNCERTAIN',{receipt:'unknown'});
  assert.equal(q.cancel(sending).ok,true);
});

test("UNCERTAIN is removable without resending or erasing idempotency evidence", async (t) => {
  const {q,root}=fixture();
  t.after(async()=>{await q.shutdown();rmSync(root,{recursive:true,force:true});});
  const id=q.enqueue({thread_id:'uncertain',message:'maybe sent',idempotency_key:'known'}).queue_id;
  q.claim('sender');
  q.transition(id,'sender','CHECKING','SENDING');
  assert.equal(q.cancel(id).ok,false);
  q.transition(id,'sender','SENDING','UNCERTAIN',{receipt:'could have been sent'});
  assert.deepEqual(q.cancel(id),{ok:true,queue_id:id,state:'CANCELLED'});
  assert.equal(q.rows().find(row=>row.id===id).receipt,'could have been sent');
  assert.equal(q.list().items.some(row=>row.id===id),false);
  assert.equal(q.enqueue({thread_id:'uncertain',message:'maybe sent',idempotency_key:'known'}).queue_id,id);
  assert.equal(q.claim('later'),null);
});

test("WAITING work is not eligible for enqueue-time merge", async (t) => {
  const {q,root}=fixture();
  t.after(async()=>{await q.shutdown();rmSync(root,{recursive:true,force:true});});
  const first=q.enqueue({thread_id:"A",message:"first",idempotency_key:"waiting-1",mergeable:true}).queue_id;
  const owner="worker";
  q.claim(owner);
  q.transition(first,owner,"CHECKING","WAITING",{receipt:"busy"});
  const second=q.enqueue({thread_id:"A",message:"second",idempotency_key:"waiting-2",mergeable:true}).queue_id;
  assert.notEqual(second,first);
  assert.equal(q.rows().find(row=>row.id===first).message,"first");
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

test("attachment turns persist paths across queue restart and cannot merge or change identity", async t => {
  const { writeFileSync } = await import("node:fs");
  const { q, root } = fixture();
  t.after(async () => { await q.shutdown(); rmSync(root, { recursive:true, force:true }); });
  const photo = join(root, "source.png");
  writeFileSync(photo, Buffer.from([0, 255, 14, 18]));
  const payload = { thread_id: "attached-thread", message: "see image",
    idempotency_key: "attachment-request-123", file: [photo] };
  const result = q.enqueue(payload);
  const row = q.rows()[0];
  assert.deepEqual(JSON.parse(row.files_json), [photo]);
  assert.equal(q.enqueue(payload).queue_id, result.queue_id);
  assert.throws(() => q.enqueue({...payload, file: []}), /idempotency key reused/);
  assert.throws(() => q.enqueue({...payload, mergeable:true}), /cannot merge/);
  const reopened = new ChatGPTQueue({persistenceRoot:root,startSession:async()=>({session_id:"test"}),
    execSession:async()=>({}),stopSession:async()=>{}});
  t.after(async()=>reopened.shutdown());
  assert.deepEqual(JSON.parse(reopened.rows()[0].files_json), [photo]);
});

test("attachment worker uploads binary files before clicking Send", async t => {
  const { writeFileSync } = await import("node:fs");
  const { q, root } = fixture();
  t.after(async () => { await q.shutdown(); rmSync(root, { recursive:true, force:true }); });
  const doc = join(root, "my image.png");
  writeFileSync(doc, Buffer.from([1, 2, 3]));
  const calls = [];
  q.sessions.set("item-one", "owned-session");
  q._exec = async (_sid, source) => {
    calls.push(source);
    return calls.length === 1 ? {ready:true} : {verified_by:"send-button-disabled"};
  };
  await q._send({id:"item-one", thread_id:"thread123456", project_id:null,
    message:"Review this", files_json:JSON.stringify([doc])});
  assert.equal(calls.length, 2);
  assert.match(calls[0], /upload_file/);
  assert.ok(calls[0].includes(doc));
  assert.ok(calls[1].includes("button[data-testid"));
});

test("ordinary new-turn URL redirects to Project thread without blocking queue", async () => {
  const { targetUrl, classifyProbe } = await import("../../runtime/chatgpt/chatgpt-probe.mjs");
  const url = targetUrl("g-p-12345678", "aabbccdd-1122-3344-5566-77889900aabb", "hello");
  assert.ok(url.startsWith("https://chatgpt.com/c/"));
  const state = { state:"READY", composer_text:"hello" };
  const redirected = "https://chatgpt.com/g/g-p-12345678-project/c/aabbccdd-1122-3344-5566-77889900aabb";
  assert.equal(classifyProbe(redirected, url, state), "READY");
  assert.equal(classifyProbe(url, url, state), "READY",
    "the ?prompt URL can remain while the composer is ready");
  assert.equal(classifyProbe(targetUrl(null,"abc12345","a\nb"),
    targetUrl(null,"abc12345","a\nb"),
    {state:"READY",composer_text:"a b"}),"READY");

  assert.equal(classifyProbe(url, url, {state:"READY",composer_text:"wrong draft"}),
    "NOT_READY", "never send an unrelated composer draft");
  assert.equal(classifyProbe("https://chatgpt.com/c/different", url, state), "BLOCKED");
});


test("browser upload helper waits per file before selecting next and handles duplicate names", async () => {
  const {attachmentUploadScript} = await import("../../runtime/chatgpt/attachment-upload.mjs");
  const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
  const script = new AsyncFunction("js","upload_file","sleep",
    attachmentUploadScript(["/tmp/a/file.txt","/tmp/b/file.txt"]));
  const attached=[];
  const uploaded=[];
  const result=await script(async expression => {
    if (expression.includes("#upload-files")) return 'input[type="file"]';
    if (expression.includes("button[aria-label^=")) return {names:attached.slice(),pending:false};
    throw Error("unexpected expression");
  }, async (_selector,path) => {
    assert.equal(attached.length,uploaded.length,"previous attachment must be ready");
    uploaded.push(path);
    attached.push(path.split("/").pop());
  }, async () => {});
  assert.deepEqual(result,{ready:true,names:["file.txt","file.txt"]});
  assert.equal(uploaded.length,2);
});


test("blocked pre-send turns retry after cooldown and preserve same-thread FIFO", async (t) => {
  let clock = 100;
  const { q, root } = fixture(() => clock);
  t.after(async () => { await q.shutdown(); rmSync(root, {recursive: true, force: true}); });
  const first = q.enqueue({thread_id: "owner", message: "first", idempotency_key: "first"}).queue_id;
  const second = q.enqueue({thread_id: "owner", message: "second", idempotency_key: "second"}).queue_id;
  const independent = q.enqueue({thread_id: "other", message: "other", idempotency_key: "other"}).queue_id;
  q._probe = async () => "BLOCKED";
  await q.process(q.claim("worker", clock));
  assert.equal(q.rows().find(row => row.id === first).state, "BLOCKED");
  assert.equal(q.rows().find(row => row.id === first).next_check_at, 160);
  assert.equal(q.claim("independent", clock).id, independent);
  q.transition(independent, "independent", "CHECKING", "SENDING");
  q.transition(independent, "independent", "SENDING", "SENT", {delay: 0, receipt: "sent"});
  assert.equal(q.claim("early", 159), null);
  clock = 160;
  const retry = q.claim("retry", clock);
  assert.equal(retry.id, first);
  assert.equal(retry.attempts, 2);
  assert.equal(q.rows().find(row => row.id === second).state, "QUEUED");
  await q.process(retry);
  assert.equal(q.rows().find(row => row.id === first).next_check_at, 280);
  assert.equal(q.claim("early-again", 279), null);
  assert.equal(q.claim("ready", 280).id, first);
});

test("old blocked records resume after restart without resending an uncertain turn", async (t) => {
  const {q, root} = fixture(100);
  t.after(async () => { await q.shutdown(); rmSync(root, {recursive: true, force: true}); });
  const id = q.enqueue({thread_id: "A", message: "old", idempotency_key: "old"}).queue_id;
  q.claim("worker", 100);
  q.transition(id, "worker", "CHECKING", "BLOCKED", {now: 100, delay: 0, receipt: "page blocked"});
  const reopen = new ChatGPTQueue({
    persistenceRoot: root, startSession: async () => ({session_id: "mock"}),
    execSession: async () => ({}), stopSession: async () => {}, now: () => 200,
  });
  t.after(async () => reopen.shutdown());
  assert.equal(reopen.claim("new", 200).id, id);
  reopen.transition(id, "new", "CHECKING", "SENDING", {now: 200});
  reopen.transition(id, "new", "SENDING", "UNCERTAIN", {now: 200, receipt: "ambiguous"});
  assert.equal(reopen.claim("safe", 10000), null);
});


test("probe preserves ProseMirror paragraph boundaries before comparing prefilled text", async () => {
  const {PROBE_JS, classifyProbe, targetUrl} = await import("../../runtime/chatgpt/chatgpt-probe.mjs");
  const {runInNewContext} = await import("node:vm");
  const lines = ["Gateway event", "metadata: important", "", "check JEL", "", "report result"];
  const composer = {
    children: lines.map(textContent => ({tagName: "P", textContent})),
    textContent: lines.join(""),
    getAttribute: key => key === "contenteditable" ? "true" : null,
    getClientRects: () => [{}],
  };
  const state = runInNewContext(PROBE_JS, {
    document: {
      body: {innerText: "Open ChatGPT"},
      querySelector: () => composer,
      querySelectorAll: () => [composer],
    },
    getComputedStyle: () => ({visibility: "visible"}),
  });
  assert.equal(state.state, "READY");
  assert.equal(state.composer_text, lines.join("\n"));
  const url = targetUrl(null, "thread", lines.join("\n"));
  assert.equal(classifyProbe(url, url, state), "READY");
  assert.equal(classifyProbe(url, url, {...state, composer_text: lines.join("")}), "NOT_READY");
});


test("prefill probe ignores hidden composer and hidden Send controls", async () => {
  const {PROBE_JS,classifyProbe,targetUrl} = await import("../../runtime/chatgpt/chatgpt-probe.mjs");
  const {SEND_ENABLED_JS} = await import("../../runtime/chatgpt/lifecycle-common.mjs");
  const {runInNewContext} = await import("node:vm");
  const hidden = {
    children: [{tagName: 'P', textContent:'stale'}], textContent:'stale',
    getAttribute:()=> 'true', getClientRects:()=>[],
  };
  const current = {
    children: [{tagName:'P',textContent:'Current'}, {tagName:'P',textContent:'owner reply'}],
    textContent:'Currentowner reply',getAttribute:k=>k==='contenteditable'?'true':null,
    getClientRects:()=>[{}],
  };
  const hiddenButton = {getClientRects:()=>[],disabled:false,getAttribute:()=>null};
  const visibleButton = {getClientRects:()=>[{}],disabled:false,getAttribute:()=>null};
  const document = {
    body:{innerText:'ChatGPT'},
    querySelectorAll:selector => selector==='button' ? [] : selector.includes('button')
      ? [hiddenButton, visibleButton] : [hidden, current],
  };
  const context = {document,getComputedStyle:()=>({visibility:'visible'})};
  const state=runInNewContext(PROBE_JS,context);
  assert.equal(state.state,'READY');
  assert.equal(state.composer_text,'Current\nowner reply');
  assert.equal(runInNewContext(SEND_ENABLED_JS,context),true);
  const url=targetUrl(null,'thread','Current\nowner reply');
  assert.equal(classifyProbe(url,url,state),'READY');
});


test("pre-click Send diagnostics retry safely instead of blocking the thread UNCERTAIN", async (t) => {
  for (const diagnostic of ["pre_send_gate_not_ready", "send_control_not_found", "thread_redirect_mismatch"]) {
    const {q, root} = fixture(100);
    t.after(async () => { await q.shutdown(); rmSync(root, {recursive:true,force:true}); });
    q._probe = async () => "READY";
    q._send = async () => ({diagnostic});
    const id = q.enqueue({thread_id:"t", message:"hi", idempotency_key:`k-${diagnostic}`}).queue_id;
    await q.process(q.claim("worker"));
    const row = q.rows().find(r => r.id === id);
    assert.equal(row.state, "WAITING", diagnostic);
    assert.equal(row.receipt, diagnostic);
    assert.equal(row.attempts, 1);
  }
});
