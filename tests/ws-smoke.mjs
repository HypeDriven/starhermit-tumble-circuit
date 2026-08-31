// Hosted-round smoke test against a running server (node tests/ws-smoke.mjs <port>)
const port = process.argv[2] || '8421';
const ws = new WebSocket(`ws://localhost:${port}/ws`);
let snaps = 0;
ws.onopen = () => ws.send(JSON.stringify({ op: 'create', showId: 'show-quick' }));
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.t === 'joined') {
    console.log('joined room', msg.code, 'as', msg.playerId);
    ws.send(JSON.stringify({ op: 'ready', ready: true }));
  } else if (msg.t === 'lobby') {
    console.log('lobby:', msg.players.map(p => p.name + (p.ready ? ' (ready)' : '')).join(', '));
  } else if (msg.t === 'start') {
    console.log('START course', msg.courseId, 'quota', msg.quota, 'roster', msg.roster.length);
    let tick = 0;
    const iv = setInterval(() => {
      tick += 3;
      const buf = new ArrayBuffer(10);
      const dv = new DataView(buf);
      dv.setUint8(0, 1); dv.setUint32(1, tick + 1);
      dv.setInt8(5, 0); dv.setInt8(6, 127);
      dv.setUint8(7, tick % 90 === 0 ? 1 : 0);
      dv.setUint16(8, tick & 0xffff);
      ws.send(buf);
    }, 50);
    ws._iv = iv;
  } else if (msg.t === 'snapshot') {
    if (++snaps % 40 === 0) console.log('snapshot tick', msg.tick, 'p0', JSON.stringify(msg.players[0]));
  } else if (msg.t === 'result') {
    console.log('RESULT terminal', JSON.stringify(msg.terminal), 'places', msg.places.length, 'winner', msg.places[0]);
    const mine = msg.results[msg.places.find(id => !id.startsWith('bot'))];
    console.log('human result:', JSON.stringify(mine && { place: mine.place, total: mine.total, qualified: mine.qualified }));
    clearInterval(ws._iv);
    ws.close();
    process.exit(0);
  } else if (msg.t === 'error') {
    console.log('ERROR', msg.error);
    process.exit(1);
  }
};
setTimeout(() => { console.log('TIMEOUT, snaps', snaps); process.exit(1); }, 150000);
