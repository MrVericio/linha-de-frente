// Teste de integracao ponta-a-ponta do protocolo (2 clientes reais via WebSocket)
import WebSocket from 'ws';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function b64ToBytes(str) {
  const clean = str.replace(/=+$/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0, buf = 0, bits = 0;
  for (const ch of clean) {
    const v = B64.indexOf(ch);
    if (v < 0) continue;
    buf = (buf << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; out[o++] = (buf >> bits) & 0xff; }
  }
  return out.subarray(0, o);
}

/** espelho do estado do mundo no cliente de teste */
function makeMirror(map) {
  const m = {
    w: map.w, h: map.h,
    terrain: b64ToBytes(map.terrain),
    owner: new Int16Array(map.w * map.h).fill(-1),
    troops: new Int32Array(map.w * map.h),
    bld: new Uint8Array(map.w * map.h),
    players: map.players
  };
  m.apply = (changes) => {
    for (const [i, o, t, b] of changes || []) {
      m.owner[i] = o; m.troops[i] = t; m.bld[i] = b;
    }
  };
  m.apply(map.changes);
  return m;
}

const URL = process.env.URL || 'ws://127.0.0.1:3000/ws';
const log = (...a) => console.log(...a);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function makeClient(name) {
  const ws = new WebSocket(URL);
  const c = {
    name, ws, msgs: [], map: null, ticks: 0, joined: null, lobby: null, over: null,
    errs: [], chats: [], events: [], open: false
  };
  ws.on('open', () => (c.open = true));
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    c.msgs.push(m.t);
    if (m.t === 'map') c.map = m;
    else if (m.t === 'tick') {
      c.ticks++;
      c.lastTick = m;
      for (const e of m.events || []) c.events.push(e.text);
    } else if (m.t === 'joined') c.joined = m;
    else if (m.t === 'lobby') c.lobby = m;
    else if (m.t === 'over') c.over = m;
    else if (m.t === 'err') c.errs.push(m.msg);
    else if (m.t === 'chat') c.chats.push(`${m.from}: ${m.text}`);
  });
  c.send = (o) => ws.send(JSON.stringify(o));
  c.waitFor = async (fn, ms = 6000, label = '') => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (fn()) return true;
      await wait(60);
    }
    throw new Error(`timeout esperando ${label || 'condicao'}`);
  };
  return c;
}

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok, extra });
  log(`${ok ? '✔' : '✘'} ${name}${extra ? ' — ' + extra : ''}`);
};

