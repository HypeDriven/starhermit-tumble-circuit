// Tumble Circuit — seeded randomness and stable hashing.
// Three independent streams are used across the app: "rules" (simulation),
// "decor" (visual decoration) and "av" (audio/visual variants). Only the
// rules stream may influence gameplay.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  constructor(seed, stream = 'rules') {
    const salt = hashString(stream);
    this.next = mulberry32((seed ^ salt) >>> 0);
  }
  float() { return this.next(); }
  range(a, b) { return a + (b - a) * this.next(); }
  int(a, b) { return a + Math.floor(this.next() * (b - a + 1)); } // inclusive
  pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }
  chance(p) { return this.next() < p; }
  sign() { return this.next() < 0.5 ? -1 : 1; }
  fork(salt) { return new Rng((hashString(String(salt)) ^ Math.floor(this.next() * 0xffffffff)) >>> 0, 'fork'); }
}

// FNV-1a 32-bit — stable across engines.
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Canonicalize a value for stable hashing: sorted object keys, numbers
// quantized to 1e-6 so serialized float noise cannot change the hash.
export function canonicalize(v) {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return 'NUM:' + String(v);
    return Math.round(v * 1e6) / 1e6;
  }
  if (Array.isArray(v)) return v.map(canonicalize);
  if (typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = canonicalize(v[k]);
    return out;
  }
  return String(v);
}

export function hashState(obj) {
  return hashString(JSON.stringify(canonicalize(obj))).toString(16).padStart(8, '0');
}

// Compact random session identifier (stable string, used as final tie-break).
export function sessionId(rng) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += chars[Math.floor(rng.next() * chars.length)];
  return s;
}
