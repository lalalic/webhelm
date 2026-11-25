export const DEMO_PROTOCOL = 'webhelm.demo/1';
const TEXT_LIMIT = 1500;
const WAIT_LIMIT = 30000;
const EVENT_LIMIT = 5000;
const HIGHLIGHT_MS = 650;
const CURSOR_MS = 480;
const MAX_RECORDING_MS = 300000;

const DEMO_COMMANDS = new Set([
  'step', 'spotlight', 'annotate', 'caption', 'say', 'cursor', 'highlight',
  'clear', 'pause', 'resume', 'wait', 'start_recording', 'stop_recording',
  'status',
]);
const TARGET_COMMANDS = new Set(['spotlight', 'annotate', 'cursor', 'highlight']);
const TEXT_COMMANDS = new Set(['caption', 'say', 'annotate']);
const PAUSE_ALLOWED = new Set(['resume', 'clear', 'stop_recording']);

function text(value) {
  return typeof value === 'string' ? value : '';
}

function integer(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function jsString(value) {
  return JSON.stringify(String(value));
}

function commandError(message) {
  const error = new Error(message);
  error.demoCommand = true;
  return error;
}

function viewportValue(width, height) {
  return { width: integer(width), height: integer(height) };
}

export class DemoEngine {
  constructor(session, transport) {
    this.sessionId = session.session_id;
    this.transport = transport;
    this.targetId = session.targetId;
    this.state = null;
  }

  requireActive() {
    if (!this.sessionId) throw commandError('Demo requires an active WebHelm Session');
  }

  ensureOverlay() {
    if (!this.state) {
      this.state = {
        sessionId: this.sessionId,
        targetId: this.targetId,
        recording: false,
        paused: false,
        startedAt: 0,
        stepNumber: 0,
        events: [],
        completed: null,
        overlay: {
          screen_width: this.transport.viewport.width,
          screen_height: this.transport.viewport.height,
        },
        viewport: { ...this.transport.viewport },
      };
    } else if (!this.state.overlay?.screen_width) {
      this.state.overlay = {
        screen_width: this.state.viewport.width || this.transport.viewport.width,
        screen_height: this.state.viewport.height || this.transport.viewport.height,
      };
    }
    return this.state;
  }

  requireRecording() {
    if (!this.state?.recording) throw commandError('Demo recording not started');
  }

  newEvent(command, extra = {}) {
    const at = Date.now();
    const relative = this.state?.startedMono ? Math.round(performance.now() - this.state.startedMono) : 0;
    return { command, at_unix_ms: at, relative_ms: relative, ...extra };
  }

  result(event) {
    return {
      command: event.command,
      event_count: this.state?.events.length || 0,
      at_unix_ms: event.at_unix_ms,
      relative_ms: event.relative_ms,
      overlay_mode: 'webhelm_capture_only',
    };
  }

  status() {
    return {
      protocol: DEMO_PROTOCOL,
      recording: !!this.state?.recording,
      paused: !!this.state?.paused,
      overlay_active: !!(this.state && Object.keys(this.state.overlay).length > 2),
      recording_started_at_unix_ms: this.state?.startedAt || 0,
      screen_points: { ...(this.state?.viewport || this.transport.viewport || { width: 0, height: 0 }) },
      events: this.state?.events || [],
      completed_recording: this.state?.completed || null,
    };
  }

  startRecording() {
    this.requireActive();
    if (this.state?.recording) throw commandError('Demo recording already active; stop it before starting again');
    const startedAt = Date.now();
    this.state = {
      sessionId: this.sessionId, targetId: this.targetId, recording: true,
      paused: false, startedAt, startedMono: performance.now(), stepNumber: 0, events: [], overlay: {
        screen_width: this.transport.viewport.width,
        screen_height: this.transport.viewport.height,
      }, viewport: { ...this.transport.viewport },
      capture_deadline_mono: performance.now() + MAX_RECORDING_MS,
    };
    return {
      protocol: DEMO_PROTOCOL,
      recording_started_at_unix_ms: startedAt,
      video_recorded: false,
      events_recorded: true,
    };
  }

  stopRecording() {
    this.requireRecording();
    const endedAt = Date.now();
    const completed = {
      protocol: DEMO_PROTOCOL,
      recording_started_at_unix_ms: this.state.startedAt,
      recording_ended_at_unix_ms: endedAt,
      video_recorded: false,
      events: this.state.events,
      screen_points: { ...this.state.viewport },
    };
    this.state.completed = completed;
    this.state.recording = false;
    this.state.paused = false;
    this.state.events = [];
    return completed;
  }

  async resolveTarget(command, args) {
    const ref = text(args.ref);
    const label = text(args.label);
    if (!ref && !label) throw commandError('Demo target requires ref or accessible label');
    if (ref && label) throw commandError('Supply ref or accessible label, not both');
    if (ref.length > 200) throw commandError('Demo ref exceeds 200 characters');
    if (label.length > TEXT_LIMIT) throw commandError('Demo accessible label exceeds 1500 characters');
    if (label && !label.trim()) throw commandError('Demo accessible label must be nonempty');
    if (ref && (!this.transport.snapshotGeneration || this.transport.snapshotTargetId !== this.targetId ||
      !ref.startsWith(`d${this.sessionId}-${this.transport.snapshotGeneration}-`))) {
      throw commandError('Invalid or stale element ref: take a fresh snapshot in the active tab');
    }
    const script = `(() => {
      const wanted=${jsString(ref)};
      const label=${jsString(label)};
      let roots=[];
      const visible=node=>{const r=node.getBoundingClientRect();if(r.width<=0||r.height<=0||r.right<=0||r.bottom<=0||r.left>=innerWidth||r.top>=innerHeight)return false;for(let p=node;p;p=p.parentElement){const s=getComputedStyle(p);if(s.visibility==='hidden'||s.visibility==='collapse'||s.display==='none'||s.opacity==='0'||p.hasAttribute('hidden')||p.hasAttribute('inert')||p.getAttribute('aria-hidden')==='true')return false}return true};
      if(wanted)roots=Array.from(document.querySelectorAll('[data-ref]')).filter(node=>node.getAttribute('data-ref')===wanted&&visible(node));
      else {
        const matches=Array.from(document.querySelectorAll('button,a,input,textarea,select,[role],[tabindex]')).filter(node=>{
          const labelledBy=node.getAttribute('aria-labelledby');
          const labelled=labelledBy?labelledBy.trim().split(/\\s+/).map(id=>document.getElementById(id)?.innerText||'').join(' '):'';
          const accessible=node.getAttribute('aria-label')||labelled||node.getAttribute('title')||node.getAttribute('alt')||node.value||node.labels?.[0]?.innerText||node.innerText||node.textContent||'';
          return visible(node)&&accessible.trim().toLowerCase().includes(label.trim().toLowerCase());
        });
        roots=matches;
      }
      if(roots.length!==1)return {error:roots.length?'ambiguous':'missing'};
      const node=roots[0];
      const rect=node.getBoundingClientRect();
      const style=getComputedStyle(node);
      if(!visible(node))return {error:'invisible'};
      return {frame:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},label:node.getAttribute('aria-label')||node.textContent||''};
    })()`;
    const found = await this.transport.evaluate(script, this.targetId);
    if (found?.error === 'missing') {
      throw commandError(ref ? 'Invalid or stale element ref: take a fresh pilot snapshot' : 'Demo target not found; supply a current ref or accessible label');
    }
    if (found?.error === 'ambiguous') throw commandError('Ambiguous accessible label');
    if (!found?.frame || !(found.frame.width > 0) || !(found.frame.height > 0)) {
      throw commandError('Demo target is invisible or has zero area');
    }
    return found.frame;
  }

  async execute(command, args = {}) {
    this.requireActive();
    if (!DEMO_COMMANDS.has(command)) throw commandError('Invalid agent.demo command');
    const state = this.ensureOverlay();
    if (command === 'status') return this.status();
    if (command === 'start_recording') return this.startRecording();
    if (command === 'stop_recording') return this.stopRecording();
    if (this.state?.paused && !PAUSE_ALLOWED.has(command)) {
      throw commandError('Demo paused: call resume before adding events');
    }
    if (this.state?.recording && performance.now() >= this.state.capture_deadline_mono) {
      throw commandError(`Demo recording reached ${MAX_RECORDING_MS / 1000} seconds; stop it before starting a new recording`);
    }

    const allowed = {
      step:['title'], spotlight:['ref','label','text'], annotate:['ref','label','text'],
      caption:['text'], say:['text'], cursor:['ref','label'], highlight:['ref','label'],
      clear:[], pause:[], resume:[], wait:['ms'], status:[], start_recording:[], stop_recording:[],
    }[command];
    const unexpected=Object.keys(args).filter(key=>args[key]!==undefined&&!allowed.includes(key));
    if(unexpected.length)throw commandError(`${command} does not accept argument: ${unexpected[0]}`);
    if(TARGET_COMMANDS.has(command)){
      for(const key of ['ref','label'])if(args[key]!==undefined&&typeof args[key]!=='string')throw commandError(`Demo ${key} must be a string`);
    }
    if(this.state.recording&&this.state.events.length>=EVENT_LIMIT)throw commandError(`Demo event limit reached (${EVENT_LIMIT})`);

    const event = this.newEvent(command);
    if (TARGET_COMMANDS.has(command)) {
      if (text(args.ref)) event.ref = text(args.ref);
      if (text(args.label)) event.label = text(args.label);
    }
    if (command === 'step') {
      const title = text(args.title);
      if (!title || title.length > TEXT_LIMIT) throw commandError('step requires title (1..1500 characters)');
      event.title = title;
      event.number = ++this.state.stepNumber;
    }
    if (TEXT_COMMANDS.has(command)) {
      const value = text(args.text);
      if (!value || value.length > TEXT_LIMIT) throw commandError('Demo command requires nonempty text (1..1500 characters)');
      event.text = value;
    }
    if (command==='spotlight'&&args.text!==undefined&&typeof args.text!=='string') {
      throw commandError('spotlight text must be a string');
    }
    if (text(args.text).length > TEXT_LIMIT) {
      throw commandError('Demo command requires text at most 1500 characters');
    }
    if (command !== 'annotate' && text(args.text)) event.text = text(args.text);
    if (TARGET_COMMANDS.has(command)) event.frame = await this.resolveTarget(command, args);
    if (command === 'wait') {
      const ms = integer(args.ms);
      if (ms === null || ms < 0 || ms > WAIT_LIMIT) throw commandError('wait requires ms 0..30000');
      event.ms = ms;
    }

    const overlay = state.overlay;
    if (command === 'step') {
      overlay.step = event.title;
      overlay.step_number = event.number;
    } else if (command === 'caption' || command === 'say') {
      overlay.caption = event.text;
    } else if (['spotlight', 'annotate', 'highlight'].includes(command)) {
      overlay.frame = event.frame;
      overlay.spotlight = command === 'spotlight';
      overlay.tooltip = command === 'annotate' ? event.text : undefined;
      overlay.expires_at_ms = command === 'highlight' ? event.at_unix_ms + HIGHLIGHT_MS : undefined;
    } else if (command === 'cursor') {
      const previous = overlay.cursor || {
        x: this.state.viewport.width / 2,
        y: this.state.viewport.height * 0.82,
      };
      overlay.cursor_from = previous;
      overlay.cursor = {
        x: event.frame.x + event.frame.width / 2,
        y: event.frame.y + event.frame.height / 2,
      };
      overlay.cursor_started_at_ms = event.at_unix_ms;
      overlay.cursor_duration_ms = CURSOR_MS;
      overlay.expires_at_ms = undefined;
    } else if (command === 'clear') {
      state.overlay = {
        screen_width: state.viewport.width,
        screen_height: state.viewport.height,
      };
    }
    if (command === 'pause') this.state.paused = true;
    if (command === 'resume' || command === 'clear') this.state.paused = false;
    if (state.recording) state.events.push(event);
    if (command === 'wait' && event.ms > 0) {
      await new Promise(resolve => setTimeout(resolve, event.ms));
      event.wait_completed_at_unix_ms = Date.now();
      event.wait_completed_relative_ms = Math.round(performance.now() - this.state.startedMono);
    }
    return this.result(event);
  }

  dispose() {
    try {
      this.transport?.close?.();
    } finally {
      this.state = null;
    }
  }
}
