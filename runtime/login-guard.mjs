import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

const LABEL='com.lalalic.webhelm.keepalive';
const escapeXml=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
export function loginGuardDefinition(home=os.homedir(),{cliPath=path.join(home,'.local/bin/webhelm'),nodePath=null}={}) {
  const cli=cliPath;
  const program=nodePath||cli;
  const args=nodePath?`<string>${escapeXml(cli)}</string><string>ensure</string>`:'<string>ensure</string>';
  const environment=[path.join(home,'.local/bin'),path.join(home,'.local/opt/node22/bin'),
    '/opt/homebrew/bin','/usr/local/bin','/usr/bin','/bin'].join(':');
  // Use the cached, tested npm Runtime directly to avoid registry/network
  // dependency at login or when Chrome has just auto-updated. This must call
  // 'ensure', not 'status': a live daemon does not imply a live Chrome.
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${LABEL}</string>\n<key>ProgramArguments</key><array><string>${escapeXml(program)}</string>${args}</array>\n<key>EnvironmentVariables</key><dict><key>PATH</key><string>${escapeXml(environment)}</string><key>HOME</key><string>${escapeXml(home)}</string></dict>\n<key>RunAtLoad</key><true/>\n<key>StartInterval</key><integer>30</integer>\n<key>StandardOutPath</key><string>/dev/null</string>\n<key>StandardErrorPath</key><string>/dev/null</string>\n</dict></plist>\n`;
}
export function installLoginGuard({home=os.homedir(), platform=process.platform, apply=true,cliPath,nodePath}={}){
  if(platform!=='darwin')return {status:'unsupported',label:LABEL};
  const cli=path.join(home,'.local/bin/webhelm');
  if(!fs.existsSync(cli))return {status:'skipped',reason:'webhelm Skill launcher missing',label:LABEL};
  const dest=path.join(home,'Library/LaunchAgents',`${LABEL}.plist`);
  const content=loginGuardDefinition(home,{cliPath,nodePath});
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
