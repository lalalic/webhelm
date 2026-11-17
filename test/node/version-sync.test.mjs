import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {syncExtensionVersion} from '../../scripts/sync-extension-version.mjs';
import {extensionVersion} from '../../runtime/extension-manager.mjs';

const repo=fileURLToPath(new URL('../../',import.meta.url));
const pkg=JSON.parse(fs.readFileSync(path.join(repo,'package.json'),'utf8'));
const extension=JSON.parse(fs.readFileSync(path.join(repo,'runtime/extension/manifest.json'),'utf8'));

test('checked-in Runtime and Chrome Extension share one version',()=>{
  assert.equal(extension.version,pkg.version);
  assert.equal(extensionVersion,pkg.version);
  assert.deepEqual(syncExtensionVersion(undefined,undefined,{checkOnly:true}),
    {runtime:pkg.version,extension:pkg.version,changed:false});
});

test('version sync rejects mismatched releases in check-only mode, stamps in sync mode',()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'webhelm-version-'));
  try {
    const p=path.join(tmp,'package.json'),m=path.join(tmp,'manifest.json');
    const pkg={name:'webhelm',version:'1.0.409'};
    const manifest={manifest_version:3,name:'WebHelm',version:'0.4.14',key:'do-not-change'};
    fs.writeFileSync(p,JSON.stringify(pkg)+'\n');
    fs.writeFileSync(m,JSON.stringify(manifest,null,2)+'\n');
    const original=fs.readFileSync(m,'utf8');
    assert.throws(()=>syncExtensionVersion(p,m,{checkOnly:true}),/version mismatch/i);
    assert.equal(fs.readFileSync(m,'utf8'),original,'check-only must not modify the manifest');
    assert.deepEqual(syncExtensionVersion(p,m),{runtime:pkg.version,extension:pkg.version,changed:true});
    const updated=JSON.parse(fs.readFileSync(m,'utf8'));
    assert.equal(updated.version,'1.0.409');
    assert.equal(updated.key,manifest.key,'manifest signing identity must not change');
    assert.deepEqual(syncExtensionVersion(p,m),{runtime:pkg.version,extension:pkg.version,changed:false});
    assert.deepEqual(syncExtensionVersion(p,m,{checkOnly:true}),{runtime:pkg.version,extension:pkg.version,changed:false});
  } finally { fs.rmSync(tmp,{recursive:true,force:true}); }
});

test('version sync rejects invalid Chrome version schemes',()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'webhelm-version-invalid-'));
  try {
    const p=path.join(tmp,'package.json'),m=path.join(tmp,'manifest.json');
    fs.writeFileSync(p,JSON.stringify({name:'webhelm',version:'1.0.35-beta'}));
    fs.writeFileSync(m,JSON.stringify({manifest_version:3,version:'1.0.34'}));
    assert.throws(()=>syncExtensionVersion(p,m),/Invalid WebHelm/);
  } finally { fs.rmSync(tmp,{recursive:true,force:true}); }
});
