// The game's heavy jobs off the game's thread (a starhermit:script module
// worker): the Daily's validated course (daily.js dailyDef runs the offline
// probe bot over up to eight candidates) and the results screen's replay
// check (replay.js verify re-runs the whole round). Both are the browser
// build's modules unchanged.
// In: { id, kind: 'daily', date } | { id, kind: 'verify', envelope, def }
// Out: { id, def } | { id, result }
import { dailyDef } from "../js/content/daily.js";
import { verify } from "../js/rules/replay.js";

globalThis.onmessage = (e) => {
  const d = e.data;
  try {
    if (d.kind === "daily") postMessage({ id: d.id, def: dailyDef(d.date) });
    else if (d.kind === "verify") postMessage({ id: d.id, result: verify(d.envelope, d.def) });
  } catch (err) {
    postMessage({ id: d.id, error: String(err && err.message || err) });
  }
};
