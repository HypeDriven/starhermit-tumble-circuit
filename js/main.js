// Bootstrap: capability detection, module wiring, lifecycle. The game runs
// fully offline (guest practice); StarHermit platform integration (SDK launch
// token, profile, cloud save, settings, bindings) activates when a token is
// present, and the
// custom-protocol hosted rooms are a local-dev-server feature only. If WebGL
// is unavailable we show a clear compatibility message and preserve local
// session state.

import { GameScene } from './render/scene.js';
import { AudioEngine } from './audio/audio.js';
import { App, DEFAULT_BINDINGS } from './ui/app.js';
import { loadSave, persistSave, migrateSave, mergeSaves } from './platform/store.js';
import { t } from './ui/i18n.js';
import { syncTime } from './platform/timeSync.js';
import { HostedClient } from './platform/net.js';
import { Platform } from './platform/platform.js';

function fatal(msg) {
  const el = document.getElementById('screens');
  el.innerHTML = `<div class="screen"><div class="panel"><h1>${t('cannotStart')}</h1><p>${msg}</p>
    <p class="muted small">${t('keptLocal')}</p></div></div>`;
}

let app = null;

async function boot() {
  const platform = new Platform();
  platform.init();

  // localStorage stays the offline cache. When hosted, the cloud copy is
  // merged with this device's (neither side's progress is dropped) and the
  // merge is written back; every game write stamps updatedAt.
  const store = { save: loadSave(), persist() {
    store.save.updatedAt = Date.now();
    store.save = persistSave(store.save);
    platform.scheduleSave(store.save);
  } };
  const adopt = (remote) => {
    const merged = mergeSaves(remote, store.save);
    const changed = JSON.stringify(merged) !== JSON.stringify(migrateSave(remote));
    store.save = persistSave(merged);
    return changed;
  };
  if (platform.active && platform.slug) {
    try { await platform.ready; } catch {}
    const remote = await platform.loadCloud();
    if (remote) {
      if (adopt(remote)) platform.scheduleSave(store.save);
      else platform.setStatus('synced');
    } else if (!platform.loadFailed()) {
      platform.setStatus('synced'); // nothing in the cloud slot yet
    }
    // Another device saved since our load: the SDK refused the conditional
    // write. Reload, merge (keeping this device's newer progress) and save again.
    platform.onConflict = async () => {
      const latest = await platform.loadCloud();
      if (latest) adopt(latest);
      platform.scheduleSave(store.save);
      if (app) app.onSaveMerged();
    };
  }

  const canvas = document.getElementById('gl');
  const scene = new GameScene(canvas);
  if (!scene.ok) {
    fatal(t('noWebgl'));
    return;
  }

  const audio = new AudioEngine();
  const hosted = new HostedClient();
  app = new App({ scene, audio, store, hosted, platform });
  if (platform.active) {
    // Platform settings win over local ones; bindings honour player overrides.
    const [remote, bindings] = await Promise.all([platform.getSettings(), platform.loadBindings(DEFAULT_BINDINGS)]);
    app.adoptRemoteSettings(remote);
    app.setBindings(bindings);
  }
  app.start();

  // host handshake: synchronize the daily boundary clock (authenticated when
  // hosted); offline is fine. Funnel events stay local no-ops — the platform
  // has no per-game telemetry/presence endpoints reachable by launch tokens.
  // Standalone play makes no network calls: the local clock is used.
  if (platform.active) {
    syncTime((input) => platform.apiFetch(input)).then((r) => {
      if (!r.ok) console.info('time sync unavailable:', r.reason);
    });
  }
}

boot().catch(e => { console.error(e); fatal(t('bootError', { error: e.message })); });
