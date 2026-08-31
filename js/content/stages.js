// Authored content: 5 tutorial lessons, 40 journey stages across 5 themes,
// 6 challenges, show courses and survival arenas. Everything is versioned
// data: identifier, seed, segments, goals, allowed mechanics, par, theme.

import { seg } from '../rules/course.js';

export function makeCourse(id, theme, seed, mechanics, segments, opts = {}) {
  const length = segments.reduce((a, s) => a + s.len, 0) + 10;
  const par = opts.par != null ? opts.par : Math.ceil((length / 7.2) * 60);
  return {
    id, version: 1, kind: 'race', theme, seed: seed >>> 0,
    width: opts.width || 12, mechanics, segments,
    par, timeLimit: opts.timeLimit != null ? opts.timeLimit : par * 2 + 900,
    ...opts.extra,
  };
}

function stage(n, theme, name, seed, mechanics, segments, opts = {}) {
  return {
    type: 'stage', stage: n, name,
    passPlace: opts.passPlace || 4,
    bots: { count: opts.bots != null ? opts.bots : 7, skill: opts.skill != null ? opts.skill : Math.min(0.95, 0.3 + n * 0.017) },
    mastery: !!opts.mastery,
    ...makeCourse('j' + String(n).padStart(2, '0'), theme, seed, mechanics, segments, opts),
  };
}

// ---------------------------------------------------------------------------
// Journey: Theme 1 — Cumulus Carnival (run, gaps, spinners, bounce, narrow)
// ---------------------------------------------------------------------------
const T1 = [
  stage(1, 'cumulus', 'Warm-Up Walk', 101, ['run', 'gap'], [
    seg('run', 16), seg('gap', 8, { gap: 2.6 }), seg('run', 12),
    seg('gap', 8, { gap: 3.0 }), seg('run', 14),
  ], { bots: 5, skill: 0.25, passPlace: 4 }),
  stage(2, 'cumulus', 'Hopscotch Heights', 102, ['gap'], [
    seg('run', 10), seg('gaps', 16, { gaps: [[5, 2.6], [10, 2.8]] }),
    seg('run', 8), seg('gaps', 18, { gaps: [[6, 3.0], [12, 3.2]] }), seg('run', 10),
  ], { bots: 6, skill: 0.3 }),
  stage(3, 'cumulus', 'Spindle Alley', 103, ['spinner'], [
    seg('run', 12), seg('spinner', 14, { omega: 0.018, count: 1 }),
    seg('run', 8, { checkpoint: true }), seg('spinner', 16, { omega: 0.02, count: 2 }), seg('run', 10),
  ], { bots: 6, skill: 0.32 }),
  stage(4, 'cumulus', 'Trampoline Trail', 104, ['bounce', 'gap'], [
    seg('run', 10), seg('bounce', 10, { count: 1, power: 12 }),
    seg('gap', 8, { gap: 3.2 }), seg('bounce', 12, { count: 2, power: 12.5 }),
    seg('gaps', 14, { gaps: [[7, 3.2]] }), seg('run', 10),
  ], { bots: 7, skill: 0.35 }),
  stage(5, 'cumulus', 'Narrow Nerves', 105, ['narrow', 'spinner'], [
    seg('run', 10), seg('narrow', 14, { w: 5 }), seg('spinner', 14, { omega: 0.02, count: 1, checkpoint: true }),
    seg('narrow', 12, { w: 4.5 }), seg('run', 10),
  ], { bots: 7, skill: 0.38 }),
  stage(6, 'cumulus', 'Sweeper Sweep', 106, ['spinner', 'gap'], [
    seg('run', 10), seg('spinner', 16, { omega: 0.023, arms: 2, count: 1 }),
    seg('gap', 8, { gap: 3.4, checkpoint: true }), seg('spinner', 18, { omega: 0.024, count: 2, reverse: true }), seg('run', 10),
  ], { bots: 7, skill: 0.4 }),
  stage(7, 'cumulus', 'Cloud Canyon', 107, ['gap', 'spinner', 'bounce'], [
    seg('run', 8), seg('gaps', 18, { gaps: [[6, 3.2], [12, 3.4]] }),
    seg('spinner', 16, { omega: 0.024, count: 2, checkpoint: true }),
    seg('bounce', 10, { count: 1, power: 13 }), seg('narrow', 12, { w: 5 }), seg('run', 8),
  ], { bots: 7, skill: 0.42 }),
  stage(8, 'cumulus', 'Cumulus Crown', 108, ['gap', 'spinner', 'bounce', 'narrow'], [
    seg('run', 10), seg('spinner', 16, { omega: 0.024, arms: 2, count: 1 }),
    seg('gaps', 16, { gaps: [[5, 3.2], [10, 3.5]], checkpoint: true }),
    seg('bounce', 10, { count: 2, power: 13 }), seg('spinner', 18, { omega: 0.026, count: 2, reverse: true }),
    seg('narrow', 12, { w: 4.5, checkpoint: true }), seg('run', 10),
  ], { bots: 9, skill: 0.48, passPlace: 4, mastery: true }),
];

