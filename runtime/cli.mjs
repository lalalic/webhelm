#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { ensureDaemon, request, handle, SOCKET } from './node-daemon.mjs';
import { PLATFORMS, listPlatforms, platformProfile, actionPath, validateConfig } from './platforms.mjs';
import { ACTIONS_DIR, ensureActions, syncActions, publishActions } from './actions-repo.mjs';
import { migrateConfig, migrateChromeProfile } from './migrate.mjs';
import { installLoginGuard, stageRuntimeForLoginGuard } from './login-guard.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const emit = value => console.log(JSON.stringify(value));
const arg = (items, name) => {
  const i = items.indexOf(name);
  return i === -1 ? undefined : items[i + 1];
};
const has = (items, name) => items.includes(name);

function help() {
  console.log(`webhelm — browser automation through one Node.js runtime

Usage:
  webhelm migrate  # after stopping Chrome and the old WebHelm daemon
  webhelm setup
  webhelm status
  webhelm ensure  # verify/recover managed Chrome and WebHelm group, not just daemon ping
  webhelm capacity [--workspace NAME]
  webhelm session start [--workspace NAME] [--url URL]
  webhelm session list
  webhelm session heartbeat SESSION_ID  # keep a working Session alive
  webhelm session exec SESSION_ID [--code-file FILE]   # JavaScript
  webhelm session stop SESSION_ID|--all
  webhelm platform list
  webhelm platform sync
  webhelm platform publish --message "DESCRIPTION"
  webhelm platform profile PLATFORM
  webhelm platform source PLATFORM ACTION
  webhelm platform run PLATFORM ACTION [--session-id ID | --auto-session] [--config FILE] [--mode async|sync]

Agent workflows should keep their session_id across browser actions and always stop owned sessions.
`);
}

function loadConfig(args) {
  const file = arg(args, '--config');
  if (!file) return {};
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw Error('platform config must be a JSON object');
  return cfg;
}

function validateMode(platform, action, args, config) {
  const isNewTurn = platform === 'chatgpt' && action === 'new-turn';
  const override = arg(args, '--mode');
  if (!isNewTurn && override !== undefined) throw Error('--mode is supported only for chatgpt/new-turn');
  if (!isNewTurn) return null;
  if ('sync' in config) throw Error('legacy sync is not supported; use mode: async or sync');
  if (override !== undefined && 'mode' in config && override !== config.mode) throw Error('--mode conflicts with the new-turn config mode');
  const mode = override ?? config.mode ?? 'async';
  if (typeof mode !== 'string' || !['async', 'sync'].includes(mode)) throw Error('mode must be exactly async or sync');
  if (mode === 'sync' && config.mergeable !== undefined && config.mergeable !== false) {
    throw Error('mergeable is only supported in async mode');
  }
  return mode;
}

async function runPlatform(args) {
  const platform = args[2], action = args[3]?.replaceAll('_', '-');
  if (!platform || !action) throw Error('platform run requires PLATFORM ACTION');
  await ensureActions();
  actionPath(platform, action);
  const config = loadConfig(args);
  const mode = validateMode(platform, action, args, config);
  const sid = arg(args, '--session-id');
  const auto = has(args, '--auto-session');
  validateConfig(platform, action, config);
  if (sid && auto) throw Error('--session-id and --auto-session are mutually exclusive');
  if (platform === 'chatgpt' && action === 'new-turn' && mode === 'async') {
    if (sid || auto) throw Error('async new-turn cannot use browser session options');
    if (!config.thread_id || !config.message) throw Error('thread_id and message required');
    if (typeof config.mergeable !== 'undefined' && typeof config.mergeable !== 'boolean') throw Error('mergeable must be a boolean');
    const receipt = await request({op:'chatgpt-new-turn-enqueue', config: {...config, idempotency_key: config.idempotency_key || randomUUID(), mode}});
    if (!receipt.ok || !receipt.queue_id || receipt.thread_id !== String(config.thread_id)) throw Error('ChatGPT queue returned an invalid acceptance receipt');
    const project = config.project_id || null;
    const prefix = project ? `/g/${encodeURIComponent(project)}` : '';
    return {
      platform, action, session_mode: 'durable_queue', self_heal_capable: false,
      result: {ok:true, status:'submitted', mode:'new-turn', project_id:project,
        thread_id:String(config.thread_id), thread_url:`https://chatgpt.com${prefix}/c/${encodeURIComponent(config.thread_id)}`,
        verified_by:'durable-queue', user_message_id:null, queue_id: receipt.queue_id, state:receipt.state},
    };
  }
  if (mode === 'sync' && (!sid || auto)) throw Error('sync new-turn requires a caller-owned --session-id');
  if (!sid && !auto) throw Error('platform run requires --session-id; use --auto-session only for one-shot actions');
  return request({op:'platform-run', platform, action, config: {...config, ...(mode ? {mode} : {})},
    session_id:sid, auto_session:auto, url:arg(args, '--url')});
}

