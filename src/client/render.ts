import { T, B, NUKE_RANGE, NUKE_R_CORE, NUKE_R_OUTER } from '../shared/constants.js';
import type { Region, World } from './state.js';

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
  /** contornos suavizados (costa + dono), retracejados só quando o mundo muda */
  private contours: { rev: number; land: number[][]; owners: Map<number, number[][]> } | null = null;

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

    ctx.fillStyle = '#0a1628';
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
    ctx.imageSmoothingEnabled = true; // blend bilinear: transicoes "onduladas" entre territorios
    ctx.drawImage(this.layer, 0, 0, w.w, w.h, Math.round(ox), Math.round(oy), Math.ceil(w.w * z) + 1, Math.ceil(w.h * z) + 1);
    ctx.imageSmoothingEnabled = false;

    // ------- contornos organicos (costa + fronteiras) -------
    if (!this.contours || this.contours.rev !== w.rev) this.contours = this.buildContours(w);
    const cont = this.contours;
    for (const loop of cont.land) {
      this.strokeSmooth(loop, z, ox, oy, 'rgba(4,8,14,0.9)', Math.max(2, z * 0.16));
    }
    for (const loops of cont.owners.values()) {
      for (const loop of loops) {
        this.strokeSmooth(loop, z, ox, oy, 'rgba(5,8,13,0.95)', Math.max(1.8, z * 0.14));
        this.strokeSmooth(loop, z, ox, oy, 'rgba(255,255,255,0.10)', Math.max(1, z * 0.05));
      }
    }

    // ------- serras: cristas estilizadas sobre montanhas -------
    if (z >= 6) {
      const snow: number[] = [];
      ctx.beginPath();
      let hasRidge = false;
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const i = y * w.w + x;
          if (w.terrain[i] !== T.MOUNTAIN) continue;
          hasRidge = true;
          const cx = ox + (x + 0.5) * z;
          const cy = oy + (y + 0.5) * z;
          const t = w.shade[i] % 5;
          const jx = (t - 2) * z * 0.03;
          const h1 = z * (0.2 + (t % 3) * 0.02);
          ctx.moveTo(cx - 0.3 * z + jx, cy + 0.2 * z);
          ctx.lineTo(cx - 0.07 * z + jx, cy - h1);
          ctx.lineTo(cx + 0.16 * z + jx, cy + 0.2 * z);
          ctx.moveTo(cx + 0.02 * z + jx, cy + 0.2 * z);
          ctx.lineTo(cx + 0.2 * z + jx, cy - h1 * 0.55);
          ctx.lineTo(cx + 0.38 * z + jx, cy + 0.2 * z);
          snow.push(
            cx - 0.14 * z + jx, cy - h1 * 0.42,
            cx - 0.07 * z + jx, cy - h1,
            cx + 0.0 * z + jx, cy - h1 * 0.42
          );
        }
      }
      if (hasRidge) {
        ctx.strokeStyle = 'rgba(8,12,18,0.42)';
        ctx.lineWidth = Math.max(1, z * 0.05);
        ctx.stroke();
      }
      if (snow.length) {
        ctx.beginPath();
        for (let k = 0; k < snow.length; k += 6) {
          ctx.moveTo(snow[k], snow[k + 1]);
          ctx.lineTo(snow[k + 2], snow[k + 3]);
          ctx.lineTo(snow[k + 4], snow[k + 5]);
        }
        ctx.strokeStyle = 'rgba(255,255,255,0.38)';
        ctx.lineWidth = Math.max(1, z * 0.045);
        ctx.stroke();
      }
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
    const s = z * 0.40;
    const lw = Math.max(1, z * 0.05);
    const ink = 'rgba(6,10,16,0.92)';
    const paper = hsl(hue, 18, 93);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.lineJoin = 'round';
    ctx.lineWidth = lw;
    ctx.strokeStyle = ink;
    if (b === B.CITY) {
      // skyline: tres torres ameadas com contorno
      const towers: [number, number, number, number][] = [
        [-s * 1.0, -s * 0.45, s * 0.62, s * 1.5],
        [-s * 0.3, -s * 1.05, s * 0.66, s * 2.1],
        [s * 0.45, -s * 0.2, s * 0.58, s * 1.25]
      ];
      ctx.fillStyle = paper;
      for (const [tx, ty, tw, th] of towers) {
        ctx.fillRect(tx, ty, tw, th);
        ctx.strokeRect(tx, ty, tw, th);
      }
      // ameias na torre central
      ctx.fillStyle = ink;
      ctx.fillRect(-s * 0.3, -s * 1.05, s * 0.16, s * 0.16);
      ctx.fillRect(-s * 0.02, -s * 1.05, s * 0.16, s * 0.16);
      ctx.fillRect(s * 0.22, -s * 1.05, s * 0.14, s * 0.16);
      // janelas quando o zoom permite
      if (z >= 10) {
        ctx.fillStyle = 'rgba(20,30,46,0.55)';
        const ws = Math.max(1, z * 0.05);
        for (const [tx, ty, tw, th] of towers) {
          ctx.fillRect(tx + tw * 0.3, ty + th * 0.22, ws, ws);
          ctx.fillRect(tx + tw * 0.3, ty + th * 0.5, ws, ws);
        }
      }
    } else if (b === B.OUTPOST) {
      // escudo com faixa na cor do dono
      ctx.beginPath();
      ctx.moveTo(0, -s * 1.15);
      ctx.lineTo(s * 0.92, -s * 0.62);
      ctx.lineTo(s * 0.92, s * 0.18);
      ctx.quadraticCurveTo(s * 0.92, s * 1.0, 0, s * 1.3);
      ctx.quadraticCurveTo(-s * 0.92, s * 1.0, -s * 0.92, s * 0.18);
      ctx.lineTo(-s * 0.92, -s * 0.62);
      ctx.closePath();
      ctx.fillStyle = paper;
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, -s * 0.72);
      ctx.lineTo(0, s * 0.85);
      ctx.strokeStyle = hsl(hue, 55, 45);
      ctx.lineWidth = Math.max(1.2, z * 0.07);
      ctx.stroke();
    } else if (b === B.PORT) {
      // ancora: traco claro sobre sombra escura
      const draw = (style: string, wL: number) => {
        ctx.strokeStyle = style;
        ctx.lineWidth = wL;
        ctx.beginPath();
        ctx.arc(0, -s * 0.85, s * 0.26, 0, Math.PI * 2); // anel
        ctx.moveTo(0, -s * 0.59);
        ctx.lineTo(0, s * 0.8); // haste
        ctx.moveTo(-s * 0.55, -s * 0.32);
        ctx.lineTo(s * 0.55, -s * 0.32); // cepo
        ctx.moveTo(-s * 0.62, s * 0.36);
        ctx.lineTo(-s * 0.78, s * 0.06); // unha esq
        ctx.moveTo(s * 0.62, s * 0.36);
        ctx.lineTo(s * 0.78, s * 0.06); // unha dir
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(0, s * 0.18, s * 0.62, Math.PI * 0.16, Math.PI * 0.84); // bracos
        ctx.stroke();
      };
      draw('rgba(6,10,16,0.85)', Math.max(2, z * 0.1));
      draw(paper, Math.max(1.2, z * 0.06));
    } else if (b === B.SILO) {
      // missil com estabilizadores e faixa vermelha
      ctx.beginPath();
      ctx.moveTo(0, -s * 1.4);
      ctx.bezierCurveTo(s * 0.5, -s * 0.95, s * 0.5, -s * 0.3, s * 0.44, s * 0.6);
      ctx.lineTo(-s * 0.44, s * 0.6);
      ctx.bezierCurveTo(-s * 0.5, -s * 0.3, -s * 0.5, -s * 0.95, 0, -s * 1.4);
      ctx.closePath();
      ctx.fillStyle = '#f0e7e2';
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-s * 0.42, s * 0.1);
      ctx.lineTo(-s * 0.85, s * 0.75);
      ctx.lineTo(-s * 0.42, s * 0.6);
      ctx.closePath();
      ctx.moveTo(s * 0.42, s * 0.1);
      ctx.lineTo(s * 0.85, s * 0.75);
      ctx.lineTo(s * 0.42, s * 0.6);
      ctx.closePath();
      ctx.fillStyle = '#9c2f24';
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#c22';
      ctx.fillRect(-s * 0.4, -s * 0.35, s * 0.8, s * 0.3);
      ctx.lineWidth = Math.max(0.8, z * 0.03);
      ctx.strokeRect(-s * 0.4, -s * 0.35, s * 0.8, s * 0.3);
    }
    ctx.restore();
  }

  /**
   * Traca o contorno de uma mascara (loops fechados em coordenadas de canto
   * de tile) encadeando as arestas da grade — base para o visual "ondulado".
   */
  private collectLoops(w: World, mask: (i: number) => boolean): number[][] {
    // marching squares nos cantos da grade: cada canto emparelha os stubs de
    // contorno ao seu redor (sela desambiguada pela diagonal preenchida),
    // garantindo loops fechados sem cadeias abertas.
    const m = (x: number, y: number): boolean =>
      x >= 0 && y >= 0 && x < w.w && y < w.h && mask(y * w.w + x);
    const adj = new Map<number, number[]>();
    const link = (a: number, b: number) => {
      let la = adj.get(a);
      if (!la) { la = []; adj.set(a, la); }
      la.push(b);
      let lb = adj.get(b);
      if (!lb) { lb = []; adj.set(b, lb); }
      lb.push(a);
    };
    const H = 262144;
    const hid = (gx: number, gy: number) => gy * 512 + gx; // horizontal em y=gy
    const vid = (gx: number, gy: number) => H + gx * 512 + gy; // vertical em x=gx
    for (let cy = 0; cy <= w.h; cy++) {
      for (let cx = 0; cx <= w.w; cx++) {
        const A = m(cx - 1, cy - 1), B = m(cx, cy - 1), C = m(cx - 1, cy), D = m(cx, cy);
        const u = A !== B, l = A !== C, r = B !== D, d = C !== D;
        const cnt = (u ? 1 : 0) + (l ? 1 : 0) + (r ? 1 : 0) + (d ? 1 : 0);
        if (cnt === 0) continue;
        const U = vid(cx, cy - 1), L = hid(cx - 1, cy), R = hid(cx, cy), Ds = vid(cx, cy);
        if (cnt === 2) {
          const stubs: number[] = [];
          if (u) stubs.push(U);
          if (l) stubs.push(L);
          if (r) stubs.push(R);
          if (d) stubs.push(Ds);
          link(stubs[0], stubs[1]);
        } else if (cnt === 4) {
          if (A && D) { link(U, L); link(R, Ds); } else { link(U, R); link(L, Ds); }
        }
      }
    }
    const pt = (id: number, end: 0 | 1): [number, number] => {
      if (id < H) {
        const gy = Math.floor(id / 512), gx = id % 512;
        return end === 0 ? [gx, gy] : [gx + 1, gy];
      }
      const gx = Math.floor((id - H) / 512), gy = (id - H) % 512;
      return end === 0 ? [gx, gy] : [gx, gy + 1];
    };
    const loops: number[][] = [];
    const used = new Set<number>();
    for (const startId of adj.keys()) {
      if (used.has(startId)) continue;
      const loop: number[] = [];
      let cur = startId;
      let fromEnd: 0 | 1 = 0;
      let guard = 0;
      while (guard++ < 200000) {
        used.add(cur);
        const p0 = pt(cur, 0), p1 = pt(cur, 1);
        const fe: number = fromEnd;
        const enter: [number, number] = fe === 0 ? p0 : p1;
        const exit: [number, number] = fe === 0 ? p1 : p0;
        loop.push(enter[0], enter[1]);
        let next = -1;
        for (const c of adj.get(cur) ?? []) {
          if (used.has(c)) continue;
          const q0 = pt(c, 0), q1 = pt(c, 1);
          if ((q0[0] === exit[0] && q0[1] === exit[1]) || (q1[0] === exit[0] && q1[1] === exit[1])) { next = c; break; }
        }
        if (next < 0) break;
        const q0 = pt(next, 0);
        fromEnd = q0[0] === exit[0] && q0[1] === exit[1] ? 0 : 1;
        cur = next;
        if (cur === startId) break;
      }
      if (loop.length >= 8) loops.push(loop);
    }
    return loops;
  }

  private buildContours(w: World): { rev: number; land: number[][]; owners: Map<number, number[][]> } {
    const land = this.collectLoops(w, (i) => w.terrain[i] !== T.WATER);
    const owners = new Map<number, number[][]>();
    for (const p of w.players) {
      if (!p.alive) continue;
      const id = p.id;
      const loops = this.collectLoops(w, (i) => w.owner[i] === id);
      if (loops.length) owners.set(id, loops);
    }
    return { rev: w.rev, land, owners };
  }

  /** Desenha um loop suavizado (quadraticas pelos pontos medios) — o efeito "onda". */
  private strokeSmooth(loop: number[], z: number, ox: number, oy: number, style: string, lw: number): void {
    const ctx = this.ctx;
    const n = loop.length / 2;
    if (n < 3) return;
    // culling rapido por bbox
    let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
    for (let k = 0; k < n; k++) {
      const x = loop[k * 2], y = loop[k * 2 + 1];
      if (x < minx) minx = x;
      if (y < miny) miny = y;
      if (x > maxx) maxx = x;
      if (y > maxy) maxy = y;
    }
    if (ox + maxx * z < -40 || ox + minx * z > this.vw + 40 || oy + maxy * z < -40 || oy + miny * z > this.vh + 40) return;
    const px = (k: number): number => ox + loop[(k % n) * 2] * z;
    const py = (k: number): number => oy + loop[(k % n) * 2 + 1] * z;
    ctx.beginPath();
    ctx.moveTo((px(0) + px(1)) / 2, (py(0) + py(1)) / 2);
    for (let k = 1; k <= n; k++) {
      const a = k % n;
      const b = (k + 1) % n;
      ctx.quadraticCurveTo(px(a), py(a), (px(a) + px(b)) / 2, (py(a) + py(b)) / 2);
    }
    ctx.closePath();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = style;
    ctx.lineWidth = lw;
    ctx.stroke();
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
          r = 10; g = 22; b = 40;
        } else if (own >= 0) {
          const p = w.playerById(own);
          const c = hueToRgb(p ? p.hue : 0, p && !p.alive ? 0.4 : 0.5, 0.56);
          r = c[0]; g = c[1]; b = c[2];
        } else {
          r = ter === T.MOUNTAIN ? 92 : 110;
          g = ter === T.MOUNTAIN ? 88 : 118;
          b = ter === T.MOUNTAIN ? 80 : 92;
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
    // preenchimentos "pastel" dessaturados: territorio claro, montanha um tom acima
    // (hueToRgb espera s/l em 0..1)
    const s = (mountain ? (dead ? 14 : 30) : (dead ? 24 : 46)) / 100;
    const l = (mountain ? (dead ? 22 : 40) : (dead ? 30 : 56)) / 100;
    c = hueToRgb(hue, s, l);
    terrCache.set(key, c);
  }
  return c;
}

const layerColorCache = {
  waterDeep: [10, 22, 40],
  waterShallow: [26, 56, 90],
  neutralLand: [110, 118, 92],
  neutralMountain: [92, 88, 80]
};

function fmtTroops(t: number): string {
  if (t >= 1e6) return `${(t / 1e6).toFixed(1)}M`;
  if (t >= 1e4) return `${(t / 1e3).toFixed(1)}k`;
  if (t >= 1000) return `${(t / 1e3).toFixed(2)}k`;
  return String(Math.round(t));
}
