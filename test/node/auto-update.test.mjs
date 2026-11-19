import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {compareVersions,upgradeRuntime} from '../../runtime/auto-update.mjs';
import {activateRuntime,currentRuntimePath,stageRuntimeForLoginGuard,installRuntimeUpdate} from '../../runtime/login-guard.mjs';

const source=fileURLToPath(new URL('../../',import.meta.url));
const local=JSON.parse(fs.readFileSync(path.join(source,'package.json'),'utf8')).version;
const newer=local.replace(/\d+$/,v=>String(Number(v)+1));
const tempHome=()=>fs.mkdtempSync(path.join(os.tmpdir(),'webhelm-autoupgrade-test-'));
function stagedUpgrade(home) {
  const repo=path.join(home,'fake-published');
  fs.mkdirSync(repo,{recursive:true});
  for(const dir of ['runtime','bin'])fs.cpSync(path.join(source,dir),path.join(repo,dir),{recursive:true});
  const pkg=JSON.parse(fs.readFileSync(path.join(source,'package.json'),'utf8'));
  pkg.version=newer;
  fs.writeFileSync(path.join(repo,'package.json'),JSON.stringify(pkg));
  return stageRuntimeForLoginGuard({home,source:repo});
}
function deps(home,{busy=false,failGuard=false}={}) {
  const calls=[];
  let committed=false;
  const ipc=async({op})=>{
    calls.push(op);
    if(op==='ping')return committed?{ok:true,pid:98765,version:newer}:{ok:true,pid:12345,version:local};
    if(op==='upgrade-prepare')return busy?{ok:true,deferred:true,reason:'daemon_busy',session_count:1}:{ok:true,ready:true};
    if(op==='upgrade-commit'){committed=true;return {ok:true,stopping:true};}
    if(op==='upgrade-release')return {ok:true,released:true};
    throw Error(`Unsupported IPC ${op}`);
  };
  return {calls,options:{home,source,latest:async()=>newer,download:()=>stagedUpgrade(home),ipc,
    installGuard:()=>{if(failGuard)throw Error('mock guard installation failed');return {status:'active'};},
    installPoller:()=>({status:'active'}),verify:async()=>({version:newer,daemon:{pid:98765}})}};
}

test('versions compare numerically and reject malformed npm versions',()=>{
  assert.equal(compareVersions('1.0.100','1.0.99'),1);
  assert.equal(compareVersions('1.0.3','1.0.3'),0);
  assert.equal(compareVersions('1.1.0','1.2.0'),-1);
  assert.throws(()=>compareVersions('latest','1.0.1'),/Invalid Runtime version/);
  assert.throws(()=>compareVersions('1.0.1-beta','1.0.1'),/Invalid Runtime version/);
});

test('hourly LaunchAgent uses staged Runtime, never npm cache or source checkout',()=>{
  const home=tempHome();
  try{
    const staged=stageRuntimeForLoginGuard({home,source});
    const current=activateRuntime(staged.path,{home});
    const cliPath=path.join(current.path,'bin/webhelm.mjs');
    const a=installRuntimeUpdate({home,platform:'darwin',apply:false,cliPath,nodePath:'/opt/node'});
    assert.equal(a.status,'staged');
    const data=fs.readFileSync(a.path,'utf8');
    assert.match(data,/<integer>3600<\/integer>/);
    assert.match(data,/<string>upgrade<\/string>/);
    assert.ok(data.includes(cliPath));
    assert.doesNotMatch(data,/_npx|webhelm@latest/);
    assert.equal(installRuntimeUpdate({home,platform:'darwin',apply:false,cliPath,nodePath:'/opt/node'}).updated,false);
    assert.equal(installRuntimeUpdate({home,platform:'darwin',sourceMode:true}).status,'disabled');
  }finally{fs.rmSync(home,{recursive:true,force:true});}
});

test('active Sessions defer upgrade without cutting over the Runtime pointer',async()=>{
  const home=tempHome();
  try{
    const existing=stageRuntimeForLoginGuard({home,source});
    activateRuntime(existing.path,{home});
    const {calls,options}=deps(home,{busy:true});
    const result=await upgradeRuntime(options);
    assert.equal(result.status,'deferred');
    assert.equal(result.reason,'daemon_busy');
    assert.equal(fs.realpathSync(currentRuntimePath(home)),fs.realpathSync(existing.path));
    assert.ok(calls.includes('upgrade-prepare'));
    assert.ok(!calls.includes('upgrade-commit'));
  }finally{fs.rmSync(home,{recursive:true,force:true});}
});

test('idle daemon cuts over through prepare/commit and verifies new daemon version',async()=>{
  const home=tempHome();
  try{
    const old=stageRuntimeForLoginGuard({home,source});
    activateRuntime(old.path,{home});
    const {calls,options}=deps(home);
    const result=await upgradeRuntime(options);
    assert.equal(result.status,'upgraded');
    assert.equal(result.to,newer);
    assert.equal(result.daemon_pid,98765);
    assert.ok(calls.indexOf('upgrade-prepare')<calls.indexOf('upgrade-commit'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(currentRuntimePath(home),'package.json'))).version,newer);
  }finally{fs.rmSync(home,{recursive:true,force:true});}
});

test('failed guard install rolls pointer back and unblocks daemon queue',async()=>{
  const home=tempHome();
  try{
    const old=stageRuntimeForLoginGuard({home,source});
    activateRuntime(old.path,{home});
    const {calls,options}=deps(home,{failGuard:true});
    await assert.rejects(upgradeRuntime(options),/mock guard installation failed/);
    assert.equal(fs.realpathSync(currentRuntimePath(home)),fs.realpathSync(old.path));
    assert.ok(calls.includes('upgrade-release'));
    assert.ok(!calls.includes('upgrade-commit'));
  }finally{fs.rmSync(home,{recursive:true,force:true});}
});

test('an incompatible old daemon stays untouched until a safe protocol exists',async()=>{
  const home=tempHome();
  try{
    const {options}=deps(home);
    options.ipc=async({op})=>{if(op==='ping')return {ok:true,pid:13,version:local};throw Error('unknown op: upgrade-prepare');};
    const result=await upgradeRuntime(options);
    assert.equal(result.status,'deferred');
    assert.equal(result.reason,'daemon_upgrade_protocol_unavailable');
    assert.equal(fs.existsSync(currentRuntimePath(home)),false);
  }finally{fs.rmSync(home,{recursive:true,force:true});}
});

test('post-commit verification failure never points clients at mismatched old runtime',async()=>{
  const home=tempHome();
  try{
    const old=stageRuntimeForLoginGuard({home,source});
    activateRuntime(old.path,{home});
    const {calls,options}=deps(home);
    options.verify=async()=>({version:local});
    await assert.rejects(upgradeRuntime(options),/Cutover verification failed/);
    assert.ok(calls.includes('upgrade-commit'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(currentRuntimePath(home),'package.json'))).version,newer);
  }finally{fs.rmSync(home,{recursive:true,force:true});}
});
