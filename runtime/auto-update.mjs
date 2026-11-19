import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {request} from './node-daemon.mjs';
import {activateRuntime,currentRuntimePath,installLoginGuard,installRuntimeUpdate,stageRuntimeForLoginGuard} from './login-guard.mjs';

const REGISTRY='https://registry.npmjs.org';
const SOURCE=fileURLToPath(new URL('../',import.meta.url));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

export function compareVersions(a,b) {
  const parts=v=>{
    if(typeof v!=='string'||!/^\d+\.\d+\.\d+$/.test(v))throw Error(`Invalid Runtime version: ${v}`);
    return v.split('.').map(Number);
  };
  const x=parts(a),y=parts(b);
  for(let i=0;i<3;i++)if(x[i]!==y[i])return Math.sign(x[i]-y[i]);
  return 0;
}

export function npmLatest() {
  const value=execFileSync('npm',['view','webhelm','version','--json',`--registry=${REGISTRY}`,'--fetch-retries=0','--fetch-timeout=8000'],
    {encoding:'utf8',timeout:15000,stdio:['ignore','pipe','pipe']});
  const version=JSON.parse(value);
  compareVersions(version,version);
  return version;
}

// npm installs into an isolated temporary prefix; lifecycle scripts never run.
// The existing offline staging contract (Runtime + yaml) remains unchanged.
export function downloadRuntime(version,{home=os.homedir()}={}) {
  compareVersions(version,version);
  const cached=path.join(home,'.local/share/webhelm',`runtime-${version}`);
  try {
    const pkg=JSON.parse(fs.readFileSync(path.join(cached,'package.json'),'utf8'));
    const ext=JSON.parse(fs.readFileSync(path.join(cached,'runtime/extension/manifest.json'),'utf8'));
    if(pkg.name==='webhelm' && pkg.version===version && ext.version===version &&
       fs.existsSync(path.join(cached,'node_modules/yaml/package.json')) &&
       fs.existsSync(path.join(cached,'runtime/auto-update.mjs')))
      return {path:cached,version,updated:false};
  }catch{}
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'webhelm-npm-upgrade-'));
  try {
    execFileSync('npm',['install','--prefix',temp,'--no-save','--omit=dev','--ignore-scripts',
      '--no-audit','--no-fund','--package-lock=false','--fetch-retries=0',
      `--registry=${REGISTRY}`,`webhelm@${version}`],
      {timeout:120000,stdio:['ignore','pipe','pipe']});
    const source=path.join(temp,'node_modules/webhelm');
    const manifest=JSON.parse(fs.readFileSync(path.join(source,'package.json'),'utf8'));
    const extension=JSON.parse(fs.readFileSync(path.join(source,'runtime/extension/manifest.json'),'utf8'));
    if(manifest.name!=='webhelm'||manifest.version!==version||extension.version!==version)
      throw Error('npm Runtime/Extension version verification failed');
    if(Object.keys(manifest.dependencies||{}).some(name=>name!=='yaml'))
      throw Error('Runtime dependencies changed; offline staging requires a review');
    return stageRuntimeForLoginGuard({home,source,yamlSource:path.join(temp,'node_modules/yaml')});
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
}

function acquireLock(home) {
  const runtime=path.join(home,'.config/webhelm/runtime');
  fs.mkdirSync(runtime,{recursive:true,mode:0o700});
  const lock=path.join(runtime,'auto-upgrade.lock');
  for(let i=0;i<2;i++){
    try {
      const fd=fs.openSync(lock,'wx',0o600);
      fs.writeFileSync(fd,String(process.pid));fs.closeSync(fd);
      return ()=>{if(fs.existsSync(lock)&&fs.readFileSync(lock,'utf8')===String(process.pid))fs.unlinkSync(lock);};
    }catch(error){
      if(error.code!=='EEXIST')throw error;
      const owner=Number(fs.readFileSync(lock,'utf8'));
      if(owner>0){try{process.kill(owner,0);return null;}catch(e){if(e.code==='EPERM')return null;}}
      fs.unlinkSync(lock);
    }
  }
  return null;
}

