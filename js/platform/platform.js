// StarHermit platform adapter: launch-token auth, account profile, and the
// single-slot cloud save. Hosted mode activates only when a launch token is
// present in the URL (fragment #game_token=..., query fallbacks for local
// dev); every path degrades to a quiet offline no-op otherwise. Tokens stay
// in memory only — localStorage remains the offline cache and the cloud slot
// is a mirror of the checksummed save document.

const REFRESH_MS = 45 * 60 * 1000;   // token lifetime is 60 min; renew early
const REFRESH_RETRY_MS = 60 * 1000;  // retry a failed refresh after ~60 s
const SAVE_DEBOUNCE_MS = 2000;

// Minimal ZIP writer/reader (stored entries only, no compression).
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function zipStore(name, dataBytes) {
  const enc = new TextEncoder();
  const nameB = enc.encode(name);
  const crc = crc32(dataBytes);
  const out = [];
  const u16 = (v) => out.push(v & 0xff, (v >> 8) & 0xff);
  const u32 = (v) => out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  u32(0x04034b50); u16(20); u16(0); u16(0); u16(0); u16(0);
  u32(crc); u32(dataBytes.length); u32(dataBytes.length);
  u16(nameB.length); u16(0);
  const local = out.length;
  const head = new Uint8Array(out);
  const cd = [];
  const c16 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff);
  const c32 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  c32(0x02014b50); c16(20); c16(20); c16(0); c16(0); c16(0); c16(0);
  c32(crc); c32(dataBytes.length); c32(dataBytes.length);
  c16(nameB.length); c16(0); c16(0); c16(0); c16(0); c32(0); c32(0); // attrs + local-header offset
  const cdHead = new Uint8Array(cd);
  const cdOff = head.length + nameB.length + dataBytes.length;
  const parts = [head, nameB, dataBytes, cdHead, nameB];
  const eocd = [];
  const e32 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  const e16 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff);
  e32(0x06054b50); e16(0); e16(0); e16(1); e16(1);
  e32(cdHead.length + nameB.length); e32(cdOff); e16(0);
  parts.push(new Uint8Array(eocd));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.length; }
  return buf;
}
function unzipFirstEntry(zipBytes) {
  // Stored single-entry reader: scan local headers for compression 0.
  const dv = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  let off = 0;
  while (off + 30 <= zipBytes.length && dv.getUint32(off, true) === 0x04034b50) {
    const method = dv.getUint16(off + 8, true);
    const size = dv.getUint32(off + 18, true);
    const nameLen = dv.getUint16(off + 26, true);
    const extraLen = dv.getUint16(off + 28, true);
    const dataOff = off + 30 + nameLen + extraLen;
    if (method !== 0) throw new Error('unsupported zip entry');
    return zipBytes.slice(dataOff, dataOff + size);
  }
  throw new Error('bad zip');
}
function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function base64ToBytes(b64) {
  const s = atob(b64);
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
}

// base64url-decode the payload; no signature verification (client-side only).
function decodeJwtPayload(token) {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)));
    return json && typeof json === 'object' ? json : null;
  } catch { return null; }
}

export class Platform {
  constructor() {
    this.token = null;     // launch token (memory only, never persisted)
    this.sub = null;       // account user id from the JWT
    this.slug = null;      // game scope from the JWT — never hard-coded
    this.nickname = null;  // account display name once loaded
    this.status = 'offline'; // offline | saving | synced | error
    this.onStatus = null;  // sync-status render hook (app supplies it)
    this.ready = Promise.resolve();
    this._saveTimer = null;
    this._pendingDoc = null;
    this._refreshTimer = null;
  }

  get active() { return !!this.token; }

  setStatus(s) {
    if (this.status === s) return;
    this.status = s;
    if (this.onStatus) this.onStatus(s);
  }

