import { useGameStore } from '../../game/store';

/** 3 · 2 · 1 · GO! — keyed so each number replays its animation. */
export function Countdown() {
  const value = useGameStore((s) => s.countdown);
  if (value === null) return null;
  const go = value === 0;
  return (
    <div className="pointer-events-none absolute inset-x-0 top-[16%] flex justify-center">
      <div key={value} className={`countdown-num ${go ? 'text-neon-lime' : 'text-neon-cyan'}`}>
        {go ? 'GO!' : value}
      </div>
    </div>
  );
}
