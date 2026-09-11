import { World, type Region } from './state.js';
import { Renderer, type Camera, type Explosion, type ExpandMarker } from './render.js';
import { Game } from '../shared/game.js';
import { bytesToB64 } from '../shared/codec.js';
import {
  B, T, COSTS, NUKE_COST, NUKE_RANGE, SUDDEN_DEATH_AT, WIN_CONTROL,
  TICK_HZ, POSTMATCH_SECONDS, DEFAULT_TOTAL_PLAYERS, PREMATCH_COUNTDOWN,
  type Change, type GameEvent, type PlayerSnapshot, type RoomInfo
} from '../shared/constants.js';
import type { C2S, S2C } from '../shared/protocol.js';

// ---------------------------------------------------------------- util
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const el = {
  conn: $('conn'), hud: $('hud'), menu: $('menu'), lobby: $('lobby'), over: $('over'),
  meDot: $('meDot'), meName: $('meName'), sGold: $('sGold'), sTiles: $('sTiles'),
  sTroops: $('sTroops'), sTime: $('sTime'), sPos: $('sPos'),
  hint: $('hint'), sd: $('sd'), selinfo: $('selinfo'), rankList: $('rankList'),
  ratioVal: $('ratioVal'), ratioRange: $('ratioRange') as HTMLInputElement,
  buildbar: $('buildbar'), log: $('log'), chatInput: $('chatInput') as HTMLInputElement,
  chatSend: $('chatSend'), roomlist: $('roomlist'), nameInput: $('nameInput') as HTMLInputElement,
  codeInput: $('codeInput') as HTMLInputElement, lobbyTitle: $('lobbyTitle'),
  lobbyCode: $('lobbyCode'), count: $('count'), plist: $('plist'), btnStart: $('btnStart'),
  overTitle: $('overTitle'), overReason: $('overReason'), overStats: $('overStats'),
  overCount: $('overCount'), winPct: $('winPct')
};

const world = new World();
let renderer: Renderer;
const cam: Camera = { x: 0, y: 0, zoom: 11 };
let selected = -1;
let hover = -1;
let path: number[] | null = null;
let buildType = 0;
let nukeMode = false;
let showNumbers = true;
let ratio = 0.7;
let explosions: Explosion[] = [];
let regions: Region[] = [];
let lastRegions = 0;
let mode: 'menu' | 'lobby' | 'playing' | 'over' = 'menu';
let ws: WebSocket | null = null;
let wsOk = false;
let localGame: Game | null = null;
let room: RoomInfo | null = null;
let hostConn = -1;
let myConn = -1;
let overShown = false;
let lastDragAttack = 0;
let lastHover = -2;

const keys = new Set<string>();
const savedName = localStorage.getItem('ldf:name') || '';
if (savedName) el.nameInput.value = savedName;
el.winPct.textContent = `${Math.round(WIN_CONTROL * 100)}%`;

function playerName(): string {
  const n = (el.nameInput.value || '').trim().slice(0, 20);
  localStorage.setItem('ldf:name', n);
  return n || 'Comandante';
}

function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${m}:${String(ss).padStart(2, '0')}`;
}
function fmtNum(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e4) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}
function colorOf(p?: PlayerSnapshot): string {
  if (!p) return '#8a97a8';
  return `hsl(${p.hue} ${p.alive ? 62 : 30}% ${p.alive ? 52 : 38}%)`;
}

let hintTimer = 0;
function hint(msg: string, ms = 2200): void {
  el.hint.textContent = msg;
  el.hint.classList.remove('hidden');
  hintTimer = performance.now() + ms;
}

// ---------------------------------------------------------------- log
const logLines: { text: string; color?: string }[] = [];
function pushEvent(e: GameEvent): void {
  const color = e.kind === 'nuke' ? '#ffb4a0' : e.kind === 'over' ? '#ffe28a' : e.kind === 'war' ? '#ffc9c9' : e.hue !== undefined ? `hsl(${e.hue} 70% 76%)` : undefined;
  logLines.push({ text: e.text, color });
  if (logLines.length > 60) logLines.shift();
  renderLog();
}
function pushChat(from: string, text: string, hue?: number): void {
  logLines.push({ text: `💬 ${from}: ${text}`, color: hue !== undefined ? `hsl(${hue} 70% 78%)` : '#cfe3ff' });
  if (logLines.length > 60) logLines.shift();
  renderLog();
}
function renderLog(): void {
  const frag = document.createDocumentFragment();
  for (const l of logLines.slice(-26)) {
    const d = document.createElement('div');
    d.textContent = l.text;
    if (l.color) d.style.color = l.color;
    frag.appendChild(d);
  }
  el.log.replaceChildren(frag);
  el.log.scrollTop = el.log.scrollHeight;
}

// ---------------------------------------------------------------- rede
function setConn(text: string, cls: string): void {
  el.conn.textContent = text;
  el.conn.className = cls;
}

function connect(): void {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  setConn('conectando…', '');
  try {
    ws = new WebSocket(`${proto}//${location.host}/ws`);
  } catch {
    setConn('sem conexão', 'bad');
    return;
  }
  const failTimer = window.setTimeout(() => {
    if (!wsOk) setConn('servidor indisponível — use o modo offline', 'bad');
  }, 4000);

  ws.onopen = () => {
    wsOk = true;
    window.clearTimeout(failTimer);
    setConn('online', 'ok');
    send({ t: 'hello', name: playerName() });
    send({ t: 'rooms' });
  };
  ws.onmessage = (ev) => {
    let msg: S2C;
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    handle(msg);
  };
  ws.onclose = () => {
    wsOk = false;
    setConn('desconectado', 'bad');
    if (mode === 'playing' && !localGame) {
      hint('Conexão perdida. Recarregue a página ou jogue offline.', 6000);
    }
    window.setTimeout(connect, 2500);
  };
  ws.onerror = () => {
    wsOk = false;
  };
}