  // Read the launch token once (fragment first, query fallbacks for local
  // dev), strip it from the URL, and start profile fetch + refresh cadence.
  init() {
    let token = null;
    try {
      if (typeof location !== 'undefined') {
        const m = (location.hash || '').match(/(?:^#|[#&])game_token=([^&]+)/);
        if (m) {
          token = decodeURIComponent(m[1]);
          history.replaceState(null, '', location.pathname + location.search);
        } else {
          const q = new URLSearchParams(location.search);
          token = q.get('game_token') || q.get('token') || q.get('launch') || q.get('launch_token');
        }
      }
    } catch { token = null; }
    const claims = token ? decodeJwtPayload(token) : null;
    if (!claims || !claims.sub) { this.token = null; return; }
    this.token = token;
    this.sub = String(claims.sub);
    this.slug = claims.game_scope ? String(claims.game_scope) : null;
    this._refreshTimer = setTimeout(() => this.refreshToken(), REFRESH_MS);
    try {
      window.addEventListener('pagehide', () => { this.flushSave(); });
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') this.flushSave();
      });
    } catch {}
    this.ready = this.fetchProfile();
  }

  _auth(init = {}) {
    const headers = Object.assign({}, init.headers, { authorization: 'Bearer ' + this.token });
    return Object.assign({}, init, { headers });
  }

  // fetch wrapper that adds the Bearer header (e.g. for time sync probes).
  apiFetch(input, init) { return fetch(input, this._auth(init)); }

  async api(path, init) {
    const res = await fetch(path, this._auth(init));
    if (!res.ok) {
      const err = new Error('http ' + res.status);
      err.status = res.status;
      throw err;
    }
    return res;
  }

  // Nickname from the account profile; NEVER /api/v1/me (403 for launch
  // tokens), never usernames. Fallback: "Player " + id.slice(0, 8).
  async fetchProfile() {
    if (!this.active) return;
    try {
      const res = await this.api(`/api/v1/users/${encodeURIComponent(this.sub)}/profile`);
      const body = await res.json().catch(() => null);
      const nick = body && typeof body.nickname === 'string' ? body.nickname.trim() : '';
      this.nickname = nick || 'Player ' + this.sub.slice(0, 8);
    } catch {
      this.nickname = 'Player ' + this.sub.slice(0, 8);
    }
  }

  // Scoped launch tokens may re-mint: swap in the fresh token and reschedule.
  async refreshToken() {
    if (!this.active || !this.slug) return;
    let ok = false;
    try {
      const res = await fetch(`/api/v1/games/${encodeURIComponent(this.slug)}/launch-token`, {
        method: 'POST',
        headers: { authorization: 'Bearer ' + this.token },
      });
      if (res.ok) {
        const body = await res.json().catch(() => null);
        if (body && typeof body.token === 'string' && body.token) this.token = body.token;
        ok = true;
      }
    } catch { ok = false; }
    clearTimeout(this._refreshTimer);
    this._refreshTimer = setTimeout(() => this.refreshToken(), ok ? REFRESH_MS : REFRESH_RETRY_MS);
  }

  // GET the cloud slot; returns the raw save doc, or null when none/unreadable.
  async loadCloud() {
    if (!this.active || !this.slug) return null;
    try {
      const res = await this.api(`/api/v1/me/cloud-saves/${encodeURIComponent(this.slug)}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) throw new Error('bad zip payload');
      return JSON.parse(new TextDecoder().decode(unzipFirstEntry(buf)));
    } catch (e) {
      if (!e || e.status !== 404) this.setStatus('offline');
      return null;
    }
  }

  // Debounced mirror of the checksummed save document (one zip entry, base64).
  scheduleSave(doc) {
    if (!this.active || !this.slug) return;
    this._pendingDoc = doc;
    this.setStatus('saving');
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => { this.flushSave(); }, SAVE_DEBOUNCE_MS);
  }

  async flushSave() {
    clearTimeout(this._saveTimer);
    this._saveTimer = null;
    if (!this.active || !this.slug || !this._pendingDoc) return;
    const doc = this._pendingDoc;
    this._pendingDoc = null;
    try {
      const bytes = new TextEncoder().encode(JSON.stringify(doc));
      await this.api(`/api/v1/me/cloud-saves/${encodeURIComponent(this.slug)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dataBase64: bytesToBase64(zipStore('save.json', bytes)) }),
        keepalive: true,
      });
      this.setStatus('synced');
    } catch {
      if (!this._pendingDoc) this._pendingDoc = doc; // retry with the next change
      this.setStatus('error');
    }
  }
}

export { zipStore, unzipFirstEntry, bytesToBase64, base64ToBytes, decodeJwtPayload };
