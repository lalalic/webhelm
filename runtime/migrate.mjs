import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import { CONFIG_ROOT, LEGACY_ROOT, OLD_PROFILE_DIR, PROFILE_DIR } from './config-paths.mjs';

function liveSocket(socketPath) {
  return new Promise(resolve => {
    const socket = net.createConnection(socketPath);
    const finish = result => { socket.destroy(); resolve(result); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(1200, () => finish(true)); // Fail closed if probing hangs.
  });
}

export async function migrateConfig({ legacyRoot = LEGACY_ROOT, configRoot = CONFIG_ROOT,
  processList = () => execFileSync('ps', ['-axo', 'command='], { encoding: 'utf8' }),
  socketCheck = liveSocket } = {}) {
  const legacy = path.resolve(legacyRoot);
  const target = path.resolve(configRoot);
  if (legacy === target) throw Error('Legacy and new config paths are identical');
  let oldStat;
  try { oldStat = fs.lstatSync(legacy); }
  catch (e) { if (e.code === 'ENOENT') return { status: 'not_needed', config_root: target }; throw e; }
  if (oldStat.isSymbolicLink()) {
    if (fs.existsSync(target) && fs.realpathSync(legacy) === fs.realpathSync(target))
      return { status: 'already_migrated', config_root: target, compatibility_symlink: legacy };
    throw Error(`Legacy path is a different symlink: ${legacy}`);
  }
  if (!oldStat.isDirectory()) throw Error(`Legacy path is not a directory: ${legacy}`);
  if (fs.existsSync(target)) throw Error(`Target already exists; refusing to overwrite: ${target}`);
  const running = processList().split('\n').filter(line =>
    line.includes(`--user-data-dir=${path.join(legacy, 'chrome')}`) ||
    (line.includes('node-daemon.mjs daemon') && !line.includes('migrate.mjs')));
  if (running.length) throw Error('Chrome or WebHelm daemon is still running; stop Sessions, daemon and Chrome before migration');
  const socket = path.join(legacy, 'runtime', 'session-node.sock');
  if (fs.existsSync(socket) && await socketCheck(socket))
    throw Error('Legacy daemon socket is active; refusing migration');
  fs.renameSync(legacy, target); // Same-volume atomic directory move; preserve Chrome data and FIFO WAL.
  try { fs.symlinkSync(target, legacy, 'dir'); }
  catch (error) {
    fs.renameSync(target, legacy);
    throw error;
  }
  return { status: 'migrated', config_root: target, compatibility_symlink: legacy };
}

// Move only the Chrome Profile. Durable FIFO and logs stay under ~/.config/webhelm/runtime.
// Chrome must be stopped because its SingletonLock and keychain-bound profile
// resources cannot be safely relocated while the browser is still running.
export async function migrateChromeProfile({oldProfile=OLD_PROFILE_DIR,newProfile=PROFILE_DIR,
  processList=()=>execFileSync('ps',['-axo','command='],{encoding:'utf8'}),
  socketCheck=liveSocket}={}){
  const old=path.resolve(oldProfile),target=path.resolve(newProfile);
  if(old===target)throw Error('Chrome source and destination paths must differ');
  if(fs.existsSync(target)){
    if(!fs.existsSync(old))return {status:'already_migrated',profile_dir:target};
    if(fs.realpathSync(old)===fs.realpathSync(target))return {status:'already_migrated',profile_dir:target,compatibility_symlink:old};
    throw Error(`Different Chrome Profiles at ${old} and ${target}; refusing to overwrite`);
  }
  if(!fs.existsSync(old))return {status:'not_needed',profile_dir:target};
  if(fs.lstatSync(old).isSymbolicLink() || !fs.statSync(old).isDirectory())
    throw Error('Old Chrome Profile is not a regular directory');
  const running=processList().split('\n').filter(s=>s.includes(`--user-data-dir=${old}`)||s.includes(`--user-data-dir=${target}`)||s.includes('node-daemon.mjs daemon') && !s.includes('migrate.mjs'));
  if(running.length)throw Error('Managed Chrome or daemon is running; stop and drain before migrating Profile');
  const socket=path.join(path.dirname(old),'runtime/session-node.sock');
  if(fs.existsSync(socket)&&await socketCheck(socket))throw Error('Session daemon still accepting requests');
  if(!fs.existsSync(path.join(old,'Default')))throw Error('Old Chrome Profile lacks Default; refusing to migrate');
  const parent=path.dirname(target);
  if(fs.existsSync(path.join(parent,'.git'))){
    const info=path.join(parent,'.git/info/exclude');
    const current=fs.existsSync(info)?fs.readFileSync(info,'utf8'):'';
    if(!current.split(/\r?\n/).includes('/chrome/'))fs.appendFileSync(info,'\n/chrome/\n');
  }
  fs.mkdirSync(parent,{recursive:true});
  fs.renameSync(old,target);
  try{fs.symlinkSync(target,old,'dir');}catch(error){fs.renameSync(target,old);throw error;}
  return {status:'migrated',profile_dir:target,compatibility_symlink:old};
}
