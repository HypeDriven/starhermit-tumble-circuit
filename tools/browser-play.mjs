// Plays the web package in Chrome on the machine's GPU (~/games/tools/
// gpu-chrome.mjs), the loader index.html that `npm run package` writes: on
// the desktop Journey stage 1 raced by keys (W held, Jump and Dive tapped) to
// its results; on a phone (390 x 844, DPR 3) the menus by finger and stage 1
// raced on the runtime's touch controls (a finger holding the stick forward,
// a second tapping Jump / Dive); sideways (844 x 390, DPR 3) Help, Settings
// and a Practice round paused and left. Widgets are found through the page's accessibility
// mirror. Fails on console errors or warnings, the runtime's error screen,
// or a view that does not finish.
//   node tools/browser-play.mjs [GAME_DIR] [--shots OUT_DIR]
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const args = process.argv.slice(2);
const dir = resolve(args[0] && !args[0].startsWith('--') ? args[0] : '.');
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const shots = opt('--shots', null);

function findPlaywright() {
  const roots = [dir, resolve(dir, '..'), ...readdirSync(resolve(dir, '..')).map((d) => resolve(dir, '..', d))];
  for (const r of roots) {
    const p = join(r, 'node_modules', 'playwright-core');
    if (existsSync(p)) return createRequire(join(r, 'package.json'))('playwright-core');
  }
  throw new Error('playwright-core not found');
}
const { chromium } = findPlaywright();

