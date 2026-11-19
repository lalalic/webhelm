import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const LABEL='com.lalalic.webhelm.keepalive';
const UPDATE_LABEL='com.lalalic.webhelm.runtime-update';
// launchd must never depend on npm's removable npx cache, or on the Skill
// launcher being present. Stage an immutable, package-backed runtime locally.
export function stageRuntimeForLoginGuard({home=os.homedir(),source=fileURLToPath(new URL('../',import.meta.url)),yamlSource=null}={}){
  const manifest=JSON.parse(fs.readFileSync(path.join(source,'package.json'),'utf8'));
  if(manifest.name!=='webhelm'||!/^\d+\.\d+\.\d+$/.test(manifest.version))throw Error('Invalid WebHelm runtime package');
  const parent=path.join(home,'.local/share/webhelm');
  const target=path.join(parent,`runtime-${manifest.version}`);
  const keyfiles=['package.json','bin/webhelm.mjs','runtime/cli.mjs','runtime/node-daemon.mjs','runtime/login-guard.mjs'];
  const equal=()=>keyfiles.every(name=>fs.existsSync(path.join(target,name))&&fs.readFileSync(path.join(target,name)).equals(fs.readFileSync(path.join(source,name))))&&fs.existsSync(path.join(target,'node_modules/yaml/package.json'));
  if(equal())return {path:target,version:manifest.version,updated:false};
  const yamlDir=yamlSource||path.resolve(fileURLToPath(import.meta.resolve('yaml')),'../..');
  if(!fs.existsSync(path.join(yamlDir,'package.json')))throw Error('Bundled Runtime yaml dependency missing');
  fs.mkdirSync(parent,{recursive:true,mode:0o700});
  const tmp=fs.mkdtempSync(path.join(parent,'.webhelm-runtime-stage-'));
  try{
    for(const dirname of ['bin','runtime'])fs.cpSync(path.join(source,dirname),path.join(tmp,dirname),{recursive:true});
    fs.copyFileSync(path.join(source,'package.json'),path.join(tmp,'package.json'));
    fs.mkdirSync(path.join(tmp,'node_modules'),{recursive:true});
    fs.cpSync(yamlDir,path.join(tmp,'node_modules/yaml'),{recursive:true});
    let old=null;
    if(fs.existsSync(target)){
      old=path.join(parent,`.webhelm-runtime-old-${process.pid}-${Date.now()}`);
      fs.renameSync(target,old);
    }
    try{fs.renameSync(tmp,target);}catch(error){if(old)fs.renameSync(old,target);throw error;}
    if(old)fs.rmSync(old,{recursive:true,force:true});
    return {path:target,version:manifest.version,updated:true};
  }finally{if(fs.existsSync(tmp))fs.rmSync(tmp,{recursive:true,force:true});}
}

