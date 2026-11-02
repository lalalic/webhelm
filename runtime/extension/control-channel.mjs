// The daemon polls this short-lived mailbox through the existing CDP Extension
// RPC. Never expose a local HTTP service or execute shell commands in Chrome.
const KEY = 'webhelm.control.v1';
const FRESH_MS = 8_000;
const EXPIRY_MS = 20_000;
const ABANDONED_MS = 10 * 60_000;

export class ControlChannel {
  constructor(chromeApi, now = () => Date.now(), makeId = () => crypto.randomUUID()) {
    this.chrome = chromeApi;
    this.now = now;
    this.makeId = makeId;
    this.queue = Promise.resolve();
  }

  serialize(fn) {
    const task = this.queue.then(fn);
    this.queue = task.catch(() => {});
    return task;
  }

  async read() {
    return (await this.chrome.storage.session.get(KEY))[KEY] || {};
  }

  async save(state) {
    await this.chrome.storage.session.set({[KEY]: state});
  }

  normalize(state) {
    const result = {...state};
    if (result.request) {
      const age = this.now() - result.request.createdAt;
      if (result.request.state === 'pending' && age > EXPIRY_MS) {
        result.lastResult = {id: result.request.id, ok: false, error: 'The request expired. Try again.'};
        result.request = null;
      } else if (result.request.state === 'processing' && age > ABANDONED_MS) {
        result.lastResult = {id: result.request.id, ok: false,
          error: 'The daemon did not confirm completion. Check current sessions before retrying.'};
        result.request = null;
      }
    }
    return result;
  }

  async status() {
    const state = this.normalize(await this.read());
    const connected = Number.isFinite(state.daemon?.seenAt) &&
      this.now() - state.daemon.seenAt < FRESH_MS;
    return {
      connected,
      sessionCount: connected ? state.daemon.sessions?.length ?? 0 : null,
      sessions: connected ? state.daemon.sessions || [] : [],
      request: state.request || null,
      lastResult: state.lastResult || null,
    };
  }

  async requestStop(action, sessionId, workspace) {
    return this.serialize(async () => {
      if (!['stop-all', 'stop', 'stop-workspace'].includes(action)) throw new Error('Unsupported action');
      const state = this.normalize(await this.read());
      if (state.request) throw new Error('Another WebHelm operation is already running');
      if (!Number.isFinite(state.daemon?.seenAt) || this.now() - state.daemon.seenAt >= FRESH_MS)
        throw new Error('WebHelm daemon is not responding');
      const sessions = state.daemon.sessions || [];
      if (action === 'stop-all' && !sessions.length) throw new Error('No active sessions to stop');
      if (action === 'stop' && !sessions.some(s => s.session_id === sessionId))
        throw new Error('Session is no longer active');
      if (action === 'stop-workspace' && (!workspace || !sessions.some(s => s.workspace === workspace)))
        throw new Error('No active sessions in this workspace');
      const request = {id: this.makeId(), action, ...(action === 'stop' ? {sessionId} : {}),
        ...(action === 'stop-workspace' ? {workspace} : {}),
        state: 'pending', createdAt: this.now()};
      await this.save({...state, request, lastResult: null});
      return {id: request.id, state: 'pending'};
    });
  }

  async heartbeat(sessions) {
    return this.serialize(async()=>{
      if (!Array.isArray(sessions)) throw new Error('Invalid sessions');
      const state=this.normalize(await this.read());
      await this.save({...state,daemon:{seenAt:this.now(),sessions}});
      return {updated:true};
    });
  }

  async poll(sessions) {
    return this.serialize(async () => {
      if (!Array.isArray(sessions) || sessions.some(s =>
        typeof s?.session_id !== 'string' || typeof s?.workspace !== 'string'))
        throw new Error('Invalid daemon session listing');
      const state = this.normalize(await this.read());
      const request = state.request?.state === 'pending'
        ? {...state.request, state: 'processing'}
        : state.request || null;
      await this.save({...state, request, daemon: {seenAt: this.now(), sessions}});
      return request?.state === 'processing' && state.request?.state === 'pending'
        ? {id: request.id, action: request.action, ...(request.sessionId ? {sessionId:request.sessionId} : {}),
          ...(request.workspace ? {workspace:request.workspace} : {})}
        : null;
    });
  }

  async complete(id, response) {
    return this.serialize(async () => {
      const state = this.normalize(await this.read());
      if (!state.request || state.request.id !== id) return {ignored: true};
      const stoppedCount = response?.stopped_count ?? (response?.stopped ? 1 : 0);
      const errors = response?.errors || [];
      const errorText = response?.error || errors.map(e => e.error || String(e)).join('; ');
      const lastResult = response?.ok
        ? {id, ok: errors.length === 0, stoppedCount, errors, ...(errors.length ? {error: errorText} : {})}
        : {id, ok: false, stoppedCount, errors, error: String(errorText || 'Unable to stop sessions')};
      await this.save({...state, request: null, lastResult});
      return lastResult;
    });
  }
}