// ---------------------------------------------------------------------------
// Journey: Theme 2 — Dawn Drift (conveyor, pendulum, headwinds)
// ---------------------------------------------------------------------------
const T2 = [
  stage(9, 'dawn', 'Crosswind Crossing', 109, ['conveyor'], [
    seg('run', 10), seg('conveyor', 14, { vx: 2.2 }), seg('run', 8, { checkpoint: true }),
    seg('conveyor', 14, { vx: -2.4 }), seg('gap', 8, { gap: 3.2 }), seg('run', 10),
  ], { bots: 7, skill: 0.45 }),
  stage(10, 'dawn', 'Pendulum Promenade', 110, ['pendulum'], [
    seg('run', 10), seg('pendulum', 14, { count: 1, omega: 0.026 }),
    seg('run', 8, { checkpoint: true }), seg('pendulum', 18, { count: 2, omega: 0.028 }), seg('run', 10),
  ], { bots: 7, skill: 0.46 }),
  stage(11, 'dawn', 'Headwind Hustle', 111, ['conveyor', 'spinner'], [
    seg('run', 8), seg('conveyor', 16, { vz: -2.4 }), seg('spinner', 14, { omega: 0.023, count: 1, checkpoint: true }),
    seg('conveyor', 14, { vz: -2.8 }), seg('run', 10),
  ], { bots: 7, skill: 0.48 }),
  stage(12, 'dawn', 'Hammerfall', 112, ['pendulum', 'gap'], [
    seg('run', 8), seg('pendulum', 16, { count: 2, omega: 0.029 }),
    seg('gaps', 14, { gaps: [[7, 3.4]], checkpoint: true }),
    seg('pendulum', 16, { count: 2, omega: 0.03, plane: 'z' }), seg('run', 10),
  ], { bots: 7, skill: 0.5 }),
  stage(13, 'dawn', 'Beltway', 113, ['conveyor', 'narrow'], [
    seg('run', 8), seg('conveyor', 12, { vx: 2.6 }), seg('narrow', 12, { w: 5, checkpoint: true }),
    seg('conveyor', 14, { vx: -2.8 }), seg('narrow', 10, { w: 4.5 }), seg('run', 10),
  ], { bots: 7, skill: 0.52 }),
  stage(14, 'dawn', 'Swing Shift', 114, ['pendulum', 'spinner'], [
    seg('run', 8), seg('spinner', 14, { omega: 0.024, count: 1 }),
    seg('pendulum', 16, { count: 2, omega: 0.03, checkpoint: true }),
    seg('spinner', 14, { omega: 0.025, arms: 2, count: 1 }), seg('pendulum', 14, { count: 1, omega: 0.031 }), seg('run', 8),
  ], { bots: 7, skill: 0.54 }),
  stage(15, 'dawn', 'Dusk Dash', 115, ['gap', 'conveyor', 'bounce'], [
    seg('run', 8), seg('conveyor', 12, { vz: 2.5 }), seg('gaps', 16, { gaps: [[5, 3.2], [11, 3.4]], checkpoint: true }),
    seg('bounce', 10, { count: 2, power: 13 }), seg('conveyor', 12, { vz: 2.8 }), seg('run', 10),
  ], { bots: 7, skill: 0.56 }),
  stage(16, 'dawn', 'Dawn Dominion', 116, ['pendulum', 'conveyor', 'spinner', 'gap'], [
    seg('run', 8), seg('pendulum', 16, { count: 2, omega: 0.031 }),
    seg('conveyor', 14, { vx: 2.8, checkpoint: true }), seg('spinner', 16, { omega: 0.026, arms: 2, count: 1 }),
    seg('gaps', 14, { gaps: [[7, 3.5]], checkpoint: true }), seg('pendulum', 16, { count: 2, omega: 0.032, plane: 'z' }), seg('run', 10),
  ], { bots: 9, skill: 0.6, mastery: true }),
];

