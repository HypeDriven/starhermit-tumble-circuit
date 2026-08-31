// DOM shell: screen router, focus management, keyboard/touch/gamepad input,
// HUD, live announcements, captions, and the accessibility mirror. All
// gameplay truth comes from the session; UI state never mutates the sim.

import { LocalRound, buildRoster, PALETTE } from '../session/round.js';
import { JOURNEY, LESSONS, CHALLENGES, SHOWS, ARENAS, courseById, showById, challengeCourse, lessonById } from '../content/stages.js';
import { dailyDef, isDailyExcluded, DAILY_RULESET } from '../content/daily.js';
import { themeById } from '../content/themes.js';
import { createShow, currentRound, applyRoundResult, showTable, isFinalRound } from '../rules/show.js';
import { formatTicks } from '../rules/scoring.js';
import { TICK_RATE, rankPlayers, PSTATE } from '../rules/sim.js';
import { utcDateString, msUntilNextUtcDay } from '../platform/timeSync.js';

const $ = (sel) => document.querySelector(sel);
const el = (id) => document.getElementById(id);

export const ACHIEVEMENTS = {
  first_finish: { name: 'First Crossing', desc: 'Finish your first course.' },
  lesson_grad: { name: 'Graduate', desc: 'Complete all five lessons.' },
  mastery_crown: { name: 'Crowned', desc: 'Pass a mastery stage.' },
  streak_3: { name: 'Hat Trick', desc: 'Qualify three rounds in a row.' },
  halfway: { name: 'Half the Sky', desc: 'Pass 20 journey stages.' },
  daily_regular: { name: 'Regular', desc: 'Play the daily challenge on 5 different days.' },
  champion: { name: 'Champion', desc: 'Win a show final.' },
  long_haul: { name: 'Long Haul', desc: 'Finish 50 races (any mode).' },
};

export class App {
  constructor({ scene, audio, store, save, hosted }) {
    this.scene = scene;
    this.audio = audio;
    this.store = store;   // { save, persist() }
    this.hosted = hosted;
    this.screen = 'title';
    this.round = null;
    this.show = null;
    this.keys = {};
    this.touch = { active: false, mx: 0, mz: 0, jump: false, dive: false };
    this.lastFocus = null;
    this.frame = this.frame.bind(this);
    this.prevTime = 0;
    this.announce = '';
    this.captionTimer = null;
    this.showFps = false;
    this.fps = 60;
    audio.onCaption = (t) => this.showCaption(t);
  }

  get settings() { return this.store.save.settings; }

  // ====================================================================
  // boot + main loop
  // ====================================================================
  start() {
    this.bindInput();
    this.applySettings();
    this.showTitle();
    this.prevTime = performance.now();
    requestAnimationFrame(this.frame);
  }

  frame(now) {
    const dt = Math.min(0.1, (now - this.prevTime) / 1000);
    this.prevTime = now;
    this.fps = this.fps * 0.95 + (1 / Math.max(dt, 1e-4)) * 0.05;

    if (this.round) {
      const evs = this.round.update(document.hidden ? 0 : dt);
      const lessonEv = this.round.pollLessonInput();
      if (lessonEv) evs.push(lessonEv);
      for (const e of evs) this.handleRoundEvent(e);
      if (this.round.invalidFlash) {
        this.announceText(this.round.invalidFlash, true);
        this.audio.event({ t: 'invalid' });
        this.round.invalidFlash = null;
      }
      const alpha = this.round.phase === 'countdown' ? 0 : this.round.accum / (1 / TICK_RATE);
      this.scene.render(this.round.state, Math.min(1, Math.max(0, alpha)), this.round.localId, dt);
      this.updateHUD();
      if (this.round.phase === 'done' && !this.resultsShown) {
        this.resultsShown = true;
        setTimeout(() => this.showResults(), 900);
      }
    } else if (this.attractState) {
      this.attractState.t += dt;
      this.scene.renderAttract(this.attractState.t);
    }
    requestAnimationFrame(this.frame);
  }

