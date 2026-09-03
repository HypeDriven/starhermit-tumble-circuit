// Platform time synchronization. Daily boundaries and countdowns use the
// host clock when reachable (GET /api/v1/time, round-trip adjusted); the
// local clock is the offline fallback. Rate limits and structured errors
// surface as recoverable states, not crashes.

let offsetMs = 0;      // serverNow - performanceTimeline estimate
let syncedAt = 0;
let failed = false;

export async function syncTime(fetchImpl = fetch) {
  const t0 = Date.now();
  try {
    const res = await fetchImpl('/api/v1/time', { cache: 'no-store' });
    const t1 = Date.now();
    if (res.status === 429) { failed = true; return { ok: false, reason: 'rate-limited' }; }
    if (!res.ok) {
      let reason = 'http-' + res.status;
      try { const j = await res.json(); if (j && j.error) reason = j.error; } catch {}
      failed = true;
      return { ok: false, reason };
    }
    const body = await res.json();
    // Hosts expose the epoch under different keys (`ms`, `now`, `serverTime`, `epochMs`).
    const serverMs = Number(body.ms ?? body.now ?? body.serverTime ?? body.epochMs);
    if (!Number.isFinite(serverMs)) throw new Error('bad time payload');
    const rtt = t1 - t0;
    offsetMs = serverMs - (t0 + rtt / 2);
    syncedAt = Date.now();
    failed = false;
    return { ok: true, rtt };
  } catch (e) {
    failed = true;
    return { ok: false, reason: 'offline' };
  }
}

export function nowMs() {
  return Date.now() + (failed || !syncedAt ? 0 : offsetMs);
}

export function nowDate() { return new Date(nowMs()); }

export function utcDateString() { return nowDate().toISOString().slice(0, 10); }

// Milliseconds until the next UTC midnight (daily rollover countdown).
export function msUntilNextUtcDay() {
  const n = nowMs();
  const d = new Date(n);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - n;
}

export function timeState() { return { synced: !!syncedAt && !failed, offsetMs, syncedAt }; }
