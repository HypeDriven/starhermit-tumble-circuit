// Localization: assets/strings.json (generated from the browser build's tables:
// flat keys plus group.id keys for stages, themes, arenas, show courses, shows,
// lessons and their steps, challenges, mechanics and achievements, the nine
// StarHermit locales) on the engine's strings, which follow the interface language
// the runtime reports (Options › Language, else the account's or the device's) and
// own the locale fallback and the account lines (`starhermit.*`). This replaces
// sh-language.js and the DOM relabelling: every string is drawn through t() each
// frame, so a change shows on the next frame and never restarts the round.
import {files, preferences, strings} from "starhermit:engine";

// Locale tables are split per language. Only the player's fallback chain is
// parsed and kept (en-US first, so it remains the default). Other locales stay
// in the package until the language changes.
const __stringLocales = new Set<string>();
let __stringsBusy = false;
let __stringsWatching = false;
function loadGameStrings(dir: string): void {
  if (__stringsBusy) return;
  __stringsBusy = true;
  try {
    let tag = "en";
    try {
      const language = preferences().language;
      if (language) tag = language;
    } catch { /* preferences are not ready while the module is still loading */ }
    const want = stringLocalesFor(tag);
    const ordered = [...want.filter((locale) => locale === "en-US"), ...want.filter((locale) => locale !== "en-US")];
    const batch: { [locale: string]: unknown } = {};
    for (const locale of ordered) {
      if (__stringLocales.has(locale)) continue;
      const path = `${dir}/${locale}.json`;
      if (!files.exists(path)) continue;
      const table = files.readJson(path);
      if (!table || typeof table !== "object" || Array.isArray(table)) continue;
      batch[locale] = table;
    }
    const added = Object.keys(batch);
    if (added.length) {
      strings.load(batch);
      for (const locale of added) __stringLocales.add(locale);
    }
  } finally {
    __stringsBusy = false;
  }
  if (!__stringsWatching) {
    __stringsWatching = true;
    strings.onChange(() => loadGameStrings(dir));
  }
}
function stringLocalesFor(tag: string): string[] {
  const out: string[] = [];
  const add = (locale: string): void => { if (locale && !out.includes(locale)) out.push(locale); };
  const bits = tag.replace(/_/g, "-").split("-").filter(Boolean);
  const language = (bits[0] || "en").toLowerCase();
  const regionBit = bits.slice(1).find((part) => /^[A-Za-z]{2}$/.test(part) || /^\d{3}$/.test(part));
  const region = regionBit ? (/^\d{3}$/.test(regionBit) ? regionBit : regionBit.toUpperCase()) : "";
  add(region ? `${language}-${region}` : language);
  if (bits.length > 2) {
    add(bits.map((part, index) => index === 0 ? language : (/^[A-Za-z]{2}$/.test(part) ? part.toUpperCase() : part)).join("-"));
  }
  if (language === "en" && region && region !== "US" && region !== "CA") add("en-001");
  if (language === "en" && region && region !== "US") add("en-GB");
  if (language === "es" && region !== "ES") add("es-419");
  if (language === "es") add("es-ES");
  if (language === "fr") add("fr-FR");
  if (language === "fr" && region === "CA") add("fr-CA");
  if (language === "de") add("de-DE");
  if (language === "pt" && region !== "BR") add("pt-PT");
  if (language === "pt") add("pt-BR");
  if (language === "it") add("it-IT");
  if (language === "nl") add("nl-NL");
  if (language === "ja") add("ja-JP");
  if (language === "zh") {
    const traditional = region === "HK" || region === "TW" || region === "MO";
    add(traditional ? "zh-HK" : "zh-CN");
    if (!traditional) add("zh-SG");
  }
  if (language === "yue") add("yue-HK");
  if (language === "ru") add("ru-FI");
  add(language);
  add("en-US");
  return out;
}
import * as ui from "starhermit:ui";
import type { Def } from "./game.ts";

loadGameStrings("assets/l10n/strings");
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
