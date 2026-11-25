import test from 'node:test';
import assert from 'node:assert/strict';
import {observeNetwork} from '../../runtime/network-observer.mjs';
const url='https://example.test/stream';
const b64=s=>Buffer.from(s).toString('base64');
function fixture(){
  const callbacks=new Map(),calls=[];
  const browser={on(n,f){if(!callbacks.has(n))callbacks.set(n,new Set());callbacks.get(n).add(f);return()=>callbacks.get(n).delete(f)},
    async send(n,p,s){calls.push([n,p,s]);return n==='Network.streamResourceContent'?{bufferedData:b64('data: {"id":')}:n==='Network.getRequestPostData'?{postData:'expected'}:{body:'data: {"id":"whole"}\n\n'}}};
  const emit=(n,p,s='owned')=>{for(const f of callbacks.get(n)||[])f(p,s)};
  return {browser,calls,callbacks,emit};
}
test('network observer captures only armed exact owned requests, reassembles initial and later bytes, disposes',async()=>{
  const f=fixture(),watch=observeNetwork(f.browser,'owned',{url});
  const request={requestId:'r',request:{url,method:'POST',hasPostData:true}};
  f.emit('Network.requestWillBeSent',request);
  watch.arm();
  f.emit('Network.requestWillBeSent',request,'other');
  f.emit('Network.requestWillBeSent',{requestId:'other-url',request:{url:url+'/prepare',method:'POST'}});
  f.emit('Network.requestWillBeSent',request);
  f.emit('Network.responseReceived',{requestId:'r',response:{url,status:200,mimeType:'text/event-stream'}});
  f.emit('Network.dataReceived',{requestId:'r',data:b64('"stream"}\n\n')});
  await Promise.resolve();
  const snap=watch.snapshot();
  assert.deepEqual(snap.requests,[{request_id:'r',post_data:'expected',status:200,mime:'text/event-stream',ambiguous:false,truncated:false,body:'data: {"id":"stream"}\n\n'}]);
  assert.ok(f.calls.every(x=>x[2]==='owned'));
  f.emit('Network.loadingFinished',{requestId:'r'});await Promise.resolve();
  assert.equal(watch.snapshot().requests[0].body,'data: {"id":"whole"}\n\n');
  watch.close();assert.ok([...f.callbacks.values()].every(x=>!x.size));
  assert.equal(watch.snapshot().requests.length,0);
});
test('redirect, overflow and truncated streams are explicitly marked',async()=>{
  const f=fixture(),watch=observeNetwork(f.browser,'owned',{url});watch.arm();
  for(let i=0;i<5;i++)f.emit('Network.requestWillBeSent',{requestId:String(i),request:{url,method:'POST',postData:'a'}});
  f.emit('Network.requestWillBeSent',{requestId:'0',request:{url:url+'/elsewhere',method:'POST'}});
  f.emit('Network.dataReceived',{requestId:'1',data:b64('a'.repeat(256*1024+1))});
  assert.equal(watch.snapshot().overflow,true);
  assert.equal(watch.snapshot().requests[0].ambiguous,true);
  assert.equal(watch.snapshot().requests[1].truncated,true);
  watch.close();
});