// ---------------------------------------------------------------------------
// Journey: Theme 3 — Nimbus Night (pistons, weave, movers)
// ---------------------------------------------------------------------------
const T3 = [
  stage(17, 'nimbus', 'Piston Plaza', 117, ['pistons'], [
    seg('run', 10), seg('pistons', 14, { count: 2, omega: 0.03 }),
    seg('run', 8, { checkpoint: true }), seg('pistons', 16, { count: 3, omega: 0.032, stagger: true }), seg('run', 10),
  ], { bots: 7, skill: 0.58 }),
  stage(18, 'nimbus', 'Weave Waves', 118, ['weave'], [
    seg('run', 10), seg('weave', 14, { count: 1, omega: 0.026 }),
    seg('run', 8, { checkpoint: true }), seg('weave', 18, { count: 2, omega: 0.028 }), seg('run', 10),
  ], { bots: 7, skill: 0.6 }),
  stage(19, 'nimbus', 'Ferry Crossing', 119, ['mover'], [
    seg('run', 10), seg('mover', 10, { omega: 0.024 }), seg('run', 8, { checkpoint: true }),
    seg('mover', 12, { omega: 0.028, pw: 3.0 }), seg('run', 10),
  ], { bots: 7, skill: 0.6 }),
  stage(20, 'nimbus', 'Shove Avenue', 120, ['pistons', 'conveyor'], [
    seg('run', 8), seg('conveyor', 12, { vx: 2.4 }), seg('pistons', 16, { count: 3, omega: 0.033, checkpoint: true }),
    seg('conveyor', 12, { vx: -2.6 }), seg('pistons', 14, { count: 2, omega: 0.034, stagger: true }), seg('run', 8),
  ], { bots: 7, skill: 0.62 }),
  stage(21, 'nimbus', 'Midnight Movers', 121, ['mover', 'gap'], [
    seg('run', 8), seg('mover', 10, { omega: 0.026 }), seg('gaps', 12, { gaps: [[6, 3.4]], checkpoint: true }),
    seg('mover', 12, { omega: 0.03, axis: 'z', A: 2.0 }), seg('mover', 8, { omega: 0.024, pw: 4.2 }), seg('run', 8),
  ], { bots: 7, skill: 0.64 }),
  stage(22, 'nimbus', 'Gate Crasher', 122, ['weave', 'spinner'], [
    seg('run', 8), seg('weave', 16, { count: 2, omega: 0.032 }),
    seg('spinner', 14, { omega: 0.026, count: 2, checkpoint: true }),
    seg('weave', 16, { count: 2, omega: 0.034, gapW: 3.0 }), seg('run', 10),
  ], { bots: 7, skill: 0.66 }),
  stage(23, 'nimbus', 'Nimbus Knockout', 123, ['pistons', 'weave', 'mover'], [
    seg('run', 8), seg('pistons', 14, { count: 2, omega: 0.034 }),
    seg('weave', 14, { count: 2, omega: 0.032, checkpoint: true }),
    seg('mover', 10, { omega: 0.03 }), seg('pistons', 14, { count: 3, omega: 0.035, stagger: true }), seg('run', 8),
  ], { bots: 7, skill: 0.68 }),
  stage(24, 'nimbus', 'Starlit Summit', 124, ['pistons', 'weave', 'mover', 'spinner'], [
    seg('run', 8), seg('weave', 16, { count: 2, omega: 0.034 }),
    seg('pistons', 16, { count: 3, omega: 0.036, stagger: true, checkpoint: true }),
    seg('mover', 12, { omega: 0.032, pw: 3.0 }), seg('spinner', 16, { omega: 0.028, arms: 2, count: 1, checkpoint: true }),
    seg('weave', 14, { count: 2, omega: 0.036, gapW: 3.0 }), seg('run', 10),
  ], { bots: 9, skill: 0.72, mastery: true }),
];

