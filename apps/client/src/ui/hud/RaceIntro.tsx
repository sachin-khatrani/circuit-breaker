import { ordinal } from '../../game/format';
import { session } from '../../game/session';
import { useGameStore } from '../../game/store';

/**
 * The race-start card, shown while the camera sweeps round to the grid (before "3"): which
 * race of the session this is, where this car starts, and the session standing going in. The
 * numbers are the server's (room state and the race start); nothing here is counted locally.
 */
export function RaceIntro() {
  const phase = useGameStore((s) => s.phase);
  const countdown = useGameStore((s) => s.countdown);
  const kind = useGameStore((s) => s.raceKind);
  const laps = useGameStore((s) => s.totalLaps);
  const serial = useGameStore((s) => s.raceSerial);
  const room = useGameStore((s) => s.online.room);
  const playerId = useGameStore((s) => s.online.playerId);
  if (phase !== 'countdown' || countdown !== null) return null;

  const online = kind === 'online';
  const racers = online ? (session.online?.info.racers ?? []) : [];
  const slot = racers.find((r) => r.id === session.playerId)?.slot;
  const me = room?.players.find((p) => p.id === playerId);
  return (
    <div className="pointer-events-none absolute inset-x-0 top-[20%] flex justify-center">
      <div key={serial} className="race-intro panel flex flex-col items-center gap-1 px-8 py-4">
        <div className="label text-neon-magenta">
          {online && room
            ? `Race ${room.sessionRaces + 1} · session ${room.sessionId}`
            : 'Practice · solo'}
        </div>
        <div className="font-display text-3xl font-black tracking-[0.2em] text-white glow-cyan">
          GRID ZERO
        </div>
        <div className="label text-white/80">
          {laps} {laps === 1 ? 'lap' : 'laps'}
          {online && slot !== undefined
            ? ` · starting ${ordinal(slot + 1)} of ${racers.length}`
            : ' · against the clock'}
        </div>
        {online && me && me.races > 0 && (
          <div className="label text-neon-lime">
            Session: {me.points} pts · {ordinal(me.rank)}
          </div>
        )}
      </div>
    </div>
  );
}
