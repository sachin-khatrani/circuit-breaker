/** The colour language shared by the scene and the HUD. */
export const PALETTE = {
  cyan: '#19e6ff',
  magenta: '#ff2bd6',
  violet: '#8a5cff',
  amber: '#ffb02e',
  lime: '#c6ff3a',
  red: '#ff3b4f',
  white: '#f4f7ff',
  fog: '#1a0a33',
  skyZenith: '#03020a',
  skyHorizon: '#2a0d52',
  skyGlow: '#ff3fa4',
  ground: '#07050f',
} as const;

/** One colour per sector (checkpoint i to i+1), used by rails, kerbs and gates. */
export const SECTOR_COLORS = [
  PALETTE.cyan,
  PALETTE.magenta,
  PALETTE.violet,
  PALETTE.amber,
] as const;

export function sectorColor(index: number): string {
  return SECTOR_COLORS[
    ((index % SECTOR_COLORS.length) + SECTOR_COLORS.length) % SECTOR_COLORS.length
  ];
}
