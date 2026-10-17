// Platform adapter + canonical StarHermit SDK with a stubbed fetch and a fake
// launch fragment: token read, profile name, cloud save in game:<slug>,
// settings KV patch, control overrides — and zero fetches standalone.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Platform } from '../js/platform/platform.js';
import { mergeSaves } from '../js/platform/store.js';

const SDK_SRC = fs.readFileSync(new URL('../starhermit-sdk.js', import.meta.url), 'utf8');
function loadSdk() {
  const m = { exports: {} };
  new Function('module', 'exports', SDK_SRC)(m, m.exports);
  return m.exports;
}
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const SLUG = 'tumble-test';
const USER = 'abcdef12-3456-7890-abcd-ef1234567890';
const JWT = 'x.' + b64url({ sub: USER, game_scope: SLUG, exp: Math.floor(Date.now() / 1000) + 3600 }) + '.y';
const noTimers = { setTimeout: () => 0, clearTimeout: () => {} };

function fakeWindow(hash) {
  return {
    location: { hash, search: '', pathname: '/', hostname: 'localhost', href: 'http://localhost/' + hash, origin: 'http://localhost' },
    history: { state: null, replaceState(_s, _t, url) { this.url = url; } },
  };
}
function stubServer() {
  const calls = [];
  const state = { save: null, etag: null, version: 0, settings: {} };
  const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
  const fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push({ url, method, auth: init.headers && init.headers.Authorization });
    if (url === '/api/v1/time') return json({ ms: Date.now() });
    if (url === `/api/v1/users/${USER}/profile`) return json({ nickname: 'Sky Sol' });
    if (url.startsWith('/api/v1/me/cloud-saves/')) {
      // Versioned slot: conditional writes (If-Match / If-None-Match) answer 412 on a stale version.
      if (url.endsWith('/info')) return json(state.save ? { exists: true, etag: state.etag } : { exists: false });
      if (method === 'PUT') {
        const h = init.headers || {};
        if ((h['If-Match'] && h['If-Match'] !== state.etag) || (h['If-None-Match'] === '*' && state.save)) {
          return new Response(JSON.stringify({ error: 'precondition_failed', etag: state.etag }), { status: 412, headers: { 'content-type': 'application/json' } });
        }
        state.save = Buffer.from(JSON.parse(init.body).dataBase64, 'base64');
        state.etag = '"v' + ++state.version + '"';
        return json({ etag: state.etag });
      }
      return state.save ? new Response(state.save) : new Response(null, { status: 404 });
    }
    if (url === `/api/v1/games/${SLUG}/settings`) {
      if (method === 'PATCH') Object.assign(state.settings, JSON.parse(init.body).settings);
      return json({ settings: state.settings });
    }
    if (url === `/api/v1/games/${SLUG}/controls`) return json({ actions: [{ action: 'jump', codes: ['KeyJ'] }] });
    return new Response(null, { status: 404 });
  };
  return { fetch, calls, state };
}

test('hosted: token, profile, cloud save game:<slug>, settings, controls', async () => {
  const srv = stubServer();
  const win = fakeWindow('#game_token=' + JWT + '&session_id=s1');
  const sh = loadSdk().create({ window: win, fetch: srv.fetch, ...noTimers });
  sh.init();
  assert.equal(sh.token, JWT);
  assert.equal(win.history.url, '/');
  const p = new Platform(sh);
  p.init();
  await p.ready;
  assert.ok(p.active);
  assert.equal(p.slug, SLUG);
  assert.equal(p.nickname, 'Sky Sol');

  p.scheduleSave({ version: 1, stats: { races: 4 } });
  await p.flushSave();
  const put = srv.calls.find((c) => c.method === 'PUT');
  assert.equal(put.url, '/api/v1/me/cloud-saves/' + encodeURIComponent('game:' + SLUG));
  assert.equal((await p.loadCloud()).stats.races, 4);
  assert.equal(p.status, 'synced');

  p.patchSettings({ music: 0.3 });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(srv.state.settings, { music: 0.3 });
  assert.equal((await p.getSettings()).music, 0.3);
  assert.deepEqual(await p.loadBindings({ jump: ['Space'], dive: ['KeyL'] }), { jump: ['KeyJ'], dive: ['KeyL'] });
  assert.match(p.inviteLink(), new RegExp(`/game-invite/${USER}/${SLUG}$`));
  const t = await p.apiFetch('/api/v1/time');
  assert.ok(t.ok && Number.isFinite((await t.json()).ms));
  assert.ok(srv.calls.every((c) => c.auth === 'Bearer ' + JWT));
});

