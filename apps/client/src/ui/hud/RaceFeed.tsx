import { LEFT_LANE, type RaceEvent } from '@circuit-breaker/shared';
import { useEffect, useRef, useState } from 'react';
import { session } from '../../game/session';
import { useGameStore } from '../../game/store';

interface Line {
  id: number;
  text: string;
  tone: 'open' | 'locked' | 'changing' | 'boost';
}

const TONE_CLASS: Record<Line['tone'], string> = {
  open: 'text-neon-lime',
  locked: 'text-neon-red',
  changing: 'text-neon-amber',
  boost: 'text-neon-magenta',
};

const LIFETIME_MS = 4200;
const MAX_LINES = 4;

const laneName = (lane: number) => (lane === LEFT_LANE ? 'outside' : 'inside');

/**
 * Top-right, under the clock: a short feed of who used what and how the track changed. The
 * lines come from the server (online) or the local race (solo), never from a client's claim.
 */
export function RaceFeed() {
  const [lines, setLines] = useState<Line[]>([]);
  const nextId = useRef(1);

  useEffect(() => {
    const timers = new Set<number>();
    const push = (text: string, tone: Line['tone']) => {
      const id = nextId.current++;
      setLines((list) => [...list.slice(-(MAX_LINES - 1)), { id, text, tone }]);
      const timer = window.setTimeout(() => {
        timers.delete(timer);
        setLines((list) => list.filter((l) => l.id !== id));
      }, LIFETIME_MS);
      timers.add(timer);
    };
    const who = (id: string) => {
      if (id === session.playerId) return 'You';
      return session.online?.info.racers.find((r) => r.id === id)?.name ?? 'A rival';
    };
    const off = session.onFeed((event: RaceEvent) => {
      switch (event.type) {
        case 'ability': {
          const name = who(event.racerId);
          if (event.ability === 'shortcut') push(`${name} opened the shortcut!`, 'open');
          else if (event.ability === 'gate') push(`${name} shifted the gate!`, 'changing');
          else push(`${name} activated Overdrive!`, 'boost');
          break;
        }
        case 'gate':
          if (event.phase === 'warning') {
            const warn = session.sim.rules.gateWarnTicks / 60;
            push(`Gate shifting: ${laneName(event.lane)} lane opens in ${warn} s`, 'changing');
          } else push(`Gate: ${laneName(event.lane)} lane open`, 'open');
          break;
        case 'shortcut':
          if (event.phase === 'open') push('The Needle is open', 'open');
          else if (event.phase === 'closing') push('The Needle is closing', 'changing');
          else if (event.phase === 'closed') push('The Needle is shut', 'locked');
          break;
        default:
          break;
      }
    });
    // Online: a rival's connection dropping or coming back (from the server's room state).
    let previous = useGameStore.getState().online.room;
    const offRoom = useGameStore.subscribe((state) => {
      const room = state.online.room;
      if (room !== previous && room && previous && state.raceKind === 'online') {
        for (const p of room.players) {
          const before = previous.players.find((q) => q.id === p.id);
          if (!before || p.id === session.playerId) continue;
          if (before.connected && !p.connected) push(`${p.name} disconnected`, 'locked');
          else if (!before.connected && p.connected) push(`${p.name} is back`, 'open');
        }
      }
      previous = room;
    });
    return () => {
      off();
      offRoom();
      for (const t of timers) window.clearTimeout(t);
    };
  }, []);

  if (lines.length === 0) return null;
  return (
    <ul className="race-feed flex flex-col items-end gap-1" aria-live="polite">
      {lines.map((line) => (
        <li
          key={line.id}
          className={`feed-line panel px-3 py-1 text-sm font-bold tracking-wide ${TONE_CLASS[line.tone]}`}
        >
          {line.text}
        </li>
      ))}
    </ul>
  );
}