const escapeXml=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
export function loginGuardDefinition(home=os.homedir(),{cliPath=path.join(home,'.local/bin/webhelm'),nodePath=null,sourceMode=false}={}) {
  const cli=cliPath;
  const program=nodePath||cli;
  const args=nodePath?`<string>${escapeXml(cli)}</string><string>ensure</string>`:'<string>ensure</string>';
  const environment=[path.join(home,'.local/bin'),path.join(home,'.local/opt/node22/bin'),
    '/opt/homebrew/bin','/usr/local/bin','/usr/bin','/bin'].join(':');
  // Use a pinned local Runtime (or the source checkout on Neo Master), not
  // npm/network at login or after Chrome updates. This must call
  // 'ensure', not 'status': a live daemon does not imply a live Chrome.
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${LABEL}</string>\n<key>ProgramArguments</key><array><string>${escapeXml(program)}</string>${args}</array>\n<key>EnvironmentVariables</key><dict><key>PATH</key><string>${escapeXml(environment)}</string><key>HOME</key><string>${escapeXml(home)}</string>${sourceMode?'<key>WEBHELM_SOURCE_MODE</key><string>1</string>':''}</dict>\n<key>RunAtLoad</key><true/>\n<key>StartInterval</key><integer>30</integer>\n<key>StandardOutPath</key><string>/dev/null</string>\n<key>StandardErrorPath</key><string>/dev/null</string>\n</dict></plist>\n`;
}
export function installLoginGuard({home=os.homedir(), platform=process.platform, apply=true,cliPath,nodePath,sourceMode=false}={}){
  if(platform!=='darwin')return {status:'unsupported',label:LABEL};
  const cli=cliPath||path.join(home,'.local/bin/webhelm');
  if(!fs.existsSync(cli))return {status:'skipped',reason:'WebHelm runtime launcher missing',label:LABEL};
  const dest=path.join(home,'Library/LaunchAgents',`${LABEL}.plist`);
  const content=loginGuardDefinition(home,{cliPath,nodePath,sourceMode});
  fs.mkdirSync(path.dirname(dest),{recursive:true});
  if(fs.existsSync(dest)){
    const old=fs.readFileSync(dest,'utf8');
    if(!old.includes(`<string>${LABEL}</string>`))throw Error(`Refusing to replace unrelated LaunchAgent: ${dest}`);
  }
  const updated=!fs.existsSync(dest)||fs.readFileSync(dest,'utf8')!==content;
  if(updated){
    const staging=dest+`.${process.pid}.tmp`;
    fs.writeFileSync(staging,content,{mode:0o600});fs.renameSync(staging,dest);
  }
  const service=`gui/${process.getuid()}/${LABEL}`;
  if(!apply)return {status:'staged',path:dest,updated,label:LABEL};
  try {
    execFileSync('launchctl',['print',service],{timeout:5000,stdio:'ignore'});
    if(updated){
      execFileSync('launchctl',['bootout',service],{timeout:5000,stdio:'ignore'});
      execFileSync('launchctl',['bootstrap',`gui/${process.getuid()}`,dest],{timeout:5000,stdio:'ignore'});
    }
    return {status:'active',path:dest,updated,label:LABEL};
  } catch(error){
    try{
      execFileSync('launchctl',['bootstrap',`gui/${process.getuid()}`,dest],{timeout:5000,stdio:'ignore'});
      return {status:'active',path:dest,updated,label:LABEL};
    }catch(e){return {status:'staged_not_loaded',path:dest,label:LABEL,reason:e.message};}
  }
}

// The npm poller is separate from the offline, 30-second Chrome health guard.
// It is pinned to a staged Runtime and never relies on a removable npx cache.
export function runtimeUpdateDefinition(home=os.homedir(),{cliPath,nodePath}={}) {
  const cli=cliPath||path.join(home,'.local/bin/webhelm');
  const node=nodePath||process.execPath;
  const environment=[path.join(home,'.local/bin'),path.join(home,'.local/opt/node22/bin'),
    '/opt/homebrew/bin','/usr/local/bin','/usr/bin','/bin'].join(':');
  const log=path.join(home,'.config/webhelm/runtime/auto-update.log');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${UPDATE_LABEL}</string>\n<key>ProgramArguments</key><array><string>${escapeXml(node)}</string><string>${escapeXml(cli)}</string><string>upgrade</string></array>\n<key>EnvironmentVariables</key><dict><key>PATH</key><string>${escapeXml(environment)}</string><key>HOME</key><string>${escapeXml(home)}</string></dict>\n<key>RunAtLoad</key><true/>\n<key>StartInterval</key><integer>3600</integer>\n<key>StandardOutPath</key><string>${escapeXml(log)}</string>\n<key>StandardErrorPath</key><string>${escapeXml(log)}</string>\n</dict></plist>\n`;
}