// ---------------------------------------------------------------------------
// Journey: Theme 4 — Storm Surge (fans, bumpers, heavy combos)
// ---------------------------------------------------------------------------
const T4 = [
  stage(25, 'storm', 'Gale Gardens', 125, ['fan', 'narrow'], [
    seg('run', 10), seg('fan', 14, { vx: 2.6 }), seg('narrow', 12, { w: 5, checkpoint: true }),
    seg('fan', 14, { vx: -2.8 }), seg('run', 10),
  ], { bots: 7, skill: 0.68 }),
  stage(26, 'storm', 'Bumper Bay', 126, ['bumpers'], [
    seg('run', 10), seg('bumpers', 14, { count: 4 }),
    seg('run', 8, { checkpoint: true }), seg('bumpers', 18, { count: 6, r: 1.0 }), seg('run', 10),
  ], { bots: 7, skill: 0.7 }),
  stage(27, 'storm', 'Thunder Road', 127, ['fan', 'spinner'], [
    seg('run', 8), seg('fan', 14, { vz: -3.0 }), seg('spinner', 14, { omega: 0.027, count: 1, checkpoint: true }),
    seg('fan', 12, { vx: 3.0 }), seg('spinner', 14, { omega: 0.028, arms: 2, count: 1 }), seg('run', 8),
  ], { bots: 7, skill: 0.72 }),
  stage(28, 'storm', 'Ricochet Ridge', 128, ['bumpers', 'gap'], [
    seg('run', 8), seg('bumpers', 14, { count: 5 }), seg('gaps', 14, { gaps: [[7, 3.5]], checkpoint: true }),
    seg('bumpers', 16, { count: 6, r: 1.0 }), seg('gap', 8, { gap: 3.6 }), seg('run', 8),
  ], { bots: 7, skill: 0.74 }),
  stage(29, 'storm', 'Cyclone Circuit', 129, ['fan', 'pendulum'], [
    seg('run', 8), seg('fan', 12, { vx: -3.0 }), seg('pendulum', 16, { count: 2, omega: 0.032, checkpoint: true }),
    seg('fan', 12, { vz: -3.2 }), seg('pendulum', 14, { count: 2, omega: 0.033, plane: 'z' }), seg('run', 8),
  ], { bots: 7, skill: 0.76 }),
  stage(30, 'storm', 'Squall Line', 130, ['weave', 'pistons', 'fan'], [
    seg('run', 8), seg('weave', 14, { count: 2, omega: 0.034 }), seg('fan', 10, { vx: 3.0, checkpoint: true }),
    seg('pistons', 16, { count: 3, omega: 0.037, stagger: true }), seg('weave', 14, { count: 2, omega: 0.036, gapW: 3.0 }), seg('run', 8),
  ], { bots: 7, skill: 0.78 }),
  stage(31, 'storm', 'Tempest Trials', 131, ['bumpers', 'fan', 'spinner', 'mover'], [
    seg('run', 8), seg('bumpers', 12, { count: 4 }), seg('fan', 12, { vz: -3.2, checkpoint: true }),
    seg('mover', 10, { omega: 0.032 }), seg('spinner', 16, { omega: 0.029, arms: 2, count: 1 }), seg('run', 8),
  ], { bots: 7, skill: 0.8 }),
  stage(32, 'storm', 'Storm Sovereign', 132, ['fan', 'bumpers', 'pendulum', 'weave', 'pistons'], [
    seg('run', 8), seg('fan', 12, { vx: 3.2 }), seg('bumpers', 14, { count: 5, checkpoint: true }),
    seg('pendulum', 16, { count: 2, omega: 0.034 }), seg('weave', 14, { count: 2, omega: 0.036, checkpoint: true }),
    seg('pistons', 16, { count: 3, omega: 0.038, stagger: true }), seg('run', 10),
  ], { bots: 9, skill: 0.84, mastery: true }),
];

