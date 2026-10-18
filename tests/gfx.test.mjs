// Graphics quality model (js/render/gfx.js). Run: node --test tests/gfx.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPreset, detectLevel, presetForLevel, LEVELS, BUDGETS, SPARK_CAP, budget, resolve, presetTier, choosePreset, describe, PRESETS, CATEGORIES } from '../js/render/gfx.js';

// gpu-level.js is a classic script in the page; imported here it sets globalThis.StarHermitGpu.
await import('../gpu-level.js');

test('hardware level picks the Auto preset (StarHermit gpu-level.js)', () => {
  assert.equal(detectPreset('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)'), 'low');
  assert.equal(detectPreset('llvmpipe (LLVM 15.0.7, 256 bits)'), 'low');
  assert.equal(detectPreset('ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)'), 'low');
  assert.equal(detectPreset('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11)'), 'low');
  assert.equal(detectPreset('ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11)'), 'balanced');
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce GTX 1070 Direct3D11 vs_5_0 ps_5_0)'), 'high');
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 Direct3D11 vs_5_0 ps_5_0)'), 'ultra');
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 Direct3D11 vs_5_0 ps_5_0)'), 'ultra');
  assert.equal(detectLevel('NVIDIA GeForce RTX 5090'), 20);
  assert.equal(detectLevel('SwiftShader'), 0);
  for (const [p, lv] of Object.entries(LEVELS)) assert.equal(presetForLevel(lv), p);
  assert.equal(presetForLevel(9), 'balanced');
  assert.equal(presetForLevel(16), 'high');
});

test('phones and tablets cap Auto at Balanced', () => {
  assert.ok(['low', 'balanced'].includes(detectPreset('Adreno (TM) 740', { mobile: true })), 'mobile Adreno 740 is Balanced at most');
  assert.equal(detectPreset('NVIDIA GeForce RTX 5090', { mobile: true }), 'balanced');
  assert.equal(detectPreset('SwiftShader', { mobile: true }), 'low');
});

test('per-preset budgets are explicit, grow from Low to Ultra and scale with the level', () => {
  const keys = ['material', 'segments', 'texture', 'decor', 'motes', 'sparks', 'bloomRes', 'aoRes'];
  for (const p of PRESETS) for (const k of keys) assert.ok(k in BUDGETS[p], `${p}.${k}`);
  for (let i = 1; i < PRESETS.length; i++) {
    const a = BUDGETS[PRESETS[i - 1]], b = BUDGETS[PRESETS[i]];
    for (const k of keys.slice(1)) assert.ok(b[k] >= a[k], `${PRESETS[i]}.${k}`);
  }
  assert.deepEqual(PRESETS.map((p) => BUDGETS[p].material), ['lambert', 'standard', 'physical', 'physical']);
  assert.equal(BUDGETS.low.motes, 0, 'no ambient motes on Low');
  assert.ok(SPARK_CAP > 0);
  assert.deepEqual(budget('high', 10), BUDGETS.high, 'floor level = table');
  assert.ok(budget('high', 14).sparks > BUDGETS.high.sparks, 'sparks grow above the floor');
  assert.ok(budget('ultra', 20).sparks <= BUDGETS.ultra.sparks * 2, 'at most 2x');
  assert.ok(budget('ultra', 2).sparks < BUDGETS.ultra.sparks, 'fewer below the floor');
  assert.deepEqual(resolve({ preset: 'low' }, 'low', 0).budget, BUDGETS.low);
  assert.equal(resolve({}, 'ultra', 20).level, 20);
  assert.equal(resolve({ preset: 'balanced' }, 'low').level, LEVELS.balanced, 'a chosen preset without a level uses its floor');
});

test('resolve: auto uses the detected preset, explicit preset wins', () => {
  const a = resolve({}, 'low');
  assert.equal(a.preset, 'low');
  assert.equal(a.auto, true);
  assert.equal(a.shadows, 'off');
  assert.equal(a.post, false, 'Low renders without a post chain');
  const h = resolve({ preset: 'high' }, 'low');
  assert.equal(h.preset, 'high');
  assert.equal(h.auto, false);
  assert.equal(h.shadows, presetTier('high', 'shadows'));
  assert.equal(h.post, true);
  assert.equal(resolve({ preset: 'bogus' }, 'balanced').preset, 'balanced');
});

test('resolve: per-category overrides and invalid tiers', () => {
  const r = resolve({ preset: 'low', bloom: 'on', shadows: 'nope' }, 'low');
  assert.equal(r.bloom, 'on');
  assert.equal(r.shadows, 'off', 'invalid tier falls back to the preset');
  assert.equal(r.post, true, 'bloom override enables the post chain');
  for (const [cat, tiers] of Object.entries(CATEGORIES)) {
    for (const p of PRESETS) assert.ok(tiers.includes(presetTier(p, cat)), `${p}.${cat} is a valid tier`);
  }
});

test('resolve: render scale is clamped to 50–200%', () => {
  assert.equal(resolve({ preset: 'high', render_scale: 5 }).userScale, 2);
  assert.equal(resolve({ preset: 'high', render_scale: 0.1 }).userScale, 0.5);
  assert.equal(resolve({ preset: 'ultra', render_scale: 1 }).scale, 1.25);
  assert.equal(resolve({ preset: 'low' }).dprCap, 1);
  assert.equal(resolve({}).adaptive, true);
  assert.equal(resolve({ adaptive: false, show_fps: true }).showFps, true);
});

test('choosing a preset clears overrides but keeps scale/adaptive/fps', () => {
  const next = choosePreset({ preset: 'low', bloom: 'on', ao: 'high', render_scale: 1.5, adaptive: false, show_fps: true }, 'high');
  assert.deepEqual(next, { preset: 'high', render_scale: 1.5, adaptive: false, show_fps: true });
  assert.equal(choosePreset({}, 'auto').preset, 'auto');
});

test('describe summarises cost', () => {
  const d = describe(resolve({ preset: 'high' }), [1280, 800]);
  assert.match(d, /2048² shadows/);
  assert.match(d, /1280×800 px/);
  assert.match(describe(resolve({ preset: 'low' })), /no shadows/);
});