// Inject ports for isolated tests. Production never imports npm code or
// touches another Chrome profile to decide whether to upgrade.
export async function upgradeRuntime({home=os.homedir(),source=SOURCE,nodePath=process.execPath,
    latest=npmLatest,download=downloadRuntime,ipc=req=>request(req,false),
    installGuard=installLoginGuard,installPoller=installRuntimeUpdate,
    activate=activateRuntime,verify=null,apply=true}={}) {
  if(process.env.WEBHELM_SOURCE_MODE==='1')return {status:'source_checkout',upgraded:false};
  const unlock=acquireLock(home);
  if(!unlock)return {status:'already_running',upgraded:false};
  let prepared=false,prior=null,switched=false,committed=false;
  try {
    const local=JSON.parse(fs.readFileSync(path.join(source,'package.json'),'utf8')).version;
    const published=await latest();
    const target=compareVersions(published,local)>0?published:local;
    let daemon=null;
    try{daemon=await ipc({op:'ping'});}catch{}
    if(daemon?.version && compareVersions(daemon.version,target)>0)
      return {status:'daemon_newer',upgraded:false,daemon_version:daemon.version,latest:published};
    const current=currentRuntimePath(home);
    const currentTarget=fs.existsSync(current)?fs.realpathSync(current):null;
    const upToDate=daemon?.version===target && currentTarget &&
      fs.existsSync(path.join(currentTarget,'package.json')) &&
      JSON.parse(fs.readFileSync(path.join(currentTarget,'package.json'),'utf8')).version===target;
    if(upToDate)return {status:'current',upgraded:false,version:target};
    // Stage before requesting the daemon to drain; download may take time.
    const staged=compareVersions(target,local)>0
      ? await download(target,{home}) : stageRuntimeForLoginGuard({home,source});
    if(daemon && compareVersions(daemon.version,target)<0){
      let gate;
      try{gate=await ipc({op:'upgrade-prepare'});}
      catch(error){return {status:'deferred',upgraded:false,reason:'daemon_upgrade_protocol_unavailable',detail:error.message,latest:target};}
      if(!gate?.ready)return {status:'deferred',upgraded:false,reason:gate?.reason||'daemon_busy',latest:target,session_count:gate?.session_count};
      prepared=true;
    }
    prior=currentTarget;
    activate(staged.path,{home});switched=true;
    const cliPath=path.join(current,'bin/webhelm.mjs');
    const guard=installGuard({home,cliPath,nodePath,apply});
    const poller=installPoller({home,cliPath,nodePath,apply});
    if(['staged_not_loaded','skipped'].includes(guard.status)||
       ['staged_not_loaded','skipped'].includes(poller.status))throw Error('Runtime LaunchAgent activation failed');
    if(prepared){
      const result=await ipc({op:'upgrade-commit'});
      if(!result?.stopping)throw Error('Daemon did not accept Runtime cutover');
      prepared=false;committed=true;
      // SIGTERM completes the daemon's lock/socket cleanup. Never kill Chrome.
      for(let i=0;i<100;i++){
        try{const ping=await ipc({op:'ping'});if(ping?.pid!==daemon.pid)break;}
        catch{break;}
        await sleep(100);
      }
    }
    const run=verify||(()=>{
      const result=execFileSync(nodePath,[cliPath,'status'],{encoding:'utf8',timeout:30000,stdio:['ignore','pipe','pipe']});
      return JSON.parse(result.trim().split('\n').at(-1));
    });
    const state=await run();
    if(state.version!==target)throw Error(`Cutover verification failed: ${state.version} !== ${target}`);
    return {status:'upgraded',upgraded:true,from:daemon?.version||null,to:target,
      daemon_pid:state.daemon?.pid||null,guard:guard.status,auto_update:poller.status};
  }catch(error){
    // Never point new clients at an old Runtime after a committed daemon
    // cutover: the new daemon may already be serving requests.
    if(switched && !committed){
      try{
        if(prior)activate(prior,{home});
        else fs.unlinkSync(currentRuntimePath(home));
        const cliPath=prior?path.join(currentRuntimePath(home),'bin/webhelm.mjs'):path.join(source,'bin/webhelm.mjs');
        installGuard({home,cliPath,nodePath,apply});
        installPoller({home,cliPath,nodePath,apply});
      }catch(rollbackError){error.message+=`; rollback failed: ${rollbackError.message}`;}
    }
    throw error;
  }finally{
    if(prepared)await ipc({op:'upgrade-release'}).catch(()=>{});
    unlock();
  }
}
