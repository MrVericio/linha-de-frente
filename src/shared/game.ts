import {
  T, B, MAP_W, MAP_H, TICK_HZ, WIN_CONTROL,
  TILE_MAX_TROOPS, MOUNTAIN_MAX_TROOPS, CITY_MAX_TROOPS, OUTPOST_MAX_TROOPS,
  PORT_MAX_TROOPS, SILO_MAX_TROOPS,
  GROWTH_RATE, FLAT_GROWTH, MIN_ATTACK_TROOPS, TRANSFER_RESERVE,
  DEF_OUTPOST, DEF_MOUNTAIN, DEF_CITY,
  GOLD_START, GOLD_PORT_PER_SEC, GOLD_CITY_PER_SEC, GOLD_TILE_PER_SEC, GOLD_BASE_PER_SEC, COSTS,
  NUKE_COST, NUKE_COOLDOWN, NUKE_RANGE, NUKE_R_CORE, NUKE_R_OUTER,
  SUDDEN_DEATH_AT, SUDDEN_DEATH_DECAY,
  DEFAULT_TOTAL_PLAYERS, PLAYER_HUES, NAMES_BOT,
  type PlayerSnapshot, type GameEvent, type Change
} from './constants.js';
import { generateMap, mulberry32 } from './mapgen.js';
import { botThink, resetBotMemory } from './bot.js';
import { quantizeTroops } from './codec.js';

export interface PlayerDef {
  name: string;
  bot: boolean;
  diff?: number;
  hue?: number;
}

const NB4 = [-1, 1, 0, 0]; // dx
const NB4Y = [0, 0, -1, 1]; // dy

/**
 * Simulacao autoritativa da partida.
 * Roda no servidor (uma instancia por sala) e tambem no navegador
 * para o modo offline contra bots.
 */
export class Game {
  w = MAP_W;
  h = MAP_H;
  terrain: Uint8Array = new Uint8Array(0);
  owner = new Int16Array(0);
  troops = new Float32Array(0);
  bld = new Uint8Array(0);

  players: PlayerSnapshot[] = [];
  state: 'waiting' | 'playing' | 'over' = 'waiting';
  time = 0;
  winner = -1;
  winReason = '';
  seed = 0;
  landTiles = 0;
  totalPlayers: number;
  difficulty: number;

  // ultimo estado enviado ao cliente (para calcular diffs)
  private sentOwner = new Int16Array(0);
  private sentTroops = new Int32Array(0);
  private sentBld = new Uint8Array(0);
  private events: GameEvent[] = [];
  private rnd: () => number = Math.random;
  private botTimers: number[] = [];
  private sdAnnounced = false;
  n = 0;

  constructor(opts: { seed?: number; totalPlayers?: number; difficulty?: number } = {}) {
    this.totalPlayers = opts.totalPlayers ?? DEFAULT_TOTAL_PLAYERS;
    this.difficulty = opts.difficulty ?? 1;
    this.seed = opts.seed ?? (Math.random() * 1e9) >>> 0;
    this.rnd = mulberry32(this.seed ^ 0x9e3779b9);
  }

  // ==========================================================
  //  Lobby / ciclo de vida
  // ==========================================================
  addPlayer(def: PlayerDef): number {
    // reaproveita slots liberados para manter os ids estaveis
    const free = this.players.findIndex((p) => p.removed);
    const id = free >= 0 ? free : this.players.length;
    const hue = def.hue ?? PLAYER_HUES[id % PLAYER_HUES.length];
    const p: PlayerSnapshot = {
      id,
      name: def.name || (def.bot ? 'Bot' : 'Jogador'),
      hue,
      bot: !!def.bot,
      diff: def.diff ?? this.difficulty,
      gold: GOLD_START,
      alive: true,
      tiles: 0,
      troops: 0,
      buildings: 0,
      cities: 0,
      ports: 0,
      outposts: 0,
      silos: 0,
      nukeCd: 0,
      removed: false
    };
    if (free >= 0) this.players[id] = p;
    else this.players.push(p);
    this.botTimers[id] = this.rnd() * 1.2;
    return id;
  }

  /** Jogadores ativos (sem slots liberados). */
  activePlayers(): PlayerSnapshot[] {
    return this.players.filter((p) => !p.removed);
  }