  // ====================================================================
  // input
  // ====================================================================
  bindInput() {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      const k = e.key.toLowerCase();
      this.keys[k] = true;
      if (k === 'escape' || k === 'p') { this.togglePause(); e.preventDefault(); }
      if (this.round && (k === ' ' || k === 'arrowup' || k === 'w' && false)) e.preventDefault();
      if (k === ' ' || k === 'enter') this.audio.start();
    });
    window.addEventListener('keyup', (e) => { this.keys[e.key.toLowerCase()] = false; });
    window.addEventListener('pointerdown', () => this.audio.start(), { once: true });
    window.addEventListener('resize', () => this.scene.resize());
    document.addEventListener('visibilitychange', () => {
      // backgrounding pauses solo simulation; rendering drops to zero
      this.scene.hidden = document.hidden;
      if (document.hidden) {
        if (this.round && this.round.phase !== 'done' && !this.round.paused) this.pauseRound(true);
        this.audio.suspend();
      } else {
        this.audio.resume();
      }
    });

    // pause button
    el('btn-pause').addEventListener('click', () => this.togglePause());

    // touch joystick + action buttons
    const zone = el('stick-zone'), base = el('stick-base'), nub = el('stick-nub');
    let stickId = null, origin = null;
    zone.addEventListener('pointerdown', (e) => {
      stickId = e.pointerId; origin = { x: e.clientX, y: e.clientY };
      zone.setPointerCapture(e.pointerId);
      base.style.display = 'block';
      base.style.left = (e.clientX - 55 - zone.getBoundingClientRect().left) + 'px';
      base.style.top = (e.clientY - 55 - zone.getBoundingClientRect().top) + 'px';
      this.audio.start();
    });
    zone.addEventListener('pointermove', (e) => {
      if (e.pointerId !== stickId || !origin) return;
      const dx = (e.clientX - origin.x) / 45, dy = (e.clientY - origin.y) / 45;
      const m = Math.hypot(dx, dy) || 1;
      const c = Math.min(1, m);
      this.touch.mx = (dx / m) * c;
      this.touch.mz = (-dy / m) * c;
      nub.style.left = (31 + this.touch.mx * 32) + 'px';
      nub.style.top = (31 - this.touch.mz * 32) + 'px';
    });
    const endStick = (e) => {
      if (e.pointerId !== stickId) return;
      stickId = null; origin = null;
      this.touch.mx = 0; this.touch.mz = 0;
      base.style.display = 'none';
      nub.style.left = '31px'; nub.style.top = '31px';
    };
    zone.addEventListener('pointerup', endStick);
    zone.addEventListener('pointercancel', endStick);
    el('btn-jump').addEventListener('pointerdown', (e) => { e.preventDefault(); this.touch.jump = true; this.audio.start(); });
    el('btn-jump').addEventListener('pointerup', () => { this.touch.jump = false; });
    el('btn-dive').addEventListener('pointerdown', (e) => { e.preventDefault(); this.touch.dive = true; this.audio.start(); });
    el('btn-dive').addEventListener('pointerup', () => { this.touch.dive = false; });

    // gamepad (focus nav is DOM-native; pad drives movement + actions)
    this.padPrev = {};
    const pollPad = () => {
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      const gp = pads && pads[0];
      if (gp && this.round) {
        const ax = gp.axes[0] || 0, ay = gp.axes[1] || 0;
        this.padMove = { mx: Math.abs(ax) > 0.18 ? ax : 0, mz: Math.abs(ay) > 0.18 ? -ay : 0 };
        const b = (i) => !!(gp.buttons[i] && gp.buttons[i].pressed);
        if (b(0) && !this.padPrev.a) this.padJump = true; else if (!b(0)) this.padJump = b(0);
        this.padButtons = { jump: b(0), dive: b(1) || b(2) };
        if (b(9) && !this.padPrev.start) this.togglePause();
        this.padPrev = { a: b(0), start: b(9) };
      }
      requestAnimationFrame(pollPad);
    };
    requestAnimationFrame(pollPad);
  }

  readMoveInput() {
    let mx = 0, mz = 0;
    if (this.keys['arrowleft'] || this.keys['a']) mx -= 1;
    if (this.keys['arrowright'] || this.keys['d']) mx += 1;
    if (this.keys['arrowup'] || this.keys['w']) mz += 1;
    if (this.keys['arrowdown'] || this.keys['s']) mz -= 0.6;
    if (this.touch.mx || this.touch.mz) { mx = this.touch.mx; mz = this.touch.mz; }
    if (this.padMove && (this.padMove.mx || this.padMove.mz)) { mx = this.padMove.mx; mz = this.padMove.mz; }
    const m = Math.hypot(mx, mz);
    if (m > 1) { mx /= m; mz /= m; }
    return { mx, mz };
  }

  readActionInput() {
    return {
      jump: !!(this.keys[' '] || this.keys['k'] || this.touch.jump || (this.padButtons && this.padButtons.jump)),
      dive: !!(this.keys['shift'] || this.keys['l'] || this.touch.dive || (this.padButtons && this.padButtons.dive)),
    };
  }

  // ====================================================================
  // round lifecycle
  // ====================================================================
  startRound(def, opts = {}) {
    const botCount = opts.bots != null ? opts.bots : 7;
    const roster = opts.roster || buildRoster(this.profileName(), PALETTE[0], botCount, def.seed % 23);
    this.round = new LocalRound(def, roster, {
      quota: opts.quota != null ? opts.quota : Math.max(1, Math.ceil((botCount + 1) / 2)),
      botSkill: opts.botSkill != null ? opts.botSkill : 0.55,
      seedOverride: opts.seedOverride,
      lesson: opts.lesson, mods: opts.mods, goal: opts.goal,
      timeLimit: opts.timeLimit,
    });
    this.resultsShown = false;
    this.scene.buildCourse(this.round.state.course, def.theme || 'cumulus');
    this.scene.ensurePlayers(this.round.state.players);
    this.audio.setMusicTheme(themeById(def.theme || 'cumulus').music);
    el('screens').innerHTML = '';
    el('hud').classList.remove('hidden');
    el('countdown').classList.remove('hidden');
    if ('ontouchstart' in window) el('touch-ui').classList.remove('hidden');
    if (opts.lesson) {
      el('lesson-banner').classList.remove('hidden');
      el('lesson-banner').textContent = opts.lesson.intro;
    }
    el('hud-title').textContent = def.name || def.id;
    el('hud-goal').textContent = opts.goalText || (def.kind === 'survival' ? 'Survive — be the last tumbler standing' : `Reach the finish — top ${this.round.state.quota} qualify`);
    el('hud-quota').textContent = def.kind === 'survival' ? '' : `Cutoff: top ${this.round.state.quota} of ${roster.length}`;
    this.announceText(`${def.name || 'Round'} starting. ${el('hud-goal').textContent}`);
    this.persistStats();
  }

  endRoundTo(screenFn) {
    this.round = null;
    this.show = null;
    el('hud').classList.add('hidden');
    el('countdown').classList.add('hidden');
    el('lesson-banner').classList.add('hidden');
    el('touch-ui').classList.add('hidden');
    screenFn();
  }

  togglePause() {
    if (!this.round) {
      return;
    }
    if (this.round.paused) this.resumeRound();
    else this.pauseRound();
  }

  pauseRound(auto = false) {
    if (!this.round || this.round.phase === 'done') return;
    this.round.pause();
    if (!auto) this.audio.event({ t: 'ui-back' });
    this.showPause();
  }

  resumeRound() {
    this.round.resume();
    el('screens').innerHTML = '';
    this.audio.event({ t: 'ui' });
  }

  handleRoundEvent(e) {
    // audio + vfx tiers: input ack < legal move < goal < round completion
    switch (e.t) {
      case 'countdown': el('countdown').textContent = e.n; this.audio.event({ t: 'countdown' }); break;
      case 'go': el('countdown').textContent = 'GO!'; this.audio.event({ t: 'go' }); setTimeout(() => el('countdown').classList.add('hidden'), 700); break;
      case 'lesson-step': {
        const st = this.round.currentLessonStep();
        el('lesson-banner').textContent = st ? this.lessonText(st.text) : 'Lesson complete — reach the finish!';
        this.audio.event({ t: 'checkpoint' });
        this.announceText(st ? this.lessonText(st.text) : 'Lesson complete');
        break;
      }
      default:
        this.audio.event(e, this.round.state.tick + (e.p === this.round.localId ? 7 : 1));
        this.scene.onEvent(e, this.round.localId);
        if (e.t === 'checkpoint' && e.p === this.round.localId) this.announceText(`Checkpoint ${e.cp} of ${e.of}`);
        if (e.t === 'finish' && e.p === this.round.localId) this.announceText(`Finished! Place ${e.place}`);
        if (e.t === 'out' && e.p === this.round.localId) this.announceText('You are out', true);
    }
  }

  lessonText(text) {
    return text
      .replace('{move}', 'W A S D / arrows / stick')
      .replace('{jump}', 'Space / Jump button')
      .replace('{dive}', 'Shift / Dive button');
  }

  updateHUD() {
    if (!this.round) return;
    const s = this.round.state;
    const remain = Math.max(0, s.timeLimit - s.tick);
    el('hud-clock').textContent = formatTicks(remain);
    const me = s.players.find(p => p.id === this.round.localId);
    if (me) {
      const ranked = rankPlayers(s);
      const place = ranked.findIndex(p => p.id === me.id) + 1;
      el('hud-place').textContent = me.st === PSTATE.FINISH ? `Finished #${me.finishTick >= 0 ? s.finishOrder.indexOf(me.id) + 1 : '—'}` : `#${place} of ${s.players.length}`;
      const prog = s.kind === 'race' ? Math.min(100, (me.progress / s.course.finishZ) * 100) : Math.min(100, (me.aliveTicks / s.timeLimit) * 100);
      const bar = el('hud-progress');
      el('hud-progress-fill').style.width = prog.toFixed(1) + '%';
      bar.setAttribute('aria-valuenow', prog.toFixed(0));
      const la = this.round.legal();
      el('btn-jump').disabled = !la.jump.ok;
      el('btn-dive').disabled = !la.dive.ok;
    }
    // drive input into the session
    if (this.round.phase === 'active' && !this.round.paused) {
      const mv = this.readMoveInput();
      const ac = this.readActionInput();
      this.round.setInput({ ...mv, ...ac, forwardHeld: mv.mz > 0.5 });
    }
  }

  // ====================================================================
  // results + progression
  // ====================================================================
  showResults() {
    const r = this.round;
    if (!r || !r.result) return;
    const res = r.result;
    const me = res.results[r.localId];
    const save = this.store.save;
    const breakdown = me.breakdown;

    // achievements + progression (idempotent unlocks)
    const unlock = (key) => {
      if (!save.achievements[key]) {
        save.achievements[key] = Date.now();
        this.audio.event({ t: 'achievement' });
        this.announceText(`Achievement unlocked: ${ACHIEVEMENTS[key].name}`, true);
      }
    };
    save.stats.races++;
    if (me.finished) {
      save.stats.finishes++;
      unlock('first_finish');
      if (save.stats.finishes >= 50) unlock('long_haul');
    }
    if (me.qualified) {
      save.stats.qualifies++;
      save.stats.bestStreak = save.stats.bestStreak || 0;
      this.streak = (this.streak || 0) + 1;
      if (this.streak >= 3) unlock('streak_3');
    } else this.streak = 0;

    let headline, nextAction = null;
    if (r.lesson) {
      const done = r.lessonDone();
      headline = done ? `${r.lesson.title} — complete!` : `${r.lesson.title} — keep practicing`;
      if (done) {
        save.lessonsDone[r.lesson.id] = true;
        if (LESSONS.every(l => save.lessonsDone[l.id])) unlock('lesson_grad');
        const idx = LESSONS.indexOf(r.lesson);
        if (idx < LESSONS.length - 1) nextAction = { label: 'Next lesson', fn: () => this.startLesson(idx + 1) };
      }
    } else if (this.challengeCtx) {
      const out = r.challengeOutcome();
      headline = out.won ? `${this.challengeCtx.name} — cleared!` : `${this.challengeCtx.name} — ${out.desc}`;
      if (out.won) save.challengesDone[this.challengeCtx.id] = true;
      nextAction = { label: 'Challenges', fn: () => this.showChallenges() };
    } else if (this.dailyCtx) {
      headline = me.qualified ? 'Daily challenge — qualified!' : 'Daily challenge — eliminated';
      const d = utcDateString();
      if (!save.daily[d] || me.total > save.daily[d]) save.daily[d] = me.total;
      if (Object.keys(save.daily).length >= 5) unlock('daily_regular');
      nextAction = { label: 'Back to title', fn: () => this.showTitle() };
    } else if (this.journeyCtx) {
      const n = this.journeyCtx.stage;
      const passed = me.place <= (this.journeyCtx.passPlace || 4) && me.finished;
      headline = passed ? `${this.journeyCtx.name} — passed! (#${me.place})` : `${this.journeyCtx.name} — #${me.place}, needed top ${this.journeyCtx.passPlace}`;
      if (passed) {
        save.journey.passed['j' + String(n).padStart(2, '0')] = me.total;
        save.journey.unlocked = Math.max(save.journey.unlocked, Math.min(40, n + 1));
        if (this.journeyCtx.mastery) { save.journey.crowns['j' + String(n).padStart(2, '0')] = true; unlock('mastery_crown'); }
        if (Object.keys(save.journey.passed).length >= 20) unlock('halfway');
        if (n < 40) nextAction = { label: `Stage ${n + 1}`, fn: () => this.startJourneyStage(n + 1) };
      } else {
        nextAction = { label: 'Retry', fn: () => this.startJourneyStage(n) };
      }
    } else if (this.showCtx) {
      headline = me.qualified ? 'Qualified!' : 'Eliminated';
    } else {
      headline = me.finished ? `Finished #${me.place}` : `Placed #${me.place}`;
    }

    this.store.persist();
    this.showResultsScreen({ headline, res, me, breakdown, nextAction });
  }

  showResultsScreen({ headline, res, me, breakdown, nextAction }) {
    const rows = res.places.map((id) => {
      const r = res.results[id];
      const p = this.round.state.players.find(pl => pl.id === id);
      return `<tr class="${id === this.round.localId ? 'you' : ''} ${r.qualified ? 'qual' : ''}">
        <td>${r.place}. ${esc(p ? p.name : id)}</td>
        <td>${r.finished ? formatTicks(r.finishTick) : (this.round.state.kind === 'survival' ? formatTicks(r.aliveTicks) + ' alive' : 'DNF')}</td>
        <td>${r.total}</td></tr>`;
    }).join('');
    const replayCheck = this.round.verifyReplay();
    this.overlay(`
      <div class="panel" role="dialog" aria-labelledby="res-h">
        <h1 id="res-h">${esc(headline)}</h1>
        <h2>Score breakdown</h2>
        <table class="score" aria-label="Your score components">
          <tr><td>Checkpoints</td><td>${breakdown.checkpoints}</td></tr>
          <tr><td>Placement</td><td>${breakdown.placement}</td></tr>
          <tr><td>Qualification bonus</td><td>${breakdown.qualify}</td></tr>
          <tr><td>Time bonus</td><td>${breakdown.timeBonus}</td></tr>
          <tr><td>Survival</td><td>${breakdown.survival}</td></tr>
          <tr><td>Falls penalty</td><td>${breakdown.falls}</td></tr>
          <tr><th>Total</th><th>${me.total}</th></tr>
        </table>
        <h2>Standings</h2>
        <table class="score" aria-label="Round standings"><tr><th>Player</th><th>Result</th><th>Score</th></tr>${rows}</table>
        <p class="small muted">Replay integrity: ${replayCheck.ok ? 'verified deterministic' : 'mismatch (' + replayCheck.reason + ')'} · seed ${this.round.def.seed}</p>
        <div class="row mt">
          ${nextAction ? `<button class="primary" data-act="next">${esc(nextAction.label)}</button>` : ''}
          <button data-act="retry">Retry</button>
          ${this.showCtx ? '<button data-act="continue-show">Continue show</button>' : ''}
          <button data-act="menu">Mode select</button>
        </div>
      </div>`);
    this.onAction('next', () => nextAction && nextAction.fn());
    this.onAction('retry', () => this.retryCurrent());
    this.onAction('continue-show', () => this.continueShow());
    this.onAction('menu', () => this.endRoundTo(() => this.showModes()));
  }

  retryCurrent() {
    const ctx = this.lastRoundCtx;
    if (ctx) { this.audio.event({ t: 'ui' }); ctx(); }
  }

  // ====================================================================
  // modes
  // ====================================================================
  startLesson(i) {
    const lesson = LESSONS[i];
    this.journeyCtx = null; this.challengeCtx = null; this.dailyCtx = null; this.showCtx = null;
    this.lastRoundCtx = () => this.startLesson(i);
    this.startRound(lesson, {
      lesson, bots: lesson.bots ? lesson.bots.count : 0, botSkill: lesson.bots ? lesson.bots.skill : 0.2,
      quota: lesson.passPlace || 1,
      goalText: lesson.intro,
    });
  }

  startJourneyStage(n) {
    const st = JOURNEY[n - 1];
    if (!st) return this.showJourney();
    this.journeyCtx = st; this.challengeCtx = null; this.dailyCtx = null; this.showCtx = null;
    this.lastRoundCtx = () => this.startJourneyStage(n);
    this.startRound(st, {
      bots: st.bots.count, botSkill: st.bots.skill, quota: st.passPlace,
      goalText: `${st.name} — finish in the top ${st.passPlace} to pass${st.mastery ? ' · mastery stage' : ''}`,
    });
  }

  startDaily() {
    const d = utcDateString();
    if (isDailyExcluded(d)) { this.announceText('Today\'s daily is excluded from ranking', true); return; }
    const def = dailyDef(d);
    this.dailyCtx = { date: d }; this.journeyCtx = null; this.challengeCtx = null; this.showCtx = null;
    this.lastRoundCtx = () => this.startDaily();
    this.startRound(def, {
      bots: 9, botSkill: 0.6, quota: 4,
      goalText: `Daily ${d} — shared seed ${def.seed}, ruleset v${DAILY_RULESET}. One course for everyone today.`,
    });
  }

  startPractice(courseId, skill, bots) {
    const def = courseById(courseId) || JOURNEY[0];
    this.journeyCtx = null; this.challengeCtx = null; this.dailyCtx = null; this.showCtx = null;
    this.lastRoundCtx = () => this.startPractice(courseId, skill, bots);
    this.startRound(def, {
      bots, botSkill: skill, quota: Math.max(1, Math.ceil((bots + 1) / 2)),
      goalText: 'Practice — unranked, restart freely',
    });
  }

  startChallenge(id) {
    const ch = CHALLENGES.find(c => c.id === id);
    if (!ch) return;
    const def = challengeCourse(ch);
    this.challengeCtx = ch; this.journeyCtx = null; this.dailyCtx = null; this.showCtx = null;
    this.lastRoundCtx = () => this.startChallenge(id);
    this.startRound(def, {
      bots: ch.bots ? ch.bots.count : 0, botSkill: ch.bots ? ch.bots.skill : 0.4,
      quota: ch.goal.kind === 'win' ? 1 : 1,
      mods: ch.mods, goal: ch.goal, goalText: ch.desc,
    });
  }

  startShow(showId) {
    const def = showById(showId);
    if (!def) return;
    this.showCtx = def; this.journeyCtx = null; this.challengeCtx = null; this.dailyCtx = null;
    const roster = buildRoster(this.profileName(), PALETTE[0], def.players - 1, 7);
    this.show = createShow(def, roster);
    this.playShowRound();
  }

  playShowRound() {
    const round = currentRound(this.show);
    const courseDef = courseById(round.courseId);
    const aliveRoster = this.show.roster.filter(r => this.show.aliveIds.includes(r.id));
    this.lastRoundCtx = () => this.playShowRound();
    // survival final: only the last tumbler qualifies
    this.startRound(courseDef, {
      quota: Math.min(round.quota, aliveRoster.length), botSkill: this.showCtx.botSkill,
      roster: aliveRoster,
      goalText: `${this.showCtx.name} — round ${this.show.roundIndex + 1}/${this.showCtx.rounds.length}: ${isFinalRound(this.show) ? 'FINAL — winner takes the crown' : `top ${round.quota} qualify`}`,
    });
  }

  continueShow() {
    if (!this.show || !this.round) return;
    applyRoundResult(this.show, this.round.result);
    if (this.show.terminal || !this.show.aliveIds.includes('you')) {
      const table = showTable(this.show);
      const you = table.find(r => r.id === 'you');
      const champ = this.show.terminal && this.show.terminal.championId === 'you';
      const eliminated = !this.show.terminal;
      if (champ) {
        this.store.save.stats.showsWon++;
        if (!this.store.save.achievements.champion) {
          this.store.save.achievements.champion = Date.now();
          this.audio.event({ t: 'achievement' });
        }
        this.audio.event({ t: 'champion' });
      }
      this.store.persist();
      const rowsHtml = table.map(r => `<tr class="${r.id === 'you' ? 'you' : ''}">
        <td>${r.champion ? '👑 ' : ''}${esc(r.name)}</td><td>${r.points}</td><td>${r.rounds.join(', ') || '—'}</td></tr>`).join('');
      this.overlay(`
        <div class="panel" role="dialog" aria-labelledby="show-h">
          <h1 id="show-h">${champ ? 'You are the champion!' : eliminated ? 'Eliminated — show over' : esc(this.showCtx.name) + ' — show over'}</h1>
          <p class="muted">You placed #${you ? table.indexOf(you) + 1 : '—'} with ${you ? you.points : 0} points.</p>
          <table class="score"><tr><th>Player</th><th>Points</th><th>Rounds</th></tr>${rowsHtml}</table>
          <div class="row mt">
            <button class="primary" data-act="menu">Mode select</button>
            <button data-act="title">Title</button>
          </div>
        </div>`);
      this.onAction('menu', () => this.endRoundTo(() => this.showModes()));
      this.onAction('title', () => this.endRoundTo(() => this.showTitle()));
      this.round = null;
      el('hud').classList.add('hidden');
      el('touch-ui').classList.add('hidden');
    } else {
      this.playShowRound();
    }
  }

  // ====================================================================
  // screens
  // ====================================================================
  overlay(html) {
    el('screens').innerHTML = `<div class="screen">${html}</div>`;
    const first = el('screens').querySelector('button');
    if (first) first.focus();
  }

  onAction(act, fn) {
    const b = el('screens').querySelector(`[data-act="${act}"]`);
    if (b) b.addEventListener('click', () => { this.audio.event({ t: 'ui' }); fn(); });
  }

  showTitle() {
    this.endlessCleanup();
    const save = this.store.save;
    const journeyDone = Object.keys(save.journey.passed).length;
    const d = utcDateString();
    const dailyBest = save.daily[d];
    this.overlay(`
      <div class="panel transparent-panel center" role="dialog" aria-labelledby="title-h">
        <h1 class="title-logo" id="title-h">Tumble <em>Circuit</em></h1>
        <p class="title-sub">Race the sky. Survive the spin. Take the crown.</p>
        <div class="col mt">
          <button class="primary" data-act="play">Play</button>
          <div class="row" style="justify-content:center">
            <button data-act="daily">Daily challenge${dailyBest ? ` · best ${dailyBest}` : ''}</button>
            <button data-act="journey">Journey (${journeyDone}/40)</button>
            <button data-act="learn">Learn</button>
          </div>
          <div class="row" style="justify-content:center">
            <button data-act="settings">Settings</button>
            <button data-act="help">Help</button>
          </div>
        </div>
        <p class="small muted mt">WASD/arrows move · Space jump · Shift dive · Esc pause</p>
      </div>`);
    this.onAction('play', () => this.showModes());
    this.onAction('daily', () => this.startDaily());
    this.onAction('journey', () => this.showJourney());
    this.onAction('learn', () => this.showLearn());
    this.onAction('settings', () => this.showSettings(() => this.showTitle()));
    this.onAction('help', () => this.showHelp(() => this.showTitle()));
    if (!this.attractState) this.buildAttract();
  }

  buildAttract() {
    // scenic backdrop behind the title: a show course, slow camera drift
    if (!this.scene.ok) return;
    const def = courseById('show-ridge');
    if (!def) return;
    this.scene.buildAttractCourse(def);
    this.attractState = { t: 0 };
  }

  endlessCleanup() { this.round = null; this.show = null; this.attractState = null; }

  showModes() {
    const hostedOk = this.hosted && this.hosted.available;
    this.overlay(`
      <div class="panel" role="dialog" aria-labelledby="modes-h">
        <h1 id="modes-h">Choose a mode</h1>
        <div class="card-grid mt">
          <button class="card" data-act="learn"><span class="card-title">Learn</span><span class="card-sub">5 interactive lessons · ~5 min · unranked</span></button>
          <button class="card" data-act="journey"><span class="card-title">Journey</span><span class="card-sub">40 stages · 5 themes · mastery crowns</span></button>
          <button class="card" data-act="daily"><span class="card-title">Daily</span><span class="card-sub">one shared seed per UTC day · ranked locally</span></button>
          <button class="card" data-act="practice"><span class="card-title">Practice</span><span class="card-sub">any course, your difficulty · unranked</span></button>
          <button class="card" data-act="challenges"><span class="card-title">Challenges</span><span class="card-sub">restricted tools &amp; speed goals</span></button>
          <button class="card" data-act="show"><span class="card-title">Show</span><span class="card-sub">elimination rounds to a final · 12–16 racers</span></button>
          <button class="card" data-act="hosted" ${hostedOk ? '' : 'disabled'}><span class="card-title">Hosted play</span><span class="card-sub">${hostedOk ? 'private rooms &amp; quick join' : 'needs the hosted server'}</span></button>
        </div>
        <div class="row mt"><button data-act="back">Back</button></div>
      </div>`);
    this.onAction('learn', () => this.showLearn());
    this.onAction('journey', () => this.showJourney());
    this.onAction('daily', () => this.startDaily());
    this.onAction('practice', () => this.showPractice());
    this.onAction('challenges', () => this.showChallenges());
    this.onAction('show', () => this.showShowSetup());
    this.onAction('hosted', () => this.showHosted());
    this.onAction('back', () => this.showTitle());
  }

  showLearn() {
    const done = this.store.save.lessonsDone;
    const cards = LESSONS.map((l, i) => `
      <button class="card ${done[l.id] ? 'done' : ''}" data-lesson="${i}">
        <span class="card-title">${i + 1}. ${esc(l.title)}</span>
        <span class="card-sub">${esc(l.intro.slice(0, 60))}…</span>
      </button>`).join('');
    this.overlay(`
      <div class="panel" role="dialog" aria-labelledby="learn-h">
        <h1 id="learn-h">Learn</h1>
        <p class="muted">One rule at a time. Perform each action to advance.</p>
        <div class="card-grid mt">${cards}</div>
        <div class="row mt"><button data-act="back">Back</button></div>
      </div>`);
    el('screens').querySelectorAll('[data-lesson]').forEach(b =>
      b.addEventListener('click', () => { this.audio.event({ t: 'ui' }); this.startLesson(+b.dataset.lesson); }));
    this.onAction('back', () => this.showModes());
  }

  showJourney() {
    const save = this.store.save;
    const cards = JOURNEY.map((st) => {
      const id = 'j' + String(st.stage).padStart(2, '0');
      const locked = st.stage > save.journey.unlocked;
      const passed = !!save.journey.passed[id];
      const crown = !!save.journey.crowns[id];
      return `<button class="card ${locked ? 'locked' : ''} ${passed ? 'done' : ''} ${st.mastery ? 'mastery' : ''}" data-stage="${st.stage}" ${locked ? 'disabled' : ''}>
        <span class="card-title">${st.stage}. ${esc(st.name)}${crown ? ' ♛' : ''}</span>
        <span class="card-sub">${esc(themeById(st.theme).name)} · top ${st.passPlace} · ${st.mechanics.join(', ')}</span>
      </button>`;
    }).join('');
    this.overlay(`
      <div class="panel wide" role="dialog" aria-labelledby="journey-h">
        <h1 id="journey-h">Journey</h1>
        <p class="muted">Unlocked through stage ${save.journey.unlocked}. Mastery stages award ♛ crowns.</p>
        <div class="card-grid mt">${cards}</div>
        <div class="row mt"><button data-act="back">Back</button></div>
      </div>`);
    el('screens').querySelectorAll('[data-stage]').forEach(b =>
      b.addEventListener('click', () => { this.audio.event({ t: 'ui' }); this.startJourneyStage(+b.dataset.stage); }));
    this.onAction('back', () => this.showModes());
  }

  showPractice() {
    const options = [...JOURNEY.map(s => ({ id: s.id, name: `${s.stage}. ${s.name}` })), ...ARENAS.map(a => ({ id: a.id, name: a.name + ' (survival)' }))]
      .map(o => `<option value="${o.id}">${esc(o.name)}</option>`).join('');
    this.overlay(`
      <div class="panel" role="dialog" aria-labelledby="prac-h">
        <h1 id="prac-h">Practice</h1>
        <p class="muted">Unranked. Restart any time with Esc → Retry.</p>
        <div class="col mt">
          <label class="field"><span>Course</span><select id="prac-course">${options}</select></label>
          <label class="field"><span>Bot difficulty</span><select id="prac-skill">
            <option value="0.3">Gentle</option><option value="0.55" selected>Medium</option><option value="0.8">Fierce</option><option value="1.0">Probe-class</option>
          </select></label>
          <label class="field"><span>Rivals</span><select id="prac-bots">
            <option value="0">Solo</option><option value="3">3</option><option value="7" selected>7</option><option value="11">11</option>
          </select></label>
        </div>
        <div class="row mt">
          <button class="primary" data-act="go">Start</button>
          <button data-act="back">Back</button>
        </div>
      </div>`);
    this.onAction('go', () => this.startPractice(el('prac-course').value, +el('prac-skill').value, +el('prac-bots').value));
    this.onAction('back', () => this.showModes());
  }

  showChallenges() {
    const done = this.store.save.challengesDone;
    const cards = CHALLENGES.map(c => `
      <button class="card ${done[c.id] ? 'done' : ''}" data-chal="${c.id}">
        <span class="card-title">${esc(c.name)}</span>
        <span class="card-sub">${esc(c.desc)}</span>
      </button>`).join('');
    this.overlay(`
      <div class="panel" role="dialog" aria-labelledby="chal-h">
        <h1 id="chal-h">Challenges</h1>
        <div class="card-grid mt">${cards}</div>
        <div class="row mt"><button data-act="back">Back</button></div>
      </div>`);
    el('screens').querySelectorAll('[data-chal]').forEach(b =>
      b.addEventListener('click', () => { this.audio.event({ t: 'ui' }); this.startChallenge(b.dataset.chal); }));
    this.onAction('back', () => this.showModes());
  }

  showShowSetup() {
    const cards = SHOWS.map(s => `
      <button class="card" data-show="${s.id}">
        <span class="card-title">${esc(s.name)}</span>
        <span class="card-sub">${s.players} racers · ${s.rounds.length} rounds · ${s.rounds.map(r => r.quota).join(' → ')} qualify</span>
      </button>`).join('');
    this.overlay(`
      <div class="panel" role="dialog" aria-labelledby="show-h">
        <h1 id="show-h">Show</h1>
        <p class="muted">Survive each cut. The final is a survival arena — last tumbler standing wins.</p>
        <div class="card-grid mt">${cards}</div>
        <div class="row mt"><button data-act="back">Back</button></div>
      </div>`);
    el('screens').querySelectorAll('[data-show]').forEach(b =>
      b.addEventListener('click', () => { this.audio.event({ t: 'ui' }); this.startShow(b.dataset.show); }));
    this.onAction('back', () => this.showModes());
  }

  showHosted() {
    this.overlay(`
      <div class="panel" role="dialog" aria-labelledby="host-h">
        <h1 id="host-h">Hosted play</h1>
        <p class="muted">Rooms run on the authoritative server: it simulates the round and decides results. Reconnect any time — you will get a fresh snapshot.</p>
        <div class="col mt">
          <button class="primary" data-act="quick">Quick join (Quick Show)</button>
          <label class="field"><span>Room code</span><input id="room-code" maxlength="6" style="font:inherit;min-height:44px;background:#1c2440;color:#fff;border-radius:8px;border:1px solid rgba(255,255,255,0.25);text-transform:uppercase" aria-label="Room code"></label>
          <div class="row">
            <button data-act="join">Join room</button>
            <button data-act="create">Create room</button>
          </div>
        </div>
        <div id="hosted-status" class="mt small muted" role="status"></div>
        <div class="row mt"><button data-act="back">Back</button></div>
      </div>`);
    const status = () => el('hosted-status');
    const ensure = async () => {
      if (!this.hosted.connected) {
        status().textContent = 'Connecting…';
        try { await this.hosted.connect(); } catch (e) { status().textContent = 'Could not reach the host: ' + e.message; return false; }
      }
      return true;
    };
    this.hosted.onEvent = (msg) => this.handleHostedEvent(msg);
    this.onAction('quick', async () => { if (await ensure()) this.hosted.quickJoin(); });
    this.onAction('join', async () => { if (await ensure()) this.hosted.joinRoom(el('room-code').value.trim().toUpperCase()); });
    this.onAction('create', async () => { if (await ensure()) this.hosted.createRoom(null, 'show-quick'); });
    this.onAction('back', () => { this.hosted.leave(); this.showModes(); });
  }

  handleHostedEvent(msg) {
    const statusEl = el('hosted-status');
    switch (msg.t) {
      case 'joined':
        if (statusEl) statusEl.textContent = `In room ${msg.code} — ${msg.players} player(s). Waiting for host to start…`;
        if (el('host-h')) {
          const pane = el('screens').querySelector('.panel');
          if (pane && !pane.querySelector('[data-act="ready"]')) {
            const row = document.createElement('div');
            row.className = 'row mt';
            row.innerHTML = `<button class="primary" data-act="ready">Ready up</button>`;
            pane.appendChild(row);
            this.onAction('ready', () => this.hosted.setReady(true));
          }
        }
        break;
      case 'lobby':
        if (statusEl) statusEl.textContent = `Room ${msg.code}: ${msg.players.map(p => p.name + (p.ready ? ' ✓' : '')).join(', ')}`;
        break;
      case 'start':
        this.startHostedRound(msg);
        break;
      case 'snapshot':
        if (this.hostedRound) this.applyHostedSnapshot(msg);
        break;
      case 'result':
        if (statusEl) statusEl.textContent = 'Round over — results decided by the server.';
        break;
      case 'error':
        if (statusEl) statusEl.textContent = 'Host: ' + msg.error;
        break;
      case 'disconnected':
        if (statusEl) statusEl.textContent = 'Disconnected — reconnecting…';
        break;
    }
  }

  // Hosted rounds reuse the local renderer; the server stays authoritative.
  startHostedRound(msg) {
    const def = courseById(msg.courseId);
    if (!def) return;
    this.journeyCtx = null; this.challengeCtx = null; this.dailyCtx = null; this.showCtx = null;
    const roster = msg.roster.map(r => ({ ...r, isBot: r.isBot }));
    this.round = new LocalRound(def, roster, { quota: msg.quota, botSkill: 0.6 });
    this.hostedRound = { serverTick: 0 };
    this.resultsShown = false;
    this.scene.buildCourse(this.round.state.course, def.theme || 'cumulus');
    el('screens').innerHTML = '';
    el('hud').classList.remove('hidden');
    if ('ontouchstart' in window) el('touch-ui').classList.remove('hidden');
    el('hud-title').textContent = def.name || def.id;
    el('hud-goal').textContent = 'Hosted round — server is authoritative';
  }

  applyHostedSnapshot(msg) {
    // The server's tick/positions overwrite local display truth. The local
    // sim is only used for scene structure; positions follow the snapshot.
    if (!this.round) return;
    for (const sp of msg.players) {
      const p = this.round.state.players.find(pl => pl.id === sp.id);
      if (p) { p.px = p.x = sp.x; p.py = p.y = sp.y; p.pz = p.z = sp.z; p.st = sp.st; }
    }
    this.round.state.tick = msg.tick;
  }

  showPause() {
    this.overlay(`
      <div class="panel" role="dialog" aria-labelledby="pause-h">
        <h1 id="pause-h">Paused</h1>
        <div class="col mt">
          <button class="primary" data-act="resume">Resume</button>
          <button data-act="retry">Retry round</button>
          <button data-act="settings">Settings</button>
          <button data-act="help">Help</button>
          <button class="danger" data-act="quit">Leave round</button>
        </div>
      </div>`);
    this.onAction('resume', () => this.resumeRound());
    this.onAction('retry', () => { const ctx = this.lastRoundCtx; this.resumeRoundSilent(); ctx && ctx(); });
    this.onAction('settings', () => this.showSettings(() => this.showPause()));
    this.onAction('help', () => this.showHelp(() => this.showPause()));
    this.onAction('quit', () => this.endRoundTo(() => this.showModes()));
  }

  resumeRoundSilent() { el('screens').innerHTML = ''; }

  showSettings(back) {
    const s = this.settings;
    this.overlay(`
      <div class="panel" role="dialog" aria-labelledby="set-h">
        <h1 id="set-h">Settings</h1>
        <h2>Audio</h2>
        ${this.slider('set-music', 'Music', s.music)}
        ${this.slider('set-effects', 'Effects', s.effects)}
        ${this.slider('set-ambience', 'Ambience', s.ambience)}
        ${this.check('set-captions', 'Captions for sound cues', s.captions)}
        <h2>Graphics</h2>
        <label class="field"><span>Quality tier</span><select id="set-quality">
          ${['auto', 'high', 'medium', 'low'].map(q => `<option ${s.quality === q ? 'selected' : ''}>${q}</option>`).join('')}
        </select></label>
        ${this.check('set-shake', 'Camera shake', s.cameraShake)}
        <label class="field"><span>Camera</span><select id="set-camera">
          <option value="follow" ${s.camera === 'follow' ? 'selected' : ''}>follow</option>
          <option value="far" ${s.camera === 'far' ? 'selected' : ''}>far</option>
        </select></label>
        <h2>Accessibility</h2>
        ${this.check('set-rm', 'Reduced motion', s.reducedMotion)}
        ${this.check('set-hc', 'High contrast', s.highContrast)}
        <label class="field"><span>Color palette</span><select id="set-palette">
          ${['standard', 'deuteranopia', 'protanopia', 'tritanopia'].map(p => `<option ${s.palette === p ? 'selected' : ''}>${p}</option>`).join('')}
        </select></label>
        ${this.slider('set-text', 'Text size', s.textScale)}
        ${this.check('set-lefty', 'Left-handed touch controls', s.leftHanded)}
        <div class="row mt">
          <button class="primary" data-act="done">Done</button>
          <button data-act="replay-tutorial">Replay tutorial</button>
        </div>
      </div>`);
    const bind = (id, fn) => el(id).addEventListener('change', (e) => { fn(e.target); this.store.persist(); this.applySettings(); this.audio.event({ t: 'ui' }); });
    bind('set-music', t => s.music = +t.value);
    bind('set-effects', t => s.effects = +t.value);
    bind('set-ambience', t => s.ambience = +t.value);
    bind('set-captions', t => s.captions = t.checked);
    bind('set-quality', t => s.quality = t.value);
    bind('set-shake', t => s.cameraShake = t.checked);
    bind('set-camera', t => s.camera = t.value);
    bind('set-rm', t => s.reducedMotion = t.checked);
    bind('set-hc', t => s.highContrast = t.checked);
    bind('set-palette', t => s.palette = t.value);
    bind('set-text', t => s.textScale = +t.value);
    bind('set-lefty', t => s.leftHanded = t.checked);
    this.onAction('done', () => back());
    this.onAction('replay-tutorial', () => this.startLesson(0));
  }

  slider(id, label, v) {
    return `<label class="field"><span>${label}</span><input type="range" id="${id}" min="0" max="1" step="0.05" value="${v}" aria-label="${label}"></label>`;
  }
  check(id, label, v) {
    return `<label class="field"><span>${label}</span><input type="checkbox" id="${id}" ${v ? 'checked' : ''} aria-label="${label}"></label>`;
  }

  showHelp(back) {
    this.overlay(`
      <div class="panel" role="dialog" aria-labelledby="help-h">
        <h1 id="help-h">How to play</h1>
        <h2>Goal</h2>
        <p>Race to the finish gate before the cutoff. Green rings are checkpoints — falling returns you to your last ring. In survival arenas, stay on the disc: last tumbler standing wins.</p>
        <h2>Controls</h2>
        <table class="score" aria-label="Controls">
          <tr><td>Move</td><td>W A S D / arrows / left stick / touch stick</td></tr>
          <tr><td>Jump</td><td>Space / K / gamepad A / Jump button</td></tr>
          <tr><td>Dive</td><td>Shift / L / gamepad B / Dive button</td></tr>
          <tr><td>Pause</td><td>Esc / P / gamepad Start</td></tr>
        </table>
        <h2>Rules cards</h2>
        <p>Jump clears gaps up to ~3.5m. Dive mid-air to lunge across wider gaps — you need a moment to get up after landing. Spinning bars, swinging hammers, pistons and bumpers knock you flying; weave walls only open where the gap is. Conveyor belts and fans push you — lean against them. After a hit you flash briefly: nothing can knock you again during the flash.</p>
        <h2>Fair play</h2>
        <p>Every course is seeded and every round records a deterministic replay, verified on the results screen. Ties break on objective progress, fewer invalid actions, then elapsed time.</p>
        <div class="row mt"><button class="primary" data-act="done">Done</button></div>
      </div>`);
    this.onAction('done', () => back());
  }

  // ====================================================================
  // settings application / announcements / captions
  // ====================================================================
  applySettings() {
    const s = this.settings;
    document.body.classList.toggle('hc', !!s.highContrast);
    document.documentElement.style.setProperty('--font-scale', s.textScale || 1);
    el('touch-ui').classList.toggle('lefty', !!s.leftHanded);
    this.audio.setVolume('music', s.music);
    this.audio.setVolume('effects', s.effects);
    this.audio.setVolume('ambience', s.ambience);
    this.audio.setCaptions(!!s.captions);
    this.scene.reducedMotion = !!s.reducedMotion;
    this.scene.camShake = s.cameraShake !== false;
    this.scene.cameraMode = s.camera || 'follow';
    const tier = s.quality === 'auto' ? this.autoQuality() : s.quality;
    this.scene.setQuality(tier);
    if (this.scene.palette !== s.palette) {
      this.scene.palette = s.palette;
      // rebuild to apply palette colors
      if (this.round) this.scene.buildCourse(this.round.state.course, this.round.def.theme || 'cumulus');
    }
  }

  autoQuality() {
    const mobile = /Android|iPhone|iPad/i.test(navigator.userAgent) || (navigator.hardwareConcurrency || 8) <= 4;
    if (mobile) return this.fps < 45 ? 'low' : 'medium';
    return this.fps < 45 ? 'medium' : 'high';
  }

  announceText(text, urgent = false) {
    const region = urgent ? el('live-urgent') : el('live');
    region.textContent = '';
    requestAnimationFrame(() => { region.textContent = text; });
  }

  showCaption(text) {
    if (!this.settings.captions) return;
    const c = el('captions');
    c.textContent = '♪ ' + text;
    c.classList.remove('hidden');
    clearTimeout(this.captionTimer);
    this.captionTimer = setTimeout(() => c.classList.add('hidden'), 1400);
  }

  profileName() { return 'You'; }

  persistStats() { this.store.persist(); }
}

function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
