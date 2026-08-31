// Local session driver: runs one deterministic round (race / survival /
// lesson / challenge) with a fixed simulation step, quantized input commands,
// countdown, replay recording and scoring. UI state is fully separate:
// pausing menus never touches the sim except through pause/resume.

import {
  createState, step, applyCommand, makeCommand, legalActions, serializeState,
  hashGameState, TICK_RATE, DT, PSTATE,
} from '../rules/sim.js';
import { roundResults } from '../rules/scoring.js';
import { Recorder, verify } from '../rules/replay.js';

export const COUNTDOWN_TICKS = TICK_RATE * 3; // 3-2-1-GO

export class LocalRound {
  // def: course content def; roster: [{id,name,color,isBot}];
  // opts: { quota, botSkill, timeLimit, seedOverride, lesson, mods }
  constructor(def, roster, opts = {}) {
    this.def = def;
    this.lesson = opts.lesson || null;
    this.mods = opts.mods || {};
    this.goal = opts.goal || null;
    this.state = createState(def, roster, {
      quota: opts.quota != null ? opts.quota : 1,
      botSkill: opts.botSkill, timeLimit: opts.timeLimit, seedOverride: opts.seedOverride,
    });
    if (this.mods.noDive) {
      // diving removed from the legal action set for this challenge
      this.state.challengeNoDive = true;
    }
    if (this.mods.maxJumps != null) this.state.challengeMaxJumps = this.mods.maxJumps;
    this.localId = roster.find(r => !r.isBot)?.id || roster[0].id;
    this.recorder = new Recorder({ build: 'web-1.0.0', courseDef: def, roster, opts });
    this.recorder.begin(this.state);
    this.phase = 'countdown';
    this.cdLeft = COUNTDOWN_TICKS;
    this.accum = 0;
    this.localInput = { mx: 0, mz: 0, jump: false, dive: false };
    this.prevJump = false; this.prevDive = false;
    this.paused = false;
    this.result = null;
    this.drainedEvents = [];
    this.lessonStep = 0;
    this.lessonProgress = {};
    this.invalidFlash = null;
    this.finished = false; // local player crossed finish (cosmetic pacing)
  }

  setInput(inp) { this.localInput = { ...this.localInput, ...inp }; }

  pause() { this.paused = true; }
  resume() { this.paused = false; }

  legal() {
    const la = legalActions(this.state, this.localId);
    if (this.state.challengeNoDive) la.dive = { ok: false, reason: 'disabled by challenge' };
    if (this.state.challengeMaxJumps != null) {
      const p = this.state.players.find(pl => pl.id === this.localId);
      if (p && p.jumps >= this.state.challengeMaxJumps) la.jump = { ok: false, reason: 'jump limit reached' };
    }
    return la;
  }

  // Advance the fixed-step sim. `realDt` seconds elapsed since last call.
  // Returns events generated this frame (drained).
  update(realDt) {
    this.drainedEvents.length = 0;
    if (this.paused || this.phase === 'done') return this.drainedEvents;

    if (this.phase === 'countdown') {
      this.accum += realDt;
      while (this.accum >= DT && this.cdLeft > 0) {
        this.accum -= DT; this.cdLeft--;
        if (this.cdLeft % TICK_RATE === 0) {
          const n = this.cdLeft / TICK_RATE;
          this.drainedEvents.push({ t: n > 0 ? 'countdown' : 'go', n });
        }
      }
      if (this.cdLeft <= 0) this.phase = 'active';
      return this.drainedEvents;
    }

    this.accum = Math.min(this.accum + realDt, DT * 8); // clamp spiral of death
    while (this.accum >= DT && this.state.phase === 'active') {
      this.accum -= DT;
      this.tickOnce();
    }
    if (this.state.phase === 'terminal' && this.phase !== 'done') {
      this.phase = 'done';
      this.result = roundResults(this.state);
      this.recorder.finalize(this.state, this.result);
      this.drainedEvents.push({ t: 'round-end' });
    }
    return this.drainedEvents;
  }

  tickOnce() {
    const s = this.state;
    // quantize local input into a validated command for tick+1
    const p = s.players.find(pl => pl.id === this.localId);
    const inp = { mx: this.localInput.mx, mz: this.localInput.mz };
    const la = this.legal();
    // edge-triggered buttons, gated by the same legal-action API as hints
    if (this.localInput.jump && !this.prevJump) {
      if (la.jump.ok) inp.jump = true;
      else if (la.canInput) this.invalidFlash = la.jump.reason || 'jump unavailable';
    }
    if (this.localInput.dive && !this.prevDive) {
      if (la.dive.ok) inp.dive = true;
      else if (la.canInput) this.invalidFlash = la.dive.reason || 'dive unavailable';
    }
    this.prevJump = this.localInput.jump;
    this.prevDive = this.localInput.dive;
    if (!la.move.ok) { inp.mx = 0; inp.mz = 0; }
    if (p && !p.eliminated && p.st !== PSTATE.FINISH) {
      const cmd = makeCommand(this.localId, s.tick + 1, inp, 'local');
      if (applyCommand(s, cmd).ok) this.recorder.record(cmd);
    }
    step(s);
    for (const e of s.events) {
      this.drainedEvents.push(e);
      this.trackLesson(e);
      if (e.t === 'finish' && e.p === this.localId) this.finished = true;
    }
    this.recorder.tickHash(s);
  }

