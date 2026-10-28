// Tumble Circuit on the StarHermit engine: the entry module (starhermit.txt
// engine.entry), played natively by the StarHermit client and in browsers by
// the engine's web runtime. The rules, content, round driver, shows and save
// model are the browser build's js/ modules (native/game.ts); this module is
// what js/ui/app.js and js/main.js did around them: the round lifecycle (one
// 60 Hz rules tick per fixed step, the 3-2-1 countdown, input sampled into
// the round each step), pause / resume / retry / leave, lessons, the Journey,
// the Daily (its validated course built on a worker), Practice, Challenges
// and Shows (elimination rounds to a survival final), results with progress,
// achievements, the replay check (on a worker) and the high-score post,
// announcements and captions, and the lifecycle (a hidden window pauses the
// round). Screens are drawn by screens.ts (starhermit:ui), the arena by
// render.ts (starhermit:scene).
import { clipboard, frame, onFixedUpdate, onPreferencesChange, onRender, onResume, onStart, onSuspend, onUpdate, preferences, setFixedRate } from "starhermit:engine";
import { bindings, isDown, onAction, setTouchControls, touchControlsVisible, value } from "starhermit:input";
import * as ui from "starhermit:ui";
import { onSessionEnded, requestSignIn } from "starhermit:platform";
import {
  Content, Daily, Round, Show, Sim, Themes, type Any, type Challenge, type Def, type Ev, type Lesson, type LocalRound, type PlayerResult, type RoundResult, type ShowDef,
} from "./game.ts";
import { ACHIEVEMENTS as ACH } from "../js/content/achievements.js";
import * as audio from "./audio.ts";
import { courseName, lessonText, onLanguage, pt, t, tn } from "./i18n.ts";
import * as platform from "./platform.ts";
import { lookFor } from "./quality.ts";
import * as render from "./render.ts";
import { drawScreens } from "./screens.ts";
import { applyTokens, initStyles } from "./style.ts";
import * as work from "./work.ts";

export type Overlay = "title" | "modes" | "learn" | "journey" | "practice" | "challenges" | "show" | "pause" | "settings" | "help" | "results" | "showOver" | null;
/** The achievement set (js/content/achievements.js). */
export const ACHIEVEMENTS = ACH as Record<string, { name: string; desc: string }>;
/** Legal-action refusal reasons (sim.js) → string keys. */
const INVALID_KEYS: Record<string, string> = { inactive: "rsnInactive", stunned: "rsnStunned", airborne: "rsnAirborne", cooldown: "rsnCooldown", "jump unavailable": "rsnJump", "dive unavailable": "rsnDive" };

type Ctx =
  | { kind: "lesson"; index: number; lesson: Lesson }
  | { kind: "journey"; stage: Def }
  | { kind: "daily"; date: string }
  | { kind: "practice"; courseId: string; skill: number; bots: number }
  | { kind: "challenge"; ch: Challenge }
  | { kind: "show"; def: ShowDef };
export interface ResultsSpec {
  headline: () => string; me: PlayerResult; res: RoundResult; next: { label: () => string; fn: () => void } | null;
  replay: { ok: boolean; reason?: string } | null; lb: (() => string) | null; newly: string[];
}
export interface ShowOver { champ: boolean; eliminated: boolean; def: ShowDef; table: ReturnType<typeof Show.showTable>; place: number; points: number }

// ------------------------------------------------------------------ app state
export const app = {
  overlay: "title" as Overlay,
  openedFrame: 0,
  focusNext: null as string | null,
  /** title | menu | preparing | round | results */
  flow: "title",
  round: null as LocalRound | null,
  ctx: null as Ctx | null,
  show: null as Any,
  showYouDefault: false,
  youDefault: false,
  goal: null as (() => string) | null,
  lessonBanner: false,
  resultsAt: 0,
  results: null as ResultsSpec | null,
  showOver: null as ShowOver | null,
  returnTo: "title" as "title" | "pause",
  practice: { course: 0, skill: 1, bots: 2 },
  toast: null as { text: string; until: number } | null,
  caption: null as { text: string; until: number } | null,
  countdown: null as string | null,
  countHide: 0,
  preparing: null as string | null,
  streak: 0,
};
let steps = 0; // fixed steps (60 Hz) since start
export const now = (): number => steps / 60;
export const fresh = (): boolean => frame().frame !== app.openedFrame;
export const inRound = (): boolean => !!app.round && app.flow === "round";

