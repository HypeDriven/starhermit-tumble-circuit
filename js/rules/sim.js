// Tumble Circuit — deterministic realtime simulation (the rules engine).
// Pure state transitions only: no DOM, no rendering, no platform clocks.
// Fixed step: 60 ticks/second. All randomness enters through seeded streams.

import { clamp, approach, TAU } from './dmath.js';
import { Rng, hashState, sessionId as makeSessionId } from './rng.js';
import {
  buildCourse, groundAt, zoneAt, hazardHit, spawnAt, KILL_Y,
} from './course.js';
import { botThink } from './bots.js';

export const DT = 1 / 60;
export const TICK_RATE = 60;
export const MAX_PLAYERS = 32;
export const INPUT_BUFFER_TICKS = 45;
export const RULES_VERSION = 1;

// physics constants (units are meters/seconds; obstacle phases use ticks)
export const PHYS = {
  runSpeed: 8.6,
  accelGround: 68,
  accelAir: 26,
  gravity: 30,
  terminal: 32,
  jumpV: 11.8,
  coyoteTicks: 7,
  jumpBufferTicks: 8,
  diveBoost: 5.6,
  diveUp: 3.4,
  diveCooldown: 46,
  recoverTicks: 22,
  respawnTicks: 66,
  invulnTicks: 50,
  playerR: 0.55,
  playerH: 1.6,
};

export const PSTATE = {
  RUN: 'run', AIR: 'air', DIVE: 'dive', STUN: 'stun', RECOVER: 'recover',
  RESPAWN: 'respawn', FINISH: 'finish', OUT: 'out',
};

// ---------------------------------------------------------------------------
// State creation
// ---------------------------------------------------------------------------

// roster: [{ id, name, color, isBot }]
// opts: { quota, timeLimit, botSkill, seedOverride, assists }
export function createState(courseDef, roster, opts = {}) {
  if (roster.length > MAX_PLAYERS) {
    throw new Error('roster size out of range: ' + roster.length);
  }
  const course = buildCourse(courseDef);
  const seed = (opts.seedOverride != null ? opts.seedOverride : courseDef.seed) >>> 0;
  const rng = new Rng(seed, 'rules');
  const botSkill = opts.botSkill != null ? opts.botSkill : 0.6;

  const players = roster.map((r, i) => {
    const persona = r.isBot ? {
      skill: clamp(botSkill * rng.range(0.75, 1.3), 0.2, 1),
      // competent bots must be able to dive (validation probes rely on it)
      aggr: botSkill >= 0.9 ? rng.range(0.6, 1) : rng.range(0.35, 1),
      lane: rng.range(-0.75, 0.75),
      wob: rng.range(0, TAU),
      orbit: rng.sign(),
    } : null;
    let sx, sz;
    if (course.kind === 'survival') {
      const ang = (i / Math.max(1, roster.length)) * TAU;
      const rr = course.arena.r * 0.62;
      sx = course.arena.cx + Math.cos(ang) * rr;
      sz = course.arena.cz + Math.sin(ang) * rr;
    } else {
      const laneCount = Math.min(roster.length, 8);
      const lane = (i % laneCount) - (laneCount - 1) / 2;
      const row = Math.floor(i / laneCount);
      const sp = spawnAt(course, 0);
      sx = sp.x + lane * 1.4; sz = sp.z - row * 1.6 - 1;
    }
    return {
      id: r.id, name: r.name, color: r.color | 0, isBot: !!r.isBot, persona,
      sid: r.sid || makeSessionId(rng),
      x: sx, y: 0, z: sz,
      vx: 0, vy: 0, vz: 0, px: 0, py: 0, pz: 0,
      st: PSTATE.RUN, grounded: true, coyote: 0,
      jumpBuf: 0, diveCd: 0, diveReq: false, stunT: 0, recoverT: 0,
      respawnT: 0, invulnT: 0, cp: 0,
      falls: 0, invalids: 0, jumps: 0, dives: 0, knocks: 0,
      finishTick: -1, progress: 0, aliveTicks: 0,
      qualified: false, eliminated: false,
      input: { mx: 0, mz: 0 },
      pending: {},
    };
  });

  return {
    version: RULES_VERSION,
    courseRef: { id: courseDef.id, version: courseDef.version || 1, seed: courseDef.seed >>> 0 },
    course,
    kind: course.kind,
    quota: Math.max(1, Math.min(opts.quota != null ? opts.quota : 1, roster.length)),
    timeLimit: opts.timeLimit != null ? opts.timeLimit : course.timeLimit,
    par: course.par,
    tick: 0,
    phase: 'active',
    terminal: null,
    finishOrder: [],
    players,
    events: [],
    seenCmds: [],
    invalidLog: [],
    stats: { commands: 0, dropped: 0 },
  };
}

