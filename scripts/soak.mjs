// Teste de carga: N clientes simulando humanos numa mesma sala, comandos por S segundos.
import WebSocket from 'ws';

const WSURL = process.env.WSURL || 'ws://127.0.0.1:3000/ws';
const N = Number(process.env.N || 8);
const SECONDS = Number(process.env.SECONDS || 75);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const stats = { sent: 0, recv: 0, bytes: 0, errors: [], closed: 0 };

function mk(i) {
  const ws = new WebSocket(WSURL);
  const c = { i, ws, open: false, map: null, ticks: 0, last: null, mirror: null, you: -1 };
  ws.on('open', () => (c.open = true));
  ws.on('message', (raw) => {
    stats.recv++;
    stats.bytes += raw.length;
    const m = JSON.parse(String(raw));
    if (m.t === 'map') {
      c.map = m;
      c.you = m.you;
      c.mirror = { owner: new Int16Array(m.w * m.h).fill(-1) };
      for (const [idx, o] of m.changes) c.mirror.owner[idx] = o;
    } else if (m.t === 'tick') {
      c.ticks++;
      c.last = m;
      if (c.mirror) for (const [idx, o] of m.changes || []) c.mirror.owner[idx] = o;
    }
  });
  ws.on('close', () => stats.closed++);
  ws.on('error', (e) => stats.errors.push(`c${i}: ${e.message}`));
  c.send = (o) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(o));
      stats.sent++;
    }
  };
  c.waitMap = () =>
    new Promise((res) => {
      if (c.map) return res();
      const h = (raw) => {
        if (JSON.parse(String(raw)).t === 'map') {
          c.ws.off('message', h);
          res();
        }
      };
      c.ws.on('message', h);
    });
  return c;
}

const cpu0 = process.cpuUsage();
const cs = [];
for (let i = 0; i < N; i++) cs.push(mk(i));
await Promise.all(cs.map((c) => new Promise((res) => c.ws.on('open', res))));
cs.forEach((c, i) => c.send({ t: 'hello', name: `Humano${i}` }));
await wait(300);

cs[0].send({ t: 'create', name: 'Host', opts: { totalPlayers: 16, difficulty: 2, maxHumans: 12, isPublic: true, name: 'Soak' } });
await wait(700);
const rooms = await fetch('http://127.0.0.1:3000/api/rooms').then((r) => r.json());
const soakRoom = rooms.find((r) => r.name === 'Soak');
if (!soakRoom) {
  console.log('sala de soak nao encontrada');
  process.exit(1);
}
for (let i = 1; i < N; i++) cs[i].send({ t: 'join', room: soakRoom.id, name: `Humano${i}` });
await wait(900);
cs[0].send({ t: 'start' });
await Promise.all(cs.map((c) => c.waitMap()));
const total = cs[0].map.players.length;
const bots = cs[0].map.players.filter((p) => p.bot).length;
console.log(`${N} clientes no mapa | ${total} impérios (${N} humanos + ${bots} bots) | sala ${soakRoom.id}`);

const stop = Date.now() + SECONDS * 1000;
const timers = cs.map((c, i) =>
  setInterval(() => {
    if (Date.now() > stop || !c.mirror) return;
    const m = c.mirror;
    let from = -1;
    let to = -1;
    for (let k = 0; k < 400; k++) {
      const idx = (Math.random() * m.owner.length) | 0;
      if (m.owner[idx] !== c.you) continue;
      const x = idx % c.map.w;
      const y = (idx / c.map.w) | 0;
      const nbs = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]
        .filter(([nx, ny]) => nx >= 0 && ny >= 0 && nx < c.map.w && ny < c.map.h)
        .map(([nx, ny]) => ny * c.map.w + nx);
      const t = nbs.find((n) => m.owner[n] !== c.you && c.map.terrain && true);
      if (t !== undefined) {
        from = idx;
        to = t;
        break;
      }
    }
    if (from >= 0 && c.map) c.send({ t: 'cmd', c: 'attack', path: [from, to], ratio: 0.9 });
    if (Math.random() < 0.25 && from >= 0) c.send({ t: 'cmd', c: 'build', tile: from, type: 1 + ((Math.random() * 3) | 0) });
    if (Math.random() < 0.08) c.send({ t: 'chat', text: `msg ${i}` });
  }, 350 + i * 40)
);

const s0 = Date.now();
while (Date.now() < stop) await wait(1000);
timers.forEach(clearInterval);
const secs = (Date.now() - s0) / 1000;
await wait(600);

const cpu1 = process.cpuUsage(cpu0);
const tiles = cs.map((c, i) => c.last?.players?.find((p) => p.id === c.you)?.tiles ?? 0);
console.log(`\n${secs.toFixed(0)}s de carga com ${N} clientes conectados simultaneamente`);
console.log(`enviadas=${stats.sent} recebidas=${stats.recv} | ${(stats.bytes / 1024 / secs).toFixed(0)} KB/s recebidos (somados)`);
console.log(`ticks/cliente ≈ ${Math.round(cs.reduce((a, c) => a + c.ticks, 0) / cs.length)} (${(cs.reduce((a, c) => a + c.ticks, 0) / cs.length / secs).toFixed(1)}/s)`);
console.log(`conexoes fechadas=${stats.closed} | erros=${stats.errors.length}`);
console.log(`tiles por humano: [${tiles.join(', ')}]`);
console.log(`cpu consumida pelo cliente de teste: ${((cpu1.user + cpu1.system) / 1e6).toFixed(1)}s`);
if (stats.errors.length) console.log('erros:', stats.errors.slice(0, 5));
cs.forEach((c) => c.ws.close());
process.exit(stats.closed > 0 || stats.errors.length ? 1 : 0);
