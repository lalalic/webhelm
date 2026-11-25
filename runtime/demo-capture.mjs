import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_CAPTURE_BYTES = 256 * 1024 * 1024;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

function run(command, args, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', data => { if (stdout.length < 1_000_000) stdout += data.toString().slice(0, 1_000_000 - stdout.length); });
    child.stderr.on('data', data => { if (stderr.length < 8_000) stderr += data.toString().slice(0, 8_000 - stderr.length); });
    child.on('error', error => {
      clearTimeout(timer);
      const guidance=command==='markcut'?' (install Markcut or pass --markcut /absolute/path/to/markcut)':command==='say'?' (macOS say is needed for narration)':'';
      reject(new Error(`${command} is unavailable${guidance}: ${error.message}`));
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited ${code}: ${stderr.slice(-1000)}`));
    });
  });
}

async function probeMedia(file) {
  const json = JSON.parse(await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]));
  const video = json.streams?.find(stream => stream.codec_type === 'video');
  const audio = json.streams?.find(stream => stream.codec_type === 'audio');
  const duration = Number(json.format?.duration || video?.duration || 0);
  if (video?.codec_name !== 'h264') throw new Error(`Capture did not produce an H.264 video stream: ${file}`);
  if (duration <= 0) throw new Error(`Capture has no positive duration: ${file}`);
  const [numerator, denominator] = String(video.avg_frame_rate || '1/1').split('/').map(Number);
  const fps = denominator ? numerator / denominator : numerator;
  if (!Number.isFinite(fps) || fps <= 0 || fps > 60) throw new Error(`Capture has invalid frame-rate metadata: ${fps}`);
  return { width: video.width, height: video.height, fps, duration, has_audio: !!audio, pixel_format: video.pix_fmt };
}

export async function requireMediaCommands() {
  for (const command of ['ffmpeg', 'ffprobe']) {
    try { await run(command, ['-version'], 5000); }
    catch(error) { throw new Error(`Demo capture dependency unavailable: install ${command} (${error.message})`); }
  }
}

function quoteDrawText(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'")
    .replace(/%/g, '\\%').replace(/,/g, '\\,').replace(/;/g, '\\;').replace(/\n/g, '\\n');
}

function annotationFilters(timeline) {
  const filters = [];
  let cursor = null;
  const points = timeline.screen_points || {};
  const scaleX = points.width > 0 ? timeline.width / points.width : 1;
  const scaleY = points.height > 0 ? timeline.height / points.height : 1;
  const startAt = event => ((event.relative_ms || 0) + Number(timeline.video_time_offset_ms || 0)) / 1000;
  const clearedAt = index => {
    const event = timeline.events[index];
    for (let i = index + 1; i < timeline.events.length; i++) {
      const next = timeline.events[i];
      if (next.command === 'clear') return startAt(next);
      if (['step'].includes(event.command) && next.command === 'step') return startAt(next);
      if (['caption', 'say'].includes(event.command) && ['caption', 'say'].includes(next.command)) return startAt(next);
      if (['spotlight', 'annotate', 'highlight'].includes(event.command) && ['spotlight', 'annotate', 'highlight'].includes(next.command)) return startAt(next);
      if (event.command === 'cursor' && next.command === 'cursor') return startAt(next);
    }
    return Number(timeline.duration || 0);
  };
  const enabled = (event, index, fallbackEnd) => {
    const start = startAt(event);
    const end = Math.max(start + 0.001, Math.min(fallbackEnd, clearedAt(index)));
    return `enable='between(t,${start.toFixed(3)},${end.toFixed(3)})'`;
  };
  const frame = value => ({
    x: Math.max(0, Math.round((value.x || 0) * scaleX)),
    y: Math.max(0, Math.round((value.y || 0) * scaleY)),
    width: Math.max(1, Math.round((value.width || 0) * scaleX)),
    height: Math.max(1, Math.round((value.height || 0) * scaleY)),
  });
  const drawText = (value, x, y, size) =>
    `drawtext=text='${quoteDrawText(value)}':fontcolor=white:box=1:boxcolor=black@0.72:boxborderw=12:fontsize=${size}:x=${x}:y=${y}`;
  for (const [index, event] of timeline.events.entries()) {
    if (event.command === 'step') {
      filters.push(`${drawText(`${event.number}. ${event.title}`, 'w-text_w-32', 28, 28)}:${enabled(event, index, timeline.duration)}`);
    } else if (event.command === 'caption' || event.command === 'say') {
      filters.push(`${drawText(event.text, 36, Math.max(0, timeline.height - 82), 24)}:${enabled(event, index, timeline.duration)}`);
    } else if (['spotlight', 'annotate', 'highlight'].includes(event.command) && event.frame) {
      const target = frame(event.frame);
      const end = event.command === 'highlight' ? startAt(event) + 0.65 : timeline.duration;
      if (event.command === 'spotlight') {
        const right = Math.max(0, timeline.width - target.x - target.width);
        const bottom = Math.max(0, timeline.height - target.y - target.height);
        const dim=`color=black@0.48:t=fill:${enabled(event, index, end)}`;
        if(target.y>0)filters.push(`drawbox=x=0:y=0:w=${timeline.width}:h=${target.y}:${dim}`);
        if(bottom>0)filters.push(`drawbox=x=${target.x}:y=${target.y + target.height}:w=${target.width}:h=${bottom}:${dim}`);
        if(target.x>0)filters.push(`drawbox=x=0:y=${target.y}:w=${target.x}:h=${target.height}:${dim}`);
        if(right>0)filters.push(`drawbox=x=${target.x + target.width}:y=${target.y}:w=${right}:h=${target.height}:${dim}`);
      }
      const color = event.command === 'spotlight' ? 'red@0.95' : 'yellow@0.95';
      filters.push(`drawbox=x=${target.x}:y=${target.y}:w=${target.width}:h=${target.height}:color=${color}:t=5:${enabled(event, index, end)}`);
      if (event.command === 'annotate' && event.text) {
        const y = Math.max(4, target.y - 42);
        filters.push(`${drawText(event.text, target.x, y, 20)}:${enabled(event, index, end)}`);
      }
    } else if (event.command === 'cursor' && event.frame) {
      const target = frame(event.frame);
      const to = { x: target.x + Math.round(target.width / 2), y: target.y + Math.round(target.height / 2) };
      const from = cursor || { x: (points.width || 0) * scaleX / 2, y: (points.height || 0) * scaleY * 0.82 };
      const start=startAt(event);
      const progress=`((t-${start.toFixed(3)})/0.48)`;
      const x=`(${from.x}-9)+(${to.x}-${from.x})*${progress}`;
      const y=`(${from.y}-9)+(${to.y}-${from.y})*${progress}`;
      filters.push(`drawbox=x='${x}':y='${y}':w=18:h=18:color=lime@0.95:t=fill:${enabled(event, index, start + 0.48)}`);
      cursor = to;
    }
  }
  return filters.join(',');
}

async function probeAudio(file) {
  const json = JSON.parse(await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]));
  return Number(json.format?.duration || json.streams?.find(stream => stream.codec_type === 'audio')?.duration || 0);
}

async function synthesizeVoice(text, file, durationLimit, voice) {
  try { await run('say', ['-v', voice, '-o', `${file}.aiff`, text], 15000); }
  catch(error) { throw new Error(`Narration synthesis unavailable; install or configure macOS say (${error.message})`); }
  try {
    await run('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', `${file}.aiff`, '-t', durationLimit.toFixed(3), '-c:a', 'aac', '-b:a', '128k', file], 20000);
    const ok=(await fs.stat(file)).size > 0;
    if(ok)await fs.chmod(file,0o600);
    return ok;
  } finally { await fs.unlink(`${file}.aiff`).catch(() => {}); }
}

export async function exportMarkcut(captureFile, timeline, outputDir, options = {}) {
  const markcut = options.markcut;
  if (!markcut) throw new Error('Markcut CLI is unavailable; capture is retained but video.md requires --markcut');
  const meta = await probeMedia(captureFile);
  const output = path.resolve(outputDir, 'markcut');
  const outputStat=await fs.lstat(output).catch(error=>error.code==='ENOENT'?null:Promise.reject(error));
  if(outputStat?.isSymbolicLink())throw new Error(`Markcut output directory must not be a symbolic link: ${output}`);
  if(outputStat&&!outputStat.isDirectory())throw new Error(`Markcut output path is not a directory: ${output}`);
  const prior = outputStat ? await fs.readdir(output) : [];
  if (prior.length) throw new Error(`Markcut output already exists: ${output}`);
  await fs.mkdir(path.join(output, 'assets'), { recursive: true, mode: 0o700 });
  const screen=path.join(output,'assets','screen.mp4');
  await fs.copyFile(captureFile, screen);
  await fs.chmod(screen,0o600);
  const lines = ['# video', 'title:"WebHelm Demo"', `width:${meta.width} height:${meta.height} fps:${meta.fps} layout:series`, '', '## Demo', 'layout:parallel', `- video src:assets/screen.mp4 duration:${meta.duration.toFixed(3)} volume:0`];
  const offset = Number(timeline.video_time_offset_ms || 0);
  const sayEvents = (timeline.events || []).filter(event => event.command === 'say');
  const generatedSpeech=[];
  for (const [index, event] of (timeline.events || []).entries()) {
    if(event.command!=='say')continue;
    const start = ((event.relative_ms || 0) + offset) / 1000;
    if (start < 0 || start >= meta.duration) throw new Error(`Say event ${index} is outside captured video`);
    if (options.voice === false) {
      generatedSpeech.push({ event_index:index, start_seconds:start, pending_text:event.text });
      continue;
    }
    const file = path.join(output, 'assets', `voice-${String(index).padStart(3, '0')}.m4a`);
    const voice = /[\u3400-\u9fff]/.test(event.text) ? 'Tingting' : 'Samantha';
    const ok = await synthesizeVoice(event.text, file, meta.duration - start, voice);
    if (!ok) throw new Error(`Could not synthesize narration for event ${index}`);
    const spoken = Math.min(await probeAudio(file), meta.duration - start);
    if (spoken <= 0) throw new Error(`Synthesized narration for event ${index} has no positive duration`);
    lines.push(`- audio src:assets/${path.basename(file)} start:${start.toFixed(3)} duration:${spoken.toFixed(3)} volume:1`);
    generatedSpeech.push({ event_index:index, start_seconds:start, file:path.basename(file) });
  }
  const videoMd = path.join(output, 'video.md');
  await fs.writeFile(videoMd, `${lines.join('\n')}\n`, { mode: 0o600 });
  const manifest={protocol:timeline.protocol,recording:timeline,video:meta,generated_speech:generatedSpeech,
    overlay:'already composited by WebHelm FFmpeg into screen.mp4',
    unspoken_say_events:generatedSpeech.some(item=>Object.hasOwn(item,'pending_text'))};
  await fs.writeFile(path.join(output, 'events.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  await run(markcut, ['verify', videoMd], 60000);
  if (options.render) {
    const rendered = path.join(output, 'video.mp4');
    await run(markcut, ['render', videoMd, '--output', rendered], 300000);
    await fs.chmod(rendered,0o600);
    const renderMeta = await probeMedia(rendered);
    if (sayEvents.length && options.voice !== false && !renderMeta.has_audio) throw new Error('Markcut render has no narration audio stream');
  }
  return { video_md: videoMd, verified: true, rendered: !!options.render };
}

export class DemoCapture {
  constructor(transport, outputDirectory, fps = 15) {
    this.transport = transport;
    this.outputDirectory = outputDirectory;
    this.fps = fps;
    this.active = false;
    this.owner = randomUUID();
    this.latestFrame = null;
    this.incomingBytes = 0;
  }

  async start() {
    if (this.active) throw new Error('Demo capture already active');
    this.active = true;
    this.startedWall = Date.now();
    this.startedMono = performance.now();
    this.sourceFile = path.join(this.outputDirectory, '.webhelm-capture-source.mp4');
    this.ownerFile = path.join(this.outputDirectory, '.webhelm-demo-owner');
    await fs.writeFile(this.ownerFile, this.owner, { flag: 'wx', mode: 0o600 });
    const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(this.fps), '-vcodec', 'mjpeg', '-i', 'pipe:0', '-an', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '22', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-fs', String(MAX_CAPTURE_BYTES), this.sourceFile];
    this.child = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });
    this.child.stderr.on('data', data => { this.stderr = `${this.stderr || ''}${data}`.slice(-1000); });
    this.child.on('error', error => { this.captureError ||= new Error(`FFmpeg capture failed: ${error.message}`); });
    this.child.on('close', code => {
      this.childClosed = true;
      this.childExitCode = code;
      if (this.active && code !== 0) this.captureError ||= new Error(`Live FFmpeg capture exited ${code}: ${this.stderr || ''}`);
    });
    let firstFrame;
    const gotFirst = new Promise((resolve, reject) => { firstFrame = { resolve, reject }; });
    try {
      await this.transport.startCapture(frame => {
        if (!this.active || this.captureError) return;
        const data = Buffer.from(frame.data, 'base64');
        if (!data.length || data.length > MAX_FRAME_BYTES) {
          this.captureError = new Error('Actual browser frame is empty or exceeds the 16 MiB frame limit');
          return;
        }
        this.incomingBytes += data.length;
        if (this.incomingBytes > MAX_CAPTURE_BYTES) {
          this.captureError = new Error(`Capture exceeded the ${MAX_CAPTURE_BYTES / 1024 / 1024} MiB bounded evidence limit`);
          return;
        }
        this.latestFrame = data;
        firstFrame.resolve();
      });
      let firstTimer;
      try {
        await Promise.race([gotFirst, new Promise((_, reject) => { firstTimer = setTimeout(() => reject(new Error(`No CDP screencast frame received within 5 seconds (${JSON.stringify(this.transport.captureDiagnostics || {})})`)), 5000); })]);
      } finally { clearTimeout(firstTimer); }
      this.nextTickAt = performance.now();
      const interval = 1000 / this.fps;
      const tick = () => {
        if (!this.active) return;
        if (this.captureError) return;
        if (this.child?.stdin.destroyed || this.childClosed) {
          this.captureError ||= new Error('FFmpeg live capture input closed unexpectedly');
          return;
        }
        if (this.latestFrame && !this.waitingForDrain) {
          this.waitingForDrain = !this.child.stdin.write(this.latestFrame);
          if (this.waitingForDrain) this.child.stdin.once('drain', () => { this.waitingForDrain = false; });
        }
        this.nextTickAt += interval;
        this.timer = setTimeout(tick, Math.max(0, this.nextTickAt - performance.now()));
        this.timer.unref?.();
      };
      tick();
    } catch(error) {
      this.captureError = error;
      await this.dispose();
      throw error;
    }
  }

  async finishProcess() {
    if (!this.child) return;
    if (!this.childClosed) {
      this.child.stdin.end();
      let timer;
      try {
        await Promise.race([
          new Promise(resolve => this.child.once('close', resolve)),
          new Promise((_, reject) => { timer = setTimeout(() => { this.child.kill('SIGKILL'); reject(new Error('FFmpeg capture did not stop within 10 seconds')); }, 10000); }),
        ]);
      } finally { clearTimeout(timer); }
    }
    if (this.childExitCode !== 0) throw new Error(`FFmpeg capture exited ${this.childExitCode}: ${this.stderr || ''}`);
    if (this.captureError) throw this.captureError;
  }

  async stop({ destination, timeline, markcut, render, voice }) {
    if (!this.active) throw new Error('Demo capture not started');
    this.active = false;
    clearTimeout(this.timer);
    try {
      await this.transport.stopCapture?.();
      const captureDuration = (performance.now() - this.startedMono) / 1000;
      await this.finishProcess();
      const sourceMeta = await probeMedia(this.sourceFile);
      if (captureDuration < 0.2 || sourceMeta.duration <= 0) throw new Error('Captured browser video duration is too short');
      timeline.capture_origin_unix_ms = this.startedWall;
      timeline.video_time_offset_ms = timeline.recording_started_at_unix_ms - this.startedWall;
      timeline.duration = sourceMeta.duration;
      timeline.width = sourceMeta.width;
      timeline.height = sourceMeta.height;
      const filters = annotationFilters(timeline);
      const captureFile = path.join(destination, 'capture.mp4');
      const requiredEnd = Math.max(0, ...(timeline.events || []).map(event => {
        const start = ((event.relative_ms || 0) + Number(timeline.video_time_offset_ms || 0)) / 1000;
        return start + (event.command === 'highlight' ? 0.65 : event.command === 'cursor' ? 0.48 : 0);
      }));
      const pad = Math.max(0, requiredEnd + 0.1 - sourceMeta.duration);
      const tail = pad ? `tpad=stop_mode=clone:stop_duration=${pad.toFixed(3)},` : '';
      const vf = ['-vf', `${filters ? `${filters},` : ''}${tail}scale=trunc(iw/2)*2:trunc(ih/2)*2:in_range=pc:out_range=tv,format=yuv420p`];
      await run('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', this.sourceFile, ...vf, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '22', '-fs', String(MAX_CAPTURE_BYTES), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', captureFile], 120000);
      await fs.chmod(captureFile, 0o600);
      await fs.unlink(this.sourceFile).catch(() => {});
      const finalMeta = await probeMedia(captureFile);
      timeline.duration = finalMeta.duration;
      timeline.achieved_fps = finalMeta.fps;
      await fs.writeFile(path.join(destination, 'timeline.json'), JSON.stringify(timeline, null, 2), { mode: 0o600 });
      const exportResult = await exportMarkcut(captureFile, timeline, destination, { markcut, render, voice });
      await fs.unlink(this.ownerFile).catch(() => {});
      this.succeeded = true;
      return { capture_mp4: captureFile, capture_return_code: 0, ...exportResult };
    } catch(error) {
      await this.cleanOutput();
      throw error;
    }
  }

  async cleanOutput() {
    const owner = await fs.readFile(this.ownerFile, 'utf8').catch(() => '');
    if (owner !== this.owner) return;
    for (const name of ['.webhelm-capture-source.mp4', '.webhelm-demo-owner', 'capture.mp4', 'timeline.json', 'markcut']) {
      await fs.rm(path.join(this.outputDirectory, name), { recursive: name === 'markcut', force: true }).catch(() => {});
    }
  }

  async dispose() {
    this.active = false;
    clearTimeout(this.timer);
    try { await this.transport.stopCapture?.(); } catch {}
    if (this.child && !this.childClosed) {
      this.child.kill('SIGKILL');
      await new Promise(resolve => this.child.once('close', resolve));
    }
    if (this.succeeded) await fs.unlink(this.ownerFile).catch(() => {});
    else await this.cleanOutput();
    this.latestFrame = null;
  }
}
