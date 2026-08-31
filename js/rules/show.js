// Show = an ordered series of elimination rounds ending in a final.
// Pure logic only; the session layer drives sims and calls into this.

export function createShow(def, roster) {
  if (!def.rounds || def.rounds.length === 0) throw new Error('show needs rounds');
  const standings = {};
  for (const r of roster) standings[r.id] = { points: 0, rounds: [], bestPlace: 1e9 };
  return {
    def, roster, roundIndex: 0,
    aliveIds: roster.map(r => r.id),
    standings,
    results: [],       // per-round roundResults()
    terminal: null,    // { reason:'champion', championId } | { reason:'eliminated' }
  };
}

export function currentRound(show) {
  return show.def.rounds[show.roundIndex];
}

export function isFinalRound(show) {
  return show.roundIndex === show.def.rounds.length - 1;
}

// Record a finished round and advance the show.
// roundResult is the output of scoring.roundResults(state).
export function applyRoundResult(show, roundResult) {
  show.results.push(roundResult);
  const qualified = [];
  for (const id of roundResult.places) {
    const res = roundResult.results[id];
    const st = show.standings[id];
    if (!st) continue;
    st.points += res.total;
    st.rounds.push(res.place);
    st.bestPlace = Math.min(st.bestPlace, res.place);
    if (res.qualified) qualified.push(id);
  }

  if (isFinalRound(show)) {
    const championId = roundResult.places[0];
    show.terminal = { reason: 'champion', championId, round: show.roundIndex };
  } else {
    show.aliveIds = qualified;
    show.roundIndex += 1;
    if (show.aliveIds.length === 0) {
      // everyone crashed out — revive the top of the round so the show goes on
      show.aliveIds = roundResult.places.slice(0, Math.min(2, roundResult.places.length));
    }
    if (show.aliveIds.length === 1 && show.roundIndex < show.def.rounds.length) {
      // lone survivor skips ahead to the final
      show.roundIndex = show.def.rounds.length - 1;
    }
  }
  return show;
}

// Final show table sorted by: still-alive first, then points, then best place.
export function showTable(show) {
  const rows = show.roster.map(r => {
    const st = show.standings[r.id];
    const lastRes = show.results.length ? show.results[show.results.length - 1].results[r.id] : null;
    return {
      id: r.id, name: r.name, color: r.color, isBot: r.isBot,
      points: st.points, rounds: st.rounds.slice(), bestPlace: st.bestPlace,
      alive: show.aliveIds.includes(r.id) || (show.terminal && show.terminal.championId === r.id),
      champion: !!(show.terminal && show.terminal.championId === r.id),
      lastPlace: lastRes ? lastRes.place : null,
    };
  });
  rows.sort((a, b) => {
    if (a.champion !== b.champion) return a.champion ? -1 : 1;
    if (a.alive !== b.alive) return a.alive ? -1 : 1;
    if (a.points !== b.points) return b.points - a.points;
    if (a.bestPlace !== b.bestPlace) return a.bestPlace - b.bestPlace;
    return a.id < b.id ? -1 : 1;
  });
  return rows;
}
