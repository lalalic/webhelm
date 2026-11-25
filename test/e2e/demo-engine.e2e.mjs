#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const EVIDENCE_ROOT = process.env.WEBHELM_DEMO_EVIDENCE_DIR ||
  path.join(os.tmpdir(), `webhelm-demo-evidence-${Date.now()}`);
const CDP_URL = process.env.WEBHELM_CDP_URL || 'http://127.0.0.1:9222';
const MARKCUT = process.env.WEBHELM_DEMO_MARKCUT || spawnSync('which', ['markcut'], { encoding: 'utf8' }).stdout.trim();
if (!MARKCUT) throw new Error('Markcut CLI is required; set WEBHELM_DEMO_MARKCUT to its executable path');

process.env.WEBHELM_CDP_URL = CDP_URL;
process.env.WEBHELM_NO_PROFILE_EXTENSION_PROBE = '1';

const { pathToFileURL, fileURLToPath } = await import('node:url');
const daemonModule = fileURLToPath(new URL('../../runtime/node-daemon.mjs', import.meta.url));
const { handle } = await import(pathToFileURL(daemonModule).href);

let sessions = [];
let server;
let serverUrl;
let primary;
let secondary;
let outputDir;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => code === 0 || options.acceptFailure
      ? resolve({ code, stdout, stderr })
      : reject(new Error(`${command} exited ${code}: ${stderr.slice(-1000)}`)));
  });
}

async function startFixtureServer() {
  server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><html><head><title>Demo fixture</title></head>
      <body><main><h1>Preferences</h1>
      <button id="preferences" aria-label="Preferences">Preferences</button>
      <output id="count">0</output></main>
      <script>document.getElementById('preferences').addEventListener('click', () => {
        const output = document.getElementById('count'); output.textContent = Number(output.textContent) + 1;
      });</script></body></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  serverUrl = `http://127.0.0.1:${port}/demo-fixture.html`;
}

async function exec(sessionId, code) {
  const result = await handle({ op: 'exec', session_id: sessionId, code });
  if (!result.ok) throw new Error(result.stderr || result.error || 'Session exec failed');
  return result;
}

async function demo(sessionId, command, args = {}, options = {}) {
  const payload = { op: 'demo', session_id: sessionId, command, arguments: args };
  if (options.outputDir) payload.output_dir = options.outputDir;
  if (options.markcut) payload.markcut = options.markcut;
  if (options.fps !== undefined) payload.fps = options.fps;
  if (options.voice !== undefined) payload.voice = options.voice;
  if (options.render !== undefined) payload.render = options.render;
  try {
    return await handle(payload);
  } catch(error) {
    if (options.expectFailure && new RegExp(options.expectFailure).test(error.message)) {
      return { expected_error: error.message };
    }
    throw error;
  }
}

async function startSession() {
  const result = await handle({ op: 'start', workspace: 'WebHelm', url: 'about:blank' });
  sessions.push(result.session_id);
  await exec(result.session_id, `await goto_url(${JSON.stringify(serverUrl)});\nreturn (await page_info()).url`);
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      if ((await exec(result.session_id, 'return (await page_info()).url')).value === serverUrl) break;
    } catch {}
    await sleep(100);
  }
  return result.session_id;
}

async function probeJson(file) {
  const result = await run('ffprobe', [
    '-v', 'error', '-show_streams', '-show_format', '-of', 'json', file,
  ]);
  return JSON.parse(result.stdout);
}

