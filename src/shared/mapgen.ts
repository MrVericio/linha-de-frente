import { T, MAP_W, MAP_H, LAND_TARGET } from './constants.js';

// ------------------------------------------------------------
// PRNG deterministico (mesma semente => mesmo mapa)
// ------------------------------------------------------------
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2i(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function vnoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const n00 = hash2i(ix, iy, seed);
  const n10 = hash2i(ix + 1, iy, seed);
  const n01 = hash2i(ix, iy + 1, seed);
  const n11 = hash2i(ix + 1, iy + 1, seed);
  return (n00 * (1 - sx) + n10 * sx) * (1 - sy) + (n01 * (1 - sx) + n11 * sx) * sy;
}

function fbm(x: number, y: number, seed: number, oct = 4): number {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < oct; i++) {
    sum += vnoise(x * freq, y * freq, seed + i * 1013) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

export interface GeneratedMap {
  w: number;
  h: number;
  terrain: Uint8Array;
  spawns: number[]; // indices de tiles iniciais (um por jogador)
  landTiles: number;
  seed: number;
}

/**
 * Gera um mapa de continentes com oceano nas bordas.
 * `count` = numero de pontos de spawn necessarios.
 */
export function generateMap(count: number, seedIn?: number, w = MAP_W, h = MAP_H): GeneratedMap {
  const seed = (seedIn ?? Math.floor(Math.random() * 1e9)) >>> 0;
  const rnd = mulberry32(seed);
  const terrain = new Uint8Array(w * h);

  const scale = 0.045 + rnd() * 0.02;
  const warpX = rnd() * 100;
  const warpY = rnd() * 100;

  // elevacao bruta
  const elev = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const nx = x * scale + warpX;
      const ny = y * scale + warpY;
      let e = fbm(nx, ny, seed, 5);
      // mascara radial: oceano nas bordas do mapa
      const dx = (x / (w - 1)) * 2 - 1;
      const dy = (y / (h - 1)) * 2 - 1;
      const d = Math.sqrt(dx * dx * 0.85 + dy * dy * 1.15);
      const falloff = 1 - Math.pow(Math.min(1, Math.max(0, (d - 0.42) / 0.62)), 1.6);
      e = e * 0.78 + 0.22 * falloff;
      e *= 0.55 + 0.45 * falloff;
      elev[y * w + x] = e;
    }
  }

  // busca o corte que atinge a proporcao alvo de terra
  const sorted = Float32Array.from(elev).sort();
  const cutIdx = Math.floor(sorted.length * (1 - LAND_TARGET));
  let cut = sorted[Math.min(sorted.length - 1, Math.max(0, cutIdx))];

  let landTiles = 0;
  for (let i = 0; i < w * h; i++) {
    if (elev[i] > cut) {
      terrain[i] = T.LAND;
      landTiles++;
    } else {
      terrain[i] = T.WATER;
    }
  }

  // montanhas: outro campo de ruido, apenas onde a elevacao e alta
  const mScale = 0.09 + rnd() * 0.05;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (terrain[i] !== T.LAND) continue;
      const m = fbm(x * mScale + 40, y * mScale + 40, seed + 7777, 3);
      const high = (elev[i] - cut) / Math.max(1e-6, 1 - cut);
      if (m > 0.63 && high > 0.16) terrain[i] = T.MOUNTAIN;
    }
  }

  // ------- spawns: amostragem por ponto mais distante -------
  const spawns = pickSpawns(terrain, w, h, count, rnd);

  // limpa montanhas ao redor de cada spawn
  for (const s of spawns) {
    const sx = s % w;
    const sy = Math.floor(s / w);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = sx + dx;
        const y = sy + dy;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const i = y * w + x;
        if (terrain[i] === T.MOUNTAIN) terrain[i] = T.LAND;
        if (terrain[i] === T.WATER && dx === 0 && dy === 0) terrain[i] = T.LAND;
      }
    }
  }

  return { w, h, terrain, spawns, landTiles, seed };
}

function localLandDensity(terrain: Uint8Array, w: number, h: number, x: number, y: number, r: number): number {
  let land = 0;
  let total = 0;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      total++;
      if (terrain[ny * w + nx] !== T.WATER) land++;
    }
  }
  return total ? land / total : 0;
}

function pickSpawns(
  terrain: Uint8Array,
  w: number,
  h: number,
  count: number,
  rnd: () => number
): number[] {
  for (const minDensity of [0.62, 0.5, 0.4, 0.28]) {
    const cands: number[] = [];
    for (let y = 3; y < h - 3; y++) {
      for (let x = 3; x < w - 3; x++) {
        const i = y * w + x;
        if (terrain[i] !== T.LAND) continue;
        if (localLandDensity(terrain, w, h, x, y, 3) >= minDensity) cands.push(i);
      }
    }
    if (cands.length < count * 3) continue;

    const chosen: number[] = [];
    const first = cands[Math.floor(rnd() * cands.length)];
    chosen.push(first);
    const dist = new Float64Array(w * h).fill(Infinity);
    const updateDist = (idx: number) => {
      const cx = idx % w;
      const cy = Math.floor(idx / w);
      for (const c of cands) {
        const x = c % w;
        const y = Math.floor(c / w);
        const d = (x - cx) * (x - cx) + (y - cy) * (y - cy);
        if (d < dist[c]) dist[c] = d;
      }
    };
    updateDist(first);
    while (chosen.length < count) {
      let best = -1;
      let bestD = -1;
      for (const c of cands) {
        if (dist[c] > bestD) {
          bestD = dist[c];
          best = c;
        }
      }
      if (best < 0 || bestD <= 4) break;
      chosen.push(best);
      updateDist(best);
    }
    if (chosen.length >= count) return chosen.slice(0, count);
  }

  // fallback: tiles de terra aleatorios bem espalhados
  const land: number[] = [];
  for (let i = 0; i < w * h; i++) if (terrain[i] !== T.WATER) land.push(i);
  const out: number[] = [];
  while (out.length < count && land.length) {
    out.push(land.splice(Math.floor(rnd() * land.length), 1)[0]);
  }
  return out;
}
