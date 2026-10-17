import { useEffect, useState } from 'react';
import { formatTime, ordinal } from '../../game/format';
import { session } from '../../game/session';
import { useGameStore } from '../../game/store';

/** Big, clear finish call-out with the final time, held until the results screen opens. */
export function FinishOverlay() {
  const [finish, setFinish] = useState<{ time: number; position: number } | null>(null);
  const results = useGameStore((s) => s.results);
  const overlay = useGameStore((s) => s.overlay);
  const phase = useGameStore((s) => s.phase);
  const raceKind = useGameStore((s) => s.raceKind);
  const serverResults = useGameStore((s) => s.online.results);

  useEffect(() => {
    const off = session.onEvent((event) => {
      if (event.type === 'finish' && event.racerId === session.playerId && session.racing) {
        setFinish({ time: event.totalTime, position: event.position });
      }
    });
    return () => {
      off();
    };
  }, []);

  // Shown once the race is over (a new race goes back to the countdown and hides it).
  if (!finish || overlay === 'results' || phase !== 'finished') return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 top-[22%] flex justify-center">
      <div className="finish-in flex flex-col items-center gap-1">
        <div className="label text-neon-lime glow-lime">{ordinal(finish.position)} place</div>
        <div className="title-logo text-[clamp(3rem,9vw,6rem)]">FINISH</div>
        <div className="digits text-4xl font-black text-white glow-cyan md:text-5xl">
          {formatTime(finish.time)}
        </div>
        {results?.newBestTotal && (
          <div className="mt-1 bg-neon-magenta/20 px-2 py-0.5 font-display text-sm font-bold tracking-[0.2em] text-neon-magenta glow-magenta">
            NEW RECORD
          </div>
        )}
        {raceKind === 'online' && !serverResults && (
          <div className="label mt-2 text-white/70">Waiting for the other racers</div>
        )}
      </div>
    </div>
  );
}
