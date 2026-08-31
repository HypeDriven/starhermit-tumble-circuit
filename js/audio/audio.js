// Procedural audio: original short transients for logical events, layered
// impacts, quiet ambience, and an adaptive seeded music loop per theme.
// No audio-only gameplay: every meaningful sound has an optional caption.

import { Rng } from '../rules/rng.js';

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.buses = {};
    this.enabled = { music: true, effects: true, ambience: true };
    this.volumes = { music: 0.7, effects: 0.9, ambience: 0.5 };
    this.captionsOn = true;
    this.onCaption = () => {};
    this.musicTheme = null;
    this.musicTimer = null;
    this.ambNodes = null;
    this.step = 0;
    this.started = false;
    this.sfxMap = null;        // event type -> sample basename (from sfx/manifest.json)
    this.sfxBuffers = new Map(); // name -> decoded AudioBuffer
    this.sfxPending = new Map(); // name -> in-flight fetch/decode promise
    this.sfxFailed = new Set();  // names that failed to load (keep synthesis fallback)
  }

  // must be called from a user gesture
  start() {
    if (this.started) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    const master = this.ctx.createGain();
    master.gain.value = 0.9;
    master.connect(this.ctx.destination);
    this.master = master;
    for (const b of ['music', 'effects', 'ambience']) {
      const g = this.ctx.createGain();
      g.gain.value = this.volumes[b];
      g.connect(master);
      this.buses[b] = g;
    }
    this.started = true;
    this.startAmbience();
    this.loadSfxManifest();
    if (this.musicTheme) this.startMusic(this.musicTheme);
  }

  // ---- authored sample one-shots (sfx/*.opus) ---------------------------
  // Lazy: manifest fetched after the user-gesture unlock, each clip fetched
  // and decoded on first use. Synthesis below stays the fallback while a
  // clip loads and whenever it is missing or fails to decode.
  loadSfxManifest() {
    fetch('sfx/manifest.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((list) => {
        if (!Array.isArray(list)) return;
        const map = {};
        for (const e of list) {
          if (e && typeof e.name === 'string' && typeof e.event === 'string') map[e.event] = e.name;
        }
        this.sfxMap = map;
      })
      .catch(() => {});
  }

  loadSample(name) {
    if (this.sfxPending.has(name) || this.sfxFailed.has(name)) return;
    const p = fetch('sfx/' + name + '.opus')
      .then((r) => { if (!r.ok) throw new Error('missing sample'); return r.arrayBuffer(); })
      .then((ab) => this.ctx.decodeAudioData(ab))
      .then((buf) => { this.sfxBuffers.set(name, buf); })
      .catch(() => { this.sfxFailed.add(name); })
      .finally(() => { this.sfxPending.delete(name); });
    this.sfxPending.set(name, p);
  }

  // Returns true when a decoded clip played through the effects bus.
  tryPlaySample(name) {
    if (!this.started || !this.enabled.effects) return false;
    const buf = this.sfxBuffers.get(name);
    if (!buf) { this.loadSample(name); return false; }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.buses.effects);
    src.start();
    return true;
  }

  setVolume(bus, v) {
    this.volumes[bus] = v;
    if (this.buses[bus]) this.buses[bus].gain.value = v;
  }
  setCaptions(on) { this.captionsOn = on; }

  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }
  suspend() { if (this.ctx && this.ctx.state === 'running') this.ctx.suspend(); }

  caption(text) { if (this.captionsOn) this.onCaption(text); }

  // ---- SFX primitives -------------------------------------------------
  blip({ f0 = 440, f1 = null, dur = 0.12, type = 'square', vol = 0.5, bus = 'effects', when = 0 }) {
    if (!this.started || !this.enabled.effects) return;
    const t = this.ctx.currentTime + when;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 != null) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(this.buses[bus]);
    o.start(t); o.stop(t + dur + 0.02);
  }

  noise({ dur = 0.2, vol = 0.4, freq = 1200, q = 1, bus = 'effects', when = 0 }) {
    if (!this.started || !this.enabled.effects) return;
    const t = this.ctx.currentTime + when;
    const len = Math.ceil(this.ctx.sampleRate * dur);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = this.ctx.createBufferSource(); src.buffer = buf;
    const f = this.ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q;
    const g = this.ctx.createGain(); g.gain.value = vol;
    src.connect(f); f.connect(g); g.connect(this.buses[bus]);
    src.start(t);
  }

  // ---- event mapping (event tier hierarchy: ack < move < goal < round) --
  event(ev, seed = 1) {
    const r = new Rng(seed, 'av');
    const pv = 1 + r.range(-0.06, 0.06); // seeded pitch variant for replay consistency
    const sampleName = this.sfxMap ? this.sfxMap[ev.t] : null;
    const sampled = sampleName ? this.tryPlaySample(sampleName) : false;
    switch (ev.t) {
      case 'ui': if (!sampled) this.blip({ f0: 660, f1: 880, dur: 0.06, type: 'sine', vol: 0.25 }); break;
      case 'ui-back': if (!sampled) this.blip({ f0: 520, f1: 330, dur: 0.07, type: 'sine', vol: 0.22 }); break;
      case 'invalid': if (!sampled) this.blip({ f0: 180, f1: 120, dur: 0.12, type: 'sawtooth', vol: 0.2 }); this.caption('not allowed'); break;
      case 'countdown': if (!sampled) this.blip({ f0: 440 * pv, dur: 0.1, type: 'sine', vol: 0.4 }); break;
      case 'go': if (!sampled) this.blip({ f0: 660 * pv, f1: 990, dur: 0.22, type: 'sine', vol: 0.5 }); this.caption('Go!'); break;
      case 'jump': if (!sampled) this.blip({ f0: 300 * pv, f1: 560 * pv, dur: 0.1, type: 'triangle', vol: 0.3 }); break;
      case 'dive': if (!sampled) { this.noise({ dur: 0.18, vol: 0.25, freq: 900 }); this.blip({ f0: 500, f1: 240, dur: 0.16, type: 'triangle', vol: 0.22 }); } this.caption('dive'); break;
      case 'land': if (!sampled) this.noise({ dur: 0.09, vol: Math.min(0.4, 0.1 + (ev.impact || 0) * 0.02), freq: 300, q: 0.7 }); break;
      case 'bounce': if (!sampled) this.blip({ f0: 240, f1: 720 * pv, dur: 0.16, type: 'sine', vol: 0.35 }); this.caption('boing'); break;
      case 'knock': if (!sampled) { this.noise({ dur: 0.2, vol: 0.5, freq: 500, q: 0.6 }); this.blip({ f0: 220, f1: 90, dur: 0.22, type: 'sawtooth', vol: 0.3 }); } this.caption('knocked!'); break;
      case 'fall': if (!sampled) this.blip({ f0: 500, f1: 140, dur: 0.35, type: 'sine', vol: 0.3 }); this.caption('fall'); break;
      case 'respawn': if (!sampled) this.blip({ f0: 330, f1: 660, dur: 0.14, type: 'sine', vol: 0.3 }); this.caption('back at checkpoint'); break;
      case 'checkpoint': if (!sampled) { this.blip({ f0: 587 * pv, f1: 880 * pv, dur: 0.14, type: 'sine', vol: 0.4 }); this.blip({ f0: 1174, dur: 0.1, type: 'sine', vol: 0.25, when: 0.07 }); } this.caption('checkpoint'); break;
      case 'finish': if (!sampled) [523, 659, 784, 1046].forEach((f, i) => this.blip({ f0: f * pv, dur: 0.16, type: 'triangle', vol: 0.35, when: i * 0.09 })); this.caption('finished!'); break;
      case 'out': if (!sampled) this.blip({ f0: 392, f1: 196, dur: 0.3, type: 'triangle', vol: 0.35 }); this.caption('eliminated'); break;
      case 'round-end': if (!sampled) [392, 523, 659].forEach((f, i) => this.blip({ f0: f, dur: 0.2, type: 'triangle', vol: 0.3, when: i * 0.12 })); break;
      case 'champion': if (!sampled) [523, 659, 784, 1046, 1318].forEach((f, i) => this.blip({ f0: f, dur: 0.22, type: 'triangle', vol: 0.4, when: i * 0.11 })); this.caption('champion!'); break;
      case 'achievement': if (!sampled) { this.blip({ f0: 880, f1: 1320, dur: 0.18, type: 'sine', vol: 0.35 }); this.blip({ f0: 1760, dur: 0.2, type: 'sine', vol: 0.2, when: 0.12 }); } this.caption('achievement unlocked'); break;
    }
  }

  // ---- ambience: filtered noise bed ------------------------------------
  startAmbience() {
    if (!this.started || this.ambNodes) return;
    const len = this.ctx.sampleRate * 2;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    let v = 0;
    for (let i = 0; i < len; i++) { v = v * 0.98 + (Math.random() * 2 - 1) * 0.02; d[i] = v * 8; }
    const src = this.ctx.createBufferSource(); src.buffer = buf; src.loop = true;
    const f = this.ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 500;
    const g = this.ctx.createGain(); g.gain.value = 0.5;
    src.connect(f); f.connect(g); g.connect(this.buses.ambience);
    src.start();
    this.ambNodes = { src, f, g };
  }
  setAmbienceTone(freq) { if (this.ambNodes) this.ambNodes.f.frequency.value = freq; }

  // ---- adaptive music: seeded scale arpeggio + pad ----------------------
  startMusic(themeMusic) {
    this.musicTheme = themeMusic;
    if (!this.started || !themeMusic) return;
    this.stopMusic();
    const beat = 60 / themeMusic.bpm;
    const rng = new Rng(Math.floor(themeMusic.root * 100), 'music');
    const stepDur = beat / 2;
    const loop = () => {
      if (!this.musicTheme) return;
      const s = this.step++;
      const scale = themeMusic.scale;
      // bass note every 2 beats
      if (s % 4 === 0) {
        const deg = scale[Math.floor(rng.float() * scale.length)];
        this.tone(this.musicTheme.root * Math.pow(2, deg / 12) / 2, stepDur * 3.4, 'triangle', 0.16);
      }
      // sparse melody, seeded
      if (rng.float() < 0.62) {
        const deg = scale[Math.floor(rng.float() * scale.length)] + 12 * rng.pick([0, 0, 1]);
        this.tone(this.musicTheme.root * Math.pow(2, deg / 12), stepDur * 0.9, 'sine', 0.1 * themeMusic.bright);
      }
      this.musicTimer = setTimeout(loop, stepDur * 1000);
    };
    loop();
  }
  tone(freq, dur, type, vol) {
    if (!this.enabled.music) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator(); o.type = type; o.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(this.buses.music);
    o.start(t); o.stop(t + dur + 0.05);
  }
  stopMusic() { if (this.musicTimer) clearTimeout(this.musicTimer); this.musicTimer = null; }
  setMusicTheme(themeMusic) { this.musicTheme = themeMusic; if (this.started) this.startMusic(themeMusic); }
}
