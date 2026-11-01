import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {installLoginGuard,loginGuardDefinition} from '../../runtime/login-guard.mjs';

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
    assert.match(data,/<key>StartInterval<\/key><integer>300<\/integer>/);
    assert.match(data,/<key>RunAtLoad<\/key><true\/>/);
    assert.doesNotMatch(data,/open -a|Google Chrome\.app|killall/);
    assert.equal(installLoginGuard({home:temp,platform:'darwin',apply:false}).updated,false);
    assert.equal(installLoginGuard({home:temp,platform:'linux'}).status,'unsupported');
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
