import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { migrateConfig, migrateChromeProfile } from '../../runtime/migrate.mjs';

const cases = () => {
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'webhelm-migrate-test-'));
  const old=path.join(base,'browser-workspace'), dest=path.join(base,'webhelm');
  fs.mkdirSync(path.join(old,'chrome'),{recursive:true});
  fs.mkdirSync(path.join(old,'runtime'));
  fs.writeFileSync(path.join(old,'chrome','Cookies'),'encrypted-profile-content');
  fs.writeFileSync(path.join(old,'runtime','chatgpt-new-turn.sqlite3'),'fifo-data');
  return {base,old,dest,cleanup:()=>fs.rmSync(base,{recursive:true,force:true})};
};

test('atomic migration keeps profile and queue, creates legacy compatibility alias, and is idempotent',async()=>{
 const x=cases();try{
  const result=await migrateConfig({legacyRoot:x.old,configRoot:x.dest,processList:()=>'',socketCheck:async()=>false});
  assert.equal(result.status,'migrated');
  assert.equal(fs.readFileSync(path.join(x.dest,'chrome','Cookies'),'utf8'),'encrypted-profile-content');
  assert.equal(fs.readFileSync(path.join(x.old,'runtime','chatgpt-new-turn.sqlite3'),'utf8'),'fifo-data');
  assert.ok(fs.lstatSync(x.old).isSymbolicLink());
  assert.equal((await migrateConfig({legacyRoot:x.old,configRoot:x.dest})).status,'already_migrated');
 }finally{x.cleanup()}
});
test('refuses to migrate if Chrome or daemon still owns the old profile',async()=>{
 const x=cases();try{
  await assert.rejects(migrateConfig({legacyRoot:x.old,configRoot:x.dest,processList:()=>`Google Chrome --user-data-dir=${x.old}/chrome --remote-debugging-port=9222`}),/still running/);
  assert.ok(!fs.existsSync(x.dest));
  await assert.rejects(migrateConfig({legacyRoot:x.old,configRoot:x.dest,processList:()=>'/path/node-daemon.mjs daemon'}),/still running/);
  assert.ok(!fs.existsSync(x.dest));
 }finally{x.cleanup()}
});
test('refuses to replace an existing destination',async()=>{
 const x=cases();try{fs.mkdirSync(x.dest);await assert.rejects(migrateConfig({legacyRoot:x.old,configRoot:x.dest,processList:()=>''}),/already exists/);assert.ok(fs.existsSync(x.old))}finally{x.cleanup()}
});
test('refuses to move data when an old daemon socket is active',async()=>{
 const x=cases();try{
  fs.writeFileSync(path.join(x.old,'runtime','session-node.sock'),'fixture');
  await assert.rejects(migrateConfig({legacyRoot:x.old,configRoot:x.dest,processList:()=>'',socketCheck:async()=>true}),/socket is active/);
  assert.ok(!fs.existsSync(x.dest));
 }finally{x.cleanup()}
});

test('Chrome-only migration moves data into local WebHelm root and excludes it from Actions Git',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'webhelm-chrome-migrate-'));
 try {
  const old=path.join(root,'.config/webhelm/chrome'), newProfile=path.join(root,'.local/webhelm/chrome');
  fs.mkdirSync(path.join(old,'Default'),{recursive:true});
  fs.writeFileSync(path.join(old,'Default','Cookies'),'encrypted cookies preserved');
  fs.mkdirSync(path.join(root,'.local/webhelm/.git/info'),{recursive:true});
  fs.writeFileSync(path.join(root,'.local/webhelm/.git/info/exclude'),'# rules\n');
  fs.mkdirSync(path.join(root,'.config/webhelm/runtime'),{recursive:true});
  fs.writeFileSync(path.join(root,'.config/webhelm/runtime/db'),'durable fifo');
  const result=await migrateChromeProfile({oldProfile:old,newProfile,processList:()=>'',socketCheck:async()=>false});
  assert.equal(result.status,'migrated');
  assert.equal(fs.readFileSync(path.join(newProfile,'Default/Cookies'),'utf8'),'encrypted cookies preserved');
  assert.equal(fs.readFileSync(path.join(root,'.config/webhelm/runtime/db'),'utf8'),'durable fifo');
  assert.ok(fs.lstatSync(old).isSymbolicLink());
  assert.equal(fs.realpathSync(old),fs.realpathSync(newProfile));
  assert.match(fs.readFileSync(path.join(root,'.local/webhelm/.git/info/exclude'),'utf8'),/\/chrome\//);
  assert.equal((await migrateChromeProfile({oldProfile:old,newProfile})).status,'already_migrated');
 } finally {fs.rmSync(root,{recursive:true,force:true})}
});

test('Chrome-only migration is blocked during active process, socket or conflicting destination',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'webhelm-chrome-block-'));
 try {
  const old=path.join(root,'old/chrome'),target=path.join(root,'new/chrome');
  fs.mkdirSync(path.join(old,'Default'),{recursive:true});
  const opts={oldProfile:old,newProfile:target,socketCheck:async()=>false};
  await assert.rejects(migrateChromeProfile({...opts,processList:()=>`Google Chrome --user-data-dir=${old}`}),/running/);
  await assert.rejects(migrateChromeProfile({...opts,processList:()=>'/path/node-daemon.mjs daemon'}),/running/);
  fs.mkdirSync(path.join(root,'old/runtime'),{recursive:true});
  fs.writeFileSync(path.join(root,'old/runtime/session-node.sock'),'dummy');
  await assert.rejects(migrateChromeProfile({...opts,processList:()=>'',socketCheck:async()=>true}),/still accepting/);
  fs.mkdirSync(target,{recursive:true});
  await assert.rejects(migrateChromeProfile({...opts,processList:()=>''}),/Different Chrome Profiles/);
  assert.ok(fs.existsSync(path.join(old,'Default')));
 }finally{fs.rmSync(root,{recursive:true,force:true})}
});
