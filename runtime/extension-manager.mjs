import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {LOCAL_ROOT} from './config-paths.mjs';

export const EXTENSION_ID='kkkpgmhpoeceojalkpfdidffdfnlgdog';
const SOURCE=fileURLToPath(new URL('./extension/',import.meta.url));
const SOURCE_MODE=process.env.WEBHELM_SOURCE_MODE==='1';
export const EXTENSION_HOME=path.resolve(process.env.WEBHELM_EXTENSION_HOME ||
  (SOURCE_MODE ? SOURCE : path.join(LOCAL_ROOT,'extension')));
const FILES=[
  'manifest.json','service-worker.mjs','workspace-manager.mjs','workspace.html','helm.html','workspace-page.mjs',
  'control-channel.mjs','workspace-summary.mjs','session-badge.mjs','popup.html','popup.mjs',
  ...[16,32,48,128].map(size => `icons/webhelm-${size}.png`),
];

function manifest(dir){
  const data=JSON.parse(fs.readFileSync(path.join(dir,'manifest.json'),'utf8'));
  const digest=crypto.createHash('sha256').update(Buffer.from(data.key,'base64')).digest('hex').slice(0,32);
  const id=[...digest].map(c=>String.fromCharCode(97+parseInt(c,16))).join('');
  if(id!==EXTENSION_ID || data.manifest_version!==3 || !/^\d+\.\d+\.\d+$/.test(data.version))
    throw Error('Unexpected WebHelm extension identity, manifest version, or version number');
  return data;
}
export const extensionVersion=manifest(SOURCE).version;
function canonicalPath(value) {
  try { return fs.realpathSync(value || ''); }
  catch { return path.resolve(value || ''); }
}

