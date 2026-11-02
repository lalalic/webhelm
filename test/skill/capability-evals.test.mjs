import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const dir=path.join(path.dirname(fileURLToPath(import.meta.url)),'evals');
const cases=JSON.parse(fs.readFileSync(path.join(dir,'cases.json'),'utf8'));
const schema=JSON.parse(fs.readFileSync(path.join(dir,'decision.schema.json'),'utf8'));

test('skill behavior matrix covers choices, failure, extension and approval',()=>{
  assert.equal(cases.length>=9,true);
  assert.equal(new Set(cases.map(c=>c.id)).size,cases.length);
  assert.deepEqual(new Set(cases.map(c=>c.expectedRoute)),new Set(schema.properties.route.enum));
  assert.ok(cases.some(c=>c.forbiddenCommands.some(x=>x.includes('stop --all'))));
  assert.ok(cases.some(c=>c.requiresAuthorization));
  for(const c of cases){
    assert.match(c.id,/^[a-z]+(?:-[a-z]+)*$/);
    assert.ok(c.goal.length>35);
    for(const field of ['requiredCommands','forbiddenCommands']){
      assert.ok(Array.isArray(c[field]));
      assert.equal(new Set(c[field]).size,c[field].length);
    }
    assert.equal(typeof c.requiresAuthorization,'boolean');
  }
});
