// Replay envelopes: schema version, build/content versions, seed, initial
// hash, ordered commands, periodic state hashes and the terminal result.
// verify() re-runs the simulation and compares hashes — the property test
// for determinism ("same version + seed + commands => identical hashes").

import { createState, applyCommand, step, serializeState, hashGameState, RULES_VERSION } from './sim.js';

export const REPLAY_SCHEMA = 1;
export const HASH_INTERVAL = 60;

export class Recorder {
  constructor({ build, courseDef, roster, opts }) {
    this.courseDef = courseDef;
    this.envelope = {
      schema: REPLAY_SCHEMA,
      build: build || 'dev',
      rulesVersion: RULES_VERSION,
      content: { id: courseDef.id, version: courseDef.version || 1, seed: courseDef.seed >>> 0 },
      roster: roster.map(r => ({ id: r.id, name: r.name, color: r.color | 0, isBot: !!r.isBot, sid: r.sid })),
      opts: {
        quota: opts && opts.quota, timeLimit: opts && opts.timeLimit,
        botSkill: opts && opts.botSkill, seedOverride: opts && opts.seedOverride,
      },
      createdAtOffset: 0,
      commands: [],
      hashes: [],
      terminal: null,
      result: null,
    };
  }
  begin(state) {
    this.envelope.initialHash = hashGameState(state);
  }
  record(cmd) {
    this.envelope.commands.push({ id: cmd.id, playerId: cmd.playerId, tick: cmd.tick, mx: cmd.mx, mz: cmd.mz, jump: cmd.jump, dive: cmd.dive });
  }
  tickHash(state) {
    if (state.tick % HASH_INTERVAL === 0) {
      this.envelope.hashes.push({ tick: state.tick, hash: hashGameState(state) });
    }
  }
  finalize(state, result) {
    this.envelope.terminal = state.terminal;
    this.envelope.finalTick = state.tick;
    this.envelope.finalHash = hashGameState(state);
    this.envelope.result = result || null;
    return this.envelope;
  }
}

// Re-run an envelope against the same content definition.
// Returns { ok, reason, mismatchAt, ticks }.
export function verify(envelope, courseDef, maxTicks = 60 * 60 * 30) {
  if (envelope.schema !== REPLAY_SCHEMA) return { ok: false, reason: 'schema' };
  if (envelope.rulesVersion !== RULES_VERSION) return { ok: false, reason: 'rules-version' };
  if (envelope.content.id !== courseDef.id || envelope.content.seed !== (courseDef.seed >>> 0)) {
    return { ok: false, reason: 'content-mismatch' };
  }
  const state = createState(courseDef, envelope.roster, envelope.opts || {});
  if (hashGameState(state) !== envelope.initialHash) return { ok: false, reason: 'initial-hash' };

  const cmds = envelope.commands.slice().sort((a, b) => a.tick - b.tick);
  let ci = 0;
  let hi = 0;
  while (state.phase === 'active' && state.tick < maxTicks) {
    const nextTick = state.tick + 1;
    while (ci < cmds.length && cmds[ci].tick <= nextTick) {
      const c = cmds[ci++];
      if (c.tick === nextTick) applyCommand(state, c);
      // stale/late commands in the envelope were dropped live too; skip
    }
    step(state);
    if (hi < envelope.hashes.length && envelope.hashes[hi].tick === state.tick) {
      const h = hashGameState(state);
      if (h !== envelope.hashes[hi].hash) {
        return { ok: false, reason: 'hash-mismatch', mismatchAt: state.tick };
      }
      hi++;
    }
  }
  if (envelope.finalHash && hashGameState(state) !== envelope.finalHash) {
    return { ok: false, reason: 'final-hash', mismatchAt: state.tick };
  }
  const a = state.terminal ? state.terminal.reason : null;
  const b = envelope.terminal ? envelope.terminal.reason : null;
  if (a !== b) return { ok: false, reason: 'terminal-mismatch' };
  return { ok: true, ticks: state.tick };
}
