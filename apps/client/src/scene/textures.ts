import { CanvasTexture, LinearFilter, SRGBColorSpace } from 'three';

/** Soft radial white gradient: halos, underglow, particle sprites. */
export function createGlowTexture(size = 128): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.25, 'rgba(255,255,255,0.55)');
    g.addColorStop(0.6, 'rgba(255,255,255,0.12)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

/**
 * Grey-scale soft spot (white centre → black edge, fully opaque pixels). Alpha maps read the
 * green channel, so this works where the alpha-gradient glow texture would not.
 */
export function createSoftSpotTexture(size = 64): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.45, '#bbbbbb');
    g.addColorStop(1, '#000000');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  return new CanvasTexture(canvas);
}

/** Soft bright ring with a dark centre: the smeared look of a fast-spinning rim. */
export function createRingTexture(size = 128): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const c = size / 2;
    const g = ctx.createRadialGradient(c, c, 0, c, c, c);
    g.addColorStop(0, 'rgba(255,255,255,0.05)');
    g.addColorStop(0.55, 'rgba(255,255,255,0.25)');
    g.addColorStop(0.8, 'rgba(255,255,255,1)');
    g.addColorStop(0.92, 'rgba(255,255,255,0.35)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

/** Vertical gradient (opaque at v = 0 → clear at v = 1), used as an alpha map for flames. */
export function createFadeTexture(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const g = ctx.createLinearGradient(0, 64, 0, 0);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.5, '#555555');
    g.addColorStop(1, '#000000');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 4, 64);
  }
  const texture = new CanvasTexture(canvas);
  texture.minFilter = LinearFilter;
  return texture;
}

export interface SignPanel {
  title: string;
  subtitle: string;
  color: string;
  accent: string;
  /** Override for scripts the bundled fonts do not cover. */
  font?: string;
}

/** Billboard ads and the gantry sign. All brands are fictional. */
export const SIGN_PANELS: SignPanel[] = [
  {
    title: 'CIRCUIT BREAKER',
    subtitle: 'GRID ZERO  //  NIGHT SERIES',
    color: '#19e6ff',
    accent: '#ff2bd6',
  },
  { title: 'VOLTA', subtitle: 'DRINK THE SURGE', color: '#c6ff3a', accent: '#19e6ff' },
  { title: 'NEON NOODLE', subtitle: 'OPEN 25 HOURS', color: '#ff2bd6', accent: '#ffb02e' },
  {
    title: 'KAIRO DYNAMICS',
    subtitle: 'ANTI-GRAV SINCE 2089',
    color: '#19e6ff',
    accent: '#8a5cff',
  },
  { title: 'OVERCLOCK', subtitle: 'FEEL EVERY MILLISECOND', color: '#8a5cff', accent: '#ff2bd6' },
  {
    title: 'サーキット',
    subtitle: 'ブレーカー  //  CIRCUIT BREAKER',
    color: '#ff3b4f',
    accent: '#ffb02e',
    font: '"Yu Gothic", "Hiragino Kaku Gothic ProN", "Noto Sans JP", "Meiryo", sans-serif',
  },
  {
    title: 'AMPERE MUTUAL',
    subtitle: 'INSURANCE FOR THE FAST',
    color: '#ffb02e',
    accent: '#ff3b4f',
  },
  {
    title: "DON'T BLINK",
    subtitle: 'BREAKER LEAGUE  //  ROUND 07',
    color: '#ff2bd6',
    accent: '#19e6ff',
  },
  { title: 'ION TUNNEL', subtitle: 'SECTOR 3  //  LIGHTS ON', color: '#8a5cff', accent: '#19e6ff' },
  {
    title: 'SKYWAY',
    subtitle: 'NO BARRIERS  //  STAY ON THE LINE',
    color: '#ffb02e',
    accent: '#ff3b4f',
  },
];

export const ATLAS_COLUMNS = 2;
export const ATLAS_ROWS = 5;
const PANEL_W = 1024;
const PANEL_H = 512;

function fitFont(
  ctx: CanvasRenderingContext2D,
  text: string,
  family: string,
  weight: number,
  start: number,
  maxWidth: number,
): number {
  let size = start;
  ctx.font = `${weight} ${size}px ${family}`;
  while (ctx.measureText(text).width > maxWidth && size > 20) {
    size -= 4;
    ctx.font = `${weight} ${size}px ${family}`;
  }
  return size;
}

