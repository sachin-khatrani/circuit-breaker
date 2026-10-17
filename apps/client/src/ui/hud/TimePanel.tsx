import { useRef } from 'react';
import { formatClock } from '../../game/format';
import { session } from '../../game/session';
import { useAnimationFrame } from '../useAnimationFrame';

/** Top-right: TIME 00:32.42 (race clock) with the current lap time underneath. */
export function TimePanel() {
  const race = useRef<HTMLSpanElement>(null);
  const lap = useRef<HTMLSpanElement>(null);
  const shown = useRef({ race: '', lap: '' });

  useAnimationFrame(() => {
    const raceText = formatClock(Math.max(0, session.raceTime));
    const lapText = formatClock(session.lapTime);
    if (race.current && raceText !== shown.current.race) {
      race.current.textContent = raceText;
      shown.current.race = raceText;
    }
    if (lap.current && lapText !== shown.current.lap) {
      lap.current.textContent = lapText;
      shown.current.lap = lapText;
    }
  });

  return (
    <div className="panel px-5 py-2.5 text-right">
      <div className="flex items-baseline justify-end gap-3">
        <span className="label">Time</span>
        <span
          ref={race}
          className="digits min-w-[7.2ch] text-4xl leading-none font-black text-white glow-cyan"
        >
          00:00.00
        </span>
      </div>
      <div className="label mt-1.5">
        Lap{' '}
        <span ref={lap} className="digits ml-1 text-sm tracking-normal text-white/80">
          00:00.00
        </span>
      </div>
    </div>
  );
}