const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.ts': 'text/plain',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav', '.mp3': 'audio/mpeg' };
const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^\/+/, '') || 'index.html';
  if (path === 'api/v1/time') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ serverTime: Date.now(), serverTimeIso: new Date().toISOString() })); return; }
  const parts = path.split('/');
  if (parts.some((p) => p.startsWith('.') || p === '..') || ['tests', 'tools', 'node_modules'].includes(parts[0])) { res.writeHead(404).end(); return; }
  const file = join(dir, path);
  if (!existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const views = [
  { name: 'desktop', viewport: { width: 1280, height: 800 } },
  { name: 'phone', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
  { name: 'landscape', viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
];

const { launchChrome } = await import('/home/albert/games/tools/gpu-chrome.mjs');
const { browser, gpu, close } = await launchChrome(chromium);
console.log(`# chrome on ${gpu}`);
let failed = false;
for (const v of views) {
  const ctx = await browser.newContext({ viewport: v.viewport, isMobile: v.isMobile, hasTouch: v.hasTouch, deviceScaleFactor: v.deviceScaleFactor });
  const page = await ctx.newPage();
  const cdp = v.hasTouch ? await ctx.newCDPSession(page) : null;
  const problems = [];
  const environment = /^No available adapters\.$|GL Driver Message/;
  page.on('console', (m) => {
    const platformRoute = /\/api\//.test(m.location()?.url ?? '');
    if ((m.type() === 'error' || m.type() === 'warning') && !environment.test(m.text()) && !platformRoute) problems.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400 && !/\/api\//.test(r.url())) problems.push(`http ${r.status()}: ${r.url()}`); });
  await page.goto(url, { waitUntil: 'load', timeout: 120000 });
  const started = await page.waitForFunction(() => ['running', 'error'].includes(document.documentElement.dataset.starhermit), null, { timeout: 90000 }).then(() => true, () => false);
  await page.waitForTimeout(4000);
  const shot = async (name) => { if (shots) { mkdirSync(shots, { recursive: true }); await page.screenshot({ path: join(shots, `${v.name}-${name}.png`) }); } };
  const find = (name) => page.getByRole('button', { name, exact: true }).or(page.getByRole('checkbox', { name, exact: true })).or(page.getByText(name, { exact: true })).first();
  /** A tap / click at window coordinates (CSS px). */
  const tapAt = async (x, y) => {
    if (cdp) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
      await page.waitForTimeout(80);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else await page.mouse.click(x, y);
    await page.waitForTimeout(250);
  };
  /** A press on a widget (or a table target): the mouse on the desktop, a finger on the phones. */
  const press = async (name) => {
    const el = find(name);
    await el.waitFor({ timeout: 15000 }).catch(() => { throw new Error(`no widget named ${name}`); });
    const b = await el.boundingBox();
    if (process.env.DEBUG_PRESS) console.log('press', name, JSON.stringify(b), await page.getByRole('button', { name, exact: true }).count());
    const x = b.x + b.width / 2, y = b.y + b.height / 2;
    if (cdp) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
      await page.waitForTimeout(80);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else await page.mouse.click(x, y);
    await page.waitForTimeout(250);
  };
  let reached = false;
  const W = v.viewport.width, H = v.viewport.height;
  const results = () => page.getByText('Score breakdown').first().isVisible().catch(() => false);
  const go = async () => { await page.getByRole('button', { name: 'Pause', exact: true }).first().waitFor({ timeout: 60000 }); await page.waitForTimeout(3300); };
  const card = async (re) => { const el = page.getByRole('button', { name: re }).first(); await el.waitFor({ timeout: 15000 }); const b = await el.boundingBox(); await tapAt(b.x + b.width / 2, b.y + b.height / 2); };
  try {
    await shot('title');
    if (v.name === 'landscape') {
      await press('Help');
      await page.getByText('How to play').first().waitFor({ timeout: 15000 });
      await page.waitForTimeout(600);
      await shot('help');
      await press('Done');
      await page.waitForTimeout(800);
      await press('Settings');
      await page.getByRole('button', { name: 'Open Options' }).first().waitFor({ timeout: 15000 });
      await page.waitForTimeout(600);
      await shot('settings');
      await press('Done');
      await page.getByRole('button', { name: 'Play', exact: true }).first().waitFor({ timeout: 15000 });
      await page.waitForTimeout(600);
      await press('Play');
      await card(/^Practice,/);
      await press('Start');
      await go();
      await shot('practice');
      await page.keyboard.press('Escape');
      await find('Resume').waitFor({ timeout: 15000 });
      await page.waitForTimeout(400);
      await shot('pause');
      await press('Leave round');
      await page.getByText('Choose a mode').first().waitFor({ timeout: 15000 });
    } else {
      await press('Play');
      await page.getByText('Choose a mode').first().waitFor({ timeout: 15000 });
      await shot('modes');
      await card(/^Journey,/);
      await card(/^1\. Warm-Up Walk/);
      await go();
      await shot('race-start');
      if (cdp) {
        const sx = 83, sy = H - 83;
        const stick = { x: sx, y: sy - 50, id: 1 };
        // each cycle: a finger on the stick pushed forward, then a second finger taps Jump or Dive; both lift together
        for (let i = 0; i < 120 && !(await results()); i++) {
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: sx, y: sy, id: 1 }] });
          for (let k = 1; k <= 5; k++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: sx, y: sy - 10 * k, id: 1 }] }); await page.waitForTimeout(16); }
          await page.waitForTimeout(250);
          const btn = i % 2 ? { x: W - 54, y: H - 60, id: 2 } : { x: W - 54, y: H - 150, id: 2 };
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [stick, btn] });
          if (i === 6) await shot('race');
          await page.waitForTimeout(80);
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        }
      } else {
        await page.keyboard.down('KeyW');
        for (let i = 0; i < 300 && !(await results()); i++) {
          await page.keyboard.press(i % 2 ? 'ShiftLeft' : 'Space');
          await page.waitForTimeout(80);
          if (i === 20) await shot('race');
        }
        await page.keyboard.up('KeyW');
      }
      await page.getByText('Score breakdown').first().waitFor({ timeout: 60000 });
      await page.waitForTimeout(1500);
      await shot('results');
    }
    reached = true;
  } catch (e) { problems.push(`play: ${String(e.message || e).split('\n')[0]}`); await shot('failed'); }
  const state = await page.evaluate(() => document.documentElement.dataset.starhermit ?? '');
  const ok = started && state === 'running' && problems.length === 0 && reached;
  failed ||= !ok;
  console.log(`${ok ? 'ok' : 'not ok'} - ${v.name} played: started=${started} state=${state || '-'} played=${reached}`);
  for (const p of problems) console.log(`  ${p}`);
  await ctx.close();
}
await close();
server.close();
process.exit(failed ? 1 : 0);