// ------------------------------------------------------------------ helpers
const spoken: string[] = [];
let spokenAssertive = false;
/** The live regions (#live polite, #live-urgent assertive): one announcement a frame, joined. */
export function announce(text: string, assertive = false): void {
  if (!text) return;
  if (!spoken.includes(text)) spoken.push(text);
  spokenAssertive ||= assertive;
}
function flushAnnouncements(): void {
  if (!spoken.length) return;
  const text = spoken.splice(0).join(" ").slice(0, 500);
  try { ui.announce(text, { politeness: spokenAssertive ? "assertive" : "polite" }); } catch { /* busy */ }
  spokenAssertive = false;
}
export function toast(text: string, ms = 3500): void { app.toast = { text, until: now() + ms / 1000 }; announce(text); }
/** audio.js event with its caption (#captions, 1.4 s, when captions are on). */
export function sound(ev: string): void {
  audio.play(ev);
  const c = audio.CAPTIONS[ev];
  if (c && platform.options.captions) app.caption = { text: `♪ ${t(c)}`, until: now() + 1.4 };
}
const pending: (() => void)[] = [];
/** A widget's press, run once the frame's UI is built. */
export function later(fn: () => void): void { pending.push(fn); }

const GLYPH: Record<string, string> = { "Arrow Up": "↑", "Arrow Down": "↓", "Arrow Left": "←", "Arrow Right": "→", Escape: "Esc", "Shift Left": "Shift", "Shift Right": "Right Shift" };
/** app.js keysFor over the effective bindings (the runtime's rebinding). */
export function keysFor(...actions: string[]): string {
  return actions.map((a) => {
    let list: string[] = [];
    try { list = bindings(a).filter((b) => b.device === "keyboard").map((b) => GLYPH[b.label] ?? b.label); } catch { /* not yet */ }
    return [...new Set(list)].join("/");
  }).join(" ");
}
export function profileName(): string { return platform.signedIn() ? platform.displayName() || t("you") : t("you"); }

// ------------------------------------------------------------------ overlays
export function open(o: Overlay, focus: string | null = null): void {
  app.overlay = o;
  app.openedFrame = frame().frame;
  app.focusNext = focus ?? (touchControlsVisible() ? null : firstFocus(o));
  ui.setFocus(null);
}
function firstFocus(o: Overlay): string | null {
  switch (o) {
    case "title": return "btn-play";
    case "pause": return "btn-resume";
    case "results": return "btn-res-first";
    default: return null;
  }
}
export function menu(o: Overlay): void { leaveRound(); app.flow = "menu"; open(o); }
export function showTitle(): void {
  leaveRound();
  app.flow = "title";
  app.returnTo = "title";
  buildAttract();
  open("title");
}
function buildAttract(): void {
  const def = Content.courseById("show-ridge");
  if (!def) return;
  render.buildAttract(def);
  audio.setTheme(Themes.themeById(def.theme || "cumulus"));
  attractT = 0;
  attract = true;
}
let attract = false;
let attractT = 0;
/** Back from Help / Settings: the pause screen when opened from it, else the title. */
export function backAuto(): void {
  if (app.returnTo === "pause" && app.round && app.round.paused) open("pause");
  else showTitle();
}

