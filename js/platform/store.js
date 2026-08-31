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
    quality: 'auto',         // auto | high | medium | low
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

// Conflict resolution helper: given two documents, returns 'local' when the
// local doc strictly descends from remote (superset of progression), 'remote'
// likewise, or 'conflict' when neither does (caller must ask the player).
export function resolveCloudConflict(local, remote) {
  const score = (d) => Object.keys(d.journey.passed || {}).length +
    Object.keys(d.lessonsDone || {}).length + Object.keys(d.challengesDone || {}).length +
    Object.keys(d.achievements || {}).length;
  const covers = (a, b) => {
    for (const k of Object.keys(b.journey.passed || {})) if (!a.journey.passed[k]) return false;
    for (const k of Object.keys(b.lessonsDone || {})) if (!a.lessonsDone[k]) return false;
    return true;
  };
  if (covers(local, remote)) return 'local';
  if (covers(remote, local)) return 'remote';
  return score(local) >= score(remote) ? 'conflict-local-newer' : 'conflict-remote-newer';
}
