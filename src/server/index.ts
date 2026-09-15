import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { Game } from '../shared/game.js';
import { bytesToB64 } from '../shared/codec.js';
import {
  TICK_HZ, BROADCAST_HZ, PREMATCH_COUNTDOWN, POSTMATCH_SECONDS,
  WIN_CONTROL, NUKE_COST, COSTS, DEFAULT_TOTAL_PLAYERS,
  type PlayerSnapshot, type RoomInfo
} from '../shared/constants.js';
import type { C2S, S2C, CreateOpts } from '../shared/protocol.js';

const PORT = Number(process.env.PORT || 3000);
const HOST = '0.0.0.0';
const PUBLIC_DIR = path.resolve(process.cwd(), 'public');

// ============================================================
//  Salas
// ============================================================
interface Client {
  id: number;
  ws: WebSocket;
  name: string;
  roomId: string | null;
  playerId: number; // -1 quando nao esta em partida
  spectator: boolean;
  sent: { o: Int16Array; t: Int32Array; b: Uint8Array } | null;
  alive: boolean;
  lastChat: number;
}

interface Room {
  id: string;
  name: string;
  game: Game;
  clients: Set<Client>;
  hostConn: number; // id do cliente dono da sala
  isPublic: boolean;
  maxHumans: number;
  totalPlayers: number;
  difficulty: number;
  countdown: number;
  overSince: number;
  mapSeed: number;
}

const rooms = new Map<string, Room>();
const clients = new Map<number, Client>();
let nextConnId = 1;

function roomInfo(r: Room): RoomInfo {
  const humans = [...r.clients].filter((c) => !c.spectator).length;
  return {
    id: r.id,
    name: r.name,
    isPublic: r.isPublic,
    state: r.game.state,
    humans,
    total: r.game.activePlayers().length,
    maxHumans: r.maxHumans,
    bots: r.game.activePlayers().filter((p) => p.bot).length,
    countdown: Math.max(0, Math.ceil(r.countdown)),
    mapSeed: r.mapSeed
  };
}

function publicRooms(): RoomInfo[] {
  return [...rooms.values()].filter((r) => r.isPublic).map(roomInfo);
}

function makeCode(len = 5): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function createRoom(opts: CreateOpts = {}, isPublic = true): Room {
  const id = isPublic ? `pub-${rooms.size + 1}` : makeCode();
  const difficulty = clampInt(opts.difficulty ?? 1, 0, 2);
  const totalPlayers = clampInt(opts.totalPlayers ?? DEFAULT_TOTAL_PLAYERS, 2, 20);
  const maxHumans = clampInt(opts.maxHumans ?? (isPublic ? 8 : 6), 1, 16);
  const seed = (opts.seed ?? (Math.random() * 1e9) >>> 0) >>> 0;
  const room: Room = {
    id,
    name: opts.name?.slice(0, 28) || (isPublic ? `Sala Pública ${rooms.size + 1}` : `Sala ${id}`),
    game: new Game({ seed, totalPlayers, difficulty }),
    clients: new Set(),
    hostConn: -1,
    isPublic,
    maxHumans,
    totalPlayers,
    difficulty,
    countdown: PREMATCH_COUNTDOWN,
    overSince: 0,
    mapSeed: seed
  };
  rooms.set(id, room);
  return room;
}

function clampInt(v: unknown, lo: number, hi: number): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

// salas publicas iniciais
for (let i = 0; i < 2; i++) createRoom({}, true);

function send(c: Client, msg: S2C): void {
  if (c.ws.readyState !== WebSocket.OPEN) return;
  try {
    c.ws.send(JSON.stringify(msg));
  } catch {
    /* ignore */
  }
}

function broadcast(r: Room, msg: S2C): void {
  const data = JSON.stringify(msg);
  for (const c of r.clients) {
    if (c.ws.readyState === WebSocket.OPEN) {
      try {
        c.ws.send(data);
      } catch {
        /* ignore */
      }
    }
  }
}

function cleanName(s: unknown, fallback: string): string {
  const raw = String(s ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>]/g, '')
    .trim()
    .slice(0, 20);
  return raw || fallback;
}

// ============================================================
//  Entrar / sair de salas
// ============================================================
function joinRoom(c: Client, r: Room): void {
  leaveRoom(c);
  r.clients.add(c);
  c.roomId = r.id;
  if (r.hostConn === -1 || ![...r.clients].some((x) => x.id === r.hostConn)) {
    r.hostConn = c.id;
  }

  const playing = r.game.state !== 'waiting';
  const humansInGame = r.game.players.filter((p) => !p.bot && !p.spectator).length;
  c.spectator = playing || humansInGame >= r.maxHumans;

  if (c.spectator) {
    c.playerId = -1;
  } else {
    c.playerId = r.game.addPlayer({ name: c.name, bot: false });
  }

  send(c, {
    t: 'joined',
    room: roomInfo(r),
    you: c.playerId,
    players: r.game.activePlayers(),
    host: r.hostConn
  });

  if (playing) {
    sendMap(c, r);
  } else {
    broadcast(r, { t: 'lobby', room: roomInfo(r), players: r.game.activePlayers(), host: r.hostConn });
    if (r.hostConn === c.id) r.countdown = PREMATCH_COUNTDOWN;
  }
}

