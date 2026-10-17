import { ordinalSuffix } from '../../game/format';
import { useGameStore } from '../../game/store';

/** Top-centre: the race standing, "2ND /6" (always 1/1 in solo races). */
export function PositionPanel() {
  const position = useGameStore((s) => s.position);
  const racerCount = useGameStore((s) => s.racerCount);
  return (
    <div
      className="panel flex items-baseline gap-3 px-6 py-2.5"
      aria-label={`Position ${position} of ${racerCount}`}
    >
      <span className="label">Position</span>
      <span className="digits text-4xl leading-none font-black text-white glow-cyan">
        {position}
        <span className="ml-0.5 text-lg tracking-[0.08em] uppercase">
          {ordinalSuffix(position)}
        </span>
        <span className="ml-1.5 text-2xl text-white/45">/{racerCount}</span>
      </span>
    </div>
  );
}
