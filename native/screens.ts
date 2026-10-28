// The browser build's DOM shell (index.html + js/ui/app.js over
// css/main.css) as starhermit:ui, built every frame over the arena: the HUD
// (course and goal, the clock and place, the progress bar and cutoff, Pause),
// the lesson banner under it, the countdown, captions, the toast, a
// "thinking" line while a worker job runs, and the screens (title, modes,
// learn, journey, practice, challenges, show, pause, settings, help, results,
// show over) as dialogs over the dimmed arena. The old media queries are
// layouts picked by the window's logical size (≤ 700 px wide: the HUD wraps,
// the progress box takes its own row; ≤ 480 px tall landscape: the compact
// HUD).
import { frame, openMenu } from "starhermit:engine";
import { primaryPointer, requestRebind, touchControlsVisible } from "starhermit:input";
import * as draw from "starhermit:draw";
import * as ui from "starhermit:ui";
import { Content, Scoring, Sim, Themes, type Def } from "./game.ts";
import { courseName, lessonText, mechanicName, playerName, pt, t, themeName, tn } from "./i18n.ts";
import * as platform from "./platform.ts";
import { highContrast, token } from "./style.ts";
import {
  ACHIEVEMENTS, BOTS, SKILLS, app, backAuto, bannerText, continueShow, endRoundTo, fresh, goalText, invite, keysFor, later, menu, open,
  pauseRound, practiceCourses, profileName, resumeRound, retryCurrent, showTitle, signIn, sound, startChallenge, startDaily, startJourneyStage,
  startLesson, startPractice, startShow, work,
} from "./main.ts";

// ------------------------------------------------------------------ layout helpers
interface Layout { lw: number; lh: number; sc: number; narrow: boolean; short: boolean; ox: number; oy: number }
function layoutNow(): Layout {
  const f = frame();
  const sc = ui.preferences().scale;
  const sa = f.safeArea;
  const lw = Math.max(1, (f.width - sa.left - sa.right) / sc), lh = Math.max(1, (f.height - sa.top - sa.bottom) / sc);
  return { lw, lh, sc, narrow: lw <= 700, short: lh <= 480 && lw > lh, ox: sa.left, oy: sa.top };
}
const lastSize = new Map<string, ui.Rect>();
function textWidth(text: string, style: string, kind?: "button" | "heading"): number {
  return ui.measureText(text, { ...(kind ? { kind } : {}), style: [style] }).width / ui.preferences().scale;
}
/** Text up to `width` wide: one label when it fits, else a paragraph. */
function para(text: string, width: number, cls = "text", id?: string): void {
  if (!text) return;
  let u = ui.style(cls);
  if (id) u = u.id(id);
  if (textWidth(text, cls) <= width) u.label(text);
  else u.paragraph(text, Math.max(20, width));
}
interface Btn { id: string; text: string; style?: string; act: () => void; disabled?: boolean; width?: number }
const btnWidth = (b: Btn): number => textWidth(b.text, b.style ?? "btn", "button") + 2;
function button(b: Btn): void {
  const style = b.style ?? "btn";
  const opts: ui.ButtonOptions = {};
  if (b.disabled) opts.disabled = true;
  if (b.width != null && btnWidth(b) > b.width) {
    opts.content = () => { ui.style(style === "btn-primary" ? "wrap-dark" : "wrap").paragraph(b.text, Math.max(20, b.width! - 40)); };
  }
  const s: ui.Style = {};
  if (b.width != null) s.width = b.width;
  if (ui.style(style, s).id(b.id).button(b.text, opts) && fresh()) later(() => { sound("ui"); b.act(); });
}
/** Buttons at their own widths in rows that wrap at `width` (.row flex-wrap). */
function flow(label: string, list: Btn[], width: number, justify: "start" | "center" = "start", gap = 10): void {
  const rows: Btn[][] = [[]];
  let used = 0;
  const bw = (b: Btn): number => Math.min(width, b.width ?? btnWidth(b));
  for (const b of list) {
    const w = bw(b);
    if (rows[rows.length - 1]!.length && used + gap + w > width) { rows.push([]); used = 0; }
    used += (rows[rows.length - 1]!.length ? gap : 0) + w;
    rows[rows.length - 1]!.push(b);
  }
  ui.column(label, () => {
    rows.forEach((row, ri) => ui.row(`${label}-r${ri}`, () => { for (const b of row) button({ ...b, width: bw(b) }); }, { spacing: gap, width, justify, align: "center" }));
  }, { spacing: gap, width });
}
/** .card-grid: auto-fill columns of at least `min` px. */
function grid(id: string, n: number, w: number, min: number, cell: (i: number, cw: number) => void, gap = 10): void {
  const cols = Math.max(1, Math.floor((w + gap) / (min + gap)));
  const cw = (w - (cols - 1) * gap) / cols;
  ui.column(id, () => {
    for (let r = 0; r * cols < n; r++) {
      ui.row(`${id}-r${r}`, () => { for (let i = r * cols; i < Math.min(n, (r + 1) * cols); i++) cell(i, cw); }, { spacing: gap, align: "start" });
    }
  }, { spacing: gap, width: w });
}
/** .card: a button whose face is a bold title over a dim sub line. */
function card(id: string, title: string, sub: string, w: number, act: () => void, opts: { style?: string; disabled?: boolean } = {}): void {
  const iw = w - 26;
  if (ui.style(opts.style ?? "card", { width: w }).id(id).button(`${title}, ${sub}`, {
    disabled: !!opts.disabled,
    content: () => ui.column(`${id}-c`, () => { para(title, iw, "card-title"); para(sub, iw, "card-sub"); }, { spacing: 2, width: iw }),
  }) && fresh()) later(() => { sound("ui"); act(); });
}