  trackLesson(e) {
    if (!this.lesson) return;
    const steps = this.lesson.steps;
    if (this.lessonStep >= steps.length) return;
    const st = steps[this.lessonStep];
    const c = st.check;
    if (c.type === 'event' && e.t === c.event && (e.p === this.localId || e.p == null)) {
      const k = this.lessonStep;
      this.lessonProgress[k] = (this.lessonProgress[k] || 0) + 1;
      if (this.lessonProgress[k] >= (c.count || 1)) {
        this.lessonStep++;
        this.drainedEvents.push({ t: 'lesson-step', step: this.lessonStep, of: steps.length });
      }
    }
  }

  // input-based lesson step (e.g. "hold forward for N ticks") is polled here
  pollLessonInput() {
    if (!this.lesson) return null;
    const steps = this.lesson.steps;
    if (this.lessonStep >= steps.length) return null;
    const st = steps[this.lessonStep];
    if (st.check.type === 'input') {
      const held = st.check.what === 'forward'
        ? (this.localInput.mz > 0.5 || this.localInput.forwardHeld)
        : false;
      if (held && this.phase === 'active') {
        const k = this.lessonStep;
        this.lessonProgress[k] = (this.lessonProgress[k] || 0) + 1;
        if (this.lessonProgress[k] >= st.check.ticks) {
          this.lessonStep++;
          return { t: 'lesson-step', step: this.lessonStep, of: steps.length };
        }
      }
    }
    return null;
  }

  lessonDone() {
    return this.lesson ? this.lessonStep >= this.lesson.steps.length : false;
  }

  currentLessonStep() {
    if (!this.lesson || this.lessonStep >= this.lesson.steps.length) return null;
    return this.lesson.steps[this.lessonStep];
  }

  // challenge goal evaluation on top of roundResults
  challengeOutcome() {
    if (!this.goal || !this.result) return null;
    const me = this.result.results[this.localId];
    const p = this.state.players.find(pl => pl.id === this.localId);
    const g = this.goal;
    switch (g.kind) {
      case 'finish': return { won: me.finished, desc: me.finished ? 'Finished!' : 'Did not finish' };
      case 'time': return {
        won: me.finished && me.finishTick <= g.ticks,
        desc: me.finished ? `Finished in ${(me.finishTick / TICK_RATE).toFixed(1)}s (target ${(g.ticks / TICK_RATE).toFixed(1)}s)` : 'Did not finish',
      };
      case 'noFalls': return { won: me.finished && p.falls === 0, desc: me.finished ? `${p.falls} falls` : 'Did not finish' };
      case 'win': return { won: me.place === 1, desc: me.place === 1 ? 'Last tumbler standing!' : `Placed #${me.place}` };
      default: return null;
    }
  }

  exportReplay() { return this.recorder.envelope; }
  verifyReplay() { return verify(this.recorder.envelope, this.def); }
  snapshot() { return serializeState(this.state); }
  hash() { return hashGameState(this.state); }
}

// Build a roster: the local player plus deterministic bot names/colors.
const BOT_NAMES = ['Brio', 'Mochi', 'Zephyr', 'Pip', 'Tansy', 'Roku', 'Ibis', 'Nix', 'Sable', 'Tulo', 'Wren', 'Kelp', 'Fizz', 'Ono', 'Lux', 'Pesto', 'Quill', 'Rill', 'Sorrel', 'Tarn', 'Umi', 'Vex', 'Wisp', 'Yara', 'Zest', 'Alto', 'Bracken', 'Coda', 'Dune', 'Echo', 'Fenn'];
const PALETTE = [0xff8fab, 0xffd166, 0x06d6a0, 0x3a86ff, 0x8338ec, 0xff9f1c, 0x2ec4b6, 0xef476f, 0x8fb8ff, 0xf9c74f, 0x58e0c0, 0xb892ff];

export function buildRoster(localName, localColor, botCount, seed = 1) {
  const roster = [{ id: 'you', name: localName || 'You', color: localColor ?? PALETTE[0], isBot: false }];
  for (let i = 0; i < botCount; i++) {
    roster.push({
      id: 'bot-' + i, name: BOT_NAMES[(seed + i * 3) % BOT_NAMES.length],
      color: PALETTE[(seed + i + 1) % PALETTE.length], isBot: true,
    });
  }
  return roster;
}
export { PALETTE };
