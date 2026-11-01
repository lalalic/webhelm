import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync,readdirSync,mkdtempSync,rmSync,existsSync,writeFileSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {stageExtension,extensionVersion,EXTENSION_HOME,EXTENSION_ID,ensureExtensionLoaded} from '../../runtime/extension-manager.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source=path.join(root,'runtime/extension');

test('bundled MV3 extension parses before npm publication',()=>{
  assert.equal(extensionVersion,'0.3.3');
  for(const name of ['service-worker.mjs','workspace-manager.mjs','workspace-page.mjs']){
    const r=spawnSync(process.execPath,['--check',path.join(source,name)],{encoding:'utf8'});
    assert.equal(r.status,0,`${name}: ${r.stderr}`);
  }
});

test('daemon stages extension at stable path, idempotent, replaces stale valid content',t=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'webhelm-extension-test-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const destination=path.join(dir,'extension');
  mkdirSync(path.join(dir,'.git/info'),{recursive:true});
  writeFileSync(path.join(dir,'.git/info/exclude'),'# local rules\n');
  const first=stageExtension(destination);
  assert.equal(first.updated,true);
  assert.deepEqual(readdirSync(destination).sort(),readdirSync(source).sort());
  assert.equal(stageExtension(destination).updated,false);
  writeFileSync(path.join(destination,'workspace.html'),'outdated but same identity');
  assert.equal(stageExtension(destination).updated,true);
  assert.equal(readFileSync(path.join(destination,'workspace.html'),'utf8'),readFileSync(path.join(source,'workspace.html'),'utf8'));
  assert.match(readFileSync(path.join(dir,'.git/info/exclude'),'utf8'),/\/extension\//);
  assert.equal(readdirSync(dir).some(n=>n.includes('stage-')||n.includes('backup-')),false);
});

test('daemon verifies modern Chrome extension and installs via browser CDP when missing',async t=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'webhelm-cdp-mock-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const extensionDir=path.join(dir,'extension');
  const calls=[];let installed=false;
  const b={async send(method,params={},sid){calls.push(method);if(method==='Extensions.getExtensions')return {extensions:installed?[{id:EXTENSION_ID,enabled:true,version:extensionVersion,path:extensionDir}]:[]};
    if(method==='Extensions.loadUnpacked'){installed=true;return {id:EXTENSION_ID}};
    if(method==='Target.getTargets')return {targetInfos:[{targetId:'worker',type:'service_worker',url:`chrome-extension://${EXTENSION_ID}/service-worker.mjs`}]};
    if(method==='Target.attachToTarget')return {sessionId:'attached'};
    if(method==='Runtime.evaluate')return {result:{value:extensionVersion}};
    return {};
  }};
  const response=await ensureExtensionLoaded(b,{extensionDir});
  assert.equal(response.method,'cdp');
  assert.ok(calls.includes('Extensions.loadUnpacked'));
  calls.length=0;await ensureExtensionLoaded(b,{extensionDir});
  assert.ok(!calls.includes('Extensions.loadUnpacked'),'do not reload on every request');
});

test('Chrome 138 uses launch flags; incorrect running extension is rejected',async t=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'webhelm-chrome138-mock-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const extensionDir=path.join(dir,'extension');
  const b={async send(method){if(method==='Extensions.getExtensions')throw Error('Method not available');
    if(method==='Target.getTargets')return {targetInfos:[{targetId:'worker',type:'service_worker',url:`chrome-extension://${EXTENSION_ID}/service-worker.mjs`}]};
    if(method==='Target.attachToTarget')return {sessionId:'attached'};
    if(method==='Runtime.evaluate')return {result:{value:extensionVersion}};
    return {};
  }};
  assert.equal((await ensureExtensionLoaded(b,{extensionDir})).method,'startup-flags');
  b.send=async function(method){if(method==='Extensions.getExtensions')throw Error('Method not available');
    if(method==='Target.getTargets')return {targetInfos:[{targetId:'worker',type:'service_worker',url:`chrome-extension://${EXTENSION_ID}/service-worker.mjs`}]};
    if(method==='Target.attachToTarget')return {sessionId:'attached'};
    if(method==='Runtime.evaluate')return {result:{value:'0.3.1'}};
    return {};
  };
  await assert.rejects(ensureExtensionLoaded(b,{extensionDir}),/Chrome has extension 0.3.1/);
});
