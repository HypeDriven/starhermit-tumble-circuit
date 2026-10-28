// The game's data and the StarHermit platform on the runtime's modules (what
// js/platform/platform.js + store.js did over the JS SDK and localStorage):
// - the save (starhermit:storage `saves`, schema 1: on the device and in the
//   player's cloud slot) is the browser build's progression document
//   (store.js: journey, lessons, challenges, dailies, achievements, stats);
//   two devices' saves merge on a conflict (store.js mergeSaves, as the
//   browser build merged on its saveconflict); the slot the browser build
//   wrote through the JS SDK (game:<slug>, the checksummed document) shows as
//   foreign: it is merged in (its settings adopted as below) and replaced once;
// - the game's own options (colour palette, camera, camera shake, captions,
//   left-handed touch controls) are engine `settings` (synced with the
//   account); the browser build's values in the account's settings KV
//   (SYNCED_SETTINGS) are adopted unless set here since, then all its keys
//   are removed (volumes, graphics, reduced motion, high contrast and text
//   size are the runtime's Options now);
// - the player, the invite link, the platform's clock for the Daily, and
//   posting a finished round's total through score-script.js (a practice
//   session whose socket carries { type: 'result', scores }, as the JS SDK's
//   submitScores did) with the rank on the high-score board.
import type { JsonValue } from "starhermit:engine";
import {
  connectGame, inviteLink as fetchInviteLink, leaderboards, onPlayerChange, player, serverNow, serverTime, sessions, type Leaderboard,
} from "starhermit:platform";
import { saves, settings as store } from "starhermit:storage";
import { Store, type SaveDoc } from "./game.ts";

// --- the save --------------------------------------------------------------------------------
/** Canonical JSON (sorted keys): merges compare by content, not key order. */
export function canon(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return "{" + Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => JSON.stringify(k) + ":" + canon(o[k])).join(",") + "}";
  }
  return JSON.stringify(v ?? null);
}
const progressOf = (d: SaveDoc): string => { const { updatedAt: _u, settings: _s, ...rest } = d; return canon(rest); };
let data: SaveDoc = Store.migrateSave(null);
let lastSavedAt = 0;
const mergedListeners = new Set<() => void>();
/** fn() after progress from the account (another device, the browser build) was merged in. */
export function onProgressMerged(fn: () => void): void { mergedListeners.add(fn); }
function merged(): void { for (const fn of mergedListeners) fn(); }

function write(opts: { replaceForeign?: boolean } = {}): void {
  try {
    saves.save(data as unknown as JsonValue, { schema: 1, ...opts });
    lastSavedAt = saves.load()?.savedAt ?? lastSavedAt;
  } catch (e) { console.warn(`save: ${String(e)}`); }
}
/** The live save document (change it, then persist()). */
export function doc(): SaveDoc { return data; }
/** Saves (the device at once, the account debounced by the runtime); stamps updatedAt as main.js did. */
export function persist(): void { data.updatedAt = Date.now(); write(); }
function adopt(other: unknown): boolean {
  const next = Store.mergeSaves(other, data);
  if (progressOf(next) === progressOf(data)) return false;
  data = next;
  write();
  return true;
}
saves.onConflict((mine, remote) => ({ merged: Store.mergeSaves(remote.data, mine?.data ?? null) as unknown as JsonValue }));
saves.onStatus((_status, state) => {
  if (state === "foreign") { migrateForeign(); return; }
  const cur = saves.load();
  if (cur && cur.savedAt !== lastSavedAt) {
    lastSavedAt = cur.savedAt;
    if (adopt(cur.data)) merged();
  }
});
/** The browser build's checksummed document (its JSON text), or null. */
export function readForeign(text: string): SaveDoc | null {
  try {
    const raw = JSON.parse(text) as unknown;
    if (!raw || typeof raw !== "object") return null;
    return Store.migrateSave(raw);
  } catch { return null; }
}
/** The browser build's cloud progression: merged with this device's save, saved over it once. */
function migrateForeign(): void {
  const old = saves.foreign();
  if (!old) return;
  const prev = old.text != null ? readForeign(old.text) : null;
  let grew = false;
  if (prev) {
    const next = Store.mergeSaves(prev, data);
    grew = progressOf(next) !== progressOf(data);
    data = next;
    for (const [k, v] of Object.entries(pickOptions(prev.settings))) adoptOption(k as keyof Options, v);
  }
  write({ replaceForeign: true });
  if (grew) merged();
}

/** The sync line: local for a guest, else saving / synced / error (platform.js status). */
export function syncState(): "local" | "connecting" | "saving" | "synced" | "error" {
  if (!player()) return "local";
  const st = saves.state();
  if (st === "error" || st === "read-blocked") return "error";
  if (st === "loading") return "connecting";
  if (st === "foreign" || st === "uploading" || saves.status() === "pending") return "saving";
  return "synced";
}
export function flush(): void { void saves.flush().catch(() => undefined); }

// --- the game's options -----------------------------------------------------------------------
export interface Options { palette: string; camera: string; cameraShake: boolean; captions: boolean; leftHanded: boolean }
export const PALETTES = ["standard", "deuteranopia", "protanopia", "tritanopia"];
export const DEFAULT_OPTIONS: Options = { palette: "standard", camera: "follow", cameraShake: true, captions: true, leftHanded: false };
const KEYS = Object.keys(DEFAULT_OPTIONS) as (keyof Options)[];
/** The browser build's synced settings keys (app.js SYNCED_SETTINGS). */
export const BROWSER_KEYS = ["music", "effects", "ambience", "voice", "gfx", "reducedMotion", "highContrast", "palette",
  "textScale", "leftHanded", "cameraShake", "captions", "camera", "showFps"];