async function main(args = process.argv.slice(2)) {
  const [group, command] = args;
  if (!group || ['--help', '-h', 'help'].includes(group) || has(args, '--help') || has(args, '-h')) return help();
  if (group === 'migrate') {
    await ensureActions(); // ~/.local/webhelm is the Actions Git checkout, never create an empty replacement.
    const legacy=await migrateConfig();
    const chrome=await migrateChromeProfile();
    return emit({legacy,chrome});
  }
  if (group === 'setup') {
    const repo=await ensureActions();
    const chrome=await ensureDaemon();
    const persisted=stageRuntimeForLoginGuard();
    const login_guard=installLoginGuard({cliPath:path.join(persisted.path,'bin/webhelm.mjs'),nodePath:process.execPath});
    return emit({status:'ready',...repo,daemon_pid:chrome.pid,managed_chrome:chrome.managed_chrome,login_guard});
  }
  if (group === 'ensure') return emit(await request({op:'guard-check'}));
  if (group === 'status') {
    const daemon = await ensureDaemon();
    return emit({version:daemon.version, platform_dir:PLATFORMS, root:ROOT,
      cli:fileURLToPath(import.meta.url),
      admin_helper:process.env.WEBHELM_ADMIN_HELPER || (fs.existsSync(path.join(os.homedir(),'.agents/skills/webhelm/scripts/admin.mjs')) ? path.join(os.homedir(),'.agents/skills/webhelm/scripts/admin.mjs') : path.join(ROOT,'admin.mjs')),
      managed_chrome:daemon.managed_chrome, chrome_guard:daemon.chrome_guard,
      daemon:{running:true, pid:daemon.pid, session_count:daemon.session_count, queue_paused:daemon.queue_paused, socket:SOCKET}});
  }
  if (group === 'capacity') {
    const payload={op:'capacity',workspace:arg(args,'--workspace')};
    try { return emit(await request(payload)); }
    catch(error) {
      // Rolling upgrade: query extension metadata directly until a busy old
      // Node daemon can drain its Sessions and load the new capacity operation.
      if (!String(error.message).includes('unknown op: capacity')) throw error;
      emit(await handle(payload));
      return process.exit(0); // close this CLI's one-off CDP websocket
    }
  }
  if (group === 'session') {
    if (command === 'start') return emit(await request({op:'start', workspace:arg(args,'--workspace'), url:arg(args,'--url')}));
    if (command === 'list') return emit(await request({op:'list'}));
    if (command === 'heartbeat') {
      if (!args[2]) throw Error('session heartbeat requires SESSION_ID');
      return emit(await request({op:'heartbeat',session_id:args[2]}));
    }
    if (command === 'stop') return emit(await request(has(args,'--all') ? {op:'stop-all'} : {op:'stop',session_id:args[2]}));
    if (command === 'exec') {
      if (!args[2]) throw Error('session exec requires SESSION_ID');
      const file = arg(args, '--code-file');
      const code = file ? fs.readFileSync(file, 'utf8') : fs.readFileSync(0, 'utf8');
      const result = await request({op:'exec', session_id:args[2], code});
      emit(result);
      if (!result.ok) process.exitCode = 1;
      return;
    }
  }
  if (group === 'platform') {
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