function drawPanel(ctx: CanvasRenderingContext2D, panel: SignPanel): void {
  const w = PANEL_W;
  const h = PANEL_H;
  ctx.clearRect(0, 0, w, h);

  const fill = ctx.createLinearGradient(0, 0, 0, h);
  fill.addColorStop(0, `${panel.color}22`);
  fill.addColorStop(1, `${panel.color}06`);
  ctx.fillStyle = fill;
  ctx.fillRect(24, 24, w - 48, h - 48);

  ctx.shadowColor = panel.color;
  ctx.shadowBlur = 22;
  ctx.strokeStyle = panel.color;
  ctx.lineWidth = 6;
  ctx.strokeRect(28, 28, w - 56, h - 56);

  // Corner brackets and a data stripe in the accent colour.
  ctx.strokeStyle = panel.accent;
  ctx.lineWidth = 10;
  for (const [x, y, dx, dy] of [
    [44, 44, 1, 1],
    [w - 44, 44, -1, 1],
    [44, h - 44, 1, -1],
    [w - 44, h - 44, -1, -1],
  ] as const) {
    ctx.beginPath();
    ctx.moveTo(x, y + dy * 60);
    ctx.lineTo(x, y);
    ctx.lineTo(x + dx * 60, y);
    ctx.stroke();
  }
  ctx.fillStyle = panel.accent;
  for (let i = 0; i < 14; i++) ctx.fillRect(w / 2 - 210 + i * 30, h - 92, 18, 10);

  const family = panel.font ?? 'Orbitron, "Arial Black", sans-serif';
  const size = fitFont(ctx, panel.title, family, 900, 150, w - 160);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = panel.color;
  ctx.shadowBlur = 36;
  ctx.fillStyle = '#ffffff';
  ctx.fillText(panel.title, w / 2, h * 0.42);
  ctx.shadowBlur = 0;
  ctx.globalAlpha = 0.9;
  ctx.fillText(panel.title, w / 2, h * 0.42);
  ctx.globalAlpha = 1;

  const subFamily = panel.font ?? 'Rajdhani, "Arial Narrow", sans-serif';
  fitFont(ctx, panel.subtitle, subFamily, 700, Math.round(size * 0.42), w - 220);
  ctx.shadowColor = panel.color;
  ctx.shadowBlur = 16;
  ctx.fillStyle = panel.color;
  ctx.fillText(panel.subtitle, w / 2, h * 0.7);
  ctx.shadowBlur = 0;
}

/**
 * Draws every sign into one atlas texture (one draw call for all billboards). Text uses the
 * bundled fonts, so the atlas is redrawn once they finish loading.
 */
export function createSignAtlas(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = PANEL_W * ATLAS_COLUMNS;
  canvas.height = PANEL_H * ATLAS_ROWS;
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;

  const panelCanvas = document.createElement('canvas');
  panelCanvas.width = PANEL_W;
  panelCanvas.height = PANEL_H;

  const draw = () => {
    const ctx = canvas.getContext('2d');
    const pctx = panelCanvas.getContext('2d');
    if (!ctx || !pctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    SIGN_PANELS.forEach((panel, i) => {
      drawPanel(pctx, panel);
      const col = i % ATLAS_COLUMNS;
      const row = Math.floor(i / ATLAS_COLUMNS);
      ctx.drawImage(panelCanvas, col * PANEL_W, row * PANEL_H);
    });
    texture.needsUpdate = true;
  };
  draw();
  if (typeof document !== 'undefined' && 'fonts' in document) {
    Promise.all([
      document.fonts.load('900 64px Orbitron'),
      document.fonts.load('700 64px Rajdhani'),
    ])
      .then(draw)
      .catch(() => {
        // Fallback fonts are already drawn; nothing else to do.
      });
  }
  return texture;
}

/** UV rectangle (u0, v0, u1, v1) of panel i in the atlas; v grows upward in three.js. */
export function panelUv(i: number): [number, number, number, number] {
  const col = i % ATLAS_COLUMNS;
  const row = Math.floor(i / ATLAS_COLUMNS);
  const u0 = col / ATLAS_COLUMNS;
  const v1 = 1 - row / ATLAS_ROWS;
  return [u0, v1 - 1 / ATLAS_ROWS, u0 + 1 / ATLAS_COLUMNS, v1];
}

let sharedAtlas: CanvasTexture | null = null;

/** The sign atlas is drawn once and shared by the gantry and every billboard. */
export function getSignAtlas(): CanvasTexture {
  sharedAtlas ??= createSignAtlas();
  return sharedAtlas;
}
