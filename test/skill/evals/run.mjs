#!/usr/bin/env node
// Skill behavior eval. Executes a dry-run reasoning prompt through the locally
// authenticated Codex harness (not a WebHelm browser integration test).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const dir=path.dirname(fileURLToPath(import.meta.url));
const skill=fs.readFileSync(path.resolve(dir,'../../../skills/webhelm/SKILL.md'),'utf8');
const cases=JSON.parse(fs.readFileSync(path.join(dir,'cases.json'),'utf8'));
const ids=process.argv.filter(a=>a.startsWith('--case=')).map(a=>a.slice(7));
if(process.argv.includes('--list')) { for(const c of cases) console.log(c.id); process.exit(0); }
const selected=ids.length ? cases.filter(c=>ids.includes(c.id)) : cases;
if(!selected.length || ids.some(id=>!cases.some(c=>c.id===id))) throw Error('Unknown or empty eval case selection');

let failures=0;
for(const testCase of selected) {
  const work=fs.mkdtempSync(path.join(os.tmpdir(),'webhelm-skill-eval-'));
  try {
    const output=path.join(work,'decision.json');
    const prompt=`You are an agent planning how to fulfill a user request with the WebHelm Skill below.\n\n${skill}\n\nUSER TASK: ${testCase.goal}\n\nThis is a decision-only dry run: DO NOT use tools, run commands, browse, send messages, open sessions, or perform side effects. Respond only with a JSON object using the requested output schema. In commands, name the concrete CLI commands or relevant reference paths you would consult, in execution order. Do not fabricate inputs or success. Set claimsSuccess=false because nothing has actually executed. Route must be setup, session, platform, extend, or decline. Decline means ask for missing authorization before an external write. The commands field should be a list of expected command steps. References can list docs that you would read. If an operation has no browser Session requirement, do not invent one.\n`;
    const args=['exec','--sandbox','read-only','--skip-git-repo-check','--ephemeral','--ignore-user-config','--ignore-rules',
      '-C',work,'--output-schema',path.join(dir,'decision.schema.json'),'-o',output,'-'];
    const call=spawnSync('codex',args,{input:prompt,encoding:'utf8',timeout:120000,maxBuffer:1024*1024*4});
    if(call.error || call.status!==0 || !fs.existsSync(output)) {
      failures++;
      console.log(`BLOCKED ${testCase.id}: ${(call.stderr || call.error?.message || 'no response').slice(-800)}`);
      continue;
    }
    let answer;
    try { answer=JSON.parse(fs.readFileSync(output,'utf8')); }
    catch(error){ console.log(`FAIL ${testCase.id}: malformed model JSON ${error.message}`);failures++;continue; }
    const combined=[...(answer.commands||[]),...(answer.references||[])].join('\n').toLowerCase();
    const missing=testCase.requiredCommands.filter(c=>!combined.includes(c.toLowerCase()));
    const forbidden=testCase.forbiddenCommands.filter(c=>combined.includes(c.toLowerCase()));
    const errors=[];
    if(answer.route!==testCase.expectedRoute)errors.push(`route=${answer.route}; expected=${testCase.expectedRoute}`);
    if(answer.requiresAuthorization!==testCase.requiresAuthorization)errors.push(`requiresAuthorization=${answer.requiresAuthorization}`);
    if(answer.claimsSuccess!==false) errors.push('claims success without execution');
    if(missing.length)errors.push(`missing: ${missing.join(', ')}`);
    if(forbidden.length)errors.push(`forbidden: ${forbidden.join(', ')}`);
    console.log(`${errors.length?'FAIL':'PASS'} ${testCase.id}${errors.length?' — '+errors.join('; '):''}`);
    console.log(JSON.stringify(answer));
    if(errors.length)failures++;
  } finally {fs.rmSync(work,{recursive:true,force:true});}
}
console.log(`Capability evals: ${selected.length-failures}/${selected.length} PASS`);
if(failures)process.exitCode=1;
