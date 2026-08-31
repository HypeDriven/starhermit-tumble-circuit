// Offline content validators. Prove basic legality, reachable goals,
// bounded duration and absence of soft locks by actually simulating a
// competent bot through every race course. Run by `npm test` and during
// development; content that fails cannot ship.

import { createState, step, PSTATE, TICK_RATE } from '../rules/sim.js';
import { buildCourse, CHECKPOINT_SPACING } from '../rules/course.js';
import { JOURNEY, LESSONS, ARENAS, SHOW_COURSES, SHOWS, CHALLENGES, challengeCourse, courseById } from './stages.js';
import { dailyDef, dailyDateString } from './daily.js';

export function validateStructure(def) {
  const errors = [];
  const warn = [];
  if (!def.id) errors.push('missing id');
  if (def.version == null) errors.push(`${def.id}: missing version`);
  if (def.seed == null) errors.push(`${def.id}: missing seed`);
  if (!def.theme) errors.push(`${def.id}: missing theme`);
  if (def.kind === 'survival') {
    if (!def.arena || !def.arena.r) errors.push(`${def.id}: survival without arena`);
    return { errors, warn };
  }
  if (!Array.isArray(def.segments) || def.segments.length === 0) {
    errors.push(`${def.id}: no segments`);
    return { errors, warn };
  }
  let len = 0;
  let prevT = null;
  for (const s of def.segments) {
    if (!s.t) { errors.push(`${def.id}: segment missing type`); continue; }
    if (!(s.len > 0) || s.len > 40) errors.push(`${def.id}: bad segment length ${s.len} (${s.t})`);
    if (s.t === 'gap' && (s.gap || 0) > 6.2) errors.push(`${def.id}: unjumpable gap ${s.gap}`);
    if (s.t === 'gaps') for (const [, w] of (s.gaps || [])) if (w > 6.2) errors.push(`${def.id}: unjumpable gap ${w}`);
    if (s.t === 'mover' && prevT === 'mover') warn.push(`${def.id}: adjacent movers (verify solvable)`);
    prevT = s.t;
    len += s.len;
  }
  if (len < 20) warn.push(`${def.id}: very short (${len}u)`);
  if (def.par == null || def.timeLimit == null) errors.push(`${def.id}: missing par/timeLimit`);
  else if (def.timeLimit < def.par) errors.push(`${def.id}: timeLimit < par`);
  // checkpoint spacing
  const course = buildCourse(def);
  let prev = 0;
  for (const cp of course.checkpoints) {
    if (cp.z - prev > CHECKPOINT_SPACING * 1.6) warn.push(`${def.id}: sparse checkpoints at z=${cp.z.toFixed(0)}`);
    prev = cp.z;
  }
  if (!course.finishZ) errors.push(`${def.id}: no finish`);
  return { errors, warn };
}

// Simulate one competent bot; the course must be finishable within the time
// limit with no NaN physics and no soft lock.
export function validateSolvable(def, maxTicks = null) {
  const errors = [];
  const limit = maxTicks || Math.min(def.timeLimit + 600, TICK_RATE * 60 * 6);
  let finished = false;
  let lastProgress = -1;
  let stallTicks = 0;
  let softLocked = false;

  for (const attemptSeed of [1, 2]) {
    const state = createState(def, [{ id: 'probe', name: 'Probe', color: 0, isBot: true }],
      { quota: 1, botSkill: 1.0, seedOverride: (def.seed + attemptSeed) >>> 0 });
    finished = false; lastProgress = -1; stallTicks = 0; softLocked = false;
    while (state.phase === 'active' && state.tick < limit) {
      step(state);
      const p = state.players[0];
      for (const v of [p.x, p.y, p.z, p.vx, p.vy, p.vz]) {
        if (!Number.isFinite(v)) { errors.push(`${def.id}: NaN physics at tick ${state.tick}`); return { errors, finished, softLocked }; }
      }
      if (p.progress > lastProgress + 0.5) { lastProgress = p.progress; stallTicks = 0; }
      else if (++stallTicks > TICK_RATE * 45) { softLocked = true; break; }
      if (p.st === PSTATE.FINISH) { finished = true; }
    }
    if (finished) break;
  }
  if (!finished) errors.push(`${def.id}: probe bot could not finish within limit`);
  if (softLocked) errors.push(`${def.id}: probe bot stalled (possible soft lock)`);
  return { errors, finished, softLocked };
}

export function validateShows() {
  const errors = [];
  for (const show of SHOWS) {
    if (!show.rounds.length) { errors.push(`${show.id}: no rounds`); continue; }
    let prevQuota = Infinity;
    show.rounds.forEach((r, i) => {
      if (!courseById(r.courseId)) errors.push(`${show.id}: round ${i} unknown course ${r.courseId}`);
      if (r.quota > prevQuota) errors.push(`${show.id}: quota increases at round ${i}`);
      prevQuota = r.quota;
      if (i < show.rounds.length - 1 && r.quota < 2) errors.push(`${show.id}: non-final round ${i} quota ${r.quota} too small`);
    });
    const last = show.rounds[show.rounds.length - 1];
    if (last.quota !== 1) errors.push(`${show.id}: final quota must be 1`);
    if (show.players < 2 || show.players > 32) errors.push(`${show.id}: bad player count`);
  }
  return errors;
}

export function validateChallenges() {
  const errors = [];
  for (const ch of CHALLENGES) {
    if (!courseById(ch.base)) { errors.push(`${ch.id}: unknown base ${ch.base}`); continue; }
    try { challengeCourse(ch); } catch (e) { errors.push(`${ch.id}: ${e.message}`); }
  }
  return errors;
}

// Full sweep. Returns { ok, errors, warnings, stats }.
export function validateAll({ withDailyDates = null, solvable = true } = {}) {
  const errors = [], warnings = [];
  const seen = new Set();
  const push = (r) => { errors.push(...r.errors); warnings.push(...(r.warn || [])); };

  const raceCourses = [...JOURNEY, ...SHOW_COURSES];
  for (const def of raceCourses) {
    if (seen.has(def.id)) { errors.push('duplicate id: ' + def.id); continue; }
    seen.add(def.id);
    push(validateStructure(def));
  }
  for (const l of LESSONS) {
    if (seen.has(l.id)) { errors.push('duplicate id: ' + l.id); continue; }
    seen.add(l.id);
    push(validateStructure(l));
    if (!l.steps || !l.steps.length) errors.push(`${l.id}: lesson has no steps`);
  }
  for (const a of ARENAS) push(validateStructure(a));
  errors.push(...validateShows());
  errors.push(...validateChallenges());

  const dailyDates = withDailyDates || [dailyDateString()];
  const dailies = dailyDates.map(dailyDef);
  for (const d of dailies) push(validateStructure(d));

  if (solvable) {
    for (const def of [...raceCourses, ...dailies, ...CHALLENGES.filter(c => c.goal.kind !== 'win').map(challengeCourse)]) {
      const r = validateSolvable(def);
      errors.push(...r.errors);
    }
  }

  return { ok: errors.length === 0, errors, warnings, stats: { courses: seen.size, dailies: dailies.length } };
}
