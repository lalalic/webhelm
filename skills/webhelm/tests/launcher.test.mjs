import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const launcher = resolve(import.meta.dirname, '../bin/webhelm');

test('launcher explicitly selects WebHelm even with inherited npm package settings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'webhelm-launcher-test-'));
  try {
    const npm = join(dir, 'npm');
    writeFileSync(npm, '#!/bin/sh\nprintf "%s\\n" "$@"\n');
    chmodSync(npm, 0o755);
    const child = spawnSync('sh', [launcher, 'capacity'], {
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
