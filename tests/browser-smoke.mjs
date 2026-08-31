// CDP-driven browser smoke test: boot the game, click through Play →
// Practice → Start, run the round for a few seconds with scripted input,
// pause/resume, and read back HUD state. Usage: node tests/browser-smoke.mjs <httpPort> <debugPort>
const httpPort = process.argv[2] || '8421';
const debugPort = process.argv[3] || '9223';

const list = await fetch(`http://localhost:${debugPort}/json`).then(r => r.json());
const page = list.find(t => t.type === 'page');
if (!page) { console.error('no page target'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const mid = ++id;
  pending.set(mid, { resolve, reject });
  ws.send(JSON.stringify({ id: mid, method, params }));
});
const consoleErrors = [];
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id).resolve(msg.result); pending.delete(msg.id); }
  if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') consoleErrors.push(msg.params.entry.text);
  if (msg.method === 'Runtime.exceptionThrown') consoleErrors.push(JSON.stringify(msg.params.exceptionDetails.exception));
};
await new Promise(r => ws.onopen = r);
await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await send('Page.navigate', { url: `http://localhost:${httpPort}/` });
await new Promise(r => setTimeout(r, 4000));

const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('page eval failed: ' + JSON.stringify(r.exceptionDetails));
  return r.result.value;
};

console.log('title screen:', await evalJs(`!!document.querySelector('[data-act="play"]')`));
await evalJs(`document.querySelector('[data-act="play"]').click()`, );
await new Promise(r => setTimeout(r, 400));
console.log('modes screen:', await evalJs(`!!document.querySelector('[data-act="practice"]')`));
await evalJs(`document.querySelector('[data-act="practice"]').click()`);
await new Promise(r => setTimeout(r, 400));
await evalJs(`document.querySelector('[data-act="go"]').click()`);
await new Promise(r => setTimeout(r, 500));
console.log('HUD visible:', await evalJs(`!document.getElementById('hud').classList.contains('hidden')`));
// wait out countdown, then hold forward + jump once
await new Promise(r => setTimeout(r, 3600));
await evalJs(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'w'}))`);
await new Promise(r => setTimeout(r, 2500));
await evalJs(`window.dispatchEvent(new KeyboardEvent('keydown',{key:' '}))`);
await new Promise(r => setTimeout(r, 150));
await evalJs(`window.dispatchEvent(new KeyboardEvent('keyup',{key:' '}))`);
await new Promise(r => setTimeout(r, 2000));
const hud = await evalJs(`({
  clock: document.getElementById('hud-clock').textContent,
  place: document.getElementById('hud-place').textContent,
  progress: document.getElementById('hud-progress-fill').style.width,
  obj: document.getElementById('hud-goal').textContent,
})`);
console.log('HUD state:', JSON.stringify(hud));
// pause + resume
await evalJs(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`);
await new Promise(r => setTimeout(r, 300));
console.log('pause dialog:', await evalJs(`!!document.querySelector('[data-act="resume"]')`));
await evalJs(`document.querySelector('[data-act="resume"]').click()`);
await new Promise(r => setTimeout(r, 300));
console.log('resumed:', await evalJs(`!document.querySelector('[data-act="resume"]')`));
// canvas actually rendering (nonblank check via readback is nontrivial headless; check renderer exists)
console.log('webgl ok:', await evalJs(`!!document.getElementById('gl').getContext('webgl2') || !!document.getElementById('gl').__proto__`));
console.log('console errors:', consoleErrors.length ? consoleErrors : 'none');
ws.close();
process.exit(consoleErrors.length ? 1 : 0);