function leaveRoom(c: Client): void {
  const rid = c.roomId;
  if (!rid) return;
  const r = rooms.get(rid);
  c.roomId = null;
  c.sent = null;
  if (!r) return;
  r.clients.delete(c);
  if (c.playerId >= 0) r.game.removePlayer(c.playerId);
  c.playerId = -1;
  if (r.hostConn === c.id) {
    const next = [...r.clients][0];
    r.hostConn = next ? next.id : -1;
  }
  if (r.clients.size === 0) {
    if (!r.isPublic) {
      rooms.delete(rid);
      return;
    }
    // sala publica vazia: zera o lobby
    if (r.game.state !== 'playing') r.game.resetToLobby();
    r.countdown = PREMATCH_COUNTDOWN;
  } else {
    broadcast(r, { t: 'lobby', room: roomInfo(r), players: r.game.activePlayers(), host: r.hostConn });
  }
}

function sendMap(c: Client, r: Room): void {
  const g = r.game;
  c.sent = g.newSentState();
  const changes = g.collectChangesFor(c.sent, 1e9);
  send(c, {
    t: 'map',
    w: g.w,
    h: g.h,
    terrain: bytesToB64(g.terrain),
    changes,
    players: g.snapshotPlayers(),
    you: c.playerId,
    room: roomInfo(r),
    spectator: c.spectator,
    rules: { winControl: WIN_CONTROL, nukeCost: NUKE_COST, costs: COSTS }
  });
}

// ============================================================
//  WebSocket
// ============================================================
const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  if (url.pathname === '/api/rooms') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(publicRooms()));
    return;
  }
  if (url.pathname === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, uptime: process.uptime() }));
    return;
  }
  serveStatic(url.pathname, res);
});

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8'
};

function serveStatic(pathname: string, res: http.ServerResponse): void {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('404');
      return;
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': 'no-store'
    });
    res.end(data);
  });
}

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  const c: Client = {
    id: nextConnId++,
    ws,
    name: 'Comandante',
    roomId: null,
    playerId: -1,
    spectator: false,
    sent: null,
    alive: true,
    lastChat: 0
  };
  clients.set(c.id, c);
  send(c, { t: 'welcome', you: c.id, serverTime: Date.now() });
  send(c, { t: 'rooms', rooms: publicRooms() });

  ws.on('message', (raw) => {
    let msg: C2S;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    handleMessage(c, msg);
  });

  ws.on('close', () => {
    clients.delete(c.id);
    leaveRoom(c);
  });
  ws.on('error', () => {
    clients.delete(c.id);
    leaveRoom(c);
  });
  ws.on('pong', () => (c.alive = true));
});

function handleMessage(c: Client, msg: C2S): void {
  switch (msg.t) {
    case 'hello':
      c.name = cleanName(msg.name, 'Comandante');
      break;

    case 'ping':
      send(c, { t: 'pong', ms: Date.now() });
      break;

    case 'rooms':
      send(c, { t: 'rooms', rooms: publicRooms() });
      break;

    case 'create': {
      c.name = cleanName(msg.name, c.name);
      const r = createRoom(msg.opts || {}, !!msg.opts?.isPublic);
      joinRoom(c, r);
      send(c, { t: 'rooms', rooms: publicRooms() });
      break;
    }

    case 'join': {
      c.name = cleanName(msg.name, c.name);
      const code = String(msg.room || '').trim().toUpperCase();
      let r = rooms.get(code) || rooms.get(code.toLowerCase());
      if (!r) {
        r = [...rooms.values()].find((x) => x.id.toUpperCase() === code || x.name.toUpperCase() === code);
      }
      if (!r) {
        send(c, { t: 'err', msg: 'Sala não encontrada.' });
        return;
      }
      joinRoom(c, r);
      break;
    }

    case 'start': {
      const r = rooms.get(c.roomId || '');
      if (!r) return;
      if (r.hostConn !== c.id && r.clients.size > 1) {
        send(c, { t: 'err', msg: 'Só o dono da sala pode iniciar.' });
        return;
      }
      if (r.game.state === 'waiting') startMatch(r);
      break;
    }

    case 'cmd': {
      const r = rooms.get(c.roomId || '');
      if (!r || c.playerId < 0 || c.spectator) return;
      const g = r.game;
      if (g.state !== 'playing') return;
      if (msg.c === 'attack') {
        const pathArr = (msg.path || []).slice(0, 400).map((v) => Math.floor(Number(v)));
        if (pathArr.some((v) => !Number.isFinite(v) || v < 0 || v >= g.n)) return;
        g.attackChain(c.playerId, pathArr, Number(msg.ratio) || 0.5);
      } else if (msg.c === 'build') {
        const tile = Math.floor(Number(msg.tile));
        if (!Number.isFinite(tile) || tile < 0 || tile >= g.n) return;
        g.build(c.playerId, tile, Math.floor(Number(msg.type)));
      } else if (msg.c === 'expand') {
        const tile = Math.floor(Number(msg.tile));
        if (!(tile >= -1 && tile < g.n)) return;
        g.setExpand(c.playerId, tile);
      } else if (msg.c === 'invade') {
        const tile = Math.floor(Number(msg.tile));
        if (!(tile >= -1 && tile < g.n)) return;
        g.setInvade(c.playerId, tile);
      } else if (msg.c === 'nuke') {
        const from = Math.floor(Number(msg.from));
        const to = Math.floor(Number(msg.to));
        if (![from, to].every((v) => Number.isFinite(v) && v >= 0 && v < g.n)) return;
        g.nuke(c.playerId, from, to);
      }
      break;
    }

    case 'chat': {
      const r = rooms.get(c.roomId || '');
      if (!r) return;
      const now = Date.now();
      if (now - c.lastChat < 700) return;
      c.lastChat = now;
      const text = cleanName(msg.text, '').slice(0, 140);
      if (!text) return;
      const hue = c.playerId >= 0 ? r.game.players[c.playerId]?.hue : undefined;
      broadcast(r, { t: 'chat', from: c.name, text, hue });
      break;
    }

    case 'leave':
      leaveRoom(c);
      send(c, { t: 'rooms', rooms: publicRooms() });
      break;
  }
}

