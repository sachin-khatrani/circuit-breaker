import { useEffect, useState } from 'react';
import { session } from '../../game/session';
import { useGameStore } from '../../game/store';

/** No snapshot for this long (ms) and the race view says so. */
const STALE_MS = 700;

/** Online: a clear notice when the link to the server is down or stalling. */
export function ConnectionWarning() {
  const status = useGameStore((s) => s.online.status);
  const [stale, setStale] = useState(false);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const online = session.online;
      setStale(
        online !== null && !online.ended && performance.now() - online.lastSnapshotAt > STALE_MS,
      );
    }, 200);
    return () => window.clearInterval(timer);
  }, []);

  if (status === 'online' && !stale) return null;
  const lost = status !== 'online';
  return (
    <div
      className="pointer-events-none absolute inset-x-0 top-[34%] flex justify-center"
      role="status"
    >
      <div className="panel flex items-center gap-3 px-5 py-2.5">
        <span className="h-2.5 w-2.5 rounded-full bg-neon-amber warning-pulse" aria-hidden />
        <span className="font-display text-sm font-bold tracking-[0.18em] text-neon-amber uppercase">
          {lost ? 'Connection lost · reconnecting' : 'Connection unstable'}
        </span>
      </div>
    </div>
  );
}
