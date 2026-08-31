// Course runtime model. A course is built once from a versioned content
// definition; everything time-varying is a pure function of (tick, seed)
// so the whole simulation is deterministic and replayable.

import { dsin, dcos, clamp, pointSegXZ, dist2, TAU } from './dmath.js';
import { Rng } from './rng.js';

export const TRACK_W = 12;          // default full width of the track
export const KILL_Y = -7;           // below this the player has fallen
export const CHECKPOINT_SPACING = 42;

// ---------------------------------------------------------------------------
// Content definition helpers
// ---------------------------------------------------------------------------

let courseCounter = 0;

// seg() builds one segment descriptor in authored content.
export function seg(t, len, params = {}) { return { t, len, ...params }; }

// Build the runtime course from a versioned content definition.
// def: { id, version, seed, kind:'race'|'survival', theme, width, par,
//        timeLimit, mechanics, segments, arena, goals }
export function buildCourse(def) {
  const W = def.width || TRACK_W;
  const course = {
    id: def.id, version: def.version || 1, seed: def.seed >>> 0,
    kind: def.kind || 'race', themeId: def.theme || 'cumulus',
    width: W, par: def.par || 60 * 60, timeLimit: def.timeLimit || 90 * 60,
    mechanics: def.mechanics ? def.mechanics.slice() : [],
    platforms: [], movers: [], obstacles: [], zones: [], checkpoints: [],
    finishZ: 0, length: 0, spawn: { x: 0, y: 0, z: 2 },
    arena: null, buildCounter: ++courseCounter,
  };

  if (course.kind === 'survival') {
    const r = (def.arena && def.arena.r) || 9;
    course.arena = { r, cx: 0, cz: 0 };
    course.platforms.push({ x0: -r, x1: r, z0: -r, z1: r, y: 0, disc: true, r });
    const arms = (def.arena && def.arena.arms) || 1;
    course.obstacles.push({
      kind: 'spinner', cx: 0, cz: 0, h: 0.55, L: r - 0.4, barR: 0.42,
      omega: (def.arena && def.arena.omega) || 0.016, phase: 0, arms,
      accel: (def.arena && def.arena.accel) || 0.0000022, omegaMax: 0.05,
    });
    if (def.arena && def.arena.second) {
      // overhead bar: safe to run under, punishes mistimed jumps
      course.obstacles.push({
        kind: 'spinner', cx: 0, cz: 0, h: 2.2, hitH: 1.1, L: r - 0.4, barR: 0.34,
        omega: -0.011, phase: 1.9, arms: 1, accel: 0.0000016, omegaMax: -0.04,
      });
    }
    course.length = 0; course.finishZ = 0;
    course.checkpoints = [];
    return course;
  }

  const rng = new Rng(course.seed, 'rules-course');
  let z = 0;
  const half = W / 2;
  const startPlat = { x0: -half, x1: half, z0: -6, z1: 0, y: 0 };
  course.platforms.push(startPlat);

  let sinceCp = 0;
  for (const s of def.segments) {
    const z0 = z, z1 = z + s.len;
    const w = s.w || W, sh = w / 2;
    const autoCp = sinceCp >= CHECKPOINT_SPACING;
    if (s.checkpoint || autoCp) {
      course.checkpoints.push({ z: z0, x: 0 });
      sinceCp = 0;
    }
    sinceCp += s.len;

    switch (s.t) {
      case 'run':
        course.platforms.push({ x0: -sh, x1: sh, z0, z1, y: 0 });
        break;
      case 'narrow':
        course.platforms.push({ x0: -sh, x1: sh, z0, z1, y: 0, narrow: true });
        break;
      case 'bridge':
        course.platforms.push({ x0: -sh, x1: sh, z0, z1, y: 0, bridge: true });
        break;
      case 'gap': {
        // platform, void, platform — jumpable gap
        const g = s.gap || 3.4, at = s.at != null ? s.at : (s.len - g) / 2;
        course.platforms.push({ x0: -sh, x1: sh, z0, z1: z0 + at, y: 0 });
        course.platforms.push({ x0: -sh, x1: sh, z0: z0 + at + g, z1, y: 0 });
        break;
      }
      case 'gaps': {
        // series of gaps: s.gaps = [[at, w], ...] offsets from z0
        let cz = z0;
        for (const [at, gw] of s.gaps) {
          course.platforms.push({ x0: -sh, x1: sh, z0: cz, z1: z0 + at, y: 0 });
          cz = z0 + at + gw;
        }
        course.platforms.push({ x0: -sh, x1: sh, z0: cz, z1, y: 0 });
        break;
      }
      case 'spinner': {
        course.platforms.push({ x0: -sh, x1: sh, z0, z1, y: 0 });
        const n = s.count || 1;
        for (let i = 0; i < n; i++) {
          const oz = z0 + (s.len * (i + 1)) / (n + 1) + (s.dx || 0);
          course.obstacles.push({
            kind: 'spinner', cx: s.cx || 0, cz: oz, h: s.h || 0.62,
            L: s.L || (sh + 0.6), barR: 0.42,
            omega: (s.omega || 0.022) * (s.reverse && i % 2 ? -1 : 1) * rng.range(0.94, 1.06),
            phase: rng.range(0, TAU), arms: s.arms || 1, omegaMax: 0, accel: 0,
          });
        }
        break;
      }
      case 'pendulum': {
        course.platforms.push({ x0: -sh, x1: sh, z0, z1, y: 0 });
        const n = s.count || 1;
        for (let i = 0; i < n; i++) {
          const oz = z0 + (s.len * (i + 1)) / (n + 1);
          course.obstacles.push({
            kind: 'pendulum', px: s.px || 0, pz: oz, py: s.py || 7.2,
            L: s.L || 5.6, A: s.A || 1.05, omega: (s.omega || 0.030) * rng.range(0.92, 1.08),
            phase: rng.range(0, TAU), bobR: s.bobR || 1.05, plane: s.plane || 'x',
          });
        }
        break;
      }
      case 'pistons': {
        course.platforms.push({ x0: -sh, x1: sh, z0, z1, y: 0 });
        const n = s.count || 2;
        for (let i = 0; i < n; i++) {
          const oz = z0 + (s.len * (i + 1)) / (n + 1);
          course.obstacles.push({
            kind: 'piston', z0: oz - 1.1, z1: oz + 1.1, h: s.h || 2.4,
            A: s.A || (sh - 0.9), omega: (s.omega || 0.035) * rng.range(0.9, 1.1),
            phase: rng.range(0, TAU) + (i * PI_HALF_OFFSET(s)) , baseX: 0,
          });
        }
        break;
      }
      case 'bumpers': {
        course.platforms.push({ x0: -sh, x1: sh, z0, z1, y: 0 });
        const n = s.count || 4;
        for (let i = 0; i < n; i++) {
          const oz = z0 + (s.len * (i + 1)) / (n + 1) + rng.range(-1.5, 1.5);
          const ox = rng.range(-(sh - 1.4), sh - 1.4);
          course.obstacles.push({ kind: 'bumper', x: ox, z: oz, r: s.r || 0.9, h: s.h || 1.7, power: s.power || 8.5 });
        }
        break;
      }
      case 'conveyor':
        course.platforms.push({ x0: -sh, x1: sh, z0, z1, y: 0, belt: true });
        course.zones.push({ kind: 'conveyor', x0: -sh, x1: sh, z0, z1, vx: s.vx || 0, vz: s.vz || 0 });
        break;
      case 'fan':
        course.platforms.push({ x0: -sh, x1: sh, z0, z1, y: 0 });
        course.zones.push({ kind: 'wind', x0: -sh, x1: sh, z0, z1, vx: s.vx || 0, vz: s.vz || 0 });
        break;
      case 'bounce': {
        course.platforms.push({ x0: -sh, x1: sh, z0, z1, y: 0 });
        const n = s.count || 1;
        for (let i = 0; i < n; i++) {
          const oz = z0 + (s.len * (i + 1)) / (n + 1);
          course.zones.push({ kind: 'bounce', x: s.x != null ? s.x : rng.range(-(sh - 2), sh - 2), z: oz, r: s.r || 1.5, power: s.power || 13 });
        }
        break;
      }
      case 'mover': {
        // void crossed by a moving platform
        const pw = s.pw || 3.4, pd = s.pd || 3.2;
        course.movers.push({
          kind: 'mover', cx: 0, cz: z0 + s.len / 2, w: pw, d: pd, y: 0,
          axis: s.axis || 'x', A: s.A != null ? s.A : (sh - pw / 2),
          omega: s.omega || 0.028, phase: s.phase || 0,
        });
        break;
      }
      case 'weave': {
        course.platforms.push({ x0: -sh, x1: sh, z0, z1, y: 0 });
        const n = s.count || 2;
        for (let i = 0; i < n; i++) {
          const oz = z0 + (s.len * (i + 1)) / (n + 1);
          course.obstacles.push({
            kind: 'weave', wz: oz, h: s.h || 3.2, gapW: s.gapW || 3.4,
            A: s.A != null ? s.A : (sh - (s.gapW || 3.4) / 2),
            omega: (s.omega || 0.030) * rng.range(0.9, 1.1),
            phase: rng.range(0, TAU) + i * 1.7,
          });
        }
        break;
      }
      default:
        throw new Error('unknown segment type: ' + s.t);
    }
    z = z1;
  }

  // finish stretch + finish gate
  course.checkpoints.push({ z: z, x: 0 });
  const fz = z + 6;
  course.platforms.push({ x0: -half, x1: half, z0: z, z1: fz + 4, y: 0, finish: true });
  course.finishZ = fz;
  course.length = fz;
  return course;
}

