import { Game } from '../shared/game.js';
import { TICK_HZ } from '../shared/constants.js';

/**
 * Teste de fumaca da simulacao: 8 bots jogando sozinhos.
 * Verifica desempenho, expansao, combate e condicao de vitoria.
 */
const SIM_SECONDS = Number(process.argv[2] || 420);
const BOT_COUNT = Number(process.argv[3] || 8);
const seed = Number(process.argv[4] || 12345);

const g = new Game({ seed, totalPlayers: BOT_COUNT, difficulty: 1 });
for (let i = 0; i < BOT_COUNT; i++) {
  g.addPlayer({ name: `Bot ${i}`, bot: true, diff: i % 3 });
}

const t0 = Date.now();
g.startMatch(seed);
const genMs = Date.now() - t0;

console.log(`mapa ${g.w}x${g.h} gerado em ${genMs}ms | terra: ${g.landTiles} tiles (${((g.landTiles / (g.w * g.h)) * 100).toFixed(1)}%)`);
console.log(`spawns: ${g.players.map((p) => p.tiles).join(', ')} tiles iniciais\n`);

const dt = 1 / TICK_HZ;
const ticks = SIM_SECONDS * TICK_HZ;
const t1 = Date.now();
let lastReport = 0;
let changesTotal = 0;

for (let i = 0; i < ticks; i++) {
  g.tick(dt);
  if (i % 2 === 0) changesTotal += g.collectChanges(2500).length;
  if (g.state === 'over') {
    console.log(`\n=== FIM em ${g.time.toFixed(0)}s — vencedor: ${g.winner >= 0 ? g.players[g.winner].name : 'ninguem'} (${g.winReason}) ===`);
    break;
  }
  const sec = Math.floor(g.time);
  if (sec - lastReport >= 60) {
    lastReport = sec;
    g.snapshotPlayers();
    const alive = g.players.filter((p) => p.alive && !p.removed);
    const top = [...alive].sort((a, b) => b.tiles - a.tiles)[0];
    console.log(
      `t=${String(sec).padStart(4)}s | vivos=${alive.length}/${g.players.length} | ` +
        `lider=${top ? top.name : '-'} ${top ? Math.round((top.tiles / g.landTiles) * 1000) / 10 : 0}% | ` +
        `ouro=[${alive.map((p) => p.gold).join(',')}]`
    );
  }
}

const elapsed = Date.now() - t1;
g.snapshotPlayers();
console.log(`\nsimulacao: ${(g.time).toFixed(0)}s de jogo em ${elapsed}ms reais (${(g.time / (elapsed / 1000)).toFixed(1)}x tempo real)`);
console.log(`diffs emitidos: ${changesTotal} (${(changesTotal / (g.time * 0.5)).toFixed(0)}/broadcast)`);
console.log('\nplacar final:');
for (const p of [...g.players].sort((a, b) => b.tiles - a.tiles)) {
  console.log(
    `  ${p.alive ? '✔' : '✘'} ${p.name.padEnd(18)} tiles=${String(p.tiles).padStart(5)} ` +
      `(${((p.tiles / g.landTiles) * 100).toFixed(1)}%) tropas=${String(Math.round(p.troops)).padStart(7)} ` +
      `ouro=${String(Math.floor(p.gold)).padStart(6)} obras=${p.buildings}`
  );
}

// validacoes
const errs: string[] = [];
if (g.players.some((p) => !Number.isFinite(p.gold))) errs.push('ouro NaN');
for (let i = 0; i < g.n; i++) {
  if (!Number.isFinite(g.troops[i])) {
    errs.push(`tropas NaN no tile ${i}`);
    break;
  }
  if (g.owner[i] >= 0 && g.terrain[i] === 0) {
    errs.push(`tile de agua com dono (${i})`);
    break;
  }
}
const totalOwned = g.players.reduce((s, p) => s + (p.removed ? 0 : p.tiles), 0);
if (totalOwned > g.landTiles) errs.push(`soma de tiles (${totalOwned}) > terra disponivel (${g.landTiles})`);
console.log(errs.length ? `\nERROS: ${errs.join('; ')}` : '\nOK: nenhuma inconsistencia detectada');
process.exit(errs.length ? 1 : 0);
