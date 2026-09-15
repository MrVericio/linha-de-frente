// Detector de sobreposicao de HUD em varias resolucoes.
import puppeteer from 'puppeteer';
import { mkdirSync } from 'node:fs';

const BASE = process.env.URL || 'http://127.0.0.1:3000/';
const OUT = new globalThis.URL('../screens/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  [1440, 860], [1280, 800], [1024, 700], [800, 600]
];
const IDS = ['#topbar', '#rank', '#hint', '#buildbar', '#logwrap', '#minibox', '#ratio'];

const browser = await puppeteer.launch({
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader'],
  defaultViewport: { width: 1440, height: 860 }
});
const page = await browser.newPage();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 20000 });
await page.click('#btnOffline');
await wait(2000);

let bad = 0;
for (const [w, h] of VIEWPORTS) {
  await page.setViewport({ width: w, height: h });
  await wait(600);
  const boxes = await page.evaluate((ids) => {
    const out = {};
    for (const id of ids) {
      const el = document.querySelector(id);
      if (!el) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      out[id] = { x: r.x, y: r.y, w: r.width, h: r.height };
    }
    return out;
  }, IDS);
  const keys = Object.keys(boxes);
  const overlaps = [];
  for (let a = 0; a < keys.length; a++) {
    for (let b = a + 1; b < keys.length; b++) {
      const A = boxes[keys[a]], B = boxes[keys[b]];
      const ix = Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x);
      const iy = Math.min(A.y + A.h, B.y + B.h) - Math.max(A.y, B.y);
      if (ix > 4 && iy > 4) overlaps.push(`${keys[a]}x${keys[b]} ${Math.round(ix)}x${Math.round(iy)}px`);
    }
  }
  // fora da tela?
  const off = keys.filter((k) => {
    const B = boxes[k];
    return B.x < -4 || B.y < -4 || B.x + B.w > w + 4 || B.y + B.h > h + 4;
  });
  const ok = overlaps.length === 0 && off.length === 0;
  if (!ok) bad++;
  console.log(`${ok ? '✔' : '✘'} ${w}x${h}${overlaps.length ? ' | sobrepoe: ' + overlaps.join(', ') : ''}${off.length ? ' | fora: ' + off.join(',') : ''}`);
  await page.screenshot({ path: `${OUT}16-ui-${w}.png` });
}
console.log(bad ? `\n${bad} resolucoes com problema` : '\ntodas as resolucoes limpas');
await browser.close();
process.exit(bad ? 1 : 0);