test('renewal refused: adapter drops to local play', async () => {
  const srv = stubServer();
  const sh = loadSdk().create({ window: fakeWindow('#game_token=' + JWT), fetch: srv.fetch, ...noTimers });
  sh.init();
  const p = new Platform(sh);
  p.init();
  await p.ready;
  let seen = null;
  p.onAuthChange = (v) => { seen = v; };
  sh.signOut('expired');
  assert.equal(seen, false);
  assert.equal(p.active, false);
  assert.equal(p.inviteLink(), null);
});

test('standalone: no token means no fetch at all', async () => {
  const srv = stubServer();
  const sh = loadSdk().create({ window: fakeWindow(''), fetch: srv.fetch });
  sh.init();
  const p = new Platform(sh);
  p.init();
  await p.ready;
  assert.equal(p.active, false);
  assert.equal(p.canSignIn(), false);
  p.scheduleSave({ version: 1 });
  await p.flushSave();
  p.patchSettings({ music: 0.1 });
  assert.deepEqual(await p.getSettings(), {});
  assert.equal(await p.loadCloud(), null);
  await p.loadBindings({ jump: ['Space'] });
  assert.equal(srv.calls.length, 0);
});

test('save conflict: another device saved first → onConflict reloads, merges, saves again', async () => {
  const srv = stubServer();
  const sh = loadSdk().create({ window: fakeWindow('#game_token=' + JWT), fetch: srv.fetch, ...noTimers });
  sh.init();
  const p = new Platform(sh);
  p.init();
  await p.ready;
  let save = { version: 1, journey: { unlocked: 4, passed: { j01: 900, j03: 700 }, crowns: {} }, stats: { races: 5 }, updatedAt: 1 };
  assert.equal(await p.loadCloud(), null); // empty slot: later writes are If-None-Match: *

  // Another device writes first.
  const sh2 = loadSdk().create({ window: fakeWindow('#game_token=' + JWT), fetch: srv.fetch, ...noTimers });
  sh2.init();
  await sh2.loadJSON();
  assert.equal(await sh2.writeSave(JSON.stringify({ version: 1, journey: { unlocked: 9, passed: { j01: 400, j08: 650 }, crowns: { j08: true } }, stats: { races: 12 }, updatedAt: 2 })), true);

  let merged = 0;
  p.onConflict = async () => {   // what main.js wires up
    const latest = await p.loadCloud();
    save = mergeSaves(latest, save);
    p.scheduleSave(save);
    await p.flushSave();
    merged++;
  };
  p.scheduleSave(save);
  await p.flushSave();             // 412 → saveconflict → onConflict
  for (let i = 0; i < 20 && !merged; i++) await new Promise((r) => setImmediate(r));
  assert.equal(merged, 1);
  assert.equal(sh.saveConflicted(), false);
  const back = await p.loadCloud();
  assert.equal(back.journey.unlocked, 9);
  assert.deepEqual(back.journey.passed, { j01: 900, j03: 700, j08: 650 });
  assert.equal(back.journey.crowns.j08, true);
  assert.equal(back.stats.races, 12);
});

test('hosted domain without a token offers sign-in (UUID host)', () => {
  const srv = stubServer();
  const win = fakeWindow('');
  win.location.hostname = '0b9d6f2e-3c4a-4e5b-9a7c-1d2e3f405162.starhermit.com';
  win.location.origin = 'https://' + win.location.hostname;
  const sh = loadSdk().create({ window: win, fetch: srv.fetch, ...noTimers });
  sh.init();
  const p = new Platform(sh);
  p.init();
  assert.equal(p.canSignIn(), true);
  assert.equal(srv.calls.length, 0);
});
