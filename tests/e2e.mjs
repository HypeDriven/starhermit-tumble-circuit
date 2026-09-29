/**
 * Tumble Circuit — end-to-end playthrough test (dev only, not shipped).
 *
 * Drives the real visible UI in headless Chrome via playwright-core:
 *   title → Play → Learn → Lesson 1 "Move Out" → hold W (real keyboard) to
 *   run the straight no-gap course to the finish gate → round terminalises
 *   (quota=1) → the lesson-complete results screen appears with a score
 *   breakdown, standings table and "verified deterministic" replay line.
 *   Pause/resume is exercised through the visible button before finishing.
 * A second pass runs title → learn → a few real touch moves (Jump tap +
 * forward stick drag) on a mobile touch viewport and confirms HUD progress.
 *
 * No game code is modified. Tumble Circuit exposes no debug handle on
 * `window`, so the test observes state purely through the shipped semantic
 * DOM (HUD clock/place/progress, lesson banner, the result overlay) — every
 * action is a real click/keypress/tap on visible controls. The keyboard
 * dispatch is the same `window` keydown path the browser-smoke harness uses.
 *
 * Serving: the repo ships `server.js` (the StarHermit authoritative script
 * declared by starhermit.txt, `server=server.js`) which also hosts realtime
 * rooms over /ws. But the game is fully playable offline — every solo mode
 * (Learn, Journey, Daily, Practice, Challenge, Show) runs on the local
 * `LocalRound` sim and only the "Hosted play" screen needs /ws + /api. So,
 * mirroring the picture-logic/balance-spire siblings, this test embeds a
 * minimal node:http static server on an ephemeral port and answers /api/*
 * probes with 200 `{}` so the platform adapter degrades to its documented
 * offline path with zero console noise. If a future version starts needing
 * the real backend this can be swapped for spawning `server.js`.
 *
 * Run: npm run test:e2e  (or: node tests/e2e.mjs)
 */
import { chromium } from 'playwright-core';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOT = (stage, vp) => `/tmp/tumble-circuit-e2e-${stage}-${vp}.png`;

// benign GPU/swiftshader noise (mirrors tools/production_game_audit.mjs)
const browserNoise = /GL Driver Message|GPU stall due to ReadPixels|Automatic fallback to software WebGL|EnableWebGLDeveloperExtensions/i;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.txt': 'text/plain; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.woff2': 'font/woff2',
};