// ---------------------------------------------------------------------------
// Legal actions — the single API used by play, tutorials and hints
// ---------------------------------------------------------------------------

export function legalActions(state, playerId) {
  const p = state.players.find(pl => pl.id === playerId);
  if (!p) return { exists: false, canInput: false };
  const active = state.phase === 'active' && !p.eliminated &&
    p.st !== PSTATE.FINISH && p.st !== PSTATE.OUT && p.st !== PSTATE.RESPAWN;
  const stunned = p.stunT > 0 || p.st === PSTATE.STUN;
  const jumpOk = active && !stunned && (p.grounded || p.coyote > 0);
  const diveOk = active && !stunned && p.diveCd <= 0 && p.st !== PSTATE.DIVE;
  return {
    exists: true,
    canInput: active,
    state: p.st,
    stunned,
    move: { ok: active && !stunned, reason: !active ? 'inactive' : (stunned ? 'stunned' : null) },
    jump: { ok: jumpOk, reason: !active ? 'inactive' : (stunned ? 'stunned' : (p.grounded || p.coyote > 0 ? null : 'airborne')) },
    dive: { ok: diveOk, reason: !active ? 'inactive' : (stunned ? 'stunned' : (p.diveCd > 0 ? 'cooldown' : null)) },
    finished: p.st === PSTATE.FINISH,
    eliminated: p.eliminated || p.st === PSTATE.OUT,
  };
}

// ---------------------------------------------------------------------------
// Command intake — validated, idempotent, quantized
// ---------------------------------------------------------------------------

let cmdSeq = 0;
export function makeCommand(playerId, tick, input, playerKey = 'local') {
  cmdSeq += 1;
  return {
    id: playerKey + '-' + cmdSeq.toString(36) + '-' + tick.toString(36),
    playerId, tick,
    mx: clamp(Math.round((input.mx || 0) * 127), -127, 127),
    mz: clamp(Math.round((input.mz || 0) * 127), -127, 127),
    jump: !!input.jump, dive: !!input.dive,
  };
}

