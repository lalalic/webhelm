import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const skill=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../skills/webhelm');

test('WebHelm Skill is a concise browser-use interface, not a maintenance guide',()=>{
  const text=fs.readFileSync(path.join(skill,'SKILL.md'),'utf8');
  assert.match(text,/^---\nname: webhelm\n/m);
  assert.match(text,/webhelm session exec "\$SESSION_ID"/);
  assert.match(text,/webhelm platform run --help/);
  assert.match(text,/--help/);
  assert.match(text,/description:.*Chrome.*platform Actions/i);
  assert.match(text,/Initial setup.*webhelm setup/s);
  assert.match(text,/webhelm session start.*trap .*webhelm session stop "\$SESSION_ID"/s);
  assert.match(text,/page_info.*snapshot.*click/s);
  assert.match(text,/without `--url` opens `about:blank`/);
  assert.match(text,/Before using a Session, plan \*\*all three commands\*\*/);
  assert.match(text,/platform profile PLATFORM/);
  assert.match(text,/platforms\/NEW_PLATFORM\.md/);
  assert.match(text,/relevant to the task/);
  assert.doesNotMatch(text,/workspace|queue|migration|migrate|launchagent|runtime\/extension|developer/i);
  assert.ok(text.split(/\s+/).length<1500);
  for(const old of ['interaction-skills','NEW_PLATFORM.md','AGENTS.md','tests']){
    assert.equal(fs.existsSync(path.join(skill,old)),false,`${old} is not an end-user Skill artifact`);
  }
});


test('documented session example stops only its owned Session after exec failure',()=>{
  const text=fs.readFileSync(path.join(skill,'SKILL.md'),'utf8');
  const script=text.split('## Sessions: always start and stop as a pair')[1].match(/```sh\n([\s\S]*?)\n```/)?.[1];
  assert.ok(script,'missing shell example');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'webhelm-skill-life-'));
  const bin=path.join(dir,'webhelm'),log=path.join(dir,'commands');
  fs.writeFileSync(bin,`#!/bin/sh
printf '%s\\n' "$*" >> "$WEBHELM_EVAL_LOG"
case "$1 $2" in
  'session start') printf '{"session_id":"task-owned-42"}\\n' ;;
  'session exec') echo '{"ok":false}' >&2; exit 1 ;;
  'session stop') exit 0 ;;
esac
`);
  fs.chmodSync(bin,0o755);
  try {
    const result=spawnSync('/bin/sh',['-c',script],{encoding:'utf8',timeout:5000,
      env:{...process.env,PATH:`${dir}:${process.env.PATH}`,WEBHELM_EVAL_LOG:log}});
    assert.equal(result.status,1,'the exec failure must not become success');
    assert.deepEqual(fs.readFileSync(log,'utf8').trim().split('\n'),[
      'session start --url https://example.com','session exec task-owned-42','session stop task-owned-42',
    ]);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('new-platform guide is owned by Actions, not duplicated in the Runtime repo',()=>{
  const repo=path.resolve(skill,'../..');
  assert.equal(fs.existsSync(path.join(repo,'docs/NEW_PLATFORM.md')),false);
  assert.match(fs.readFileSync(path.join(repo,'AGENTS.md'),'utf8'),/platforms\/NEW_PLATFORM\.md/);
  assert.match(fs.readFileSync(path.join(repo,'README.md'),'utf8'),/webhelm-actions\/blob\/main\/platforms\/NEW_PLATFORM\.md/);
});
