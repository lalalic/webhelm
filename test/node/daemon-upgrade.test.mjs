import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const daemon=fileURLToPath(new URL('../../runtime/node-daemon.mjs',import.meta.url));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function send(socket,op,extra={}) {
  return new Promise((resolve,reject)=>{
    const conn=net.createConnection(socket);
    let data='';
    const timer=setTimeout(()=>{conn.destroy();reject(Error('IPC timeout'));},5000);
    conn.on('connect',()=>conn.write(JSON.stringify({op,...extra})+'\n'));
    conn.on('data',chunk=>{data+=chunk;if(data.includes('\n')){clearTimeout(timer);conn.destroy();resolve(JSON.parse(data.split('\n')[0]));}});
    conn.on('error',error=>{clearTimeout(timer);reject(error);});
  });
}

test('real isolated daemon has an atomic upgrade gate and graceful commit',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'webhelm-upgrade-daemon-'));
  const socket=path.join(root,'server.sock');
  const lock=path.join(root,'daemon.lock');
  const child=spawn(process.execPath,[daemon,'daemon'],{env:{...process.env,
    WEBHELM_RUNTIME_DIR:root, WEBHELM_SOCKET:socket, WEBHELM_LOCK:lock,
    WEBHELM_CDP_URL:'http://127.0.0.1:1',WEBHELM_SITE_HEARTBEAT_POLL_MS:'600000'},
    stdio:'ignore'});
  try{
    let alive=false;
    for(let i=0;i<100;i++){
      if(fs.existsSync(socket)){alive=true;break;}
      await delay(50);
    }
    assert.equal(alive,true,'isolated daemon did not start');
    const ping=await send(socket,'ping');
    assert.equal(ping.ok,true);
    let prepare;
    for(let i=0;i<100;i++){
      prepare=await send(socket,'upgrade-prepare');
      if(prepare.ready)break;
      assert.equal(prepare.deferred,true);
      await delay(100);
    }
    assert.equal(prepare.ready,true,'isolated daemon did not become safe to upgrade');
    const accepted=await send(socket,'chatgpt-new-turn-enqueue',{config:{
      thread_id:'isolated-upgrade-thread',message:'Durable queued turn',idempotency_key:'isolated-upgrade-key'}});
    assert.equal(accepted.ok,true);
    assert.equal((await send(socket,'queue-list')).items.some(item=>item.queue_id===accepted.queue_id),true);
    const blocked=await send(socket,'start');
    assert.match(blocked.error,/upgrade in progress/i);
    assert.equal((await send(socket,'upgrade-commit')).stopping,true);
    let stopped=false;
    for(let i=0;i<100;i++){
      if(!fs.existsSync(lock)){stopped=true;break;}
      await delay(50);
    }
    assert.equal(stopped,true,'daemon did not remove its lock after commit');
    assert.equal(fs.existsSync(socket),false);
  }finally{
    if(child.exitCode===null)child.kill('SIGTERM');
    await new Promise(resolve=>{if(child.exitCode!==null)resolve();else child.once('exit',resolve);});
    fs.rmSync(root,{recursive:true,force:true});
  }
});