// ------------------------------------------------------------------ the frame
export function drawScreens(): void {
  const L0 = layoutNow();
  const r = app.round;
  const playing = !!r && app.flow === "round";
  if (r && (playing || app.flow === "results") && app.overlay !== "showOver") hud(L0);
  if (app.countdown && playing && !app.overlay) {
    ui.place("countdown", { anchor: "center", x: 0, y: 0 }, () => ui.style(L0.narrow || L0.short ? "countdown-s" : "countdown").id("countdown-text").label(app.countdown!));
  }
  if (app.caption) {
    ui.place("captions", { anchor: "bottom", y: 120 }, () => ui.column("caption-box", () => ui.style("caption").label(app.caption!.text), { style: "caption-box" }));
  }
  if (app.toast) {
    const w = Math.min(L0.lw - 32, 520);
    ui.place("toast", { anchor: "bottom", y: 24 }, () => {
      ui.column("toast-box", () => para(app.toast!.text, Math.min(textWidth(app.toast!.text, "toast-text") + 1, w - 34), "toast-text", "toast-text"), { style: "toast" });
    });
  }
  overlay(L0);
  if (app.focusNext) {
    const age = frame().frame - app.openedFrame;
    // results focus their first button only after ~0.4 s: a jump key still held from the finish must not press it
    const delay = app.overlay === "results" ? 24 : 1;
    if (age >= delay) ui.setFocus(app.focusNext);
    if (age >= delay + 2) app.focusNext = null;
  }
}