async function extractFrame(file, time, destination) {
  await run('ffmpeg', [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', time.toFixed(3), '-i', file, '-frames:v', '1', destination,
  ]);
  const bytes = await fs.readFile(destination);
  return {
    path: destination,
    bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
}

async function checkOwnedTargetsClosed(urls) {
  const response = await fetch(new URL('/json/list', CDP_URL));
  const targets = await response.json();
  const ownedRemaining = targets.filter(target => urls.includes(target.url));
  if (ownedRemaining.length) throw new Error(`Owned E2E tabs remain open: ${ownedRemaining.length}`);
  return { inspected_target_count: targets.length, owned_remaining: 0 };
}

async function cleanup() {
  for (const sessionId of [...sessions].reverse()) {
    await handle({ op: 'stop', session_id: sessionId }).catch(() => {});
    sessions = sessions.filter(id => id !== sessionId);
  }
  if (server) await new Promise(resolve => server.close(resolve));
}

try {
  await fs.mkdir(EVIDENCE_ROOT, { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(EVIDENCE_ROOT, 'frames'), { recursive: true, mode: 0o700 });
  await startFixtureServer();
  const ping = await handle({ op: 'ping' });
  primary = await startSession();
  secondary = await startSession();
  const initialPrimary = await exec(primary, 'return await js(\'({href:location.href,ticks:Number(document.getElementById("count").textContent||0)})\')');
  const initialSecondary = await exec(secondary, 'return await js(\'({href:location.href,ticks:Number(document.getElementById("count").textContent||0)})\')');
  console.error('e2e: initial sessions ready');
  if (initialPrimary.value.ticks !== 0 || initialSecondary.value.ticks !== 0) {
    throw new Error('Fixture sessions did not start independently at zero state');
  }

  const statusBefore = await demo(primary, 'status');
  outputDir = path.join(EVIDENCE_ROOT, 'output');
  await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });
  const start = await demo(primary, 'start_recording', {}, { outputDir, fps: 15 });
  console.error('e2e: recording started');
  await demo(primary, 'step', { title: 'Open preferences' });
  const clickCode = [
    'await click(\'button[aria-label="Preferences"]\');',
    'await wait(0.1);',
    'const ticks = await js(\'Number(document.getElementById("count").textContent||0)\');',
    'return { ticks };',
  ].join('\n');
  const clickResult = await exec(primary, clickCode);
  if (clickResult.value.ticks !== 1) throw new Error('Real WebHelm click did not change the fixture');
  console.error('e2e: real click verified');
  const snapshot = await exec(primary, 'return await snapshot()');
  const target = /- button "([^"]*)" \[ref=([^\]]+)\]/.exec(snapshot.value);
  if (!target || target[1].toLowerCase() !== 'preferences') throw new Error('Snapshot did not expose the expected Preferences target');
  const domBeforeOverlay = await exec(primary, 'return await js("document.body.innerHTML")');
  const spotlight = await demo(primary, 'spotlight', { ref: target[2], text: 'Account settings' });
  const annotate = await demo(primary, 'annotate', { ref: target[2], text: 'Click to open preferences' });
  const cursor = await demo(primary, 'cursor', { ref: target[2] });
  await demo(primary, 'caption', { text: 'Preferences opened' });
  await demo(primary, 'say', { text: 'Preferences are ready' });
  await demo(primary, 'highlight', { label: 'Preferences' });
  await demo(primary, 'wait', { ms: 800 });
  const pausedStatus = await demo(primary, 'pause');
  const blockedDuringPause = await demo(primary, 'caption', { text: 'blocked' }, {
    expectFailure: 'Demo paused: call resume before adding events',
  });
  const resume = await demo(primary, 'resume');
  await demo(primary, 'clear');
  const domAfterOverlay = await exec(primary, 'return await js("document.body.innerHTML")');
  if (domAfterOverlay.value !== domBeforeOverlay.value) throw new Error('Demo overlays changed target UI DOM');
  const secondaryDuringRecording = await exec(secondary, 'return await js(\'Number(document.getElementById("count").textContent||0)\')');
  console.error('e2e: isolation checked before stop');
  const stop = await demo(primary, 'stop_recording', {}, {
    outputDir, markcut: MARKCUT, render: true, voice: true, fps: 15,
  });
  const completedStatus = await demo(primary, 'status');
  if (completedStatus.completed_recording?.video_recorded !== true) throw new Error('Status did not retain verified completed-recording state');
  console.error('e2e: recording exported');

  const captureProbe = await probeJson(path.join(outputDir, 'capture.mp4'));
  const finalProbe = await probeJson(path.join(outputDir, 'markcut', 'video.mp4'));
  const timeline = JSON.parse(await fs.readFile(path.join(outputDir, 'timeline.json'), 'utf8'));
  const offsetSeconds = timeline.video_time_offset_ms / 1000;
  const events = timeline.events || [];
  if (events.length !== 11) throw new Error(`Expected 11 recorded Demo events, received ${events.length}`);
  if (events.some(event => event.relative_ms < 0)) throw new Error('Negative Demo event timing');
  const lastEventEnd = Math.max(...events.map(event => (event.relative_ms / 1000) +
    (event.command === 'highlight' ? 0.65 : event.command === 'cursor' ? 0.48 : 0))) + offsetSeconds;
  if (lastEventEnd > Number(captureProbe.format.duration)) {
    throw new Error('Timeline effects extend beyond captured media');
  }

  const captureDuration = Number(captureProbe.format.duration);
  const frameTimes = [0.05, offsetSeconds + 0.1, offsetSeconds + 0.35,
    Math.min(offsetSeconds + 0.8, captureDuration - 0.05), Math.max(0.05, captureDuration - 0.1)];
  const frames = [];
  for (const [index, time] of frameTimes.entries()) {
    frames.push(await extractFrame(path.join(outputDir, 'capture.mp4'), time,
      path.join(EVIDENCE_ROOT, 'frames', `capture-${String(index).padStart(2, '0')}.png`)));
  }
  if (new Set(frames.map(frame => frame.sha256)).size < 4) {
    throw new Error('Representative capture frames did not show sufficient visual change');
  }

  const videoMd = await fs.readFile(path.join(outputDir, 'markcut', 'video.md'), 'utf8');
  const narrationAssets = (await fs.readdir(path.join(outputDir, 'markcut', 'assets')))
    .filter(file => /^voice-\d{3}\.m4a$/.test(file));
  if (!events.some(event => event.command === 'say')) throw new Error('Say event missing from timeline');
  if (narrationAssets.length !== 1) throw new Error(`Expected one narration asset, received ${narrationAssets.length}`);
  const sayIndex=events.findIndex(event=>event.command==='say');
  const narrationAsset=`voice-${String(sayIndex).padStart(3,'0')}.m4a`;
  if (!videoMd.includes(`audio src:assets/${narrationAsset}`)) throw new Error('Markcut lacks synchronized narration entry');
  const narrationProbe = await probeJson(path.join(outputDir, 'markcut', 'assets', narrationAsset));
  const sayEvent = events[sayIndex];
  const narrationStart = (sayEvent.relative_ms + timeline.video_time_offset_ms) / 1000;
  const narrationDuration = Number(narrationProbe.format.duration);
  const narrationLine = videoMd.split('\n').find(line => line.includes(`audio src:assets/${narrationAsset} `));
  const narrationSegment = narrationLine && /start:([0-9.]+) duration:([0-9.]+)/.exec(narrationLine);
  const narrationSegmentStart = narrationSegment ? Number(narrationSegment[1]) : NaN;
  const narrationSegmentDuration = narrationSegment ? Number(narrationSegment[2]) : NaN;
  if (narrationStart < 0 || narrationStart >= captureDuration || !narrationSegment ||
      Math.abs(narrationSegmentStart - narrationStart) > 0.002 || narrationSegmentDuration <= 0 ||
      narrationSegmentDuration > captureDuration - narrationStart + 0.002) {
    throw new Error(`Narration segment is not synchronized within captured video: ${JSON.stringify({ narrationStart, narrationDuration, narrationSegmentStart, narrationSegmentDuration, captureDuration })}`);
  }
  const markcutManifest = JSON.parse(await fs.readFile(path.join(outputDir, 'markcut', 'events.json'), 'utf8'));
  if (markcutManifest.generated_speech?.[0]?.event_index !== sayIndex ||
      Math.abs(markcutManifest.generated_speech[0].start_seconds - narrationStart) > 0.002) {
    throw new Error('Markcut narration manifest is not synchronized to the say event');
  }
  const renderVideo=finalProbe.streams.find(stream=>stream.codec_type==='video');
  const renderDuration=Number(renderVideo?.duration || finalProbe.format.duration);
  const renderFrames=[];
  const renderFrameInterval=1/(Number(renderVideo?.avg_frame_rate?.split('/')[0]||1)/Number(renderVideo?.avg_frame_rate?.split('/')[1]||1));
  for(const [index,time] of [0.1,Math.max(0.05,renderDuration-2*renderFrameInterval)].entries()){
    renderFrames.push(await extractFrame(path.join(outputDir,'markcut','video.mp4'),time,
      path.join(EVIDENCE_ROOT,'frames',`render-${String(index).padStart(2,'0')}.png`)));
  }

  await handle({ op: 'stop', session_id: primary });
  sessions = sessions.filter(id => id !== primary);
  const secondaryAfterPrimaryStop = await exec(secondary, 'return (await page_info()).url');
  if (secondaryAfterPrimaryStop.value !== serverUrl) throw new Error('Second Session did not survive primary release');
  await handle({ op: 'stop', session_id: secondary });
  sessions = sessions.filter(id => id !== secondary);
  const cleanup = await checkOwnedTargetsClosed([serverUrl]);
  const list = await handle({ op: 'list' });
  if (list.session_count !== 0) throw new Error('Isolated daemon retained E2E Sessions');

  const evidence = {
    generated_at: new Date().toISOString(),
    protocol: 'webhelm.demo/1',
    daemon_pid: ping.pid,
    daemon_version: ping.version,
    browser_cdp_endpoint: CDP_URL,
    fixture_url: serverUrl,
    commands: { recorded: 11, blocked_during_pause: 1, real_navigation: true, real_click: true, snapshot_target_ref: target[2], target_dom_unchanged: true },
    capture: {
      codec: captureProbe.streams.find(stream => stream.codec_type === 'video')?.codec_name,
      pixel_format: captureProbe.streams.find(stream => stream.codec_type === 'video')?.pix_fmt,
      width: captureProbe.streams.find(stream => stream.codec_type === 'video')?.width,
      height: captureProbe.streams.find(stream => stream.codec_type === 'video')?.height,
      duration_seconds: Number(captureProbe.format.duration),
      achieved_fps: timeline.achieved_fps,
      timeline_event_count: events.length,
      timeline_last_effect_end_seconds: lastEventEnd,
    },
    final_render: {
      video_codec: finalProbe.streams.find(stream => stream.codec_type === 'video')?.codec_name,
      audio_codec: finalProbe.streams.find(stream => stream.codec_type === 'audio')?.codec_name,
      duration_seconds: Number(finalProbe.format.duration),
      has_audio: Boolean(finalProbe.streams.some(stream => stream.codec_type === 'audio')),
    },
    narration: {
      asset: narrationAsset,
      codec: narrationProbe.streams.find(stream => stream.codec_type === 'audio')?.codec_name,
      duration_seconds: narrationDuration,
      start_seconds: narrationStart,
      ends_within_capture: narrationSegmentStart + narrationSegmentDuration <= captureDuration + 0.002,
      synchronized: /start:[0-9.]+ duration:[0-9.]+/.test(videoMd),
    },
    frames,
    render_frames:renderFrames,
    second_session: {
      started_independent: initialSecondary.value.ticks === 0,
      ticks_during_primary_recording: secondaryDuringRecording.value,
      survived_primary_stop: true,
    },
    cleanup: { session_count_after_stop: list.session_count, ...cleanup },
    result_fields: { start, spotlight, annotate, cursor, paused_status: pausedStatus, blocked_during_pause: blockedDuringPause, resume, stop, completed_status: completedStatus },
    verification: {
      h264_capture: captureProbe.streams.some(stream => stream.codec_name === 'h264'),
      markcut_verified: stop.export?.verified === true,
      markcut_rendered: stop.export?.rendered === true,
      video_recorded_truthful: stop.video_recorded === true,
    },
  };
  if (!evidence.verification.h264_capture || captureProbe.streams.find(stream => stream.codec_type === 'video')?.pix_fmt !== 'yuv420p') {
    throw new Error('Capture is not valid H.264/yuv420p content');
  }
  if (!evidence.verification.markcut_verified || !evidence.verification.markcut_rendered ||
      !evidence.verification.video_recorded_truthful) throw new Error('Markcut export receipts are incomplete or unverified');
  if (!evidence.final_render.has_audio || evidence.final_render.audio_codec !== 'aac' ||
      evidence.final_render.duration_seconds <= 0) {
    throw new Error('Markcut render lacks positive AAC audio');
  }
  await fs.writeFile(path.join(EVIDENCE_ROOT, 'evidence.json'), JSON.stringify(evidence, null, 2));
  await fs.writeFile(path.join(EVIDENCE_ROOT, 'commands.txt'), [
    'WEBHELM_CDP_URL=' + CDP_URL,
    'WEBHELM_DEMO_MARKCUT=' + MARKCUT,
    'WEBHELM_DEMO_EVIDENCE_DIR=' + EVIDENCE_ROOT,
    'node test/e2e/demo-engine.e2e.mjs',
    'ffprobe ' + path.join(outputDir, 'capture.mp4'),
    'markcut verify ' + path.join(outputDir, 'markcut', 'video.md'),
    'ffprobe ' + path.join(outputDir, 'markcut', 'video.mp4'),
  ].join('\n'));
  console.log(JSON.stringify({
    ok: true,
    evidence: EVIDENCE_ROOT,
    duration_seconds: evidence.capture.duration_seconds,
    achieved_fps: evidence.capture.achieved_fps,
    events: evidence.capture.timeline_event_count,
  }, null, 2));
} finally {
  await cleanup();
}
process.exit(0);