const server = http.createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/') p = '/index.html';
    // No StarHermit backend here: answer API probes with empty JSON (200) so
    // the platform time-sync adapter falls back to its offline path quietly.
    if (p.startsWith('/api/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
    const file = path.normalize(path.join(ROOT, p));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

let failures = 0;
const ok = (name) => console.log(`ok - ${name}`);

// Read the public HUD state (pure DOM: no game globals are exposed).
const readHud = (page) => page.evaluate(() => ({
  clock: document.getElementById('hud-clock')?.textContent ?? '',
  place: document.getElementById('hud-place')?.textContent ?? '',
  progress: (document.getElementById('hud-progress-fill')?.style.width ?? ''),
  title: document.getElementById('hud-title')?.textContent ?? '',
  goal: document.getElementById('hud-goal')?.textContent ?? '',
  hudHidden: document.getElementById('hud')?.classList.contains('hidden'),
}));

// Start Learn → Lesson 1 "Move Out" through the visible controls.
async function startLesson1(page) {
  await page.click('#screens [data-act="play"]');          // title → mode select
  await page.waitForSelector('#screens [data-act="learn"]');
  await page.click('#screens [data-act="learn"]');          // mode select → Learn
  await page.waitForSelector('#screens [data-lesson]');
  await page.click('#screens [data-lesson="0"]');           // Learn → Lesson 1
  await page.waitForFunction(() => {
    const h = document.getElementById('hud');
    return h && !h.classList.contains('hidden') && document.getElementById('hud-title')?.textContent.length > 0;
  }, null, { timeout: 15000 });
}

// Open Settings from the title and return the Graphics section.
async function openGraphics(page) {
  await page.click('#screens [data-act="settings"]');
  await page.waitForSelector('#gfx-section #gfx-preset');
  await page.locator('#gfx-preset').scrollIntoViewIfNeeded();
}

const gfxState = (page) => page.evaluate(() => ({
  preset: document.body.dataset.gfxPreset,
  select: document.getElementById('gfx-preset')?.value,
  bloom: document.getElementById('gfx-bloom')?.value,
  summary: document.getElementById('gfx-summary')?.textContent || '',
}));

async function graphicsFlow(page, name) {
  await openGraphics(page);
  let st = await gfxState(page);
  if (st.select !== 'auto' || st.preset !== 'low') throw new Error(`expected Auto→low on a software GPU, got ${JSON.stringify(st)}`);
  // the section must fit inside the viewport width (no horizontal cut-off)
  const fits = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    return [...document.querySelectorAll('#gfx-section select, #gfx-section input, #gfx-section output')]
      .every(e => { const r = e.getBoundingClientRect(); return r.left >= 0 && r.right <= vw + 1; });
  });
  if (!fits) throw new Error('graphics controls overflow the viewport');
  await page.selectOption('#gfx-preset', 'ultra');
  await page.waitForFunction(() => document.body.dataset.gfxPreset === 'ultra');
  await page.selectOption('#gfx-preset', 'low');
  await page.waitForFunction(() => document.body.dataset.gfxPreset === 'low');
  await page.selectOption('#gfx-preset', 'high');
  await page.waitForFunction(() => document.body.dataset.gfxPreset === 'high');
  st = await gfxState(page);
  if (!/bloom/.test(st.summary) || !/2048² shadows/.test(st.summary)) throw new Error(`High summary unexpected: ${st.summary}`);
  await page.selectOption('#gfx-bloom', 'off');
  await page.waitForFunction(() => !/bloom/.test(document.getElementById('gfx-summary')?.textContent || 'bloom'));
  await page.screenshot({ path: SHOT('graphics', name) });
  ok(`${name}: Graphics presets (Ultra/Low/High) + bloom override apply live`);

  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#screens [data-act="settings"]', { timeout: 30000 });
  await openGraphics(page);
  st = await gfxState(page);
  if (st.preset !== 'high' || st.select !== 'high' || st.bloom !== 'off') throw new Error(`graphics settings did not persist: ${JSON.stringify(st)}`);
  ok(`${name}: Graphics settings survive a reload`);

  // choosing a preset clears overrides; Auto keeps the rest of the run fast
  await page.selectOption('#gfx-preset', 'auto');
  await page.waitForFunction(() => document.body.dataset.gfxPreset === 'low');
  st = await gfxState(page);
  if (st.bloom !== 'preset') throw new Error('choosing a preset did not clear the override');
  await page.click('#screens [data-act="done"]');
  await page.waitForSelector('#screens [data-act="play"]');
}

