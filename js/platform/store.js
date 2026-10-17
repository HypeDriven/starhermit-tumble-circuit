// Local persistence: versioned, checksummed progression document plus
// per-game settings. Guest practice works fully offline; nothing sensitive
// (no tokens, no credentials, no chat) is ever stored here.

const SAVE_KEY = 'tumble-circuit-save-v1';

export const SAVE_VERSION = 1;

const DEFAULTS = () => ({
  version: SAVE_VERSION,
  journey: { unlocked: 1, passed: {}, crowns: {} },
  lessonsDone: {},
  challengesDone: {},
  daily: {},                 // dateStr -> best total
  achievements: {},          // key -> unlockedAtTickCount
  stats: { races: 0, finishes: 0, qualifies: 0, showsWon: 0, bestStreak: 0 },
  settings: {
    music: 0.7, effects: 0.9, ambience: 0.5, voice: 0.0,
    quality: 'auto',         // legacy tier (superseded by gfx)
    gfx: {},                 // graphics: { preset, render_scale, adaptive, show_fps, <category>: tier } — see js/render/gfx.js
    reducedMotion: false, highContrast: false, palette: 'standard', // standard | deuteranopia | protanopia | tritanopia
    textScale: 1, leftHanded: false, cameraShake: true, captions: true,
    camera: 'follow',        // follow | far
    showFps: false,
  },
});

function checksumPayload(doc) {
  const { checksum, ...rest } = doc;
  return JSON.stringify(rest);
}

// FNV-1a, same as rules hashing — stable across engines.
function checksum(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function migrateSave(doc) {
  if (!doc || typeof doc !== 'object') return DEFAULTS();
  let d = doc;
  if (d.version == null || d.version < 1) {
    // v0 hypothetical: flat settings, no stats
    d = { ...DEFAULTS(), ...d, version: 1, stats: d.stats || DEFAULTS().stats };
  }
  // deep-merge defaults so new fields appear on old saves
  const base = DEFAULTS();
  const merged = { ...base, ...d, settings: { ...base.settings, ...(d.settings || {}) } };
  merged.journey = { ...base.journey, ...(d.journey || {}) };
  merged.stats = { ...base.stats, ...(d.stats || {}) };
  delete merged.checksum;
  return merged;
}

export function loadSave() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return DEFAULTS();
    const doc = JSON.parse(raw);
    const migrated = migrateSave(doc);
    if (doc.checksum && doc.checksum !== checksum(checksumPayload(migrated))) {
      console.warn('save checksum mismatch — keeping a backup and starting fresh copy');
      try { localStorage.setItem(SAVE_KEY + '.corrupt-backup', raw); } catch {}
      return DEFAULTS();
    }
    return migrated;
  } catch (e) {
    console.warn('save load failed', e);
    return DEFAULTS();
  }
}

export function persistSave(doc) {
  const clean = migrateSave(doc);
  const out = { ...clean };
  try {
    const { checksum: _drop, ...unsigned } = clean;
    out.checksum = checksum(JSON.stringify(unsigned));
    localStorage.setItem(SAVE_KEY, JSON.stringify(out));
  } catch (e) {
    console.warn('save persist failed', e);
  }
  return out;
}

// Merge two save documents without dropping either side's progress (boot load
// and after a refused conditional cloud write): journey — the higher unlock,
// passed stages with the better score, crowns; unions of lessons, challenges
// and achievements (earliest unlock); per daily the better total; each stat
// the larger value. Settings come from the more recently written side.
export function mergeSaves(remote, local) {
  const r = migrateSave(remote), l = migrateSave(local);
  const ru = typeof remote?.updatedAt === 'number' ? remote.updatedAt : 0;
  const lu = typeof local?.updatedAt === 'number' ? local.updatedAt : 0;
  const out = migrateSave({ ...l, settings: { ...(ru > lu ? r.settings : l.settings) } });
  const maxMap = (a, b) => {
    const m = { ...a };
    for (const [k, v] of Object.entries(b || {})) m[k] = k in m ? (typeof v === 'number' && typeof m[k] === 'number' ? Math.max(m[k], v) : (m[k] || v)) : v;
    return m;
  };
  const minMap = (a, b) => {
    const m = { ...a };
    for (const [k, v] of Object.entries(b || {})) m[k] = k in m && typeof m[k] === 'number' && typeof v === 'number' ? Math.min(m[k], v) : (m[k] ?? v);
    return m;
  };
  out.journey = {
    unlocked: Math.max(r.journey.unlocked || 1, l.journey.unlocked || 1),
    passed: maxMap(r.journey.passed, l.journey.passed),
    crowns: maxMap(r.journey.crowns, l.journey.crowns),
  };
  out.lessonsDone = maxMap(r.lessonsDone, l.lessonsDone);
  out.challengesDone = maxMap(r.challengesDone, l.challengesDone);
  out.daily = maxMap(r.daily, l.daily);
  out.achievements = minMap(r.achievements, l.achievements);
  out.stats = maxMap(r.stats, l.stats);
  out.updatedAt = Math.max(ru, lu);
  return out;
}
