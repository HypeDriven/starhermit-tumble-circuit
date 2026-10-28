// Localization: the browser build's tables (js/ui/strings.js: flat keys plus
// per-id maps for stages, themes, arenas, show courses, shows, lessons and
// their steps, challenges, mechanics and achievements; the account strings in
// js/ui/platformStrings.js) in the nine StarHermit locales, in the interface
// language the runtime reports (preferences().language: Options › Language,
// else the account's or the device's). This replaces sh-language.js and the
// DOM relabelling: every string is drawn through t() each frame, so a change
// shows on the next frame and never restarts the round.
import { onPreferencesChange, preferences } from "starhermit:engine";
import * as ui from "starhermit:ui";
import { STRINGS } from "../js/ui/strings.js";
import { platformStrings } from "../js/ui/platformStrings.js";
import { pickLocale } from "../js/ui/gfxStrings.js";
import type { Def } from "./game.ts";

type Table = Record<string, unknown>;
const TABLES = STRINGS as unknown as Record<string, Table>;
const EN = TABLES["en-US"]!;
let locale = "";
let dict: Table = EN;
let ptr: (k: string, v?: Vars) => string = platformStrings("en-US") as (k: string, v?: Vars) => string;
const listeners = new Set<() => void>();
export function onLanguage(fn: () => void): void { listeners.add(fn); }

function apply(tag: string): void {
  const next = pickLocale(String(tag || "en-US")) as string;
  const loc = TABLES[next] ? next : "en-US";
  if (loc === locale) return;
  locale = loc;
  dict = TABLES[loc]!;
  ptr = platformStrings(loc) as (k: string, v?: Vars) => string;
  ui.setLanguage(locale);
  for (const fn of listeners) fn();
}
apply(preferences().language);
onPreferencesChange((p) => apply(p.language));

export function currentLocale(): string { return locale; }
export type Vars = Record<string, string | number>;
const fill = (s: string, vars?: Vars | null): string =>
  vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (vars[k] != null ? String(vars[k]) : m)) : s;
/** i18n.js t(). */
export function t(key: string, vars?: Vars | null): string {
  return fill(String(dict[key] ?? EN[key] ?? key), vars);
}
/** i18n.js tn(). */
export function tn<V>(group: string, id: string, fallback: V): V {
  const own = (dict[group] as Record<string, unknown> | undefined)?.[id];
  if (own != null) return own as V;
  const en = (EN[group] as Record<string, unknown> | undefined)?.[id];
  return (en != null ? en : fallback) as V;
}
/** platformStrings.js (sign in, invite, signed out, leaderboard lines). */
export function pt(key: string, vars?: Vars): string { return ptr(key, vars); }

export const themeName = (id: string, fallback?: string): string => tn("themes", id, fallback ?? id);
export const mechanicName = (id: string): string => tn("mechanics", id, id);
/** i18n.js courseName. */
export function courseName(def: Def | null): string {
  if (!def) return "";
  if (def.challenge) return tn("challenges", def.challenge, def.name ?? def.id);
  if (def.type === "stage") return tn("stages", def.id, def.name ?? def.id);
  if (def.type === "arena") return tn("arenas", def.id, def.name ?? def.id);
  if (def.type === "lesson") return tn("lessons", def.id, def.title ?? def.id);
  if (/^daily-/.test(def.id || "")) return t("dailyName", { date: def.id.slice(6) });
  return tn("showCourses", def.id, def.name || def.id);
}
export function lessonText(id: string, fallback: string): string { return tn("lessonText", id, fallback); }
export function playerName(name: string): string {
  const m = /^Player (\S+)$/.exec(String(name ?? ""));
  return m ? t("playerN", { id: m[1]! }) : String(name ?? "");
}
