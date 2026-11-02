import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const LABEL='com.lalalic.webhelm.keepalive';
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
