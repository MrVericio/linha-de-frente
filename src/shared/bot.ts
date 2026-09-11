import { B, T, COSTS, NUKE_COST, NUKE_RANGE } from './constants.js';
import type { PlayerSnapshot } from './constants.js';
import type { Game } from './game.js';

interface Opportunity {
  from: number;
  to: number;
  atk: number;
  foe: number;
}

interface BotMemory {
  nextWave: number;
  waveFoe: number;
  waveUntil: number;
}

const RESERVE = 100; // ouro guardado para nao travar a economia
const memory = new Map<number, BotMemory>();

/** Limpa a memoria da IA (chamado no inicio de cada partida). */
export function resetBotMemory(): void {
  memory.clear();
}

/**
 * IA dos bots. Chamada em intervalos escalonados (nao a cada tick).
 * Dificuldade: 0 = facil, 1 = normal, 2 = dificil.
 */
export function botThink(g: Game, p: PlayerSnapshot): void {
  if (!p.alive || p.tiles <= 0) return;
  const diff = p.diff ?? 1;

  // ---------------- levantamento ----------------
  const own: number[] = [];
  const buildable: number[] = [];
  const coastBuildable: number[] = [];
  const front: Opportunity[] = [];
  const borderTiles: number[] = [];
  const siloTiles: number[] = [];

  for (let i = 0; i < g.n; i++) {
    if (g.owner[i] !== p.id) continue;
    own.push(i);
    const b = g.bld[i];
    if (b === B.SILO) siloTiles.push(i);
    else if (b === B.NONE) {
      buildable.push(i);
      if (g.isCoastal(i)) coastBuildable.push(i);
    }

    let isBorder = false;
    for (const t of g.neighbors(i)) {
      if (g.terrain[t] === T.WATER || g.owner[t] === p.id) continue;
      isBorder = true;
      front.push({ from: i, to: t, atk: g.troops[i], foe: g.owner[t] });
    }
    if (isBorder) borderTiles.push(i);
  }
  if (!own.length) return;

  const gold = p.gold;
  const leader = currentLeader(g, p.id);
  const ratio = diff >= 2 ? 0.9 : diff === 1 ? 0.75 : 0.6;

  // ---------------- ondas de agressao ----------------
  let mem = memory.get(p.id);
  if (!mem) {
    mem = { nextWave: 40 + Math.random() * 40, waveFoe: -1, waveUntil: -1 };
    memory.set(p.id, mem);
  }
  const inWave = g.time < mem.waveUntil;
  if (diff >= 1 && g.time > mem.nextWave) {
    const foe = pickWaveTarget(g, p, front, leader);
    if (foe >= 0) {
      mem.waveFoe = foe;
      mem.waveUntil = g.time + (diff >= 2 ? 22 : 16);
    }
    mem.nextWave = g.time + 22 + Math.random() * 26;
  }

  // ---------------- ataques convergentes ----------------
  const sd = g.suddenDeath;
  const threshold =
    (diff >= 2 ? 1.1 : diff === 1 ? 1.25 : 1.5) * (inWave ? 0.6 : 1) * (sd ? 0.75 : 1);
  // durante a onda (ou na morte subita) o bot compromete toda a fronteira
  const maxAssaults = inWave || sd ? 60 : diff >= 2 ? 5 : diff === 1 ? 4 : 2;
  const blitzDepth = diff >= 2 ? 4 : diff === 1 ? 3 : 1;

  const byTarget = new Map<number, Opportunity[]>();
  for (const f of front) {
    if (f.atk * ratio < 4) continue;
    const list = byTarget.get(f.to);
    if (list) list.push(f);
    else byTarget.set(f.to, [f]);
  }

  const scored: { to: number; score: number; list: Opportunity[] }[] = [];
  for (const [to, list] of byTarget) {
    const foe = list[0].foe;
    const def = g.troops[to] * g.defenseMult(to, foe);
    let totalAtk = 0;
    for (const o of list) totalAtk += o.atk * ratio;
    let score = totalAtk / (def + 6);
    if (foe < 0) score *= 1.45;
    if (foe >= 0 && g.bld[to] !== B.NONE) score *= 1.3;
    if (inWave && !sd) {
      if (foe !== mem!.waveFoe) continue; // foco total no alvo da onda
      score *= 1.8;
    } else if (inWave && foe === mem!.waveFoe) {
      score *= 1.8;
    }
    else if (foe === leader && leader !== p.id) score *= diff >= 2 ? 0.95 : 0.7;
    if (score > threshold) scored.push({ to, score, list });
  }
  scored.sort((a, b) => b.score - a.score);

  const usedFrom = new Set<number>();
  const captured: number[] = [];
  let assaults = 0;
  for (const s of scored) {
    if (assaults >= maxAssaults) break;
    const sources = s.list
      .filter((o) => !usedFrom.has(o.from) && g.troops[o.from] >= 8 && g.owner[o.from] === p.id)
      .sort((a, b) => b.atk - a.atk);
    if (!sources.length) continue;
    let hit = false;
    for (const src of sources) {
      const path = extendPath(g, p.id, src.from, s.to, blitzDepth, ratio);
      const wasHostile = g.owner[s.to] !== p.id;
      if (g.attackChain(p.id, path, ratio)) {
        usedFrom.add(src.from);
        hit = true;
        if (g.owner[s.to] === p.id) {
          if (wasHostile) captured.push(s.to);
          break; // alvo caiu, para de gastar tropa
        }
      }
    }
    if (hit) assaults++;
  }

  // explorar a brecha: segue empurrando a partir do tile recem-capturado
  if (captured.length && diff >= 1) {
    const depth = g.suddenDeath ? 8 : inWave ? 6 : 3;
    for (const c of captured) pursue(g, p.id, c, ratio, depth);
  }

  // ---------------- concentrar exercito na fronteira ----------------
  if (borderTiles.length && own.length > 8) {
    const flow = buildFlow(g, p.id, own, borderTiles);
    const moves = inWave || sd ? 14 : 6;
    let done = 0;
    for (const i of own) {
      if (done >= moves) break;
      const cap = g.maxTroops(i);
      if (g.troops[i] < cap * (inWave ? 0.55 : 0.75)) continue;
      const next = flow[i];
      if (next < 0 || g.owner[next] !== p.id) continue;
      if (g.maxTroops(next) - g.troops[next] < 10) continue;
      if (g.attackChain(p.id, [i, next], 1)) done++;
    }
  }

  // ---------------- reforcar a frente ----------------
  if (diff >= 1 && borderTiles.length && own.length > 6) {
    const borderSet = new Set(borderTiles);
    let moved = 0;
    const limit = inWave ? 4 : 2;
    for (const i of borderTiles) {
      if (moved >= limit) break;
      const cap = g.maxTroops(i);
      if (g.troops[i] > cap * 0.5) continue;
      // so reforca se houver ameaca real por perto
      let threat = 0;
      for (const t of g.neighbors(i)) {
        if (g.terrain[t] === T.WATER || g.owner[t] === p.id) continue;
        threat += g.troops[t];
      }
      if (threat < g.troops[i] * 1.1 + 25) continue;
      let src = -1;
      let srcTroops = 0;
      for (const t of g.neighbors(i)) {
        if (g.terrain[t] === T.WATER || g.owner[t] !== p.id) continue;
        if (g.troops[t] > g.maxTroops(t) * 0.9 && borderSet.has(t)) continue;
        if (g.troops[t] > srcTroops) {
          srcTroops = g.troops[t];
          src = t;
        }
      }
      if (src >= 0 && srcTroops > 35 && g.attackChain(p.id, [src, i], 1)) moved++;
    }
    // retaguarda cheia -> frente
    for (const i of own) {
      if (moved >= limit + 2) break;
      if (borderSet.has(i)) continue;
      const cap = g.maxTroops(i);
      if (g.troops[i] < cap * 0.85) continue;
      let best = -1;
      let bestScore = -1;
      for (const t of g.neighbors(i)) {
        if (g.terrain[t] === T.WATER || g.owner[t] !== p.id) continue;
        const room = g.maxTroops(t) - g.troops[t];
        if (room < 15) continue;
        const score = (borderSet.has(t) ? 3 : 0) + room / 100;
        if (score > bestScore) {
          bestScore = score;
          best = t;
        }
      }
      if (best >= 0 && g.attackChain(p.id, [i, best], 1)) moved++;
    }
  }

  // ---------------- construir ----------------
  if (inWave && assaults > 0 && diff >= 1) return; // segue empurrando a frente
  const wantCities = Math.min(24, 1 + Math.floor(p.tiles / 10));
  const wantPorts = Math.min(14, 1 + Math.floor(p.tiles / 20));
  const wantOutposts = Math.min(20, Math.floor(p.tiles / 12));

  if (p.cities < wantCities && gold >= COSTS.city + RESERVE && buildable.length) {
    const spot = pickInteriorSpot(g, buildable, p.id);
    if (spot >= 0 && g.troops[spot] >= 40 && g.build(p.id, spot, B.CITY)) return;
  }

  if (p.ports < wantPorts && gold >= COSTS.port + RESERVE && coastBuildable.length) {
    const spot = coastBuildable.reduce((a, b) => (g.troops[a] > g.troops[b] ? a : b));
    if (g.build(p.id, spot, B.PORT)) return;
  }

  if (p.outposts < wantOutposts && gold >= COSTS.outpost + RESERVE * 0.4 && borderTiles.length) {
    let best = -1;
    let bestPressure = 30;
    for (const i of borderTiles) {
      if (g.bld[i] !== B.NONE) continue;
      let pressure = 0;
      for (const t of g.neighbors(i)) {
        if (g.terrain[t] === T.WATER || g.owner[t] === p.id) continue;
        pressure += g.troops[t] * (g.owner[t] >= 0 ? 1.6 : 0.4);
      }
      if (pressure > bestPressure) {
        bestPressure = pressure;
        best = i;
      }
    }
    if (best >= 0 && g.build(p.id, best, B.OUTPOST)) return;
  }

  if (p.silos < 3 && gold >= COSTS.silo + RESERVE && g.time > 110 && buildable.length) {
    const spot = pickInteriorSpot(g, buildable, p.id);
    if (spot >= 0 && g.build(p.id, spot, B.SILO)) return;
  }

  // ---------------- missile nuclear ----------------
  if (p.silos && p.nukeCd <= 0 && gold >= NUKE_COST && g.time > 130) {
    const target = pickNukeTarget(g, p.id, siloTiles, inWave ? mem.waveFoe : -1);
    if (target) g.nuke(p.id, target.silo, target.tile);
  }
}

