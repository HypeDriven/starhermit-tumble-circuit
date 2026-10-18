// Graphics benchmark hook for tools/gfx-bench.mjs (dev-only): picks a preset in Settings → Graphics,
// then starts Practice on the busiest Journey course (stage 40: every obstacle kind, aurora sky) with
// 11 rival bots and keeps the player running forward, jumping now and then, so obstacles, bots,
// bursts and the follow camera all animate. A finished round is retried from the results screen.
export const presets = ['low', 'balanced', 'high', 'ultra'];
export const levels = { low: 0, balanced: 4, high: 10, ultra: 17 };

export async function setPreset(page, preset) {
  await page.waitForSelector('#screens [data-act="settings"]', { timeout: 20000 });
  await page.click('#screens [data-act="settings"]');
  await page.waitForSelector('#gfx-section #gfx-preset');
  await page.locator('#gfx-preset').scrollIntoViewIfNeeded();
  await page.selectOption('#gfx-preset', preset);
  await page.waitForFunction((p) => document.body.dataset.gfxPreset === p, preset);
  await page.click('#screens [data-act="done"]');
  await page.waitForSelector('#screens [data-act="play"]');
}

async function launch(page) {
  await page.click('#screens [data-act="play"]');
  await page.click('#screens [data-act="practice"]');
  await page.selectOption('#prac-course', 'j40');
  await page.selectOption('#prac-bots', '11');
  await page.click('#screens [data-act="go"]');
  await page.waitForFunction(() => !document.getElementById('hud')?.classList.contains('hidden'), null, { timeout: 15000 });
}

export async function start(page) {
  await launch(page);
  let stopped = false, n = 0;
  page.once('close', () => { stopped = true; });
  (async () => {
    await page.keyboard.down('w').catch(() => {});
    while (!stopped) {
      try {
        const retry = page.locator('#screens [data-act="retry"]:visible');
        if (await retry.count()) { await retry.first().click({ timeout: 3000 }); await page.keyboard.down('w'); }
        else if (n % 4 === 0) await page.keyboard.press('Space');
      } catch (e) { if (process.env.BENCH_DEBUG) console.log('hook:', e.message.split('\n')[0]); }
      n++;
      await new Promise((r) => setTimeout(r, 500));
    }
  })();
  await page.waitForTimeout(4000); // countdown → race
}
