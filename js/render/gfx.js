// Graphics quality model: presets, per-category overrides, hardware-level
// detection, per-preset budgets and a cost summary. Pure (no three.js) so the settings panel, the renderer and the
// unit tests agree on what a setting means. Quality never alters rules,
// hitboxes or the visibility of hazards.

export const PRESETS = ['low', 'balanced', 'high', 'ultra'];

// Category → allowed tiers, cheapest first.
export const CATEGORIES = {
  shadows: ['off', 'low', 'medium', 'high'],
  ao: ['off', 'on', 'high'],
  bloom: ['off', 'on'],
  grade: ['off', 'on'],
  antialias: ['off', 'fxaa', 'smaa', 'msaa'],
  reflections: ['off', 'on'],       // image-based lighting (room environment)
  detail: ['plain', 'detailed'],    // surface textures, rounded blocks, decor density
  particles: ['low', 'high'],       // burst counts, sparkles, ambient sky motes
  background: ['static', 'animated'], // drifting clouds, sky shimmer, bobbing balloons
};

// Each preset: a row of tiers, a device-pixel-ratio cap and a render scale.
const TABLE = {
  low: { dpr: 1, scale: 1, shadows: 'off', ao: 'off', bloom: 'off', grade: 'off', antialias: 'msaa', reflections: 'off', detail: 'plain', particles: 'low', background: 'static' },
  balanced: { dpr: 1.5, scale: 1, shadows: 'low', ao: 'off', bloom: 'on', grade: 'on', antialias: 'fxaa', reflections: 'on', detail: 'detailed', particles: 'high', background: 'animated' },
  high: { dpr: 2, scale: 1, shadows: 'medium', ao: 'on', bloom: 'on', grade: 'on', antialias: 'smaa', reflections: 'on', detail: 'detailed', particles: 'high', background: 'animated' },
  ultra: { dpr: 2, scale: 1.25, shadows: 'high', ao: 'high', bloom: 'on', grade: 'on', antialias: 'msaa', reflections: 'on', detail: 'detailed', particles: 'high', background: 'animated' },
};

export const SHADOW_MAP = { off: 0, low: 1024, medium: 2048, high: 4096 };

// StarHermit hardware level (0–20, gpu-level.js → window.StarHermitGpu) at which Auto starts choosing
// each preset. 0 = Galaxy S20 / Intel UHD or weaker, 20 = RTX 5090; phones, tablets and ≤ 4 GB machines
// are capped at level 9 (Balanced); software renderers are level 0 (Low).
export const LEVELS = { low: 0, balanced: 4, high: 10, ultra: 17 };

/*
 * Per-preset asset and effect budgets, each tuned to hold 60 FPS on the weakest GPU Auto gives the preset
 * (Low: level 0 phones / Intel UHD; Balanced: level 4 Iris Xe; High: level 10 GTX 1070; Ultra: level 17
 * RTX 4080; measured with tests/gfx-bench.mjs). Gameplay, hitboxes and hazard visibility are identical
 * on every preset.
 *   material  course, obstacles and racers: 'lambert' (Low) | 'standard' (Balanced) | 'physical'
 *             (clearcoat toy plastic with Surface detail on; High/Ultra)
 *   segments  geometry LOD: multiplies the segments of discs, rims, rings, poles, hubs, capsules,
 *             pendulum bobs, bumpers, pads, racers and clouds
 *   texture   procedural tile / stripe / chequer texture size in px (Surface detail on)
 *   decor     multiplies the floating islands, clouds, stars, balloons and kites
 *   motes     ambient light motes near the course (Particles high)
 *   sparks    multiplies burst counts and the live-burst cap, then scaled by the hardware level within
 *             the preset (≤ 2×)
 *   bloomRes / aoRes  bloom and GTAO resolution as a fraction of the frame
 */
export const BUDGETS = {
  low: { material: 'lambert', segments: 0.5, texture: 128, decor: 0.5, motes: 0, sparks: 0.5, bloomRes: 0.5, aoRes: 0.5 },
  balanced: { material: 'standard', segments: 0.75, texture: 256, decor: 0.75, motes: 70, sparks: 0.75, bloomRes: 0.5, aoRes: 0.5 },
  high: { material: 'physical', segments: 1, texture: 256, decor: 1, motes: 140, sparks: 1, bloomRes: 0.5, aoRes: 0.5 },
  ultra: { material: 'physical', segments: 1.5, texture: 512, decor: 1.3, motes: 240, sparks: 1.5, bloomRes: 1, aoRes: 1 },
};