/**
 * BFS multi-origem a partir da fronteira: para cada tile proprio guarda
 * o proximo salto em direcao ao tile de fronteira mais proximo.
 * Isso permite "bombear" o exercito da retaguarda para a frente.
 */
function buildFlow(g: Game, pid: number, own: number[], borderTiles: number[]): Int32Array {
  const flow = new Int32Array(g.n).fill(-1);
  const seen = new Uint8Array(g.n);
  const queue: number[] = [];
  for (const b of borderTiles) {
    seen[b] = 1;
    queue.push(b);
  }
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    for (const t of g.neighbors(cur)) {
      if (seen[t] || g.owner[t] !== pid) continue;
      seen[t] = 1;
      flow[t] = cur;
      queue.push(t);
    }
  }
  void own;
  return flow;
}

/** Persegue o inimigo a partir de um tile recem-capturado enquanto estiver vencendo. */
function pursue(g: Game, pid: number, start: number, ratio: number, maxSteps: number): void {
  let cur = start;
  for (let s = 0; s < maxSteps; s++) {
    if (g.owner[cur] !== pid || g.troops[cur] < 8) break;
    let best = -1;
    let bestDef = Infinity;
    for (const t of g.neighbors(cur)) {
      if (g.terrain[t] === T.WATER || g.owner[t] === pid) continue;
      const def = g.troops[t] * g.defenseMult(t, g.owner[t]);
      if (def < bestDef) {
        bestDef = def;
        best = t;
      }
    }
    if (best < 0) break;
    if (g.troops[cur] * ratio < bestDef * 1.05) break;
    if (!g.attackChain(pid, [cur, best], ratio)) break;
    if (g.owner[best] !== pid) break;
    cur = best;
  }
}

