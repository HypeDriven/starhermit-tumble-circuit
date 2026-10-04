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
import { loadSave, persistSave, migrateSave, resolveCloudConflict } from './platform/store.js';
import { syncTime } from './platform/timeSync.js';
import { HostedClient } from './platform/net.js';
import { Platform } from './platform/platform.js';

function fatal(msg) {
  const el = document.getElementById('screens');
  el.innerHTML = `<div class="screen"><div class="panel"><h1>Cannot start</h1><p>${msg}</p>
    <p class="muted small">Your settings and progress are kept locally and unchanged.</p></div></div>`;
}

async function boot() {
  const platform = new Platform();
  platform.init();

  // localStorage stays the offline cache; when hosted, the cloud slot wins.
  const store = { save: loadSave(), persist() {
    store.save = persistSave(store.save);
    platform.scheduleSave(store.save);
  } };
  if (platform.active && platform.slug) {
    try { await platform.ready; } catch {}
    const remote = await platform.loadCloud();
    if (remote) {
      const verdict = resolveCloudConflict(migrateSave(store.save), migrateSave(remote));
      if (verdict === 'local') {
        // local strictly descends from remote — mirror it up
        platform.scheduleSave(store.save);
      } else {
        // remote wins outright; on divergence the platform copy is preferred
        store.save = persistSave(migrateSave(remote));
        platform.setStatus('synced');
      }
    } else {
      platform.setStatus('synced'); // nothing in the cloud slot yet
    }
  }

  const canvas = document.getElementById('gl');
  const scene = new GameScene(canvas);
  if (!scene.ok) {
    fatal('This device or browser does not support WebGL, which Tumble Circuit needs to render the sky arena.');
    return;
  }

  const audio = new AudioEngine();
  const hosted = new HostedClient();
  const app = new App({ scene, audio, store, hosted, platform });
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

boot().catch(e => { console.error(e); fatal('Unexpected boot error: ' + e.message); });