// ------------------------------------------------------------------ round lifecycle (app.js startRound …)
interface StartOpts { bots?: number; botSkill?: number; quota?: number; roster?: Any[]; lesson?: Lesson; mods?: Any; goal?: Any; goalText?: () => string; seedOverride?: number; timeLimit?: number }
function startRound(def: Def, opts: StartOpts = {}): void {
  const botCount = opts.bots != null ? opts.bots : 7;
  const roster = opts.roster || Round.buildRoster(profileName(), Round.PALETTE[0]!, botCount, def.seed % 23);
  app.goal = opts.goalText || null;
  app.lessonBanner = false;
  app.youDefault = !platform.signedIn() && !opts.roster;
  app.round = new Round.LocalRound(def, roster, {
    quota: opts.quota != null ? opts.quota : Math.max(1, Math.ceil((botCount + 1) / 2)),
    botSkill: opts.botSkill != null ? opts.botSkill : 0.55,
    seedOverride: opts.seedOverride, lesson: opts.lesson, mods: opts.mods, goal: opts.goal, timeLimit: opts.timeLimit,
  });
  app.results = null;
  app.resultsAt = 0;
  app.flow = "round";
  app.overlay = null;
  app.openedFrame = frame().frame;
  app.countdown = null;
  ui.setFocus(null);
  attract = false;
  render.buildCourse(app.round.state.course, def.theme || "cumulus");
  render.ensurePlayers(app.round.state.players);
  audio.setTheme(Themes.themeById(def.theme || "cumulus"));
  audio.setPaused(false);
  announce(t("roundStarting", { name: courseName(def) || t("round"), goal: goalText() }));
  platform.persist();
}
/** The HUD goal line (app.js renderRoundText). */
export function goalText(): string {
  const r = app.round;
  if (!r) return "";
  if (app.goal) return app.goal();
  return r.state.kind === "survival" ? t("goalSurvive") : t("goalReach", { n: r.state.quota });
}
/** The lesson banner: the intro until the first step event, then the current step. */
export function bannerText(): string {
  const r = app.round;
  if (!r || !r.lesson) return "";
  const st = r.currentLessonStep();
  return !app.lessonBanner ? lessonText(r.lesson.id, r.lesson.intro) : st ? stepText(r.lesson, st) : t("lessonComplete");
}
function stepText(lesson: Lesson, step: { id: string; text: string }): string {
  return lessonText(lesson.id + "." + step.id, step.text).replace("{move}", t("moveKeys")).replace("{jump}", t("jumpKeys")).replace("{dive}", t("diveKeys"));
}
function leaveRound(): void {
  app.round = null;
  app.show = null;
  app.ctx = null;
  app.countdown = null;
  app.preparing = null;
  work.cancelAll();
}
export function endRoundTo(fn: () => void): void { leaveRound(); fn(); }
export function pauseRound(auto = false): void {
  const r = app.round;
  if (!r || r.phase === "done" || r.paused || app.flow !== "round") return;
  r.pause();
  if (!auto) sound("ui-back");
  audio.setPaused(true);
  app.returnTo = "pause";
  open("pause");
}
export function resumeRound(): void {
  const r = app.round;
  if (!r || !r.paused) return;
  r.resume();
  audio.setPaused(false);
  app.overlay = null;
  app.openedFrame = frame().frame;
  ui.setFocus(null);
  sound("ui");
}
export function togglePause(): void {
  if (!app.round) return;
  if (app.round.paused) { if (app.overlay === "pause") resumeRound(); }
  else pauseRound();
}
let lastRoundCtx: (() => void) | null = null;
export function retryCurrent(): void { if (lastRoundCtx) lastRoundCtx(); }

function handleRoundEvent(e: Ev): void {
  const r = app.round!;
  switch (e.t) {
    case "countdown": app.countdown = String(e.n); app.countHide = 0; sound("countdown"); break;
    case "go": app.countdown = t("go"); sound("go"); app.countHide = steps + 42; break;
    case "lesson-step": {
      const st = r.currentLessonStep();
      app.lessonBanner = true;
      sound("checkpoint");
      announce(st ? stepText(r.lesson!, st) : t("lessonCompleteShort"));
      break;
    }
    default:
      sound(e.t);
      render.onEvent(e, r.localId);
      if (e.t === "checkpoint" && e.p === r.localId) announce(t("checkpointOf", { cp: e.cp!, of: e.of! }));
      if (e.t === "finish" && e.p === r.localId) announce(t("finishedPlace", { place: e.place! }));
      if (e.t === "out" && e.p === r.localId) announce(t("youAreOut"), true);
  }
}