// ------------------------------------------------------------------ HUD (#hud) and the lesson banner
let hudH = 68;
function hud(L0: Layout): void {
  const r = app.round!;
  const s = r.state;
  const box = highContrast ? "hud-box-hc" : L0.short ? "hud-box-s" : "hud-box";
  const pad = L0.short ? 10 : 14;
  const side = 10, gap = L0.narrow ? 6 : 12;
  const inner = L0.lw - 2 * side;
  const title = courseName(r.def);
  const goal = goalText();
  const clock = Scoring.formatTicks(Math.max(0, s.timeLimit - s.tick));
  const me = s.players.find((p) => p.id === r.localId);
  let place = "—", prog = 0;
  if (me) {
    const ranked = Sim.rankPlayers(s);
    const pl = ranked.findIndex((p) => p.id === me.id) + 1;
    place = me.st === Sim.PSTATE.FINISH ? t("finishedN", { n: me.finishTick >= 0 ? s.finishOrder.indexOf(me.id) + 1 : "—" }) : t("placeOf", { place: pl, total: s.players.length });
    prog = s.kind === "race" ? Math.min(100, (me.progress / s.course.finishZ) * 100) : Math.min(100, (me.aliveTicks / s.timeLimit) * 100);
  }
  const quota = s.kind === "survival" ? "" : t("cutoff", { n: s.quota, total: s.players.length });
  const pauseW = 48;
  const centerW = Math.max(textWidth("0:00.00", "hud-clock"), textWidth(place, "hud-place")) + 2 * pad + 2;
  const rightW = Math.max(160, textWidth(quota, "hud-quota") + 2) + 2 * pad;
  // wide: objective | center | right | pause on one row; narrow: objective + center + pause, then the progress box
  const oneRow = !L0.narrow;
  const objMax = oneRow ? inner - centerW - rightW - pauseW - 3 * gap : inner - centerW - pauseW - 2 * gap;
  const objIn = Math.max(80, Math.min(Math.min(objMax, 560) - 2 * pad - 2, Math.max(textWidth(title, "hud-title"), textWidth(goal, "hud-goal")) + 1));
  const objective = (): void => {
    ui.column("hud-objective", () => {
      para(title, objIn, "hud-title", "hud-title");
      para(goal, objIn, "hud-goal", "hud-goal");
    }, { style: box, width: objIn + 2 * pad + 2, spacing: 2 });
  };
  const center = (): void => {
    ui.column("hud-center", () => {
      ui.style("hud-clock").id("hud-clock").label(clock);
      ui.style("hud-place").id("hud-place").label(place);
    }, { style: box, width: centerW, spacing: 0, align: "center" });
  };
  const right = (w: number): void => {
    ui.column("hud-right", () => {
      const bw = w - 2 * pad - 2;
      ui.widget(t("ariaProgress") + ` ${prog.toFixed(0)}%`, {
        role: "meter", size: { width: bw, height: 10 }, value: prog / 100,
        draw: (rc) => {
          draw.roundRect(rc.x, rc.y, rc.width, rc.height, 5, "#ffffff26");
          if (prog > 0) draw.roundRect(rc.x, rc.y, Math.max(rc.height, (rc.width * prog) / 100), rc.height, 5, token("ok"));
        },
      });
      if (quota) ui.style("hud-quota").id("hud-quota").label(quota);
    }, { style: box, width: w, spacing: 4 });
  };
  const pause = (): void => {
    if (ui.style("btn-icon", { width: pauseW }).id("btn-pause").button(t("pause"), { content: () => ui.style("hud-title").label("II") }) && fresh()) {
      later(() => (r.paused ? resumeRound() : pauseRound()));
    }
  };
  const y = L0.short ? 4 : 8;
  const rect = ui.place("hud", { anchor: "top-start", x: side, y }, () => {
    ui.column("hud-top", () => {
      ui.row("hud-r0", () => {
        objective();
        ui.spacer();
        center();
        if (oneRow) { ui.spacer(); right(rightW); }
        pause();
      }, { width: inner, spacing: gap, align: "start" });
      if (!oneRow) ui.row("hud-r1", () => right(inner), { width: inner });
    }, { width: inner, spacing: gap });
  });
  hudH = rect.height / L0.sc;
  // lesson banner below the measured HUD
  const banner = bannerText();
  if (banner && app.flow === "round" && !app.overlay) {
    const bw = Math.min(L0.lw * 0.9, 620) - 40;
    const tw = Math.min(bw, textWidth(banner, "banner-text") + 1);
    ui.place("lesson-banner", { anchor: "top", y: y + hudH + 12 }, () => {
      ui.column("lesson-banner-box", () => para(banner, tw, "banner-text", "lesson-banner"), { style: "banner" });
    });
  }
  if (app.flow === "round" && r.paused === false && r.phase !== "done") ui.target(`${title}. ${goal}. ${place}. ${clock}`, { x: 0, y: 0, width: 1, height: 1 }, { role: "label" });
}

