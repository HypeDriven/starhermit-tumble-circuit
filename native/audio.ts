// Sound, as the browser build's js/audio/audio.js: the authored one-shots
// (sfx/<name>.opus, mapped by event as sfx/manifest.json did), the quiet
// ambience (a 2 s low-passed noise bed looped, its cutoff the theme's ambHz)
// and the adaptive music (a seeded scale arpeggio per theme: every half beat a
// sparse sine melody note, every two beats a triangle bass note). The runtime
// has no ambience bus, so the ambience plays on the music bus at the old
// ambience-to-music ratio; the old default bus gains (music 0.7, effects 0.9,
// ambience 0.5) set the relative levels. Notes and ambience are rendered once
// per theme into clips (a sine table, slices a frame) and the notes start on
// the fixed-step clock (main.ts calls tick). The synthesized stand-ins
// audio.js played while a sample loaded are not ported (a live synthesis
// graph makes clip loads fail on the web runtime). A pause silences
// everything, as the old context suspend did. The runtime's Options own the
// volumes and the mute.
import { context, createClip, loadClip, play as playClip, type AudioClip, type Sound } from "starhermit:audio";
import { Rng, type Theme } from "./game.ts";

/** sfx/manifest.json: event → sample. */
const SAMPLES: Record<string, string> = {
  ui: "ui-click", "ui-back": "ui-back", invalid: "invalid-buzz", countdown: "countdown-beep", go: "go-whistle", jump: "jump-hop",
  dive: "dive-whoosh", land: "land-thud", bounce: "bounce-boing", knock: "knock-hit", fall: "fall-whoosh", respawn: "respawn-sparkle",
  checkpoint: "checkpoint-chime", finish: "finish-fanfare", out: "out-eliminated", "round-end": "round-end-sting", champion: "champion-fanfare",
  achievement: "achievement-chime",
};
/** audio.js caption cues per event. */
export const CAPTIONS: Record<string, string> = {
  invalid: "capInvalid", go: "capGo", dive: "capDive", bounce: "capBoing", knock: "capKnock", fall: "capFall", respawn: "capRespawn",
  checkpoint: "capCheckpoint", finish: "capFinish", out: "capOut", champion: "capChampion", achievement: "capAchievement",
};
const FX = 0.9, MUSIC = 0.7, AMB = 0.5;
const clips = new Map<string, AudioClip>();
const queue: string[] = [];
let loading = false;
let wantClips = false;
let paused = false;

export function loadSfx(): void { wantClips = true; }
/** audio.js event(): the event's sample (when loaded). */
export function play(ev: string): void {
  if (paused) return;
  const name = SAMPLES[ev];
  const clip = name ? clips.get(name) : undefined;
  if (!clip) return;
  try { playClip(clip, { bus: "effects" }); } catch { /* busy */ }
}

// ---- rendered synthesis -------------------------------------------------------------------------
const RATE = 22050;
const TABLE_N = 4096;
const SINE = new Float32Array(TABLE_N + 1);
for (let i = 0; i <= TABLE_N; i++) SINE[i] = Math.sin((i / TABLE_N) * Math.PI * 2);
const sineAt = (phase: number): number => { const p = (phase - Math.floor(phase)) * TABLE_N; const i = p | 0; return SINE[i]! + (SINE[i + 1]! - SINE[i]!) * (p - i); };
const triAt = (phase: number): number => { const p = phase - Math.floor(phase); return p < 0.25 ? p * 4 : p < 0.75 ? 2 - p * 4 : p * 4 - 4; };
interface Job { data: Float32Array; pos: number; fill: (i: number) => number; done: (c: AudioClip) => void; theme: string }
const jobs: Job[] = [];
/** audio.js tone(): exponential attack to `vol` in 30 ms, exponential decay to 0.001 at `dur`. */
function toneFill(freq: number, dur: number, type: "sine" | "triangle", vol: number): (i: number) => number {
  const lo = 0.0001, na = Math.round(0.03 * RATE), nd = Math.round(dur * RATE);
  const up = Math.pow(vol / lo, 1 / na), down = Math.pow(0.001 / vol, 1 / Math.max(1, nd - na));
  let env = lo;
  return (i) => {
    env = i < na ? env * up : i < nd ? env * down : 0;
    const ph = (freq * i) / RATE;
    return (type === "sine" ? sineAt(ph) : triAt(ph)) * env;
  };
}
interface ThemeSound { notes: Map<string, AudioClip>; amb: AudioClip | null; queued: boolean }
const themeSounds = new Map<string, ThemeSound>();
function soundsFor(th: Theme): ThemeSound {
  let s = themeSounds.get(th.id);
  if (!s) { s = { notes: new Map(), amb: null, queued: false }; themeSounds.set(th.id, s); }
  return s;
}
function queueTheme(th: Theme): void {
  const s = soundsFor(th);
  if (s.queued) return;
  s.queued = true;
  const m = th.music;
  const stepDur = 60 / m.bpm / 2;
  // ambience: audio.js startAmbience — 2 s of smoothed noise (×8), a 12 dB/oct low-pass at ambHz, gain 0.5
  let seed = 0x7c1a + th.id.length * 977;
  const rand = (): number => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2147483648 - 1; };
  const w0 = (2 * Math.PI * (th.ambHz || 500)) / RATE, al = Math.sin(w0) / (2 * Math.SQRT1_2), cw = Math.cos(w0);
  const a0 = 1 + al, b0 = (1 - cw) / 2 / a0, b1 = (1 - cw) / a0, a1 = (-2 * cw) / a0, a2 = (1 - al) / a0;
  let v = 0, x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  jobs.push({ theme: th.id, data: new Float32Array(RATE * 2), pos: 0, fill: () => {
    v = v * 0.98 + rand() * 0.02;
    const x = v * 8;
    const y = b0 * x + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    return y * 0.5;
  }, done: (c) => { s.amb = c; } });
  for (const deg of m.scale as number[]) {
    for (const oct of [0, 1]) {
      const f = m.root * Math.pow(2, (deg + 12 * oct) / 12);
      jobs.push({ theme: th.id, data: new Float32Array(Math.round(RATE * (stepDur * 0.9 + 0.05))), pos: 0, fill: toneFill(f, stepDur * 0.9, "sine", 0.1 * m.bright), done: (c) => s.notes.set(`m${deg + 12 * oct}`, c) });
    }
    const fb = (m.root * Math.pow(2, deg / 12)) / 2;
    jobs.push({ theme: th.id, data: new Float32Array(Math.round(RATE * (stepDur * 3.4 + 0.05))), pos: 0, fill: toneFill(fb, stepDur * 3.4, "triangle", 0.16), done: (c) => s.notes.set(`b${deg}`, c) });
  }
}
function runJobs(budget: number): void {
  let left = budget;
  while (jobs.length && left > 0) {
    const j = jobs[0]!;
    const end = Math.min(j.data.length, j.pos + left);
    for (let i = j.pos; i < end; i++) j.data[i] = j.fill(i);
    left -= end - j.pos;
    j.pos = end;
    if (j.pos >= j.data.length) {
      jobs.shift();
      try { j.done(createClip([j.data], RATE)); } catch (e) { console.warn(`audio: ${String(e)}`); }
    }
  }
}

