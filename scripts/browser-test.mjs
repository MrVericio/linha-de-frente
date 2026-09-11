// Teste de navegador real: abre o jogo, joga um pouco e tira screenshots.
import puppeteer from 'puppeteer';
import { mkdirSync } from 'node:fs';

const BASE = process.env.URL || 'http://127.0.0.1:3000/';
const OUT = new globalThis.URL('../screens/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const errors = [];
const logs = [];

const browser = await puppeteer.launch({
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader'],
  defaultViewport: { width: 1440, height: 860 }
});
const page = await browser.newPage();
page.on('console', (m) => {
  const t = m.type();
  logs.push(`[${t}] ${m.text()}`);
  if (t === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('requestfailed', (r) => errors.push('requestfailed: ' + r.url()));

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✔' : '✘'} ${name}${extra ? ' — ' + extra : ''}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (file) => {
  await page.screenshot({ path: OUT + file });
  console.log(`   📸 ${file}`);
};

try {
  await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 20000 });
  await page.waitForSelector('#menu:not(.hidden)', { timeout: 8000 });
  check('pagina carrega e mostra o menu', true);

  const conn = await page.$eval('#conn', (e) => e.textContent);
  check('websocket conecta', /online/.test(conn), `status="${conn}"`);

  await shot('01-menu.png');

  // lista de salas publicas
  const roomCount = await page.$$eval('#roomlist .room', (n) => n.length);
  check('salas publicas listadas', roomCount >= 1, `${roomCount} salas`);

  // cria sala privada
  await page.$eval('#nameInput', (e) => {
    e.value = 'Testador';
    e.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.click('#btnCreate');
  await page.waitForSelector('#lobby:not(.hidden)', { timeout: 8000 });
  const code = await page.$eval('#lobbyCode', (e) => e.textContent);
  check('cria sala privada e cai no lobby', true, code);
  await shot('02-lobby.png');

  // inicia
  await page.click('#btnStart');
  await page.waitForSelector('#hud:not(.hidden)', { timeout: 15000 });
  check('partida inicia e HUD aparece', true);
  await wait(2500);
  await shot('03-jogo.png');

  // o canvas esta desenhando algo?
  const nonBlank = await page.evaluate(() => {
    const c = document.getElementById('game');
    const ctx = c.getContext('2d', { alpha: false });
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const seen = new Set();
    for (let i = 0; i < d.length; i += 4 * 997) seen.add(`${d[i]},${d[i + 1]},${d[i + 2]}`);
    return seen.size;
  });
  check('canvas renderiza o mapa (cores variadas)', nonBlank > 12, `${nonBlank} cores amostradas`);

  // HUD populado
  const hud = await page.evaluate(() => ({
    name: document.getElementById('meName').textContent,
    gold: document.getElementById('sGold').textContent,
    tiles: document.getElementById('sTiles').textContent,
    troops: document.getElementById('sTroops').textContent,
    rank: document.querySelectorAll('#rankList .rk').length,
    build: document.querySelectorAll('#buildbar .bbtn').length
  }));
  check('HUD mostra stats, placar e barra de construcao',
    hud.rank >= 6 && hud.build === 6 && hud.name.includes('Testador'), JSON.stringify(hud));

  // mede FPS por 2s
  const fps = await page.evaluate(() => new Promise((res) => {
    let n = 0;
    const t0 = performance.now();
    const loop = () => {
      n++;
      if (performance.now() - t0 < 2000) requestAnimationFrame(loop);
      else res(Math.round((n / (performance.now() - t0)) * 1000));
    };
    requestAnimationFrame(loop);
  }));
  check('renderizacao flui a >= 30 fps', fps >= 30, `${fps} fps`);

  // interage: clica no proprio territorio e ataca
  const box = await page.evaluate(() => {
    const c = document.getElementById('game');
    const r = c.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  await page.keyboard.press('c');
  await wait(400);

  // ataque dirigido via hook de depuracao
  const tilesBefore = await page.$eval('#sTiles', (e) => e.textContent);
  // forca maxima de ataque para o teste
  await page.$eval('#ratioRange', (e) => {
    e.value = '100';
    e.dispatchEvent(new Event('input', { bubbles: true }));
  });
  let conquered = false;
  for (let attempt = 0; attempt < 8 && !conquered; attempt++) {
    const pair = await page.evaluate(() => window.__ldf.bestAttackPair());
    if (!pair) break;
    const a = await page.evaluate((i) => window.__ldf.tileToScreen(i), pair.from);
    const bpos = await page.evaluate((i) => window.__ldf.tileToScreen(i), pair.to);
    await page.mouse.click(box.x + a.x, box.y + a.y);
    await wait(150);
    const sel = await page.evaluate(() => window.__ldf.selected);
    await page.mouse.click(box.x + bpos.x, box.y + bpos.y);
    await wait(600);
    const own = await page.evaluate((i) => window.__ldf.world.owner[i], pair.to);
    if (own === 0 && sel >= 0) conquered = true;
  }
  const tilesAfter = await page.$eval('#sTiles', (e) => e.textContent);
  check('clique-seleciona + clique-ataca conquista tile neutro', conquered,
    `territorio ${tilesBefore} -> ${tilesAfter}`);

  await shot('04-apos-interacao.png');

  // construcao: seleciona posto defensivo (tecla 4) e clica em varios pontos
  await page.keyboard.press('4');
  await wait(200);
  const buildOn = await page.$eval('#buildbar .bbtn.on', (e) => e.textContent).catch(() => null);
  check('tecla 4 seleciona construcao na barra', !!buildOn, (buildOn || '').replace(/\s+/g, ' ').trim());
  for (let i = 0; i < 6; i++) {
    await page.mouse.click(box.x + box.w / 2 + (i - 3) * 30, box.y + box.h / 2 + (i % 2) * 26);
    await wait(120);
  }
  await page.keyboard.press('Escape');
  await wait(500);

  // zoom minimo/maximo + pan com WASD
  await page.keyboard.down('d');
  await wait(600);
  await page.keyboard.up('d');
  await page.keyboard.press('q');
  await wait(300);
  await shot('05-zoom-out.png');

  // numeros de tropas (espaco)
  await page.keyboard.press(' ');
  await wait(200);
  await page.keyboard.press(' ');

  // chat
  await page.keyboard.press('Enter');
  await page.type('#chatInput', 'gl hf');
  await page.keyboard.press('Enter');
  await wait(600);
  const chatTxt = await page.$eval('#log', (e) => e.textContent);
  check('chat aparece no log de eventos', chatTxt.includes('gl hf'));

  // deixa a partida rodar um pouco para os bots brigarem
  await wait(12000);
  const late = await page.evaluate(() => ({
    tiles: document.getElementById('sTiles').textContent,
    troops: document.getElementById('sTroops').textContent,
    time: document.getElementById('sTime').textContent,
    log: document.getElementById('log').textContent.slice(-240)
  }));
  check('partida segue rodando (bots conquistando/construindo)', /construiu|capturou|eliminado|iniciada/.test(late.log),
    `t=${late.time} tiles=${late.tiles} tropas=${late.troops}`);
  await shot('06-tarde.png');

  // ---- modo offline ----
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector('#menu:not(.hidden)');
  await page.click('#btnOffline');
  await page.waitForSelector('#hud:not(.hidden)', { timeout: 10000 });
  await wait(3000);
  const off = await page.evaluate(() => ({
    conn: document.getElementById('conn').textContent,
    rank: document.querySelectorAll('#rankList .rk').length,
    tiles: document.getElementById('sTiles').textContent,
    time: document.getElementById('sTime').textContent
  }));
  check('modo offline roda a simulacao localmente', off.rank >= 6 && off.conn.includes('offline'), JSON.stringify(off));
  await page.keyboard.press('c');
  await wait(600);
  await shot('07-offline.png');
  await wait(6000);
  const off2 = await page.$eval('#sTime', (e) => e.textContent);
  check('relogio do modo offline avanca', off2 !== off.time, `${off.time} -> ${off2}`);
  await shot('08-offline-tarde.png');
} catch (e) {
  console.log('\nERRO:', e.message);
  results.push({ name: 'excecao: ' + e.message, ok: false });
  await shot('99-erro.png').catch(() => {});
}

if (errors.length) {
  console.log('\n--- erros de console ---');
  for (const e of errors.slice(0, 12)) console.log('  ' + e.slice(0, 240));
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} verificações passaram | ${errors.length} erros de console`);
await browser.close();
process.exit(failed.length || errors.length ? 1 : 0);