function send(msg: C2S): void {
  if (localGame) {
    localCommand(msg);
    return;
  }
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* ignore */
    }
  }
}

function handle(m: S2C): void {
  switch (m.t) {
    case 'welcome':
      myConn = m.you;
      break;
    case 'pong':
      break;
    case 'rooms':
      renderRooms(m.rooms);
      break;
    case 'joined':
      room = m.room;
      hostConn = m.host;
      world.you = m.you;
      world.players = m.players;
      world.spectator = m.you < 0;
      showLobby(m.room, m.players);
      break;
    case 'lobby':
      room = m.room;
      hostConn = m.host;
      world.players = m.players;
      if (mode === 'lobby') showLobby(m.room, m.players);
      else if (mode === 'over') {
        el.over.classList.add('hidden');
        overShown = false;
        showLobby(m.room, m.players);
      }
      break;
    case 'map': {
      world.rules = m.rules;
      world.spectator = m.spectator;
      world.loadMap(m.w, m.h, m.terrain, m.changes, m.players, m.you);
      world.time = 0;
      room = m.room;
      logLines.length = 0;
      explosions = [];
      overShown = false;
      selected = -1;
      buildType = 0;
      nukeMode = false;
      regions = [];
      mode = 'playing';
      el.menu.classList.add('hidden');
      el.lobby.classList.add('hidden');
      el.over.classList.add('hidden');
      el.hud.classList.remove('hidden');
      centerOnMe(13);
      buildBar();
      pushEvent({ text: m.spectator ? 'Você entrou como espectador desta partida.' : 'Partida iniciada! Boa sorte, comandante.', kind: 'info' });
      break;
    }
    case 'tick':
      if (m.changes.length) world.apply(m.changes);
      world.players = m.players;
      world.time = m.time;
      world.state = m.state;
      for (const e of m.events) onEvent(e);
      if (m.state === 'over' && !overShown) showOver();
      if (m.state === 'playing' && mode === 'over') {
        el.over.classList.add('hidden');
        overShown = false;
        mode = 'playing';
        el.hud.classList.remove('hidden');
      }
      break;
    case 'over':
      world.state = 'over';
      world.players = m.players;
      showOver(m.winner, m.reason);
      break;
    case 'chat':
      pushChat(m.from, m.text, m.hue);
      break;
    case 'err':
      hint(m.msg, 2600);
      break;
  }
}

function onEvent(e: GameEvent): void {
  pushEvent(e);
  if (e.kind === 'nuke' && e.i !== undefined && e.i >= 0 && world.n) {
    explosions.push({ x: (e.i % world.w) + 0.5, y: Math.floor(e.i / world.w) + 0.5, t: performance.now() });
  }
  if (e.kind === 'over' && !overShown) showOver();
}

// ---------------------------------------------------------------- telas
function renderRooms(rooms: RoomInfo[]): void {
  if (!rooms.length) {
    el.roomlist.replaceChildren(Object.assign(document.createElement('div'), { className: 'mut tiny', textContent: 'nenhuma sala pública — crie uma!' }));
    return;
  }
  const frag = document.createDocumentFragment();
  for (const r of rooms) {
    const d = document.createElement('div');
    d.className = 'room';
    const left = document.createElement('div');
    const b = document.createElement('b');
    b.textContent = r.name;
    const s = document.createElement('div');
    s.className = 'tiny mut';
    s.textContent = `${r.state === 'playing' ? 'em jogo' : 'aguardando'} · ${r.humans}/${r.maxHumans} humanos · ${r.total} impérios`;
    left.append(b, s);
    const btn = document.createElement('button');
    btn.textContent = r.state === 'playing' ? 'Assistir' : 'Entrar';
    btn.onclick = () => {
      send({ t: 'hello', name: playerName() });
      send({ t: 'join', room: r.id, name: playerName() });
    };
    d.append(left, btn);
    frag.appendChild(d);
  }
  el.roomlist.replaceChildren(frag);
}

function showLobby(r: RoomInfo, players: PlayerSnapshot[]): void {
  mode = 'lobby';
  el.menu.classList.add('hidden');
  el.over.classList.add('hidden');
  el.hud.classList.add('hidden');
  el.lobby.classList.remove('hidden');
  el.lobbyTitle.textContent = r.name;
  el.lobbyCode.textContent = r.isPublic ? 'sala pública' : `código ${r.id}`;
  el.count.textContent = r.state === 'playing' ? '⚔' : String(r.countdown || PREMATCH_COUNTDOWN);
  (el.btnStart as HTMLButtonElement).disabled = !(hostConn === myConn || r.humans <= 1);

  const frag = document.createDocumentFragment();
  const humans = players.filter((p) => !p.bot);
  for (const p of humans) {
    const d = document.createElement('div');
    d.className = 'pl';
    const dot = document.createElement('span');
    dot.style.cssText = `width:11px;height:11px;border-radius:50%;background:${colorOf(p)}`;
    const nm = document.createElement('b');
    nm.textContent = p.name + (p.id === world.you ? ' (você)' : '');
    d.append(dot, nm);
    if (p.id === world.you) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = 'você';
      d.append(badge);
    }
    frag.appendChild(d);
  }
  const botCount = Math.max(0, r.total - humans.length);
  const botLine = document.createElement('div');
  botLine.className = 'pl tiny mut';
  botLine.textContent = `🤖 ${botCount} bots vão preencher a partida (total de ${r.total} impérios)`;
  frag.appendChild(botLine);
  el.plist.replaceChildren(frag);
}