// ---- music and ambience -------------------------------------------------------------------------
let theme: Theme | null = null;
let music: { rng: InstanceType<typeof Rng>; step: number; next: number; stepDur: number } | null = null;
let ambVoice: Sound | null = null;
let ambTheme = "";
/** audio.js setMusicTheme + setAmbienceTone: a theme's music restarts from its seed. */
export function setTheme(th: Theme): void {
  if (theme && theme.id === th.id && music) return;
  theme = th;
  music = { rng: new Rng(Math.floor(th.music.root * 100), "music"), step: 0, next: 0, stepDur: 60 / th.music.bpm / 2 };
}
/** audio.js suspend / resume (the pause screen, a hidden window). */
export function setPaused(p: boolean): void {
  paused = p;
  if (p) { try { ambVoice?.stop(); } catch { /* gone */ } ambVoice = null; ambTheme = ""; }
}
/** The music's half-beat steps on the fixed-step clock (seconds). */
export function tick(now: number): void {
  if (paused || !music || !theme || context.state !== "running") return;
  if (now < music.next) return;
  const s = soundsFor(theme);
  music.next = Math.max(now, music.next) + music.stepDur;
  const m = theme.music;
  const scale = m.scale as number[];
  const st = music.step++;
  const g = MUSIC / FX;
  if (st % 4 === 0) {
    const deg = scale[Math.floor(music.rng.float() * scale.length)]!;
    const c = s.notes.get(`b${deg}`);
    if (c) try { playClip(c, { bus: "music", gain: g }); } catch { /* busy */ }
  }
  if (music.rng.float() < 0.62) {
    const deg = scale[Math.floor(music.rng.float() * scale.length)]! + 12 * music.rng.pick([0, 0, 1]);
    const c = s.notes.get(`m${deg}`);
    if (c) try { playClip(c, { bus: "music", gain: g }); } catch { /* busy */ }
  }
}
/** Each frame: the clips once the mixer runs (one at a time), the synthesis slices, the ambience voice. */
export function update(): void {
  if (context.state !== "running") return;
  if (wantClips) {
    wantClips = false;
    for (const n of Object.values(SAMPLES)) if (!queue.includes(n)) queue.push(n);
  }
  if (theme) queueTheme(theme);
  if (!loading && queue.length) {
    const name = queue.shift()!;
    if (!clips.has(name)) {
      loading = true;
      loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); loading = false; }, (e: unknown) => {
        console.warn(`sfx ${name}: ${e instanceof Error ? e.message : String(e)}`);
        loading = false;
      });
    }
  }
  // the current theme's sounds first
  if (theme) { const i = jobs.findIndex((j) => j.theme === theme!.id); if (i > 0) jobs.unshift(jobs.splice(i, 1)[0]!); }
  runJobs(5000);
  if (!paused && theme && ambTheme !== theme.id) {
    const amb = soundsFor(theme).amb;
    if (amb) {
      try { ambVoice?.stop(); } catch { /* gone */ }
      try { ambVoice = playClip(amb, { bus: "music", gain: AMB / FX, loop: true }); ambTheme = theme.id; } catch { ambVoice = null; }
    }
  }
}
