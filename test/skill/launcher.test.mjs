import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const launcher = resolve(import.meta.dirname, '../../skills/webhelm/bin/webhelm');

test('installed Skill launcher invokes published npm runtime with inherited npm package settings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'webhelm-launcher-test-'));
  try {
    const installedSkill=join(dir,'agents/skills/webhelm');
    mkdirSync(join(installedSkill,'bin'),{recursive:true});
    copyFileSync(launcher,join(installedSkill,'bin/webhelm'));
    const npm = join(dir, 'npm');
    writeFileSync(npm, '#!/bin/sh\nprintf "%s\\n" "$@"\n');
    chmodSync(npm, 0o755);
    const child = spawnSync('sh', [join(installedSkill,'bin/webhelm'), 'capacity'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, npm_config_package: 'unrelated@latest', npm_lifecycle_event: 'test' },
    });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(child.stdout.trim().split('\n'), [
      'exec', '--yes', '--package=webhelm@latest', '--', 'webhelm', 'capacity',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('repo-linked Skill launcher runs source directly with source mode enabled',()=>{
  const dir=mkdtempSync(join(tmpdir(),'webhelm-repo-launcher-'));
  try {
    const node=join(dir,'node');
    writeFileSync(node,'#!/bin/sh\nprintf "MODE=%s\\n" "$WEBHELM_SOURCE_MODE"\nprintf "%s\\n" "$@"\n');
    chmodSync(node,0o755);
    const child=spawnSync('sh',[launcher,'capacity'],{
      encoding:'utf8',env:{...process.env,PATH:`${dir}:${process.env.PATH}`},
    });
    assert.equal(child.status,0,child.stderr);
    assert.equal(child.stdout.trim().split('\n')[0],'MODE=1');
    assert.match(child.stdout,/bin\/webhelm\.mjs/);
    assert.match(child.stdout,/capacity/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