function showOver(winnerId?: number, reason?: string): void {
  const wid = winnerId ?? world.players.slice().sort((a, b) => b.tiles - a.tiles)[0]?.id ?? -1;
  const r = reason ?? world.players.find((p) => p.id === wid)?.name ?? '';
  overShown = true;
  mode = 'over';
  const w = world.playerById(wid);
  const iWon = wid === world.you;
  el.overTitle.textContent = iWon ? '🏆 Vitória!' : wid >= 0 ? `${w?.name ?? '—'} venceu` : 'Fim de jogo';
  el.overTitle.style.color = iWon ? 'var(--good)' : colorOf(w);
  el.overReason.textContent = reason ?? `por ${r}`;
  const frag = document.createDocumentFragment();
  world.sortedPlayers().forEach((p, k) => {
    const d = document.createElement('div');
    d.className = 'pl tiny';
    d.innerHTML = '';
    const dot = document.createElement('span');
    dot.style.cssText = `width:10px;height:10px;border-radius:3px;background:${colorOf(p)}`;
    const nm = document.createElement('span');
    nm.style.flex = '1';
    nm.textContent = `${k + 1}. ${p.name}${p.id === world.you ? ' (você)' : ''}`;
    const pc = document.createElement('span');
    pc.className = 'mut';
    pc.textContent = `${world.landTiles ? ((p.tiles / world.landTiles) * 100).toFixed(1) : '0.0'}% · ${fmtNum(p.troops)} tropas`;
    d.append(dot, nm, pc);
    frag.appendChild(d);
  });
  el.overStats.replaceChildren(frag);
  el.over.classList.remove('hidden');
  let left = POSTMATCH_SECONDS;
  el.overCount.textContent = String(left);
  const iv = window.setInterval(() => {
    left--;
    el.overCount.textContent = String(Math.max(0, left));
    if (left <= 0 || mode !== 'over') window.clearInterval(iv);
  }, 1000);
}

// ---------------------------------------------------------------- HUD
function buildBar(): void {
  const items = [
    { t: B.CITY, name: 'Cidade', cost: COSTS.city, key: '3', desc: '+teto de tropas, +ouro' },
    { t: B.OUTPOST, name: 'Posto', cost: COSTS.outpost, key: '4', desc: 'defesa ×1.4' },
    { t: B.PORT, name: 'Porto', cost: COSTS.port, key: '5', desc: 'ouro/s (precisa de costa)' },
    { t: B.SILO, name: 'Silo', cost: COSTS.silo, key: '6', desc: 'permite mísseis' },
    { t: -1, name: '☢ Míssil', cost: NUKE_COST, key: 'N', desc: 'requer silo' },
    { t: -2, name: '✖ Cancelar', cost: 0, key: 'Esc', desc: '' }
  ];
  const frag = document.createDocumentFragment();
  for (const it of items) {
    const b = document.createElement('div');
    b.className = 'bbtn';
    b.dataset.t = String(it.t);
    b.innerHTML = `<b>${it.name}</b><span>${it.cost ? `${it.cost} ouro` : it.desc || '&nbsp;'}</span><kbd>${it.key}</kbd>`;
    b.onclick = () => {
      if (it.t === -2) {
        buildType = 0;
        nukeMode = false;
      } else if (it.t === -1) {
        nukeMode = !nukeMode;
        buildType = 0;
        hint(nukeMode ? 'Modo míssil: clique no alvo (círculo = alcance do silo)' : 'Modo míssil desativado');
      } else {
        buildType = buildType === it.t ? 0 : it.t;
        nukeMode = false;
        hint(buildType ? `Clique num tile SEU para construir ${it.name} (${it.cost} ouro)` : '');
      }
      refreshBuildBar();
    };
    frag.appendChild(b);
  }
  el.buildbar.replaceChildren(frag);
  refreshBuildBar();
}

function refreshBuildBar(): void {
  const me = world.me();
  const gold = me ? me.gold : 0;
  for (const node of Array.from(el.buildbar.children)) {
    const b = node as HTMLElement;
    const t = Number(b.dataset.t);
    b.classList.toggle('on', (t >= 0 && t === buildType) || (t === -1 && nukeMode));
    const cost = t === B.CITY ? COSTS.city : t === B.OUTPOST ? COSTS.outpost : t === B.PORT ? COSTS.port : t === B.SILO ? COSTS.silo : t === -1 ? NUKE_COST : 0;
    b.classList.toggle('poor', cost > 0 && gold < cost);
  }
}

