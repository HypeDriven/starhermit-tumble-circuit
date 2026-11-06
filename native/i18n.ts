// Localization: assets/strings.json (generated from the browser build's tables:
// flat keys plus group.id keys for stages, themes, arenas, show courses, shows,
// lessons and their steps, challenges, mechanics and achievements, the nine
// StarHermit locales) on the engine's strings, which follow the interface language
// the runtime reports (Options › Language, else the account's or the device's) and
// own the locale fallback and the account lines (`starhermit.*`). This replaces
// sh-language.js and the DOM relabelling: every string is drawn through t() each
// frame, so a change shows on the next frame and never restarts the round.
import { strings } from "starhermit:engine";
import * as ui from "starhermit:ui";
import type { Def } from "./game.ts";

strings.load("assets/strings.json");
strings.defaultLocale = "en-US";
ui.setLanguage(strings.locale);
strings.onChange((locale) => ui.setLanguage(locale));
export function onLanguage(fn: () => void): void { strings.onChange(() => fn()); }

export type Vars = Record<string, string | number>;
/** i18n.js t(). */
export function t(key: string, vars?: Vars | null): string { return strings.t(key, vars ?? undefined); }
/** i18n.js tn(): a content name by its group.id key. */
export function tn(group: string, id: string, fallback: string): string {
  const key = `${group}.${id}`;
  return strings.has(key) ? strings.t(key) : fallback;
}
/** The engine's account strings (signIn, invite, inviteCopied, inviteLink, signedOut, leaderboard…). */
export function pt(key: string, vars?: Vars): string { return strings.t(`starhermit.${key}`, vars); }

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
