import { formatClock } from '../../game/format';
import { useGameStore } from '../../game/store';

/** Top-left: LAP 1/3, with the best lap underneath once there is one. The last lap is flagged. */
export function LapPanel() {
  const lap = useGameStore((s) => s.lap);
  const totalLaps = useGameStore((s) => s.totalLaps);
  const bestLap = useGameStore((s) => s.bestLap);
  const phase = useGameStore((s) => s.phase);
  const final = totalLaps > 1 && lap === totalLaps && phase === 'racing';
  return (
    <div className={`panel px-5 py-2.5 ${final ? 'final-lap' : ''}`}>
      <div className="flex items-baseline gap-3">
        <span className={`label ${final ? 'text-neon-magenta' : ''}`}>
          {final ? 'Final' : 'Lap'}
        </span>
        <span className="lap-digits digits text-4xl leading-none font-black text-white glow-cyan">
          {lap}
          <span className="text-2xl text-white/45">/{totalLaps}</span>
        </span>
      </div>
      <div className="label mt-1.5 text-neon-magenta/80">
        Best{' '}
        <span className="digits ml-1 text-sm tracking-normal text-neon-magenta glow-magenta">
          {bestLap === null ? '--:--.--' : formatClock(bestLap)}
        </span>
      </div>
    </div>
  );
}