let lastHud = 0;
function updateHud(now: number): void {
  if (now - lastHud < 140) return;
  lastHud = now;
  const me = world.me();
  const sorted = world.sortedPlayers();
  const pos = me ? sorted.findIndex((p) => p.id === me.id) + 1 : 0;

  el.meName.textContent = me ? `${me.name}${world.spectator ? ' (espectador)' : ''}` : 'espectador';
  const c = colorOf(me);
  el.meDot.style.background = c;
  el.meDot.style.color = c;
  el.sGold.textContent = me ? fmtNum(me.gold) : '0';
  el.sTiles.textContent = world.landTiles && me ? `${((me.tiles / world.landTiles) * 100).toFixed(1)}%` : '0%';
  el.sTroops.textContent = me ? fmtNum(me.troops) : '0';
  el.sTime.textContent = fmtTime(world.time);
  el.sPos.textContent = pos ? `${pos}º/${sorted.length}` : '—';
  el.sd.classList.toggle('hidden', world.time < SUDDEN_DEATH_AT || mode !== 'playing');

  // placar
  const frag = document.createDocumentFragment();
  for (const p of sorted.slice(0, 12)) {
    const row = document.createElement('div');
    row.className = 'rk' + (p.id === world.you ? ' me' : '') + (p.alive ? '' : ' dead');
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = colorOf(p);
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = `${p.bot ? '🤖 ' : ''}${p.name}`;
    const pc = document.createElement('span');
    pc.className = 'pc';
    const pct = world.landTiles ? (p.tiles / world.landTiles) * 100 : 0;
    pc.textContent = `${pct.toFixed(1)}%`;
    const bar = document.createElement('span');
    bar.className = 'bar';
    const fill = document.createElement('i');
    fill.style.width = `${Math.min(100, (pct / (WIN_CONTROL * 100)) * 100).toFixed(1)}%`;
    fill.style.background = colorOf(p);
    bar.append(fill);
    row.append(dot, nm, pc, bar);
    frag.appendChild(row);
  }
  el.rankList.replaceChildren(frag);

  refreshBuildBar();
  updateSelInfo();
}

function updateSelInfo(): void {
  const i = hover >= 0 ? hover : selected;
  if (i < 0 || mode !== 'playing') {
    el.selinfo.classList.add('hidden');
    return;
  }
  const ter = world.terrain[i];
  if (ter === T.WATER) {
    el.selinfo.classList.add('hidden');
    return;
  }
  const own = world.owner[i];
  const p = own >= 0 ? world.playerById(own) : undefined;
  const def = world.bld[i];
  const rows: string[] = [];
  rows.push(`<b style="color:${p ? colorOf(p) : '#c9d6e4'}">${p ? p.name : 'Território neutro'}</b>`);
  rows.push(`Terreno: ${ter === T.MOUNTAIN ? '⛰ montanha' : '🌱 planície'} · tropas: <b>${fmtNum(world.troops[i])}</b>`);
  if (def !== B.NONE) rows.push(`Construção: ${['', 'Cidade', 'Posto Defensivo', 'Porto', 'Silo de Mísseis'][def]}`);
  if (own === world.you) rows.push('<span class="mut tiny">seu tile — clique num alvo para atacar</span>');
  else if (selected >= 0) rows.push('<span class="mut tiny">clique para atacar a partir do tile selecionado</span>');
  el.selinfo.innerHTML = rows.join('<br />');
  el.selinfo.classList.remove('hidden');
}

// ---------------------------------------------------------------- camera
function centerOnMe(zoom?: number): void {
  const t = world.you >= 0 ? world.myStrongestTile(world.you) : -1;
  if (zoom) cam.zoom = zoom;
  if (t >= 0) {
    cam.x = ((t % world.w) + 0.5) * cam.zoom;
    cam.y = (Math.floor(t / world.w) + 0.5) * cam.zoom;
  } else {
    cam.x = (world.w * cam.zoom) / 2;
    cam.y = (world.h * cam.zoom) / 2;
  }
  renderer.clampCamera(cam, world);
}

function updateCamera(dt: number): void {
  const speed = 620 * dt * (cam.zoom / 11);
  let dx = 0;
  let dy = 0;
  if (keys.has('a') || keys.has('arrowleft')) dx -= speed;
  if (keys.has('d') || keys.has('arrowright')) dx += speed;
  if (keys.has('w') || keys.has('arrowup')) dy -= speed;
  if (keys.has('s') || keys.has('arrowdown')) dy += speed;
  if (keys.has('q')) zoomAt(1 - 1.6 * dt, renderer.vw / 2, renderer.vh / 2);
  if (keys.has('e')) zoomAt(1 + 1.6 * dt, renderer.vw / 2, renderer.vh / 2);
  if (dx || dy) {
    cam.x += dx;
    cam.y += dy;
    renderer.clampCamera(cam, world);
  }
}

function zoomAt(factor: number, px: number, py: number): void {
  const oldZoom = cam.zoom;
  const z = Math.max(3.4, Math.min(46, oldZoom * factor));
  if (z === oldZoom) return;
  const wx = (px - renderer.vw / 2) / oldZoom + cam.x / oldZoom;
  const wy = (py - renderer.vh / 2) / oldZoom + cam.y / oldZoom;
  cam.zoom = z;
  cam.x = (wx - (px - renderer.vw / 2) / z) * z;
  cam.y = (wy - (py - renderer.vh / 2) / z) * z;
  renderer.clampCamera(cam, world);
}

// ---------------------------------------------------------------- comandos
function canCommand(): boolean {
  return mode === 'playing' && !world.spectator && world.you >= 0 && world.state === 'playing';
}