/** Escolhe o vizinho mais fraco para a proxima onda de agressao. */
function pickWaveTarget(g: Game, p: PlayerSnapshot, front: Opportunity[], leader: number): number {
  const foeTroops = new Map<number, number>();
  const myTroops = new Map<number, number>();
  for (const f of front) {
    if (f.foe < 0) continue;
    foeTroops.set(f.foe, (foeTroops.get(f.foe) || 0) + g.troops[f.to]);
    myTroops.set(f.foe, (myTroops.get(f.foe) || 0) + f.atk);
  }
  let best = -1;
  let bestScore = 0;
  for (const [foe, def] of foeTroops) {
    const mine = myTroops.get(foe) || 0;
    let score = mine / (def + 20);
    const fp = g.players[foe];
    if (fp && !fp.alive) continue;
    if (foe === leader) score *= 0.8;
    if (score > bestScore) {
      bestScore = score;
      best = foe;
    }
  }
  return bestScore > 0.55 ? best : -1;
}

/** Estende o ataque por territorio neutro/inimigo fraco (o "arrastao" do mouse). */
function extendPath(g: Game, pid: number, from: number, to: number, depth: number, ratio: number): number[] {
  const path = [from, to];
  if (depth <= 1) return path;
  let cur = to;
  let arriving = g.troops[from] * ratio - g.troops[to] * g.defenseMult(to, g.owner[to]);
  const seen = new Set<number>([from, to]);
  for (let step = 1; step < depth; step++) {
    if (arriving < 10) break;
    let best = -1;
    let bestTroops = Infinity;
    for (const t of g.neighbors(cur)) {
      if (seen.has(t) || g.terrain[t] === T.WATER || g.owner[t] === pid) continue;
      const tr = g.troops[t] * g.defenseMult(t, g.owner[t]);
      if (tr > arriving * 0.5) continue;
      if (tr < bestTroops) {
        bestTroops = tr;
        best = t;
      }
    }
    if (best < 0) break;
    path.push(best);
    seen.add(best);
    arriving = arriving * ratio - bestTroops;
    cur = best;
  }
  return path;
}