try {
  const A = makeClient('Alice');
  await A.waitFor(() => A.open, 5000, 'conexao A');
  A.send({ t: 'hello', name: 'Alice' });
  await A.waitFor(() => A.msgs.includes('rooms'), 4000, 'lista de salas');
  check('cliente conecta e recebe welcome+rooms', A.msgs.includes('welcome') && A.msgs.includes('rooms'));

  // cria sala privada
  A.send({ t: 'create', name: 'Alice', opts: { totalPlayers: 8, difficulty: 1, maxHumans: 4, isPublic: false } });
  await A.waitFor(() => A.joined, 4000, 'joined');
  const code = A.joined.room.id;
  check('cria sala privada e entra no lobby', !!code && A.joined.you === 0, `codigo=${code} you=${A.joined.you}`);

  // inicia a partida
  A.send({ t: 'start' });
  await A.waitFor(() => A.map, 8000, 'mapa');
  const map = A.map;
  check('servidor gera e envia o mapa', map.w === 120 && map.h === 88 && map.terrain.length > 1000,
    `${map.w}x${map.h} terrainB64=${map.terrain.length} chars, changes=${map.changes.length}, jogadores=${map.players.length}`);
  check('bots preenchem a partida', map.players.length === 8 && map.players.filter((p) => p.bot).length === 7);

  // espelho do estado + descoberta de alvo neutro terrestre
  const mirror = makeMirror(map);
  const adj = (i) => {
    const x = i % map.w, y = Math.floor(i / map.w);
    return [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]
      .filter(([nx, ny]) => nx >= 0 && ny >= 0 && nx < map.w && ny < map.h)
      .map(([nx, ny]) => ny * map.w + nx);
  };
  // mantem o espelho atualizado a cada tick
  const origOnMsg = A.ws.listeners('message').slice();
  A.ws.removeAllListeners('message');
  let illegalExpand = 0; // tile de outro jogador tomado por mim (nao deve acontecer em expansao)
  A.ws.on('message', (raw) => {
    for (const fn of origOnMsg) fn(raw);
    try {
      const m = JSON.parse(String(raw));
      if (m.t === 'tick') {
        for (const [i, o] of m.changes || []) {
          if (o === 0 && mirror.owner[i] > 0) illegalExpand++;
        }
        mirror.apply(m.changes);
        mirror.players = m.players;
      }
    } catch { /* ignore */ }
  });

  const findNeutralTarget = () => {
    for (let i = 0; i < mirror.owner.length; i++) {
      if (mirror.owner[i] !== 0 || mirror.terrain[i] === 0) continue;
      for (const n of adj(i)) {
        if (mirror.terrain[n] === 0) continue; // agua
        if (mirror.owner[n] === -1) return { from: i, to: n };
      }
    }
    return null;
  };
  let tgt = findNeutralTarget();
  check('existe tile neutro terrestre adjacente ao territorio inicial', !!tgt);

  let captured = false;
  const tilesBefore = mirror.players.find((p) => p.id === 0).tiles;
  for (let attempt = 0; attempt < 30 && !captured; attempt++) {
    tgt = findNeutralTarget();
    if (!tgt) break;
    A.send({ t: 'cmd', c: 'attack', path: [tgt.from, tgt.to], ratio: 1 });
    await wait(200);
    if (mirror.owner[tgt.to] === 0) captured = true;
  }
  const tilesAfter = mirror.players.find((p) => p.id === 0).tiles;
  check('comando de ataque conquista territorio', captured, `tiles ${tilesBefore} -> ${tilesAfter}`);

  // construcao: posto defensivo custa 250 (ouro inicial = 320)
  const beforeGold = mirror.players.find((p) => p.id === 0).gold;
  let builtTile = -1;
  for (let i = 0; i < mirror.owner.length && builtTile < 0; i++) {
    if (mirror.owner[i] !== 0 || mirror.terrain[i] === 0 || mirror.bld[i] !== 0) continue;
    A.send({ t: 'cmd', c: 'build', tile: i, type: 2 });
    await wait(160);
    if (mirror.bld[i] === 2) builtTile = i;
  }
  const afterGold = mirror.players.find((p) => p.id === 0).gold;
  check('construcao de posto defensivo funciona', builtTile >= 0 && afterGold < beforeGold,
    `tile=${builtTile} ouro ${beforeGold} -> ${afterGold}`);

  // validacao: construir em tile alheio deve falhar
  let enemyTile = -1;
  for (let i = 0; i < mirror.owner.length; i++) if (mirror.owner[i] > 0) { enemyTile = i; break; }
  const goldBeforeBad = mirror.players.find((p) => p.id === 0).gold;
  A.send({ t: 'cmd', c: 'build', tile: enemyTile, type: 2 });
  await wait(300);
  const goldAfterBad = mirror.players.find((p) => p.id === 0).gold;
  check('servidor rejeita construcao em territorio alheio', goldAfterBad >= goldBeforeBad - 1 && mirror.bld[enemyTile] !== 2);

  // validacao: ataque em caminho invalido (agua / nao adjacente) e ignorado
  const tilesBeforeBad = mirror.players.find((p) => p.id === 0).tiles;
  A.send({ t: 'cmd', c: 'attack', path: [99999, 3], ratio: 1 });
  A.send({ t: 'cmd', c: 'attack', path: [0, mirror.owner.length - 1], ratio: 1 });
  await wait(300);
  check('comandos invalidos sao descartados sem derrubar o servidor', A.open && mirror.players.find((p) => p.id === 0).tiles >= tilesBeforeBad - 3);

  // segundo cliente entra como espectador
  const Bm = makeClient('Bob');
  await Bm.waitFor(() => Bm.open, 5000, 'conexao B');
  Bm.send({ t: 'hello', name: 'Bob' });
  await wait(200);
  Bm.send({ t: 'join', room: code, name: 'Bob' });
  await Bm.waitFor(() => Bm.map, 8000, 'mapa para B');
  check('segundo cliente recebe o mapa da partida em andamento', Bm.map.w === 120 && Bm.map.spectator === true,
    `spectator=${Bm.map.spectator} changes=${Bm.map.changes.length}`);

  // chat
  A.send({ t: 'chat', text: 'ola mundo' });
  await Bm.waitFor(() => Bm.chats.length > 0, 4000, 'chat');
  check('chat e transmitido para a sala', Bm.chats.some((c) => c.includes('ola mundo')), Bm.chats.join(' | '));

  // ticks continuos
  const t0 = A.ticks;
  await wait(1200);
  check('servidor envia ticks continuamente (~10/s)', A.ticks - t0 >= 8, `${A.ticks - t0} pacotes em 1.2s`);

  // payload medio
  const sizes = [];
  A.ws.on('message', (raw) => sizes.push(String(raw).length));
  await wait(1500);
  const avg = sizes.length ? Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length) : 0;
  log(`   payload medio por broadcast: ${(avg / 1024).toFixed(1)} KB (${sizes.length} pacotes)`);

  // ---- ordem de expansao: clique/compando em neutro distante ----
  const tilesBeforeExp = mirror.players.find((p) => p.id === 0).tiles;
  let far = -1;
  outer: for (let i = 0; i < mirror.owner.length; i++) {
    if (mirror.owner[i] !== -1 || mirror.terrain[i] === 0) continue;
    const x = i % mirror.w;
    const y = Math.floor(i / mirror.w);
    for (const m of [...mirror.owner.keys()].filter((k) => mirror.owner[k] === 0)) {
      const d = Math.abs((m % mirror.w) - x) + Math.abs(Math.floor(m / mirror.w) - y);
      if (d < 12) continue outer;
    }
    far = i;
    break;
  }
  A.send({ t: 'cmd', c: 'expand', tile: far });
  await wait(7000);
  const tilesAfterExp = mirror.players.find((p) => p.id === 0).tiles;
  check('ordem de expansao conquista neutro distante, sem atacar inimigos',
    far >= 0 && tilesAfterExp > tilesBeforeExp && illegalExpand === 0,
    `tiles ${tilesBeforeExp} -> ${tilesAfterExp}, tomados de inimigos=${illegalExpand}`);
  A.send({ t: 'cmd', c: 'expand', tile: -1 });
  await wait(300);

  // bots estao vivos e expandindo
  const botsMoving = mirror.players.filter((p) => p.bot && p.tiles > 0).length;
  check('bots expandem territorio sozinhos', botsMoving >= 6, `${botsMoving}/7 bots com territorio`);

  A.ws.close();
  Bm.ws.close();
} catch (e) {
  log('\nERRO:', e.message);
  results.push({ name: 'excecao', ok: false, extra: e.message });
}

const failed = results.filter((r) => !r.ok);
log(`\n${results.length - failed.length}/${results.length} verificações passaram`);
process.exit(failed.length ? 1 : 0);
