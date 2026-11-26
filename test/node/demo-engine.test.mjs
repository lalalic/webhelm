import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DemoEngine } from '../../runtime/demo-engine.mjs';
import { DemoCapture } from '../../runtime/demo-capture.mjs';

function transport(responses = {}) {
  const calls = [];
  return {
    calls,
    snapshotGeneration: 1,
    snapshotTargetId: 't1',
    viewport: { width: 800, height: 600 },
    async evaluate(expression) {
      calls.push(expression);
      if (expression.includes('"ds1-1-e1"')) return responses.e1 ?? { frame: { x: 10, y: 20, width: 100, height: 40 } };
      if (expression.includes('"ds1-1-e2"')) return { error: 'missing' };
      if (expression.includes('"Save"')) return responses.Save ?? { frame: { x: 30, y: 40, width: 80, height: 30 } };
      if (expression.includes('"Ambiguous"')) return { error: 'ambiguous' };
      return { error: 'missing' };
    },
    close() {},
    async startCapture() {},
    async stopCapture() {},
  };
}

async function engine() {
  const fake = transport();
  const demo = new DemoEngine({ session_id: 's1', targetId: 't1' }, fake);
  return { demo, fake };
}

test('supports every command and preserves lifecycle result fields', async() => {
  const { demo } = await engine();
  await assert.rejects(demo.execute('step', { title: '' }), /step requires title/);
  const recording = await demo.execute('start_recording');
  assert.equal(recording.protocol, 'webhelm.demo/1');
  assert.equal(recording.video_recorded, false);
  const step = await demo.execute('step', { title: 'Open' });
  assert.equal(step.command, 'step');
  assert.equal(step.relative_ms >= 0, true);
  const spotlight = await demo.execute('spotlight', { ref: 'ds1-1-e1', text: 'Target' });
  assert.deepEqual(spotlight.command, 'spotlight');
  await demo.execute('annotate', { label: 'Save', text: 'Click here' });
  await demo.execute('caption', { text: 'Hello' });
  await demo.execute('say', { text: 'Hello' });
  await demo.execute('cursor', { ref: 'ds1-1-e1' });
  await demo.execute('highlight', { label: 'Save' });
  await demo.execute('wait', { ms: 0 });
  await demo.execute('clear');
  await demo.execute('pause');
  await assert.rejects(demo.execute('caption', { text: 'blocked' }), /Demo paused/);
  const resume = await demo.execute('resume');
  assert.equal(resume.command, 'resume');
  const stopped = await demo.execute('stop_recording');
  assert.equal(stopped.video_recorded, false);
  assert.equal(stopped.events.length >= 8, true);
  const status = await demo.execute('status');
  assert.equal(status.recording, false);
  assert.deepEqual(status.events, []);
  assert.equal(status.completed_recording.protocol, 'webhelm.demo/1');
  await assert.rejects(demo.execute('stop_recording'), /Demo recording not started/);
});

test('supports capture-only overlays and status before recording', async() => {
  const { demo } = await engine();
  const before = await demo.execute('status');
  assert.equal(before.recording, false);
  assert.equal(before.overlay_active, false);
  const step = await demo.execute('step', { title: 'Pre-roll' });
  assert.equal(step.command, 'step');
  assert.equal(step.event_count, 0);
  await demo.execute('spotlight', { ref: 'ds1-1-e1', text: 'Visible now' });
  const status = await demo.execute('status');
  assert.equal(status.overlay_active, true);
  assert.deepEqual(status.events, []);
  const recording = await demo.execute('start_recording');
  assert.equal(recording.events_recorded, true);
  const restartedStep = await demo.execute('step', { title: 'Recording' });
  assert.equal(restartedStep.event_count, 1);
});

test('records timing and target ownership fields without browser effects', async() => {
  const { demo } = await engine();
  await demo.execute('start_recording');
  await demo.execute('spotlight', { ref: 'ds1-1-e1' });
  await demo.execute('annotate', { label: 'Save', text: 'Click here' });
  const status = await demo.execute('status');
  assert.equal(status.events.length, 2);
  for (const event of status.events) {
    assert.equal(event.at_unix_ms > 0, true);
    assert.equal(event.relative_ms >= 0, true);
    assert.equal(Object.hasOwn(event, 'frame'), true);
  }
  assert.equal(status.events[0].ref, 'ds1-1-e1');
  assert.equal(Object.hasOwn(status.events[0], 'text'), false);
  assert.equal(status.events[1].label, 'Save');
  assert.equal(status.events[1].text, 'Click here');
  await assert.rejects(demo.execute('spotlight', { ref: 'e1', text: 'x'.repeat(1501) }), /at most 1500/);
  const beforeOverlay = structuredClone(demo.state.overlay);
  await assert.rejects(demo.execute('spotlight', { ref: 'ds1-1-e2' }), /stale element ref/);
  const afterFailure = await demo.execute('status');
  assert.deepEqual(demo.state.overlay, beforeOverlay);
  assert.equal(afterFailure.events.length, 2);
});

