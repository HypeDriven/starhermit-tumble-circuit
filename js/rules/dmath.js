// Deterministic math for the rules engine. Trig here is a polynomial
// approximation computed only with IEEE-double add/mul, so results are
// bit-identical across JS engines (Math.sin is implementation-defined and
// may differ between browsers). Rendering code may use Math.* freely.

export const PI = Math.PI;
export const TAU = Math.PI * 2;

export function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
export function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
export function lerp(a, b, t) { return a + (b - a) * t; }
export function sign(v) { return v < 0 ? -1 : 1; }
export function approach(v, target, delta) {
  if (v < target) return Math.min(v + delta, target);
  if (v > target) return Math.max(v - delta, target);
  return v;
}

// sin(x) for x in radians, deterministic. Range-reduce to [-PI, PI], fold to
// [-PI/2, PI/2] via sin(PI - x) = sin(x), then 13th-order Taylor (error ~1e-11
// on the reduced range).
export function dsin(x) {
  x = x - TAU * Math.round(x / TAU);
  if (x > PI / 2) x = PI - x;
  else if (x < -PI / 2) x = -PI - x;
  const x2 = x * x;
  let term = x, sum = x;
  term *= x2; sum -= term / 6;
  term *= x2; sum += term / 120;
  term *= x2; sum -= term / 5040;
  term *= x2; sum += term / 362880;
  term *= x2; sum -= term / 39916800;
  term *= x2; sum += term / 6227020800;
  return sum;
}

export function dcos(x) { return dsin(x + PI / 2); }

export function dist2(ax, az, bx, bz) {
  const dx = ax - bx, dz = az - bz;
  return dx * dx + dz * dz;
}

export function len2(x, z) { return Math.sqrt(x * x + z * z); }

// Distance from point P to segment AB in the XZ plane, plus the parametric
// position along the segment (used by rotating-bar hazards).
export function pointSegXZ(px, pz, ax, az, bx, bz) {
  const abx = bx - ax, abz = bz - az;
  const l2 = abx * abx + abz * abz;
  let t = 0;
  if (l2 > 1e-9) t = clamp(((px - ax) * abx + (pz - az) * abz) / l2, 0, 1);
  const cx = ax + abx * t, cz = az + abz * t;
  return { d: len2(px - cx, pz - cz), t, cx, cz };
}
