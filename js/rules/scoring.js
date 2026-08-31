// Round scoring with full component breakdown. All stored values are
// integers; formatting happens only in presentation.

import { PSTATE, rankPlayers } from './sim.js';

export function placePoints(place) {
  if (place <= 1) return 1000;
  const table = [1000, 820, 680, 570, 490, 430, 380, 340, 310];
  return place <= table.length ? table[place - 1] : Math.max(150, 310 - (place - 9) * 20);
}

// Compute per-player results for a terminal (or time-cut) race/survival state.
// Mutates nothing; returns { places: [playerIds in order], results: Map-like }.
export function roundResults(state) {
  const ranked = rankPlayers(state);
  const quota = state.quota;
  const results = {};
  const finishIdx = new Map(state.finishOrder.map((id, i) => [id, i]));

  ranked.forEach((p, i) => {
    const place = i + 1;
    const finished = p.st === PSTATE.FINISH;
    let qualified = false;
    if (state.kind === 'race') {
      if (finished) qualified = (finishIdx.get(p.id) != null ? finishIdx.get(p.id) : 1e9) < quota;
      else qualified = state.finishOrder.length + countUnfinishedAhead(ranked, p, state) < quota &&
        state.terminal && state.terminal.reason === 'time';
    } else {
      qualified = place <= quota;
    }

    const cp = state.kind === 'race' ? p.cp * 50 : 0;
    const placement = placePoints(place);
    const qualify = qualified ? 250 : 0;
    const timeBonus = finished ? Math.max(0, Math.floor((state.par - p.finishTick) / 8)) : 0;
    const survival = state.kind === 'survival' ? Math.floor(p.aliveTicks / 6) : 0;
    const falls = -25 * p.falls;
    const total = cp + placement + qualify + timeBonus + survival + falls;

    results[p.id] = {
      playerId: p.id, place, qualified,
      finished, finishTick: p.finishTick, aliveTicks: p.aliveTicks,
      breakdown: { checkpoints: cp, placement, qualify, timeBonus, survival, falls },
      total,
      stats: { falls: p.falls, invalids: p.invalids, jumps: p.jumps, dives: p.dives, knocks: p.knocks },
    };
  });

  return { places: ranked.map(p => p.id), results, terminal: state.terminal };
}

function countUnfinishedAhead(ranked, p, state) {
  let n = 0;
  for (const q of ranked) {
    if (q.id === p.id) break;
    if (q.st !== PSTATE.FINISH) n++;
  }
  return n;
}

export function formatTicks(ticks) {
  const t = Math.max(0, ticks | 0);
  const m = Math.floor(t / 3600);
  const s = Math.floor((t % 3600) / 60);
  const cs = Math.floor(((t % 60) * 100) / 60);
  return (m > 0 ? m + ':' + String(s).padStart(2, '0') : String(s)) + '.' + String(cs).padStart(2, '0');
}
