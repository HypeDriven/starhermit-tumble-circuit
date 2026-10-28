// The browser build's pure modules, typed for this client: the rules
// (js/rules: the 60 Hz deterministic race / survival simulation with its
// bots, scoring, shows and replays), the content (js/content: 40 Journey
// stages, five lessons, show courses, survival arenas, challenges, themes and
// the validated Daily), the local round driver (js/session/round.js) and the
// save model (js/platform/store.js: migrate / merge). They are ES modules
// shared with the node tests, unchanged apart from a JSON clone in daily.js
// (the engine interpreter has no structuredClone).
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as sim from "../js/rules/sim.js";
import * as scoring from "../js/rules/scoring.js";
import * as showMod from "../js/rules/show.js";
import * as courseMod from "../js/rules/course.js";
import * as rngMod from "../js/rules/rng.js";
import * as stages from "../js/content/stages.js";
import * as themes from "../js/content/themes.js";
import * as dailyMod from "../js/content/daily.js";
import * as round from "../js/session/round.js";
import * as store from "../js/platform/store.js";

export type Any = any;
export interface Player {
  id: string; name: string; color: number; isBot: boolean;
  x: number; y: number; z: number; px: number; py: number; pz: number; vx: number; vy: number; vz: number;
  st: string; invulnT: number; cp: number; progress: number; aliveTicks: number; finishTick: number; falls: number; jumps: number; eliminated: boolean;
}
export interface Ev { t: string; p?: string; x?: number; y?: number; z?: number; cp?: number; of?: number; place?: number; impact?: number; n?: number; step?: number }
export interface State {
  tick: number; timeLimit: number; kind: "race" | "survival"; course: Any; players: Player[]; finishOrder: string[]; quota: number;
  phase: string; terminal: { reason: string } | null; events: Ev[]; par: number;
}
export interface Def { id: string; type?: string; name?: string; title?: string; theme?: string; seed: number; kind?: string; stage?: number; passPlace?: number; mastery?: boolean; mechanics?: string[]; bots?: { count: number; skill: number }; challenge?: string; [k: string]: Any }
export interface Lesson extends Def { intro: string; steps: { id: string; text: string; check: Any }[] }
export interface Challenge { id: string; name: string; desc: string; base: string; mods: Any; goal: { kind: string; ticks?: number }; bots?: { count: number; skill: number } }
export interface ShowDef { id: string; name: string; players: number; botSkill: number; rounds: { courseId: string; quota: number }[] }
export interface Breakdown { checkpoints: number; placement: number; qualify: number; timeBonus: number; survival: number; falls: number }
export interface PlayerResult { playerId: string; place: number; qualified: boolean; finished: boolean; finishTick: number; aliveTicks: number; breakdown: Breakdown; total: number }
export interface RoundResult { places: string[]; results: Record<string, PlayerResult>; terminal: Any }
export interface LocalRound {
  def: Def; lesson: Lesson | null; state: State; localId: string; phase: string; cdLeft: number; accum: number; paused: boolean;
  result: RoundResult | null; finished: boolean; invalidFlash: string | null;
  setInput(i: Any): void; pause(): void; resume(): void; legal(): Any; update(dt: number): Ev[]; pollLessonInput(): Ev | null;
  lessonDone(): boolean; currentLessonStep(): { id: string; text: string } | null; challengeOutcome(): Any; exportReplay(): Any;
}
export interface Theme { id: string; name: string; music: Any; ambHz: number; [k: string]: Any }

export const Sim = sim as unknown as {
  TICK_RATE: number; DT: number; PSTATE: Record<string, string>; rankPlayers(s: State): Player[];
};
export const Scoring = scoring as unknown as { formatTicks(t: number): string };
export const Show = showMod as unknown as {
  createShow(def: ShowDef, roster: Any[]): Any; currentRound(s: Any): { courseId: string; quota: number }; isFinalRound(s: Any): boolean;
  applyRoundResult(s: Any, r: RoundResult): Any; showTable(s: Any): { id: string; name: string; points: number; rounds: number[]; champion: boolean }[];
};
export const Course = courseMod as unknown as {
  buildCourse(def: Def): Any; moverTransform(m: Any, tick: number): { x: number; z: number }; spinnerOmega(ob: Any, tick: number): number;
};
export const Rng = rngMod.Rng as unknown as new (seed: number, stream: string) => { range(a: number, b: number): number; float(): number; pick<T>(l: T[]): T; sign(): number };
export const Content = stages as unknown as {
  JOURNEY: Def[]; LESSONS: Lesson[]; ARENAS: Def[]; SHOW_COURSES: Def[]; SHOWS: ShowDef[]; CHALLENGES: Challenge[];
  courseById(id: string): Def | null; challengeCourse(c: Challenge): Def;
};
export const Themes = themes as unknown as { themeById(id: string): Theme; THEMES: Record<string, Theme> };
export const Daily = dailyMod as unknown as { DAILY_RULESET: number; isDailyExcluded(d: string): boolean; dailyDef(d: string): Def };
export const Round = round as unknown as {
  LocalRound: new (def: Def, roster: Any[], opts: Any) => LocalRound; buildRoster(name: string, color: number, bots: number, seed: number): Any[]; PALETTE: number[];
};
export interface SaveDoc {
  version: number; journey: { unlocked: number; passed: Record<string, number>; crowns: Record<string, boolean> };
  lessonsDone: Record<string, boolean>; challengesDone: Record<string, boolean>; daily: Record<string, number>;
  achievements: Record<string, number>; stats: { races: number; finishes: number; qualifies: number; showsWon: number; bestStreak: number };
  settings: Record<string, Any>; updatedAt?: number;
}
export const Store = store as unknown as { migrateSave(d: unknown): SaveDoc; mergeSaves(remote: unknown, local: unknown): SaveDoc };
