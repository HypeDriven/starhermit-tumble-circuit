// Heavy jobs on a worker (native/work-worker.js): natively the Daily's probe
// validation (~90 ms a candidate, up to eight) and the replay check (a whole
// round re-simulated, up to a second) take longer than a frame may run, so
// the game keeps drawing (and shows a "thinking" line past 300 ms). Without a
// worker (it failed to start) the job runs on the game's thread as the
// browser build's did.
import { worker, type Worker } from "starhermit:script";
import { frame } from "starhermit:engine";
import { verify } from "../js/rules/replay.js";
import { Daily, type Any, type Def } from "./game.ts";

let w: Worker | null = null;
let failed = false;
let nextId = 1;
interface Job { id: number; msg: Any; done: (r: Any) => void; local: () => Any; at: number }
const jobs = new Map<number, Job>();

function ensure(): Worker | null {
  if (w || failed) return w;
  try {
    w = worker("native/work-worker.js", { type: "module" });
    w.on("message", (m) => {
      const r = m as unknown as { id: number; def?: Def; result?: Any; error?: string };
      const job = jobs.get(r.id);
      if (!job) return;
      jobs.delete(r.id);
      if (r.error) { job.done(job.local()); return; }
      job.done(r.def ?? r.result);
    });
    w.on("error", (msg) => { if (!/not responding/i.test(msg)) console.warn(`worker: ${msg}`); });
    w.on("stopped", () => {
      failed = true; w = null;
      for (const job of [...jobs.values()]) { jobs.delete(job.id); job.done(job.local()); }
    });
  } catch (e) { console.warn(`worker: ${String(e)}`); failed = true; w = null; }
  return w;
}
function run(msg: Any, local: () => Any, done: (r: Any) => void): number {
  const id = nextId++;
  const wk = ensure();
  if (!wk) { done(local()); return id; }
  jobs.set(id, { id, msg, done, local, at: frame().time });
  try { wk.post({ id, ...msg }); }
  catch (e) { jobs.delete(id); console.warn(`worker: ${String(e)}`); done(local()); }
  return id;
}
export function warm(): void { ensure(); }
/** Whether a job has been running for over 300 ms (the "thinking" line). */
export function busy(): boolean {
  const now = frame().time;
  for (const j of jobs.values()) if (now - j.at > 0.3) return true;
  return false;
}
export function cancelAll(): void { jobs.clear(); }
export function daily(date: string, done: (def: Def) => void): void {
  run({ kind: "daily", date }, () => Daily.dailyDef(date), done);
}
export function verifyReplay(envelope: Any, def: Def, done: (r: { ok: boolean; reason?: string }) => void): void {
  const env = JSON.parse(JSON.stringify(envelope));
  const d = JSON.parse(JSON.stringify(def));
  run({ kind: "verify", envelope: env, def: d }, () => verify(env, d), done);
}
