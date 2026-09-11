import { b64ToBytes } from '../shared/codec.js';
import { T, type Change, type PlayerSnapshot } from '../shared/constants.js';

/**
 * Estado do mundo no cliente (espelho do servidor).
 */
export class World {
  w = 0;
  h = 0;
  n = 0;
  terrain: Uint8Array = new Uint8Array(0);
  owner = new Int16Array(0);
  troops = new Int32Array(0);
  bld = new Uint8Array(0);
  /** variacao visual deterministica por tile (0..255) */
  shade: Uint8Array = new Uint8Array(0);
  /** agua rasa (adjacente a terra) para desenhar melhor */
  shallow: Uint8Array = new Uint8Array(0);
  players: PlayerSnapshot[] = [];
  you = -1;
  time = 0;
  state: 'waiting' | 'playing' | 'over' = 'waiting';
  landTiles = 0;
  spectator = false;
  /** incrementa quando algum dono de tile muda (invalida a camada de render) */
  rev = 0;
  rules = { winControl: 0.72, nukeCost: 1500, costs: {} as Record<string, number> };

  loadMap(w: number, h: number, terrainB64: string, changes: Change[], players: PlayerSnapshot[], you: number): void {
    this.w = w;
    this.h = h;
    this.n = w * h;
    this.terrain = b64ToBytes(terrainB64);
    this.owner = new Int16Array(this.n).fill(-1);
    this.troops = new Int32Array(this.n);
    this.bld = new Uint8Array(this.n);
    this.players = players;
    this.you = you;
    this.state = 'playing';
    this.time = 0;
    this.precomputeShading();
    this.apply(changes);
    this.rev++;
    this.recountLand();
  }

  private precomputeShading(): void {
    this.shade = new Uint8Array(this.n);
    this.shallow = new Uint8Array(this.n);
    for (let i = 0; i < this.n; i++) {
      const x = i % this.w;
      let hsh = Math.imul(x, 374761393) + Math.imul(Math.floor(i / this.w), 668265263);
      hsh = Math.imul(hsh ^ (hsh >>> 13), 1274126177);
      this.shade[i] = ((hsh ^ (hsh >>> 16)) >>> 0) % 256;
      if (this.terrain[i] === T.WATER) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = Math.floor(i / this.w) + dy;
            if (nx < 0 || ny < 0 || nx >= this.w || ny >= this.h) continue;
            if (this.terrain[ny * this.w + nx] !== T.WATER) {
              this.shallow[i] = 1;
              dy = 2;
              break;
            }
          }
        }
      }
    }
  }

  private recountLand(): void {
    let c = 0;
    for (let i = 0; i < this.n; i++) if (this.terrain[i] !== T.WATER) c++;
    this.landTiles = c;
  }

  apply(changes: Change[]): void {
    let changed = false;
    for (let k = 0; k < changes.length; k++) {
      const ch = changes[k];
      const i = ch[0];
      if (i < 0 || i >= this.n) continue;
      if (this.owner[i] !== ch[1]) changed = true;
      this.owner[i] = ch[1];
      this.troops[i] = ch[2];
      this.bld[i] = ch[3];
    }
    if (changed) this.rev++;
  }

  me(): PlayerSnapshot | undefined {
    return this.players.find((p) => p.id === this.you);
  }

  playerById(id: number): PlayerSnapshot | undefined {
    return this.players.find((p) => p.id === id);
  }

  sortedPlayers(): PlayerSnapshot[] {
    return [...this.players].sort((a, b) => {
      if (a.alive !== b.alive) return a.alive ? -1 : 1;
      return b.tiles - a.tiles;
    });
  }

  /** Caminho BFS por territorio proprio de `from` ate `to` (ultimo pode ser hostil). */
  findPath(from: number, to: number, pid: number, maxLen = 400): number[] | null {
    if (from === to) return null;
    if (!this.inBounds(from) || !this.inBounds(to)) return null;
    if (this.owner[from] !== pid) return null;
    // vizinho direto
    if (this.isAdjacent(from, to)) return [from, to];

    const prev = new Int32Array(this.n).fill(-1);
    const seen = new Uint8Array(this.n);
    const q: number[] = [from];
    seen[from] = 1;
    let head = 0;
    let found = false;
    while (head < q.length && head < maxLen * 40) {
      const cur = q[head++];
      for (const nb of this.neighbors(cur)) {
        if (seen[nb]) continue;
        if (nb === to) {
          prev[nb] = cur;
          seen[nb] = 1;
          found = true;
          q.length = 0;
          break;
        }
        if (this.owner[nb] !== pid) continue;
        if (this.terrain[nb] === T.WATER) continue;
        seen[nb] = 1;
        prev[nb] = cur;
        q.push(nb);
      }
    }
    if (!found) return null;
    const path: number[] = [to];
    let cur = to;
    while (cur !== from && cur >= 0) {
      cur = prev[cur];
      path.push(cur);
      if (path.length > maxLen) return null;
    }
    path.reverse();
    return path[0] === from ? path : null;
  }

  neighbors(i: number): number[] {
    const x = i % this.w;
    const y = Math.floor(i / this.w);
    const out: number[] = [];
    if (x > 0) out.push(i - 1);
    if (x < this.w - 1) out.push(i + 1);
    if (y > 0) out.push(i - this.w);
    if (y < this.h - 1) out.push(i + this.w);
    return out;
  }

  isAdjacent(a: number, b: number): boolean {
    const ax = a % this.w;
    const ay = Math.floor(a / this.w);
    const bx = b % this.w;
    const by = Math.floor(b / this.w);
    return Math.abs(ax - bx) + Math.abs(ay - by) === 1;
  }

  inBounds(i: number): boolean {
    return i >= 0 && i < this.n;
  }

  isCoastal(i: number): boolean {
    const x = i % this.w;
    const y = Math.floor(i / this.w);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= this.w || ny >= this.h) continue;
        if (this.terrain[ny * this.w + nx] === T.WATER) return true;
      }
    }
    return false;
  }

  mySiloTiles(pid: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.n; i++) {
      if (this.owner[i] === pid && this.bld[i] === 4) out.push(i);
    }
    return out;
  }

  myStrongestTile(pid: number): number {
    let best = -1;
    let bestT = -1;
    for (let i = 0; i < this.n; i++) {
      if (this.owner[i] === pid && this.troops[i] > bestT) {
        bestT = this.troops[i];
        best = i;
      }
    }
    return best;
  }
}
