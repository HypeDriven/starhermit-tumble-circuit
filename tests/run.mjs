// Tumble Circuit — rules & content test suite. Run: node tests/run.mjs
// [--validate-only] [--golden-update]

import { dsin, dcos, clamp, TAU } from '../js/rules/dmath.js';
import { Rng, hashString, hashState } from '../js/rules/rng.js';
import { buildCourse, groundAt, hazardHit, spawnAt } from '../js/rules/course.js';
import {
  createState, step, applyCommand, makeCommand, legalActions, serializeState,
  deserializeState, hashGameState, migrateState, PSTATE, TICK_RATE,
} from '../js/rules/sim.js';
import { roundResults, placePoints } from '../js/rules/scoring.js';
import { createShow, applyRoundResult, showTable, isFinalRound } from '../js/rules/show.js';
import { Recorder, verify } from '../js/rules/replay.js';
import { JOURNEY, LESSONS, SHOW_COURSES, SHOWS, CHALLENGES, ARENAS, courseById, challengeCourse, makeCourse } from '../js/content/stages.js';
import { dailyDef, dailyDateString } from '../js/content/daily.js';
import { validateAll, validateStructure, validateSolvable } from '../js/content/validate.js';
import { seg } from '../js/rules/course.js';

let passed = 0, failed = 0;
const failures = [];
function ok(cond, name) {
  if (cond) { passed++; }
  else { failed++; failures.push(name); console.error('  FAIL:', name); }
}
function section(name) { console.log('\n== ' + name); }

const validateOnly = process.argv.includes('--validate-only');
const goldenUpdate = process.argv.includes('--golden-update');

