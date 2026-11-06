// Sound, as the browser build's js/audio/audio.js: the authored one-shots
// (sfx/<name>.opus, mapped by event as sfx/manifest.json did), the quiet
// ambience (a 2 s low-passed noise bed looped, its cutoff the theme's ambHz)
// and the adaptive music (a seeded scale arpeggio per theme: every half beat a
// sparse sine melody note, every two beats a triangle bass note). The runtime
// has no ambience bus, so the ambience plays on the music bus at the old
// ambience-to-music ratio; the old default bus gains (music 0.7, effects 0.9,
// ambience 0.5) set the relative levels. Notes and ambience are rendered once
// per theme into clips (OfflineAudioContext) and the notes start on the
// fixed-step clock (main.ts calls tick). The synthesized stand-ins audio.js
// played while a sample loaded are not ported. A pause silences everything, as
// the old context suspend did. The runtime's Options own the volumes and the
// mute. Clips load in onStart and a theme renders when it is first set; only
// starting the ambience waits for the mixer.
import { context, createClip, loadClip, OfflineAudioContext, play as playClip, type AudioClip, type Sound } from "starhermit:audio";
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
let paused = false;

/** Loads every clip at once (onStart). */
export function loadSfx(): void {
  for (const n of new Set(Object.values(SAMPLES))) {
    loadClip(`sfx/${n}.opus`).then((c) => { clips.set(n, c); }, (e: unknown) => { console.warn(`sfx ${n}: ${e instanceof Error ? e.message : String(e)}`); });
  }
}
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
interface ThemeSound { notes: Map<string, AudioClip>; amb: AudioClip | null; queued: boolean }
const themeSounds = new Map<string, ThemeSound>();
function soundsFor(th: Theme): ThemeSound {
  let s = themeSounds.get(th.id);
  if (!s) { s = { notes: new Map(), amb: null, queued: false }; themeSounds.set(th.id, s); }
  return s;
}
const warn = (e: unknown): void => { console.warn(`audio: ${String(e)}`); };
/**
 * audio.js startAmbience: white noise through a two-pole low-pass close to the old smoothing (one pole at 71 Hz, ×8:
 * within 1 dB up to 250 Hz), a 12 dB/oct low-pass at ambHz, gain 0.5. Filtered periodic noise is periodic once settled.
 */
async function renderAmbience(th: Theme): Promise<AudioClip> {
  const settle = Math.round(0.25 * RATE);
  const off = new OfflineAudioContext(1, settle + RATE * 2, RATE);
  const noise = off.createNoise({ seed: 0x7c1a + th.id.length * 977, seconds: 2 });
  const tilt = off.createBiquadFilter(); tilt.type = "lowpass"; tilt.frequency.value = 141; tilt.Q.value = -6.02;
  const lp = off.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = th.ambHz || 500; lp.Q.value = -3.01;
  const gain = off.createGain(); gain.gain.value = 4; // measured: within .6 dB of the old beds, all five themes
  noise.connect(tilt).connect(lp).connect(gain).connect(off.destination); noise.start();
  const r = await off.startRendering();
  return createClip([r.getChannelData(0).slice(settle)], RATE);
}
/** A theme's notes end to end in one context, sliced. audio.js tone(): exponential attack to `vol` in 30 ms, exponential decay to 0.001 at `dur`. */
async function renderNotes(th: Theme, into: Map<string, AudioClip>): Promise<void> {
  const m = th.music, stepDur = 60 / m.bpm / 2;
  const list: { key: string; f: number; dur: number; type: "sine" | "triangle"; vol: number; n: number; at: number }[] = [];
  let at = 0;
  const add = (key: string, f: number, dur: number, type: "sine" | "triangle", vol: number): void => {
    const n = Math.round(RATE * (dur + 0.05));
    list.push({ key, f, dur, type, vol, n, at });
    at += n;
  };
  for (const deg of m.scale as number[]) {
    for (const oct of [0, 1]) add(`m${deg + 12 * oct}`, m.root * Math.pow(2, (deg + 12 * oct) / 12), stepDur * 0.9, "sine", 0.1 * m.bright);
    add(`b${deg}`, (m.root * Math.pow(2, deg / 12)) / 2, stepDur * 3.4, "triangle", 0.16);
  }
  const off = new OfflineAudioContext(1, at, RATE);
  for (const x of list) {
    const t0 = x.at / RATE;
    const osc = off.createOscillator(); osc.type = x.type; osc.frequency.value = x.f;
    const g = off.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(x.vol, t0 + 0.03);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + x.dur);
    g.gain.setValueAtTime(0, t0 + x.dur);
    osc.connect(g).connect(off.destination);
    osc.start(t0); osc.stop((x.at + x.n) / RATE);
  }
  const d = (await off.startRendering()).getChannelData(0);
  for (const x of list) into.set(x.key, createClip([d.slice(x.at, x.at + x.n)], RATE));
}
function queueTheme(th: Theme): void {
  const s = soundsFor(th);
  if (s.queued) return;
  s.queued = true;
  renderAmbience(th).then((c) => { s.amb = c; }, warn);
  renderNotes(th, s.notes).catch(warn);
}

// ---- music and ambience -------------------------------------------------------------------------
let theme: Theme | null = null;
let music: { rng: InstanceType<typeof Rng>; step: number; next: number; stepDur: number } | null = null;
let ambVoice: Sound | null = null;
let ambTheme = "";
/** audio.js setMusicTheme + setAmbienceTone: a theme's music restarts from its seed. */
export function setTheme(th: Theme): void {
  queueTheme(th);
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
/** Each frame, once the mixer runs: the ambience voice. */
export function update(): void {
  if (context.state !== "running") return;
  if (!paused && theme && ambTheme !== theme.id) {
    const amb = soundsFor(theme).amb;
    if (amb) {
      try { ambVoice?.stop(); } catch { /* gone */ }
      try { ambVoice = playClip(amb, { bus: "music", gain: AMB / FX, loop: true }); ambTheme = theme.id; } catch { ambVoice = null; }
    }
  }
}
