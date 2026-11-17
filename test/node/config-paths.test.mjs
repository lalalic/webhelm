import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import * as currentPaths from '../../runtime/config-paths.mjs';

// These tests intentionally avoid the real user's Chrome profile and daemon.
test('shared runtime path module has no Browser Workspace legacy root',()=>{
  assert.equal(Object.hasOwn(currentPaths,'LEGACY_ROOT'),false);
});

test('profile consistency guard protects existing Chrome data without migration CLI',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'webhelm-profile-guard-'));
  const configBefore=process.env.WEBHELM_CONFIG_ROOT;
  const localBefore=process.env.WEBHELM_LOCAL_ROOT;
  try {
    process.env.WEBHELM_CONFIG_ROOT=path.join(root,'config');
    process.env.WEBHELM_LOCAL_ROOT=path.join(root,'local');
    const {assertProfileConsistency,OLD_PROFILE_DIR,PROFILE_DIR}=await import(`../../runtime/config-paths.mjs?isolated=${randomUUID()}`);
    assert.doesNotThrow(()=>assertProfileConsistency()); // fresh install
    fs.mkdirSync(path.join(OLD_PROFILE_DIR,'Default'),{recursive:true});
    assert.throws(()=>assertProfileConsistency(),/WebHelm Chrome profile exists/);
    fs.mkdirSync(path.join(PROFILE_DIR,'Default'),{recursive:true});
    assert.throws(()=>assertProfileConsistency(),/Two distinct WebHelm Chrome Profiles/);
    fs.rmSync(OLD_PROFILE_DIR,{recursive:true});
    fs.symlinkSync(PROFILE_DIR,OLD_PROFILE_DIR,'dir');
    assert.doesNotThrow(()=>assertProfileConsistency());
  } finally {
    if(configBefore===undefined)delete process.env.WEBHELM_CONFIG_ROOT;
    else process.env.WEBHELM_CONFIG_ROOT=configBefore;
    if(localBefore===undefined)delete process.env.WEBHELM_LOCAL_ROOT;
    else process.env.WEBHELM_LOCAL_ROOT=localBefore;
    fs.rmSync(root,{recursive:true,force:true});
  }
});
