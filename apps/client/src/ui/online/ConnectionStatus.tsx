import { useGameStore } from '../../game/store';

const LABELS = {
  online: 'Connected',
  connecting: 'Connecting…',
  reconnecting: 'Reconnecting…',
} as const;

/**
 * Small connection indicator for the online screens. Nothing before the first connection: a
 * grey "Offline" on the title screen read as "the server is down". A failed attempt says so in
 * the panel's error line instead.
 */
export function ConnectionStatus() {
  const status = useGameStore((s) => s.online.status);
  const color = status === 'online' ? 'bg-neon-lime' : 'bg-neon-amber warning-pulse';
  // The live region stays mounted so the first "Connecting…" is announced.
  return (
    <span className="label flex items-center gap-2 text-white/60" aria-live="polite">
      {status !== 'offline' && (
        <>
          <span className={`h-2 w-2 rounded-full ${color}`} aria-hidden />
          {LABELS[status]}
        </>
      )}
    </span>
  );
}
