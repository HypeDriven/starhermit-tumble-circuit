// Tumble Circuit — authoritative host server (Node.js, stdlib only).
// - Serves the static browser distribution.
// - GET /api/v1/time — host clock for daily boundaries (client RTT-adjusts).
// - /ws — Realtime rooms for hosted play. The SERVER runs the authoritative
//   simulation (same rules modules as the client) and decides results;
//   clients send validated, idempotent input commands only.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { createState, step, applyCommand, serializeState, TICK_RATE, PSTATE } from './js/rules/sim.js';
import { roundResults } from './js/rules/scoring.js';
import { courseById, showById } from './js/content/stages.js';
import { dailyDef, dailyDateString } from './js/content/daily.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.txt': 'text/plain',
};

// ---------------------------------------------------------------------------
// HTTP + static files
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/v1/time') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ms: Date.now(), iso: new Date().toISOString() }));
    return;
  }
  if (url.pathname === '/api/v1/telemetry') {
    // aggregate funnel categories only; nothing is persisted with identity
    res.writeHead(204); res.end();
    return;
  }
  if (url.pathname === '/api/v1/daily') {
    const d = dailyDateString();
    const def = dailyDef(d);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ date: d, id: def.id, seed: def.seed, theme: def.theme }));
    return;
  }
  // static
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT) || file.includes(`${path.sep}.`)) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    const ext = path.extname(file);
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(data);
  });
});

// ---------------------------------------------------------------------------
// Minimal RFC6455 WebSocket (no dependencies)
// ---------------------------------------------------------------------------
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function wsAccept(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

function wsEncode(payload) {
  const isText = typeof payload === 'string';
  const data = isText ? Buffer.from(payload) : payload;
  const len = data.length;
  const op = isText ? 0x81 : 0x82;
  let header;
  if (len < 126) {
    header = Buffer.from([op, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4); header[0] = op; header[1] = 126; header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10); header[0] = op; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, data]);
}

// stateful frame parser per socket
function wsParser(onMessage, onClose) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const op = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (len > 65536) { onClose(); return; } // payload cap
      const maskOff = off;
      if (masked) off += 4;
      if (buf.length < off + len) return;
      let payload = buf.subarray(off, off + len);
      if (masked) {
        const mask = buf.subarray(maskOff, maskOff + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }
      buf = buf.subarray(off + len);
      if (op === 8) { onClose(); return; }
      if (op === 9) continue; // ping (pong omitted: tiny server)
      if ((op === 1 || op === 2) && fin) onMessage(payload, op === 2);
    }
  };
}

// ---------------------------------------------------------------------------
// Rooms: authoritative sim on the server
// ---------------------------------------------------------------------------
const rooms = new Map(); // code -> room

function makeCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 5; i++) s += chars[crypto.randomInt(chars.length)];
  return rooms.has(s) ? makeCode() : s;
}

class Room {
  constructor(showId) {
    this.code = makeCode();
    this.showId = showId || 'show-quick';
    this.clients = new Map(); // playerId -> { sock, name, ready, alive }
    this.state = null;        // authoritative sim state
    this.courseDef = null;
    this.roundIndex = 0;
    this.aliveIds = [];
    this.interval = null;
    this.result = null;
    this.cmdCounts = new Map(); // rate limiting per player
  }

  broadcast(obj) {
    const data = wsEncode(JSON.stringify(obj));
    for (const c of this.clients.values()) {
      try { c.sock.write(data); } catch {}
    }
  }

  lobby() {
    return {
      t: 'lobby', code: this.code,
      players: [...this.clients.entries()].map(([id, c]) => ({ id, name: c.name, ready: c.ready })),
    };
  }

  addClient(sock, playerId) {
    if (this.clients.size >= 32) return null;
    const id = playerId && this.clients.has(playerId) ? playerId : 'p' + crypto.randomInt(1e6).toString(36);
    this.clients.set(id, { sock, name: 'Player ' + id.slice(1, 5), ready: false });
    if (!this.aliveIds.includes(id)) this.aliveIds.push(id);
    return id;
  }

  maybeStart() {
    const ready = [...this.clients.values()].filter(c => c.ready).length;
    if (this.state || this.clients.size === 0) return;
    if (ready >= this.clients.size && ready >= 1) this.startRound();
  }

  startRound() {
    const show = showById(this.showId);
    const round = show ? show.rounds[this.roundIndex] : null;
    const courseDef = courseById(round ? round.courseId : 'show-ridge');
    if (!courseDef) return;
    this.courseDef = courseDef;
    // fill with bots to the show's roster size
    const roster = [...this.clients.keys()].filter(id => this.aliveIds.includes(id))
      .map(id => ({ id, name: this.clients.get(id).name, color: 0xff8fab, isBot: false }));
    const target = show ? Math.min(show.players, Math.max(roster.length + 3, 6)) : Math.max(roster.length + 3, 6);
    for (let i = roster.length; i < target; i++) roster.push({ id: 'bot-' + i, name: 'Bot ' + i, color: 0x3a86ff, isBot: true });
    const quota = round ? Math.min(round.quota, roster.length) : Math.max(1, Math.ceil(roster.length / 2));
    this.state = createState(courseDef, roster, { quota, botSkill: show ? show.botSkill : 0.55 });
    this.quota = quota;
    this.result = null;
    this.broadcast({
      t: 'start', courseId: courseDef.id, quota,
      roster: roster.map(r => ({ id: r.id, name: r.name, color: r.color, isBot: r.isBot })),
    });
    let last = process.hrtime.bigint();
    this.interval = setInterval(() => {
      const now = process.hrtime.bigint();
      const dt = Number(now - last) / 1e9;
      last = now;
      // fixed step, clamped catch-up
      let steps = Math.min(8, Math.floor(dt * TICK_RATE) || 1);
      while (steps-- > 0 && this.state.phase === 'active') step(this.state);
      if (this.state.tick % 3 === 0) {
        this.broadcast({
          t: 'snapshot', tick: this.state.tick,
          players: this.state.players.map(p => ({ id: p.id, x: +p.x.toFixed(3), y: +p.y.toFixed(3), z: +p.z.toFixed(3), st: p.st })),
        });
      }
      if (this.state.phase === 'terminal') {
        clearInterval(this.interval);
        this.interval = null;
        // authoritative results — computed here, never from client claims
        this.result = roundResults(this.state);
        const qualified = this.result.places.filter(id => this.result.results[id].qualified);
        this.aliveIds = qualified.filter(id => this.clients.has(id));
        this.broadcast({
          t: 'result',
          places: this.result.places,
          results: this.result.results,
          terminal: this.state.terminal,
        });
        // advance the show or stop
        if (show && this.roundIndex < show.rounds.length - 1 && this.aliveIds.length > 1) {
          this.roundIndex++;
          for (const c of this.clients.values()) c.ready = false;
          setTimeout(() => { if (this.clients.size) this.startRound(); }, 6000);
        }
      }
    }, 1000 / TICK_RATE);
  }