// ---------------------------------------------------------------------------
// Journey: Theme 5 — Aurora Heights (everything, combined)
// ---------------------------------------------------------------------------
const T5 = [
  stage(33, 'aurora', 'Aurora Approach', 133, ['gap', 'spinner', 'conveyor'], [
    seg('run', 8), seg('gaps', 16, { gaps: [[5, 3.4], [11, 3.6]] }),
    seg('spinner', 16, { omega: 0.028, arms: 2, count: 1, checkpoint: true }),
    seg('conveyor', 14, { vz: -2.8 }), seg('spinner', 14, { omega: 0.029, count: 2, reverse: true }), seg('run', 8),
  ], { bots: 7, skill: 0.8 }),
  stage(34, 'aurora', 'Polaris Pass', 134, ['pendulum', 'weave', 'narrow'], [
    seg('run', 8), seg('pendulum', 16, { count: 2, omega: 0.034 }),
    seg('narrow', 12, { w: 4.5, checkpoint: true }), seg('weave', 16, { count: 2, omega: 0.036 }),
    seg('pendulum', 14, { count: 2, omega: 0.035, plane: 'z' }), seg('run', 8),
  ], { bots: 7, skill: 0.82 }),
  stage(35, 'aurora', 'Skyfall Slalom', 135, ['bumpers', 'fan', 'gap'], [
    seg('run', 8), seg('bumpers', 14, { count: 5 }), seg('fan', 12, { vx: -3.2, checkpoint: true }),
    seg('gaps', 16, { gaps: [[5, 3.5], [10, 3.7]] }), seg('bumpers', 14, { count: 6, r: 1.0 }), seg('run', 8),
  ], { bots: 7, skill: 0.84 }),
  stage(36, 'aurora', 'Zenith Zigzag', 136, ['pistons', 'mover', 'weave'], [
    seg('run', 8), seg('pistons', 16, { count: 3, omega: 0.038, stagger: true }),
    seg('mover', 12, { omega: 0.034, pw: 3.0, checkpoint: true }),
    seg('weave', 16, { count: 3, omega: 0.036, gapW: 3.0 }), seg('pistons', 14, { count: 2, omega: 0.04 }), seg('run', 8),
  ], { bots: 7, skill: 0.86 }),
  stage(37, 'aurora', 'Celestial Circuit', 137, ['spinner', 'pendulum', 'conveyor', 'bounce'], [
    seg('run', 8), seg('spinner', 16, { omega: 0.03, arms: 2, count: 2, reverse: true }),
    seg('pendulum', 16, { count: 2, omega: 0.035, checkpoint: true }),
    seg('conveyor', 12, { vz: -3.0 }), seg('bounce', 10, { count: 2, power: 13.5 }),
    seg('spinner', 14, { omega: 0.031, count: 2 }), seg('run', 8),
  ], { bots: 7, skill: 0.88 }),
  stage(38, 'aurora', 'Eclipse Express', 138, ['fan', 'mover', 'pistons', 'weave'], [
    seg('run', 8), seg('fan', 12, { vz: -3.4 }), seg('mover', 12, { omega: 0.034, axis: 'z', A: 2.5, checkpoint: true }),
    seg('pistons', 16, { count: 3, omega: 0.04, stagger: true }), seg('weave', 16, { count: 3, omega: 0.038, gapW: 2.8 }), seg('run', 8),
  ], { bots: 7, skill: 0.9 }),
  stage(39, 'aurora', 'Crown Gauntlet', 139, ['gap', 'spinner', 'pendulum', 'bumpers', 'weave'], [
    seg('run', 8), seg('gaps', 14, { gaps: [[7, 3.6]] }), seg('spinner', 16, { omega: 0.03, arms: 2, count: 1, checkpoint: true }),
    seg('pendulum', 16, { count: 2, omega: 0.036 }), seg('bumpers', 12, { count: 5, checkpoint: true }),
    seg('weave', 16, { count: 3, omega: 0.038, gapW: 2.8 }), seg('spinner', 14, { omega: 0.032, count: 2, reverse: true }), seg('run', 8),
  ], { bots: 7, skill: 0.92 }),
  stage(40, 'aurora', 'Tumble Mastery', 140, ['gap', 'spinner', 'pendulum', 'pistons', 'weave', 'mover', 'fan', 'bumpers', 'conveyor'], [
    seg('run', 8), seg('gaps', 16, { gaps: [[5, 3.5], [11, 3.7]] }),
    seg('spinner', 16, { omega: 0.031, arms: 2, count: 2, reverse: true, checkpoint: true }),
    seg('pendulum', 16, { count: 3, omega: 0.036 }), seg('conveyor', 12, { vx: 3.0, checkpoint: true }),
    seg('pistons', 16, { count: 3, omega: 0.04, stagger: true }), seg('mover', 12, { omega: 0.035, pw: 3.0, checkpoint: true }),
    seg('weave', 16, { count: 3, omega: 0.038, gapW: 2.8 }), seg('fan', 12, { vz: -3.4 }),
    seg('bumpers', 12, { count: 6, r: 1.0 }), seg('run', 10),
  ], { bots: 11, skill: 0.95, mastery: true }),
];

