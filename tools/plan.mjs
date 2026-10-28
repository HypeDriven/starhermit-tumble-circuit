// Plans the key rhythms the play scripts use to win rounds, with the real
// round driver (js/session/round.js) and the play scripts' measured timing on
// engine 1.21.0 at minor 23 (render checks run one fixed step a frame):
//
//   until =GO!          matches on the frame of the round's first active tick
//   frames F            (F = 0..)
//   hold KeyW           forward held from tick F + 3
//   repeat N until X    each iteration takes one frame more than its lines
//   key Space 1         Jump applies on tick F + 5, then every period
//   frames A
//   key ShiftLeft 1     Dive A + 2 ticks after each jump
//   frames B
//   end                 period = A + B + 5 ticks
//
// The rules are deterministic and identical natively and in node, so a plan
// found here wins the same way in the render check (tests/native/*.play).
// node tools/plan.mjs <stage:N|lesson:N|course-id> → the first winning F A B.
import { LocalRound, buildRoster, PALETTE } from '../js/session/round.js';
import { courseById, LESSONS, JOURNEY } from '../js/content/stages.js';
import { DT } from '../js/rules/sim.js';

export function setup(spec) {
  if (spec.startsWith('lesson:')) {
    const l = LESSONS[+spec.slice(7)];
    return { def: l, opts: { lesson: l, bots: l.bots ? l.bots.count : 0, botSkill: l.bots ? l.bots.skill : 0.2, quota: l.passPlace || 1 } };
  }
  if (spec.startsWith('stage:')) {
    const s = JOURNEY[+spec.slice(6) - 1];
    return { def: s, opts: { bots: s.bots.count, botSkill: s.bots.skill, quota: s.passPlace } };
  }
  return { def: courseById(spec), opts: { bots: 7, botSkill: 0.55, quota: 4 } };
}
/** Plays the script's rhythm exactly; { place, finished, qualified, lessonDone, ticks }. */
export function play(def, opts, { F, A, B, roster = null, maxTicks = 60 * 150 }) {
  const ros = roster || buildRoster('You', PALETTE[0], opts.bots, def.seed % 23);
  const r = new LocalRound(def, ros, { quota: opts.quota, botSkill: opts.botSkill, lesson: opts.lesson, mods: opts.mods, goal: opts.goal });
  const H = F + 3, J0 = F + 5, P = A + B + 5, D = A + 2;
  while (r.phase !== 'done' && r.state.tick < maxTicks) {
    const a = r.phase === 'active';
    const T = r.state.tick + 1;
    r.setInput({
      mx: 0, mz: a && T >= H ? 1 : 0, forwardHeld: a && T >= H,
      jump: a && T >= J0 && (T - J0) % P === 0, dive: a && T >= J0 + D && (T - J0 - D) % P === 0,
    });
    r.update(DT);
    r.pollLessonInput();
  }
  const me = r.result ? r.result.results[r.localId] : null;
  return { place: me ? me.place : 99, finished: !!me?.finished, qualified: !!me?.qualified, lessonDone: r.lessonDone(), ticks: r.state.tick };
}
export const won = (opts, res) => res.finished && res.place <= opts.quota && (!opts.lesson || res.lessonDone);
/** The first (F, A, B) that wins, cheapest rhythm first. */
export function search(spec, { F = 2 } = {}) {
  const { def, opts } = setup(spec);
  for (let P = 6; P <= 40; P++) for (let A = 0; A <= P - 5; A++) {
    const B = P - 5 - A;
    const res = play(def, opts, { F, A, B });
    if (won(opts, res)) return { F, A, B, ...res };
  }
  return null;
}
if (import.meta.url === `file://${process.argv[1]}`) {
  for (const spec of process.argv.slice(2)) console.log(spec, JSON.stringify(search(spec)));
}
