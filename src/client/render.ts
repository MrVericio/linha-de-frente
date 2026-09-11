import { T, B, NUKE_RANGE, NUKE_R_CORE, NUKE_R_OUTER } from '../shared/constants.js';
import type { Region, World } from './state.js';

export interface ExpandMarker {
  tile: number;
  hue: number;
  me: boolean;
}

export interface Camera {
  x: number; // centro da camera em coordenadas de mundo (pixels)
  y: number;
  zoom: number; // pixels por tile
}

export interface Explosion {
  x: number;
  y: number;
  t: number; // tempo de inicio (ms)
}

export interface Scene {
  world: World;
  cam: Camera;
  selected: number;
  hover: number;
  path: number[] | null;
  buildType: number;
  nukeMode: boolean;
  showNumbers: boolean;
  explosions: Explosion[];
  now: number;
  validBuild: boolean;
  regions: Region[];
  expandTargets: ExpandMarker[];
}

const colorCache = new Map<string, string>();
function hsl(h: number, s: number, l: number, a = 1): string {
  const key = `${h | 0},${s | 0},${l | 0},${a}`;
  let c = colorCache.get(key);
  if (!c) {
    c = a >= 1 ? `hsl(${h | 0} ${s | 0}% ${l | 0}%)` : `hsla(${h | 0} ${s | 0}% ${l | 0}% / ${a})`;
    colorCache.set(key, c);
  }
  return c;
}

export class Renderer {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  mini: HTMLCanvasElement;
  mctx: CanvasRenderingContext2D;
  dpr = 1;
  vw = 0;
  vh = 0;
  private lastMini = 0;
  /** camada base (terreno+territorio) em 1px/tile, refeita barato a cada frame */
  private layer: HTMLCanvasElement | null = null;
  private layerCtx: CanvasRenderingContext2D | null = null;
  private layerImg: ImageData | null = null;
  private layerRev = -1;

  constructor(canvas: HTMLCanvasElement, mini: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    this.mini = mini;
    this.mctx = mini.getContext('2d')!;
    this.resize();
  }