  handleInput(playerId, dv) {
    if (!this.state || this.state.phase !== 'active') return;
    // rate limit: max 240 input frames/s per player
    const now = Date.now();
    const rc = this.cmdCounts.get(playerId) || { t: now, n: 0 };
    if (now - rc.t > 1000) { rc.t = now; rc.n = 0; }
    if (++rc.n > 300) return;
    this.cmdCounts.set(playerId, rc);
    const cmd = {
      id: playerId + '-' + dv.readUInt16BE(8).toString(36) + '-' + dv.readUInt32BE(1).toString(36),
      playerId,
      tick: dv.readUInt32BE(1),
      mx: dv.readInt8(5), mz: dv.readInt8(6),
      jump: (dv.readUint8(7) & 1) !== 0,
      dive: (dv.readUint8(7) & 2) !== 0,
    };
    applyCommand(this.state, cmd); // validates identity, tick window, bounds, dedup
  }
}

server.on('upgrade', (req, sock) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/ws') { sock.destroy(); return; }
  const key = req.headers['sec-websocket-key'];
  if (!key) { sock.destroy(); return; }
  sock.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`);
  sock.setNoDelay(true);

  let room = null, playerId = null;

  const send = (obj) => { try { sock.write(wsEncode(JSON.stringify(obj))); } catch {} };

  const onMessage = (payload, binary) => {
    if (!binary) {
      let msg;
      try { msg = JSON.parse(payload.toString()); } catch { return; }
      switch (msg.op) {
        case 'create': {
          room = new Room(typeof msg.showId === 'string' ? msg.showId : 'show-quick');
          rooms.set(room.code, room);
          playerId = room.addClient(sock, null);
          send({ t: 'joined', code: room.code, playerId, players: room.clients.size });
          room.broadcast(room.lobby());
          break;
        }
        case 'join':
        case 'quick': {
          if (msg.op === 'quick') {
            room = [...rooms.values()].find(r => !r.state && r.showId === 'show-quick') || null;
            if (!room) { room = new Room('show-quick'); rooms.set(room.code, room); }
          } else {
            room = rooms.get(String(msg.code || '').toUpperCase()) || null;
            if (!room) { send({ t: 'error', error: 'no such room' }); return; }
          }
          playerId = room.addClient(sock, null);
          if (!playerId) { send({ t: 'error', error: 'room full' }); room = null; return; }
          send({ t: 'joined', code: room.code, playerId, players: room.clients.size });
          room.broadcast(room.lobby());
          break;
        }
        case 'rejoin': {
          const r = rooms.get(String(msg.code || '').toUpperCase());
          if (r && r.clients.has(msg.playerId)) {
            room = r; playerId = msg.playerId;
            r.clients.get(playerId).sock = sock;
            send({ t: 'joined', code: r.code, playerId, players: r.clients.size });
            // fresh snapshot after reconnect
            if (r.state) {
              send({ t: 'start', courseId: r.courseDef.id, quota: r.quota, roster: r.state.players.map(p => ({ id: p.id, name: p.name, color: p.color, isBot: p.isBot })) });
              send({ t: 'snapshot', tick: r.state.tick, players: r.state.players.map(p => ({ id: p.id, x: p.x, y: p.y, z: p.z, st: p.st })) });
            }
          } else send({ t: 'error', error: 'cannot rejoin' });
          break;
        }
        case 'ready': if (room && playerId) { room.clients.get(playerId).ready = !!msg.ready; room.broadcast(room.lobby()); room.maybeStart(); } break;
        case 'leave': cleanup(); break;
      }
      return;
    }
    // binary input frame: [1][tick u32][mx][mz][buttons][seq u16]
    if (payload.length === 10 && payload[0] === 1 && room && playerId) {
      room.handleInput(playerId, payload);
    }
  };

  const cleanup = () => {
    if (room && playerId && room.clients.has(playerId)) {
      room.clients.delete(playerId);
      room.aliveIds = room.aliveIds.filter(id => id !== playerId);
      room.broadcast(room.lobby());
      if (room.clients.size === 0) {
        if (room.interval) clearInterval(room.interval);
        rooms.delete(room.code);
      }
    }
    room = null; playerId = null;
    try { sock.destroy(); } catch {}
  };

  sock.on('data', wsParser(onMessage, cleanup));
  sock.on('close', cleanup);
  sock.on('error', cleanup);
});

server.listen(PORT, () => {
  console.log(`Tumble Circuit host on http://localhost:${PORT}`);
});
