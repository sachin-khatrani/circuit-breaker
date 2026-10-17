import { PLAYER_COLORS } from '@circuit-breaker/shared';
import { formatClock } from '../../game/format';
import { useGameStore } from '../../game/store';

/** Online: the live order under the lap panel, compact enough to stay off the road. */
export function Standings() {
  const standings = useGameStore((s) => s.online.standings);
  const laps = useGameStore((s) => s.totalLaps);
  if (standings.length === 0) return null;
  return (
    <div className="panel w-[210px] px-3 py-2" aria-label="Live standings">
      <ol className="flex flex-col gap-0.5">
        {standings.map((s) => {
          const color = PLAYER_COLORS[s.color] ?? PLAYER_COLORS[0];
          const status = s.finished
            ? formatClock(s.finishTime)
            : s.retired
              ? 'DNF'
              : s.offline
                ? 'Offline'
                : `Lap ${Math.min(s.lap + 1, laps)}`;
          return (
            <li
              key={s.id}
              className={`flex items-center gap-2 text-[0.95rem] leading-tight font-bold ${
                s.me ? 'text-white' : 'text-white/72'
              } ${s.retired || s.offline ? 'opacity-50' : ''}`}
            >
              <span className="digits w-4 text-right text-xs text-white/60">{s.position}</span>
              <span
                className="h-2.5 w-2.5 shrink-0"
                style={{ background: color, boxShadow: `0 0 6px ${color}` }}
                aria-hidden
              />
              <span className={`min-w-0 flex-1 truncate ${s.me ? 'glow-cyan' : ''}`}>
                {s.name}
                {s.me && <span className="label ml-1.5 text-[0.58rem] text-neon-cyan">you</span>}
              </span>
              <span
                className={`digits text-[0.68rem] ${s.finished ? 'text-neon-lime' : 'text-white/55'}`}
              >
                {status}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