  resize(): void {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    const rect = this.canvas.getBoundingClientRect();
    this.vw = Math.max(320, rect.width);
    this.vh = Math.max(240, rect.height);
    this.canvas.width = Math.floor(this.vw * this.dpr);
    this.canvas.height = Math.floor(this.vh * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  screenToTile(px: number, py: number, cam: Camera, w: World): number {
    const tx = Math.floor((px - this.vw / 2) / cam.zoom + cam.x / cam.zoom);
    const ty = Math.floor((py - this.vh / 2) / cam.zoom + cam.y / cam.zoom);
    if (tx < 0 || ty < 0 || tx >= w.w || ty >= w.h) return -1;
    return ty * w.w + tx;
  }

  clampCamera(cam: Camera, w: World): void {
    const worldW = w.w * cam.zoom;
    const worldH = w.h * cam.zoom;
    const minX = Math.min(worldW / 2, this.vw / 2);
    const minY = Math.min(worldH / 2, this.vh / 2);
    cam.x = Math.max(minX - 80, Math.min(worldW - minX + 80, cam.x));
    cam.y = Math.max(minY - 80, Math.min(worldH - minY + 80, cam.y));
  }

  draw(s: Scene): void {
    const { ctx } = this;
    const w = s.world;
    const cam = s.cam;
    const z = cam.zoom;

    ctx.fillStyle = '#0a1420';
    ctx.fillRect(0, 0, this.vw, this.vh);
    if (!w.n) return;

    const x0 = Math.max(0, Math.floor((cam.x - this.vw / 2) / z));
    const y0 = Math.max(0, Math.floor((cam.y - this.vh / 2) / z));
    const x1 = Math.min(w.w - 1, Math.ceil((cam.x + this.vw / 2) / z));
    const y1 = Math.min(w.h - 1, Math.ceil((cam.y + this.vh / 2) / z));
    const ox = this.vw / 2 - cam.x;
    const oy = this.vh / 2 - cam.y;

    // ------- terreno + territorio (camada base 1px/tile, upscale) -------
    if (!this.layer || this.layer.width !== w.w || this.layer.height !== w.h) {
      this.layer = document.createElement('canvas');
      this.layer.width = w.w;
      this.layer.height = w.h;
      this.layerCtx = this.layer.getContext('2d')!;
      this.layerImg = this.layerCtx.createImageData(w.w, w.h);
    }
    if (this.layerRev !== w.rev) {
      this.layerRev = w.rev;
      const img = this.layerImg!;
      const data = img.data;
      const colorCacheLocal = layerColorCache;
      for (let i = 0; i < w.n; i++) {
        const ter = w.terrain[i];
        const own = w.owner[i];
        let rgb: number[];
        if (ter === T.WATER) {
          rgb = w.shallow[i] ? colorCacheLocal.waterShallow : colorCacheLocal.waterDeep;
        } else if (own >= 0) {
          const p = w.playerById(own);
          const hue = p ? p.hue : 0;
          const dead = !!p && !p.alive;
          rgb = ter === T.MOUNTAIN ? terrRgb(hue, true, dead) : terrRgb(hue, false, dead);
        } else {
          rgb = ter === T.MOUNTAIN ? colorCacheLocal.neutralMountain : colorCacheLocal.neutralLand;
        }
        const sh = ((w.shade[i] % 24) - 12) * 0.28;
        const o = i * 4;
        data[o] = clamp255(rgb[0] + sh);
        data[o + 1] = clamp255(rgb[1] + sh);
        data[o + 2] = clamp255(rgb[2] + sh);
        data[o + 3] = 255;
      }
      this.layerCtx!.putImageData(img, 0, 0);
    }
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.layer, 0, 0, w.w, w.h, Math.round(ox), Math.round(oy), Math.ceil(w.w * z) + 1, Math.ceil(w.h * z) + 1);

    // ------- fronteiras -------
    if (z >= 4.5) {
      ctx.lineWidth = Math.max(1, z * 0.09);
      ctx.strokeStyle = 'rgba(6,10,16,0.55)';
      ctx.beginPath();
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const i = y * w.w + x;
          if (w.terrain[i] === T.WATER) continue;
          const o = w.owner[i];
          if (x + 1 <= x1) {
            const j = i + 1;
            if (w.terrain[j] !== T.WATER && w.owner[j] !== o) {
              const px = Math.round(ox + (x + 1) * z);
              ctx.moveTo(px, Math.round(oy + y * z));
              ctx.lineTo(px, Math.round(oy + (y + 1) * z));
            }
          }
          if (y + 1 <= y1) {
            const j = i + w.w;
            if (w.terrain[j] !== T.WATER && w.owner[j] !== o) {
              const py = Math.round(oy + (y + 1) * z);
              ctx.moveTo(Math.round(ox + x * z), py);
              ctx.lineTo(Math.round(ox + (x + 1) * z), py);
            }
          }
        }
      }
      ctx.stroke();
    }

    // ------- caminho / selecao / hover -------
    if (s.path && s.path.length) {
      ctx.fillStyle = 'rgba(255,255,255,0.20)';
      for (const i of s.path) {
        const x = i % w.w;
        const y = Math.floor(i / w.w);
        ctx.fillRect(ox + x * z, oy + y * z, z, z);
      }
    }
    const markTile = (i: number, color: string, lw: number) => {
      if (i < 0) return;
      const x = i % w.w;
      const y = Math.floor(i / w.w);
      ctx.strokeStyle = color;
      ctx.lineWidth = lw;
      ctx.strokeRect(ox + x * z + lw / 2, oy + y * z + lw / 2, z - lw, z - lw);
    };
    markTile(s.hover, 'rgba(255,255,255,0.45)', Math.max(1, z * 0.08));
    markTile(s.selected, 'rgba(255,235,120,0.95)', Math.max(1.5, z * 0.14));

