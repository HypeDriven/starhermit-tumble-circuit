// Bot brains. Bots think inside the simulation as a pure function of state,
// so replays only need human commands. Skill/aggression personas are seeded
// at state creation.

import { clamp, dsin, dcos, TAU, dist2, pointSegXZ } from './dmath.js';
import { groundAt, moverTransform, spinnerOmega } from './course.js';
import { PSTATE, PHYS } from './sim.js';

export function botThink(state, p) {
  const per = p.persona || { skill: 0.6, aggr: 0.6, lane: 0, wob: 0, orbit: 1 };
  const out = { mx: 0, mz: 0, jump: false, dive: false };
  if (p.st === PSTATE.RESPAWN) return out;
  if (p.stunT > 0) return out;
  const course = state.course;

  if (state.kind === 'survival') survivalThink(state, p, per, out);
  else raceThink(state, p, per, out);
  return out;
}

function raceThink(state, p, per, out) {
  const course = state.course;
  const tick = state.tick;
  const half = course.width / 2;
  const skill = per.skill;

  // base lane target with gentle deterministic wander
  let targetX = per.lane * (half - 1.6) + dsin(tick * 0.011 + per.wob) * 0.9;
  let speedMul = 0.82 + per.aggr * 0.18;

  // ---- hazard avoidance (nearest threat of each kind dominates)
  let weaveHandled = -1; // dz of nearest weave wall already handled
  let dodgeX = null;     // piston/bumper sidestep beats any travel plan
  for (const ob of course.obstacles) {
    const oz = ob.cz != null ? ob.cz : (ob.pz != null ? ob.pz : (ob.wz != null ? ob.wz : (ob.z != null ? ob.z : (ob.z0 + ob.z1) / 2)));
    const dz = oz - p.z;
    if (dz < -3 || dz > 12) continue;

    if (ob.kind === 'spinner') {
      // will a bar be near our crossing point when we arrive at full pace?
      const w = spinnerOmega(ob, tick);
      const reach = Math.hypot(p.x - ob.cx, 0);
      if (dz > 0 && dz < 5 && reach < ob.L + 0.6) {
        const eta = dz / 8.2; // ticks to arrive at full pace
        let danger = false;
        for (let k = 0; k < ob.arms && !danger; k++) {
          for (const dtOff of [-6, 0, 6]) {
            const a = ob.phase + w * (tick + eta + dtOff) + (k * TAU) / ob.arms;
            const bx = ob.cx + dcos(a) * ob.L, bz = ob.cz + dsin(a) * ob.L;
            // distance from our crossing point to the bar at arrival
            const q = pointSegXZ(p.x, ob.cz, ob.cx, ob.cz, bx, bz);
            if (q.d < 1.7 && q.t * ob.L > 0.8) { danger = true; break; }
          }
        }
        if (danger) {
          // hold short and let the bar pass; the clear window comes around
          speedMul = Math.min(speedMul, dz > 1.2 ? 0.12 : 0.0);
        } else {
          // clear window — dash through at full pace
          speedMul = Math.max(speedMul, 1.0);
        }
      }
    } else if (ob.kind === 'pendulum') {
      if (dz > -0.5 && dz < 2.6) {
        const th = ob.A * dsin(ob.omega * tick + ob.phase);
        const bobX = ob.plane === 'x' ? ob.px + ob.L * dsin(th) : ob.px;
        const bobZ = ob.plane === 'z' ? ob.pz + ob.L * dsin(th) : ob.pz;
        const d = Math.hypot(p.x - bobX, p.z - bobZ);
        if (d < 2.6 && skill > 0.35) speedMul = Math.min(speedMul, 0.25 + skill * 0.3);
      }
    } else if (ob.kind === 'piston') {
      const ozm = (ob.z0 + ob.z1) / 2;
      if (ozm - p.z > -0.5 && ozm - p.z < 3.5) {
        const bx = ob.baseX + ob.A * dsin(ob.omega * tick + ob.phase);
        const bvx = ob.A * ob.omega * dcos(ob.omega * tick + ob.phase);
        // follow through behind the sweeping block
        targetX = clamp(bx - (bvx >= 0 ? 1 : -1) * 2.8, -(half - 1), half - 1);
        dodgeX = targetX;
        if (Math.abs(p.x - bx) < 1.9 && skill > 0.4) speedMul = Math.min(speedMul, 0.55);
      }
    } else if (ob.kind === 'weave') {
      if (dz > -1 && dz < 8 && (weaveHandled < 0 || dz < weaveHandled)) {
        weaveHandled = dz; // only the nearest wall drives steering
        if (dz < 2.0) {
          // at the wall: track the gap's current position, dash when aligned
          const gNow = ob.A * dsin(ob.omega * tick + ob.phase);
          targetX = clamp(gNow, -(half - 1), half - 1);
          if (Math.abs(p.x - gNow) < ob.gapW / 2 - 0.7) speedMul = Math.max(speedMul, 1.0);
          else speedMul = Math.min(speedMul, 0.1);
        } else {
          // approach: aim where the gap will be when we arrive (capped lead)
          const eta = Math.min(35, Math.max(0, dz) / Math.max(2.5, p.vz));
          const gx = ob.A * dsin(ob.omega * (tick + eta) + ob.phase);
          targetX = clamp(gx, -(half - 1), half - 1);
        }
      }
    } else if (ob.kind === 'bumper') {
      if (dz > -1 && dz < 4) {
        const d = Math.hypot(p.x - ob.x, dz);
        if (d < ob.r + 1.3) { targetX = p.x + (p.x >= ob.x ? 1.8 : -1.8); dodgeX = targetX; }
      }
    }
  }
  targetX = clamp(targetX, -(half - 0.9), half - 0.9);

  // ---- ground / gap handling
  const lookAhead = 1.9 + skill * 1.1 + Math.max(0, p.vz - 6) * 0.12;
  const desperate = p.falls >= 3; // deterministic escalation after repeated failures
  if (p.grounded) {
    const near = groundAt(course, p.x, p.z + 0.9, tick);
    const probe = groundAt(course, p.x, p.z + lookAhead, tick);
    if (near && near.mover) {
      // riding a moving platform: hold near its front edge, then jump toward
      // the nearest landing surface ahead (static or another platform),
      // evaluated at the moment we would land
      const mv = near.mover;
      const frontDist = mv.z1 - p.z;
      let landD = null;
      for (let d = 0.6; d <= 8.6; d += 0.4) {
        const gq = groundAt(course, mv.x, mv.z1 + d, tick + 40);
        if (gq) { landD = d; break; }
      }
      const receding = mv.vz < -0.005;
      if (frontDist < 1.5 && !receding && landD != null && landD <= 7.8) {
        out.jump = true;
        targetX = mv.x;
      } else {
        // hold aboard: drift toward front-center; ride z-oscillators forward
        // while they advance, hold while they recede
        speedMul = frontDist > 2.2 ? 0.6 : 0.12;
        targetX = mv.x;
        if (mv.vz > 0.005) speedMul = Math.max(speedMul, 0.5);
        if (receding) speedMul = frontDist < 1.2 ? -0.6 : 0.05; // retreat with the edge
        if (mv.z1 < p.z - 0.2) speedMul = -0.6; // past the back edge: re-center
        if ((landD == null || landD > 7.8) && frontDist < 1.6 && !receding) speedMul = 0.05;
      }
    } else if (!near || !probe) {
      // at or near a lip with void within lookahead — plan the crossing.
      // find the lip: first void within the next few meters
      let lipZ = p.z + 0.9;
      for (let d = 0.9; d <= 3.6; d += 0.3) {
        if (!groundAt(course, p.x, p.z + d, tick)) { lipZ = p.z + d; break; }
      }
      // static far side in plain jump range?
      let beyondStatic = false;
      for (const d of [lookAhead + 2.2, lookAhead + 3.6, lookAhead + 5.0]) {
        const g = groundAt(course, p.x, p.z + d, tick);
        if (g && !g.mover) { beyondStatic = true; break; }
      }
      // forward-search a boarding window on any mover: jump at tick+dt so the
      // platform is under the expected landing point at landing time
      const carry = clamp(3.2 + Math.max(0, p.vz) * 0.36, 4.0, 6.2);
      const landZ = lipZ - 0.5 + carry;
      let plan = null, firstMoverX = null;
      for (const m of course.movers) {
        if (firstMoverX == null) firstMoverX = m.cx != null ? m.cx : 0;
        // only consider movers whose z-band overlaps the void ahead
        const tNow = moverTransform(m, tick);
        if (tNow.z1 < p.z - 1 || tNow.z0 > p.z + 12) continue;
        for (let dt = 0; dt <= 240; dt += 3) {
          const tL = moverTransform(m, tick + dt + 38);
          if (tL.z0 > landZ + 0.8 || tL.z1 < landZ - 0.8) continue;
          if (m.axis === 'z' && tL.vz < -0.02) continue; // receding at landing
          if (Math.abs(tL.x - p.x) > m.w / 2 + 2.4) continue; // steerable in air
          plan = { dt, x: tL.x };
          break;
        }
        if (plan) break;
      }
      const lipNear = !near || !groundAt(course, p.x, p.z + 1.6, tick);
      if (!lipNear) {
        // close the last meters to the lip at pace, aligned for the crossing
        speedMul = 0.95;
        if (plan) targetX = clamp(plan.x, -(half - 0.9), half - 0.9);
        else if (firstMoverX != null && !beyondStatic) targetX = clamp(firstMoverX, -(half - 1.2), half - 1.2);
      } else if (beyondStatic) out.jump = true;
      else if (plan) {
        targetX = clamp(plan.x, -(half - 0.9), half - 0.9);
        if (plan.dt <= 5) out.jump = true;
        else speedMul = 0.05; // hold at the lip for the boarding window
      } else {
        const far = groundAt(course, p.x, p.z + lookAhead + 6.5, tick);
        if (far && !far.mover && (skill > 0.55 || desperate)) { out.jump = true; out.dive = true; }
        else if (firstMoverX != null) {
          speedMul = 0.05;
          targetX = clamp(firstMoverX, -(half - 1.2), half - 1.2);
        } else speedMul = near ? 0.2 : 0; // creep to the lip, then hold
      }
    } else if (near && probe && probe.mover) {
      speedMul = Math.max(speedMul, 0.7); // board the platform
    }
  } else if (!p.grounded) { // AIR, DIVE and airborne RECOVER all steer
    // mid-air: if over a void, steer toward any moving platform we can land on
    const below = groundAt(course, p.x, p.z, tick);
    if (!below) {
      let best = null;
      // estimate ticks until landing (SI seconds converted to ticks) so we
      // steer to where a platform WILL be
      const tSec = (p.vy + Math.sqrt(Math.max(0, p.vy * p.vy + 60 * Math.max(0, p.y)))) / 30;
      const tLand = Math.max(0, Math.min(70, tSec * 60));
      for (const m of course.movers) {
        const t = moverTransform(m, tick + Math.round(tLand));
        if (t.z1 > p.z - 0.5 && t.z0 < p.z + 7) { best = t; break; }
      }
      if (best) targetX = clamp(best.x, -(half - 0.9), half - 0.9);
      if (per.aggr > 0.45 && p.diveCd <= 0 && p.vy < 1.5) {
        // dive only if the current trajectory falls short AND a landing
        // surface (static or platform) lies within dive reach beyond it
        const zLand = p.z + Math.max(2, p.vz) * tSec;
        const reachAnyway = groundAt(course, p.x, zLand, tick + Math.round(tLand)) ||
          groundAt(course, p.x, zLand - 1.2, tick + Math.round(tLand));
        if (!reachAnyway) {
          const tProbe = tick + Math.round(tLand * 0.6);
          for (const d of [3.5, 4.5, 5.5, 7.0]) {
            if (groundAt(course, p.x, p.z + d, tProbe)) { out.dive = true; break; }
          }
        }
      }
    }
    out.mx = clamp((targetX - p.x) * 0.9, -1, 1);
    out.mz = clamp(Math.max(speedMul, 0.75), -1, 1);
    return;
  }

  // finish-line lunge
  if (course.kind === 'race' && course.finishZ - p.z < 3.5 && course.finishZ - p.z > 1 &&
      p.grounded && per.aggr > 0.7 && p.diveCd <= 0) {
    out.dive = true;
  }

  // a live sidestep from a piston/bumper beats any travel plan while grounded
  if (dodgeX != null && p.grounded) targetX = clamp(dodgeX, -(half - 0.9), half - 0.9);

  out.mx = clamp((targetX - p.x) * 0.9, -1, 1);
  out.mz = clamp(speedMul, -1, 1);
}