// ------------------------------------------------------------------ screens (#screens > .screen > .panel)
type O = NonNullable<typeof app.overlay>;
function overlay(L0: Layout): void {
  const o = app.overlay;
  if (!o) return;
  const wide = o === "journey";
  const w = Math.min(wide ? 900 : 640, L0.lw * (wide ? 0.96 : 0.94), L0.lw - 16);
  const padX = L0.narrow ? 18 : 28, padY = L0.narrow ? 16 : 24;
  const inner = w - 2 * padX;
  const maxH = L0.lh * 0.92 - 8;
  const key = `panel-${o}`;
  const prev = lastSize.get(key);
  const foot = footer(o);
  const footH = foot.length ? (lastSize.get(`${key}-foot`)?.height ?? 58 * L0.sc) / L0.sc + 14 : 0;
  const scroll = !!prev && prev.height / L0.sc + 2 * padY + footH > maxH;
  const opening = frame().frame - app.openedFrame <= 6;
  const isOpen = ui.dialog(panelLabel(o), "", true, () => {
    ui.column("panel", () => {
      const iw = inner - (scroll ? 14 : 0);
      const body = (): void => { lastSize.set(key, ui.column(`${key}-in`, () => buildPanel(o, iw, L0), { spacing: 10, width: iw })); };
      if (scroll) ui.scrollArea(`${key}-scroll`, { width: inner + 6, height: maxH - 2 * padY - footH }, body, opening ? { scrollTo: { top: 0 } } : undefined);
      else body();
      if (foot.length) lastSize.set(`${key}-foot`, ui.column("panel-foot", () => flow(`${o}-foot`, foot, inner), { width: inner, padding: { top: 14 } }));
    }, { style: highContrast ? "panel-hc" : "panel", width: w, spacing: 0, padding: { top: padY, bottom: padY, start: padX, end: padX } });
  });
  if (!isOpen && fresh()) {
    if (o === "pause") later(resumeRound);
    else if (o === "results" || o === "showOver") later(() => endRoundTo(() => menu("modes")));
    else if (o === "modes") later(showTitle);
    else if (o === "learn" || o === "journey" || o === "practice" || o === "challenges" || o === "show") later(() => menu("modes"));
    else if (o === "help" || o === "settings") later(backAuto);
  }
}
function panelLabel(o: O): string {
  switch (o) {
    case "title": return "Tumble Circuit";
    case "modes": return t("modesH");
    case "learn": return t("learn");
    case "journey": return t("journey");
    case "practice": return t("practice");
    case "challenges": return t("challengesH");
    case "show": return t("show");
    case "pause": return t("paused");
    case "settings": return t("settings");
    case "help": return t("howToPlay");
    case "results": return app.results ? app.results.headline() : "";
    case "showOver": return t("show");
  }
}
/** The buttons that close each screen, kept outside its scroll area (always visible and clickable). */
function footer(o: O): Btn[] {
  const back = (act: () => void): Btn => ({ id: "btn-back", text: t("back"), act });
  switch (o) {
    case "modes": return [back(showTitle)];
    case "learn": case "journey": case "challenges": case "show": return [back(() => menu("modes"))];
    case "practice": return [
      { id: "btn-prac-go", text: t("start"), style: "btn-primary", act: () => { const p = app.practice; startPractice(practiceCourses()[p.course]!.id, SKILLS[p.skill]!, BOTS[p.bots]!); } },
      back(() => menu("modes")),
    ];
    case "settings": return [
      { id: "btn-set-done", text: t("done"), style: "btn-primary", act: backAuto },
      { id: "btn-replay-tutorial", text: t("replayTutorial"), act: () => startLesson(0) },
    ];
    case "help": return [{ id: "btn-help-done", text: t("done"), style: "btn-primary", act: backAuto }];
    case "results": {
      const spec = app.results;
      if (!spec) return [];
      const list: Btn[] = [];
      if (spec.next) list.push({ id: "btn-res-next", text: spec.next.label(), style: "btn-primary", act: spec.next.fn });
      list.push({ id: "btn-res-retry", text: t("retry"), act: retryCurrent });
      if (app.ctx?.kind === "show") list.push({ id: "btn-res-show", text: t("continueShow"), act: continueShow });
      list.push({ id: "btn-res-menu", text: t("modeSelect"), act: () => endRoundTo(() => menu("modes")) });
      list[0]!.id = "btn-res-first";
      return list;
    }
    case "showOver": return [
      { id: "btn-res-first", text: t("modeSelect"), style: "btn-primary", act: () => endRoundTo(() => menu("modes")) },
      { id: "btn-show-title", text: t("titleBtn"), act: showTitle },
    ];
    default: return [];
  }
}
function buildPanel(o: O, w: number, L0: Layout): void {
  switch (o) {
    case "title": titlePanel(w, L0); break;
    case "modes": modesPanel(w); break;
    case "learn": learnPanel(w); break;
    case "journey": journeyPanel(w); break;
    case "practice": practicePanel(w); break;
    case "challenges": challengesPanel(w); break;
    case "show": showPanel(w); break;
    case "pause": pausePanel(w); break;
    case "settings": settingsPanel(w); break;
    case "help": helpPanel(w); break;
    case "results": resultsPanel(w); break;
    case "showOver": showOverPanel(w); break;
  }
  if (app.preparing || work.busy()) para(app.preparing ? t("preparingDaily") : t("thinking"), w, "thinking", "thinking");
}
function heading(title: string, w: number, sub?: string): void {
  para(title, w, "h1", "screen-title");
  if (sub) para(sub, w, "dim", "screen-sub");
}
function syncText(): string {
  const st = platform.syncState();
  const key = st === "synced" ? "syncSynced" : st === "error" ? "syncError" : st === "local" ? "syncOffline" : "syncSaving";
  return t("playingAs", { name: playerName(profileName()), status: t(key) });
}

