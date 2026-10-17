import { PLAYER_COLORS } from '@circuit-breaker/shared';

/** The player's neon colour, as a small glowing square. */
export function PlayerSwatch({ color, size = 12 }: { color: number; size?: number }) {
  const hex = PLAYER_COLORS[color] ?? PLAYER_COLORS[0];
  return (
    <span
      className="shrink-0"
      style={{ width: size, height: size, background: hex, boxShadow: `0 0 8px ${hex}` }}
      aria-hidden
    />
  );
}