// ------------------------------------------------------------------ modes (app.js start*)
function setCtx(c: Ctx, retry: () => void): void { app.ctx = c; lastRoundCtx = retry; }
export function startLesson(i: number): void {
  const lesson = Content.LESSONS[i];
  if (!lesson) return;
  leaveRound();
  setCtx({ kind: "lesson", index: i, lesson }, () => startLesson(i));
  startRound(lesson, {
    lesson, bots: lesson.bots ? lesson.bots.count : 0, botSkill: lesson.bots ? lesson.bots.skill : 0.2, quota: lesson.passPlace || 1,
    goalText: () => t("goalLesson", { title: tn("lessons", lesson.id, lesson.title ?? lesson.id) }),
  });
}
export function startJourneyStage(n: number): void {
  const st = Content.JOURNEY[n - 1];
  if (!st) { menu("journey"); return; }
  leaveRound();
  setCtx({ kind: "journey", stage: st }, () => startJourneyStage(n));
  startRound(st, {
    bots: st.bots!.count, botSkill: st.bots!.skill, quota: st.passPlace,
    goalText: () => t("goalStage", { name: courseName(st), n: st.passPlace! }) + (st.mastery ? t("masteryStage") : ""),
  });
}
/** app.js startDaily: today's course comes from the worker (the probe validation is heavy natively). */
export function startDaily(): void {
  const d = platform.utcDate();
  if (Daily.isDailyExcluded(d)) { announce(t("dailyExcluded"), true); toast(t("dailyExcluded")); return; }
  leaveRound();
  app.flow = "preparing";
  app.preparing = d;
  open(app.overlay ?? "modes");
  work.daily(d, (def) => {
    if (app.preparing !== d) return;
    app.preparing = null;
    setCtx({ kind: "daily", date: d }, startDaily);
    startRound(def, { bots: 9, botSkill: 0.6, quota: 4, goalText: () => t("goalDaily", { date: d, seed: def.seed, v: Daily.DAILY_RULESET }) });
  });
}
export const SKILLS = [0.3, 0.55, 0.8, 1.0];
export const BOTS = [0, 3, 7, 11];
export function practiceCourses(): Def[] { return [...Content.JOURNEY, ...Content.ARENAS]; }
export function startPractice(courseId: string, skill: number, bots: number): void {
  const def = Content.courseById(courseId) || Content.JOURNEY[0]!;
  leaveRound();
  setCtx({ kind: "practice", courseId, skill, bots }, () => startPractice(courseId, skill, bots));
  startRound(def, { bots, botSkill: skill, quota: Math.max(1, Math.ceil((bots + 1) / 2)), goalText: () => t("goalPractice") });
}
export function startChallenge(id: string): void {
  const ch = Content.CHALLENGES.find((c) => c.id === id);
  if (!ch) return;
  const def = Content.challengeCourse(ch);
  leaveRound();
  setCtx({ kind: "challenge", ch }, () => startChallenge(id));
  startRound(def, {
    bots: ch.bots ? ch.bots.count : 0, botSkill: ch.bots ? ch.bots.skill : 0.4, quota: 1,
    mods: ch.mods, goal: ch.goal, goalText: () => tn("challengeDesc", ch.id, ch.desc),
  });
}
export function startShow(showId: string): void {
  const def = Content.SHOWS.find((s) => s.id === showId);
  if (!def) return;
  leaveRound();
  const roster = Round.buildRoster(profileName(), Round.PALETTE[0]!, def.players - 1, 7);
  app.show = Show.createShow(def, roster);
  app.showYouDefault = !platform.signedIn();
  playShowRound(def);
}
function playShowRound(def: ShowDef): void {
  const show = app.show;
  const rd = Show.currentRound(show);
  const courseDef = Content.courseById(rd.courseId)!;
  const alive = show.roster.filter((r: Any) => show.aliveIds.includes(r.id));
  const n = show.roundIndex + 1, final = Show.isFinalRound(show);
  app.ctx = { kind: "show", def };
  lastRoundCtx = () => { const s = app.show; leaveRound(); app.show = s; app.ctx = { kind: "show", def }; playShowRound(def); };
  startRound(courseDef, {
    quota: Math.min(rd.quota, alive.length), botSkill: def.botSkill, roster: alive,
    goalText: () => t(final ? "goalShowFinal" : "goalShowRound", { show: tn("shows", def.id, def.name), n, total: def.rounds.length, quota: rd.quota }),
  });
  app.youDefault = app.showYouDefault;
}
export function continueShow(): void {
  const show = app.show, r = app.round;
  if (!show || !r || !r.result || app.ctx?.kind !== "show") return;
  const def = app.ctx.def;
  Show.applyRoundResult(show, r.result);
  if (show.terminal || !show.aliveIds.includes("you")) {
    const table = Show.showTable(show);
    const you = table.find((x) => x.id === "you");
    const champ = !!show.terminal && show.terminal.championId === "you";
    if (champ) {
      platform.doc().stats.showsWon++;
      if (!platform.doc().achievements.champion) { platform.doc().achievements.champion = Date.now(); sound("achievement"); }
      sound("champion");
    }
    platform.persist();
    app.showOver = { champ, eliminated: !show.terminal, def, table, place: you ? table.indexOf(you) + 1 : 0, points: you ? you.points : 0 };
    app.round = null;
    app.flow = "results";
    open("showOver");
  } else {
    app.round = null;
    playShowRound(def);
  }
}

