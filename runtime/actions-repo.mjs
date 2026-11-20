import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);

export const ACTIONS_DIR = path.resolve(process.env.WEBHELM_ACTIONS_HOME || path.join(os.homedir(), '.local', 'webhelm'));
const REMOTE = process.env.WEBHELM_ACTIONS_REPO || 'https://github.com/lalalic/webhelm-actions.git';
const options={timeout:90000,maxBuffer:1048576};
let initialSetup;
const git=(...args)=>run('git',args,options).then(r=>r.stdout.trim());
const realChatGPTMvpScript=fileURLToPath(new URL('../scripts/chatgpt-three-mvps.mjs',import.meta.url));
// Only site delivery changes trigger external four-message acceptance.
// Other site publishing must never touch a ChatGPT account.
export function needsChatGPTRealMvp(status) {
  return String(status).split('\n').some(line=>{
    const index=line.indexOf('platforms/chatgpt/');
    if(index<0)return false;
    const name=line.slice(index+'platforms/chatgpt/'.length);
    return !name || name.startsWith('actions/') || name.startsWith('runtime/') ||
      name.startsWith('queues/') || name==='manifest.yaml';
  });
}

function verifyCheckout(){
  if (!fs.existsSync(path.join(ACTIONS_DIR,'.git')) || !fs.existsSync(path.join(ACTIONS_DIR,'platforms')))
    throw new Error(`Existing ${ACTIONS_DIR} is not a complete WebHelm Actions checkout; do not overwrite it`);
}
export async function ensureActions(){
  if(initialSetup)return initialSetup;
  initialSetup=(async()=>{
    if(fs.existsSync(ACTIONS_DIR))verifyCheckout();
    else {
      fs.mkdirSync(path.dirname(ACTIONS_DIR),{recursive:true});
      const staging=fs.mkdtempSync(path.join(path.dirname(ACTIONS_DIR),'.webhelm-actions-'));
      try {
        await git('clone','--depth','1','--branch','main','--',REMOTE,staging);
        if(!fs.existsSync(path.join(staging,'platforms')))throw Error('Action repository has no platforms/');
        fs.renameSync(staging,ACTIONS_DIR);
      }finally{if(fs.existsSync(staging))fs.rmSync(staging,{recursive:true,force:true});}
    }
    return {actions_home:ACTIONS_DIR,platform_dir:path.join(ACTIONS_DIR,'platforms'),revision:await git('-C',ACTIONS_DIR,'rev-parse','--short','HEAD')};
  })();
  try{return await initialSetup;}catch(e){initialSetup=undefined;throw e;}
}
export async function syncActions(){
  await ensureActions();
  const changes=await git('-C',ACTIONS_DIR,'status','--porcelain');
  if(changes)throw Error('Actions checkout has local changes; refusing to overwrite. Review/publish or commit before sync.');
  await git('-C',ACTIONS_DIR,'fetch','--prune','origin','main');
  // Updating is permitted only if current commit is an ancestor of origin/main.
  await git('-C',ACTIONS_DIR,'merge-base','--is-ancestor','HEAD','origin/main');
  await git('-C',ACTIONS_DIR,'merge','--ff-only','origin/main');
  return {status:'synced',...(await ensureActions()),revision:await git('-C',ACTIONS_DIR,'rev-parse','--short','HEAD')};
}
export async function publishActions(message){
  await ensureActions();
  if(!message || message.trim().length<8 || message.length>250)throw Error('--message must describe the verified action change (8–250 characters)');
  const staged=await git('-C',ACTIONS_DIR,'diff','--cached','--name-only');
  if(staged.split('\n').filter(Boolean).some(s=>!s.startsWith('platforms/')))
    throw Error('Refusing to publish unrelated staged files');
  await git('-C',ACTIONS_DIR,'diff','--check');
  const changed=await git('-C',ACTIONS_DIR,'status','--porcelain','--','platforms');
  if(!changed)throw Error('No platform action changes to publish');
  // Run repository contract tests before creating a commit. These must not perform live writes.
  await run('npm',['test'],{cwd:ACTIONS_DIR,...options});
  // Real-browser ChatGPT release gate: run after offline tests and before
  // creating/pushing a commit. The test cannot be silently bypassed by mocks
  // or by the diagnostic --isolated-manual-queue option.
  if(needsChatGPTRealMvp(changed)) {
    if(process.env.WEBHELM_MVP_ALLOW_SEND!=='1')
      throw Error('ChatGPT platform changes require 3 REAL MVPs before publish: set WEBHELM_MVP_ALLOW_SEND=1 (four test sends)');
    if(!fs.existsSync(realChatGPTMvpScript))
      throw Error('missing required ChatGPT 3-MVP script in WebHelm Runtime; publish blocked');
    const before=await git('-C',ACTIONS_DIR,'status','--porcelain','--','platforms/chatgpt');
    const proof=await run(process.execPath,[realChatGPTMvpScript],{
      cwd:ACTIONS_DIR,env:process.env,timeout:300000,maxBuffer:1048576,
    });
    const verified=proof.stdout.split('\n').flatMap(line=>{
      try{return [JSON.parse(line)];}catch{return [];}
    }).find(item=>item.stage==='ALL_3_MVPS_PASS' && item.live_daemon_queue===true);
    if(!verified)throw Error('3-MVP execution did not prove native live Daemon Queue FIFO; publish blocked');
    const after=await git('-C',ACTIONS_DIR,'status','--porcelain','--','platforms/chatgpt');
    if(before!==after)throw Error('ChatGPT files changed during real 3-MVP gate; rerun required');
  }
  await git('-C',ACTIONS_DIR,'add','--','platforms');
  await git('-C',ACTIONS_DIR,'diff','--cached','--check');
  await git('-C',ACTIONS_DIR,'commit','-m',message.trim());
  const revision=await git('-C',ACTIONS_DIR,'rev-parse','HEAD');
  // Never force-push or overwrite collaborator commits.
  await git('-C',ACTIONS_DIR,'push','origin','HEAD:refs/heads/main');
  return {status:'published',revision,repository:REMOTE};
}