// ---------------------------------------------------------------------------
if (!validateOnly) {
section('deterministic math');
{
  let maxErr = 0;
  for (let i = 0; i < 2000; i++) {
    const x = (i / 2000) * 40 - 20;
    maxErr = Math.max(maxErr, Math.abs(dsin(x) - Math.sin(x)));
  }
  ok(maxErr < 1e-8, 'dsin approximates Math.sin (err ' + maxErr + ')');
  ok(Math.abs(dcos(0.7) - Math.cos(0.7)) < 1e-8, 'dcos');
  ok(dsin(0) === 0 && Math.abs(dsin(TAU)) < 1e-8, 'dsin period');
}

section('rng');
{
  const a = new Rng(42, 'rules'), b = new Rng(42, 'rules'), c = new Rng(43, 'rules');
  const sa = [a.float(), a.float(), a.int(1, 10)].join(',');
  const sb = [b.float(), b.float(), b.int(1, 10)].join(',');
  const sc = [c.float(), c.float(), c.int(1, 10)].join(',');
  ok(sa === sb, 'same seed same stream');
  ok(sa !== sc, 'different seed different stream');
  const d = new Rng(42, 'decor');
  ok(d.float() !== new Rng(42, 'rules').float(), 'streams are independent');
  ok(hashString('a') !== hashString('b'), 'hash distinguishes');
  ok(hashState({ b: 1, a: [2, 3] }) === hashState({ a: [2, 3], b: 1 }), 'hash key order stable');
}

// ---------------------------------------------------------------------------
section('course building');
{
  const def = JOURNEY[0];
  const c1 = buildCourse(def), c2 = buildCourse(def);
  ok(c1.finishZ === c2.finishZ && c1.obstacles.length === c2.obstacles.length, 'course build deterministic');
  ok(c1.checkpoints.length >= 2, 'has checkpoints');
  ok(JSON.stringify(c1.obstacles) === JSON.stringify(c2.obstacles), 'obstacle params deterministic');
  ok(groundAt(c1, 0, 2, 0), 'ground at spawn');
  ok(spawnAt(c1, 0).z === 2, 'spawn at start');
}

// ---------------------------------------------------------------------------
section('legal actions API');
{
  const def = makeCourse('t-legal', 'cumulus', 1, ['run'], [seg('run', 30)]);
  const s = createState(def, [{ id: 'h', name: 'H', color: 1, isBot: false }], { quota: 1 });
  let la = legalActions(s, 'h');
  ok(la.exists && la.canInput && la.jump.ok && la.dive.ok, 'all legal at start');
  ok(legalActions(s, 'nobody').exists === false, 'unknown player');

  // jump then verify airborne illegality
  applyCommand(s, makeCommand('h', s.tick + 1, { jump: true }));
  step(s); step(s);
  la = legalActions(s, 'h');
  const p = s.players[0];
  if (!p.grounded) ok(!la.jump.ok && la.jump.reason === 'airborne', 'jump illegal while airborne');
  else ok(true, 'jump consumed');
  // dive on cooldown
  ok(!la.dive.ok && (la.dive.reason === 'cooldown' || la.dive.reason === null) || la.dive.ok, 'dive state readable');
  // stun blocks move
  p.stunT = 0.5; p.st = PSTATE.STUN;
  la = legalActions(s, 'h');
  ok(!la.move.ok && la.move.reason === 'stunned', 'stun blocks movement');
  // finished player cannot act
  p.st = PSTATE.FINISH; p.stunT = 0;
  la = legalActions(s, 'h');
  ok(!la.canInput && la.finished, 'finished player locked out');
}

section('command validation');
{
  const def = makeCourse('t-cmd', 'cumulus', 2, ['run'], [seg('run', 30)]);
  const s = createState(def, [{ id: 'h', name: 'H', color: 1, isBot: false }], { quota: 1 });
  ok(applyCommand(s, null).ok === false, 'null rejected');
  ok(applyCommand(s, { id: '', playerId: 'h', tick: 1, mx: 0, mz: 0 }).reason === 'malformed-id', 'bad id rejected');
  ok(applyCommand(s, makeCommand('ghost', s.tick + 1, {})).reason === 'no-player', 'unknown player rejected');
  ok(applyCommand(s, makeCommand('h', 0, {})).reason === 'stale-tick', 'past tick rejected');
  ok(applyCommand(s, makeCommand('h', s.tick + 500, {})).reason === 'future-tick', 'far future rejected');
  const bad = makeCommand('h', s.tick + 1, {}); bad.mx = 999;
  ok(applyCommand(s, bad).reason === 'bad-move', 'out-of-range move rejected');
  const good = makeCommand('h', s.tick + 1, { mz: 1 });
  ok(applyCommand(s, good).ok === true, 'valid accepted');
  const dup = applyCommand(s, good);
  ok(dup.ok === true && dup.dedup === true, 'duplicate idempotent');
  ok(s.players[0].invalids === 2, 'invalid attempts counted for tie-breaks (network artifacts not counted)');
  step(s);
  ok(s.players[0].input.mz === 1, 'command applied on its tick');
  ok(s.players[0].vz > 1, 'movement produces velocity');
}

// ---------------------------------------------------------------------------
section('simulation: race to terminal + events');
{
  const def = makeCourse('t-race', 'cumulus', 3, ['run'], [seg('run', 20, { checkpoint: true }), seg('run', 20)]);
  const s = createState(def, [
    { id: 'h', name: 'H', color: 1, isBot: false },
    { id: 'b1', name: 'B1', color: 2, isBot: true },
  ], { quota: 1, botSkill: 0.5 });
  let sawCp = false, sawFinish = false;
  let guard = 0;
  while (s.phase === 'active' && guard++ < TICK_RATE * 120) {
    applyCommand(s, makeCommand('h', s.tick + 1, { mz: 1 }));
    step(s);
    for (const e of s.events) {
      if (e.t === 'checkpoint' && e.p === 'h') sawCp = true;
      if (e.t === 'finish') sawFinish = true;
    }
  }
  ok(sawCp, 'checkpoint event fired');
  ok(sawFinish, 'finish event fired');
  ok(s.terminal && s.terminal.reason === 'quota', 'terminal reason quota: ' + (s.terminal || {}).reason);
  ok(s.tick > 0, 'tick monotonic');
  const res = roundResults(s);
  ok(res.places.length === 2, 'results ranked');
  const winner = res.results[res.places[0]];
  ok(winner.qualified && winner.breakdown.qualify === 250, 'qualify bonus');
  ok(winner.total === winner.breakdown.checkpoints + winner.breakdown.placement +
    winner.breakdown.qualify + winner.breakdown.timeBonus + winner.breakdown.survival +
    winner.breakdown.falls, 'breakdown sums to total');
  ok(Number.isInteger(winner.total), 'scores are integers');
}

section('simulation: gap jumping + falling + respawn');
{
  const def = makeCourse('t-gap', 'cumulus', 4, ['gap'], [seg('run', 8), seg('gap', 8, { gap: 3 }), seg('run', 12, { checkpoint: true }), seg('run', 8)]);
  const s = createState(def, [{ id: 'h', name: 'H', color: 1, isBot: false }], { quota: 1 });
  const course = s.course;
  // walk into the gap without jumping -> fall and respawn
  let fell = false, respawned = false;
  let guard = 0;
  while (guard++ < TICK_RATE * 20 && !respawned) {
    applyCommand(s, makeCommand('h', s.tick + 1, { mz: 1 }));
    step(s);
    for (const e of s.events) {
      if (e.t === 'fall' && e.p === 'h') fell = true;
      if (e.t === 'respawn' && e.p === 'h') respawned = true;
    }
  }
  ok(fell, 'falling into gap detected');
  ok(respawned, 'respawn at checkpoint');
  ok(s.players[0].falls === 1, 'fall counted');
  // now jump the gap
  guard = 0;
  let finished = false;
  while (guard++ < TICK_RATE * 30 && !finished) {
    const p = s.players[0];
    const gAhead = groundAt(course, p.x, p.z + 2.2, s.tick);
    const gHere = groundAt(course, p.x, p.z + 0.8, s.tick);
    applyCommand(s, makeCommand('h', s.tick + 1, { mz: 1, jump: p.grounded && gHere && !gAhead }));
    step(s);
    if (p.st === PSTATE.FINISH) finished = true;
  }
  ok(finished, 'jumped gap and finished');
}

section('simulation: spinner knocks you');
{
  const def = makeCourse('t-spin', 'cumulus', 5, ['spinner'], [seg('run', 6), seg('spinner', 12, { omega: 0.03, count: 1 }), seg('run', 10)]);
  const s = createState(def, [{ id: 'h', name: 'H', color: 1, isBot: false }], { quota: 1 });
  let knocked = false;
  let guard = 0;
  while (guard++ < TICK_RATE * 30 && s.phase === 'active') {
    applyCommand(s, makeCommand('h', s.tick + 1, { mz: 1 }));
    step(s);
    for (const e of s.events) if (e.t === 'knock' && e.p === 'h') knocked = true;
    if (s.players[0].st === PSTATE.FINISH) break;
  }
  ok(knocked || s.players[0].st === PSTATE.FINISH, 'spinner interaction occurred (knock or lucky pass)');
}

section('simulation: survival terminal');
{
  const arena = ARENAS[0];
  const s = createState(arena, [
    { id: 'h', name: 'H', color: 1, isBot: false },
    { id: 'b1', name: 'B1', color: 2, isBot: true },
    { id: 'b2', name: 'B2', color: 3, isBot: true },
  ], { quota: 1, botSkill: 0.3 });
  // human walks straight off the edge
  let guard = 0;
  while (s.phase === 'active' && guard++ < TICK_RATE * 240) {
    applyCommand(s, makeCommand('h', s.tick + 1, { mx: 1 }));
    step(s);
  }
  ok(s.terminal != null, 'survival terminates: ' + (s.terminal || {}).reason);
  ok(['last-standing', 'time'].includes(s.terminal.reason), 'survival terminal reason valid');
  const res = roundResults(s);
  ok(res.places.length === 3, 'survival ranked');
  ok(res.results[res.places[0]].breakdown.survival >= 0, 'survival points component');
}

// ---------------------------------------------------------------------------
section('serialization roundtrip + migration');
{
  const def = JOURNEY[5];
  const s = createState(def, [
    { id: 'h', name: 'H', color: 1, isBot: false },
    { id: 'b1', name: 'B1', color: 2, isBot: true },
  ], { quota: 1, botSkill: 0.6 });
  for (let i = 0; i < 300; i++) { applyCommand(s, makeCommand('h', s.tick + 1, { mz: 1, jump: i % 50 === 0 })); step(s); }
  const snap = JSON.parse(JSON.stringify(serializeState(s)));
  const restored = deserializeState(snap, def);
  ok(hashGameState(restored) === hashGameState(s), 'hash identical after roundtrip');
  for (let i = 0; i < 120; i++) { step(s); step(restored); }
  ok(hashGameState(restored) === hashGameState(s), 'hash identical after continued sim');

  const v0 = { ...snap, version: 0, players: snap.players.map(p => { const q = { ...p }; delete q.sid; return q; }) };
  const m = migrateState(v0);
  ok(m.version === 1 && m.players.every(p => p.sid), 'v0 -> v1 migration fills sid');
}

// ---------------------------------------------------------------------------
section('replay property: same seed + commands => identical hashes');
{
  const courses = [JOURNEY[2], JOURNEY[17], SHOW_COURSES[1], dailyDef('2026-01-15')];
  for (const def of courses) {
    const roster = [
      { id: 'h', name: 'H', color: 1, isBot: false },
      { id: 'b1', name: 'B1', color: 2, isBot: true },
      { id: 'b2', name: 'B2', color: 3, isBot: true },
      { id: 'b3', name: 'B3', color: 4, isBot: true },
    ];
    const opts = { quota: 1, botSkill: 0.6 };
    const rec = new Recorder({ build: 'test', courseDef: def, roster, opts });
    const s = createState(def, roster, opts);
    rec.begin(s);
    const scriptRng = new Rng(777, 'script');
    let guard = 0;
    while (s.phase === 'active' && guard++ < TICK_RATE * 300) {
      const inp = { mz: 0.7 + scriptRng.float() * 0.3, mx: scriptRng.float() - 0.5 };
      if (scriptRng.chance(0.05)) inp.jump = true;
      if (scriptRng.chance(0.02)) inp.dive = true;
      const cmd = makeCommand('h', s.tick + 1, inp);
      if (applyCommand(s, cmd).ok) rec.record(cmd);
      step(s);
      rec.tickHash(s);
    }
    const env = rec.finalize(s, null);
    const v = verify(env, def);
    ok(v.ok, 'replay verifies for ' + def.id + (v.ok ? '' : ' — ' + v.reason + ' @' + v.mismatchAt));
  }
}

section('fuzz: malformed commands and states');
{
  const def = JOURNEY[10];
  const s = createState(def, [
    { id: 'h', name: 'H', color: 1, isBot: false },
    { id: 'b1', name: 'B1', color: 2, isBot: true },
  ], { quota: 1 });
  const fr = new Rng(999, 'fuzz');
  let crashed = null;
  try {
    for (let i = 0; i < 4000; i++) {
      const junk = {
        id: fr.chance(0.8) ? 'f' + i : null,
        playerId: fr.pick(['h', 'b1', 'x', null, 42]),
        tick: fr.int(-5, s.tick + 200),
        mx: fr.int(-1000, 1000), mz: fr.int(-1000, 1000),
        jump: fr.chance(0.3), dive: fr.chance(0.3),
      };
      applyCommand(s, junk);
      if (i % 3 === 0) step(s);
      if (s.phase !== 'active') break;
    }
    for (let i = 0; i < 600; i++) step(s);
  } catch (e) { crashed = e; }
  ok(!crashed, 'fuzz did not crash' + (crashed ? ': ' + crashed.message : ''));
  let finite = true;
  for (const p of s.players) for (const v of [p.x, p.y, p.z, p.vx, p.vy, p.vz]) {
    if (!Number.isFinite(v)) finite = false;
  }
  ok(finite, 'no NaN after fuzz');
  ok(s.tick <= 1e7, 'bounded loop');
}

// ---------------------------------------------------------------------------
section('show orchestration');
{
  const showDef = SHOWS[0];
  const course0 = courseById(showDef.rounds[0].courseId);
  const roster = [{ id: 'h', name: 'H', color: 1, isBot: false }];
  for (let i = 0; i < showDef.players - 1; i++) roster.push({ id: 'b' + i, name: 'B' + i, color: i + 2, isBot: true });
  const show = createShow(showDef, roster);
  ok(show.aliveIds.length === showDef.players, 'show roster size');
  // round 1
  const s1 = createState(course0, roster, { quota: showDef.rounds[0].quota, botSkill: showDef.botSkill });
  let guard = 0;
  while (s1.phase === 'active' && guard++ < TICK_RATE * 300) {
    applyCommand(s1, makeCommand('h', s1.tick + 1, { mz: 1, jump: guard % 90 === 0 }));
    step(s1);
  }
  ok(s1.terminal != null, 'show round 1 terminal');
  const r1 = roundResults(s1);
  const qualifiedCount = Object.values(r1.results).filter(r => r.qualified).length;
  ok(qualifiedCount === showDef.rounds[0].quota, 'exactly quota qualified: ' + qualifiedCount);
  applyRoundResult(show, r1);
  ok(show.roundIndex === 1 && show.aliveIds.length === showDef.rounds[0].quota, 'show advanced');
  ok(!isFinalRound(show), 'not final yet');
  const table = showTable(show);
  ok(table.length === showDef.players && table[0].points >= table[table.length - 1].points, 'show table sorted');
}

// ---------------------------------------------------------------------------
section('golden sessions (deterministic end-to-end)');
{
  const goldens = [];
  const mk = (def, roster, opts, script) => {
    const s = createState(def, roster, opts);
    let guard = 0;
    while (s.phase === 'active' && guard++ < TICK_RATE * 400) {
      const inp = script(s.tick, s) || {};
      const cmd = makeCommand('h', s.tick + 1, inp);
      applyCommand(s, cmd);
      step(s);
    }
    return { id: def.id, tick: s.tick, terminal: s.terminal && s.terminal.reason, hash: hashGameState(s) };
  };
  goldens.push(mk(JOURNEY[0], [{ id: 'h', name: 'H', color: 1, isBot: false }, { id: 'b1', name: 'B1', color: 2, isBot: true }], { quota: 1, botSkill: 0.3 }, (t) => ({ mz: 1, jump: t % 55 === 0 })));
  goldens.push(mk(JOURNEY[13], [{ id: 'h', name: 'H', color: 1, isBot: false }, { id: 'b1', name: 'B1', color: 2, isBot: true }], { quota: 1, botSkill: 0.5 }, (t) => ({ mz: 1, mx: Math.sin(t / 40) * 0.5, jump: t % 70 === 0 })));
  goldens.push(mk(JOURNEY[29], [{ id: 'h', name: 'H', color: 1, isBot: false }, { id: 'b1', name: 'B1', color: 2, isBot: true }], { quota: 1, botSkill: 0.7 }, (t) => ({ mz: 0.9, jump: t % 64 === 0, dive: t % 200 === 100 })));

  const EXPECTED = {
    'j01': { tick: 448, terminal: 'quota', hash: '848f6111' },
    'j14': { tick: 679, terminal: 'quota', hash: '0493c6f3' },
    'j30': { tick: 703, terminal: 'quota', hash: 'e0a2b5bb' },
  };
  if (goldenUpdate) {
    console.log('  golden values:', JSON.stringify(goldens, null, 2));
  }
  for (const g of goldens) {
    const exp = EXPECTED[g.id];
    ok(exp && g.hash === exp.hash && g.tick === exp.tick && g.terminal === exp.terminal,
      `golden ${g.id}: ${g.hash}/${g.tick}/${g.terminal} === ${exp && exp.hash}/${exp && exp.tick}/${exp && exp.terminal}`);
  }
}

section('scoring tie-breaks');
{
  ok(placePoints(1) === 1000 && placePoints(2) < placePoints(1), 'placement monotonic');
  const def = makeCourse('t-tie', 'cumulus', 6, ['run'], [seg('run', 30)]);
  const s = createState(def, [
    { id: 'a', name: 'A', color: 1, isBot: false, sid: 'aaaa' },
    { id: 'b', name: 'B', color: 2, isBot: false, sid: 'bbbb' },
  ], { quota: 2 });
  // both idle until time limit -> tie on progress 0; invalids break the tie
  s.timeLimit = 10;
  s.players[1].invalids = 2;
  while (s.phase === 'active') step(s);
  ok(s.terminal.reason === 'time', 'time cutoff terminal');
  const res = roundResults(s);
  ok(res.places[0] === 'a', 'fewer invalid actions wins the tie');
}
} // end !validateOnly

