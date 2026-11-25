#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { ensureDaemon, request, SOCKET } from './node-daemon.mjs';
import { PLATFORMS, listPlatforms, platformProfile, actionPath, validateConfig, queueForAction } from './platforms.mjs';
import { ACTIONS_DIR, ensureActions, syncActions, publishActions } from './actions-repo.mjs';
import { activateRuntime, currentRuntimePath, installLoginGuard, installRuntimeUpdate, migrateLegacyRuntimeCli, stageRuntimeForLoginGuard } from './login-guard.mjs';
import { upgradeRuntime } from './auto-update.mjs';
import { cliHelp } from './cli-help.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CLI_WORKSPACE = 'WebHelm';
const emit = value => console.log(JSON.stringify(value));
const arg = (items, name) => {
  const i = items.indexOf(name);
  return i === -1 ? undefined : items[i + 1];
};
const has = (items, name) => items.includes(name);


function loadConfig(args) {
  const file = arg(args, '--config');
  if (!file) return {};
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw Error('platform config must be a JSON object');
  return cfg;
}

async function runPlatform(args) {
  const platform = args[2], action = args[3];
  if (!platform || !action) throw Error('platform run requires PLATFORM ACTION');
  await ensureActions();
  actionPath(platform, action);
  const config = loadConfig(args);
  if (arg(args,'--mode') !== undefined) throw Error('--mode has been removed; use --session-id for direct execution or omit for a registered Queue');
  const sid = arg(args, '--session-id');
  if (sid) await requireCliSession(sid);
  const auto = has(args, '--auto-session');
  validateConfig(platform, action, config);
  if (sid && auto) throw Error('--session-id and --auto-session are mutually exclusive');
  const registeredQueue=await queueForAction(platform,action);
  if (registeredQueue && !sid && !auto) {
    const receipt=await request({op:'queue-enqueue',platform,queue:registeredQueue,
      config:{...config,idempotency_key:config.idempotency_key||randomUUID(),mergeable:config.mergeable??false}});
    if (!receipt.ok || !receipt.queue_id) throw Error('queue returned an invalid acceptance receipt');
    return {platform,action,session_mode:'durable_queue',self_heal_capable:false,
      result:{ok:true,status:'queued',queue_id:receipt.queue_id,
        group:receipt.group,state:receipt.state,queue:registeredQueue}};
  }
  if (!sid && !auto) throw Error('platform run requires --session-id; use --auto-session only for one-shot actions');
  return request({op:'platform-run', platform, action, config,
    session_id:sid, auto_session:auto, url:arg(args, '--url'), workspace:CLI_WORKSPACE});
}

// The agent CLI is not a Workspace provisioning interface. Other workspaces
// belong to application code using the explicit daemon IPC API.
function rejectWorkspaceOverride(args) {
  if (has(args, '--workspace') || args.some(a=>a.startsWith('--workspace=')))
    throw Error('CLI is restricted to the WebHelm workspace; applications must provision custom workspaces through the daemon API');
}
function onlyCliWorkspace(sessions) {
  return (sessions || []).filter(item=>item.workspace === CLI_WORKSPACE);
}
async function requireCliSession(sessionId) {
  if (!sessionId) throw Error('session id is required');
  const listed = await request({op:'list'});
  if (!onlyCliWorkspace(listed.sessions).some(item=>item.session_id===sessionId))
    throw Error(`Session ${sessionId} is not owned by the WebHelm CLI workspace`);
}

