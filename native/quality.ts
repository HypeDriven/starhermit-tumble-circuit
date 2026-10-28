// The look per graphics level: the browser build's four presets and budgets
// (js/render/gfx.js TABLE / BUDGETS, each tuned to hold 60 FPS on the weakest
// GPU its Auto gave it) keyed by the runtime's quality tier (frame().quality),
// with the burst sparks scaled within the tier by the hardware level
// (frame().levelIndex, at most 2x), as gfx.js scaled them. The runtime owns
// what the old Graphics panel did besides: Auto and the level choice, render
// scale and the pixel-ratio cap, adaptive resolution, the frame-rate limit and
// its readout. The old per-category overrides are not offered (Options choose
// a level).
import type { QualityTier } from "starhermit:engine";
import type { AntialiasMode } from "starhermit:scene";

export interface Budget { material: "lambert" | "standard" | "physical"; segments: number; texture: number; decor: number; motes: number; sparks: number; bloomRes: number; aoRes: number }
export interface Look {
  preset: QualityTier;
  shadows: 0 | 1024 | 2048 | 4096;
  ao: "off" | "on" | "high";
  bloom: boolean;
  grade: boolean;
  antialias: AntialiasMode;
  reflections: boolean;
  detailed: boolean;
  particles: "low" | "high";
  animated: boolean;
  budget: Budget;
}
const TABLE: Record<QualityTier, Omit<Look, "preset" | "budget">> = {
  low: { shadows: 0, ao: "off", bloom: false, grade: false, antialias: "msaa", reflections: false, detailed: false, particles: "low", animated: false },
  balanced: { shadows: 1024, ao: "off", bloom: true, grade: true, antialias: "fxaa", reflections: true, detailed: true, particles: "high", animated: true },
  high: { shadows: 2048, ao: "on", bloom: true, grade: true, antialias: "smaa", reflections: true, detailed: true, particles: "high", animated: true },
  ultra: { shadows: 4096, ao: "high", bloom: true, grade: true, antialias: "msaa", reflections: true, detailed: true, particles: "high", animated: true },
};
const BUDGETS: Record<QualityTier, Budget> = {
  low: { material: "lambert", segments: 0.5, texture: 128, decor: 0.5, motes: 0, sparks: 0.5, bloomRes: 0.5, aoRes: 0.5 },
  balanced: { material: "standard", segments: 0.75, texture: 256, decor: 0.75, motes: 70, sparks: 0.75, bloomRes: 0.5, aoRes: 0.5 },
  high: { material: "physical", segments: 1, texture: 256, decor: 1, motes: 140, sparks: 1, bloomRes: 0.5, aoRes: 0.5 },
  ultra: { material: "physical", segments: 1.5, texture: 512, decor: 1.3, motes: 240, sparks: 1.5, bloomRes: 1, aoRes: 1 },
};
/** gfx.js LEVELS: the hardware level at which Auto starts choosing each preset. */
const TIER_FLOOR: Record<QualityTier, number> = { low: 0, balanced: 4, high: 10, ultra: 17 };
/** gfx.js SPARK_CAP: live burst particles at a sparks multiplier of 1. */
export const SPARK_CAP = 120;

export function lookFor(preset: QualityTier, levelIndex: number): Look {
  const b = { ...BUDGETS[preset] };
  const k = Math.min(2, Math.pow(1.5, Math.max(0, levelIndex - TIER_FLOOR[preset]) / 3));
  b.sparks = Math.round(b.sparks * k * 100) / 100;
  return { preset, ...TABLE[preset], budget: b };
}
