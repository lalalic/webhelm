import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {compareVersions,upgradeRuntime,forceStopDaemon,npmLatest,downloadRuntime} from '../../runtime/auto-update.mjs';
import {activateRuntime,currentRuntimePath,migrateLegacyRuntimeCli,stageRuntimeForLoginGuard,installRuntimeUpdate} from '../../runtime/login-guard.mjs';

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

test('legacy global CLI migrates pinned runtime link, preserving all foreign links',()=>{
  const home=tempHome();
  try {
    const old=stageRuntimeForLoginGuard({home,source});
    activateRuntime(old.path,{home});
    const globalBin=path.join(home,'.local/bin');
    fs.mkdirSync(globalBin,{recursive:true});
    const cli=path.join(globalBin,'webhelm');
    fs.symlinkSync(path.join(old.path,'bin/webhelm.mjs'),cli);
    const result=migrateLegacyRuntimeCli({home});
    assert.equal(result.status,'migrated');
    assert.equal(fs.readlinkSync(cli),path.join(currentRuntimePath(home),'bin/webhelm.mjs'));
    assert.equal(migrateLegacyRuntimeCli({home}).status,'preserved');
    fs.unlinkSync(cli);
    fs.symlinkSync(path.join(home,'.agents/skills/webhelm/bin/webhelm'),cli);
    assert.equal(migrateLegacyRuntimeCli({home}).status,'preserved');
    assert.equal(fs.readlinkSync(cli),path.join(home,'.agents/skills/webhelm/bin/webhelm'));
    fs.unlinkSync(cli);
    fs.writeFileSync(cli,'#!/bin/sh\n');
    assert.equal(migrateLegacyRuntimeCli({home}).reason,'unmanaged_cli');
    assert.equal(fs.readFileSync(cli,'utf8'),'#!/bin/sh\n');
  }finally{fs.rmSync(home,{recursive:true,force:true});}
});

test('explicit force upgrades an unsupported legacy daemon despite active Sessions',async()=>{
  const home=tempHome();
  try{
    const calls=[];
    const {options}=deps(home);
    options.ipc=async({op})=>{
      calls.push(op);
      if(op==='ping')return {ok:true,pid:12345,version:local,session_count:3};
      throw Error('unknown op: '+op);
    };
    options.restart=async(daemon,{ipc})=>{
      assert.equal(daemon.session_count,3);
      assert.equal((await ipc({op:'ping'})).pid,12345);
      calls.push('SIGTERM');
      return {stopping:true,stopped:true,pid:daemon.pid};
    };
    const result=await upgradeRuntime({...options,force:true});
    assert.equal(result.status,'upgraded');
    assert.equal(result.forced,true);
    assert.equal(result.sessions_before_restart,3);
    assert.equal(result.to,newer);
    assert.ok(calls.includes('SIGTERM'));
    assert.ok(!calls.includes('upgrade-prepare'));
    assert.ok(!calls.includes('upgrade-commit'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(currentRuntimePath(home),'package.json'))).version,newer);
  }finally{fs.rmSync(home,{recursive:true,force:true});}
});

test('force restarts an already current daemon; normal upgrade does not',async()=>{
  const home=tempHome();
  try{
    const staged=stagedUpgrade(home);
    activateRuntime(staged.path,{home});
    const {options}=deps(home);
    options.ipc=async({op})=>{
      assert.equal(op,'ping');
      return {ok:true,pid:44,version:newer,session_count:0};
    };
    let restarts=0;
    options.restart=async()=>{restarts++;return {stopping:true,stopped:true};};
    assert.equal((await upgradeRuntime(options)).status,'current');
    assert.equal(restarts,0);
    const forced=await upgradeRuntime({...options,force:true});
    assert.equal(forced.status,'upgraded');
    assert.equal(forced.forced,true);
    assert.equal(restarts,1);
  }finally{fs.rmSync(home,{recursive:true,force:true});}
});

test('forced SIGTERM timeout does not roll the Runtime pointer back',async()=>{
  const home=tempHome();
  try{
    const old=stageRuntimeForLoginGuard({home,source});
    activateRuntime(old.path,{home});
    const {options}=deps(home);
    options.restart=async()=>({stopping:true,stopped:false});
    const result=await upgradeRuntime({...options,force:true});
    assert.equal(result.reason,'daemon_shutdown_timeout');
    assert.equal(result.forced,true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(currentRuntimePath(home),'package.json'))).version,newer);
  }finally{fs.rmSync(home,{recursive:true,force:true});}
});

