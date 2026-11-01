import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';

import { CONFIG_ROOT, PROFILE_DIR, OLD_PROFILE_DIR, requireMigratedConfig } from './config-paths.mjs';
import { stageExtension } from './extension-manager.mjs';
const ROOT = CONFIG_ROOT;
const PROFILE = PROFILE_DIR;
const STATE = path.join(ROOT, 'managed-chrome.json');
const LOCK = path.join(ROOT, 'managed-chrome-node.lock');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function endpointLive(port) {
  try {
    const url = `http://127.0.0.1:${port}/json/version`;
    const response = await fetch(url, { signal: AbortSignal.timeout(650) });
    if (!response.ok) return false;
    return Boolean((await response.json()).webSocketDebuggerUrl);
  } catch { return false; }
}
function alive(pid) {
  try { if(!pid) return false;process.kill(Number(pid), 0);return true; }
  catch {return false;}
}
function matchesManagedChromeProcess(pid,port) {
  if(process.platform==='win32')return alive(pid); // Windows command-line discovery needs a separate provider.
  try {
    const command=execFileSync('ps',['-p',String(pid),'-o','command='],{encoding:'utf8',timeout:2500});
    return command.includes(`--user-data-dir=${PROFILE}`) &&
      command.includes(`--remote-debugging-port=${port}`) &&
      !command.includes('--type=');
  } catch{return false;}
}
async function fromState() {
  let state;
  try { state=JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return null; }
  if (state?.pid && Number.isInteger(state.port) && matchesManagedChromeProcess(state.pid,state.port) && await endpointLive(state.port)) return state;
  return null;
}
async function discover() {
  if (process.platform === 'win32') return null;
  let output;
  try { output=execFileSync('ps', ['-axo', 'pid=,command='], {encoding:'utf8'}); }
  catch { return null; }
  for(const line of output.split('\n')) {
    if(!line.includes(`--user-data-dir=${PROFILE}`) || line.includes('--type=')) continue;
    const match=line.match(/^\s*(\d+)\s+.*?--remote-debugging-port=(\d+)/);
    if (!match) continue;
    const [pid,port]=match.slice(1).map(Number);
    if (!matchesManagedChromeProcess(pid,port) || !await endpointLive(port)) continue;
    const state={pid,port,profile_dir:PROFILE,chrome_path:line.slice(line.search(/\S/)).replace(/^\d+\s*/, '').split(' --user-data-dir=')[0]};
    fs.writeFileSync(STATE,JSON.stringify(state,null,2));
    return state;
  }
  return null;
}
function browserExecutable(){
  const override=process.env.WEBHELM_CHROME_PATH||process.env.BROWSER_WORKSPACE_CHROME_PATH;
  if(override)return override;
  const candidates=process.platform==='darwin' ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ] : process.platform==='win32' ? [
    path.join(process.env.LOCALAPPDATA||'', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env.PROGRAMFILES||'', 'Google/Chrome/Application/chrome.exe'),
  ] : ['/usr/bin/google-chrome-stable','/usr/bin/google-chrome','/usr/bin/chromium'];
  const chosen=candidates.find(candidate=>fs.existsSync(candidate));
  if(!chosen) throw Error('Chrome not found; set WEBHELM_CHROME_PATH');
  return chosen;
}
function portFree(port) {
  return new Promise(resolve=>{
    const server=net.createServer();
    server.once('error',()=>resolve(false));
    server.listen(port,'127.0.0.1',()=>server.close(()=>resolve(true)));
  });
}
async function choosePort() {
  const initial=Number(process.env.BROWSER_WORKSPACE_CDP_PORT||9222);
  for(let port=initial;port<initial+20;port++) if(await portFree(port))return port;
  throw Error('No free managed Chrome CDP port');
}
async function lockOwnership(fn) {
  fs.mkdirSync(ROOT,{recursive:true,mode:0o700});
  let fd;
  for(let attempt=0;attempt<30;attempt++){
    try {fd=fs.openSync(LOCK,'wx',0o600);break;}
    catch (error) {
      if(error.code!=='EEXIST')throw error;
      let pid=0;
      try {pid=Number(fs.readFileSync(LOCK,'utf8'));}catch{}
      if(pid>0&&!alive(pid)){try{fs.unlinkSync(LOCK);}catch{}}
      await delay(150);
    }
  }
  if(fd===undefined)throw Error('Managed Chrome lock timed out');
  fs.writeSync(fd,String(process.pid));
  try {return await fn();}
  finally {fs.closeSync(fd);try {fs.unlinkSync(LOCK);}catch{}}
}
export function chromeMajorFromVersion(versionText){
  const match=String(versionText).match(/(?:Chrome|Chromium)\s+(?:for Testing\s+)?(\d+)\./);
  const major=match?Number(match[1]):NaN;
  if(!Number.isSafeInteger(major)||major<50)throw Error(`Cannot determine managed Chrome version: ${versionText}`);
  return major;
}
function chromeMajor(chromePath){
  return chromeMajorFromVersion(execFileSync(chromePath,['--version'],{encoding:'utf8',timeout:5000}).trim());
}
export function chromeLaunchArgs(profile,port,extensionPath,major){
  const args=[`--user-data-dir=${profile}`,`--remote-debugging-port=${port}`];
  // Chrome 138 can load unpacked extensions with a compatibility flag.
  // Chrome 139+ must rely on Extensions.loadUnpacked through CDP instead:
  // passing --load-extension can leave a stale, non-running extension entry.
  if(major<=138)args.push('--disable-features=DisableLoadExtensionCommandLineSwitch',`--load-extension=${extensionPath}`);
  args.push('--no-first-run','--no-default-browser-check','about:blank');
  return args;
}
export async function ensureManagedChrome(){
  // Explicit CDP endpoints also support hermetic mock-browser tests.
  const specified=process.env.WEBHELM_CDP_URL;
  if (specified) return {mode:'override',reused:true,endpoint:specified,profile_dir:PROFILE};
  requireMigratedConfig();
  return lockOwnership(async()=>{
    const existing=await fromState()||await discover();
    if(existing)return {...existing, mode:'managed',reused:true,endpoint:`http://127.0.0.1:${existing.port}`};
    // An explicit endpoint takes precedence only when there is no managed instance.
    const override=process.env.WEBHELM_CDP_URL||process.env.BU_CDP_URL;
    if(override)return {mode:'override',reused:true,endpoint:override,profile_dir:PROFILE};
    const port=await choosePort();
    const chrome=browserExecutable();
    const extension=stageExtension();
    const log=fs.openSync(path.join(ROOT,'managed-chrome.log'),'a');
    fs.mkdirSync(PROFILE,{recursive:true});
    const child=spawn(chrome,chromeLaunchArgs(PROFILE,port,extension.path,chromeMajor(chrome)),
      {detached:true,stdio:['ignore',log,log]});
    child.unref();
    fs.closeSync(log);
    for(let tries=0;tries<100;tries++){
      if(await endpointLive(port)){
        const state={chrome_path:chrome,pid:child.pid,port,profile_dir:PROFILE};
        const temp=`${STATE}.${process.pid}.tmp`;
        fs.writeFileSync(temp,JSON.stringify(state,null,2));fs.renameSync(temp,STATE);
        return {...state,mode:'managed',endpoint:`http://127.0.0.1:${port}`,reused:false};
      }
      if(!alive(child.pid))throw Error('Managed Chrome exited during launch');
      await delay(150);
    }
    throw Error(`Chrome did not expose CDP port ${port}`);
  });
}