/** Live burst particles at a sparks multiplier of 1 (each burst sphere is one draw). */
export const SPARK_CAP = 120;

const gpuApi = () => globalThis.StarHermitGpu;

/** Hardware level 0–20 for an unmasked renderer string plus StarHermitGpu.detectSystem() facts. */
export function detectLevel(gpu, system = {}) {
  const G = gpuApi();
  if (!G) return LEVELS.balanced;
  return G.detectLevel({ webgl: true, webgl2: true, ...system, gpu: String(gpu || '') });
}

/** Auto preset for a hardware level: Low 0, Balanced 4, High 10, Ultra 17. */
export function presetForLevel(level) {
  const G = gpuApi();
  if (G) return G.presetForLevel(level, LEVELS);
  return PRESETS.filter((p) => LEVELS[p] <= level).pop() || 'low';
}

/** Best preset for this GPU; phones and tablets are capped at Balanced by the hardware level. */
export function detectPreset(gpu, system = {}) {
  return presetForLevel(detectLevel(gpu, system || {}));
}

/** A preset's concrete budget for a hardware level (sparks scale within the preset, ≤ 2×). */
export function budget(preset, level) {
  const b = { ...(BUDGETS[preset] || BUDGETS.balanced) };
  const G = gpuApi(), floor = LEVELS[preset] ?? 0;
  const k = G ? Math.min(2, G.scaleBudget(1, Number.isFinite(level) ? level : floor, floor)) : 1;
  b.sparks = Math.round(b.sparks * k * 100) / 100;
  return b;
}

/**
 * Resolve saved settings into concrete tiers.
 * `saved`: { preset: 'auto'|preset, render_scale, adaptive, show_fps, <category>: 'preset'|tier }.
 */
export function resolve(saved, detected, level) {
  const s = saved || {};
  const auto = !PRESETS.includes(s.preset);
  const preset = auto ? (PRESETS.includes(detected) ? detected : 'balanced') : s.preset;
  const row = TABLE[preset];
  const userScale = clamp(Number(s.render_scale) || 1, 0.5, 2);
  const out = { preset, auto, dprCap: row.dpr, userScale, scale: row.scale * userScale };
  for (const [cat, tiers] of Object.entries(CATEGORIES)) {
    out[cat] = tiers.includes(s[cat]) ? s[cat] : row[cat];
  }
  out.level = Number.isFinite(level) ? level : LEVELS[preset];
  out.budget = budget(preset, out.level);
  out.adaptive = s.adaptive !== false;
  out.showFps = !!s.show_fps;
  // Post-processing runs only when something needs it; otherwise the canvas renders directly.
  out.post = out.ao !== 'off' || out.bloom === 'on' || out.grade === 'on' || out.antialias === 'fxaa' || out.antialias === 'smaa';
  return out;
}

/** Choosing a preset clears every override but keeps scale / adaptive / fps choices. */
export function choosePreset(saved, preset) {
  const s = saved || {};
  const out = { preset: PRESETS.includes(preset) ? preset : 'auto' };
  if (s.render_scale != null) out.render_scale = s.render_scale;
  if (s.adaptive != null) out.adaptive = s.adaptive;
  if (s.show_fps != null) out.show_fps = s.show_fps;
  return out;
}

/** The preset's own tier for a category (for "From preset (…)" labels). */
export function presetTier(preset, cat) {
  return TABLE[preset]?.[cat];
}

export function describe(r, pixels) {
  const parts = [
    r.shadows === 'off' ? 'no shadows' : `${SHADOW_MAP[r.shadows]}² shadows`,
    r.ao === 'off' ? null : r.ao === 'high' ? 'full ambient occlusion' : 'ambient occlusion',
    r.bloom === 'on' ? 'bloom' : null,
    r.reflections === 'on' ? 'reflections' : null,
    r.antialias === 'off' ? 'no anti-aliasing' : r.antialias.toUpperCase(),
    pixels ? `${pixels[0]}×${pixels[1]} px` : null,
  ];
  return parts.filter(Boolean).join(' · ');
}

function clamp(v, a, b) {
  return Math.min(b, Math.max(a, v));
}
