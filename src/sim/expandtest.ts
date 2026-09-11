import { Game } from '../shared/game.js';
import { T, TICK_HZ } from '../shared/constants.js';

/**
 * Valida a ORDEM DE EXPANSAO:
 *  - tropas conquistam apenas territorio NEUTRO em direcao ao alvo;
 *  - NUNCA atacam outro jogador por conta propria (param na fronteira);
 *  - o fluxo continua ate bloquear/chegar.
 */
const seed = Number(process.argv[2] || 555);
const SECONDS = Number(process.argv[3] || 240);

const g = new Game({ seed, totalPlayers: 6, difficulty: 1 });
g.addPlayer({ name: 'Humano', bot: false });
for (let i = 0; i < 5; i++) g.addPlayer({ name: `Bot ${i}`, bot: true, diff: 1 });
g.startMatch(seed);

const H = 0;
const myTiles = (): number[] => {
  const out: number[] = [];
  for (let i = 0; i < g.n; i++) if (g.owner[i] === H) out.push(i);
  return out;
};

// alvo neutro bem distante do territorio inicial
const mine0 = myTiles();
const cx = mine0.reduce((s, i) => s + (i % g.w), 0) / mine0.length;
const cy = mine0.reduce((s, i) => s + Math.floor(i / g.w), 0) / mine0.length;
let target = -1;
let bestD = -1;
for (let i = 0; i < g.n; i++) {
  if (g.owner[i] !== -1 || g.terrain[i] === T.WATER) continue;
  const d = Math.hypot((i % g.w) - cx, Math.floor(i / g.w) - cy);
  if (d > bestD) {
    bestD = d;
    target = i;
  }
}
console.log(`alvo de expansao: tile ${target} (distancia ${bestD.toFixed(0)} do spawn)`);
if (!g.setExpand(H, target)) {
  console.log('FALHA: setExpand recusado');
  process.exit(1);
}

const prev = Int16Array.from(g.owner);
let illegal = 0; // tile de outro jogador tomado pela expansao
let claimedNeutral = 0;
let retargets = 0;
const dt = 1 / TICK_HZ;
const ticks = SECONDS * TICK_HZ;
let lastReport = 0;

for (let k = 0; k < ticks; k++) {
  g.tick(dt);
  for (let i = 0; i < g.n; i++) {
    if (prev[i] === g.owner[i]) continue;
    if (g.owner[i] === H) {
      if (prev[i] > 0) illegal++;
      else if (prev[i] === -1) claimedNeutral++;
    }
    prev[i] = g.owner[i];
  }
  // quando chega ao alvo, mira em outro ponto neutro distante (continua o teste)
  if (g.players[H].expandTarget === -1 && g.state === 'playing') {
    const mine = myTiles();
    const mx = mine.reduce((s, i) => s + (i % g.w), 0) / Math.max(1, mine.length);
    const my = mine.reduce((s, i) => s + Math.floor(i / g.w), 0) / Math.max(1, mine.length);
    let nt = -1;
    let nd = -1;
    for (let i = 0; i < g.n; i++) {
      if (g.owner[i] !== -1 || g.terrain[i] === T.WATER) continue;
      const d = Math.hypot((i % g.w) - mx, Math.floor(i / g.w) - my);
      if (d > nd) {
        nd = d;
        nt = i;
      }
    }
    if (nt >= 0 && nd > 6) {
      g.setExpand(H, nt);
      retargets++;
    }
  }
  const sec = Math.floor(g.time);
  if (sec - lastReport >= 60) {
    lastReport = sec;
    const p = g.players[H];
    console.log(`t=${sec}s tiles=${p.tiles} (${((p.tiles / g.landTiles) * 100).toFixed(1)}%) tropas=${Math.round(p.troops)} alvo=${p.expandTarget}`);
  }
  if (g.state === 'over') break;
}

const p = g.players[H];
console.log(`\nneutros conquistados pela expansao: ${claimedNeutral}`);
console.log(`tiles inimigos tomados pela expansao (deve ser 0): ${illegal}`);
console.log(`re-mirei o alvo ${retargets}x | tiles finais do humano: ${p.tiles}`);
const ok = illegal === 0 && claimedNeutral > 10;
console.log(ok ? 'OK: expansao só toma neutro e para na fronteira' : 'FALHA na expansão');
process.exit(ok ? 0 : 1);
