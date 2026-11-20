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

test("expired SENDING is FAILED without resend and successor can proceed",async t=>{
 const {q,root}=fixture(100);
 t.after(async()=>{await q.shutdown();rmSync(root,{recursive:true,force:true})});
 const first=q.enqueue({thread_id:"T",message:"one",idempotency_key:"one"}).queue_id;
 const second=q.enqueue({thread_id:"T",message:"two",idempotency_key:"two"}).queue_id;
 q.claim("old",100);
 q.transition(first,"old","CHECKING","SENDING",{now:101});
 const restart=new ChatGPTQueue({persistenceRoot:root,startSession:async()=>({session_id:"mock"}),execSession:async()=>({}),stopSession:async()=>{},now:()=>300,leaseSeconds:10});
 t.after(async()=>restart.shutdown());
 assert.equal(restart.claim("new",300).id,second);
 assert.equal(restart.rows().find(r=>r.id===first).state,"FAILED");
 assert.equal(restart.rows().find(r=>r.id===first).receipt,"send_interrupted");
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

test("active sends and FAILED terminal items cannot be cancelled",async t=>{
 const {q,root}=fixture();
 t.after(async()=>{await q.shutdown();rmSync(root,{recursive:true,force:true})});
 const id=q.enqueue({thread_id:'sending',message:'message',idempotency_key:'one'}).queue_id;
 q.claim('w');
 q.transition(id,'w','CHECKING','SENDING');
 assert.equal(q.cancel(id).ok,false);
 q.transition(id,'w','SENDING','FAILED',{receipt:'click_failed'});
 assert.equal(q.cancel(id).ok,false);
 assert.equal(q.rows()[0].state,'FAILED');
});

test("legacy UNCERTAIN migrates to FAILED and unblocks FIFO without resend",async t=>{
 const {q,root}=fixture();
 t.after(async()=>{await q.shutdown();rmSync(root,{recursive:true,force:true})});
 const first=q.enqueue({thread_id:'same',message:'maybe sent',idempotency_key:'known'}).queue_id;
 const second=q.enqueue({thread_id:'same',message:'next',idempotency_key:'next'}).queue_id;
 // Simulate a record persisted by the previous deployed queue.
 q.db.prepare("UPDATE turns SET state='UNCERTAIN',receipt='old failed probe' WHERE id=?").run(first);
 assert.equal(q.claim('new').id,second);
 assert.equal(q.rows().find(r=>r.id===first).state,'FAILED');
 assert.equal(q.enqueue({thread_id:'same',message:'maybe sent',idempotency_key:'known'}).queue_id,first);
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
      return { ok: true, value: { verified_by: "send-clicked" } };
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

test("failed click receipt releases the next queued turn without retry",async t=>{
 const {q,root}=fixture();
 t.after(async()=>{await q.shutdown();rmSync(root,{recursive:true,force:true})});
 const first=q.enqueue({thread_id:'same',message:'one',idempotency_key:'one'}).queue_id;
 const second=q.enqueue({thread_id:'same',message:'two',idempotency_key:'two'}).queue_id;
 const sent=[];
 q._probe=async()=>'READY';
 q._send=async item=>{
   sent.push(item.id);
   return item.id===first?{diagnostic:'send_click_not_confirmed'}:{verified_by:'send-clicked'};
 };
 await q.process(q.claim('first'));
 assert.equal(q.rows().find(r=>r.id===first).state,'FAILED');
 await q.process(q.claim('second'));
 assert.equal(q.rows().find(r=>r.id===second).state,'SENT');
 assert.deepEqual(sent,[first,second]);
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
    return calls.length === 1 ? {ready:true} : {verified_by:"send-clicked"};
  };
  await q._send({id:"item-one", thread_id:"thread123456", project_id:null,
    message:"Review this", files_json:JSON.stringify([doc])});
  assert.equal(calls.length, 2);
  assert.match(calls[0], /upload_file/);
  assert.ok(calls[0].includes(doc));
  assert.ok(calls[1].includes("button[data-testid"));
});

test("long newTurn sends prompt.md via existing file upload, keeps short ?prompt, and removes local file", async t => {
  const { readFileSync, existsSync, statSync } = await import("node:fs");
  const { deliveryMessage, targetUrl } = await import("../../runtime/chatgpt/chatgpt-probe.mjs");
  const { q, root } = fixture();
  t.after(async () => { await q.shutdown(); rmSync(root,{recursive:true,force:true}); });
  const original = "Execute these instructions:\n" + "a".repeat(3000) + "\nEnd.";
  const queueId=q.enqueue({thread_id:"long",message:original,idempotency_key:"large-new-turn"}).queue_id;
  const url=targetUrl(null,"long",original);
  assert.equal(new URL(url).searchParams.get("prompt"),deliveryMessage(original));
  assert.ok(url.length<200,"large prompt is absent from the URL");
  assert.ok(!url.includes("Execute these instructions"));
  q.sessions.set(queueId,"private-session");
  let uploadedFile, uploadedDir, calls=0;
  q._exec=async (_sid,script)=>{
    calls++;
    if(calls===1){
      const files=JSON.parse(script.match(/const files=(\[[^\n]+\]);/)[1]);
      assert.equal(files.length,1);
      uploadedFile=files[0];uploadedDir=uploadedFile.slice(0,uploadedFile.lastIndexOf("/"));
      assert.equal(uploadedFile.split("/").pop(),"prompt.md");
      assert.equal(readFileSync(uploadedFile,"utf8"),original,"file contains the exact original prompt");
      assert.equal(statSync(uploadedFile).mode & 0o777,0o600);
      return {ready:true};
    }
    assert.equal(calls,2);
    assert.ok(script.includes("await click(selector)"),"clicks Send after attachment upload");
    assert.ok(!script.includes(original),"does not put the original long prompt into browser submission script");
    assert.ok(existsSync(uploadedFile),"local file exists until upload finishes");
    return {verified_by:"send-clicked"};
  };
  const result=await q._send(q.rows()[0]);
  assert.equal(result.verified_by,"send-clicked");
  assert.equal(calls,2);
  assert.equal(existsSync(uploadedDir),false,"temporary directory is removed after newTurn");
  assert.equal(q.rows()[0].message,original,"durable queue keeps original prompt");
});

test("long prompt.md temporary file is removed when upload fails", async t=>{
  const { existsSync }=await import("node:fs");
  const { q,root }=fixture();
  t.after(async()=>{await q.shutdown();rmSync(root,{recursive:true,force:true});});
  const msg="x".repeat(2001);
  const id=q.enqueue({thread_id:"long",message:msg,idempotency_key:"fails-before-send"}).queue_id;
  q.sessions.set(id,"private-session");
  let dir;
  q._exec=async (_sid,script)=>{
    const files=JSON.parse(script.match(/const files=(\[[^\n]+\]);/)[1]);
    dir=files.at(-1).slice(0,files.at(-1).lastIndexOf("/"));
    assert.ok(existsSync(files.at(-1)));
    throw Error("upload failed");
  };
  await assert.rejects(q._send(q.rows()[0]),/upload failed/);
  assert.equal(existsSync(dir),false,"always clean up the temporary file");
});

test("newTurn uses original message at exactly 2000 characters and prompt.md above threshold",async()=>{
  const {deliveryMessage,targetUrl,PROMPT_FILE_MESSAGE}=await import("../../runtime/chatgpt/chatgpt-probe.mjs");
  const short="x".repeat(2000),long=short+"x";
  assert.equal(new URL(targetUrl(null,"x",short)).searchParams.get("prompt"),short);
  assert.equal(deliveryMessage(short),short);
  assert.equal(deliveryMessage(long),PROMPT_FILE_MESSAGE);
  assert.equal(new URL(targetUrl(null,"x",long)).searchParams.get("prompt"),PROMPT_FILE_MESSAGE);
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
    "READY", "ignore the composer draft and trust enabled Send only");
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


test("blocked pre-send becomes FAILED, preserving next-turn FIFO",async t=>{
 const {q,root}=fixture();
 t.after(async()=>{await q.shutdown();rmSync(root,{recursive:true,force:true})});
 const first=q.enqueue({thread_id:'same',message:'first',idempotency_key:'first'}).queue_id;
 const second=q.enqueue({thread_id:'same',message:'second',idempotency_key:'second'}).queue_id;
 q._probe=async item=>item.id===first?'BLOCKED':'READY';
 q._send=async()=>({verified_by:'send-clicked'});
 await q.process(q.claim('one'));
 assert.equal(q.rows().find(r=>r.id===first).state,'FAILED');
 await q.process(q.claim('two'));
 assert.equal(q.rows().find(r=>r.id===second).state,'SENT');
});

test("legacy BLOCKED head can recover, then failed send remains terminal",async t=>{
 const {q,root}=fixture(100);
 t.after(async()=>{await q.shutdown();rmSync(root,{recursive:true,force:true})});
 const first=q.enqueue({thread_id:'A',message:'old',idempotency_key:'old'}).queue_id;
 const second=q.enqueue({thread_id:'A',message:'next',idempotency_key:'next'}).queue_id;
 q.claim('w',100);
 q.transition(first,'w','CHECKING','BLOCKED',{now:100,delay:0,receipt:'page blocked'});
 const restart=new ChatGPTQueue({persistenceRoot:root,startSession:async()=>({session_id:'mock'}),execSession:async()=>({}),stopSession:async()=>{},now:()=>200});
 t.after(async()=>restart.shutdown());
 assert.equal(restart.claim('new',200).id,first);
 restart.transition(first,'new','CHECKING','SENDING',{now:200});
 restart.transition(first,'new','SENDING','FAILED',{now:200,receipt:'click_failed'});
 assert.equal(restart.claim('next',200).id,second);
});

test("probe ignores composer content and uses enabled Send only",async()=>{
 const {PROBE_JS,classifyProbe,targetUrl}=await import('../../runtime/chatgpt/chatgpt-probe.mjs');
 const {runInNewContext}=await import('node:vm');
 const visible={getClientRects:()=>[{}],disabled:false,getAttribute:()=>null};
 const state=runInNewContext(PROBE_JS,{document:{
   body:{innerText:'Open ChatGPT'},
   querySelectorAll:()=>[visible],
 },getComputedStyle:()=>({visibility:'visible'})});
 assert.equal(state.state,'READY');
 assert.equal('composer_text' in state,false);
 const url=targetUrl(null,'thread','the actual prompt');
 assert.equal(classifyProbe(url,url,state),'READY');
 assert.equal(classifyProbe(url,url,{...state,composer_text:'completely different'}),'READY');
});

test("probe rejects disabled/hidden Send controls without reading any composer",async()=>{
 const {PROBE_JS,classifyProbe,targetUrl}=await import('../../runtime/chatgpt/chatgpt-probe.mjs');
 const {runInNewContext}=await import('node:vm');
 const hidden={getClientRects:()=>[],disabled:false,getAttribute:()=>null};
 const disabled={getClientRects:()=>[{}],disabled:true,getAttribute:()=>null};
 const active={getClientRects:()=>[{}],disabled:false,getAttribute:()=>null};
 let buttons=[hidden,disabled];
 const context={document:{body:{innerText:'ChatGPT'},querySelectorAll:()=>buttons}};
 const probe=()=>runInNewContext(PROBE_JS,context);
 assert.equal(probe().state,'NOT_READY');
 buttons=[hidden,disabled,active];
 assert.equal(probe().state,'READY');
 const url=targetUrl(null,'thread','expected');
 assert.equal(classifyProbe(url,url,probe()),'READY');
});

test("pre-click Send failures terminate FAILED and preserve diagnostics",async t=>{
 for(const diagnostic of ['pre_send_gate_not_ready','send_control_not_found','thread_redirect_mismatch']){
   const {q,root}=fixture();
   t.after(async()=>{await q.shutdown();rmSync(root,{recursive:true,force:true})});
   q._probe=async()=>'READY';
   q._send=async()=>({diagnostic});
   const id=q.enqueue({thread_id:'t',message:'hi',idempotency_key:'k-'+diagnostic}).queue_id;
   await q.process(q.claim('worker'));
   assert.equal(q.rows().find(r=>r.id===id).state,'FAILED');
   assert.equal(q.rows().find(r=>r.id===id).receipt,diagnostic);
 }
});

test("sequential queued messages do not inherit a fixed 60s delay", async (t) => {
  const {q,root}=fixture(100);
  t.after(async()=>{await q.shutdown();rmSync(root,{recursive:true,force:true});});
  q._probe=async()=>"READY";
  q._send=async()=>({verified_by:"send-clicked"});
  const first=q.enqueue({thread_id:"t",message:"hi",idempotency_key:"first"}).queue_id;
  const next=q.enqueue({thread_id:"t",message:"good day",idempotency_key:"next"}).queue_id;
  await q.process(q.claim("worker1"));
  assert.equal(q.rows().find(r=>r.id===first).state,"SENT");
  assert.equal(q.rows().find(r=>r.id===first).next_check_at,100);
  assert.equal(q.claim("worker2").id,next);
});

test("Send not ready after probe timeout fails rather than indefinitely blocking",async t=>{
 const {q,root}=fixture();
 t.after(async()=>{await q.shutdown();rmSync(root,{recursive:true,force:true})});
 q._probe=async()=>'NOT_READY';
 const id=q.enqueue({thread_id:'t',message:'new message',idempotency_key:'not-ready'}).queue_id;
 await q.process(q.claim('worker'));
 const row=q.rows().find(r=>r.id===id);
 assert.equal(row.state,'FAILED');
 assert.equal(row.receipt,'send_not_ready_not_ready');
});

test("durable queued Turn persists optional enforcement_context and sends context with long prompt.md",async t=>{
  const {readFileSync}=await import('node:fs');
  const {q,root}=fixture();
  t.after(async()=>{await q.shutdown();rmSync(root,{recursive:true,force:true})});
  const id='resp_'+'3'.repeat(40);
  const context='Call chat_report with completed:true separately.\nNeo model request: '+id;
  const original='[USER]\n'+'x'.repeat(4200)+'\n[/USER]';
  const {deliveryMessage}=await import('../../runtime/chatgpt/chatgpt-probe.mjs');
  const expected=deliveryMessage(original,context);
  assert.match(expected,/^<top-instructions>/);
  assert.match(expected,/Neo model request: resp_[a-f0-9]{40}/);
  assert.ok(expected.length<=2000);
  const queueId=q.enqueue({thread_id:'thread-top-contract',message:original,enforcement_context:context,idempotency_key:'top-contract'}).queue_id;
  assert.equal(q.rows()[0].enforcement_context,context);
  assert.throws(()=>q.enqueue({thread_id:'thread-top-contract',message:original,enforcement_context:'different',idempotency_key:'top-contract'}),/different payload/);
  q.sessions.set(queueId,'top-contract-session');
  let calls=0;
  q._exec=async(_sid,source)=>{
    calls++;
    if(calls===1){
      const files=JSON.parse(source.match(/const files=(\[[^\n]+\]);/)[1]);
      assert.equal(readFileSync(files.at(-1),'utf8'),original);
      return {ready:true};
    }
    assert.ok(source.includes('await click(selector)'),'clicks Send after upload');
    assert.ok(!source.includes('x'.repeat(300)),'does not echo the full user task');
    return {verified_by:'send-clicked'};
  };
  assert.equal((await q._send(q.rows()[0])).verified_by,'send-clicked');
  assert.equal(calls,2);
});

test("optional enforcement_context leaves legacy queued deliveries unchanged",async t=>{
  const {deliveryMessage}=await import('../../runtime/chatgpt/chatgpt-probe.mjs');
  assert.equal(deliveryMessage('hello'),'hello');
  assert.equal(deliveryMessage('x'.repeat(2001)),'Read prompt.md and execute the task in that file.');
  assert.equal(deliveryMessage('hello','Do the thing').startsWith('<top-instructions>'),true);
  const {q,root}=fixture();t.after(async()=>{await q.shutdown();rmSync(root,{recursive:true,force:true})});
  q.enqueue({thread_id:'t',message:'hello',idempotency_key:'k'});
  assert.equal(q.rows()[0].enforcement_context,'');
  assert.throws(()=>q.enqueue({thread_id:'t',message:'hello',idempotency_key:'k',enforcement_context:'new'}),/different payload/);
});

test('existing durable queue database migrates to optional enforcement_context without losing historical entries',async t=>{
  const {DatabaseSync}=await import('node:sqlite');
  const root=mkdtempSync(join(tmpdir(),'chatgpt-legacy-enforcement-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const path=join(root,'chatgpt-new-turn.sqlite3');
  const db=new DatabaseSync(path);
  db.exec(`CREATE TABLE turns(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,idem_key TEXT NOT NULL UNIQUE,project_id TEXT,thread_id TEXT NOT NULL,message TEXT NOT NULL,state TEXT NOT NULL,lease_owner TEXT,lease_until REAL,next_check_at REAL NOT NULL,created_at REAL NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,receipt TEXT,mergeable INTEGER NOT NULL DEFAULT 0,files_json TEXT NOT NULL DEFAULT '[]');
    CREATE TABLE merged_requests(idem_key TEXT PRIMARY KEY,project_id TEXT,thread_id TEXT NOT NULL,message TEXT NOT NULL,queue_id TEXT NOT NULL);`);
  db.prepare("INSERT INTO turns(id,idem_key,project_id,thread_id,message,state,next_check_at,created_at,mergeable) VALUES(?, ?, NULL, ?, ?, 'QUEUED', 100, 100, 0)").run('old-id','old-key','old-thread','old message');
  db.close();
  const q=new ChatGPTQueue({persistenceRoot:root,
    startSession:async()=>({session_id:'mock'}),execSession:async()=>({}),stopSession:async()=>{},now:()=>100});
  t.after(async()=>q.shutdown());
  assert.equal(q.rows()[0].enforcement_context,'');
  assert.equal(q.rows()[0].message,'old message');
  const fresh=q.enqueue({thread_id:'new-thread',message:'new message',enforcement_context:'Must report completion',idempotency_key:'new-key'});
  assert.equal(q.rows().find(x=>x.id===fresh.queue_id).enforcement_context,'Must report completion');
  assert.equal(q.enqueue({thread_id:'old-thread',message:'old message',idempotency_key:'old-key'}).queue_id,'old-id');
});

test('mergeable queued Turns never combine distinct enforcement contexts',async t=>{
  const {q,root}=fixture();
  t.after(async()=>{await q.shutdown();rmSync(root,{recursive:true,force:true})});
  const a=q.enqueue({thread_id:'one',message:'first',enforcement_context:'contract-A',idempotency_key:'1',mergeable:true});
  const b=q.enqueue({thread_id:'one',message:'second',enforcement_context:'contract-B',idempotency_key:'2',mergeable:true});
  assert.notEqual(a.queue_id,b.queue_id);
  const c=q.enqueue({thread_id:'one',message:'third',enforcement_context:'contract-B',idempotency_key:'3',mergeable:true});
  assert.equal(c.queue_id,b.queue_id);
  assert.deepEqual(q.rows().map(x=>({text:x.message,contract:x.enforcement_context})),[
    {text:'first',contract:'contract-A'},
    {text:'second\nthird',contract:'contract-B'},
  ]);
  assert.throws(()=>q.enqueue({thread_id:'one',message:'third',enforcement_context:'contract-A',idempotency_key:'3',mergeable:true}),/different payload/);
  assert.throws(()=>q.enqueue({thread_id:'one',message:'bad',enforcement_context:'x'.repeat(1501),idempotency_key:'bad'}),/enforcement_context/);
  const empty=q.enqueue({thread_id:'new',message:'ok',enforcement_context:null,idempotency_key:'null'});
  assert.equal(q.rows().find(x=>x.id===empty.queue_id).enforcement_context,'');
});

test("actual queue probe executes with Send readiness and never reads composer text", async t => {
  const {runInNewContext}=await import('node:vm');
  const {targetUrl}=await import('../../runtime/chatgpt/chatgpt-probe.mjs');
  const {q,root}=fixture();
  t.after(async()=>{await q.shutdown();rmSync(root,{recursive:true,force:true})});
  const message='private input not inspected';
  const url=targetUrl(null,'target-thread',message);
  const button={getClientRects:()=>[{}],disabled:false,getAttribute:()=>null};
  const document={body:{innerText:'Open ChatGPT'},querySelectorAll:()=>[button]};
  const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
  let calls=0;
  q._exec=async(_session,source)=>{
    calls++;
    return new AsyncFunction('page_info','js',source)(
      async()=>({url}),
      async probe=>runInNewContext(probe,{document}),
    );
  };
  const state=await q._probe({id:'only-once',project_id:null,thread_id:'target-thread',message});
  assert.equal(state,'READY');
  assert.equal(calls,1);
});

test("browser click transport exception fails once and allows the next same-thread turn",async t=>{
 const {q,root}=fixture();
 t.after(async()=>{await q.shutdown();rmSync(root,{recursive:true,force:true})});
 const first=q.enqueue({thread_id:'same',message:'first',idempotency_key:'first'}).queue_id;
 const second=q.enqueue({thread_id:'same',message:'second',idempotency_key:'second'}).queue_id;
 q._probe=async()=>'READY';
 const sends=[];
 q._send=async item=>{
   sends.push(item.id);
   if(item.id===first)throw Error('simulated browser click failure');
   return {verified_by:'send-clicked'};
 };
 await q.process(q.claim('w1'));
 assert.equal(q.rows().find(x=>x.id===first).state,'FAILED');
 await q.process(q.claim('w2'));
 assert.equal(q.rows().find(x=>x.id===second).state,'SENT');
 assert.deepEqual(sends,[first,second]);
});
