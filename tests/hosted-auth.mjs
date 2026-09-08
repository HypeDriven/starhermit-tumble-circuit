import assert from 'node:assert/strict';
process.env.PORT = '0';
const {server} = await import('../server.js');
if (!server.listening) await new Promise(r => server.once('listening',r));
const sockets = [];
async function connect() {
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws`);
  sockets.push(ws);
  const messages = [];
  ws.onmessage = m => messages.push(JSON.parse(m.data));
  await new Promise((r,j) => { ws.onopen=r; ws.onerror=j; });
  return {ws, async request(body,type) {
    ws.send(JSON.stringify(body));
    const until=Date.now()+5000;
    while(Date.now()<until) {
      const i=messages.findIndex(m=>m.t===type);
      if(i>=0)return messages.splice(i,1)[0];
      await new Promise(r=>setTimeout(r,20));
    }
    throw new Error(`Missing ${type}`);
  }};
}
try {
  const a=await connect();
  const joined=await a.request({op:'create',showId:'show-quick'},'joined');
  assert.ok(joined.rejoinToken.length >= 32);
  const b=await connect();
  const denied=await b.request({op:'rejoin',code:joined.code,playerId:joined.playerId},'error');
  assert.equal(denied.error,'cannot rejoin');
  const restored=await b.request({op:'rejoin',code:joined.code,playerId:joined.playerId,rejoinToken:joined.rejoinToken},'joined');
  assert.equal(restored.playerId,joined.playerId);
  a.ws.close();
  await new Promise(r=>setTimeout(r,50));
  const c=await connect();
  const still=await c.request({op:'rejoin',code:joined.code,playerId:joined.playerId,rejoinToken:joined.rejoinToken},'joined');
  assert.equal(still.playerId,joined.playerId);
  c.ws.send(JSON.stringify({op:'leave'}));
  console.log('Hosted seat authentication and replaced-socket cleanup passed');
} finally {
  for(const ws of sockets) ws.close();
  await new Promise(r=>setTimeout(r,100));
  server.closeAllConnections(); await new Promise(r=>server.close(r));
}