function myBestAdjacent(target: number): number {
  let best = -1;
  let bestT = -1;
  for (const nb of world.neighbors(target)) {
    if (world.owner[nb] !== world.you) continue;
    if (world.troops[nb] > bestT) {
      bestT = world.troops[nb];
      best = nb;
    }
  }
  return best;
}

function tryAttack(target: number): void {
  if (!canCommand() || target < 0) return;
  if (world.terrain[target] === T.WATER) {
    hint('Não é possível atacar o mar (ainda sem marinha).');
    return;
  }
  if (selected < 0 || world.owner[selected] !== world.you) {
    const adj = myBestAdjacent(target);
    if (adj >= 0) selected = adj;
  }
  if (selected < 0) {
    hint('Selecione primeiro um tile seu com tropas.');
    return;
  }
  if (world.owner[target] === world.you) {
    // transferencia
    const p = world.findPath(selected, target, world.you);
    if (p) send({ t: 'cmd', c: 'attack', path: p, ratio: 1 });
    else hint('Sem caminho pelo seu território.');
    selected = target;
    return;
  }
  const p = world.findPath(selected, target, world.you);
  if (!p) {
    hint('Esse alvo não faz fronteira com o seu território.');
    path = null;
    return;
  }
  path = p;
  send({ t: 'cmd', c: 'attack', path: p, ratio });
  const last = p[p.length - 1];
  window.setTimeout(() => {
    if (world.owner[last] === world.you) selected = last;
    path = null;
  }, 130);
}

function tryBuild(tile: number): void {
  if (!canCommand() || tile < 0) return;
  if (world.owner[tile] !== world.you) {
    hint('Só dá para construir em território seu.');
    return;
  }
  if (world.bld[tile] !== B.NONE) {
    hint('Este tile já tem uma construção.');
    return;
  }
  if (buildType === B.PORT && !world.isCoastal(tile)) {
    hint('Portos precisam ficar ao lado do mar.');
    return;
  }
  send({ t: 'cmd', c: 'build', tile, type: buildType });
}

function tryNuke(tile: number): void {
  if (!canCommand() || tile < 0) return;
  const silos = world.mySiloTiles(world.you);
  if (!silos.length) {
    hint('Você precisa de um Silo de Mísseis.');
    nukeMode = false;
    return;
  }
  let best = -1;
  let bestD = Infinity;
  for (const s of silos) {
    const d = Math.hypot((s % world.w) - (tile % world.w), Math.floor(s / world.w) - Math.floor(tile / world.w));
    if (d <= NUKE_RANGE && d < bestD) {
      bestD = d;
      best = s;
    }
  }
  if (best < 0) {
    hint('Alvo fora do alcance dos seus silos.');
    return;
  }
  send({ t: 'cmd', c: 'nuke', from: best, to: tile });
  hint(`Míssil lançado (${NUKE_COST} ouro)`);
}

// ---------------------------------------------------------------- input
let panning = false;
let dragAttack = false;
let dragCandidate = false;
let lastPx = 0;
let lastPy = 0;
let downTile = -1;
let downTime = 0;
let moved = 0;

