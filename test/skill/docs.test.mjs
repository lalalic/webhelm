import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const skill=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../skills/webhelm');

test('WebHelm Skill is a concise browser-use interface, not a maintenance guide',()=>{
  const text=fs.readFileSync(path.join(skill,'SKILL.md'),'utf8');
  assert.match(text,/^---\nname: webhelm\n/m);
  assert.match(text,/webhelm session exec SESSION_ID/);
  assert.match(text,/webhelm platform run PLATFORM ACTION/);
  assert.match(text,/--help/);
  assert.match(text,/description:.*Chrome.*platform Actions/i);
  assert.match(text,/Initial setup.*webhelm setup/s);
  assert.match(text,/webhelm session start.*webhelm session stop SESSION_ID/s);
  assert.match(text,/page_info.*snapshot/s);
  assert.match(text,/platform profile PLATFORM/);
  assert.match(text,/platforms\/NEW_PLATFORM\.md/);
  assert.match(text,/relevant to the task/);
  assert.doesNotMatch(text,/workspace|queue|migration|migrate|launchagent|runtime\/extension|developer/i);
  assert.ok(text.split(/\s+/).length<1500);
  for(const old of ['interaction-skills','NEW_PLATFORM.md','AGENTS.md','tests']){
    assert.equal(fs.existsSync(path.join(skill,old)),false,`${old} is not an end-user Skill artifact`);
  }
});