test('forceStopDaemon refuses wrong lock, wrong process identity, and missing IPC',async()=>{
  const home=tempHome();
  try{
    const lockPath=path.join(home,'daemon.lock');
    fs.writeFileSync(lockPath,'123');
    const daemon={pid:124,version:local};
    const signals=[];
    const params={home,lockPath,inspect:()=>'/usr/bin/node /tmp/node-daemon.mjs daemon',
      ipc:async()=>({pid:124,version:local}),signal:(...args)=>signals.push(args)};
    await assert.rejects(forceStopDaemon(daemon,params),/lock PID mismatch/);
    fs.writeFileSync(lockPath,'124');
    await assert.rejects(forceStopDaemon(daemon,{...params,inspect:()=>'/usr/bin/Chrome'}),/not a WebHelm daemon/);
    await assert.rejects(forceStopDaemon(daemon,{...params,ipc:async()=>({pid:125,version:local})}),/identity changed/);
    assert.deepEqual(signals,[]);
    const result=await forceStopDaemon(daemon,{...params,signal:(pid,signal)=>{
      signals.push([pid,signal]);fs.unlinkSync(lockPath);
    }});
    assert.deepEqual(result,{stopping:true,stopped:true,pid:124});
    assert.deepEqual(signals,[[124,'SIGTERM']]);
  }finally{fs.rmSync(home,{recursive:true,force:true});}
});

test('npm latest lookup uses a disposable cache instead of inherited stale npx cache',()=>{
  let cachePath=null;
  const version=npmLatest({run:(command,args)=>{
    assert.equal(command,'npm');
    assert.deepEqual(args.slice(0,4),['view','webhelm','version','--json']);
    assert.ok(args.includes('--prefer-online'));
    cachePath=args.find(item=>item.startsWith('--cache=')).slice('--cache='.length);
    assert.ok(fs.existsSync(cachePath));
    assert.notEqual(cachePath,process.env.npm_config_cache);
    return JSON.stringify(newer);
  }});
  assert.equal(version,newer);
  assert.equal(fs.existsSync(cachePath),false);
});

test('npm install uses a disposable cache despite stale caller npm metadata',()=>{
  const home=tempHome();
  try{
    const fake=path.join(home,'fake-package');
    fs.mkdirSync(fake,{recursive:true});
    for(const dir of ['runtime','bin'])fs.cpSync(path.join(source,dir),path.join(fake,dir),{recursive:true});
    const pkg=JSON.parse(fs.readFileSync(path.join(source,'package.json'),'utf8'));
    pkg.version=newer;
    fs.writeFileSync(path.join(fake,'package.json'),JSON.stringify(pkg));
    const extPath=path.join(fake,'runtime/extension/manifest.json');
    const ext=JSON.parse(fs.readFileSync(extPath,'utf8'));
    ext.version=newer;
    fs.writeFileSync(extPath,JSON.stringify(ext));
    let installCache,installPrefix;
    const result=downloadRuntime(newer,{home,run:(command,args)=>{
      assert.equal(command,'npm');
      assert.equal(args[0],'install');
      assert.ok(args.includes('--prefer-online'));
      assert.ok(args.includes('--ignore-scripts'));
      assert.ok(args.includes('webhelm@'+newer));
      installCache=args.find(item=>item.startsWith('--cache=')).slice('--cache='.length);
      installPrefix=args[args.indexOf('--prefix')+1];
      assert.ok(installCache.startsWith(installPrefix+path.sep));
      assert.notEqual(installCache,process.env.npm_config_cache);
      const nodeModules=path.join(installPrefix,'node_modules');
      fs.mkdirSync(nodeModules,{recursive:true});
      fs.cpSync(fake,path.join(nodeModules,'webhelm'),{recursive:true});
      fs.cpSync(path.resolve(fileURLToPath(import.meta.resolve('yaml')),'../..'),
        path.join(nodeModules,'yaml'),{recursive:true});
      return '';
    }});
    assert.equal(result.version,newer);
    assert.equal(fs.existsSync(installCache),false);
    assert.equal(fs.existsSync(installPrefix),false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(result.path,'package.json'),'utf8')).version,newer);
  }finally{fs.rmSync(home,{recursive:true,force:true});}
});

test('npm ETARGET during registry propagation defers without stopping daemon',async()=>{
  const home=tempHome();
  try{
    const old=stageRuntimeForLoginGuard({home,source});
    activateRuntime(old.path,{home});
    const {calls,options}=deps(home);
    options.download=()=>{const error=new Error('npm install failed');error.stderr=Buffer.from('npm error code ETARGET');throw error;};
    const result=await upgradeRuntime({...options,force:true});
    assert.equal(result.status,'deferred');
    assert.equal(result.reason,'npm_release_not_yet_resolvable');
    assert.equal(result.latest,newer);
    assert.equal(fs.realpathSync(currentRuntimePath(home)),fs.realpathSync(old.path));
    assert.ok(!calls.includes('upgrade-prepare'));
    assert.ok(!calls.includes('upgrade-commit'));
  }finally{fs.rmSync(home,{recursive:true,force:true});}
});
