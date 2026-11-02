import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

test('IPC absolute deadline survives a daemon trickling incomplete replies',async()=>{
  const root=await mkdtemp(join(tmpdir(),'webhelm-ipc-timeout-'));
  const oldSocket=process.env.WEBHELM_SOCKET,oldTimeout=process.env.WEBHELM_IPC_TIMEOUT_MS;
  const socket=join(root,'daemon.sock');
  process.env.WEBHELM_SOCKET=socket;
  process.env.WEBHELM_IPC_TIMEOUT_MS='75';
  const {request}=await import('../../runtime/node-daemon.mjs');
  const clients=new Set();
  const server=createServer(client=>{
    clients.add(client);
    const trickle=setInterval(()=>{if(!client.destroyed)client.write('.');},20);
    client.on('close',()=>{clients.delete(client);clearInterval(trickle);});
    client.on('data',()=>{});
  });
  try{
    await new Promise((resolve,reject)=>server.listen(socket,resolve).once('error',reject));
    const start=Date.now();
    await assert.rejects(request({op:'stop',session_id:'hung'},false),/WebHelm IPC stop timed out/);
    assert.ok(Date.now()-start<2000);
    await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(clients.size,0);
  }finally{
    for(const client of clients)client.destroy();
    await new Promise(resolve=>server.close(resolve));
    if(oldSocket===undefined)delete process.env.WEBHELM_SOCKET;else process.env.WEBHELM_SOCKET=oldSocket;
    if(oldTimeout===undefined)delete process.env.WEBHELM_IPC_TIMEOUT_MS;else process.env.WEBHELM_IPC_TIMEOUT_MS=oldTimeout;
    await rm(root,{recursive:true,force:true});
  }
});

test('daemon rejects oversized unframed IPC input before allocating unbounded buffers',async()=>{
  const {serve}=await import('../../runtime/node-daemon.mjs');
  const server=createServer(serve);
  try{
    await new Promise((resolve,reject)=>server.listen(0,'127.0.0.1',resolve).once('error',reject));
    const port=server.address().port;
    const {createConnection}=await import('node:net');
    const response=await new Promise((resolve,reject)=>{
      const client=createConnection({host:'127.0.0.1',port});
      let output='';
      client.on('connect',()=>client.write('x'.repeat(8_000_100)));
      client.on('data',data=>output+=data);
      client.on('end',()=>resolve(output));
      client.on('error',reject);
    });
    assert.match(JSON.parse(response).error,/request too large/);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