export const JOURNEY = [...T1, ...T2, ...T3, ...T4, ...T5];

// ---------------------------------------------------------------------------
// Learn: five interactive lessons, one rule at a time
// ---------------------------------------------------------------------------
export const LESSONS = [
  {
    type: 'lesson', id: 'lesson-1', title: 'Move Out', version: 1,
    intro: 'Welcome to the sky arena! Reach the finish gate at the far end of the course.',
    steps: [
      { id: 'move', text: 'Move forward — hold {move}', check: { type: 'input', what: 'forward', ticks: 24 } },
      { id: 'cp', text: 'Run through the green checkpoint ring', check: { type: 'event', event: 'checkpoint', count: 1 } },
      { id: 'finish', text: 'Cross the golden finish gate!', check: { type: 'event', event: 'finish', count: 1 } },
    ],
    ...makeCourse('lesson-1', 'cumulus', 11, ['run'], [seg('run', 12, { checkpoint: true }), seg('run', 12, { checkpoint: true }), seg('run', 8)]),
  },
  {
    type: 'lesson', id: 'lesson-2', title: 'Hop To It', version: 1,
    intro: 'Gaps in the track fall away into the sky. Jump them!',
    steps: [
      { id: 'jump1', text: 'Press {jump} to jump the gap', check: { type: 'event', event: 'jump', count: 1 } },
      { id: 'jump2', text: 'Jump both gaps and keep running', check: { type: 'event', event: 'jump', count: 2 } },
      { id: 'finish', text: 'Cross the finish gate!', check: { type: 'event', event: 'finish', count: 1 } },
    ],
    ...makeCourse('lesson-2', 'cumulus', 12, ['gap'], [seg('run', 8), seg('gap', 7, { gap: 2.8 }), seg('run', 6, { checkpoint: true }), seg('gap', 7, { gap: 3.1 }), seg('run', 8)]),
  },
  {
    type: 'lesson', id: 'lesson-3', title: 'Dive Deep', version: 1,
    intro: 'Some gaps are too wide for a plain jump. Dive mid-air to lunge forward.',
    steps: [
      { id: 'dive', text: 'Press {dive} while airborne to dive', check: { type: 'event', event: 'dive', count: 1 } },
      { id: 'finish', text: 'Dive across the wide gap and finish!', check: { type: 'event', event: 'finish', count: 1 } },
    ],
    ...makeCourse('lesson-3', 'cumulus', 13, ['gap', 'dive'], [seg('run', 10), seg('gap', 10, { gap: 5.6, at: 3 }), seg('run', 10)]),
  },
  {
    type: 'lesson', id: 'lesson-4', title: 'Roll With It', version: 1,
    intro: 'Spinning sweepers knock you flying. Falling costs time — checkpoints bring you back.',
    steps: [
      { id: 'cp1', text: 'Reach the checkpoint past the first sweeper', check: { type: 'event', event: 'checkpoint', count: 1 } },
      { id: 'finish', text: 'Dodge (or recover!) and reach the finish', check: { type: 'event', event: 'finish', count: 1 } },
    ],
    ...makeCourse('lesson-4', 'cumulus', 14, ['spinner'], [
      seg('run', 8), seg('spinner', 12, { omega: 0.02, count: 1 }), seg('narrow', 10, { w: 4.5, checkpoint: true }),
      seg('spinner', 12, { omega: 0.024, count: 1 }), seg('run', 8),
    ]),
  },
  {
    type: 'lesson', id: 'lesson-5', title: 'First Race', version: 1,
    intro: 'A real race! Three rivals, one course. Finish in the top 3 to pass.',
    passPlace: 3, bots: { count: 3, skill: 0.25 },
    steps: [
      { id: 'finish', text: 'Race to the finish — top 3 qualifies!', check: { type: 'event', event: 'finish', count: 1 } },
    ],
    ...makeCourse('lesson-5', 'cumulus', 15, ['gap', 'spinner'], [
      seg('run', 10), seg('gap', 8, { gap: 3.2 }), seg('spinner', 14, { omega: 0.02, count: 1, checkpoint: true }), seg('run', 10),
    ]),
  },
];