export function installRuntimeUpdate({home=os.homedir(),platform=process.platform,apply=true,cliPath,nodePath,sourceMode=false}={}) {
  if(sourceMode)return {status:'disabled',reason:'source_checkout',label:UPDATE_LABEL};
  if(platform!=='darwin')return {status:'unsupported',label:UPDATE_LABEL};
  const cli=cliPath||path.join(home,'.local/bin/webhelm');
  if(!fs.existsSync(cli))return {status:'skipped',reason:'WebHelm runtime launcher missing',label:UPDATE_LABEL};
  const dest=path.join(home,'Library/LaunchAgents',`${UPDATE_LABEL}.plist`);
  const content=runtimeUpdateDefinition(home,{cliPath:cli,nodePath});
  fs.mkdirSync(path.dirname(dest),{recursive:true});
  fs.mkdirSync(path.join(home,'.config/webhelm/runtime'),{recursive:true,mode:0o700});
  if(fs.existsSync(dest)&&!fs.readFileSync(dest,'utf8').includes(`<string>${UPDATE_LABEL}</string>`))
    throw Error(`Refusing to replace unrelated LaunchAgent: ${dest}`);
  const updated=!fs.existsSync(dest)||fs.readFileSync(dest,'utf8')!==content;
  if(updated){const tmp=dest+`.${process.pid}.tmp`;fs.writeFileSync(tmp,content,{mode:0o600});fs.renameSync(tmp,dest);}
  if(!apply)return {status:'staged',path:dest,updated,label:UPDATE_LABEL};
  const service=`gui/${process.getuid()}/${UPDATE_LABEL}`;
  try {
    execFileSync('launchctl',['print',service],{timeout:5000,stdio:'ignore'});
    if(updated){
      execFileSync('launchctl',['bootout',service],{timeout:5000,stdio:'ignore'});
      execFileSync('launchctl',['bootstrap',`gui/${process.getuid()}`,dest],{timeout:5000,stdio:'ignore'});
    }
    return {status:'active',path:dest,updated,label:UPDATE_LABEL};
  }catch{
    try{execFileSync('launchctl',['bootstrap',`gui/${process.getuid()}`,dest],{timeout:5000,stdio:'ignore'});
      return {status:'active',path:dest,updated,label:UPDATE_LABEL};}
    catch(error){return {status:'staged_not_loaded',path:dest,label:UPDATE_LABEL,reason:error.message};}
  }
}

export function currentRuntimePath(home=os.homedir()) {
  return path.join(home,'.local/share/webhelm/runtime-current');
}

// Atomic pointer swap: version directories remain immutable, so a running
// daemon or CLI can finish on its original files while future invocations
// start from the new version. Never replace a user-owned directory.
export function activateRuntime(stagedPath,{home=os.homedir()}={}) {
  const current=currentRuntimePath(home);
  if(!fs.existsSync(path.join(stagedPath,'bin/webhelm.mjs')))throw Error('Missing staged WebHelm Runtime CLI');
  if(fs.existsSync(current)&&!fs.lstatSync(current).isSymbolicLink())
    throw Error(`Refusing to replace unmanaged Runtime directory: ${current}`);
  if(fs.existsSync(current)&&fs.realpathSync(current)===fs.realpathSync(stagedPath))return {path:current,updated:false};
  fs.mkdirSync(path.dirname(current),{recursive:true,mode:0o700});
  const temp=`${current}.${process.pid}.${Date.now()}.tmp`;
  fs.symlinkSync(stagedPath,temp,'dir');
  try{fs.renameSync(temp,current);}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}
  return {path:current,updated:true};
}

// Pre-updater installations may have pointed ~/.local/bin/webhelm directly
// at an immutable runtime-VERSION snapshot. Migrate ONLY this owned pattern;
// preserve Skill launchers, unmanaged binaries and other symlinks.
export function migrateLegacyRuntimeCli({home=os.homedir()}={}) {
  const link=path.join(home,'.local/bin/webhelm');
  const stable=path.join(currentRuntimePath(home),'bin/webhelm.mjs');
  if(!fs.existsSync(stable))return {status:'skipped',reason:'stable_runtime_missing'};
  try{if(!fs.lstatSync(link).isSymbolicLink())return {status:'preserved',reason:'unmanaged_cli'};}
  catch(error){if(error.code==='ENOENT')return {status:'skipped',reason:'no_existing_cli'};throw error;}
  const resolved=path.resolve(path.dirname(link),fs.readlinkSync(link));
  const relative=path.relative(path.join(home,'.local/share/webhelm'),resolved).split(path.sep).join('/');
  if(!/^runtime-\d+\.\d+\.\d+\/bin\/webhelm\.mjs$/.test(relative))
    return {status:'preserved',reason:'not_a_versioned_runtime_link'};
  const tmp=`${link}.${process.pid}.${Date.now()}.tmp`;
  fs.symlinkSync(stable,tmp);
  try{fs.renameSync(tmp,link);}finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
  return {status:'migrated',path:link,target:stable};
}
