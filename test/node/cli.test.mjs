import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync,execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const cli=fileURLToPath(new URL('../../runtime/cli.mjs',import.meta.url));
const dir=mkdtempSync(path.join(os.tmpdir(),'webhelm-cli-actions-'));
const platformDir=path.join(dir,'platforms');
const run=(...args)=>spawnSync(process.execPath,[cli,...args],{encoding:'utf8',timeout:10000,env:{...process.env,WEBHELM_ACTIONS_HOME:dir,WEBHELM_PLATFORM_DIR:platformDir}});
for(const platform of ['z','chatgpt']){
  const site=path.join(platformDir,platform);mkdirSync(path.join(site,'actions'),{recursive:true});
  const action=platform==='z'?'new-turn':'new-turn';
  writeFileSync(path.join(site,'manifest.yaml'),`platform: ${platform}\nactions:\n  ${action}: "actions/_new_turn.mjs"\n`);
  writeFileSync(path.join(site,'actions/_new_turn.mjs'),'export default async function run() { return true; }\n');
}
execFileSync('git',['init','-b','main'],{cwd:dir,stdio:'ignore'});
execFileSync('git',['add','.'],{cwd:dir,stdio:'ignore'});
execFileSync('git',['-c','user.name=Test','-c','user.email=test@invalid.local','commit','-m','test fixture'],{cwd:dir,stdio:'ignore'});
after(()=>rmSync(dir,{recursive:true,force:true}));

test('independent local action repo is discoverable without bundled platform copies',()=>{
  const result=run('platform','list');assert.equal(result.status,0,result.stderr);
  assert.deepEqual(JSON.parse(result.stdout),['chatgpt','z']);
});

test('platform profile and JS source preserve CLI compatibility',()=>{
  const profile=run('platform','profile','z');assert.equal(profile.status,0,profile.stderr);
  assert.equal(JSON.parse(profile.stdout).platform,'z');
  const source=run('platform','source','z','new-turn');assert.equal(source.status,0,source.stderr);
  assert.match(source.stdout,/export default async function/);
});

test('invalid queue action fails without sending a browser request',()=>{
  const result=run('platform','run','chatgpt','new-turn');
  assert.equal(result.status,1);assert.match(result.stderr,/thread_id and message required/);
});

test('setup/sync/publish commands are visible',()=>{
  const result=run('--help');assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/webhelm setup/);
  assert.match(result.stdout,/webhelm platform sync/);
  assert.match(result.stdout,/webhelm platform publish/);
  assert.match(result.stdout,/webhelm capacity/);
});

test('CLI explicitly rejects --workspace and does not expose Workspace provisioning commands',()=>{
  const help=run('--help');
  assert.doesNotMatch(help.stdout,/--workspace/);
  for(const args of [
    ['session','start','--workspace','VlogMusic'],
    ['session','start','--workspace=Neo'],
    ['capacity','--workspace','Neo'],
    ['session','stop','--workspace','Neo'],
  ]){
    const result=run(...args);
    assert.equal(result.status,1,args.join(' '));
    assert.match(result.stderr,/CLI is restricted to the WebHelm workspace/);
  }
  const forbidden=run('workspace','create','VlogMusic');
  assert.equal(forbidden.status,1);
  assert.match(forbidden.stderr,/unknown command:/);
});