// ---------------------------------------------------------------------------
// Survival arenas (finals / challenges)
// ---------------------------------------------------------------------------
export const ARENAS = [
  {
    type: 'arena', id: 'arena-carousel', version: 1, name: 'Crown Carousel',
    kind: 'survival', theme: 'cumulus', seed: 501, width: 20, mechanics: ['spinner'],
    par: 60 * 45, timeLimit: 60 * 75, segments: [],
    arena: { r: 9, arms: 1, omega: 0.017, accel: 0.0000024, second: true },
  },
  {
    type: 'arena', id: 'arena-whirlpool', version: 1, name: 'The Whirlpool',
    kind: 'survival', theme: 'storm', seed: 502, width: 20, mechanics: ['spinner'],
    par: 60 * 50, timeLimit: 60 * 80, segments: [],
    arena: { r: 10, arms: 2, omega: 0.015, accel: 0.000002, second: true },
  },
];

// ---------------------------------------------------------------------------
// Show courses (quick play / hosted rotation)
// ---------------------------------------------------------------------------
export const SHOW_COURSES = [
  makeCourse('show-ridge', 'cumulus', 601, ['gap', 'spinner'], [
    seg('run', 10), seg('gaps', 16, { gaps: [[5, 3.2], [11, 3.4]] }),
    seg('spinner', 16, { omega: 0.024, arms: 2, count: 1, checkpoint: true }), seg('run', 10),
  ]),
  makeCourse('show-hammers', 'dawn', 602, ['pendulum', 'conveyor'], [
    seg('run', 8), seg('pendulum', 16, { count: 2, omega: 0.03 }),
    seg('conveyor', 14, { vx: 2.6, checkpoint: true }), seg('pendulum', 14, { count: 2, omega: 0.031, plane: 'z' }), seg('run', 8),
  ]),
  makeCourse('show-shunt', 'nimbus', 603, ['pistons', 'weave'], [
    seg('run', 8), seg('pistons', 16, { count: 3, omega: 0.034, stagger: true }),
    seg('weave', 16, { count: 2, omega: 0.032, checkpoint: true }), seg('run', 10),
  ]),
  makeCourse('show-gale', 'storm', 604, ['fan', 'bumpers'], [
    seg('run', 8), seg('fan', 12, { vx: 3.0 }), seg('bumpers', 14, { count: 5, checkpoint: true }),
    seg('fan', 12, { vz: -3.0 }), seg('run', 8),
  ]),
  makeCourse('show-ferry', 'aurora', 605, ['mover', 'spinner'], [
    seg('run', 8), seg('mover', 12, { omega: 0.03 }), seg('spinner', 16, { omega: 0.027, arms: 2, count: 1, checkpoint: true }), seg('run', 10),
  ]),
  makeCourse('show-gauntlet', 'aurora', 606, ['gap', 'pendulum', 'weave', 'spinner'], [
    seg('run', 8), seg('gaps', 14, { gaps: [[7, 3.5]] }), seg('pendulum', 16, { count: 2, omega: 0.032, checkpoint: true }),
    seg('weave', 14, { count: 2, omega: 0.034 }), seg('spinner', 14, { omega: 0.028, count: 2, reverse: true }), seg('run', 8),
  ]),
];