async function main(args = process.argv.slice(2)) {
  const [group, command] = args;
  if (!group || ['--help', '-h', 'help'].includes(group) || has(args, '--help') || has(args, '-h') ||
      ((group === 'session' || group === 'platform' || group === 'design' || group === 'demo') && (!command || command === 'help'))) {
    const topics = group === 'help'
      ? args.slice(1).filter(item => !['--help', '-h'].includes(item))
      : ['--help', '-h'].includes(group) ? [] : args.filter(item => !['--help', '-h', 'help'].includes(item));
    if (group === 'help' && !topics.length && (has(args, '--help') || has(args, '-h'))) topics.push('help');
    return console.log(cliHelp(topics));
  }
  rejectWorkspaceOverride(args);
  if (group === 'setup') {
    const repo=await ensureActions();
    const chrome=await ensureDaemon();
    const sourceMode=process.env.WEBHELM_SOURCE_MODE==='1';
    if(!sourceMode)activateRuntime(stageRuntimeForLoginGuard().path);
    const cliPath=sourceMode
      ? fileURLToPath(new URL('../bin/webhelm.mjs',import.meta.url))
      : path.join(currentRuntimePath(),'bin/webhelm.mjs');
    const global_cli=sourceMode?{status:'source_checkout'}:migrateLegacyRuntimeCli();
    const login_guard=installLoginGuard({cliPath,nodePath:process.execPath,sourceMode});
    const auto_update=installRuntimeUpdate({cliPath,nodePath:process.execPath,sourceMode});
    return emit({status:'ready',...repo,daemon_pid:chrome.pid,managed_chrome:chrome.managed_chrome,global_cli,login_guard,auto_update});
  }
  if (group === 'upgrade') {
    if(args.some(value=>value!=='upgrade'&&value!=='--force'))
      throw Error('upgrade supports only --force');
    return emit(await upgradeRuntime({force:has(args,'--force')}));
  }
  if (group === 'ensure') {
    try { return emit(await request({op:'guard-check'})); }
    catch(error) {
      // An older, still-busy daemon can hold the same socket during a
      // rolling source upgrade. Preserve its Sessions; never hot-swap it.
      if (!String(error.message).includes('unknown op: guard-check')) throw error;
      const legacy=await request({op:'ping'});
      if (legacy.session_count>0)
        return emit({ok:true,deferred_upgrade:true,reason:'legacy_daemon_has_active_sessions',
          session_count:legacy.session_count,daemon_version:legacy.version||'unknown',
          chrome_health:'not_verified'});
      throw Error('Legacy WebHelm daemon lacks health guard; drain and migrate it before activating the new source Runtime');
    }
  }
  if (group === 'status') {
    const daemon = await ensureDaemon();
    const link=currentRuntimePath();
    let installed_version=null;
    try{installed_version=JSON.parse(fs.readFileSync(path.join(link,'package.json'),'utf8')).version;}catch{}
    const auto_update_installed=fs.existsSync(path.join(os.homedir(),'Library/LaunchAgents/com.lalalic.webhelm.runtime-update.plist'));
    return emit({version:daemon.version, installed_version, auto_update_installed,
      source_mode:process.env.WEBHELM_SOURCE_MODE==='1',platform_dir:PLATFORMS, root:ROOT,
      cli:fileURLToPath(import.meta.url),
      admin_helper:process.env.WEBHELM_ADMIN_HELPER || (fs.existsSync(path.join(os.homedir(),'.agents/skills/webhelm/scripts/admin.mjs')) ? path.join(os.homedir(),'.agents/skills/webhelm/scripts/admin.mjs') : path.join(ROOT,'admin.mjs')),
      managed_chrome:daemon.managed_chrome, chrome_guard:daemon.chrome_guard,
      daemon:{running:true, pid:daemon.pid, session_count:daemon.session_count, queue_paused:daemon.queue_paused, socket:SOCKET}});
  }
  if (group === 'capacity') {
    rejectWorkspaceOverride(args);
    const payload={op:'capacity',workspace:CLI_WORKSPACE};
    // Never run a second in-process browser controller as a fallback: it may
    // reload an older daemon's Extension while its Sessions are still active.
    return emit(await request(payload));
  }
  if (group === 'design') {
    if (command === 'status') return emit(await request({op:'design-status'}));
    if (command === 'start') {
      const url=arg(args,'--url');
      if (!url) throw Error('design start requires --url URL; select a native reference site');
      return emit(await request({op:'design-start',url}));
    }
    if (command === 'attach') {
      await requireCliSession(args[2]);
      return emit(await request({op:'design-attach',session_id:args[2]}));
    }
    if (command === 'stop') {
      await requireCliSession(args[2]);
      return emit(await request({op:'design-stop',session_id:args[2]}));
    }
    throw Error('unknown design command: '+String(command||''));
  }
  if (group === 'session') {
    if (command === 'start') return emit(await request({op:'start', workspace:CLI_WORKSPACE, url:arg(args,'--url')}));
    if (command === 'list') {
      const result=await request({op:'list'});
      const sessions=onlyCliWorkspace(result.sessions);
      return emit({session_count:sessions.length,sessions});
    }
    if (command === 'heartbeat') {
      await requireCliSession(args[2]);
      return emit(await request({op:'heartbeat',session_id:args[2]}));
    }
    if (command === 'stop') {
      if (has(args,'--all')) return emit(await request({op:'stop-workspace',workspace:CLI_WORKSPACE}));
      await requireCliSession(args[2]);
      return emit(await request({op:'stop',session_id:args[2]}));
    }
    if (command === 'exec') {
      await requireCliSession(args[2]);
      const file = arg(args, '--code-file');
      const code = file ? fs.readFileSync(file, 'utf8') : fs.readFileSync(0, 'utf8');
      const result = await request({op:'exec', session_id:args[2], code});
      emit(result);
      if (!result.ok) process.exitCode = 1;
      return;
    }
  }
  if (group === 'demo') {
    const sessionId = command;
    const demoCommand = args[2];
    const valueOptions={step:['--title'],spotlight:['--ref','--label','--text'],annotate:['--ref','--label','--text'],
      caption:['--text'],say:['--text'],cursor:['--ref','--label'],highlight:['--ref','--label'],wait:['--ms'],
      clear:[],pause:[],resume:[],status:[],start_recording:['--output-dir','--fps'],
      stop_recording:['--output-dir','--markcut']};
    const allowed=valueOptions[demoCommand];
    if(!allowed)throw Error(`unknown Demo command: ${String(demoCommand||'')}`);
    const booleanOptions=demoCommand==='stop_recording'?['--render','--no-render','--no-voice']:[];
    for(let index=3;index<args.length;index++){
      const option=args[index];
      if(allowed.includes(option)){
        const value=args[++index];
        if(!value||value.startsWith('--'))throw Error(`${option} requires a value`);
      }else if(!booleanOptions.includes(option))throw Error(`unsupported ${demoCommand} option: ${option}`);
    }
    if(has(args,'--render')&&has(args,'--no-render'))throw Error('Choose --render or --no-render, not both');
    await requireCliSession(sessionId);
    const option = name => arg(args, name);
    return emit(await request({
      op:'demo', session_id:sessionId, command:demoCommand,
      arguments:{
        title:option('--title'), text:option('--text'), ref:option('--ref'),
        label:option('--label'), ms:option('--ms') === undefined ? undefined : Number(option('--ms')),
      },
      output_dir:option('--output-dir'), markcut:option('--markcut'),
      render:has(args,'--render') || !has(args,'--no-render'), voice:!has(args,'--no-voice'),
      fps:option('--fps') === undefined ? undefined : Number(option('--fps')),
    }));
  }
  if (group === 'platform') {
    rejectWorkspaceOverride(args);
    if (command === 'sync') return emit(await syncActions());
    if (command === 'publish') return emit(await publishActions(arg(args, '--message')));
    await ensureActions();
    if (command === 'list') return emit(listPlatforms());
    if (command === 'profile') return emit(platformProfile(args[2]));
    if (command === 'source') return console.log(fs.readFileSync(actionPath(args[2],args[3]), 'utf8'));
    if (command === 'run') {
      const result = await runPlatform(args);
      // Preserve the legacy caller contract even when a rolling-upgrade daemon
      // still emits only `result.value`. Do not alter already logged stdout.
      if(result?.result?.ok===true && result.result.value!==undefined && !String(result.result.stdout||'').trim())
        result.result.stdout=JSON.stringify(result.result.value);
      emit(result);
      if (result?.result?.ok === false) process.exitCode = 1;
      return;
    }
  }
  throw Error(`unknown command: ${args.join(' ')}`);
}

main().catch(error => { console.error(JSON.stringify({error:error.message})); process.exitCode=1; });