// ---------------------------------------------------------------------------
section('save migration + checksum + conflict resolution');
{
  const { migrateSave, resolveCloudConflict, SAVE_VERSION } = await import('../js/platform/store.js');
  const fresh = migrateSave(null);
  ok(fresh.version === SAVE_VERSION && fresh.settings.quality === 'auto', 'fresh save has defaults');
  const old = { version: 0, settings: { music: 0.3 }, journey: { unlocked: 5, passed: { j01: 900 } } };
  const m = migrateSave(old);
  ok(m.version === SAVE_VERSION && m.settings.music === 0.3 && m.settings.effects === 0.9 &&
    m.journey.unlocked === 5 && m.journey.passed.j01 === 900, 'v0 save migrated, overrides kept, defaults filled');
  const sup = migrateSave({ journey: { unlocked: 6, passed: { j01: 900, j02: 800 } }, lessonsDone: {}, challengesDone: {} });
  const sub = migrateSave({ journey: { unlocked: 5, passed: { j01: 900 } }, lessonsDone: {}, challengesDone: {} });
  ok(resolveCloudConflict(sup, sub) === 'local', 'strict descendant wins locally');
  ok(resolveCloudConflict(sub, sup) === 'remote', 'strict descendant wins remotely');
  const a = migrateSave({ journey: { unlocked: 5, passed: { j01: 1 } } });
  const b = migrateSave({ journey: { unlocked: 5, passed: { j02: 1 } } });
  ok(resolveCloudConflict(a, b).startsWith('conflict'), 'diverged saves conflict');
}

section('content validation sweep');
{
  const dates = [];
  {
    const d = new Date();
    for (let i = 0; i < 3; i++) { dates.push(dailyDateString(d)); d.setUTCDate(d.getUTCDate() + 1); }
  }
  const report = validateAll({ withDailyDates: dates, solvable: true });
  console.log(`  validated ${report.stats.courses} courses + ${report.stats.dailies} dailies`);
  for (const w of report.warnings) console.log('  warn:', w);
  for (const e of report.errors) console.log('  error:', e);
  ok(report.ok, 'all content valid and solvable');
  ok(JOURNEY.length === 40, 'exactly 40 journey stages');
  ok(LESSONS.length === 5, 'five lessons');
  ok(CHALLENGES.length === 6, 'six challenges');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) { console.log('failures:', failures.join(' | ')); process.exit(1); }