    // ------- construcoes -------
    if (z >= 5.5) {
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const i = y * w.w + x;
          const b = w.bld[i];
          if (b === B.NONE) continue;
          const cx = ox + (x + 0.5) * z;
          const cy = oy + (y + 0.5) * z;
          this.drawBuilding(b, cx, cy, z, w.owner[i], w);
        }
      }
    }

    // ------- numeros de tropas: UM por regiao, centralizado -------
    if (s.showNumbers) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const r of s.regions) {
        if (r.tiles <= 0 || r.troops < 1) continue;
        const lx = ox + ((r.label % w.w) + 0.5) * z;
        const ly = oy + (Math.floor(r.label / w.w) + 0.5) * z;
        if (lx < -60 || ly < -60 || lx > this.vw + 60 || ly > this.vh + 60) continue;
        const fs = Math.max(12, Math.min(76, Math.sqrt(r.tiles) * z * 0.36));
        ctx.font = `800 ${fs}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
        ctx.lineWidth = Math.max(2.5, fs * 0.22);
        ctx.strokeStyle = 'rgba(0,0,0,0.72)';
        ctx.fillStyle = r.owner === w.you ? '#ffffff' : 'rgba(255,255,255,0.94)';
        const label = fmtTroops(r.troops);
        ctx.strokeText(label, lx, ly);
        ctx.fillText(label, lx, ly);
      }
      // numero auxiliar do tile sob o cursor / selecionado
      const aux = [s.hover, s.selected];
      ctx.font = `700 ${Math.max(9, Math.min(15, z * 0.4))}px system-ui, sans-serif`;
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      for (const i of aux) {
        if (i < 0 || i >= w.n || w.terrain[i] === T.WATER || w.troops[i] < 1) continue;
        const lx = ox + ((i % w.w) + 0.5) * z;
        const ly = oy + (Math.floor(i / w.w) + 0.12) * z;
        ctx.strokeText(String(w.troops[i]), lx, ly);
        ctx.fillText(String(w.troops[i]), lx, ly);
      }
    }

    // ------- marcadores de ordem de expansao -------
    for (const et of s.expandTargets) {
      if (et.tile < 0 || et.tile >= w.n) continue;
      const ex = ox + ((et.tile % w.w) + 0.5) * z;
      const ey = oy + (Math.floor(et.tile / w.w) + 0.5) * z;
      if (ex < -80 || ey < -80 || ex > this.vw + 80 || ey > this.vh + 80) continue;
      const pulse = (s.now % 900) / 900;
      const col = `hsl(${et.hue} 85% 62%)`;
      ctx.save();
      ctx.strokeStyle = col;
      ctx.lineWidth = Math.max(1.5, z * 0.1);
      ctx.globalAlpha = 0.95 - pulse * 0.55;
      ctx.beginPath();
      ctx.arc(ex, ey, z * (0.55 + pulse * 0.75), 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
      // bandeirinha
      const fs = Math.max(8, z * 0.5);
      ctx.beginPath();
      ctx.moveTo(ex, ey - fs * 1.1);
      ctx.lineTo(ex, ey + fs * 0.5);
      ctx.moveTo(ex, ey - fs * 1.1);
      ctx.lineTo(ex + fs * 0.85, ey - fs * 0.75);
      ctx.lineTo(ex, ey - fs * 0.4);
      ctx.strokeStyle = et.me ? '#ffffff' : col;
      ctx.lineWidth = Math.max(1.5, z * 0.09);
      ctx.stroke();
      ctx.restore();
    }

    // ------- modo missil -------
    if (s.nukeMode && w.you >= 0) {
      const silos = w.mySiloTiles(w.you);
      ctx.save();
      ctx.setLineDash([Math.max(3, z * 0.4), Math.max(3, z * 0.4)]);
      ctx.strokeStyle = 'rgba(255,90,90,0.55)';
      ctx.lineWidth = Math.max(1, z * 0.08);
      for (const sI of silos) {
        const x = ox + ((sI % w.w) + 0.5) * z;
        const y = oy + (Math.floor(sI / w.w) + 0.5) * z;
        ctx.beginPath();
        ctx.arc(x, y, NUKE_RANGE * z, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
      if (s.hover >= 0) {
        const hx = ox + ((s.hover % w.w) + 0.5) * z;
        const hy = oy + (Math.floor(s.hover / w.w) + 0.5) * z;
        ctx.fillStyle = 'rgba(255,60,40,0.30)';
        ctx.beginPath();
        ctx.arc(hx, hy, NUKE_R_OUTER * z, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(255,180,60,0.45)';
        ctx.beginPath();
        ctx.arc(hx, hy, NUKE_R_CORE * z, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // ------- ghost de construcao -------
    if (s.buildType !== B.NONE && s.hover >= 0 && z >= 5) {
      const x = ox + ((s.hover % w.w) + 0.5) * z;
      const y = oy + (Math.floor(s.hover / w.w) + 0.5) * z;
      ctx.globalAlpha = 0.55;
      this.drawBuilding(s.buildType, x, y, z, w.you, w);
      ctx.globalAlpha = 1;
      markTile(s.hover, s.validBuild ? 'rgba(120,255,160,0.9)' : 'rgba(255,90,90,0.9)', Math.max(1.5, z * 0.12));
    }

    // ------- explosoes -------
    for (const ex of s.explosions) {
      const age = (s.now - ex.t) / 1400;
      if (age < 0 || age > 1) continue;
      const px = ox + ex.x * z;
      const py = oy + ex.y * z;
      const r = (NUKE_R_OUTER * z) * (0.25 + age * 1.1);
      const g = ctx.createRadialGradient(px, py, 0, px, py, Math.max(1, r));
      const alpha = 1 - age;
      g.addColorStop(0, `rgba(255,255,240,${0.95 * alpha})`);
      g.addColorStop(0.35, `rgba(255,190,70,${0.75 * alpha})`);
      g.addColorStop(0.7, `rgba(255,80,30,${0.4 * alpha})`);
      g.addColorStop(1, 'rgba(120,20,10,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(px, py, Math.max(1, r), 0, Math.PI * 2);
      ctx.fill();
    }

    // ------- vinheta -------
    const vg = ctx.createRadialGradient(this.vw / 2, this.vh / 2, Math.min(this.vw, this.vh) * 0.35, this.vw / 2, this.vh / 2, Math.max(this.vw, this.vh) * 0.75);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.35)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, this.vw, this.vh);

    // ------- minimapa -------
    if (s.now - this.lastMini > 400) {
      this.lastMini = s.now;
      this.drawMinimap(w);
    }
    this.drawMiniViewport(w, cam);
  }

  private drawBuilding(b: number, cx: number, cy: number, z: number, owner: number, w: World): void {
    const ctx = this.ctx;
    const p = owner >= 0 ? w.playerById(owner) : undefined;
    const hue = p ? p.hue : 0;
    const s = z * 0.34;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.lineWidth = Math.max(1, z * 0.06);
    ctx.strokeStyle = 'rgba(8,12,18,0.85)';
    ctx.fillStyle = hsl(hue, 20, 92);
    if (b === B.CITY) {
      ctx.fillStyle = hsl(hue, 25, 94);
      ctx.fillRect(-s, -s * 0.5, s * 0.55, s * 1.5);
      ctx.fillRect(-s * 0.25, -s, s * 0.6, s * 2);
      ctx.fillRect(s * 0.5, -s * 0.2, s * 0.5, s * 1.2);
      ctx.strokeRect(-s, -s, s * 2, s * 2);
    } else if (b === B.OUTPOST) {
      ctx.beginPath();
      ctx.moveTo(0, -s * 1.15);
      ctx.lineTo(s * 1.05, s * 0.95);
      ctx.lineTo(-s * 1.05, s * 0.95);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    } else if (b === B.PORT) {
      ctx.beginPath();
      ctx.arc(0, 0, s * 0.95, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-s * 0.75, s * 0.15);
      ctx.lineTo(s * 0.75, s * 0.15);
      ctx.moveTo(0, -s * 0.7);
      ctx.lineTo(0, s * 0.8);
      ctx.strokeStyle = hsl(hue, 45, 30);
      ctx.stroke();
    } else if (b === B.SILO) {
      ctx.beginPath();
      ctx.moveTo(0, -s * 1.2);
      ctx.lineTo(s * 0.85, 0);
      ctx.lineTo(0, s * 1.2);
      ctx.lineTo(-s * 0.85, 0);
      ctx.closePath();
      ctx.fillStyle = '#ffd7d0';
      ctx.fill();
      ctx.strokeStyle = 'rgba(120,20,10,0.9)';
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, s * 0.3, 0, Math.PI * 2);
      ctx.fillStyle = '#c22';
      ctx.fill();
    }
    ctx.restore();
  }

  private drawMinimap(w: World): void {
    const mw = this.mini.width;
    const mh = this.mini.height;
    const img = this.mctx.createImageData(mw, mh);
    const sx = mw / w.w;
    const sy = mh / w.h;
    const data = img.data;
    for (let y = 0; y < w.h; y++) {
      for (let x = 0; x < w.w; x++) {
        const i = y * w.w + x;
        const ter = w.terrain[i];
        const own = w.owner[i];
        let r: number, g: number, b: number;
        if (ter === T.WATER) {
          r = 16; g = 38; b = 62;
        } else if (own >= 0) {
          const p = w.playerById(own);
          const c = hueToRgb(p ? p.hue : 0, p && !p.alive ? 0.4 : 0.62, 0.5);
          r = c[0]; g = c[1]; b = c[2];
        } else {
          r = ter === T.MOUNTAIN ? 96 : 116;
          g = ter === T.MOUNTAIN ? 92 : 122;
          b = ter === T.MOUNTAIN ? 84 : 96;
        }
        const px0 = Math.floor(x * sx);
        const py0 = Math.floor(y * sy);
        const px1 = Math.max(px0 + 1, Math.floor((x + 1) * sx));
        const py1 = Math.max(py0 + 1, Math.floor((y + 1) * sy));
        for (let py = py0; py < py1 && py < mh; py++) {
          for (let px = px0; px < px1 && px < mw; px++) {
            const o = (py * mw + px) * 4;
            data[o] = r;
            data[o + 1] = g;
            data[o + 2] = b;
            data[o + 3] = 255;
          }
        }
      }
    }
    this.mctx.putImageData(img, 0, 0);
  }

  private drawMiniViewport(w: World, cam: Camera): void {
    const mw = this.mini.width;
    const mh = this.mini.height;
    const z = cam.zoom;
    const vx = ((cam.x - this.vw / 2) / z / w.w) * mw;
    const vy = ((cam.y - this.vh / 2) / z / w.h) * mh;
    const vw = (this.vw / z / w.w) * mw;
    const vh = (this.vh / z / w.h) * mh;
    this.mctx.strokeStyle = 'rgba(255,255,255,0.85)';
    this.mctx.lineWidth = 1.5;
    this.mctx.strokeRect(vx, vy, vw, vh);
  }

  miniToTile(px: number, py: number, w: World): number {
    const rect = this.mini.getBoundingClientRect();
    const x = Math.floor(((px - rect.left) / rect.width) * w.w);
    const y = Math.floor(((py - rect.top) / rect.height) * w.h);
    if (x < 0 || y < 0 || x >= w.w || y >= w.h) return -1;
    return y * w.w + x;
  }
}

function hueToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

// ---------------------------------------------------------------
// Camada base: cores em RGB para preencher ImageData sem strings
// ---------------------------------------------------------------
function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}

const terrCache = new Map<string, number[]>();
function terrRgb(hue: number, mountain: boolean, dead: boolean): number[] {
  const key = `${hue}|${mountain ? 1 : 0}|${dead ? 1 : 0}`;
  let c = terrCache.get(key);
  if (!c) {
    c = hueToRgb(hue, mountain ? (dead ? 17 : 34) : (dead ? 28 : 56), mountain ? (dead ? 20 : 30) : (dead ? 30 : 44));
    terrCache.set(key, c);
  }
  return c;
}

const layerColorCache = {
  waterDeep: [14, 34, 58],
  waterShallow: [24, 52, 78],
  neutralLand: [112, 120, 96],
  neutralMountain: [96, 92, 84]
};

function fmtTroops(t: number): string {
  if (t >= 1e6) return `${(t / 1e6).toFixed(1)}M`;
  if (t >= 1e4) return `${(t / 1e3).toFixed(1)}k`;
  if (t >= 1000) return `${(t / 1e3).toFixed(2)}k`;
  return String(Math.round(t));
}