function titlePanel(w: number, L0: Layout): void {
  const big = !L0.narrow && !L0.short;
  const a = big ? "logo" : "logo-s", b = big ? "logo-em" : "logo-em-s";
  ui.row("title-logo", () => { ui.style(a).label("Tumble"); ui.style(b).label("Circuit"); }, { width: w, justify: "center", spacing: big ? 13 : 10 });
  ui.row("title-sub-row", () => para(t("tagline"), w, "dim", "title-sub"), { width: w, justify: "center" });
  ui.row("account-row", () => para(platform.signedIn() ? syncText() : t("guestLine"), w, "small", "account-line"), { width: w, justify: "center" });
  ui.column("title-gap", () => undefined, { height: 4 });
  button({ id: "btn-play", text: t("play"), style: "btn-primary", act: () => menu("modes"), width: w });
  const save = platform.doc();
  const best = save.daily[platform.utcDate()];
  flow("title-row1", [
    { id: "btn-daily", text: best ? t("dailyBest", { n: best }) : t("dailyChallenge"), act: startDaily, disabled: !!app.preparing },
    { id: "btn-journey", text: t("journeyN", { n: Object.keys(save.journey.passed).length }), act: () => menu("journey") },
    { id: "btn-learn", text: t("learn"), act: () => menu("learn") },
  ], w, "center");
  const row2: Btn[] = [
    { id: "btn-settings", text: t("settings"), act: () => { app.returnTo = "title"; menu("settings"); } },
    { id: "btn-help", text: t("help"), act: () => { app.returnTo = "title"; menu("help"); } },
  ];
  if (!platform.signedIn()) row2.push({ id: "btn-signin", text: pt("signIn"), act: signIn });
  if (platform.inviteLink()) row2.push({ id: "btn-invite", text: pt("invite"), act: invite });
  flow("title-row2", row2, w, "center");
  const touch = touchControlsVisible() || primaryPointer() === "coarse";
  const hint = touch ? t("touchHint") : t("keysHint", { move: keysFor("forward", "left", "back", "right"), jump: keysFor("jump"), dive: keysFor("dive"), pause: keysFor("pause") });
  ui.row("hint-row", () => para(hint, w, "small", "keys-hint"), { width: w, justify: "center" });
}

