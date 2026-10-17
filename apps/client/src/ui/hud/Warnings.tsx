import { useGameStore } from '../../game/store';

/** Centre warnings: off track (about to respawn), the respawn reboot, wrong way. */
export function Warnings() {
  const wrongWay = useGameStore((s) => s.wrongWay);
  const offTrack = useGameStore((s) => s.offTrack);
  const rebooting = useGameStore((s) => s.rebooting);
  const screen = useGameStore((s) => s.screen);
  if (screen !== 'race') return null;

  let content: { text: string; tone: string } | null = null;
  if (offTrack) content = { text: 'OFF TRACK', tone: 'text-neon-amber' };
  else if (rebooting) content = { text: 'REBOOTING', tone: 'text-neon-cyan glow-cyan' };
  else if (wrongWay) content = { text: 'WRONG WAY', tone: 'text-neon-red' };
  if (!content) return null;

  return (
    <div className="pointer-events-none absolute inset-x-0 top-[38%] flex justify-center">
      <div
        className={`panel warning-pulse px-6 py-2 font-display text-2xl font-black tracking-[0.3em] md:text-3xl ${content.tone}`}
      >
        {content.text}
      </div>
    </div>
  );
}