export function applyCommand(state, cmd) {
  const fail = (reason) => {
    state.invalidLog.push({ tick: state.tick, playerId: cmd && cmd.playerId, reason });
    if (state.invalidLog.length > 120) state.invalidLog.shift();
    const p = state.players.find(pl => pl.id === (cmd && cmd.playerId));
    if (p) p.invalids += 1;
    return { ok: false, reason };
  };
  if (!cmd || typeof cmd !== 'object') return fail('malformed');
  if (typeof cmd.id !== 'string' || !cmd.id) return fail('malformed-id');
  if (state.seenCmds.includes(cmd.id)) return { ok: true, dedup: true }; // idempotent
  if (state.phase !== 'active') return fail('round-over');
  const p = state.players.find(pl => pl.id === cmd.playerId);
  if (!p) return fail('no-player');
  if (p.eliminated || p.st === PSTATE.OUT || p.st === PSTATE.FINISH) return fail('player-inactive');
  if (!Number.isInteger(cmd.tick)) return fail('bad-tick');
  // commands must target a future tick; the current tick is already committed
  if (cmd.tick <= state.tick) { state.stats.dropped++; return { ok: false, reason: 'stale-tick' }; }
  if (cmd.tick > state.tick + INPUT_BUFFER_TICKS) return { ok: false, reason: 'future-tick' };
  if (!Number.isInteger(cmd.mx) || !Number.isInteger(cmd.mz) ||
      Math.abs(cmd.mx) > 127 || Math.abs(cmd.mz) > 127) return fail('bad-move');
  state.seenCmds.push(cmd.id);
  if (state.seenCmds.length > 600) state.seenCmds.splice(0, 200);
  p.pending[cmd.tick] = { mx: cmd.mx / 127, mz: cmd.mz / 127, jump: !!cmd.jump, dive: !!cmd.dive };
  state.stats.commands++;
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Main step
// ---------------------------------------------------------------------------

export function step(state) {
  if (state.phase !== 'active') return state;
  const course = state.course;
  state.tick += 1;
  const tick = state.tick;
  state.events.length = 0;

  for (const p of state.players) {
    p.px = p.x; p.py = p.y; p.pz = p.z;

    // ---- input intake (bots think inside the sim: fully deterministic)
    if (p.eliminated || p.st === PSTATE.OUT || p.st === PSTATE.FINISH) continue;
    if (p.isBot) {
      const b = botThink(state, p);
      p.input.mx = b.mx; p.input.mz = b.mz;
      if (b.jump) p.jumpBuf = PHYS.jumpBufferTicks;
      if (b.dive) p.diveReq = true;
    } else {
      const cmd = p.pending[tick];
      if (cmd) {
        p.input.mx = cmd.mx; p.input.mz = cmd.mz;
        if (cmd.jump) p.jumpBuf = PHYS.jumpBufferTicks;
        if (cmd.dive) p.diveReq = true;
      }
      for (const k in p.pending) if ((k | 0) < tick) delete p.pending[k];
    }

    stepPlayer(state, p, tick);
  }

  updateTerminal(state);
  return state;
}

function stepPlayer(state, p, tick) {
  const course = state.course;

  if (p.st === PSTATE.RESPAWN) {
    p.respawnT -= 1;
    if (p.respawnT <= 0) {
      const sp = spawnAt(course, p.cp);
      p.x = sp.x; p.y = sp.y; p.z = sp.z;
      p.px = p.x; p.py = p.y; p.pz = p.z;
      p.vx = 0; p.vy = 0; p.vz = 0;
      p.st = PSTATE.RUN; p.grounded = true;
      p.invulnT = PHYS.invulnTicks;
      state.events.push({ t: 'respawn', p: p.id, x: p.x, y: p.y, z: p.z });
    }
    return;
  }

  if (p.invulnT > 0) p.invulnT -= 1;
  if (p.diveCd > 0) p.diveCd -= 1;
  if (p.jumpBuf > 0) p.jumpBuf -= 1;

  const stunned = p.stunT > 0;
  if (stunned) {
    p.stunT -= DT;
    if (p.stunT <= 0 && p.st === PSTATE.STUN) p.st = p.grounded ? PSTATE.RUN : PSTATE.AIR;
  }
  if (p.st === PSTATE.RECOVER) {
    p.recoverT -= 1;
    if (p.recoverT <= 0) p.st = p.grounded ? PSTATE.RUN : PSTATE.AIR;
  }

  // ---- horizontal control
  // ctl scales steering AUTHORITY (accel), not target speed: a dive keeps
  // its momentum instead of braking mid-flight
  const ctl = stunned ? 0 : (p.st === PSTATE.DIVE ? 0.25 : p.st === PSTATE.RECOVER ? 0.3 : 1);
  const speed = PHYS.runSpeed * (p.speedMul || 1);
  const tvx = clamp(p.input.mx, -1, 1) * speed;
  const tvz = clamp(p.input.mz, -1, 1) * speed;
  const acc = (p.grounded ? PHYS.accelGround : PHYS.accelAir) * DT * ctl;
  p.vx = approach(p.vx, tvx, acc);
  p.vz = approach(p.vz, tvz, acc);

  // ---- jump (buffered + coyote)
  if (p.grounded) p.coyote = PHYS.coyoteTicks; else if (p.coyote > 0) p.coyote -= 1;
  if (p.jumpBuf > 0 && p.coyote > 0 && !stunned) {
    p.vy = PHYS.jumpV; p.grounded = false; p.coyote = 0; p.jumpBuf = 0;
    if (p.st !== PSTATE.DIVE) p.st = PSTATE.AIR;
    p.jumps += 1;
    state.events.push({ t: 'jump', p: p.id, x: p.x, y: p.y, z: p.z });
  }

  // ---- dive
  if (p.diveReq) {
    p.diveReq = false;
    if (p.diveCd <= 0 && !stunned && p.st !== PSTATE.DIVE) {
      let dx = p.input.mx, dz = p.input.mz;
      const m = Math.hypot(dx, dz);
      if (m < 0.2) { dx = 0; dz = 1; } else { dx /= m; dz /= m; }
      p.vx += dx * PHYS.diveBoost; p.vz += dz * PHYS.diveBoost;
      p.vy = Math.max(p.vy, PHYS.diveUp);
      p.st = PSTATE.DIVE; p.grounded = false; p.diveCd = PHYS.diveCooldown;
      p.dives += 1;
      state.events.push({ t: 'dive', p: p.id, x: p.x, y: p.y, z: p.z });
    }
  }

  // ---- gravity + integrate
  p.vy = Math.max(p.vy - PHYS.gravity * DT, -PHYS.terminal);
  p.x += p.vx * DT; p.y += p.vy * DT; p.z += p.vz * DT;

  // ---- ground resolve
  const g = groundAt(course, p.x, p.z, tick);
  const wasGrounded = p.grounded;
  p.grounded = false;
  if (g && p.vy <= 0.01 && p.y <= g.y + 0.35 && p.y >= g.y - 0.35) {
    p.y = g.y; 
    if (!wasGrounded) {
      const impact = -p.vy;
      if (p.st === PSTATE.DIVE) { p.st = PSTATE.RECOVER; p.recoverT = PHYS.recoverTicks; }
      else if (p.st === PSTATE.AIR || p.st === PSTATE.STUN) p.st = PSTATE.RUN;
      state.events.push({ t: 'land', p: p.id, x: p.x, y: p.y, z: p.z, impact });
    }
    p.vy = 0; p.grounded = true;
    if (g.mover) { p.x += g.mover.vx; p.z += g.mover.vz; }
  } else if (wasGrounded && p.st === PSTATE.RUN) {
    p.st = PSTATE.AIR; // walked off an edge
  }

  // ---- zones
  if (p.grounded) {
    const conv = zoneAt(course, 'conveyor', p.x, p.z);
    if (conv) { p.x += conv.vx * DT; p.z += conv.vz * DT; }
    const bounce = zoneAt(course, 'bounce', p.x, p.z);
    if (bounce && p.vy <= 0.01) {
      p.vy = bounce.power; p.grounded = false; p.st = PSTATE.AIR;
      state.events.push({ t: 'bounce', p: p.id, x: p.x, y: p.y, z: p.z });
    }
  }
  const wind = zoneAt(course, 'wind', p.x, p.z);
  if (wind) {
    p.vx = approach(p.vx, p.vx + wind.vx, Math.abs(wind.vx) * 0.06 + 0.05);
    p.vz = approach(p.vz, p.vz + wind.vz, Math.abs(wind.vz) * 0.06 + 0.05);
  }

  // keep inside nothing — falling off is the point; but clamp absurd speeds
  p.vx = clamp(p.vx, -26, 26); p.vz = clamp(p.vz, -26, 26);

  // ---- hazards
  if (p.invulnT <= 0 && p.st !== PSTATE.RESPAWN) {
    for (const ob of course.obstacles) {
      const hit = hazardHit(course, ob, tick, p.x, p.y + 0.8, p.z, PHYS.playerR);
      if (hit) {
        p.vx = hit.ix; p.vy = hit.iy; p.vz = hit.iz;
        p.stunT = hit.stun; p.st = PSTATE.STUN; p.grounded = false;
        p.invulnT = 42; // mercy window: no juggling while recovering
        p.knocks += 1;
        state.events.push({ t: 'knock', p: p.id, x: p.x, y: p.y, z: p.z, kind: ob.kind });
        break;
      }
    }
  }

  // ---- falling off
  if (p.y < KILL_Y) {
    p.falls += 1;
    state.events.push({ t: 'fall', p: p.id, x: p.x, y: p.y, z: p.z });
    if (state.kind === 'survival') {
      p.st = PSTATE.OUT; p.progress = p.aliveTicks;
      state.events.push({ t: 'out', p: p.id });
    } else {
      p.st = PSTATE.RESPAWN; p.respawnT = PHYS.respawnTicks;
      p.vx = 0; p.vy = 0; p.vz = 0;
    }
    return;
  }

  // ---- race progress, checkpoints, finish
  if (state.kind === 'race') {
    while (p.cp < course.checkpoints.length && p.z >= course.checkpoints[p.cp].z) {
      if (p.pz < course.checkpoints[p.cp].z) {
        state.events.push({ t: 'checkpoint', p: p.id, cp: p.cp + 1, of: course.checkpoints.length });
      }
      p.cp += 1;
    }
    if (p.z >= course.finishZ && p.st !== PSTATE.FINISH) {
      p.st = PSTATE.FINISH; p.finishTick = tick;
      p.input.mx = 0; p.input.mz = 0;
      state.finishOrder.push(p.id);
      state.events.push({ t: 'finish', p: p.id, place: state.finishOrder.length });
    }
    p.progress = clamp(p.z, 0, course.finishZ);
  } else {
    p.aliveTicks += 1;
    p.progress = p.aliveTicks;
  }
}

function updateTerminal(state) {
  if (state.terminal) { state.phase = 'terminal'; return; }
  const ps = state.players;
  if (state.kind === 'race') {
    const finished = ps.filter(p => p.st === PSTATE.FINISH).length;
    if (finished >= state.quota) {
      state.terminal = { reason: 'quota', tick: state.tick };
    } else if (state.tick >= state.timeLimit) {
      state.terminal = { reason: 'time', tick: state.tick };
    } else if (finished === ps.length) {
      state.terminal = { reason: 'all-finished', tick: state.tick };
    } else if (ps.every(p => p.st === PSTATE.FINISH || p.eliminated)) {
      state.terminal = { reason: 'all-finished', tick: state.tick };
    }
  } else {
    const alive = ps.filter(p => p.st !== PSTATE.OUT && !p.eliminated);
    if (ps.length > 1 && alive.length <= 1) {
      state.terminal = { reason: 'last-standing', tick: state.tick };
    } else if (ps.length === 1 && alive.length === 0) {
      state.terminal = { reason: 'out', tick: state.tick };
    } else if (state.tick >= state.timeLimit) {
      state.terminal = { reason: 'time', tick: state.tick };
    }
  }
  if (state.terminal) state.phase = 'terminal';
}

// ---------------------------------------------------------------------------
// Progress / ranking helpers (shared by scoring, HUD and bots)
// ---------------------------------------------------------------------------

export function rankPlayers(state) {
  const arr = state.players.slice();
  arr.sort((a, b) => comparePlayers(state, a, b));
  return arr;
}

// Spec tie-break order: primary objective, fewer invalid actions, lower
// authoritative elapsed time, then stable session identifier.
export function comparePlayers(state, a, b) {
  if (state.kind === 'race') {
    const af = a.st === PSTATE.FINISH, bf = b.st === PSTATE.FINISH;
    if (af !== bf) return af ? -1 : 1;
    if (af && a.finishTick !== b.finishTick) return a.finishTick - b.finishTick;
    if (!af && a.progress !== b.progress) return b.progress - a.progress;
  } else {
    const ao = a.st === PSTATE.OUT, bo = b.st === PSTATE.OUT;
    if (ao !== bo) return ao ? 1 : -1;
    if (a.aliveTicks !== b.aliveTicks) return b.aliveTicks - a.aliveTicks;
  }
  if (a.invalids !== b.invalids) return a.invalids - b.invalids;
  if (a.falls !== b.falls) return a.falls - b.falls;
  if (a.sid < b.sid) return -1;
  if (a.sid > b.sid) return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// Serialization / hashing / migration
// ---------------------------------------------------------------------------

export function serializeState(state) {
  return {
    version: state.version,
    courseRef: state.courseRef,
    kind: state.kind,
    quota: state.quota,
    timeLimit: state.timeLimit,
    par: state.par,
    tick: state.tick,
    phase: state.phase,
    terminal: state.terminal,
    finishOrder: state.finishOrder.slice(),
    players: state.players.map(p => ({
      id: p.id, name: p.name, color: p.color, isBot: p.isBot, persona: p.persona, sid: p.sid,
      x: p.x, y: p.y, z: p.z, vx: p.vx, vy: p.vy, vz: p.vz,
      st: p.st, grounded: p.grounded, coyote: p.coyote, jumpBuf: p.jumpBuf,
      diveCd: p.diveCd, stunT: p.stunT, recoverT: p.recoverT, respawnT: p.respawnT,
      invulnT: p.invulnT, cp: p.cp, falls: p.falls, invalids: p.invalids,
      jumps: p.jumps, dives: p.dives, knocks: p.knocks,
      finishTick: p.finishTick, progress: p.progress, aliveTicks: p.aliveTicks,
      qualified: p.qualified, eliminated: p.eliminated,
      input: { mx: p.input.mx, mz: p.input.mz },
      pending: p.pending,
    })),
    seenCmds: state.seenCmds.slice(-200),
    stats: { ...state.stats },
  };
}

export function hashGameState(state) {
  return hashState({
    tick: state.tick, phase: state.phase, terminal: state.terminal,
    players: state.players.map(p => ({
      id: p.id, x: p.x, y: p.y, z: p.z, vx: p.vx, vy: p.vy, vz: p.vz,
      st: p.st, g: p.grounded, cp: p.cp, falls: p.falls, inv: p.invalids,
      ft: p.finishTick, prog: p.progress, at: p.aliveTicks, el: p.eliminated,
    })),
  });
}

// Rebuild a live state from a serialized snapshot. courseDef must be the
// same versioned content the snapshot references.
export function deserializeState(data, courseDef) {
  if (data.version > RULES_VERSION) throw new Error('state from newer rules version');
  const migrated = migrateState(data);
  const state = createState(courseDef, [], { quota: migrated.quota, timeLimit: migrated.timeLimit });
  // createState with empty roster then rebuild players to preserve identities
  state.courseRef = migrated.courseRef;
  state.kind = migrated.kind;
  state.tick = migrated.tick;
  state.phase = migrated.phase;
  state.terminal = migrated.terminal;
  state.finishOrder = migrated.finishOrder.slice();
  state.seenCmds = migrated.seenCmds.slice();
  state.stats = { ...migrated.stats };
  state.players = migrated.players.map(sp => ({
    ...sp,
    px: sp.x, py: sp.y, pz: sp.z,
    diveReq: false,
    pending: sp.pending || {},
    input: { mx: sp.input.mx, mz: sp.input.mz },
  }));
  state.events = [];
  state.invalidLog = [];
  return state;
}

// Migration chain. v1 is current; the structure exists so future versions
// can upgrade old snapshots/replays without breaking saves.
export function migrateState(data) {
  let d = data;
  if (d.version === 0) { // hypothetical legacy shape: players lacked sid
    d = {
      ...d, version: 1,
      players: d.players.map((p, i) => ({ invalids: 0, knocks: 0, sid: 'legacy' + i, ...p })),
    };
  }
  return d;
}
