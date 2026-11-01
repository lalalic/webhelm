import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync, readdirSync, mkdtempSync, rmSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source=path.join(root,'skills/webhelm/extension');
const script=path.join(root,'skills/webhelm/scripts/prepare-local-extension.mjs');

test('MV3 service worker and imported module parse before release',()=>{
  for(const name of ['service-worker.mjs','workspace-manager.mjs','workspace-page.mjs']){
    const parsed=spawnSync(process.execPath,['--check',path.join(source,name)],{encoding:'utf8'});
    assert.equal(parsed.status,0,`${name}: ${parsed.stderr}`);
  }
});

test('offline extension staging validates the current source and ID',t=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'webhelm-ext-test-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const staged=spawnSync(process.execPath,[script,source,dir],{encoding:'utf8'});
  assert.equal(staged.status,0,staged.stderr);
  const manifest=JSON.parse(readFileSync(path.join(source,'manifest.json'),'utf8'));
  const installed=path.join(dir,`browser-workspace-${manifest.version}`);
  assert.deepEqual(readdirSync(installed).sort(),readdirSync(source).sort());
  const again=spawnSync(process.execPath,[script,source,dir],{encoding:'utf8'});
  assert.equal(again.status,0,again.stderr);
  assert.match(staged.stdout,/Extension ID: kkkpgmhpoeceojalkpfdidffdfnlgdog/);
});