export const SHOWS = [
  {
    type: 'show', id: 'show-quick', version: 1, name: 'Quick Show', players: 12, botSkill: 0.5,
    rounds: [
      { courseId: 'show-ridge', quota: 8 },
      { courseId: 'show-hammers', quota: 4 },
      { courseId: 'arena-carousel', quota: 1 },
    ],
  },
  {
    type: 'show', id: 'show-grand', version: 1, name: 'Grand Circuit', players: 16, botSkill: 0.62,
    rounds: [
      { courseId: 'show-ridge', quota: 12 },
      { courseId: 'show-shunt', quota: 8 },
      { courseId: 'show-gauntlet', quota: 4 },
      { courseId: 'arena-whirlpool', quota: 1 },
    ],
  },
];

// ---------------------------------------------------------------------------
// Challenges: constrained goals on altered layouts / restricted tools
// ---------------------------------------------------------------------------
export const CHALLENGES = [
  {
    type: 'challenge', id: 'chal-nodive', version: 1, name: 'Feet on the Ground',
    desc: 'Finish Cloud Canyon — diving is disabled.', base: 'j07',
    mods: { noDive: true }, goal: { kind: 'finish' },
  },
  {
    type: 'challenge', id: 'chal-speed', version: 1, name: 'Speed Star',
    desc: 'Finish Dusk Dash at 125% of par pace or faster.', base: 'j15',
    mods: {}, goal: { kind: 'time', ticks: Math.ceil(Math.ceil((66 / 7.2) * 60) * 0.8) },
  },
  {
    type: 'challenge', id: 'chal-flawless', version: 1, name: 'Flawless Gates',
    desc: 'Finish Gate Crasher without falling once.', base: 'j22',
    mods: {}, goal: { kind: 'noFalls' },
  },
  {
    type: 'challenge', id: 'chal-tenjumps', version: 1, name: 'Ten Jumps Only',
    desc: 'Finish Sweeper Sweep using at most ten jumps.', base: 'j06',
    mods: { maxJumps: 10 }, goal: { kind: 'finish' },
  },
  {
    type: 'challenge', id: 'chal-turbo', version: 1, name: 'Turbo Sweepers',
    desc: 'Narrow Nerves, but every sweeper spins 60% faster.', base: 'j05',
    mods: { speedMul: 1.6 }, goal: { kind: 'finish' },
  },
  {
    type: 'challenge', id: 'chal-survive', version: 1, name: 'Last Tumbler',
    desc: 'Survive the Crown Carousel against 7 rivals.', base: 'arena-carousel',
    mods: {}, goal: { kind: 'win' }, bots: { count: 7, skill: 0.6 },
  },
];

// Resolve a challenge into a concrete course definition.
export function challengeCourse(ch) {
  const base = courseById(ch.base);
  if (!base) throw new Error('challenge base missing: ' + ch.base);
  const def = JSON.parse(JSON.stringify(base));
  def.id = ch.id; def.theme = base.theme; def.challenge = ch.id;
  def.name = ch.name; def.mods = ch.mods; def.goal = ch.goal;
  if (ch.mods.speedMul && def.segments) {
    for (const s of def.segments) if (s.omega) s.omega *= ch.mods.speedMul;
  }
  return def;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------
const ALL = [...JOURNEY, ...LESSONS, ...ARENAS, ...SHOW_COURSES];

export function courseById(id) {
  return ALL.find(c => c.id === id) || null;
}

export function showById(id) { return SHOWS.find(s => s.id === id) || null; }
export function challengeById(id) { return CHALLENGES.find(c => c.id === id) || null; }
export function lessonById(id) { return LESSONS.find(l => l.id === id) || null; }
