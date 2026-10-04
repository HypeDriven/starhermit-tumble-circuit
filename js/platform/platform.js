// StarHermit platform adapter over the canonical SDK (`starhermit-sdk.js`,
// global `StarHermit`, initialised from index.html before any module runs).
// Hosted mode = the SDK holds a launch token. Without one every method is a
// quiet local no-op and no network call is made. localStorage stays the
// offline cache; the `game:<slug>` cloud slot mirrors the save document.

export class Platform {
  constructor(sh = globalThis.StarHermit || null) {
    this.sh = sh;
    this.sub = null;       // account user id from the token
    this.slug = null;      // game scope from the token — never hard-coded
    this.nickname = null;  // account display name once loaded
    this.status = 'offline'; // offline | saving | synced | error
    this.onStatus = null;  // sync-status render hook (app supplies it)
    this.onAuthChange = null; // (signedIn) => void, app supplies it
    this.ready = Promise.resolve();
    this._active = false;
  }

  get active() { return this._active; }

  setStatus(s) {
    if (this.status === s) return;
    this.status = s;
    if (this.onStatus) this.onStatus(s);
  }

  // Adopt the SDK's launch token (already read and stripped from the URL),
  // then load the profile; renewal is the SDK's job.
  init() {
    const sh = this.sh;
    if (!sh || !sh.token) return;
    this._active = true;
    this.sub = sh.userId;
    this.slug = sh.slug;
    sh.on('saved', (ok) => this._active && this.setStatus(ok ? 'synced' : 'error'));
    sh.on('auth', (e) => {
      if (e && e.signedIn) return;
      this._active = false;
      this.setStatus('offline');
      if (this.onAuthChange) this.onAuthChange(false);
    });
    try {
      window.addEventListener('pagehide', () => { this.flushSave(); });
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') this.flushSave();
      });
    } catch {}
    this.ready = this.fetchProfile();
  }

  // Authenticated JSON call through the SDK (null when signed out / 404).
  api(path, init) { return this.sh.api(path, init); }

  // Response-like wrapper for timeSync's fetch contract.
  apiFetch(path) {
    return this.sh.api(path).then(
      (body) => ({ ok: !!body, status: body ? 200 : 404, json: async () => body }),
      (e) => ({ ok: false, status: (e && e.status) || 0, json: async () => (e && e.body) || null }),
    );
  }

  // Nickname from the account profile (fallback "Player <id prefix>").
  async fetchProfile() {
    if (!this.active) return;
    const p = await this.sh.profile();
    this.nickname = p ? p.displayName : 'Player ' + String(this.sub).slice(0, 6);
  }

  // Sign-in button (only on *.starhermit.com without a token) and invites.
  canSignIn() { return !!(this.sh && this.sh.canSignIn()); }
  signIn() { return !!(this.sh && this.sh.signIn()); }
  inviteLink() { return this.active ? this.sh.inviteLink() : null; }

  // Per-player settings KV and control bindings.
  async getSettings() { return this.active ? this.sh.getSettings() : {}; }
  patchSettings(obj) { if (this.active) this.sh.patchSettings(obj); }
  async loadBindings(defaults) {
    if (this.active) return this.sh.loadBindings(defaults);
    const out = {};
    for (const k of Object.keys(defaults)) out[k] = defaults[k].slice();
    return out;
  }

  // The cloud save document, or null when none/unreadable/signed out.
  async loadCloud() {
    if (!this.active) return null;
    return this.sh.loadJSON();
  }

  // Debounced (~2 s) mirror of the checksummed save document.
  scheduleSave(doc) {
    if (!this.active) return;
    this.setStatus('saving');
    this.sh.saveJSON(doc, 2000);
  }

  flushSave() {
    if (!this.active) return Promise.resolve(false);
    return this.sh.flushSave(true);
  }
}