/** Valid option values from an old settings object. */
export function pickOptions(raw: unknown): Partial<Options> {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: Partial<Options> = {};
  if (typeof o.palette === "string" && PALETTES.includes(o.palette)) out.palette = o.palette;
  if (o.camera === "follow" || o.camera === "far") out.camera = o.camera;
  for (const k of ["cameraShake", "captions", "leftHanded"] as const) if (typeof o[k] === "boolean") out[k] = o[k] as boolean;
  return out;
}
export const options: Options = { ...DEFAULT_OPTIONS };
function readOption(key: keyof Options): void {
  let v: JsonValue | undefined;
  try { v = store.get(key); } catch { return; }
  const ok = pickOptions({ [key]: v })[key];
  if (ok !== undefined) (options as unknown as Record<string, unknown>)[key] = ok;
}
/** A migrated value, kept unless this game set the key since. */
function adoptOption(key: keyof Options, value: unknown): void {
  const v = pickOptions({ [key]: value })[key];
  if (v === undefined) return;
  try {
    if (store.get(key) !== undefined) return;
    store.set(key, v as JsonValue);
    (options as unknown as Record<string, unknown>)[key] = v;
  } catch { /* keep the device's */ }
}
/** Changes one of the game's options (device and account). */
export function setOption<K extends keyof Options>(key: K, value: Options[K]): void {
  if (options[key] === value) return;
  options[key] = value;
  try { store.set(key, value as JsonValue); } catch (e) { console.warn(`option ${key}: ${String(e)}`); }
}
/** The browser build's settings KV: the game's options carry over (unless set here since), then all its keys go. */
function importLegacy(): void {
  const keys = store.legacyKeys();
  if (!keys) return;
  const kv: Record<string, unknown> = {};
  for (const key of keys) kv[key] = store.legacy(key);
  for (const [k, v] of Object.entries(pickOptions(kv))) adoptOption(k as keyof Options, v);
  for (const key of keys) if (BROWSER_KEYS.includes(key)) store.removeLegacy(key);
}

/** Reads the device's save and the game's options (from onStart). */
export function initPlatform(): void {
  const cur = saves.load();
  lastSavedAt = cur?.savedAt ?? 0;
  data = Store.migrateSave(cur?.data ?? null);
  for (const k of KEYS) readOption(k);
  store.onChange((key) => { if ((KEYS as string[]).includes(key)) readOption(key as keyof Options); });
  store.onLegacy(importLegacy);
  importLegacy();
  if (saves.state() === "foreign") migrateForeign();
  refreshPlayer();
  void serverTime().then(() => undefined, () => undefined);
}

// --- the player and the clock -----------------------------------------------------------------
export function signedIn(): boolean { return !!player(); }
export function displayName(): string { return player()?.displayName ?? ""; }
let invite: string | null = null;
/** The invite link, fetched ahead so a button press can copy it at once. */
export function inviteLink(): string | null { return player() ? invite : null; }
function refreshPlayer(): void {
  invite = null;
  board = undefined;
  if (!player()) return;
  fetchInviteLink().then((u) => { invite = u; }, () => { invite = null; });
}
const playerListeners = new Set<() => void>();
export function onPlayer(fn: () => void): void { playerListeners.add(fn); }
onPlayerChange(() => { refreshPlayer(); for (const fn of playerListeners) fn(); });

/** Now in ms by the platform's clock when it has answered, else the device's (the Daily's UTC day). */
export function nowMs(): number {
  try { return serverNow() ?? Date.now(); } catch { return Date.now(); }
}
export function utcDate(): string { return new Date(nowMs()).toISOString().slice(0, 10); }

// --- the high-score board ---------------------------------------------------------------------
let board: Leaderboard | null | undefined;
async function highScoreBoard(): Promise<Leaderboard | null> {
  if (board !== undefined) return board;
  const list = await leaderboards.list();
  board = list.find((b) => b.key === "high-score") ?? list[0] ?? null;
  return board;
}
export interface Posted { posted: boolean; rank: number | null }
/** Signed in only: post a round's total through score-script.js; { posted, rank }. Never rejects. */
export async function postScore(total: number): Promise<Posted> {
  const me = player();
  if (!me) return { posted: false, rank: null };
  const score = Math.max(0, Math.round(total));
  let accepted: string[] = [];
  try {
    const sessionId = await sessions.practice();
    accepted = await new Promise<string[]>((resolve) => {
      const socket = connectGame(sessionId);
      let done = false;
      const finish = (list: string[]): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.close();
        resolve(list);
      };
      const timer = setTimeout(() => finish([]), 15000);
      socket.on("open", () => { socket.sendCommand({ type: "result", scores: { "high-score": score } }); });
      socket.on("game", (d) => {
        const m = d as { type?: string; accepted?: string[] } | null;
        if (m && m.type === "result-ack") finish(Array.isArray(m.accepted) ? m.accepted : []);
      });
      socket.on("error", () => finish([]));
      socket.on("stopped", () => finish([]));
      socket.on("abandoned", () => finish([]));
    });
  } catch { return { posted: false, rank: null }; }
  if (!accepted.includes("high-score")) return { posted: false, rank: null };
  try {
    const b = await highScoreBoard();
    if (!b) return { posted: true, rank: null };
    const r = await leaderboards.entries(b.id, { pageSize: 100 });
    const mine = r.items.find((e) => e.userId === me.userId);
    return { posted: true, rank: mine ? mine.rank : null };
  } catch { return { posted: true, rank: null }; }
}