function setupInput(): void {
  const c = renderer.canvas;

  c.addEventListener('contextmenu', (e) => e.preventDefault());

  c.addEventListener('pointerdown', (e) => {
    c.setPointerCapture(e.pointerId);
    const rect = c.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    lastPx = px;
    lastPy = py;
    moved = 0;
    downTime = performance.now();
    const tile = renderer.screenToTile(px, py, cam, world);
    downTile = tile;
    lastHover = -2;
    if (mode !== 'playing') return;
    const mine = tile >= 0 && world.owner[tile] === world.you && world.terrain[tile] !== T.WATER;
    if (e.button === 0 && mine && !buildType && !nukeMode && canCommand()) {
      dragCandidate = true; // vira arrasto de ataque so se o ponteiro se mover
    } else {
      panning = true;
    }
  });

  c.addEventListener('pointermove', (e) => {
    const rect = c.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    hover = renderer.screenToTile(px, py, cam, world);
    const dx = px - lastPx;
    const dy = py - lastPy;
    moved += Math.abs(dx) + Math.abs(dy);

    if (panning) {
      cam.x -= dx;
      cam.y -= dy;
      renderer.clampCamera(cam, world);
    } else {
      if (dragCandidate && !dragAttack && moved > 7) {
        dragAttack = true;
        if (selected < 0 || world.owner[selected] !== world.you) selected = downTile;
      }
    }
    if (dragAttack && canCommand()) {
      const now = performance.now();
      if (hover >= 0 && hover !== lastHover && now - lastDragAttack > 110) {
        lastHover = hover;
        lastDragAttack = now;
        if (world.owner[hover] === world.you) {
          selected = hover;
        } else if (world.terrain[hover] !== T.WATER) {
          const src = selected >= 0 && world.isAdjacent(selected, hover) ? selected : myBestAdjacent(hover);
          if (src >= 0) {
            const p = world.isAdjacent(src, hover) ? [src, hover] : world.findPath(src, hover, world.you);
            if (p) {
              send({ t: 'cmd', c: 'attack', path: p, ratio });
              path = p;
            }
          }
        }
      }
    }
    lastPx = px;
    lastPy = py;
    if (path && !dragAttack) path = null;
  });

  const endPointer = (e: PointerEvent) => {
    const wasPanning = panning;
    const wasDrag = dragAttack;
    panning = false;
    dragAttack = false;
    dragCandidate = false;
    path = null;
    if (mode !== 'playing') return;
    const tapped = moved < 9 && performance.now() - downTime < 520;
    if (!tapped) return;
    const rect = renderer.canvas.getBoundingClientRect();
    const tile = renderer.screenToTile(e.clientX - rect.left, e.clientY - rect.top, cam, world);
    if (tile < 0) return;
    if (e.button === 2 || wasPanning && world.terrain[tile] === T.WATER) return;

    if (nukeMode) {
      tryNuke(tile);
      return;
    }
    if (buildType !== B.NONE) {
      tryBuild(tile);
      return;
    }
    if (world.terrain[tile] === T.WATER) {
      hint('Oceano: por enquanto a guerra é só terrestre.');
      return;
    }
    const ownHere = world.owner[tile];
    if (ownHere === world.you) {
      // com uma origem selecionada, clicar em outro tile seu = transferencia
      if (selected >= 0 && selected !== tile && world.owner[selected] === world.you) {
        const p = world.findPath(selected, tile, world.you);
        if (p) send({ t: 'cmd', c: 'attack', path: p, ratio: 1 });
        else hint('Sem caminho pelo seu território.');
        selected = tile;
        return;
      }
      selected = selected === tile ? -1 : tile;
      return;
    }
    if (ownHere === -1) {
      // ordem de expansao: espalha ate encostar em outro jogador
      send({ t: 'cmd', c: 'expand', tile });
      selected = -1;
      hint('🚩 Ordem de expansão: suas tropas fluem para lá e se espalham até fazerem fronteira.');
      return;
    }
    // tile inimigo: ataca se houver fronteira (ou se houver selecao propria)
    if (selected >= 0 && world.owner[selected] === world.you) {
      tryAttack(tile);
      return;
    }
    const adj = myBestAdjacent(tile);
    if (adj >= 0) {
      selected = adj;
      tryAttack(tile);
    } else {
      hint('Sem fronteira aí. Clique num tile vazio para expandir até ele.');
    }
  };
  c.addEventListener('pointerup', endPointer);
  c.addEventListener('pointercancel', () => {
    panning = false;
    dragAttack = false;
  });

  c.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = c.getBoundingClientRect();
    zoomAt(e.deltaY < 0 ? 1.14 : 1 / 1.14, e.clientX - rect.left, e.clientY - rect.top);
  }, { passive: false });

  // minimapa
  const mini = renderer.mini;
  const miniJump = (e: PointerEvent) => {
    const t = renderer.miniToTile(e.clientX, e.clientY, world);
    if (t < 0) return;
    cam.x = ((t % world.w) + 0.5) * cam.zoom;
    cam.y = (Math.floor(t / world.w) + 0.5) * cam.zoom;
    renderer.clampCamera(cam, world);
  };
  let miniDown = false;
  mini.addEventListener('pointerdown', (e) => {
    miniDown = true;
    mini.setPointerCapture(e.pointerId);
    miniJump(e);
  });
  mini.addEventListener('pointermove', (e) => {
    if (miniDown) miniJump(e);
  });
  mini.addEventListener('pointerup', () => (miniDown = false));

  window.addEventListener('keydown', (e) => {
    if (document.activeElement === el.chatInput) {
      if (e.key === 'Enter') {
        const text = el.chatInput.value.trim();
        if (text) send({ t: 'chat', text });
        el.chatInput.value = '';
        el.chatInput.blur();
      } else if (e.key === 'Escape') el.chatInput.blur();
      return;
    }
    const k = e.key.toLowerCase();
    if (['w', 'a', 's', 'd', 'q', 'e', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(k)) e.preventDefault();
    keys.add(k);
    if (k === 'c') centerOnMe();
    else if (k === ' ') {
      showNumbers = !showNumbers;
      hint(showNumbers ? 'Números de tropas ativados' : 'Números de tropas ocultos', 1200);
    } else if (k === '1') setRatio(ratio - 0.1);
    else if (k === '2') setRatio(ratio + 0.1);
    else if (k === '3') pickBuild(B.CITY);
    else if (k === '4') pickBuild(B.OUTPOST);
    else if (k === '5') pickBuild(B.PORT);
    else if (k === '6') pickBuild(B.SILO);
    else if (k === 'n') pickBuild(-1);
    else if (k === 'escape') {
      buildType = 0;
      nukeMode = false;
      selected = -1;
      if (canCommand()) send({ t: 'cmd', c: 'expand', tile: -1 });
      refreshBuildBar();
    } else if (k === 'enter') el.chatInput.focus();
  });
  window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
  window.addEventListener('blur', () => keys.clear());
  window.addEventListener('resize', () => renderer.resize());

  el.ratioRange.addEventListener('input', () => setRatio(Number(el.ratioRange.value) / 100));
  el.chatSend.onclick = () => {
    const text = el.chatInput.value.trim();
    if (text) send({ t: 'chat', text });
    el.chatInput.value = '';
  };
}

function setRatio(v: number): void {
  ratio = Math.max(0.1, Math.min(1, Math.round(v * 20) / 20));
  el.ratioRange.value = String(Math.round(ratio * 100));
  el.ratioVal.textContent = `${Math.round(ratio * 100)}%`;
}

