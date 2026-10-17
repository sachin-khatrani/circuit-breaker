import { PLAYER_COLORS } from '@circuit-breaker/shared';

/**
 * A side view of a car in its colour, one outline per body style (see VEHICLE_STYLES and
 * buildCarModel): Dart's low wing, Apex's tall wing and fin, Brute's ducktail and roof bar.
 */
export function CarGlyph({
  color,
  style,
  className = 'h-6 w-12',
}: {
  color: number;
  style: number;
  className?: string;
}) {
  const hex = PLAYER_COLORS[color] ?? PLAYER_COLORS[0];
  const line = { fill: 'none', stroke: hex, strokeWidth: 1.6, strokeLinejoin: 'round' as const };
  return (
    <svg
      viewBox="0 0 44 22"
      className={`${className} shrink-0`}
      style={{ filter: `drop-shadow(0 0 4px ${hex})` }}
      aria-hidden
    >
      {/* Body and canopy (the same car under every kit). */}
      <path
        d="M3 15.5 Q4 11.5 10 10.6 L19 8.4 Q27 6.6 33 9.6 L40 13 Q41.5 14.4 40 15.5 Z"
        {...line}
      />
      <path d="M21 8.2 Q25.5 5.6 29.5 8.6" {...line} strokeWidth={1.2} />
      {style === 1 && (
        <>
          {/* Apex: tall wing on a swan neck, and a fin along the spine. */}
          <path d="M5 11 L5.5 4.5 M2.5 4.2 L10.5 4.2" {...line} />
          <path d="M11 10 L14.5 6.6 L17.5 8.8" {...line} strokeWidth={1.2} />
        </>
      )}
      {style === 2 && (
        <>
          {/* Brute: a ducktail spoiler and a light bar on the roof. */}
          <path d="M2.5 11.6 L8.5 10.2" {...line} strokeWidth={2.2} />
          <path d="M22 5.6 L28.5 5.6" {...line} strokeWidth={2} />
        </>
      )}
      {style !== 1 && style !== 2 && (
        /* Dart: a low wing on two short struts. */
        <path d="M6 11 L6.5 7.4 M3 7.2 L11 7.2" {...line} />
      )}
      <circle cx="11" cy="16.5" r="3.4" fill="#05060c" stroke={hex} strokeWidth="1.6" />
      <circle cx="33" cy="16.5" r="3.4" fill="#05060c" stroke={hex} strokeWidth="1.6" />
    </svg>
  );
}