function modesPanel(w: number): void {
  heading(t("modesH"), w);
  const cards: [string, string, string, () => void, boolean][] = [
    ["learn", t("learn"), t("learnSub"), () => menu("learn"), false],
    ["journey", t("journey"), t("journeySub"), () => menu("journey"), false],
    ["daily", t("daily"), t("dailySub"), startDaily, !!app.preparing],
    ["practice", t("practice"), t("practiceSub"), () => menu("practice"), false],
    ["challenges", t("challengesH"), t("challengesSub"), () => menu("challenges"), false],
    ["show", t("show"), t("showSub"), () => menu("show"), false],
    // The browser build's rooms belonged to its own dev server; on StarHermit the card stays disabled, as it was there.
    ["hosted", t("hostedPlay"), t("hostedSubPlatform"), () => undefined, true],
  ];
  grid("mode-grid", cards.length, w, 150, (i, cw) => {
    const [id, title, sub, act, disabled] = cards[i]!;
    card(`mode-${id}`, title, sub, cw, act, { disabled });
  });
}
function learnPanel(w: number): void {
  heading(t("learn"), w, t("learnSubtitle"));
  const done = platform.doc().lessonsDone;
  grid("lesson-grid", Content.LESSONS.length, w, 150, (i, cw) => {
    const l = Content.LESSONS[i]!;
    card(`lesson-${i + 1}`, `${i + 1}. ${tn("lessons", l.id, l.title ?? l.id)}`, lessonText(l.id, l.intro), cw, () => startLesson(i), { style: done[l.id] ? "card-done" : "card" });
  });
}
function journeyPanel(w: number): void {
  const save = platform.doc();
  heading(t("journey"), w, t("journeyUnlocked", { n: save.journey.unlocked }));
  grid("stage-grid", Content.JOURNEY.length, w, 150, (i, cw) => {
    const st = Content.JOURNEY[i]!;
    const n = st.stage!;
    const id = "j" + String(n).padStart(2, "0");
    const locked = n > save.journey.unlocked;
    const passed = !!save.journey.passed[id];
    const crown = !!save.journey.crowns[id];
    const sub = `${themeName(st.theme!, Themes.themeById(st.theme!).name)} · ${t("topN", { n: st.passPlace! })} · ${(st.mechanics ?? []).map(mechanicName).join(", ")}`;
    card(`stage-${n}`, `${n}. ${courseName(st)}${crown ? " ♛" : ""}`, sub, cw, () => startJourneyStage(n), {
      disabled: locked, style: st.mastery ? "card-mastery" : passed ? "card-done" : "card",
    });
  });
}
function selectRow(id: string, label: string, idx: number, items: string[], w: number, set: (i: number) => void): void {
  const lw = Math.min(200, w * 0.4);
  ui.row(`${id}-row`, () => {
    para(label, lw, "text", `${id}-label`);
    ui.spacer();
    const pick = ui.id(id).select(label, idx, items, { width: Math.min(w - lw - 12, 320) } as ui.WidgetOptions);
    if (pick !== idx) later(() => set(pick));
  }, { width: w, align: "center", spacing: 12, height: 52 });
}
function practicePanel(w: number): void {
  heading(t("practice"), w, t("practiceSubtitle"));
  const p = app.practice;
  const courses = practiceCourses().map((d: Def) => (d.type === "arena" ? t("survivalTag", { name: courseName(d) }) : `${d.stage}. ${courseName(d)}`));
  selectRow("prac-course", t("courseLabel"), p.course, courses, w, (i) => { p.course = i; });
  selectRow("prac-skill", t("botDifficulty"), p.skill, [t("gentle"), t("medium"), t("fierce"), t("probe")], w, (i) => { p.skill = i; });
  selectRow("prac-bots", t("rivals"), p.bots, [t("solo"), "3", "7", "11"], w, (i) => { p.bots = i; });
}
function challengesPanel(w: number): void {
  heading(t("challengesH"), w);
  const done = platform.doc().challengesDone;
  grid("chal-grid", Content.CHALLENGES.length, w, 150, (i, cw) => {
    const c = Content.CHALLENGES[i]!;
    card(`chal-${c.id}`, tn("challenges", c.id, c.name), tn("challengeDesc", c.id, c.desc), cw, () => startChallenge(c.id), { style: done[c.id] ? "card-done" : "card" });
  });
}
function showPanel(w: number): void {
  heading(t("show"), w, t("showSubtitle"));
  grid("show-grid", Content.SHOWS.length, w, 150, (i, cw) => {
    const s = Content.SHOWS[i]!;
    card(`show-${s.id}`, tn("shows", s.id, s.name), t("showCard", { players: s.players, rounds: s.rounds.length, quotas: s.rounds.map((r) => r.quota).join(" → ") }), cw, () => startShow(s.id));
  });
}
function pausePanel(w: number): void {
  heading(t("paused"), w);
  ui.column("pause-col", () => {
    button({ id: "btn-resume", text: t("resume"), style: "btn-primary", act: resumeRound, width: w });
    button({ id: "btn-pause-retry", text: t("retryRound"), act: retryCurrent, width: w });
    button({ id: "btn-pause-settings", text: t("settings"), act: () => { app.returnTo = "pause"; open("settings"); }, width: w });
    button({ id: "btn-pause-help", text: t("help"), act: () => { app.returnTo = "pause"; open("help"); }, width: w });
    button({ id: "btn-leave", text: t("leaveRound"), style: "btn-danger", act: () => endRoundTo(() => menu("modes")), width: w });
  }, { spacing: 10, width: w });
}
/** A check box row (a role "checkbox" widget drawing its box; its label wraps). */
function toggleRow(id: string, label: string, on: boolean, w: number, set: (v: boolean) => void): void {
  ui.row(`${id}-row`, () => {
    para(label, w - 56, "text", `${id}-label`);
    ui.spacer();
    const res = ui.id(id).widget(label, {
      role: "checkbox", checked: on, size: { width: 44, height: 44 },
      draw: (r, st) => {
        const s = st.scale, box = 22 * s, bx = r.x + (r.width - box) / 2, by = r.y + (r.height - box) / 2;
        draw.roundRect(bx, by, box, box, 4, on ? token("accent") : "#1c2440");
        draw.strokeRoundRect(bx, by, box, box, 4, token("accent"), 2);
        if (on) draw.text("✓", bx + box / 2, by + 1 * s, { size: 17 * s, color: token("dark"), align: "center", weight: "bold" });
      },
    });
    if (res.activated && fresh()) later(() => { set(!on); sound("ui"); });
  }, { width: w, align: "center", spacing: 8, height: 48 });
}
/** Settings: what the runtime's Options don't cover (sound volumes, graphics, reduced motion, contrast, text size and language are there). */
function settingsPanel(w: number): void {
  const o = platform.options;
  heading(t("settings"), w);
  para(t("optionsNote"), w, "dim", "options-note");
  flow("set-runtime", [
    { id: "btn-options", text: t("openOptions"), act: () => openMenu() },
    { id: "btn-rebind", text: t("keyBindings"), act: () => requestRebind() },
  ], w);
  para(t("audio"), w, "h2", "set-audio-h");
  toggleRow("set-captions", t("captions"), o.captions, w, (v) => platform.setOption("captions", v));
  para(t("graphics"), w, "h2", "set-gfx-h");
  toggleRow("set-shake", t("cameraShake"), o.cameraShake, w, (v) => platform.setOption("cameraShake", v));
  selectRow("set-camera", t("camera"), o.camera === "far" ? 1 : 0, [t("camFollow"), t("camFar")], w, (i) => platform.setOption("camera", i ? "far" : "follow"));
  para(t("accessibility"), w, "h2", "set-a11y-h");
  const PAL = ["palStandard", "palDeut", "palProt", "palTrit"];
  selectRow("set-palette", t("colorPalette"), Math.max(0, platform.PALETTES.indexOf(o.palette)), PAL.map((k) => t(k)), w, (i) => platform.setOption("palette", platform.PALETTES[i]!));
  toggleRow("set-lefty", t("leftHanded"), o.leftHanded, w, (v) => platform.setOption("leftHanded", v));
}
function table(id: string, cols: number[], rows: { cells: string[]; cls?: string; numCls?: string }[], w: number): void {
  const total = cols.reduce((a, b) => a + b, 0);
  const widths = cols.map((c) => (c / total) * (w - 16));
  ui.column(id, () => {
    rows.forEach((row, ri) => ui.row(`${id}-r${ri}`, () => {
      row.cells.forEach((c, ci) => {
        ui.row(`${id}-r${ri}-c${ci}`, () => {
          if (ci > 0) ui.spacer();
          para(c, widths[ci]! - 8, ci === 0 ? (row.cls ?? "td") : (row.numCls ?? "td-num"));
        }, { width: widths[ci]!, align: "center" });
      });
    }, { style: "tr", width: w, spacing: 0, align: "center" }));
  }, { spacing: 0, width: w });
}
function helpPanel(w: number): void {
  heading(t("howToPlay"), w);
  para(t("goal"), w, "h2");
  para(t("goalText"), w, "text", "help-goal");
  para(t("controls"), w, "h2");
  table("help-controls", [1, 3], [
    { cells: [t("move"), t("moveRow", { keys: keysFor("forward", "left", "back", "right") })] },
    { cells: [t("jump"), t("jumpRow", { keys: keysFor("jump") })] },
    { cells: [t("dive"), t("diveRow", { keys: keysFor("dive") })] },
    { cells: [t("pause"), t("pauseRow", { keys: keysFor("pause") })] },
  ], w);
  para(t("rulesCards"), w, "h2");
  para(t("rulesText"), w, "text", "help-rules");
  para(t("fairPlay"), w, "h2");
  para(t("fairText"), w, "text", "help-fair");
}
function resultsPanel(w: number): void {
  const spec = app.results;
  const r = app.round;
  if (!spec || !r) return;
  const b = spec.me.breakdown;
  heading(spec.headline(), w);
  para(t("scoreBreakdown"), w, "h2");
  const row = (k: string, v: number): { cells: string[] } => ({ cells: [t(k), String(v)] });
  table("breakdown", [3, 1], [
    row("checkpoints", b.checkpoints), row("placement", b.placement), row("qualifyBonus", b.qualify), row("timeBonus", b.timeBonus),
    row("survival", b.survival), row("fallsPenalty", b.falls),
    { cells: [t("total"), String(spec.me.total)], cls: "th", numCls: "th-num" },
  ], w);
  para(t("standings"), w, "h2");
  const kind = r.state.kind;
  table("standings", [5, 3, 2.4], [
    { cells: [t("colPlayer"), t("colResult"), t("colScore")], cls: "th", numCls: "th-num" },
    ...spec.res.places.map((id) => {
      const pr = spec.res.results[id]!;
      const p = r.state.players.find((x) => x.id === id);
      const you = id === r.localId;
      return {
        cells: [`${pr.place}. ${p ? playerName(p.name) : id}${pr.qualified ? " ✓" : ""}`,
          pr.finished ? Scoring.formatTicks(pr.finishTick) : kind === "survival" ? t("alive", { time: Scoring.formatTicks(pr.aliveTicks) }) : t("dnf"), String(pr.total)],
        cls: you ? "td-you" : "td", numCls: you ? "td-you-num" : "td-num",
      };
    }),
  ], w);
  for (const key of spec.newly) para(t("achievementUnlocked", { name: tn<string[]>("achievements", key, [ACHIEVEMENTS[key]!.name])[0]! }), w, "hud-place", `ach-${key}`);
  if (spec.lb) para(spec.lb(), w, "text", "results-lb");
  const seed = r.def.seed;
  para(spec.replay ? (spec.replay.ok ? t("replayOk", { seed }) : t("replayBad", { reason: spec.replay.reason ?? "", seed })) : t("checkingReplay"), w, "small", "replay-line");
}
function showOverPanel(w: number): void {
  const so = app.showOver;
  if (!so) return;
  heading(so.champ ? t("champion") : so.eliminated ? t("eliminatedShowOver") : t("showOver", { show: tn("shows", so.def.id, so.def.name) }), w,
    t("showPlaced", { place: so.place || "—", points: so.points }));
  table("show-table", [5, 2.4, 3], [
    { cells: [t("colPlayer"), t("colPoints"), t("colRounds")], cls: "th", numCls: "th-num" },
    ...so.table.map((r) => ({
      cells: [`${r.champion ? "👑 " : ""}${playerName(r.name)}`, String(r.points), r.rounds.join(", ") || "—"],
      cls: r.id === "you" ? "td-you" : "td", numCls: r.id === "you" ? "td-you-num" : "td-num",
    })),
  ], w);
}