function survivalThink(state, p, per, out) {
  const course = state.course;
  const tick = state.tick;
  const ar = course.arena;
  const ang = Math.atan2(p.z - ar.cz, p.x - ar.cx);

  // orbit the arena at a comfortable radius
  const rad = ar.r * (0.52 + 0.22 * dsin(tick * 0.004 + per.wob));
  const targetAng = ang + 0.5 * per.orbit;
  const tx = ar.cx + dcos(targetAng) * rad;
  const tz = ar.cz + dsin(targetAng) * rad;

  // bar threat: jump when a low bar is about to reach us
  let dodging = false;
  for (const ob of course.obstacles) {
    if (ob.kind !== 'spinner') continue;
    const w = spinnerOmega(ob, tick);
    for (let k = 0; k < ob.arms; k++) {
      const a = ob.phase + w * tick + (k * TAU) / ob.arms;
      // wrapped angular distance from bar to player, in bar's travel direction
      let rel = (ang - a) % TAU;
      if (rel < 0) rel += TAU;
      if (w < 0) rel = TAU - rel;
      const tta = rel / Math.max(Math.abs(w), 1e-5); // ticks until bar reaches us
      const radial = Math.hypot(p.x - ob.cx, p.z - ob.cz);
      if (ob.h > 1.5) continue; // overhead bar handled by the veto below
      if (tta < 14 + per.skill * 10 && radial < ob.L + 0.5 && p.grounded) {
        out.jump = true;
      }
      // drift away if the bar is very close laterally
      if (tta < 30 && radial < ob.L + 0.3) {
        const dodge = ang + per.orbit * 0.9;
        out.mx = clamp((ar.cx + dcos(dodge) * rad - p.x) * 0.9, -1, 1);
        out.mz = clamp((ar.cz + dsin(dodge) * rad - p.z) * 0.9, -1, 1);
        dodging = true;
      }
    }
  }
  if (!dodging) {
    out.mx = clamp((tx - p.x) * 0.9, -1, 1);
    out.mz = clamp((tz - p.z) * 0.9, -1, 1);
  }

  // final veto: never jump while an overhead (high) bar is near our angle
  if (out.jump) {
    for (const ob of course.obstacles) {
      if (ob.kind !== 'spinner' || ob.h <= 1.5) continue;
      const w = spinnerOmega(ob, tick);
      for (let k = 0; k < ob.arms; k++) {
        const a = ob.phase + w * tick + (k * TAU) / ob.arms;
        let hd = Math.abs(((ang - a) % TAU + TAU) % TAU);
        if (hd > TAU / 2) hd = TAU - hd;
        if (hd < 0.45) { out.jump = false; break; }
      }
    }
  }
}