function pickBuild(t: number): void {
  if (t === -1) {
    nukeMode = !nukeMode;
    buildType = 0;
    hint(nukeMode ? 'Modo míssil: clique no alvo' : 'Modo míssil desativado', 1600);
  } else {
    buildType = buildType === t ? 0 : t;
    nukeMode = false;
    const names: Record<number, string> = { 1: 'Cidade', 2: 'Posto Defensivo', 3: 'Porto', 4: 'Silo de Mísseis' };
    hint(buildType ? `Construir ${names[buildType]} — clique num tile seu` : '', 1600);
  }
  refreshBuildBar();
}

// ---------------------------------------------------------------- offline
function startOffline(): void {
  const g = new Game({ totalPlayers: DEFAULT_TOTAL_PLAYERS, difficulty: 1 });
  g.addPlayer({ name: playerName(), bot: false });
  g.startMatch();
  localGame = g;
  world.rules = { winControl: WIN_CONTROL, nukeCost: NUKE_COST, costs: COSTS };
  world.loadMap(g.w, g.h, bytesToB64(g.terrain), g.fullState(), g.snapshotPlayers(), 0);
  world.spectator = false;
  room = null;
  logLines.length = 0;
  explosions = [];
  overShown = false;
  selected = -1;
  buildType = 0;
  nukeMode = false;
  regions = [];
  mode = 'playing';
  el.menu.classList.add('hidden');
  el.lobby.classList.add('hidden');
  el.over.classList.add('hidden');
  el.hud.classList.remove('hidden');
  setConn('offline (local)', '');
  centerOnMe(13);
  buildBar();
  pushEvent({ text: 'Partida local iniciada — simulação rodando no seu navegador.', kind: 'info' });
}

function localCommand(msg: C2S): void {
  const g = localGame;
  if (!g || g.state !== 'playing') return;
  if (msg.t === 'cmd') {
    if (msg.c === 'attack') g.attackChain(0, msg.path, msg.ratio);
    else if (msg.c === 'build') g.build(0, msg.tile, msg.type);
    else if (msg.c === 'nuke') g.nuke(0, msg.from, msg.to);
    else if (msg.c === 'expand') g.setExpand(0, msg.tile);
  }
}

// ---------------------------------------------------------------- loop
let last = performance.now();
let acc = 0;
function frame(now: number): void {
  const dt = Math.min(0.12, (now - last) / 1000);
  last = now;
  updateCamera(dt);

  if (localGame) {
    acc += dt;
    let steps = 0;
    while (acc >= 1 / TICK_HZ && steps < 6) {
      localGame.tick(1 / TICK_HZ);
      acc -= 1 / TICK_HZ;
      steps++;
    }
    const ch: Change[] = localGame.collectChanges(4000);
    if (ch.length) world.apply(ch);
    world.players = localGame.snapshotPlayers();
    world.time = localGame.time;
    world.state = localGame.state;
    for (const e of localGame.drainEvents()) onEvent(e);
    if (localGame.state === 'over' && !overShown) showOver(localGame.winner, localGame.winReason);
  }

  if (now - lastRegions > 200 && world.n) {
    lastRegions = now;
    regions = world.computeRegions();
  }

  if (hintTimer && now > hintTimer) {
    hintTimer = 0;
    el.hint.classList.add('hidden');
  }
  if (explosions.length) explosions = explosions.filter((e) => now - e.t < 1500);

  const expandTargets: ExpandMarker[] = world.players
    .filter((p) => p.alive && !p.removed && p.expandTarget >= 0)
    .map((p) => ({ tile: p.expandTarget, hue: p.hue, me: p.id === world.you }));

  renderer.draw({
    world, cam, selected, hover, path, buildType, nukeMode, showNumbers,
    explosions, now, validBuild: isValidBuildSpot(hover), regions, expandTargets
  });
  if (mode === 'playing' || mode === 'over') updateHud(now);
  requestAnimationFrame(frame);
}

function isValidBuildSpot(tile: number): boolean {
  if (tile < 0 || buildType === B.NONE) return false;
  if (world.owner[tile] !== world.you) return false;
  if (world.bld[tile] !== B.NONE) return false;
  if (world.terrain[tile] === T.WATER) return false;
  if (buildType === B.PORT && !world.isCoastal(tile)) return false;
  const me = world.me();
  const cost = buildType === B.CITY ? COSTS.city : buildType === B.OUTPOST ? COSTS.outpost : buildType === B.PORT ? COSTS.port : COSTS.silo;
  return !!me && me.gold >= cost;
}