function PI_HALF_OFFSET(s) { return s.stagger ? 1.5707963 : 0; }

// ---------------------------------------------------------------------------
// Kinematic queries — pure functions of tick
// ---------------------------------------------------------------------------

export function moverTransform(m, tick) {
  const off = m.A * dsin(m.omega * tick + m.phase);
  const vel = m.A * m.omega * dcos(m.omega * tick + m.phase); // units per tick
  const x = m.axis === 'x' ? m.cx + off : m.cx;
  const z = m.axis === 'z' ? m.cz + off : m.cz;
  return {
    x, z,
    vx: m.axis === 'x' ? vel : 0,
    vz: m.axis === 'z' ? vel : 0,
    x0: x - m.w / 2, x1: x + m.w / 2, z0: z - m.d / 2, z1: z + m.d / 2, y: m.y,
  };
}

export function spinnerOmega(ob, tick) {
  if (!ob.accel) return ob.omega;
  const w = ob.omega + ob.accel * tick;
  if (ob.omegaMax > 0) return Math.min(w, ob.omegaMax);
  return Math.max(w, ob.omegaMax); // omegaMax negative
}

// Ground query: highest platform top under (x,z) at tick. Returns
// { y, mover|null, belt } or null when over a void.
export function groundAt(course, x, z, tick) {
  let best = null;
  for (const p of course.platforms) {
    if (p.disc) {
      if (dist2(x, z, course.arena.cx, course.arena.cz) > p.r * p.r) continue;
    } else if (x < p.x0 || x > p.x1 || z < p.z0 || z > p.z1) continue;
    if (!best || p.y > best.y) best = { y: p.y, mover: null, belt: !!p.belt, finish: !!p.finish };
  }
  for (const m of course.movers) {
    const t = moverTransform(m, tick);
    if (x >= t.x0 && x <= t.x1 && z >= t.z0 && z <= t.z1) {
      if (!best || t.y > best.y) best = { y: t.y, mover: t, belt: false, finish: false };
    }
  }
  return best;
}