function listRelativeFiles(dir, prefix='') {
  return fs.readdirSync(path.join(dir,prefix),{withFileTypes:true}).flatMap(entry => {
    const relative=path.join(prefix,entry.name);
    return entry.isDirectory() ? listRelativeFiles(dir,relative) : [relative];
  });
}
function identical(dir){
  return fs.existsSync(path.join(dir,'manifest.json'))&&
    JSON.stringify(listRelativeFiles(dir).sort())===JSON.stringify([...FILES].sort())&&
    FILES.every(name=>fs.readFileSync(path.join(dir,name)).equals(fs.readFileSync(path.join(SOURCE,name))));
}
// Actions checkout contains this self-managed directory, but Git must never publish it.
function excludeFromActionsGit(dir){
  const root=path.dirname(dir), info=path.join(root,'.git/info/exclude');
  if(!fs.existsSync(info))return;
  const contents=fs.readFileSync(info,'utf8');
  const additions=['/chrome/','/extension/','/.webhelm-extension-stage-*/','/.webhelm-extension-backup-*/'].filter(rule=>!contents.split(/\r?\n/).includes(rule));
  if(additions.length)fs.appendFileSync(info,'\n'+additions.join('\n')+'\n');
}
export function stageExtension(dir=EXTENSION_HOME){
  const target=path.resolve(dir);
  const bundled=manifest(SOURCE);
  // Neo Master works from its Git checkout. Never stage or overwrite source
  // files, and never accept arbitrary symlinks as a deployment directory.
  if(SOURCE_MODE && canonicalPath(target)===canonicalPath(SOURCE))
    return {path:SOURCE,version:bundled.version,updated:false,sourceMode:true};
  if(fs.existsSync(target)&&fs.lstatSync(target).isSymbolicLink())throw Error('Refusing to replace extension symlink');
  if(fs.existsSync(target)&&identical(target))return {path:target,version:bundled.version,updated:false};
  if(fs.existsSync(target))manifest(target); // Never replace unrelated content.
  const root=path.dirname(target);
  fs.mkdirSync(root,{recursive:true,mode:0o700});
  excludeFromActionsGit(target);
  const stage=fs.mkdtempSync(path.join(root,'.webhelm-extension-stage-'));
  let backup;
  try {
    for(const filename of FILES){
      fs.mkdirSync(path.dirname(path.join(stage,filename)),{recursive:true});
      fs.copyFileSync(path.join(SOURCE,filename),path.join(stage,filename));
    }
    if(!identical(stage))throw Error('WebHelm extension staged content mismatch');
    if(fs.existsSync(target)){
      backup=path.join(root,`.webhelm-extension-backup-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
      fs.renameSync(target,backup);
    }
    try {fs.renameSync(stage,target);}catch(error){if(backup)fs.renameSync(backup,target);throw error;}
    if(backup)fs.rmSync(backup,{recursive:true,force:true});
    return {path:target,version:bundled.version,updated:true};
  }finally{if(fs.existsSync(stage))fs.rmSync(stage,{recursive:true,force:true});}
}

// Modern Chrome exposes this browser-level protocol. Older Chrome (including
// Big Sur's Chrome 138) requires the managed startup flags instead.
export async function ensureExtensionLoaded(browser, {skip=false,extensionDir=EXTENSION_HOME,allowUpdate=true}={}){
  if(skip)return {skipped:true};
  if(!allowUpdate && (!fs.existsSync(path.join(extensionDir,'manifest.json')) || !identical(extensionDir)))
    throw Error('Extension update deferred: active browser Sessions must finish before staging new content');
  const {path:dir,version}=allowUpdate?stageExtension(extensionDir):{path:extensionDir,version:extensionVersion};
  let modern=false, installed;
  try{
    const state=await browser.send('Extensions.getExtensions');
    modern=true;installed=state.extensions?.find(e=>e.id===EXTENSION_ID);
    if(!installed || !installed.enabled || installed.version!==version || canonicalPath(installed.path)!==canonicalPath(dir)){
      if(!allowUpdate)throw Error('Extension reload deferred: active browser Sessions must finish');
      const loaded=await browser.send('Extensions.loadUnpacked',{path:dir});
      if(loaded.id!==EXTENSION_ID)throw Error('Chrome loaded an unexpected extension ID');
    }
  }catch(error){
    if(modern || !/Method not available|wasn't found|Method not found|not supported/i.test(String(error.message)))
      throw Error(`WebHelm extension install failed: ${error.message}`);
  }
  // Inspect the real extension context. An installed-but-asleep MV3 worker may
  // need a temporary extension page, which is never a user's allocated tab.
  const {targetInfos=[]}=await browser.send('Target.getTargets');
  const prefix=`chrome-extension://${EXTENSION_ID}/`;
  let target=targetInfos.find(t=>t.type==='service_worker'&&t.url.startsWith(prefix));
  let temporary=false;
  if(!target){
    const created=await browser.send('Target.createTarget',{url:`${prefix}helm.html?webhelm_wakeup=1`,background:true});
    target={targetId:created.targetId};temporary=true;
  }
  let attached;
  try{
    ({sessionId:attached}=await browser.send('Target.attachToTarget',{targetId:target.targetId,flatten:true}));
    for(let i=0;i<30;i++){
      try{
        const reply=await browser.send('Runtime.evaluate',{expression:'chrome.runtime?.getManifest?.().version',returnByValue:true},attached);
        if(reply.result?.value===version)return {path:dir,version,method:modern?'cdp':'startup-flags'};
        if(reply.result?.value && reply.result.value!==version)
          throw Error(`Chrome has extension ${reply.result.value}; expected ${version}`);
      }catch(error){if(/Chrome has extension/.test(error.message))throw error;}
      await new Promise(r=>setTimeout(r,100));
    }
    throw Error(`Chrome did not initialize managed Extension ${version}. Restart managed Chrome when idle with local extension launch flags.`);
  }finally{
    if(attached)await browser.send('Target.detachFromTarget',{sessionId:attached}).catch(()=>{});
    if(temporary)await browser.send('Target.closeTarget',{targetId:target.targetId}).catch(()=>{});
  }
}