function currentLeader(g: Game, selfId: number): number {
  let best = -1;
  let bestTiles = -1;
  for (const pl of g.players) {
    if (!pl.alive || pl.spectator || pl.removed) continue;
    if (pl.tiles > bestTiles) {
      bestTiles = pl.tiles;
      best = pl.id;
    }
  }
  return best === selfId ? -1 : best;
}

function pickInteriorSpot(g: Game, candidates: number[], pid: number): number {
  let best = -1;
  let bestScore = -Infinity;
  for (const i of candidates) {
    let friendly = 0;
    for (const t of g.neighbors(i)) if (g.owner[t] === pid) friendly++;
    const score = friendly * 80 + Math.min(g.troops[i], 300) * 0.15;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

function pickNukeTarget(
  g: Game,
  pid: number,
  siloTiles: number[],
  waveFoe: number
): { silo: number; tile: number } | null {
  if (!siloTiles.length) return null;

  // candidatos: tiles inimigos valiosos (obras ou pilhas cheias)
  const cands: number[] = [];
  for (let i = 0; i < g.n; i++) {
    const o = g.owner[i];
    if (o < 0 || o === pid) continue;
    const foe = g.players[o];
    if (!foe || !foe.alive || foe.removed) continue;
    if (g.bld[i] !== B.NONE || g.troops[i] > g.maxTroops(i) * 0.6) cands.push(i);
  }
  if (!cands.length) return null;

  // pontua a densidade ao redor de cada candidato (amostragem se houver muitos)
  const step = cands.length > 400 ? Math.ceil(cands.length / 400) : 1;
  let bestTile = -1;
  let bestScore = 0;
  const w = g.w;
  const h = g.h;
  for (let k = 0; k < cands.length; k += step) {
    const i = cands[k];
    const x = i % w;
    const y = Math.floor(i / w);
    let sc = 0;
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        const o = g.owner[j];
        if (o < 0 || o === pid) continue;
        sc += g.troops[j] + (g.bld[j] === B.CITY ? 400 : g.bld[j] !== B.NONE ? 180 : 0);
      }
    }
    if (waveFoe >= 0 && g.owner[i] === waveFoe) sc *= 1.7;
    if (sc > bestScore) {
      bestScore = sc;
      bestTile = i;
    }
  }
  if (bestTile < 0 || bestScore < 220) return null;

  // escolhe o silo com alcance; se o alvo estiver longe, tenta o melhor alvo ao alcance
  for (const s of siloTiles) {
    if (Math.hypot(g.x(s) - g.x(bestTile), g.y(s) - g.y(bestTile)) <= NUKE_RANGE) {
      return { silo: s, tile: bestTile };
    }
  }
  let fallback = -1;
  let fbScore = 0;
  for (const s of siloTiles) {
    for (const c of cands) {
      if (Math.hypot(g.x(s) - g.x(c), g.y(s) - g.y(c)) > NUKE_RANGE) continue;
      const v = g.troops[c] + (g.bld[c] !== B.NONE ? 300 : 0);
      if (v > fbScore) {
        fbScore = v;
        fallback = c;
        bestTile = c;
      }
    }
    if (fallback >= 0) return { silo: s, tile: fallback };
  }
  return null;
}
