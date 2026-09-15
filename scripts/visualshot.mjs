// Screenshots do passe visual: menu, close de construcoes, serras, costa.
import puppeteer from 'puppeteer';
import { mkdirSync } from 'node:fs';

const BASE = process.env.URL || 'http://127.0.0.1:3000/';
const OUT = new globalThis.URL('../screens/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader'],
  defaultViewport: { width: 1440, height: 860 }
});
const page = await browser.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (f) => { await page.screenshot({ path: OUT + f }); console.log('📸', f); };

await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 20000 });
await wait(700);
await shot('12-menu-azul.png');

await page.click('#btnOffline');
await wait(2500);

// acha tile com construcao minha / montanha / costa
const info = await page.evaluate(() => {
  const w = window.__ldf.world;
  let bld = -1, mnt = -1, coast = -1;
  for (let i = 0; i < w.n; i++) {
    if (bld < 0 && w.bld[i] > 0 && w.owner[i] === w.you) bld = i;
    if (mnt < 0 && w.terrain[i] === 2) mnt = i;
  }
  if (bld < 0) for (let i = 0; i < w.n; i++) if (w.bld[i] > 0) { bld = i; break; }
  outer: for (let y = 1; y < w.h - 1; y++) {
    for (let x = 1; x < w.w - 1; x++) {
      const i = y * w.w + x;
      if (w.terrain[i] !== 0) continue;
      // agua com terra em 2 vizinhos = enseada bonita
      let land = 0;
      for (const j of [i - 1, i + 1, i - w.w, i + w.w]) if (w.terrain[j] !== 0) land++;
      if (land >= 2) { coast = i; break outer; }
    }
  }
  return { bld, mnt, coast };
});
console.log('alvos:', JSON.stringify(info));

if (info.bld >= 0) {
  await page.evaluate((i) => window.__ldf.centerOnTile(i, 16), info.bld);
  await wait(600);
  await shot('13-close-construcoes.png');
}
if (info.mnt >= 0) {
  await page.evaluate((i) => window.__ldf.centerOnTile(i, 9), info.mnt);
  await wait(600);
  await shot('14-serras.png');
}
if (info.coast >= 0) {
  await page.evaluate((i) => window.__ldf.centerOnTile(i, 11), info.coast);
  await wait(600);
  await shot('15-costa.png');
}

console.log(errors.length ? 'ERROS: ' + errors.join(' | ') : 'sem erros de console');
await browser.close();
