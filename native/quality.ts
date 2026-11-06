// The look per graphics level. The engine owns shadows, ambient occlusion, bloom,
// the grade and the anti-aliasing (levelSettings(): the frame's level); the
// browser build's art columns and budgets (js/render/gfx.js TABLE / BUDGETS) stay
// keyed by the runtime's quality tier (frame().quality), with the burst sparks
// scaled within the tier by the level's particle budget (at most 2×). The runtime
// owns what the old Graphics panel did besides: Auto and the level choice, render
// scale and the pixel-ratio cap, adaptive resolution, the frame-rate limit and its
// readout. The old per-category overrides are not offered (Options choose a level).
import { levelSettings, type GraphicsLevel, type LevelSettings, type QualityTier } from "starhermit:engine";
import type { AntialiasMode } from "starhermit:scene";

export interface Budget { material: "lambert" | "standard" | "physical"; segments: number; texture: number; decor: number; motes: number; sparks: number }
export interface Look {
  preset: QualityTier;
  /** The level's shadow map size, 0 = off. */
  shadows: number;
  ao: { resolution: number; samples: number; denoiseSamples: number } | null;
  /** The level's bloom resolution, null = off. */
  bloom: number | null;
  grade: boolean;
  antialias: AntialiasMode;
  reflections: boolean;
  detailed: boolean;
  particles: "low" | "high";
  animated: boolean;
  budget: Budget;
}
const ART: Record<QualityTier, Pick<Look, "reflections" | "detailed" | "particles" | "animated">> = {
  low: { reflections: false, detailed: false, particles: "low", animated: false },
  balanced: { reflections: true, detailed: true, particles: "high", animated: true },
  high: { reflections: true, detailed: true, particles: "high", animated: true },
  ultra: { reflections: true, detailed: true, particles: "high", animated: true },
};
const BUDGETS: Record<QualityTier, Budget> = {
  low: { material: "lambert", segments: 0.5, texture: 128, decor: 0.5, motes: 0, sparks: 0.5 },
  balanced: { material: "standard", segments: 0.75, texture: 256, decor: 0.75, motes: 70, sparks: 0.75 },
  high: { material: "physical", segments: 1, texture: 256, decor: 1, motes: 140, sparks: 1 },
  ultra: { material: "physical", segments: 1.5, texture: 512, decor: 1.3, motes: 240, sparks: 1.5 },
};
const ANCHOR: Record<QualityTier, GraphicsLevel> = { low: "quantum", balanced: "molecular", high: "terrestrial", ultra: "galactic" };
/** gfx.js SPARK_CAP: live burst particles at a sparks multiplier of 1. */
export const SPARK_CAP = 120;

export function lookFor(s: LevelSettings = levelSettings()): Look {
  const preset = s.quality;
  const b = BUDGETS[preset];
  const k = Math.min(2, s.particles / levelSettings(ANCHOR[preset]).particles);
  return {
    preset, ...ART[preset],
    shadows: s.shadows ? s.shadowMapSize : 0,
    ao: s.ao && { resolution: s.ao.resolution, samples: s.ao.samples, denoiseSamples: s.ao.denoiseSamples },
    bloom: s.bloom ? s.bloom.resolution : null,
    grade: s.grade,
    antialias: s.antialias,
    budget: { ...b, texture: Math.min(b.texture, s.maxTextureSize), sparks: Math.round(b.sparks * k * 100) / 100 },
  };
}