function startMatch(r: Room): void {
  r.game.difficulty = r.difficulty;
  r.game.totalPlayers = r.totalPlayers;
  r.mapSeed = (Math.random() * 1e9) >>> 0;
  r.game.startMatch(r.mapSeed);
  r.countdown = 0;
  r.overSince = 0;
  for (const c of r.clients) {
    c.spectator = false;
    if (c.playerId < 0) c.playerId = r.game.addPlayer({ name: c.name, bot: false });
    sendMap(c, r);
  }
  broadcast(r, {
    t: 'tick',
    dt: 0,
    changes: [],
    players: r.game.snapshotPlayers(),
    events: r.game.drainEvents(),
    time: 0,
    state: 'playing'
  });
}

// ============================================================
//  Loop principal
// ============================================================
const TICK_MS = 1000 / TICK_HZ;
const BROADCAST_EVERY = Math.max(1, Math.round(TICK_HZ / BROADCAST_HZ));
let tickCount = 0;

setInterval(() => {
  const dt = 1 / TICK_HZ;
  tickCount++;
  for (const r of rooms.values()) {
    const g = r.game;

    if (g.state === 'playing') {
      g.tick(dt);
      const st: string = g.state;
      if (st === 'over') {
        r.overSince = Date.now();
        broadcast(r, { t: 'over', winner: g.winner, reason: g.winReason, players: g.snapshotPlayers() });
      }
    } else if (g.state === 'over') {
      if (Date.now() - r.overSince > POSTMATCH_SECONDS * 1000) {
        g.resetToLobby();
        r.countdown = PREMATCH_COUNTDOWN;
        for (const c of r.clients) {
          c.playerId = g.addPlayer({ name: c.name, bot: false });
          c.spectator = false;
          c.sent = null;
        }
        broadcast(r, { t: 'lobby', room: roomInfo(r), players: g.activePlayers(), host: r.hostConn });
      }
    } else if (g.state === 'waiting') {
      const humans = [...r.clients].length;
      if (humans > 0) {
        r.countdown -= dt;
        if (r.countdown <= 0) startMatch(r);
      } else {
        r.countdown = PREMATCH_COUNTDOWN;
      }
    }

    // broadcast de estado
    if (tickCount % BROADCAST_EVERY === 0 && r.clients.size) {
      const players: PlayerSnapshot[] = g.state === 'waiting' ? g.activePlayers() : g.snapshotPlayers();
      const events = g.drainEvents();
      const info = roomInfo(r);
      for (const c of r.clients) {
        let changes: [number, number, number, number][] = [];
        if (g.state !== 'waiting') {
          if (!c.sent) c.sent = g.newSentState();
          changes = g.collectChangesFor(c.sent, 2500);
        }
        send(c, { t: 'tick', dt, changes, players, events, time: g.time, state: g.state });
      }
      if (g.state === 'waiting') {
        broadcast(r, { t: 'lobby', room: info, players, host: r.hostConn });
      }
    }
  }
}, TICK_MS);

// keepalive
setInterval(() => {
  for (const c of clients.values()) {
    if (!c.alive) {
      c.ws.terminate();
      clients.delete(c.id);
      leaveRoom(c);
      continue;
    }
    c.alive = false;
    try {
      c.ws.ping();
    } catch {
      /* ignore */
    }
  }
}, 30000);

server.listen(PORT, HOST, () => {
  console.log(`[linha-de-frente] servidor em http://${HOST}:${PORT}`);
});
