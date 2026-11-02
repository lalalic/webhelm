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
const target=process.argv.find(a=>a.startsWith('--target='))?.slice(9) || 'codex:default';
if(!target.startsWith('codex:') || target.length<=6) throw Error(`Unsupported eval target: ${target}. Use codex:<model>`);
const model=target.slice(6);
const openrouter=model==='openrouter/free' || model.endsWith(':free');
const timeoutMs=Number(process.argv.find(a=>a.startsWith('--timeout-ms='))?.slice(13) || '120000');
if(!Number.isInteger(timeoutMs) || timeoutMs<5000 || timeoutMs>180000) throw Error('timeout-ms must be 5000..180000');
if(process.argv.includes('--list')) { for(const c of cases) console.log(c.id); process.exit(0); }
const selected=ids.length ? cases.filter(c=>ids.includes(c.id)) : cases;
if(!selected.length || ids.some(id=>!cases.some(c=>c.id===id))) throw Error('Unknown or empty eval case selection');

let failures=0, blocked=0;
console.log(`Eval target: ${target}${openrouter?' (OpenRouter free provider)':''}`);
for(const testCase of selected) {
  const work=fs.mkdtempSync(path.join(os.tmpdir(),'webhelm-skill-eval-'));
  try {
    const output=path.join(work,'decision.json');
    const prompt=`You are an agent planning how to fulfill a user request with the WebHelm Skill below.\n\n${skill}\n\nUSER TASK: ${testCase.goal}\n\nThis is a decision-only dry run: DO NOT use tools, run commands, browse, send messages, open sessions, or perform side effects. Respond only with a JSON object using the requested output schema. In commands, name the concrete CLI commands or relevant reference paths you would consult, in execution order. Do not fabricate inputs or success. Set claimsSuccess=false because nothing has actually executed. Route must be setup, session, platform, extend, or decline. Decline means ask for missing authorization before an external write. The commands field should be a list of expected command steps. References can list docs that you would read. If an operation has no browser Session requirement, do not invent one.\n`;
    const args=['exec','--sandbox','read-only','--skip-git-repo-check','--ephemeral','--ignore-rules'];
    if(openrouter) args.push('-c','model_provider="openrouter"','-m',model);
    else if(model==='default') args.push('--ignore-user-config');
    else args.push('-m',model);
    args.push('-C',work,'--output-schema',path.join(dir,'decision.schema.json'),'-o',output,'-');
    const call=spawnSync('codex',args,{input:prompt,encoding:'utf8',timeout:timeoutMs,maxBuffer:1024*1024*4});
    if(call.error || call.status!==0 || !fs.existsSync(output)) {
      blocked++;
      const stderr=call.stderr||'';
      const reason=call.error?.code==='ETIMEDOUT' ? `timeout after ${timeoutMs}ms`
        : /429|Too Many Requests/i.test(stderr) ? 'OpenRouter HTTP 429 rate limit'
        : /5\d\d|server error/i.test(stderr) ? 'provider/server error'
        : call.error?.message || `Codex exited ${call.status ?? 'without output'}`;
      console.log(`BLOCKED ${testCase.id}: ${reason}`);
      continue;
    }
    let answer;
    try {
      const raw=fs.readFileSync(output,'utf8').trim();
      // Some OpenRouter models wrap structured output in a Markdown JSON fence.
      const json=raw.replace(/^```(?:json)?\s*\n?/i,'').replace(/\n?```\s*$/,'').trim();
      answer=JSON.parse(json);
    }
    catch(error){ console.log(`FAIL ${testCase.id}: malformed model JSON ${error.message}`);failures++;continue; }
    const combined=[...(answer.commands||[]),...(answer.references||[])].join('\n').toLowerCase();
    const missing=testCase.requiredCommands.filter(c=>!combined.includes(c.toLowerCase()));
    // Reference/help inspection is not command execution. Only actual intended
    // commands may violate a forbidden-command assertion.
    const execution=(answer.commands||[]).join('\n').toLowerCase();
    const forbidden=testCase.forbiddenCommands.filter(c=>execution.includes(c.toLowerCase()));
    const errors=[];
    const requiredFields=['route','commands','references','requiresAuthorization','claimsSuccess'];
    const absent=requiredFields.filter(field=>!Object.hasOwn(answer,field));
    const extras=Object.keys(answer).filter(field=>!requiredFields.includes(field));
    if(absent.length) errors.push(`missing schema fields: ${absent.join(', ')}`);
    if(extras.length) errors.push(`unexpected schema fields: ${extras.join(', ')}`);
    if(!Array.isArray(answer.commands) || !Array.isArray(answer.references)) errors.push('commands/references must be arrays');
    const allowedRoutes=[testCase.expectedRoute,...(testCase.alternativeRoutes||[])];
    if(!allowedRoutes.includes(answer.route))errors.push(`route=${answer.route}; expected one of ${allowedRoutes.join(',')}`);
    if(testCase.requiredAny?.length && !testCase.requiredAny.some(c=>combined.includes(c.toLowerCase())))
      errors.push(`missing repair intent: one of ${testCase.requiredAny.join(', ')}`);
    if(answer.requiresAuthorization!==testCase.requiresAuthorization)errors.push(`requiresAuthorization=${answer.requiresAuthorization}`);
    if(answer.claimsSuccess!==false) errors.push('claims success without execution');
    if(missing.length)errors.push(`missing: ${missing.join(', ')}`);
    if(forbidden.length)errors.push(`forbidden: ${forbidden.join(', ')}`);
    console.log(`${errors.length?'FAIL':'PASS'} ${testCase.id}${errors.length?' — '+errors.join('; '):''}`);
    console.log(JSON.stringify(answer));
    if(errors.length)failures++;
  } finally {fs.rmSync(work,{recursive:true,force:true});}
}
console.log(`Capability evals (${target}): ${selected.length-failures-blocked}/${selected.length} PASS, ${failures} FAIL, ${blocked} BLOCKED`);
if(failures||blocked)process.exitCode=1;
