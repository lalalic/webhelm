import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {installLoginGuard,loginGuardDefinition,stageRuntimeForLoginGuard} from '../../runtime/login-guard.mjs';

test('login guard provides a scheduled daemon check, without replacing Chrome apps',()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'webhelm-login-guard-'));
  try{
    const launcher=path.join(temp,'.local/bin/webhelm');
    fs.mkdirSync(path.dirname(launcher),{recursive:true});fs.writeFileSync(launcher,'#!/bin/sh\n');
    const r=installLoginGuard({home:temp,platform:'darwin',apply:false});
    assert.equal(r.status,'staged');
    assert.ok(r.updated);
    const data=fs.readFileSync(r.path,'utf8');
    assert.equal(data,loginGuardDefinition(temp));
    assert.match(data,/<key>StartInterval<\/key><integer>30<\/integer>/);
    assert.match(data,/<key>RunAtLoad<\/key><true\/>/);
    assert.match(data,/<string>ensure<\/string>/);
    assert.doesNotMatch(data,/<string>status<\/string>/);
    assert.doesNotMatch(data,/open -a|Google Chrome\.app|killall/);
    assert.equal(installLoginGuard({home:temp,platform:'darwin',apply:false}).updated,false);
    const stable=path.join(temp,'cached/webhelm/cli.mjs');
    fs.mkdirSync(path.dirname(stable),{recursive:true});fs.writeFileSync(stable,'#!/usr/bin/env node\n');
    const offline=installLoginGuard({home:temp,platform:'darwin',apply:false,nodePath:'/usr/local/bin/node',cliPath:stable});
    assert.ok(offline.updated);
    assert.ok(fs.readFileSync(offline.path,'utf8').includes(`<string>${stable}</string><string>ensure</string>`));
    assert.equal(installLoginGuard({home:temp,platform:'linux'}).status,'unsupported');
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
});

test('daemon login runtime is versioned and survives npx cache removal',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'webhelm-stable-runtime-'));
  const repo=path.resolve(path.dirname(new URL(import.meta.url).pathname),'../..');
  try {
    const a=stageRuntimeForLoginGuard({home:dir,source:repo});
    assert.equal(a.updated,true);
    assert.ok(fs.existsSync(path.join(a.path,'node_modules/yaml/package.json')));
    assert.ok(fs.existsSync(path.join(a.path,'bin/webhelm.mjs')));
    assert.equal(stageRuntimeForLoginGuard({home:dir,source:repo}).updated,false);
    const p=installLoginGuard({home:dir,platform:'darwin',apply:false,nodePath:process.execPath,cliPath:path.join(a.path,'bin/webhelm.mjs')});
    const xml=fs.readFileSync(p.path,'utf8');
    assert.ok(xml.includes(a.path));
    assert.match(xml,/<string>ensure<\/string>/);
    assert.doesNotMatch(xml,/_npx/);
  } finally{fs.rmSync(dir,{recursive:true,force:true});}
});
