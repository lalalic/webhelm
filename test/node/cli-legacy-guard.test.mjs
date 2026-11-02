import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {fileURLToPath} from 'node:url';

const cli=fileURLToPath(new URL('../../runtime/cli.mjs',import.meta.url));

async function runLegacyGuard(sessionCount) {
  const root=mkdtempSync(path.join(tmpdir(),'webhelm-legacy-guard-'));
  const socket=path.join(root,'daemon.sock');
  const server=net.createServer(conn=>{
    let buffer='';
    conn.on('data',chunk=>{
      buffer+=chunk;
      if(!buffer.includes('\n'))return;
      const {op}=JSON.parse(buffer.slice(0,buffer.indexOf('\n')));
      conn.end(JSON.stringify(op==='guard-check'
        ? {error:'Error: unknown op: guard-check'}
        : {ok:true,pid:9876,session_count:sessionCount,version:'1.0.1'})+'\n');
    });
  });
  try{
    await new Promise((resolve,reject)=>server.listen(socket,resolve).once('error',reject));
    const child=spawn(process.execPath,[cli,'ensure'],{
      env:{...process.env,WEBHELM_SOCKET:socket,WEBHELM_RUNTIME_DIR:root,
        WEBHELM_LOCK:path.join(root,'daemon.lock')},stdio:['ignore','pipe','pipe']
    });
    let stdout='',stderr='';
    for await (const chunk of child.stdout)stdout+=chunk;
    for await (const chunk of child.stderr)stderr+=chunk;
    const status=await new Promise(resolve=>child.on('close',resolve));
    return {status,stdout,stderr};
  }finally{
    await new Promise(resolve=>server.close(resolve));
    rmSync(root,{recursive:true,force:true});
  }
}

test('busy legacy daemon is preserved and reported as not health-verified',async()=>{
  const result=await runLegacyGuard(8);
  assert.equal(result.status,0,result.stderr);
  assert.deepEqual(JSON.parse(result.stdout),{
    ok:true,deferred_upgrade:true,reason:'legacy_daemon_has_active_sessions',
    session_count:8,daemon_version:'1.0.1',chrome_health:'not_verified'
  });
});
test('legacy daemon with no Sessions is not silently reported healthy',async()=>{
  const result=await runLegacyGuard(0);
  assert.equal(result.status,1);
  assert.match(result.stderr,/drain and migrate/);
});