// ---------- one full pass ----------
async function runPass(browser, name, ctxOpts, { full }) {
  const errors = [];
  const context = await browser.newContext(ctxOpts);
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if ((m.type() !== 'error' && m.type() !== 'warning') || browserNoise.test(m.text())) return;
    const url = m.location()?.url || '';
    if (/Failed to load resource/.test(m.text()) && /\/api\/|\/favicon/.test(url)) return;
    errors.push(`console ${m.type()}: ${m.text()}`);
  });
  page.on('response', (r) => {
    const u = r.url();
    if (r.status() >= 400 && !/\/api\/|\/favicon/.test(u)) errors.push(`http ${r.status()}: ${u}`);
  });

  try {
    // load + title
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForSelector('#screens [data-act="play"]', { timeout: 15000 });
    await page.screenshot({ path: SHOT('title', name) });
    ok(`${name}: title screen visible (Play button present)`);

    // Settings → Graphics through the visible UI: presets, one override,
    // persistence across a reload, then back to Auto for the rest of the run.
    await graphicsFlow(page, name);

    // start Learn → Lesson 1
    await startLesson1(page);
    const hud = await readHud(page);
    // Lessons carry no `.name`, so the HUD titles them by id ("lesson-1").
    if (hud.title !== 'lesson-1') throw new Error(`expected Lesson 1, got hud title "${hud.title}"`);
    if (!/finish/i.test(hud.goal)) throw new Error(`unexpected lesson goal: "${hud.goal}"`);
    const banner = (await page.textContent('#lesson-banner')) || '';
    if (!/finish/i.test(banner)) throw new Error(`unexpected lesson intro banner: "${banner.slice(0, 60)}"`);
    await page.screenshot({ path: SHOT('lesson', name) });
    ok(`${name}: Lesson 1 started ("${hud.title}")`);

    // wait out the 3-2-1-GO countdown (~3s) so the round is live
    await page.waitForTimeout(3400);

    if (full) {
      // pause/resume through the visible HUD button
      await page.click('#btn-pause');
      await page.waitForSelector('#screens [data-act="resume"]', { timeout: 5000 });
      await page.screenshot({ path: SHOT('pause', name) });
      await page.click('#screens [data-act="resume"]');
      await page.waitForFunction(() => !document.querySelector('#screens [data-act="resume"]'), null, { timeout: 5000 });
      ok(`${name}: pause and resume work`);

      // Drive FORWARD with the real keyboard (W / ArrowUp) until the round
      // terminalises. Lesson 1 is a straight run (no gaps), so the bot-less
      // player crosses the finish gate and the race ends on quota.
      await page.keyboard.down('w');
      let done = false;
      const started = Date.now();
      while (Date.now() - started < 45000) {
        if (await page.evaluate(() => document.getElementById('screens')?.textContent.includes('Score breakdown'))) { done = true; break; }
        await page.waitForTimeout(400);
      }
      await page.keyboard.up('w');
      if (!done) throw new Error('round did not reach a result screen within 45s while holding W');

      // results screen assertions
      await page.waitForSelector('#screens [data-act="retry"]', { timeout: 8000 });
      const panelText = (await page.locator('#screens .panel').first().textContent()) || '';
      if (!/complete/i.test(panelText)) throw new Error(`results did not report lesson complete: "${panelText.slice(0, 90)}"`);
      if (!/Score breakdown/i.test(panelText)) throw new Error('results screen missing score breakdown');
      if (!/Standings/i.test(panelText)) throw new Error('results screen missing standings');
      if (!/verified deterministic/i.test(panelText)) throw new Error('replay not verified deterministic');
      const scoreRows = await page.locator('#screens .panel table.score tbody tr').count();
      if (scoreRows < 1) throw new Error('score breakdown table is empty');
      await page.screenshot({ path: SHOT('results', name) });
      ok(`${name}: Lesson 1 finished for real — results screen shown ("${(await page.locator('#screens .panel h1').first().textContent()).trim()}", ${scoreRows} score rows, replay deterministic)`);
    } else {
      // Mobile: a few real touch moves — tap the Jump button and drag the
      // virtual stick forward — then confirm the round is running (HUD
      // progress grows as the player moves along the course).
      const before = (await readHud(page)).progress;
      await page.locator('#touch-ui #btn-jump').tap();
      ok(`${name}: Jump touch button responds`);

      // Forward stick drag: press the stick zone, drag up (forward), hold.
      const zone = await page.locator('#stick-zone').boundingBox();
      if (!zone) throw new Error('virtual stick not visible on mobile');
      const cx = zone.x + zone.width / 2, cy = zone.y + zone.height / 2;
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      await page.mouse.move(cx, cy - zone.height * 0.6, { steps: 4 });
      await page.waitForTimeout(1600);           // drive forward a bit
      await page.mouse.up();
      const after = await readHud(page);
      const pct = (v) => parseFloat(v) || 0;
      if (pct(after.progress) <= pct(before)) throw new Error(`no forward progress on mobile: ${before} -> ${after.progress}`);
      if (!after.clock) throw new Error('HUD clock not populated on mobile');
      await page.screenshot({ path: SHOT('mobile-move', name) });
      ok(`${name}: touch moves drive the round (progress ${before || '0%'} → ${after.progress})`);
    }
  } finally {
    await context.close();
  }

  if (errors.length) throw new Error(`${name} pass had page errors:\n  ${errors.join('\n  ')}`);
  console.log(`ok - ${name}: no page errors`);
}

// ---------- main ----------
let browser = null;
try {
  browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio'],
  });
  console.log(`serving ${ROOT} at ${BASE}`);
  await runPass(browser, 'desktop', { viewport: { width: 1280, height: 800 } }, { full: true });
  await runPass(browser, 'mobile',
    { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }, { full: false });
  console.log('\nE2E PASS — tumble-circuit, desktop + mobile, no page errors');
} catch (e) {
  failures++;
  console.error('\nE2E FAIL:', e.message || e);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  server.close();
}
if (failures) process.exit(1);
