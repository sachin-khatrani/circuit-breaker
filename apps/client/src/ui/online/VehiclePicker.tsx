import {
  PLAYER_COLOR_NAMES,
  PLAYER_COLORS,
  VEHICLE_STYLES,
  type LobbyPlayer,
} from '@circuit-breaker/shared';
import type { CSSProperties } from 'react';
import { pickVehicle } from '../../game/multiplayer';
import { useGameStore } from '../../game/store';
import { CarGlyph } from './CarGlyph';

/**
 * The player's car: a body style and a colour. The server checks every pick (a colour another
 * player has is refused); the preview, and the car behind the lobby, show what it accepted.
 */
export function VehiclePicker({ me, players }: { me: LobbyPlayer; players: LobbyPlayer[] }) {
  const busy = useGameStore((s) => s.online.busy);
  const owner = new Map(players.filter((p) => p.id !== me.id).map((p) => [p.color, p.name]));
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <CarGlyph color={me.color} style={me.style} className="h-12 w-24" />
        <div className="min-w-0">
          <div className="font-display text-lg font-black tracking-[0.1em] text-white uppercase">
            {VEHICLE_STYLES[me.style]}
          </div>
          <div className="label" style={{ color: PLAYER_COLORS[me.color] }}>
            {PLAYER_COLOR_NAMES[me.color]}
          </div>
        </div>
      </div>
      <div role="radiogroup" aria-label="Body style" className="flex flex-wrap gap-1.5">
        {VEHICLE_STYLES.map((name, style) => (
          <button
            key={name}
            type="button"
            role="radio"
            aria-checked={me.style === style}
            className="chip vehicle-chip flex items-center gap-2"
            disabled={busy}
            onClick={() => void pickVehicle({ color: me.color, style })}
          >
            <CarGlyph color={me.color} style={style} className="h-5 w-10" />
            {name}
          </button>
        ))}
      </div>
      <div role="radiogroup" aria-label="Colour" className="flex flex-wrap gap-1.5">
        {PLAYER_COLORS.map((hex, color) => {
          const takenBy = owner.get(color);
          const label = takenBy
            ? `${PLAYER_COLOR_NAMES[color]} (${takenBy} has it)`
            : PLAYER_COLOR_NAMES[color];
          return (
            <button
              key={hex}
              type="button"
              role="radio"
              aria-checked={me.color === color}
              aria-label={label}
              title={label}
              className="color-swatch"
              style={{ '--swatch': hex } as CSSProperties}
              disabled={busy || takenBy !== undefined}
              onClick={() => void pickVehicle({ color, style: me.style })}
            />
          );
        })}
      </div>
    </div>
  );
}