  removePlayer(id: number): void {
    const p = this.players[id];
    if (!p || p.bot) return;
    if (this.state === 'playing') {
      // remove o territorio dele do mapa
      for (let i = 0; i < this.n; i++) {
        if (this.owner[i] === id) this.setOwner(i, -1, true);
      }
      p.alive = false;
      p.tiles = 0;
      p.troops = 0;
      p.buildings = 0;
    }
    p.removed = true;
    p.spectator = false;
  }

  /** Preenche com bots e comeca a partida. */
  startMatch(seed?: number): void {
    if (seed !== undefined) this.seed = seed >>> 0;
    this.rnd = mulberry32(this.seed ^ 0x9e3779b9);

    // compacta: descarta slots liberados antes de comecar
    this.players = this.players.filter((p) => !p.removed);
    this.players.forEach((p, i) => (p.id = i));
    this.botTimers = this.players.map(() => this.rnd() * 1.2);

    const humans = this.players.filter((p) => !p.bot).length || 1;
    const wantTotal = Math.max(humans + 1, Math.min(this.totalPlayers, 20));
    while (this.players.length < wantTotal) {
      const i = this.players.length;
      this.addPlayer({
        name: NAMES_BOT[i % NAMES_BOT.length],
        bot: true,
        diff: this.difficulty
      });
    }

    resetBotMemory();
    const map = generateMap(this.players.length, this.seed, this.w, this.h);
    this.terrain = map.terrain;
    this.landTiles = map.landTiles;
    this.n = this.w * this.h;
    this.owner = new Int16Array(this.n).fill(-1);
    this.troops = new Float32Array(this.n);
    this.bld = new Uint8Array(this.n);

    this.sentOwner = new Int16Array(this.n).fill(-2);
    this.sentTroops = new Int32Array(this.n).fill(-1);
    this.sentBld = new Uint8Array(this.n).fill(255);

    // territorio neutro com guarnicoes
    for (let i = 0; i < this.n; i++) {
      if (this.terrain[i] === T.WATER) continue;
      const base = this.terrain[i] === T.MOUNTAIN ? 6 : 12;
      this.troops[i] = base + this.rnd() * 14;
    }

    // spawn dos jogadores
    this.players.forEach((p) => {
      p.gold = GOLD_START;
      p.alive = true;
      p.tiles = 0;
      p.troops = 0;
      p.buildings = 0;
      p.nukeCd = 0;
    });

    const spawns = map.spawns;
    this.players.forEach((p, k) => {
      const s = spawns[k % spawns.length];
      if (s === undefined) return;
      const sx = s % this.w;
      const sy = Math.floor(s / this.w);
      // pequeno territorio inicial
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = sx + dx;
          const y = sy + dy;
          if (x < 0 || y < 0 || x >= this.w || y >= this.h) continue;
          const i = y * this.w + x;
          if (this.terrain[i] === T.WATER) continue;
          this.setOwner(i, p.id, true);
          this.troops[i] = i === s ? 90 : 35;
        }
      }
      this.bld[s] = B.CITY;
      this.troops[s] = 240;
    });

    this.recountAll();
    this.time = 0;
    this.winner = -1;
    this.winReason = '';
    this.state = 'playing';
    this.sdAnnounced = false;
    this.pushEvent(`Partida iniciada — ${this.players.length} impérios, mapa ${this.w}×${this.h}`, 'info');
  }

  resetToLobby(): void {
    this.state = 'waiting';
    this.players = [];
    this.botTimers = [];
    this.events = [];
    this.winner = -1;
    this.winReason = '';
    this.time = 0;
  }

  // ==========================================================
  //  Utilidades de mapa
  // ==========================================================
  idx(x: number, y: number): number {
    return y * this.w + x;
  }
  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.w && y < this.h;
  }
  valid(i: number): boolean {
    return i >= 0 && i < this.n;
  }
  x(i: number): number {
    return i % this.w;
  }
  y(i: number): number {
    return Math.floor(i / this.w);
  }
  neighbors(i: number): number[] {
    const x = i % this.w;
    const y = Math.floor(i / this.w);
    const out: number[] = [];
    for (let k = 0; k < 4; k++) {
      const nx = x + NB4[k];
      const ny = y + NB4Y[k];
      if (nx < 0 || ny < 0 || nx >= this.w || ny >= this.h) continue;
      out.push(ny * this.w + nx);
    }
    return out;
  }
  isWater(i: number): boolean {
    return this.terrain[i] === T.WATER;
  }

  maxTroops(i: number): number {
    const b = this.bld[i];
    let cap: number;
    if (b === B.CITY) cap = CITY_MAX_TROOPS;
    else if (b === B.OUTPOST) cap = OUTPOST_MAX_TROOPS;
    else if (b === B.PORT) cap = PORT_MAX_TROOPS;
    else if (b === B.SILO) cap = SILO_MAX_TROOPS;
    else cap = this.terrain[i] === T.MOUNTAIN ? MOUNTAIN_MAX_TROOPS : TILE_MAX_TROOPS;
    // na morte subita os exercitos encolhem progressivamente:
    // ninguem consegue segurar o mapa inteiro e a partida sempre termina
    if (this.time < SUDDEN_DEATH_AT) return cap;
    const f = Math.max(0.25, 0.6 - (this.time - SUDDEN_DEATH_AT) / 900);
    return cap * f;
  }

  /** Morte subita ativa? (a partir de SUDDEN_DEATH_AT segundos) */
  get suddenDeath(): boolean {
    return this.time >= SUDDEN_DEATH_AT;
  }

  defenseMult(i: number, ownerId: number): number {
    if (this.suddenDeath && ownerId >= 0) {
      // na morte subita as fortificacoes perdem efeito: o jogo precisa terminar
      return this.terrain[i] === T.MOUNTAIN ? 1.1 : 1;
    }
    let m = 1;
    if (this.terrain[i] === T.MOUNTAIN) m *= DEF_MOUNTAIN;
    if (ownerId >= 0) {
      if (this.bld[i] === B.OUTPOST) m *= DEF_OUTPOST;
      else if (this.bld[i] === B.CITY) m *= DEF_CITY;
    }
    return m;
  }

  /** Porto exige tile proprio terrestre adjacente a agua. */
  isCoastal(i: number): boolean {
    const x = i % this.w;
    const y = Math.floor(i / this.w);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= this.w || ny >= this.h) continue;
        if (this.terrain[ny * this.w + nx] === T.WATER) return true;
      }
    }
    return false;
  }

  private adjBld(pid: number, type: number, delta: number): void {
    const p = this.players[pid];
    if (!p || pid < 0 || type === B.NONE) return;
    if (type === B.CITY) p.cities = Math.max(0, p.cities + delta);
    else if (type === B.PORT) p.ports = Math.max(0, p.ports + delta);
    else if (type === B.OUTPOST) p.outposts = Math.max(0, p.outposts + delta);
    else if (type === B.SILO) p.silos = Math.max(0, p.silos + delta);
    p.buildings = p.cities + p.ports + p.outposts + p.silos;
  }

  private setOwner(i: number, newOwner: number, silent = false): void {
    const prev = this.owner[i];
    if (prev === newOwner) return;
    if (prev >= 0 && this.players[prev] && !this.players[prev].removed) this.players[prev].tiles--;
    if (newOwner >= 0 && this.players[newOwner]) this.players[newOwner].tiles++;
    const b = this.bld[i];
    if (b !== B.NONE) {
      if (prev >= 0) this.adjBld(prev, b, -1);
      if (newOwner >= 0) this.adjBld(newOwner, b, +1);
    }
    this.owner[i] = newOwner;
    if (!silent) {
      if (prev >= 0) this.checkElimination(prev);
    }
  }

  private recountAll(): void {
    for (const p of this.players) {
      p.tiles = 0;
      p.troops = 0;
      p.buildings = 0;
      p.cities = 0;
      p.ports = 0;
      p.outposts = 0;
      p.silos = 0;
    }
    for (let i = 0; i < this.n; i++) {
      const o = this.owner[i];
      if (o >= 0 && this.players[o]) {
        this.players[o].tiles++;
        this.players[o].troops += this.troops[i];
        this.adjBld(o, this.bld[i], +1);
      }
    }
  }

  pushEvent(text: string, kind: GameEvent['kind'], hue?: number, i?: number): void {
    this.events.push({ text, kind, hue, i });
    if (this.events.length > 120) this.events.splice(0, this.events.length - 120);
  }

  drainEvents(): GameEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  // ==========================================================
  //  Tick
  // ==========================================================
  tick(dt: number): void {
    if (this.state !== 'playing') return;
    this.time += dt;

    // crescimento das tropas + ouro
    const players = this.players;
    for (let i = 0; i < this.n; i++) {
      const o = this.owner[i];
      if (o < 0) continue;
      if (this.terrain[i] === T.WATER) continue;
      const cap = this.maxTroops(i);
      const cur = this.troops[i];
      if (cur > cap) {
        // excedente evapora (morte subita)
        this.troops[i] = Math.max(cap, cur - cur * SUDDEN_DEATH_DECAY * 4 * dt);
      } else if (cur < cap) {
        const g = (cur * GROWTH_RATE + FLAT_GROWTH) * dt;
        this.troops[i] = Math.min(cap, cur + g);
      }
    }
    for (const p of players) {
      if (!p.alive || p.removed) continue;
      if (p.nukeCd > 0) p.nukeCd = Math.max(0, p.nukeCd - dt);
      const income =
        GOLD_BASE_PER_SEC +
        p.tiles * GOLD_TILE_PER_SEC +
        p.cities * GOLD_CITY_PER_SEC +
        p.ports * GOLD_PORT_PER_SEC;
      p.gold += income * dt;
    }

    // IA dos bots
    for (const p of players) {
      if (!p.bot || !p.alive || p.removed) continue;
      this.botTimers[p.id] = (this.botTimers[p.id] ?? 0) - dt;
      if (this.botTimers[p.id] <= 0) {
        const interval = p.diff >= 2 ? 0.5 : p.diff === 1 ? 0.85 : 1.35;
        this.botTimers[p.id] = interval * (0.8 + this.rnd() * 0.4);
        botThink(this, p);
      }
    }

    if (this.suddenDeath && !this.sdAnnounced) {
      this.sdAnnounced = true;
      this.pushEvent('⚠ MORTE SÚBITA: fortificações enfraquecidas e exércitos em declínio!', 'war');
    }
    this.checkWin();
  }

  // ==========================================================
  //  Comandos
  // ==========================================================
  /**
   * Cadeia de ataque: path[0] e um tile do jogador, os demais sao
   * tiles adjacentes. Passos sobre tiles proprios = transferencia.
   * O ultimo passo (hostil) usa o `ratio` informado.
   */
  attackChain(pid: number, path: number[], ratio: number): boolean {
    if (this.state !== 'playing') return false;
    const p = this.players[pid];
    if (!p || !p.alive || p.spectator) return false;
    if (!Array.isArray(path) || path.length < 2 || path.length > 400) return false;
    if (!this.valid(path[0]) || this.owner[path[0]] !== pid) return false;
    const r = Math.max(0.05, Math.min(1, Number(ratio) || 0.5));

    let ok = false;
    for (let k = 1; k < path.length; k++) {
      const from = path[k - 1];
      const to = path[k];
      if (!this.valid(from) || !this.valid(to)) break;
      if (!this.isAdjacent(from, to)) break;
      if (this.owner[from] !== pid) break;
      if (this.terrain[to] === T.WATER) break;
      const res = this.resolveAttack(pid, from, to, r);
      if (!res) break;
      ok = true;
      if (this.owner[to] !== pid) break; // bateu em tile hostil: para aqui
    }
    return ok;
  }

  isAdjacent(a: number, b: number): boolean {
    const ax = a % this.w;
    const ay = Math.floor(a / this.w);
    const bx = b % this.w;
    const by = Math.floor(b / this.w);
    return Math.abs(ax - bx) + Math.abs(ay - by) === 1;
  }

  private resolveAttack(pid: number, from: number, to: number, ratio: number): boolean {
    const avail = this.troops[from];
    if (avail <= MIN_ATTACK_TROOPS) return false;

    // transferencia entre tiles proprios
    if (this.owner[to] === pid) {
      const cap = this.maxTroops(to);
      const room = cap - this.troops[to];
      if (room <= 0.5) return false;
      const move = Math.min(room, Math.max(0, avail - TRANSFER_RESERVE));
      if (move < 0.5) return false;
      this.troops[from] = avail - move;
      this.troops[to] += move;
      return true;
    }

    const prevOwner = this.owner[to];
    const moving = avail * ratio;
    if (moving < 1) return false;

    const defMult = this.defenseMult(to, prevOwner);
    const def = this.troops[to] * defMult;
    this.troops[from] = avail - moving;

    if (moving > def) {
      const remaining = moving - def;
      const capturedBld = this.bld[to];
      this.setOwner(to, pid);
      this.troops[to] = Math.max(1, Math.min(this.maxTroops(to), remaining));
      if (prevOwner >= 0 && capturedBld !== B.NONE) {
        this.pushEvent(
          `${this.players[pid].name} capturou ${capturedBld === B.CITY ? 'uma cidade' : 'uma estrutura'} de ${this.players[prevOwner].name}`,
          'war',
          this.players[pid].hue
        );
      }
    } else {
      this.troops[to] = Math.max(0, (def - moving) / defMult);
      if (this.troops[to] < 0.4) this.troops[to] = 0;
    }
    return true;
  }

  build(pid: number, tile: number, type: number): boolean {
    if (this.state !== 'playing') return false;
    const p = this.players[pid];
    if (!p || !p.alive || p.spectator) return false;
    if (!this.valid(tile)) return false;
    if (this.owner[tile] !== pid) return false;
    if (this.bld[tile] !== B.NONE) return false;
    if (this.terrain[tile] === T.WATER) return false;
    const key = type === B.CITY ? 'city' : type === B.OUTPOST ? 'outpost' : type === B.PORT ? 'port' : type === B.SILO ? 'silo' : '';
    if (!key) return false;
    const cost = COSTS[key];
    if (p.gold < cost) return false;
    if (type === B.PORT && !this.isCoastal(tile)) return false;
    if (type === B.SILO && p.silos >= 2) return false;

    p.gold -= cost;
    this.bld[tile] = type;
    this.adjBld(pid, type, +1);
    const names: Record<number, string> = { 1: 'Cidade', 2: 'Posto Defensivo', 3: 'Porto', 4: 'Silo de Mísseis' };
    this.pushEvent(`${p.name} construiu ${names[type]}`, 'build', p.hue);
    return true;
  }

  nuke(pid: number, from: number, target: number): boolean {
    if (this.state !== 'playing') return false;
    const p = this.players[pid];
    if (!p || !p.alive || p.spectator) return false;
    if (!this.valid(from) || !this.valid(target)) return false;
    if (this.owner[from] !== pid || this.bld[from] !== B.SILO) return false;
    if (p.gold < NUKE_COST) return false;
    if (p.nukeCd > 0) return false;
    const tx = this.x(target);
    const ty = this.y(target);
    const fx = this.x(from);
    const fy = this.y(from);
    if (Math.hypot(tx - fx, ty - fy) > NUKE_RANGE) return false;

    p.gold -= NUKE_COST;
    p.nukeCd = NUKE_COOLDOWN;

    const affectedOwners = new Set<number>();
    for (let y = Math.max(0, ty - 7); y <= Math.min(this.h - 1, ty + 7); y++) {
      for (let x = Math.max(0, tx - 7); x <= Math.min(this.w - 1, tx + 7); x++) {
        const i = y * this.w + x;
        if (this.terrain[i] === T.WATER) continue;
        const d = Math.hypot(x - tx, y - ty);
        if (d > NUKE_R_OUTER) continue;
        if (this.owner[i] >= 0) affectedOwners.add(this.owner[i]);
        if (this.bld[i] !== B.NONE) {
          this.adjBld(this.owner[i], this.bld[i], -1);
          this.bld[i] = B.NONE;
        }
        if (d <= NUKE_R_CORE) {
          this.setOwner(i, -1, true);
          this.troops[i] = 2;
        } else {
          this.troops[i] = Math.max(0, this.troops[i] * 0.05);
        }
      }
    }
    this.recountAll();
    for (const o of affectedOwners) this.checkElimination(o);

    this.pushEvent(`☢ ${p.name} lançou um míssil nuclear!`, 'nuke', p.hue, target);
    return true;
  }

  private checkElimination(pid: number): void {
    const p = this.players[pid];
    if (!p || !p.alive || p.tiles > 0) return;
    p.alive = false;
    p.troops = 0;
    this.pushEvent(`${p.name} foi eliminado da partida`, 'war', p.hue);
  }

  private checkWin(): void {
    if (this.state !== 'playing') return;
    const alive = this.players.filter((p) => p.alive && !p.spectator && !p.removed);
    const contenders = this.players.filter((p) => !p.removed && !p.spectator);
    if (contenders.length > 1 && alive.length <= 1) {
      this.winner = alive.length === 1 ? alive[0].id : -1;
      this.winReason = 'último império de pé';
      this.state = 'over';
      this.pushEvent(`🏆 ${this.winner >= 0 ? this.players[this.winner].name : 'Ninguém'} venceu — ${this.winReason}`, 'over');
      return;
    }
    let leader = -1;
    let best = 0;
    for (const p of alive) {
      if (p.tiles > best) {
        best = p.tiles;
        leader = p.id;
      }
    }
    if (leader >= 0 && this.landTiles > 0 && best / this.landTiles >= WIN_CONTROL) {
      this.winner = leader;
      this.winReason = `controle de ${((best / this.landTiles) * 100).toFixed(1)}% do território`;
      this.state = 'over';
      this.pushEvent(`🏆 ${this.players[leader].name} venceu por ${this.winReason}`, 'over');
    }
  }

  // ==========================================================
  //  Sincronizacao de estado
  // ==========================================================
  /** Diff completo (usado quando um cliente entra). */
  fullState(): Change[] {
    const out: Change[] = [];
    for (let i = 0; i < this.n; i++) {
      const o = this.owner[i];
      const t = quantizeTroops(this.troops[i]);
      const b = this.bld[i];
      if (o === -1 && t === 0 && b === B.NONE) continue;
      out.push([i, o, t, b]);
      this.sentOwner[i] = o;
      this.sentTroops[i] = t;
      this.sentBld[i] = b;
    }
    return out;
  }

  /** Diff incremental com orcamento de bytes por pacote. */
  collectChanges(budget = 3000): Change[] {
    const out: Change[] = [];
    for (let i = 0; i < this.n && out.length < budget; i++) {
      const o = this.owner[i];
      const t = quantizeTroops(this.troops[i]);
      const b = this.bld[i];
      if (this.sentOwner[i] === o && this.sentTroops[i] === t && this.sentBld[i] === b) continue;
      this.sentOwner[i] = o;
      this.sentTroops[i] = t;
      this.sentBld[i] = b;
      out.push([i, o, t, b]);
    }
    return out;
  }

  /** Como `collectChanges`, mas com contadores de cada cliente separados. */
  collectChangesFor(sent: { o: Int16Array; t: Int32Array; b: Uint8Array }, budget = 3000): Change[] {
    const out: Change[] = [];
    for (let i = 0; i < this.n && out.length < budget; i++) {
      const o = this.owner[i];
      const t = quantizeTroops(this.troops[i]);
      const b = this.bld[i];
      if (sent.o[i] === o && sent.t[i] === t && sent.b[i] === b) continue;
      sent.o[i] = o;
      sent.t[i] = t;
      sent.b[i] = b;
      out.push([i, o, t, b]);
    }
    return out;
  }

  newSentState(): { o: Int16Array; t: Int32Array; b: Uint8Array } {
    return {
      o: new Int16Array(this.n).fill(-2),
      t: new Int32Array(this.n).fill(-1),
      b: new Uint8Array(this.n).fill(255)
    };
  }

  snapshotPlayers(): PlayerSnapshot[] {
    const troops = new Float64Array(this.players.length);
    for (let i = 0; i < this.n; i++) {
      const o = this.owner[i];
      if (o >= 0) troops[o] += this.troops[i];
    }
    for (const p of this.players) {
      p.troops = Math.round(troops[p.id]);
      p.gold = Math.floor(p.gold);
    }
    return this.activePlayers();
  }
}
