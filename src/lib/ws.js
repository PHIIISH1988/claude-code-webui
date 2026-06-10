class WsManager {
  constructor() {
    this.ws = null; this.handlers = new Map(); this.globalHandlers = []; this.pending = [];
    this._connected = false;
    this._stateListeners = []; // {connected: bool} listeners
    this.connect();
  }
  connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.ws = new WebSocket(`${proto}//${location.host}/ws`);
    this.ws.onopen = () => {
      this._connected = true;
      this._notifyState(true);
      for (const m of this.pending) this.ws.send(m); this.pending = [];
    };
    this.ws.onmessage = (e) => {
      let d; try { d = JSON.parse(e.data); } catch { return; }
      // Dispatch over SNAPSHOTS: one-shot handlers commonly remove
      // themselves (offGlobal → splice) while we're mid-dispatch, which
      // shifts the array and silently SKIPS the next handler. Bit us when
      // two handlers both listened for the same 'created' event —
      // createSession's self-removing handler made TaskManager's
      // spawn-bind handler (registered right after it) never fire.
      if (d.sessionId) [...(this.handlers.get(d.sessionId) || [])].forEach(h => h(d));
      [...this.globalHandlers].forEach(h => h(d));
    };
    this.ws.onclose = () => {
      this._connected = false;
      this._notifyState(false);
      setTimeout(() => this.connect(), 2000);
    };
    this.ws.onerror = () => {};
  }
  get connected() { return this._connected; }
  send(d) { const m = JSON.stringify(d); this.ws?.readyState === 1 ? this.ws.send(m) : this.pending.push(m); }
  on(sid, h) { if (!this.handlers.has(sid)) this.handlers.set(sid, []); this.handlers.get(sid).push(h); }
  off(sid) { this.handlers.delete(sid); }
  onGlobal(h) { this.globalHandlers.push(h); }
  offGlobal(h) { const i = this.globalHandlers.indexOf(h); if (i >= 0) this.globalHandlers.splice(i, 1); }
  onStateChange(h) { this._stateListeners.push(h); }
  offStateChange(h) { const i = this._stateListeners.indexOf(h); if (i >= 0) this._stateListeners.splice(i, 1); }
  _notifyState(connected) { for (const h of this._stateListeners) h(connected); }
}

export { WsManager };