// ------------------------------------------------------------------ results + progression (app.js showResults)
function showResults(): void {
  const r = app.round!;
  const res = r.result!;
  const me = res.results[r.localId]!;
  const save = platform.doc();
  const newly: string[] = [];
  const unlock = (key: string): void => {
    if (!save.achievements[key]) {
      save.achievements[key] = Date.now();
      newly.push(key);
      sound("achievement");
      announce(t("achievementUnlocked", { name: tn<string[]>("achievements", key, [ACHIEVEMENTS[key]!.name])[0]! }), true);
    }
  };
  save.stats.races++;
  if (me.finished) {
    save.stats.finishes++;
    unlock("first_finish");
    if (save.stats.finishes >= 50) unlock("long_haul");
  }
  if (me.qualified) {
    save.stats.qualifies++;
    app.streak++;
    save.stats.bestStreak = Math.max(save.stats.bestStreak || 0, app.streak);
    if (app.streak >= 3) unlock("streak_3");
  } else app.streak = 0;

  const c = app.ctx;
  let headline: () => string;
  let next: ResultsSpec["next"] = null;
  if (c?.kind === "lesson") {
    const done = r.lessonDone();
    const lesson = c.lesson;
    headline = () => t(done ? "lessonDoneH" : "lessonKeepH", { lesson: tn("lessons", lesson.id, lesson.title ?? lesson.id) });
    if (done) {
      save.lessonsDone[lesson.id] = true;
      if (Content.LESSONS.every((l) => save.lessonsDone[l.id])) unlock("lesson_grad");
      if (c.index < Content.LESSONS.length - 1) next = { label: () => t("nextLesson"), fn: () => startLesson(c.index + 1) };
    }
  } else if (c?.kind === "challenge") {
    const out = r.challengeOutcome();
    const ch = c.ch;
    const desc = (): string => (out.key ? t(out.key, out.vars) : out.desc);
    headline = () => (out.won ? t("challengeCleared", { name: tn("challenges", ch.id, ch.name) }) : t("challengeOutcome", { name: tn("challenges", ch.id, ch.name), desc: desc() }));
    if (out.won) save.challengesDone[ch.id] = true;
    next = { label: () => t("challengesH"), fn: () => menu("challenges") };
  } else if (c?.kind === "daily") {
    headline = () => (me.qualified ? t("dailyQualified") : t("dailyEliminated"));
    const d = c.date;
    if (!save.daily[d] || me.total > save.daily[d]!) save.daily[d] = me.total;
    if (Object.keys(save.daily).length >= 5) unlock("daily_regular");
    next = { label: () => t("backToTitle"), fn: showTitle };
  } else if (c?.kind === "journey") {
    const st = c.stage;
    const n = st.stage!;
    const passed = me.place <= (st.passPlace || 4) && me.finished;
    headline = () => (passed ? t("stagePassed", { name: courseName(st), place: me.place }) : t("stageFailed", { name: courseName(st), place: me.place, n: st.passPlace! }));
    const id = "j" + String(n).padStart(2, "0");
    if (passed) {
      save.journey.passed[id] = me.total;
      save.journey.unlocked = Math.max(save.journey.unlocked, Math.min(40, n + 1));
      if (st.mastery) { save.journey.crowns[id] = true; unlock("mastery_crown"); }
      if (Object.keys(save.journey.passed).length >= 20) unlock("halfway");
      if (n < 40) next = { label: () => t("stageN", { n: n + 1 }), fn: () => startJourneyStage(n + 1) };
    } else next = { label: () => t("retry"), fn: () => startJourneyStage(n) };
  } else if (c?.kind === "show") {
    headline = () => (me.qualified ? t("qualified") : t("eliminated"));
  } else {
    headline = () => (me.finished ? t("finishedN", { n: me.place }) : t("placedN", { n: me.place }));
  }
  platform.persist();
  const spec: ResultsSpec = { headline, me, res, next, replay: null, lb: null, newly };
  // Signed in only: every finished local round except lessons posts the total to the high-score board.
  if (platform.signedIn() && !r.lesson) {
    spec.lb = () => pt("lbPosting");
    void platform.postScore(Math.max(0, me.total)).then((p) => {
      spec.lb = () => (!p.posted ? pt("lbFailed") : p.rank ? pt("lbRank", { rank: p.rank }) : pt("lbPosted"));
      if (app.results === spec) announce(spec.lb());
    });
  }
  const round = r;
  work.verifyReplay(r.exportReplay(), r.def, (v) => { if (app.round === round) spec.replay = v; });
  app.results = spec;
  app.flow = "results";
  setTouchControls(null);
  open("results");
}

