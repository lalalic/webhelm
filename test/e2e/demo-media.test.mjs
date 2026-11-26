// Opt-in integration tests: require FFmpeg, ffprobe, and Markcut.
// Deliberately outside test/node so npm test has no media-tool dependency.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DemoCapture, exportMarkcut, requireMediaCommands } from '../../runtime/demo-capture.mjs';

const markcut = process.env.WEBHELM_DEMO_MARKCUT || 'markcut';
test.before(async () => {
  await requireMediaCommands();
  const probe = spawnSync(markcut, ['--help'], { encoding: 'utf8' });
  assert.equal(probe.error, undefined, 'Markcut executable required: '+markcut);
  assert.equal(probe.status, 0, probe.stderr);
});

function transport() {
  return {
    async startCapture() {},
    async stopCapture() {},
  };
}

test('exports a valid Markcut artifact layout without silent overwrite', async() => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'webhelm-demo-'));
  const output = path.join(parent, 'demo');
  const capture = path.join(output, 'capture.mp4');
  await fs.mkdir(output);
  const source = spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:size=320x180:rate=10', '-t', '0.3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', capture]);
  assert.equal(source.status, 0, String(source.error || source.stderr || ''));
  const timeline = {
    protocol: 'webhelm.demo/1', duration: 0.3, width: 320, height: 180,
    video_time_offset_ms: 0, events: [{ command: 'say', text: 'Hello', relative_ms: 0 }],
  };
  await fs.writeFile(path.join(output, 'timeline.json'), JSON.stringify(timeline));
  const result = await exportMarkcut(capture, timeline, output, { markcut, voice: false });
  assert.equal(result.verified, true);
  for (const file of ['timeline.json', 'markcut/video.md', 'markcut/events.json', 'markcut/assets/screen.mp4']) {
    await fs.access(path.join(output, file));
  }
  const source2 = spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:size=320x180:rate=10', '-t', '0.3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', capture]);
  assert.equal(source2.status, 0);
  await assert.rejects(exportMarkcut(capture, timeline, output, { markcut, voice: false }), /already exists/);
  await fs.rm(parent, { recursive: true, force: true });
});

test('recording fails honestly when CDP screencast is unavailable', async() => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'webhelm-demo-fail-'));
  const output = path.join(parent, 'empty-output');
  await fs.mkdir(output);
  const noFrames = { ...transport(), async startCapture() { throw new Error('CDP screencast unavailable'); } };
  const capture = new DemoCapture(noFrames, output);
  await assert.rejects(capture.start(), /CDP screencast unavailable/);
  await capture.dispose();
  await fs.rm(parent, { recursive: true, force: true });
});

test('encodes live CDP JPEG frames into a valid bounded H.264 capture', async() => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'webhelm-demo-live-'));
  const output = path.join(parent, 'output');
  await fs.mkdir(output, { mode: 0o700 });
  const jpg = path.join(parent, 'frame.jpg');
  const image = spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:size=320x180', '-frames:v', '1', jpg]);
  assert.equal(image.status, 0, String(image.error || image.stderr || ''));
  const jpegData = (await fs.readFile(jpg)).toString('base64');
  const liveTransport = {
    ...transport(),
    async startCapture(onFrame) { this.onFrame = onFrame; onFrame({ data: jpegData, width: 320, height: 180 }); },
  };
  const capture = new DemoCapture(liveTransport, output, 12);
  try {
    await capture.start();
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(Number.isInteger(capture.child.pid), true);
    assert.equal(capture.active, true);
    const timeline = {
      protocol: 'webhelm.demo/1', recording_started_at_unix_ms: capture.startedWall + 10,
      recording_ended_at_unix_ms: Date.now(), screen_points: { width: 320, height: 180 }, events: [],
    };
    const result = await capture.stop({ destination: output, timeline, markcut, voice: false });
    assert.equal(result.verified, true);
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path.join(output, 'capture.mp4')], { encoding: 'utf8' });
    assert.equal(probe.status, 0, probe.stderr);
    const media = JSON.parse(probe.stdout);
    assert.equal(media.streams.some(stream => stream.codec_name === 'h264' && stream.pix_fmt === 'yuv420p'), true, JSON.stringify(media.streams));
    assert.equal(Number(media.format.duration) > 0, true);
    assert.equal('frames' in capture, false);
  } finally {
    await capture.dispose();
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('export probes H.264 and requires the Markcut dependency', async() => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'webhelm-demo-probe-'));
  const invalid = path.join(parent, 'invalid.mp4');
  await fs.writeFile(invalid, Buffer.from('not video'));
  await assert.rejects(exportMarkcut(invalid, {
    protocol: 'webhelm.demo/1', duration: 0.2, width: 320, height: 180, events: [],
  }, parent, { markcut: path.resolve('/tmp/unused-markcut'), voice: false }), /Invalid data|H\.264/);
  await fs.rm(parent, { recursive: true, force: true });
});
