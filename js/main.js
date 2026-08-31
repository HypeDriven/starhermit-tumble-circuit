// Bootstrap: capability detection, module wiring, lifecycle. The game runs
// fully offline (guest practice); host integration (/api, /ws) is used when
// reachable. If WebGL is unavailable we show a clear compatibility message
// and preserve local session state.

import { GameScene } from './render/scene.js';
import { AudioEngine } from './audio/audio.js';
import { App } from './ui/app.js';
import { loadSave, persistSave } from './platform/store.js';
import { syncTime } from './platform/timeSync.js';
import { HostedClient } from './platform/net.js';

function fatal(msg) {
  const el = document.getElementById('screens');
  el.innerHTML = `<div class="screen"><div class="panel"><h1>Cannot start</h1><p>${msg}</p>
    <p class="muted small">Your settings and progress are kept locally and unchanged.</p></div></div>`;
}

async function boot() {
  const save = loadSave();
  const store = { save, persist() { store.save = persistSave(store.save); } };

  const canvas = document.getElementById('gl');
  const scene = new GameScene(canvas);
  if (!scene.ok) {
    fatal('This device or browser does not support WebGL, which Tumble Circuit needs to render the sky arena.');
    return;
  }

  const audio = new AudioEngine();
  const hosted = new HostedClient();
  const app = new App({ scene, audio, store, hosted });
  app.start();

  // host handshake: synchronize the daily boundary clock; offline is fine
  syncTime().then((r) => { if (!r.ok) console.info('time sync unavailable:', r.reason); });

  // funnel telemetry: anonymous, aggregate-only categories, no content
  const tel = (kind) => {
    if (!navigator.sendBeacon) return;
    try { navigator.sendBeacon('/api/v1/telemetry', JSON.stringify({ kind, ts: Date.now() })); } catch {}
  };
  tel('start');
}

boot().catch(e => { console.error(e); fatal('Unexpected boot error: ' + e.message); });