// ------------------------------------------------------------------ account
export function signIn(): void { void requestSignIn().catch(() => undefined); }
export function invite(): void {
  const link = platform.inviteLink();
  if (!link) return;
  try { clipboard.writeText(link); toast(pt("inviteCopied")); } catch { toast(pt("inviteFailed", { link })); }
}

// ------------------------------------------------------------------ input (keys, pads, the touch stick and buttons)
let jumpLatch = false, diveLatch = false;
onAction((e) => {
  if (!e.pressed || ui.capturingKeys()) return;
  if (e.action === "pause") {
    if (app.flow === "round" && app.round && app.round.phase !== "done") {
      if (!app.round.paused && !app.overlay) later(() => pauseRound());
      else if (app.overlay === "pause" && fresh()) later(resumeRound);
    }
    return;
  }
  if (!inRound() || app.overlay) return;
  ui.setFocus(null); // keys play the round, not the HUD's Pause button
  if (e.action === "jump") jumpLatch = true;
  if (e.action === "dive") diveLatch = true;
});
/** app.js readMoveInput / readActionInput: keys, the pad's stick or the touch stick (the keyboard's back is 0.6). */
function sampleInput(): Any {
  const v = (a: string): number => { try { return value(a); } catch { return 0; } };
  let mx = v("right") - v("left");
  const back = v("back");
  let mz = v("forward") - (back >= 0.999 ? 0.6 : back);
  const m = Math.hypot(mx, mz);
  if (m > 1) { mx /= m; mz /= m; }
  const jump = isDown("jump") || jumpLatch, dive = isDown("dive") || diveLatch;
  jumpLatch = false; diveLatch = false;
  return { mx, mz, jump, dive, forwardHeld: mz > 0.5 };
}
let touchKey = "";
function touchControls(): void {
  const want = inRound() && !app.overlay;
  const lh = platform.options.leftHanded;
  const key = want ? `${lh}:${t("jump")}:${t("dive")}` : "";
  if (key === touchKey) return;
  touchKey = key;
  if (!want) { setTouchControls(null); return; }
  const stickAt = lh ? "bottom-right" : "bottom-left", btnAt = lh ? "bottom-left" : "bottom-right";
  setTouchControls([
    { kind: "stick", up: "forward", down: "back", left: "left", right: "right", anchor: stickAt, offset: [83, 83], radius: 55 },
    { kind: "button", action: "jump", label: t("jump").slice(0, 16), anchor: btnAt, offset: [54, 150], radius: 42 },
    { kind: "button", action: "dive", label: t("dive").slice(0, 16), anchor: btnAt, offset: [54, 60], radius: 42 },
  ]);
}