export function zoneAt(course, kind, x, z) {
  for (const zn of course.zones) {
    if (zn.kind !== kind) continue;
    if (zn.kind === 'bounce') {
      if (dist2(x, z, zn.x, zn.z) <= zn.r * zn.r) return zn;
    } else if (x >= zn.x0 && x <= zn.x1 && z >= zn.z0 && z <= zn.z1) return zn;
  }
  return null;
}

// Hazard collision: returns an impulse {ix,iy,iz, stun} or null.
// px,py,pz is the player's center (capsule mid), pr the player radius.
export function hazardHit(course, ob, tick, px, py, pz, pr) {
  switch (ob.kind) {
    case 'spinner': {
      const w = spinnerOmega(ob, tick);
      const th = ob.phase + w * tick;
      for (let k = 0; k < ob.arms; k++) {
        const a = th + (k * TAU) / ob.arms;
        const bx = ob.cx + dcos(a) * ob.L, bz = ob.cz + dsin(a) * ob.L;
        const q = pointSegXZ(px, pz, ob.cx, ob.cz, bx, bz);
        if (q.d < pr + ob.barR && Math.abs(py - ob.h) < (ob.hitH || 1.25)) {
          // bar surface velocity at contact: omega x r  -> (-sin a, cos a) * w * r
          const dir = w >= 0 ? 1 : -1;
          const speed = Math.abs(w) * Math.max(1.6, q.t * ob.L);
          let ix = -dsin(a) * speed * dir * 2.4;
          let iz = dcos(a) * speed * dir * 2.4;
          // always push the player away from the bar a little
          const away = q.d > 1e-4 ? (pr + ob.barR - q.d) : 0.3;
          ix += ((px - q.cx) / Math.max(q.d, 1e-4)) * away * 3;
          iz += ((pz - q.cz) / Math.max(q.d, 1e-4)) * away * 3;
          return { ix: clamp(ix, -11, 11), iy: 6.2, iz: clamp(iz, -11, 11), stun: 0.6 };
        }
      }
      return null;
    }
    case 'pendulum': {
      const th = ob.A * dsin(ob.omega * tick + ob.phase);
      const thv = ob.A * ob.omega * dcos(ob.omega * tick + ob.phase); // rad/tick
      let bx = ob.px, bz = ob.pz, bvx = 0, bvz = 0;
      const by = ob.py - ob.L * dcos(th);
      if (ob.plane === 'x') {
        bx += ob.L * dsin(th); bvx = ob.L * dcos(th) * thv;
      } else {
        bz += ob.L * dsin(th); bvz = ob.L * dcos(th) * thv;
      }
      const dx = px - bx, dy = (py + 0.4) - by, dz = pz - bz;
      const d2 = dx * dx + dy * dy + dz * dz, rr = ob.bobR + pr;
      if (d2 < rr * rr) {
        const d = Math.max(Math.sqrt(d2), 1e-4);
        const k = 7.5 / d;
        return {
          ix: clamp(dx * k + bvx * 30, -12, 12),
          iy: 6.8,
          iz: clamp(dz * k + bvz * 30, -12, 12),
          stun: 0.7,
        };
      }
      return null;
    }
    case 'piston': {
      const bx = ob.baseX + ob.A * dsin(ob.omega * tick + ob.phase);
      const bvx = ob.A * ob.omega * dcos(ob.omega * tick + ob.phase);
      if (pz < ob.z0 - pr || pz > ob.z1 + pr) return null;
      if (Math.abs(px - bx) > pr + 1.0) return null;
      if (py > ob.h) return null;
      const pushDir = px >= bx ? 1 : -1;
      return {
        ix: clamp(pushDir * (4.5 + Math.abs(bvx) * 26), -8.5, 8.5),
        iy: 3.6, iz: 0, stun: 0.35,
      };
    }
    case 'bumper': {
      const d2v = dist2(px, pz, ob.x, ob.z);
      const rr = ob.r + pr;
      if (d2v < rr * rr && py < ob.h) {
        const d = Math.max(Math.sqrt(d2v), 1e-4);
        return {
          ix: ((px - ob.x) / d) * ob.power, iy: 4.2,
          iz: ((pz - ob.z) / d) * ob.power, stun: 0.18,
        };
      }
      return null;
    }
    case 'weave': {
      const gx = ob.A * dsin(ob.omega * tick + ob.phase);
      if (Math.abs(pz - ob.wz) > 0.55 + pr) return null;
      if (py > ob.h) return null;
      if (Math.abs(px - gx) < ob.gapW / 2 - pr * 0.4) return null; // in the gap
      const dir = pz > ob.wz ? 1 : -1;
      return { ix: 0, iy: 2.5, iz: dir * 6.5, stun: 0.3 };
    }
    default:
      return null;
  }
}

// Checkpoint spawn for index i (0 = start).
export function spawnAt(course, cpIndex) {
  if (cpIndex <= 0) return { x: course.spawn.x, y: course.spawn.y, z: course.spawn.z };
  const cp = course.checkpoints[Math.min(cpIndex - 1, course.checkpoints.length - 1)];
  return { x: cp.x, y: 0, z: cp.z + 1.5 };
}