// ---------------------------------------------------------------- boot
function bindMenu(): void {
  $('btnRefresh').onclick = () => send({ t: 'rooms' });
  $('btnQuick').onclick = () => {
    send({ t: 'hello', name: playerName() });
    send({ t: 'rooms' });
    // entra na primeira sala publica livre
    fetch('/api/rooms')
      .then((r) => r.json())
      .then((rooms: RoomInfo[]) => {
        const free = rooms.find((r) => r.state === 'waiting' && r.humans < r.maxHumans) || rooms[0];
        if (free) send({ t: 'join', room: free.id, name: playerName() });
        else hint('Nenhuma sala disponível — crie uma.', 3000);
      })
      .catch(() => hint('Falha ao listar salas.', 3000));
  };
  $('btnJoinCode').onclick = () => {
    const code = el.codeInput.value.trim().toUpperCase();
    if (!code) return;
    send({ t: 'hello', name: playerName() });
    send({ t: 'join', room: code, name: playerName() });
  };
  $('btnCreate').onclick = () => {
    send({ t: 'hello', name: playerName() });
    send({
      t: 'create',
      name: playerName(),
      opts: {
        totalPlayers: Number(($('optTotal') as HTMLSelectElement).value),
        difficulty: Number(($('optDiff') as HTMLSelectElement).value),
        maxHumans: Number(($('optMax') as HTMLInputElement).value),
        isPublic: false,
        name: `${playerName()}`
      }
    });
  };
  $('btnOffline').onclick = () => startOffline();
  el.btnStart.onclick = () => send({ t: 'start' });
  $('btnLeave').onclick = () => {
    send({ t: 'leave' });
    mode = 'menu';
    el.lobby.classList.add('hidden');
    el.menu.classList.remove('hidden');
    send({ t: 'rooms' });
  };
  $('btnBackMenu').onclick = () => {
    send({ t: 'leave' });
    mode = 'menu';
    overShown = false;
    el.over.classList.add('hidden');
    el.hud.classList.add('hidden');
    el.menu.classList.remove('hidden');
    localGame = null;
    send({ t: 'rooms' });
  };
  el.nameInput.addEventListener('input', () => localStorage.setItem('ldf:name', el.nameInput.value));
}

// hook de depuracao/testes (inofensivo em producao)
(window as unknown as Record<string, unknown>).__ldf = {
  world, cam,
  get mode() { return mode; },
  get selected() { return selected; },
  get hover() { return hover; },
  get renderer() { return renderer; },
  tilesOnScreen: () => {
    const z = cam.zoom;
    return { w: Math.round(renderer.vw / z), h: Math.round(renderer.vh / z), z, vw: renderer.vw, vh: renderer.vh };
  },
  tileToScreen: (i: number) => {
    const x = i % world.w;
    const y = Math.floor(i / world.w);
    return { x: renderer.vw / 2 - cam.x + (x + 0.5) * cam.zoom, y: renderer.vh / 2 - cam.y + (y + 0.5) * cam.zoom };
  },
  myTiles: () => {
    const out: number[] = [];
    for (let i = 0; i < world.n; i++) if (world.owner[i] === world.you) out.push(i);
    return out;
  },
  bestAttackPair: () => {
    let best: { from: number; to: number } | null = null;
    let bestScore = -1;
    for (let i = 0; i < world.n; i++) {
      if (world.owner[i] !== world.you || world.terrain[i] === 0) continue;
      const mine = world.troops[i];
      if (mine < 12) continue;
      for (const nb of world.neighbors(i)) {
        if (world.terrain[nb] === 0 || world.owner[nb] !== -1) continue;
        const score = mine - world.troops[nb] * 2;
        if (score > bestScore) {
          bestScore = score;
          best = { from: i, to: nb };
        }
      }
    }
    return best;
  },
  neutralAdjacent: () => {
    for (let i = 0; i < world.n; i++) {
      if (world.owner[i] !== world.you || world.terrain[i] === 0) continue;
      for (const nb of world.neighbors(i)) {
        if (world.terrain[nb] === 0) continue;
        if (world.owner[nb] === -1) return { from: i, to: nb };
      }
    }
    return null;
  },
  state: () => ({ mode, zoom: cam.zoom, camx: cam.x, camy: cam.y, you: world.you, state: world.state }),
  regionInfo: () => regions.map((r) => ({ owner: r.owner, tiles: r.tiles, troops: Math.round(r.troops), label: r.label })),
  dbgExpand: () =>
    localGame
      ? { tgt: localGame.players[0]?.expandTarget, tiles: localGame.players[0]?.tiles, state: localGame.state, you: world.you, wState: world.state }
      : null,
  centerOnTile: (i: number, zoom?: number) => {
    if (zoom) cam.zoom = zoom;
    cam.x = ((i % world.w) + 0.5) * cam.zoom;
    cam.y = (Math.floor(i / world.w) + 0.5) * cam.zoom;
    renderer.clampCamera(cam, world);
  },
  /** tile neutro a uma distancia minima do territorio do jogador */
  farNeutral: (minDist = 8) => {
    const mine: number[] = [];
    for (let i = 0; i < world.n; i++) if (world.owner[i] === world.you) mine.push(i);
    if (!mine.length) return -1;
    let best = -1;
    let bestScore = -1;
    for (let i = 0; i < world.n; i++) {
      if (world.owner[i] !== -1 || world.terrain[i] === 0) continue;
      const x = i % world.w;
      const y = Math.floor(i / world.w);
      let dMin = Infinity;
      for (const m of mine) {
        const d = Math.abs((m % world.w) - x) + Math.abs(Math.floor(m / world.w) - y);
        if (d < dMin) dMin = d;
      }
      if (dMin >= minDist && dMin > bestScore) {
        bestScore = dMin;
        best = i;
      }
    }
    return best;
  }
};

function boot(): void {
  renderer = new Renderer($('game') as HTMLCanvasElement, $('minimap') as HTMLCanvasElement);
  bindMenu();
  setupInput();
  setRatio(0.7);
  connect();
  window.setInterval(() => {
    if (wsOk) send({ t: 'rooms' });
  }, 8000);
  requestAnimationFrame(frame);
}

boot();
