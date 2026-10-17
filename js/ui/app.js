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
import { PRESETS, CATEGORIES, presetTier, choosePreset } from '../render/gfx.js';
import { gfxStrings } from './gfxStrings.js';
import { platformStrings } from './platformStrings.js';
import { t, tn, locale, onLanguage, applyDom, courseName, themeName, mechanicName, lessonText, playerName } from './i18n.js';

const $ = (sel) => document.querySelector(sel);
const el = (id) => document.getElementById(id);

// English names/descriptions; the shown text comes from strings.js (achievements group).
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

// Keyboard actions — declared as control.* lines in starhermit.txt; hosted
// players may override them on StarHermit.
export const DEFAULT_BINDINGS = {
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  jump: ['Space', 'KeyK'],
  dive: ['ShiftLeft', 'ShiftRight', 'KeyL'],
  pause: ['Escape', 'KeyP'],
};
const KEY_GLYPHS = { ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Escape: 'Esc', ShiftLeft: 'Shift', ShiftRight: 'Right Shift' };
function keyLabel(code) {
  if (KEY_GLYPHS[code]) return KEY_GLYPHS[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  return code;
}
// Player preferences mirrored to the StarHermit settings KV.
const SYNCED_SETTINGS = ['music', 'effects', 'ambience', 'voice', 'gfx', 'reducedMotion', 'highContrast', 'palette',
  'textScale', 'leftHanded', 'cameraShake', 'captions', 'camera', 'showFps'];

export class App {
  constructor({ scene, audio, store, save, hosted, platform }) {
    this.scene = scene;
    this.audio = audio;
    this.store = store;   // { save, persist() }
    this.hosted = hosted;
    this.platform = platform; // StarHermit adapter; offline no-ops without a token
    this.screen = 'title';
    this.round = null;
    this.show = null;
    this.keys = {};          // action -> held
    this.setBindings(DEFAULT_BINDINGS);
    this.pt = platformStrings(locale());
    this.touch = { active: false, mx: 0, mz: 0, jump: false, dive: false };
    this.lastFocus = null;
    this.frame = this.frame.bind(this);
    this.prevTime = 0;
    this.announce = '';
    this.captionTimer = null;
    this.showFps = false;
    this.fps = 60;
    audio.onCaption = (key) => this.showCaption(t(key));
    this.redraw = null;   // re-renders the current menu screen in a new language
  }

  get settings() { return this.store.save.settings; }

  // ====================================================================
  // boot + main loop
  // ====================================================================
  start() {
    this.bindInput();
    this.applySettings();
    onLanguage(() => this.relocalize());
    if (this.platform) {
      this.platform.onStatus = () => this.renderAccountLine();
      this.platform.onAuthChange = () => {
        this.toast(this.pt('signedOut'));
        if (el('title-h')) this.showTitle();
      };
    }
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
      // lesson "hold forward" steps must not tick while the round is paused
      const lessonEv = this.round.paused ? null : this.round.pollLessonInput();
      if (lessonEv) evs.push(lessonEv);
      for (const e of evs) this.handleRoundEvent(e);
      if (this.round.invalidFlash) {
        this.announceText(t(INVALID_KEYS[this.round.invalidFlash] || 'capInvalid'), true);
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
      const action = this.codeAction[e.code];
      if (action) this.keys[action] = true;
      if (action === 'pause') { this.togglePause(); e.preventDefault(); }
      // keep gameplay keys from scrolling the page while a round is running,
      // but never steal them from a focused control (space activates buttons)
      const onControl = e.target && e.target.closest && e.target.closest('button, input, select, textarea, a[href]');
      if (this.round && !onControl && action && action !== 'pause' && action !== 'dive') e.preventDefault();
      if (e.key === ' ' || e.key === 'Enter') this.audio.start();
    });
    window.addEventListener('keyup', (e) => {
      const action = this.codeAction[e.code];
      if (action) this.keys[action] = false;
    });
    window.addEventListener('blur', () => { this.keys = {}; });
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
    // the lesson banner sits below the HUD, whose height depends on wrapping
    {
      const hud = el('hud');
      const sync = () => document.documentElement.style.setProperty('--hud-h', (hud.classList.contains('hidden') ? 0 : hud.offsetHeight) + 'px');
      if (typeof ResizeObserver === 'function') new ResizeObserver(sync).observe(hud);
      new MutationObserver(sync).observe(hud, { attributes: true, attributeFilter: ['class'] });
      window.addEventListener('resize', sync);
      sync();
    }
    const zone = el('stick-zone'), base = el('stick-base'), nub = el('stick-nub');
    let stickId = null, origin = null;
    const hint = el('stick-hint');
    zone.addEventListener('pointerdown', (e) => {
      stickId = e.pointerId; origin = { x: e.clientX, y: e.clientY };
      zone.setPointerCapture(e.pointerId);
      base.classList.add('active');
      base.style.bottom = 'auto';
      // client/rect coords are visual px; the zoomed touch layer wants layout px
      const zr = zone.getBoundingClientRect(), k = window.UIScale?.value || 1;
      base.style.left = ((e.clientX - zr.left) / k - 55) + 'px';
      base.style.top = ((e.clientY - zr.top) / k - 55) + 'px';
      if (hint) hint.classList.add('hidden'); // first drag: the cue has done its job
      this.audio.start();
    });
    zone.addEventListener('pointermove', (e) => {
      if (e.pointerId !== stickId || !origin) return;
      const k = window.UIScale?.value || 1;
      const dx = (e.clientX - origin.x) / (45 * k), dy = (e.clientY - origin.y) / (45 * k);
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
      // return to the resting spot so the stick is always discoverable
      base.classList.remove('active');
      base.style.left = ''; base.style.top = ''; base.style.bottom = '';
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
    if (this.keys.left) mx -= 1;
    if (this.keys.right) mx += 1;
    if (this.keys.forward) mz += 1;
    if (this.keys.back) mz -= 0.6;
    if (this.touch.mx || this.touch.mz) { mx = this.touch.mx; mz = this.touch.mz; }
    if (this.padMove && (this.padMove.mx || this.padMove.mz)) { mx = this.padMove.mx; mz = this.padMove.mz; }
    const m = Math.hypot(mx, mz);
    if (m > 1) { mx /= m; mz /= m; }
    return { mx, mz };
  }

  readActionInput() {
    return {
      jump: !!(this.keys.jump || this.touch.jump || (this.padButtons && this.padButtons.jump)),
      dive: !!(this.keys.dive || this.touch.dive || (this.padButtons && this.padButtons.dive)),
    };
  }

  // ====================================================================
  // round lifecycle
  // ====================================================================
  startRound(def, opts = {}) {
    const botCount = opts.bots != null ? opts.bots : 7;
    const roster = opts.roster || buildRoster(this.profileName(), PALETTE[0], botCount, def.seed % 23);
    this.roundDef = def;
    this.roundGoal = opts.goalText || null;   // thunk → string (re-read on a language change)
    this.lessonBanner = false;
    this.youDefault = !(this.platform && this.platform.nickname) && !opts.roster;
    this.round = new LocalRound(def, roster, {
      quota: opts.quota != null ? opts.quota : Math.max(1, Math.ceil((botCount + 1) / 2)),
      botSkill: opts.botSkill != null ? opts.botSkill : 0.55,
      seedOverride: opts.seedOverride,
      lesson: opts.lesson, mods: opts.mods, goal: opts.goal,
      timeLimit: opts.timeLimit,
    });
    this.resultsShown = false;
    this.hostedRound = null;   // solo rounds never talk to the host
    this.scene.buildCourse(this.round.state.course, def.theme || 'cumulus');
    this.scene.ensurePlayers(this.round.state.players);
    const theme = themeById(def.theme || 'cumulus');
    this.audio.setMusicTheme(theme.music);
    this.audio.setAmbienceTone(theme.ambHz || 500);
    el('screens').innerHTML = '';
    el('hud').classList.remove('hidden');
    el('countdown').classList.remove('hidden');
    if ('ontouchstart' in window) el('touch-ui').classList.remove('hidden');
    if (opts.lesson) el('lesson-banner').classList.remove('hidden');
    this.renderRoundText();
    this.announceText(t('roundStarting', { name: courseName(def) || t('round'), goal: el('hud-goal').textContent }));
    this.persistStats();
  }

  /** HUD title/goal/cutoff and the lesson banner in the current language. */
  renderRoundText() {
    const r = this.round, def = this.roundDef;
    if (!r || !def) return;
    el('hud-title').textContent = courseName(def);
    if (this.hostedRound) { el('hud-goal').textContent = t('hostedGoal'); return; }
    el('hud-goal').textContent = this.roundGoal ? this.roundGoal()
      : def.kind === 'survival' ? t('goalSurvive') : t('goalReach', { n: r.state.quota });
    el('hud-quota').textContent = def.kind === 'survival' ? '' : t('cutoff', { n: r.state.quota, total: r.state.players.length });
    if (r.lesson) {
      // The intro shows until the first lesson-step event, then the current step.
      const st = r.currentLessonStep();
      el('lesson-banner').textContent = !this.lessonBanner ? lessonText(r.lesson.id, r.lesson.intro)
        : st ? this.lessonText(r.lesson, st) : t('lessonComplete');
    }
  }

  /**
   * The game language changed (Settings → Language, or the account preference
   * arrived): static markup is re-applied; re-render what this class built —
   * the current menu screen (Settings relabels in place so the shared panel
   * and its Language select stay mounted), HUD, banner, captions targets —
   * without touching the round or the dev-server socket.
   */
  relocalize() {
    this.pt = platformStrings(locale());
    const you = this.round && this.round.state.players.find((p) => p.id === 'you');
    if (you && this.youDefault) {
      you.name = t('you');
      this.scene.setPlayerName && this.scene.setPlayerName(you.id, you.name, you.color);
      const sr = this.show && this.show.roster.find((r) => r.id === 'you');
      if (sr) sr.name = you.name;
    }
    this.renderRoundText();
    if (this.round) this.updateHUD();
    if (el('set-h') || el('host-h')) {
      applyDom(el('screens'));
      this.renderGraphicsSection();
    } else if (this.redraw && el('screens').firstElementChild) {
      this.redraw();
    }
  }

  endRoundTo(screenFn) {
    this.round = null;
    this.show = null;
    this.clearRoundChrome();
    screenFn();
  }

  // Hide every in-round overlay. Menus call this too, because results-screen
  // follow-ups (e.g. "Back to title", "Challenges") jump straight to a menu
  // and would otherwise leave the HUD and touch controls on top of it.
  clearRoundChrome() {
    this.hostedRound = null;
    el('hud').classList.add('hidden');
    el('countdown').classList.add('hidden');
    el('lesson-banner').classList.add('hidden');
    el('touch-ui').classList.add('hidden');
  }

  // Leaving a round for a menu screen: drop the session and its chrome.
  leaveRound() {
    if (this.round) this.round = null;
    this.show = null;
    this.clearRoundChrome();
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
      case 'go': el('countdown').textContent = t('go'); this.audio.event({ t: 'go' }); setTimeout(() => el('countdown').classList.add('hidden'), 700); break;
      case 'lesson-step': {
        const st = this.round.currentLessonStep();
        this.lessonBanner = true;
        el('lesson-banner').textContent = st ? this.lessonText(this.round.lesson, st) : t('lessonComplete');
        this.audio.event({ t: 'checkpoint' });
        this.announceText(st ? this.lessonText(this.round.lesson, st) : t('lessonCompleteShort'));
        break;
      }
      default:
        this.audio.event(e, this.round.state.tick + (e.p === this.round.localId ? 7 : 1));
        this.scene.onEvent(e, this.round.localId);
        if (e.t === 'checkpoint' && e.p === this.round.localId) this.announceText(t('checkpointOf', { cp: e.cp, of: e.of }));
        if (e.t === 'finish' && e.p === this.round.localId) this.announceText(t('finishedPlace', { place: e.place }));
        if (e.t === 'out' && e.p === this.round.localId) this.announceText(t('youAreOut'), true);
    }
  }

  lessonText(lesson, step) {
    return lessonText(lesson.id + '.' + step.id, step.text)
      .replace('{move}', t('moveKeys'))
      .replace('{jump}', t('jumpKeys'))
      .replace('{dive}', t('diveKeys'));
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
      el('hud-place').textContent = me.st === PSTATE.FINISH ? t('finishedN', { n: me.finishTick >= 0 ? s.finishOrder.indexOf(me.id) + 1 : '—' }) : t('placeOf', { place, total: s.players.length });
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
      // hosted rounds: the server owns the sim, so the same input also goes
      // upstream. Commands must target a future tick (the current one is
      // already committed), and buttons are edge-triggered like locally.
      if (this.hostedRound && this.hosted && this.hosted.connected) {
        const prev = this.hostedRound.prev || { jump: false, dive: false };
        this.hosted.sendInput(this.round.state.tick + 3, mv.mx, mv.mz,
          ac.jump && !prev.jump, ac.dive && !prev.dive);
        this.hostedRound.prev = { jump: ac.jump, dive: ac.dive };
      }
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
        this.announceText(t('achievementUnlocked', { name: tn('achievements', key, [ACHIEVEMENTS[key].name])[0] }), true);
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
      this.streak = (this.streak || 0) + 1;
      save.stats.bestStreak = Math.max(save.stats.bestStreak || 0, this.streak);
      if (this.streak >= 3) unlock('streak_3');
    } else this.streak = 0;

    // Headline and next-action label are thunks so the results screen re-renders in a new language.
    let headline, nextAction = null;
    if (r.lesson) {
      const done = r.lessonDone();
      const lesson = r.lesson;
      headline = () => t(done ? 'lessonDoneH' : 'lessonKeepH', { lesson: tn('lessons', lesson.id, lesson.title) });
      if (done) {
        save.lessonsDone[r.lesson.id] = true;
        if (LESSONS.every(l => save.lessonsDone[l.id])) unlock('lesson_grad');
        const idx = LESSONS.indexOf(r.lesson);
        if (idx < LESSONS.length - 1) nextAction = { label: () => t('nextLesson'), fn: () => this.startLesson(idx + 1) };
      }
    } else if (this.challengeCtx) {
      const out = r.challengeOutcome();
      const ch = this.challengeCtx;
      headline = () => (out.won ? t('challengeCleared', { name: tn('challenges', ch.id, ch.name) })
        : t('challengeOutcome', { name: tn('challenges', ch.id, ch.name), desc: outcomeText(out) }));
      if (out.won) save.challengesDone[this.challengeCtx.id] = true;
      nextAction = { label: () => t('challengesH'), fn: () => this.showChallenges() };
    } else if (this.dailyCtx) {
      headline = () => (me.qualified ? t('dailyQualified') : t('dailyEliminated'));
      const d = utcDateString();
      if (!save.daily[d] || me.total > save.daily[d]) save.daily[d] = me.total;
      if (Object.keys(save.daily).length >= 5) unlock('daily_regular');
      nextAction = { label: () => t('backToTitle'), fn: () => this.showTitle() };
    } else if (this.journeyCtx) {
      const n = this.journeyCtx.stage;
      const st = this.journeyCtx;
      const passed = me.place <= (this.journeyCtx.passPlace || 4) && me.finished;
      headline = () => (passed ? t('stagePassed', { name: courseName(st), place: me.place })
        : t('stageFailed', { name: courseName(st), place: me.place, n: st.passPlace }));
      if (passed) {
        save.journey.passed['j' + String(n).padStart(2, '0')] = me.total;
        save.journey.unlocked = Math.max(save.journey.unlocked, Math.min(40, n + 1));
        if (this.journeyCtx.mastery) { save.journey.crowns['j' + String(n).padStart(2, '0')] = true; unlock('mastery_crown'); }
        if (Object.keys(save.journey.passed).length >= 20) unlock('halfway');
        if (n < 40) nextAction = { label: () => t('stageN', { n: n + 1 }), fn: () => this.startJourneyStage(n + 1) };
      } else {
        nextAction = { label: () => t('retry'), fn: () => this.startJourneyStage(n) };
      }
    } else if (this.showCtx) {
      headline = () => (me.qualified ? t('qualified') : t('eliminated'));
    } else {
      headline = () => (me.finished ? t('finishedN', { n: me.place }) : t('placedN', { n: me.place }));
    }

    this.store.persist();
    this.postToLeaderboard(me.total);
    this.showResultsScreen({ headline, res, me, breakdown, nextAction });
  }

  // Signed in only: post a finished local round against the AI (not lessons or
  // dev-server rooms) to the platform high-score board; results show the rank.
  postToLeaderboard(total) {
    this.lbText = null;
    const token = this.lbToken = {};
    if (!this.platform || !this.platform.active || this.round.lesson || this.hostedRound) return;
    this.lbText = () => this.pt('lbPosting');
    this.platform.submitScore(Math.max(0, total)).then((r) => {
      if (token !== this.lbToken) return;
      this.lbText = () => (!r.posted ? this.pt('lbFailed') : r.rank ? this.pt('lbRank', { rank: r.rank }) : this.pt('lbPosted'));
      const el = document.getElementById('results-lb');
      if (el) el.textContent = this.lbText();
    });
  }

  showResultsScreen(spec) {
    const { headline, res, me, breakdown, nextAction } = spec;
    this.redraw = () => this.showResultsScreen(spec);
    const rows = res.places.map((id) => {
      const r = res.results[id];
      const p = this.round.state.players.find(pl => pl.id === id);
      return `<tr class="${id === this.round.localId ? 'you' : ''} ${r.qualified ? 'qual' : ''}">
        <td>${r.place}. ${esc(p ? playerName(p.name) : id)}</td>
        <td>${r.finished ? formatTicks(r.finishTick) : (this.round.state.kind === 'survival' ? esc(t('alive', { time: formatTicks(r.aliveTicks) })) : esc(t('dnf')))}</td>
        <td>${r.total}</td></tr>`;
    }).join('');
    const replayCheck = spec.replayCheck || (spec.replayCheck = this.round.verifyReplay());
    const row = (key, v) => `<tr><td>${esc(t(key))}</td><td>${v}</td></tr>`;
    this.overlay(`
      <div class="panel" role="dialog" aria-labelledby="res-h">
        <h1 id="res-h">${esc(headline())}</h1>
        <h2>${esc(t('scoreBreakdown'))}</h2>
        <table class="score" aria-label="${esc(t('ariaScoreComponents'))}">
          ${row('checkpoints', breakdown.checkpoints)}
          ${row('placement', breakdown.placement)}
          ${row('qualifyBonus', breakdown.qualify)}
          ${row('timeBonus', breakdown.timeBonus)}
          ${row('survival', breakdown.survival)}
          ${row('fallsPenalty', breakdown.falls)}
          <tr><th>${esc(t('total'))}</th><th>${me.total}</th></tr>
        </table>
        <h2>${esc(t('standings'))}</h2>
        <table class="score" aria-label="${esc(t('ariaStandings'))}"><tr><th>${esc(t('colPlayer'))}</th><th>${esc(t('colResult'))}</th><th>${esc(t('colScore'))}</th></tr>${rows}</table>
        ${this.lbText != null ? `<p id="results-lb" aria-live="polite">${esc(this.lbText())}</p>` : ''}
        <p class="small muted">${esc(replayCheck.ok ? t('replayOk', { seed: this.round.def.seed }) : t('replayBad', { reason: replayCheck.reason, seed: this.round.def.seed }))}</p>
        <div class="row mt">
          ${nextAction ? `<button class="primary" data-act="next">${esc(nextAction.label())}</button>` : ''}
          <button data-act="retry">${esc(t('retry'))}</button>
          ${this.showCtx ? `<button data-act="continue-show">${esc(t('continueShow'))}</button>` : ''}
          <button data-act="menu">${esc(t('modeSelect'))}</button>
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
      // the banner carries the instruction; the HUD keeps a short goal line
      goalText: () => t('goalLesson', { title: tn('lessons', lesson.id, lesson.title) }),
    });
  }

  startJourneyStage(n) {
    const st = JOURNEY[n - 1];
    if (!st) return this.showJourney();
    this.journeyCtx = st; this.challengeCtx = null; this.dailyCtx = null; this.showCtx = null;
    this.lastRoundCtx = () => this.startJourneyStage(n);
    this.startRound(st, {
      bots: st.bots.count, botSkill: st.bots.skill, quota: st.passPlace,
      goalText: () => t('goalStage', { name: courseName(st), n: st.passPlace }) + (st.mastery ? t('masteryStage') : ''),
    });
  }

  startDaily() {
    const d = utcDateString();
    if (isDailyExcluded(d)) { this.announceText(t('dailyExcluded'), true); return; }
    const def = dailyDef(d);
    this.dailyCtx = { date: d }; this.journeyCtx = null; this.challengeCtx = null; this.showCtx = null;
    this.lastRoundCtx = () => this.startDaily();
    this.startRound(def, {
      bots: 9, botSkill: 0.6, quota: 4,
      goalText: () => t('goalDaily', { date: d, seed: def.seed, v: DAILY_RULESET }),
    });
  }

  startPractice(courseId, skill, bots) {
    const def = courseById(courseId) || JOURNEY[0];
    this.journeyCtx = null; this.challengeCtx = null; this.dailyCtx = null; this.showCtx = null;
    this.lastRoundCtx = () => this.startPractice(courseId, skill, bots);
    this.startRound(def, {
      bots, botSkill: skill, quota: Math.max(1, Math.ceil((bots + 1) / 2)),
      goalText: () => t('goalPractice'),
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
      mods: ch.mods, goal: ch.goal, goalText: () => tn('challengeDesc', ch.id, ch.desc),
    });
  }

  startShow(showId) {
    const def = showById(showId);
    if (!def) return;
    this.showCtx = def; this.journeyCtx = null; this.challengeCtx = null; this.dailyCtx = null;
    const roster = buildRoster(this.profileName(), PALETTE[0], def.players - 1, 7);
    this.show = createShow(def, roster);
    this.showYouDefault = !(this.platform && this.platform.nickname);
    this.playShowRound();
  }

  playShowRound() {
    const round = currentRound(this.show);
    const courseDef = courseById(round.courseId);
    const aliveRoster = this.show.roster.filter(r => this.show.aliveIds.includes(r.id));
    const youDefault = this.showYouDefault;
    this.lastRoundCtx = () => this.playShowRound();
    const showDef = this.showCtx, n = this.show.roundIndex + 1, final = isFinalRound(this.show);
    // survival final: only the last tumbler qualifies
    this.startRound(courseDef, {
      quota: Math.min(round.quota, aliveRoster.length), botSkill: this.showCtx.botSkill,
      roster: aliveRoster,
      goalText: () => t(final ? 'goalShowFinal' : 'goalShowRound', { show: tn('shows', showDef.id, showDef.name), n, total: showDef.rounds.length, quota: round.quota }),
    });
    this.youDefault = youDefault;
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
      const showDef = this.showCtx;
      const draw = () => {
        const rowsHtml = table.map(r => `<tr class="${r.id === 'you' ? 'you' : ''}">
          <td>${r.champion ? '👑 ' : ''}${esc(playerName(r.name))}</td><td>${r.points}</td><td>${r.rounds.join(', ') || '—'}</td></tr>`).join('');
        this.overlay(`
          <div class="panel" role="dialog" aria-labelledby="show-h">
            <h1 id="show-h">${esc(champ ? t('champion') : eliminated ? t('eliminatedShowOver') : t('showOver', { show: tn('shows', showDef.id, showDef.name) }))}</h1>
            <p class="muted">${esc(t('showPlaced', { place: you ? table.indexOf(you) + 1 : '—', points: you ? you.points : 0 }))}</p>
            <table class="score"><tr><th>${esc(t('colPlayer'))}</th><th>${esc(t('colPoints'))}</th><th>${esc(t('colRounds'))}</th></tr>${rowsHtml}</table>
            <div class="row mt">
              <button class="primary" data-act="menu">${esc(t('modeSelect'))}</button>
              <button data-act="title">${esc(t('titleBtn'))}</button>
            </div>
          </div>`);
        this.onAction('menu', () => this.endRoundTo(() => this.showModes()));
        this.onAction('title', () => this.endRoundTo(() => this.showTitle()));
      };
      this.redraw = draw;
      draw();
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
    // focusing must not scroll a tall panel (settings, results) past its heading
    if (first) first.focus({ preventScroll: true });
    for (const n of el('screens').querySelectorAll('.screen, .panel')) n.scrollTop = 0;
  }

  onAction(act, fn) {
    const b = el('screens').querySelector(`[data-act="${act}"]`);
    if (b) b.addEventListener('click', () => { this.audio.event({ t: 'ui' }); fn(); });
  }

  showTitle() {
    this.endlessCleanup();
    this.redraw = () => this.showTitle();
    const save = this.store.save;
    const journeyDone = Object.keys(save.journey.passed).length;
    const d = utcDateString();
    const dailyBest = save.daily[d];
    this.overlay(`
      <div class="panel transparent-panel center" role="dialog" aria-labelledby="title-h">
        <h1 class="title-logo" id="title-h">Tumble <em>Circuit</em></h1>
        <p class="title-sub">${esc(t('tagline'))}</p>
        <p class="small muted" id="account-line" role="status"></p>
        <div class="col mt">
          <button class="primary" data-act="play">${esc(t('play'))}</button>
          <div class="row" style="justify-content:center">
            <button data-act="daily">${esc(dailyBest ? t('dailyBest', { n: dailyBest }) : t('dailyChallenge'))}</button>
            <button data-act="journey">${esc(t('journeyN', { n: journeyDone }))}</button>
            <button data-act="learn">${esc(t('learn'))}</button>
          </div>
          <div class="row" style="justify-content:center">
            <button data-act="settings">${esc(t('settings'))}</button>
            <button data-act="help">${esc(t('help'))}</button>
            ${this.platform && this.platform.canSignIn() ? `<button data-act="signin" id="btn-signin">${esc(this.pt('signIn'))}</button>` : ''}
            ${this.platform && this.platform.active && this.platform.inviteLink() ? `<button data-act="invite" id="btn-invite">${esc(this.pt('invite'))}</button>` : ''}
          </div>
        </div>
        <p class="small muted mt">${esc('ontouchstart' in window ? t('touchHint') : t('keysHint', { move: this.keysFor('forward', 'left', 'back', 'right'), jump: this.keysFor('jump'), dive: this.keysFor('dive'), pause: this.keysFor('pause') }))}</p>
      </div>`);
    this.onAction('play', () => this.showModes());
    this.onAction('daily', () => this.startDaily());
    this.onAction('journey', () => this.showJourney());
    this.onAction('learn', () => this.showLearn());
    this.onAction('settings', () => this.showSettings(() => this.showTitle()));
    this.onAction('help', () => this.showHelp(() => this.showTitle()));
    this.onAction('signin', () => this.platform.signIn());
    this.onAction('invite', () => this.copyInvite());
    this.renderAccountLine();
    if (!this.attractState) this.buildAttract();
  }

  buildAttract() {
    // scenic backdrop behind the title: a show course, slow camera drift
    if (!this.scene.ok) return;
    const def = courseById('show-ridge');
    if (!def) return;
    this.scene.buildAttractCourse(def);
    this.audio.setAmbienceTone(themeById(def.theme || 'cumulus').ambHz || 500);
    this.attractState = { t: 0 };
  }

  endlessCleanup() { this.leaveRound(); this.attractState = null; }

  showModes() {
    this.leaveRound();
    // The custom-protocol /ws rooms belong to this game's own dev server
    // (server.js). They have no StarHermit platform endpoint, so on-platform
    // the card is honestly disabled rather than promising rooms that cannot
    // connect.
    const platformHosted = !!(this.platform && this.platform.active);
    const hostedOk = this.hosted && this.hosted.available && !platformHosted;
    this.redraw = () => this.showModes();
    const hostedSub = hostedOk ? t('hostedSubOk') : platformHosted ? t('hostedSubPlatform') : t('hostedSubNone');
    const card = (act, title, sub, attrs = '') =>
      `<button class="card" data-act="${act}" ${attrs}><span class="card-title">${esc(t(title))}</span><span class="card-sub">${esc(sub)}</span></button>`;
    this.overlay(`
      <div class="panel" role="dialog" aria-labelledby="modes-h">
        <h1 id="modes-h">${esc(t('modesH'))}</h1>
        <div class="card-grid mt">
          ${card('learn', 'learn', t('learnSub'))}
          ${card('journey', 'journey', t('journeySub'))}
          ${card('daily', 'daily', t('dailySub'))}
          ${card('practice', 'practice', t('practiceSub'))}
          ${card('challenges', 'challengesH', t('challengesSub'))}
          ${card('show', 'show', t('showSub'))}
          ${card('hosted', 'hostedPlay', hostedSub, hostedOk ? '' : 'disabled')}
        </div>
        <div class="row mt"><button data-act="back">${esc(t('back'))}</button></div>
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
    this.leaveRound();
    this.redraw = () => this.showLearn();
    const done = this.store.save.lessonsDone;
    const cards = LESSONS.map((l, i) => `
      <button class="card ${done[l.id] ? 'done' : ''}" data-lesson="${i}">
        <span class="card-title">${i + 1}. ${esc(tn('lessons', l.id, l.title))}</span>
        <span class="card-sub">${esc(lessonText(l.id, l.intro))}</span>
      </button>`).join('');
    this.overlay(`
      <div class="panel" role="dialog" aria-labelledby="learn-h">
        <h1 id="learn-h">${esc(t('learn'))}</h1>
        <p class="muted">${esc(t('learnSubtitle'))}</p>
        <div class="card-grid mt">${cards}</div>
        <div class="row mt"><button data-act="back">${esc(t('back'))}</button></div>
      </div>`);
    el('screens').querySelectorAll('[data-lesson]').forEach(b =>
      b.addEventListener('click', () => { this.audio.event({ t: 'ui' }); this.startLesson(+b.dataset.lesson); }));
    this.onAction('back', () => this.showModes());
  }

  showJourney() {
    this.leaveRound();
    this.redraw = () => this.showJourney();
    const save = this.store.save;
    const cards = JOURNEY.map((st) => {
      const id = 'j' + String(st.stage).padStart(2, '0');
      const locked = st.stage > save.journey.unlocked;
      const passed = !!save.journey.passed[id];
      const crown = !!save.journey.crowns[id];
      return `<button class="card ${locked ? 'locked' : ''} ${passed ? 'done' : ''} ${st.mastery ? 'mastery' : ''}" data-stage="${st.stage}" ${locked ? 'disabled' : ''}>
        <span class="card-title">${st.stage}. ${esc(courseName(st))}${crown ? ' ♛' : ''}</span>
        <span class="card-sub">${esc(themeName(st.theme, themeById(st.theme).name))} · ${esc(t('topN', { n: st.passPlace }))} · ${esc(st.mechanics.map(mechanicName).join(', '))}</span>
      </button>`;
    }).join('');
    this.overlay(`
      <div class="panel wide" role="dialog" aria-labelledby="journey-h">
        <h1 id="journey-h">${esc(t('journey'))}</h1>
        <p class="muted">${esc(t('journeyUnlocked', { n: save.journey.unlocked }))}</p>
        <div class="card-grid mt">${cards}</div>
        <div class="row mt"><button data-act="back">${esc(t('back'))}</button></div>
      </div>`);
    el('screens').querySelectorAll('[data-stage]').forEach(b =>
      b.addEventListener('click', () => { this.audio.event({ t: 'ui' }); this.startJourneyStage(+b.dataset.stage); }));
    this.onAction('back', () => this.showModes());
  }

  showPractice() {
    this.leaveRound();
    // Re-rendering keeps the player's current picks.
    const keep = { course: el('prac-course')?.value, skill: el('prac-skill')?.value ?? '0.55', bots: el('prac-bots')?.value ?? '7' };
    this.redraw = () => this.showPractice();
    const options = [...JOURNEY.map(s => ({ id: s.id, name: `${s.stage}. ${courseName(s)}` })), ...ARENAS.map(a => ({ id: a.id, name: t('survivalTag', { name: courseName(a) }) }))]
      .map(o => `<option value="${o.id}" ${o.id === keep.course ? 'selected' : ''}>${esc(o.name)}</option>`).join('');
    const opts = (list, cur) => list.map(([v, label]) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${esc(label)}</option>`).join('');
    this.overlay(`
      <div class="panel" role="dialog" aria-labelledby="prac-h">
        <h1 id="prac-h">${esc(t('practice'))}</h1>
        <p class="muted">${esc(t('practiceSubtitle'))}</p>
        <div class="col mt">
          <label class="field"><span>${esc(t('courseLabel'))}</span><select id="prac-course">${options}</select></label>
          <label class="field"><span>${esc(t('botDifficulty'))}</span><select id="prac-skill">
            ${opts([['0.3', t('gentle')], ['0.55', t('medium')], ['0.8', t('fierce')], ['1.0', t('probe')]], keep.skill)}
          </select></label>
          <label class="field"><span>${esc(t('rivals'))}</span><select id="prac-bots">
            ${opts([['0', t('solo')], ['3', '3'], ['7', '7'], ['11', '11']], keep.bots)}
          </select></label>
        </div>
        <div class="row mt">
          <button class="primary" data-act="go">${esc(t('start'))}</button>
          <button data-act="back">${esc(t('back'))}</button>
        </div>
      </div>`);
    this.onAction('go', () => this.startPractice(el('prac-course').value, +el('prac-skill').value, +el('prac-bots').value));
    this.onAction('back', () => this.showModes());
  }

  showChallenges() {
    this.leaveRound();
    this.redraw = () => this.showChallenges();
    const done = this.store.save.challengesDone;
    const cards = CHALLENGES.map(c => `
      <button class="card ${done[c.id] ? 'done' : ''}" data-chal="${c.id}">
        <span class="card-title">${esc(tn('challenges', c.id, c.name))}</span>
        <span class="card-sub">${esc(tn('challengeDesc', c.id, c.desc))}</span>
      </button>`).join('');
    this.overlay(`
      <div class="panel" role="dialog" aria-labelledby="chal-h">
        <h1 id="chal-h">${esc(t('challengesH'))}</h1>
        <div class="card-grid mt">${cards}</div>
        <div class="row mt"><button data-act="back">${esc(t('back'))}</button></div>
      </div>`);
    el('screens').querySelectorAll('[data-chal]').forEach(b =>
      b.addEventListener('click', () => { this.audio.event({ t: 'ui' }); this.startChallenge(b.dataset.chal); }));
    this.onAction('back', () => this.showModes());
  }

  showShowSetup() {
    this.leaveRound();
    this.redraw = () => this.showShowSetup();
    const cards = SHOWS.map(s => `
      <button class="card" data-show="${s.id}">
        <span class="card-title">${esc(tn('shows', s.id, s.name))}</span>
        <span class="card-sub">${esc(t('showCard', { players: s.players, rounds: s.rounds.length, quotas: s.rounds.map(r => r.quota).join(' → ') }))}</span>
      </button>`).join('');
    this.overlay(`
      <div class="panel" role="dialog" aria-labelledby="show-h">
        <h1 id="show-h">${esc(t('show'))}</h1>
        <p class="muted">${esc(t('showSubtitle'))}</p>
        <div class="card-grid mt">${cards}</div>
        <div class="row mt"><button data-act="back">${esc(t('back'))}</button></div>
      </div>`);
    el('screens').querySelectorAll('[data-show]').forEach(b =>
      b.addEventListener('click', () => { this.audio.event({ t: 'ui' }); this.startShow(b.dataset.show); }));
    this.onAction('back', () => this.showModes());
  }

  showHosted() {
    this.leaveRound();
    // The dev-server room UI relabels in place (no redraw: the socket and room state stay put).
    this.redraw = null;
    this.overlay(`
      <div class="panel" role="dialog" aria-labelledby="host-h">
        <h1 id="host-h" data-i18n="hostedPlay">${esc(t('hostedPlay'))}</h1>
        <p class="muted" data-i18n="hostedText">${esc(t('hostedText'))}</p>
        <div class="col mt">
          <button class="primary" data-act="quick" data-i18n="quickJoin">${esc(t('quickJoin'))}</button>
          <label class="field"><span data-i18n="roomCode">${esc(t('roomCode'))}</span><input id="room-code" maxlength="6" style="font:inherit;min-height:44px;background:#1c2440;color:#fff;border-radius:8px;border:1px solid rgba(255,255,255,0.25);text-transform:uppercase" aria-label="${esc(t('roomCode'))}" data-i18n-aria="roomCode"></label>
          <div class="row">
            <button data-act="join" data-i18n="joinRoom">${esc(t('joinRoom'))}</button>
            <button data-act="create" data-i18n="createRoom">${esc(t('createRoom'))}</button>
          </div>
        </div>
        <div id="hosted-status" class="mt small muted" role="status"></div>
        <div class="row mt"><button data-act="back" data-i18n="back">${esc(t('back'))}</button></div>
      </div>`);
    const status = () => el('hosted-status');
    const ensure = async () => {
      if (!this.hosted.connected) {
        status().textContent = t('connecting');
        try { await this.hosted.connect(); } catch (e) { status().textContent = t('cantReach', { error: e.message }); return false; }
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
        if (statusEl) statusEl.textContent = t('inRoom', { code: msg.code, n: msg.players });
        if (el('host-h')) {
          const pane = el('screens').querySelector('.panel');
          if (pane && !pane.querySelector('[data-act="ready"]')) {
            const row = document.createElement('div');
            row.className = 'row mt';
            row.innerHTML = `<button class="primary" data-act="ready" data-i18n="readyUp">${esc(t('readyUp'))}</button>`;
            pane.appendChild(row);
            this.onAction('ready', () => this.hosted.setReady(true));
          }
        }
        break;
      case 'lobby':
        if (statusEl) statusEl.textContent = t('roomList', { code: msg.code, players: msg.players.map(p => p.name + (p.ready ? ' ✓' : '')).join(', ') });
        break;
      case 'start':
        this.startHostedRound(msg);
        break;
      case 'snapshot':
        if (this.hostedRound) this.applyHostedSnapshot(msg);
        break;
      case 'result':
        if (statusEl) statusEl.textContent = t('roundOverServer');
        break;
      case 'error':
        if (statusEl) statusEl.textContent = t('hostError', { error: msg.error });
        break;
      case 'disconnected':
        if (statusEl) statusEl.textContent = t('reconnecting');
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
    // follow *our* seat, not merely the first non-bot in the roster
    if (this.hosted.playerId && roster.some(r => r.id === this.hosted.playerId)) {
      this.round.localId = this.hosted.playerId;
    }
    // the server starts stepping immediately: skip the local countdown so
    // input is accepted from the first frame
    this.round.phase = 'active';
    this.round.cdLeft = 0;
    this.hostedRound = { serverTick: 0, prev: { jump: false, dive: false } };
    this.resultsShown = false;
    this.scene.buildCourse(this.round.state.course, def.theme || 'cumulus');
    const theme = themeById(def.theme || 'cumulus');
    this.audio.setMusicTheme(theme.music);
    this.audio.setAmbienceTone(theme.ambHz || 500);
    el('screens').innerHTML = '';
    el('hud').classList.remove('hidden');
    if ('ontouchstart' in window) el('touch-ui').classList.remove('hidden');
    this.roundDef = def;
    this.renderRoundText();
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
    this.redraw = () => this.showPause();
    this.overlay(`
      <div class="panel" role="dialog" aria-labelledby="pause-h">
        <h1 id="pause-h">${esc(t('paused'))}</h1>
        <div class="col mt">
          <button class="primary" data-act="resume">${esc(t('resume'))}</button>
          <button data-act="retry">${esc(t('retryRound'))}</button>
          <button data-act="settings">${esc(t('settings'))}</button>
          <button data-act="help">${esc(t('help'))}</button>
          <button class="danger" data-act="quit">${esc(t('leaveRound'))}</button>
        </div>
      </div>`);
    this.onAction('resume', () => this.resumeRound());
    this.onAction('retry', () => { const ctx = this.lastRoundCtx; this.resumeRoundSilent(); ctx && ctx(); });
    this.onAction('settings', () => this.showSettings(() => this.showPause()));
    this.onAction('help', () => this.showHelp(() => this.showPause()));
    this.onAction('quit', () => this.endRoundTo(() => this.showModes()));
  }

  resumeRoundSilent() { el('screens').innerHTML = ''; }

  // Settings relabels in place on a language change (data-i18n): the shared
  // Sound / Language / Report sections stay mounted after the Graphics box.
  showSettings(back) {
    this.redraw = null;
    const s = this.settings;
    const L = (key) => `<span data-i18n="${key}">${esc(t(key))}</span>`;
    const pal = { standard: 'palStandard', deuteranopia: 'palDeut', protanopia: 'palProt', tritanopia: 'palTrit' };
    this.overlay(`
      <div class="panel" role="dialog" aria-labelledby="set-h">
        <h1 id="set-h" data-i18n="settings">${esc(t('settings'))}</h1>
        <h2 data-i18n="audio">${esc(t('audio'))}</h2>
        ${this.slider('set-music', 'music', s.music)}
        ${this.slider('set-effects', 'effects', s.effects)}
        ${this.slider('set-ambience', 'ambience', s.ambience)}
        ${this.check('set-captions', 'captions', s.captions)}
        <h2 data-i18n="graphics">${esc(t('graphics'))}</h2>
        <div id="gfx-section" class="gfx-section" data-options-graphics><div id="gfx-box"></div></div>
        ${this.check('set-shake', 'cameraShake', s.cameraShake)}
        <label class="field">${L('camera')}<select id="set-camera">
          <option value="follow" ${s.camera === 'follow' ? 'selected' : ''} data-i18n="camFollow">${esc(t('camFollow'))}</option>
          <option value="far" ${s.camera === 'far' ? 'selected' : ''} data-i18n="camFar">${esc(t('camFar'))}</option>
        </select></label>
        <h2 data-i18n="accessibility">${esc(t('accessibility'))}</h2>
        ${this.check('set-rm', 'reducedMotion', s.reducedMotion)}
        ${this.check('set-hc', 'highContrast', s.highContrast)}
        <label class="field">${L('colorPalette')}<select id="set-palette">
          ${Object.entries(pal).map(([p, k]) => `<option value="${p}" ${s.palette === p ? 'selected' : ''} data-i18n="${k}">${esc(t(k))}</option>`).join('')}
        </select></label>
        ${this.slider('set-text', 'textSize', s.textScale)}
        ${this.check('set-lefty', 'leftHanded', s.leftHanded)}
        <div class="row mt">
          <button class="primary" data-act="done" data-i18n="done">${esc(t('done'))}</button>
          <button data-act="replay-tutorial" data-i18n="replayTutorial">${esc(t('replayTutorial'))}</button>
        </div>
      </div>`);
    const bind = (id, fn) => el(id).addEventListener('change', (e) => { fn(e.target); this.store.persist(); this.applySettings(); this.pushSettings(); this.audio.event({ t: 'ui' }); });
    bind('set-music', t => s.music = +t.value);
    bind('set-effects', t => s.effects = +t.value);
    bind('set-ambience', t => s.ambience = +t.value);
    bind('set-captions', t => s.captions = t.checked);
    bind('set-shake', t => s.cameraShake = t.checked);
    bind('set-camera', t => s.camera = t.value);
    bind('set-rm', t => s.reducedMotion = t.checked);
    bind('set-hc', t => s.highContrast = t.checked);
    bind('set-palette', t => s.palette = t.value);
    bind('set-text', t => s.textScale = +t.value);
    bind('set-lefty', t => s.leftHanded = t.checked);
    this.onAction('done', () => { clearInterval(this.gfxTimer); back(); });
    this.onAction('replay-tutorial', () => { clearInterval(this.gfxTimer); this.startLesson(0); });
    this.renderGraphicsSection();
  }

  // Graphics section: preset, render scale, per-effect overrides, adaptive
  // resolution, frame-rate readout and a GPU / cost summary. Changes apply
  // live and persist in settings.gfx.
  renderGraphicsSection(focusId) {
    // Only the inner box redraws, so the shared sections mounted after it survive.
    const box = el('gfx-box');
    if (!box) return;
    const T = gfxStrings(locale());
    const s = this.settings;
    const saved = s.gfx || {};
    const info = this.scene.graphicsInfo();
    const r = info.resolved;
    const tier = (t) => T.tiers[t] || t;
    const preset = PRESETS.includes(saved.preset) ? saved.preset : 'auto';
    const opt = (v, label, sel) => `<option value="${v}" ${sel ? 'selected' : ''}>${esc(label)}</option>`;
    const pct = Math.round((Number(saved.render_scale) || 1) * 100);
    box.innerHTML = `
      <label class="field"><span>${esc(T.quality)}</span><select id="gfx-preset" data-gfx="preset">
        ${opt('auto', T.auto.replace('{tier}', tier(info.detected)), preset === 'auto')}
        ${PRESETS.map(p => opt(p, tier(p), preset === p)).join('')}
      </select></label>
      <label class="field gfx-scale-row"><span>${esc(T.scale)} <output id="gfx-scale-val" for="gfx-scale">${pct}%</output></span>
        <input type="range" id="gfx-scale" data-gfx="render_scale" min="50" max="200" step="5" value="${pct}" aria-label="${esc(T.scale)}"></label>
      ${Object.entries(CATEGORIES).map(([cat, tiers]) => `
      <label class="field"><span>${esc(T.cats[cat])}</span><select id="gfx-${cat}" data-gfx-cat="${cat}">
        ${opt('preset', T.fromPreset.replace('{tier}', tier(presetTier(r.preset, cat))), !tiers.includes(saved[cat]))}
        ${tiers.map(t => opt(t, tier(t), saved[cat] === t)).join('')}
      </select></label>`).join('')}
      <label class="field"><span>${esc(T.adaptive)}</span><input type="checkbox" id="gfx-adaptive" ${r.adaptive ? 'checked' : ''} aria-label="${esc(T.adaptive)}"></label>
      <label class="field"><span>${esc(T.showFps)}</span><input type="checkbox" id="gfx-fps" ${r.showFps ? 'checked' : ''} aria-label="${esc(T.showFps)}"></label>
      <p class="small muted gfx-summary" id="gfx-summary" role="status"></p>
      <p class="small gfx-note ${info.postFailed ? '' : 'hidden'}" id="gfx-note">${esc(T.postFailed)}</p>`;
    const commit = (next, id) => {
      s.gfx = next;
      this.store.persist();
      this.pushSettings();
      this.scene.setGraphics(next);
      this.audio.event({ t: 'ui' });
      this.renderGraphicsSection(id);
    };
    el('gfx-preset').addEventListener('change', (e) => commit(choosePreset(saved, e.target.value), 'gfx-preset'));
    const scale = el('gfx-scale');
    scale.addEventListener('input', () => { el('gfx-scale-val').textContent = scale.value + '%'; });
    scale.addEventListener('change', () => commit({ ...saved, render_scale: +scale.value / 100 }, 'gfx-scale'));
    box.querySelectorAll('[data-gfx-cat]').forEach(sel => sel.addEventListener('change', () => {
      const next = { ...saved };
      if (sel.value === 'preset') delete next[sel.dataset.gfxCat]; else next[sel.dataset.gfxCat] = sel.value;
      commit(next, sel.id);
    }));
    el('gfx-adaptive').addEventListener('change', (e) => commit({ ...saved, adaptive: e.target.checked }, 'gfx-adaptive'));
    el('gfx-fps').addEventListener('change', (e) => commit({ ...saved, show_fps: e.target.checked }, 'gfx-fps'));
    if (focusId && el(focusId)) el(focusId).focus();
    const summary = () => {
      const i = this.scene.graphicsInfo();
      const line = el('gfx-summary');
      if (!line) { clearInterval(this.gfxTimer); return; }
      line.textContent = `${i.gpu} · ${i.summary}`;
      el('gfx-note')?.classList.toggle('hidden', !i.postFailed);
    };
    summary();
    clearInterval(this.gfxTimer);
    this.gfxTimer = setInterval(summary, 500);
  }

  slider(id, key, v) {
    return `<label class="field"><span data-i18n="${key}">${esc(t(key))}</span><input type="range" id="${id}" min="0" max="1" step="0.05" value="${v}" aria-label="${esc(t(key))}" data-i18n-aria="${key}"></label>`;
  }
  check(id, key, v) {
    return `<label class="field"><span data-i18n="${key}">${esc(t(key))}</span><input type="checkbox" id="${id}" ${v ? 'checked' : ''} aria-label="${esc(t(key))}" data-i18n-aria="${key}"></label>`;
  }

  showHelp(back) {
    this.redraw = () => this.showHelp(back);
    const r = (key, rowKey, keys) => `<tr><td>${esc(t(key))}</td><td>${esc(t(rowKey, { keys }))}</td></tr>`;
    this.overlay(`
      <div class="panel" role="dialog" aria-labelledby="help-h">
        <h1 id="help-h">${esc(t('howToPlay'))}</h1>
        <h2>${esc(t('goal'))}</h2>
        <p>${esc(t('goalText'))}</p>
        <h2>${esc(t('controls'))}</h2>
        <table class="score" aria-label="${esc(t('controls'))}">
          ${r('move', 'moveRow', this.keysFor('forward', 'left', 'back', 'right'))}
          ${r('jump', 'jumpRow', this.keysFor('jump'))}
          ${r('dive', 'diveRow', this.keysFor('dive'))}
          ${r('pause', 'pauseRow', this.keysFor('pause'))}
        </table>
        <h2>${esc(t('rulesCards'))}</h2>
        <p>${esc(t('rulesText'))}</p>
        <h2>${esc(t('fairPlay'))}</h2>
        <p>${esc(t('fairText'))}</p>
        <div class="row mt"><button class="primary" data-act="done">${esc(t('done'))}</button></div>
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
    this.scene.setGraphics(s.gfx || {});
    if (this.scene.palette !== s.palette) {
      this.scene.palette = s.palette;
      // rebuild to apply palette colors
      this.scene.rebuild();
    }
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

  // ---- StarHermit: bindings, settings KV, invite ----
  setBindings(bindings) {
    this.bindings = bindings;
    this.codeAction = {};
    for (const [action, codes] of Object.entries(bindings)) for (const c of codes) this.codeAction[c] = action;
    this.keys = {};
  }

  keysFor(...actions) {
    return actions.map(a => (this.bindings[a] || []).map(keyLabel).join('/')).join(' ');
  }

  adoptRemoteSettings(remote) {
    if (!remote || typeof remote !== 'object') return;
    const s = this.settings;
    let changed = false;
    for (const k of SYNCED_SETTINGS) {
      const v = remote[k];
      if (v === undefined || v === null || typeof v !== typeof s[k]) continue;
      s[k] = v;
      changed = true;
    }
    if (changed) this.store.persist();
  }

  pushSettings() {
    if (!this.platform || !this.platform.active) return;
    clearTimeout(this.settingsTimer);
    this.settingsTimer = setTimeout(() => {
      const out = {};
      for (const k of SYNCED_SETTINGS) out[k] = this.settings[k];
      this.platform.patchSettings(out);
    }, 500);
  }

  async copyInvite() {
    const link = this.platform && this.platform.inviteLink();
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      this.toast(this.pt('inviteCopied'));
    } catch {
      this.toast(this.pt('inviteFailed', { link }));
    }
  }

  toast(text) {
    let t = el('toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'toast';
      t.className = 'toast';
      t.setAttribute('role', 'status');
      document.getElementById('app').appendChild(t);
    }
    t.textContent = text;
    t.classList.remove('hidden');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => t.classList.add('hidden'), 3500);
  }

  profileName() { return (this.platform && this.platform.nickname) || t('you'); }

  // Small account/sync line under the title logo: account nickname plus the
  // cloud-save state when hosted; guest note otherwise. Re-rendered whenever
  // the platform adapter reports a sync-status change.
  renderAccountLine() {
    const line = el('account-line');
    if (!line || !this.platform) return;
    if (!this.platform.active) {
      line.textContent = t('guestLine');
      return;
    }
    const key = { synced: 'syncSynced', saving: 'syncSaving', error: 'syncError', offline: 'syncOffline' }[this.platform.status];
    line.textContent = t('playingAs', { name: playerName(this.profileName()), status: key ? t(key) : this.platform.status });
  }

  persistStats() { this.store.persist(); }

  /** The cloud copy was merged in after a save conflict: re-apply settings, refresh the title. */
  onSaveMerged() {
    this.applySettings();
    if (el('title-h') && this.redraw) this.redraw();
  }
}

// Legal-action refusal reasons (sim.js) → string keys.
const INVALID_KEYS = { inactive: 'rsnInactive', stunned: 'rsnStunned', airborne: 'rsnAirborne', cooldown: 'rsnCooldown', 'jump unavailable': 'rsnJump', 'dive unavailable': 'rsnDive' };

/** Challenge outcome line (round.js reports kind + numbers; text is localized here). */
function outcomeText(out) {
  if (!out.key) return out.desc;
  return t(out.key, out.vars);
}

function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