// ------------------------------------------------------------------ the clock
let hidden = false;
onFixedUpdate(() => {
  if (hidden) return;
  steps++;
  audio.tick(now());
  const r = app.round;
  if (r && app.flow === "round" && !r.paused) {
    if (r.phase === "active") r.setInput(sampleInput());
    else sampleInput();
    const evs = r.update(Sim.DT).slice();
    const lessonEv = r.pollLessonInput();
    if (lessonEv) evs.push(lessonEv);
    for (const e of evs) handleRoundEvent(e);
    if (r.invalidFlash) {
      announce(t(INVALID_KEYS[r.invalidFlash] || "capInvalid"), true);
      sound("invalid");
      r.invalidFlash = null;
    }
    if (r.phase === "done" && !app.resultsAt) app.resultsAt = steps + 54; // 900 ms
  }
  if (app.countHide && steps >= app.countHide) { app.countdown = null; app.countHide = 0; }
  if (r && app.flow === "round" && app.resultsAt && steps >= app.resultsAt) { app.resultsAt = 0; showResults(); }
});

// ------------------------------------------------------------------ boot and lifecycle
let lookKey = "";
function applyLook(): void {
  const f = frame();
  const k = `${f.quality}:${f.levelIndex}`;
  if (k === lookKey) return;
  lookKey = k;
  render.applyLook(lookFor(f.quality, f.levelIndex));
}
function applyOptions(): void {
  const o = platform.options;
  render.setCameraOptions(o.cameraShake, o.camera);
  render.setPalette(o.palette);
}
onLanguage(() => {
  // the local racer's default name ("You") follows the language, its name sprite too
  const r = app.round;
  const you = r?.state.players.find((p) => p.id === "you");
  if (you && app.youDefault) {
    you.name = t("you");
    render.setPlayerName(you.id, you.name);
    const sr = app.show?.roster.find((x: Any) => x.id === "you");
    if (sr) sr.name = you.name;
  }
});
onStart(() => {
  setFixedRate(60);
  initStyles();
  platform.initPlatform();
  audio.loadSfx();
  work.warm();
  render.setReducedMotion(preferences().reducedMotion);
  applyLook();
  applyOptions();
  showTitle();
});
onPreferencesChange((p) => render.setReducedMotion(p.reducedMotion));
onSessionEnded(() => toast(pt("signedOut")));
platform.onProgressMerged(() => toast(t("progressMerged")));
onSuspend(() => {
  hidden = true;
  if (app.round && app.flow === "round" && app.round.phase !== "done" && !app.round.paused) pauseRound(true);
  audio.setPaused(true);
  platform.flush();
});
onResume(() => { hidden = false; if (!app.round?.paused) audio.setPaused(false); });

let frameDt = 0;
onUpdate((dt) => {
  frameDt = Math.min(0.1, dt);
  applyLook();
  applyOptions();
  applyTokens(ui.preferences().highContrast);
  audio.update();
  const n = now();
  if (app.toast && app.toast.until < n) app.toast = null;
  if (app.caption && app.caption.until < n) app.caption = null;
  touchControls();
});
onRender(() => {
  const f = frame();
  if (app.round) render.render(app.round.state, app.round.localId, frameDt, f.width, f.height);
  else if (attract) { attractT += frameDt; render.renderAttract(attractT, frameDt, f.width, f.height); }
  drawScreens();
  for (const fn of pending.splice(0)) fn();
  flushAnnouncements();
});
export { work };