test('validates arguments, targets, and wrong-session ownership', async() => {
  const { demo, fake } = await engine();
  const active = new DemoEngine({}, transport());
  active.sessionId = '';
  await assert.rejects(active.execute('start_recording'), /active WebHelm Session/);
  await assert.rejects(demo.execute('unknown'), /Invalid agent.demo command/);
  await assert.rejects(demo.execute('spotlight', { ref: 's1-e2' }), /stale element ref/);
  await assert.rejects(demo.execute('cursor', { label: 'Ambiguous' }), /Ambiguous accessible label/);
  await assert.rejects(demo.execute('annotate', { label: 'Save', text: '' }), /nonempty text/);
  await assert.rejects(demo.execute('spotlight', { ref: 'e1', label: 'Save' }), /not both/);
  await assert.rejects(demo.execute('wait', { ms: 30001 }), /0..30000/);
  await assert.rejects(demo.execute('say', { text: 'x'.repeat(1501) }), /nonempty text/);
  const status = await demo.execute('status');
  assert.deepEqual(status.screen_points, { width: 800, height: 600 });
});

test('rejects refs from a prior snapshot or another active target before CDP evaluation', async() => {
  const fake = transport();
  const demo = new DemoEngine({ session_id: 's1', targetId: 't1' }, fake);
  fake.snapshotGeneration = 2;
  await assert.rejects(demo.execute('spotlight', { ref: 'ds1-1-e1' }), /stale element ref/);
  fake.snapshotGeneration = 1;
  fake.snapshotTargetId = 't2';
  await assert.rejects(demo.execute('spotlight', { ref: 'ds1-1-e1' }), /stale element ref/);
  assert.equal(fake.calls.length, 0);
});

test('records relative event timing monotonically when wall clock moves backward', async() => {
  const { demo } = await engine();
  const originalNow = Date.now;
  let wall = 1000;
  Date.now = () => wall;
  try {
    await demo.execute('start_recording');
    const first = await demo.execute('step', { title: 'First' });
    wall = 500;
    await new Promise(resolve => setTimeout(resolve, 5));
    const second = await demo.execute('caption', { text: 'Second' });
    assert.equal(first.at_unix_ms, 1000);
    assert.equal(second.at_unix_ms, 500);
    assert.equal(second.relative_ms > first.relative_ms, true);
  } finally { Date.now = originalNow; }
});


test('bounded capture evidence rejects excessive bytes', async() => {
  const boundedParent = await fs.mkdtemp(path.join(os.tmpdir(), 'webhelm-demo-bounded-'));
  const bounded = new DemoCapture(transport(), boundedParent);
  bounded.active = true;
  bounded.incomingBytes = 256 * 1024 * 1024;
  bounded.latestFrame = Buffer.from('x');
  bounded.captureError = new Error('Capture exceeded the 256 MiB bounded evidence limit');
  await assert.rejects(async()=>{ throw bounded.captureError; }, /bounded evidence limit/);
  await bounded.dispose();
  await fs.rm(boundedParent, { recursive: true, force: true });
});

test('documentation keeps the frozen protocol and artifacts discoverable', async() => {
  const help = (await import('../../runtime/cli-help.mjs')).cliHelp(['demo']);
  assert.match(help, /start_recording --output-dir/);
  assert.match(help, /stop_recording --output-dir/);
  const skill = await fs.readFile(new URL('../../skills/webhelm/SKILL.md', import.meta.url), 'utf8');
  assert.match(skill, /## Demo recording/);
  const parity = JSON.parse(await fs.readFile(new URL('../../docs/demo-parity.json', import.meta.url), 'utf8'));
  assert.equal(parity.protocol, 'webhelm.demo/1');
  assert.equal(parity.commands.length, 14);
  assert.deepEqual(parity.artifacts, [
    'capture.mp4', 'timeline.json', 'markcut/video.md', 'markcut/events.json',
    'markcut/assets/screen.mp4', 'markcut/assets/voice-*.m4a when say and voice enabled',
    'markcut/video.mp4 by default; omitted with --no-render',
  ]);
});
