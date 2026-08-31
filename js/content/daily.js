// Daily challenge: one shared seed and ruleset per UTC day. The seed is
// derived from the date string only, so every player on the planet gets the
// identical course. Seeds are immutable after publication; a defective day
// is marked excluded rather than replaced.

import { Rng, hashString } from '../rules/rng.js';
import { seg } from '../rules/course.js';
import { makeCourse } from './stages.js';
import { THEME_IDS } from './themes.js';

export const DAILY_RULESET = 1;

// Days marked defective are excluded from ranking (never silently replaced).
export const EXCLUDED_DAYS = [];

export function dailyDateString(d = new Date()) {
  return d.toISOString().slice(0, 10); // UTC day
}

export function dailyId(dateStr) { return 'daily-' + dateStr; }
export function isDailyExcluded(dateStr) { return EXCLUDED_DAYS.includes(dateStr); }

const POOL = [
  ['gaps', 16, (r) => ({ gaps: [[5, r.range(3.0, 3.4)], [11, r.range(3.2, 3.6)]] })],
  ['spinner', 16, (r) => ({ omega: r.range(0.022, 0.028), arms: r.chance(0.5) ? 2 : 1, count: r.int(1, 2) })],
  ['pendulum', 16, (r) => ({ count: 2, omega: r.range(0.027, 0.032), plane: r.chance(0.3) ? 'z' : 'x' })],
  ['conveyor', 14, (r) => r.chance(0.5) ? { vx: r.range(2.2, 3) * r.sign() } : { vz: r.range(-3, -2.2) }],
  ['pistons', 16, (r) => ({ count: r.int(2, 3), omega: r.range(0.03, 0.036), stagger: r.chance(0.6) })],
  ['weave', 16, (r) => ({ count: 2, omega: r.range(0.03, 0.035), gapW: r.range(2.9, 3.4) })],
  ['bumpers', 14, (r) => ({ count: r.int(4, 6), r: r.range(0.9, 1.05) })],
  ['fan', 12, (r) => r.chance(0.5) ? { vx: r.range(2.4, 3.2) * r.sign() } : { vz: r.range(-3.2, -2.6) }],
  ['bounce', 10, (r) => ({ count: r.int(1, 2), power: r.range(12.5, 13.5) })],
  ['narrow', 12, (r) => ({ w: r.range(4.4, 5.2) })],
  ['mover', 12, (r) => ({ omega: r.range(0.026, 0.032), pw: r.range(3.0, 3.4) })],
];

export function dailyDef(dateStr = dailyDateString()) {
  const seed = hashString('tumble-daily-' + dateStr);
  const rng = new Rng(seed, 'daily');
  const theme = THEME_IDS[seed % THEME_IDS.length];
  const segments = [seg('run', rng.int(8, 12))];
  const mech = new Set(['run']);
  const n = rng.int(7, 9);
  let lastType = 'run';
  for (let i = 0; i < n; i++) {
    let [t, len, params] = rng.pick(POOL);
    // adjacent mover bands leave an uncrossable void between their platforms
    if (t === 'mover' && lastType === 'mover') { t = 'narrow'; len = 12; params = (r) => ({ w: r.range(4.4, 5.2) }); }
    segments.push(seg(t, len, params(rng)));
    mech.add(t === 'gaps' ? 'gap' : t);
    lastType = t;
    if (i % 3 === 1) { segments.push(seg('run', rng.int(6, 10))); lastType = 'run'; }
  }
  segments.push(seg('run', 8));
  const def = makeCourse(dailyId(dateStr), theme, seed, [...mech], segments);
  def.daily = dateStr;
  def.ruleset = DAILY_RULESET;
  return def;
}
