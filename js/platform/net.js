// Hosted-play client: JSON control frames over WebSocket for lifecycle and
// compact binary frames for high-frequency input/snapshots. All gameplay
// truth comes from the server; this client sends validated commands with
// unique IDs and renders snapshots. Reconnects with a fresh snapshot.

const FRAME_CMD = 1;     // client -> server binary input frame
const FRAME_SNAP = 2;    // server -> client binary snapshot (reserved; JSON used for state)

export class HostedClient {
  constructor() {
    this.ws = null;
    this.roomCode = null;
    this.playerId = null;
    this.connected = false;
    this.state = 'idle'; // idle | connecting | lobby | playing | done
    this.onEvent = () => {};
    this.cmdSeq = 0;
    this.reconnectAttempts = 0;
  }

  get available() {
    return typeof WebSocket !== 'undefined' &&
      (location.protocol === 'http:' || location.protocol === 'https:');
  }

  connect() {
    if (!this.available) return Promise.reject(new Error('hosted play unavailable offline'));
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = proto + '//' + location.host + '/ws';
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      const to = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 8000);
      ws.onopen = () => { clearTimeout(to); this.ws = ws; this.connected = true; resolve(); };
      ws.onerror = () => { clearTimeout(to); reject(new Error('connection failed')); };
      ws.onclose = () => this.handleClose();
      ws.onmessage = (m) => this.handleMessage(m);
    });
  }

  handleClose() {
    this.connected = false;
    this.onEvent({ t: 'disconnected' });
    // bounded reconnect while a room is active
    if (this.roomCode && this.reconnectAttempts < 5) {
      this.reconnectAttempts++;
      setTimeout(() => {
        this.connect().then(() => this.send({ op: 'rejoin', code: this.roomCode, playerId: this.playerId }))
          .catch(() => {});
      }, 500 * this.reconnectAttempts);
    }
  }

  handleMessage(m) {
    if (typeof m.data === 'string') {
      let msg;
      try { msg = JSON.parse(m.data); } catch { return; }
      if (msg.t === 'joined') { this.roomCode = msg.code; this.playerId = msg.playerId; this.reconnectAttempts = 0; }
      this.onEvent(msg);
    }
  }

  send(obj) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  // Compact binary input frame: [type u8][tick u32][mx i8][mz i8][buttons u8][seq u16]
  sendInput(tick, mx, mz, jump, dive) {
    if (!this.ws || this.ws.readyState !== 1) return;
    this.cmdSeq = (this.cmdSeq + 1) & 0xffff;
    const buf = new ArrayBuffer(10);
    const dv = new DataView(buf);
    dv.setUint8(0, FRAME_CMD);
    dv.setUint32(1, tick >>> 0);
    dv.setInt8(5, Math.max(-127, Math.min(127, Math.round(mx * 127))));
    dv.setInt8(6, Math.max(-127, Math.min(127, Math.round(mz * 127))));
    dv.setUint8(7, (jump ? 1 : 0) | (dive ? 2 : 0));
    dv.setUint16(8, this.cmdSeq);
    this.ws.send(buf);
  }

  createRoom(courseId, showId) { this.send({ op: 'create', courseId, showId }); }
  joinRoom(code) { this.send({ op: 'join', code }); }
  quickJoin() { this.send({ op: 'quick' }); }
  setReady(ready) { this.send({ op: 'ready', ready: !!ready }); }
  leave() { this.send({ op: 'leave' }); this.roomCode = null; this.playerId = null; }
  close() { this.roomCode = null; try { this.ws && this.ws.close(); } catch {} this.ws = null; }
}
