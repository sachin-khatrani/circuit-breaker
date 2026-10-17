import { useEffect, useRef, useState } from 'react';
import { formatDelta, formatTime, ordinal } from '../../game/format';
import { session } from '../../game/session';

interface Banner {
  id: number;
  title: string;
  detail?: string;
  tone: 'cyan' | 'magenta' | 'lime' | 'red' | 'white';
  size: 'lg' | 'sm';
}

const TONE_CLASS: Record<Banner['tone'], string> = {
  cyan: 'text-neon-cyan glow-cyan',
  magenta: 'text-neon-magenta glow-magenta',
  lime: 'text-neon-lime glow-lime',
  red: 'text-neon-red',
  white: 'text-white glow-cyan',
};

const LIFETIME_MS = 1800;
const LAUNCH_BANNER_DELAY_MS = 850;

/** Race call-outs: laps, final lap, splits, best laps, launches and mini-turbos. */
export function Banners() {
  const [banners, setBanners] = useState<Banner[]>([]);
  const nextId = useRef(1);

  useEffect(() => {
    const timers = new Set<number>();
    const push = (banner: Omit<Banner, 'id'>) => {
      const id = nextId.current++;
      setBanners((list) => [...list.slice(-2), { ...banner, id }]);
      const timer = window.setTimeout(() => {
        timers.delete(timer);
        setBanners((list) => list.filter((b) => b.id !== id));
      }, LIFETIME_MS);
      timers.add(timer);
    };
    const off = session.onEvent((event) => {
      if (!session.racing) return;
      const laps = session.sim.laps;
      switch (event.type) {
        case 'checkpoint': {
          const detail =
            event.bestSplit === null
              ? formatTime(event.split)
              : formatDelta(event.split - event.bestSplit);
          const tone =
            event.bestSplit === null ? 'white' : event.split <= event.bestSplit ? 'lime' : 'red';
          push({ title: `Sector ${event.checkpoint}`, detail, tone, size: 'sm' });
          break;
        }
        case 'lap':
          if (event.lap >= laps) break;
          if (event.improved) {
            push({
              title: 'Best lap',
              detail: formatTime(event.lapTime),
              tone: 'magenta',
              size: 'sm',
            });
          }
          push(
            event.lap === laps - 1
              ? {
                  title: 'Final lap',
                  detail: formatTime(event.lapTime),
                  tone: 'magenta',
                  size: 'lg',
                }
              : {
                  title: `Lap ${event.lap + 1}/${laps}`,
                  detail: formatTime(event.lapTime),
                  tone: 'cyan',
                  size: 'lg',
                },
          );
          break;
        case 'launchBoost': {
          // Shown as "GO!" fades, so the two never sit on top of each other.
          const timer = window.setTimeout(() => {
            timers.delete(timer);
            push({ title: 'Perfect launch', tone: 'lime', size: 'sm' });
          }, LAUNCH_BANNER_DELAY_MS);
          timers.add(timer);
          break;
        }
        case 'driftEnd':
          if (event.tier > 0) {
            push({
              title: event.tier === 2 ? 'Super mini-turbo' : 'Mini-turbo',
              tone: event.tier === 2 ? 'magenta' : 'cyan',
              size: 'sm',
            });
          }
          break;
        default:
          break;
      }
    });
    // Online: other players crossing the line, or leaving.
    const nameOf = (id: string) =>
      session.online?.info.racers.find((r) => r.id === id)?.name ?? 'A rival';
    const offRemote = session.onRemoteEvent((event) => {
      if (event.type === 'finish') {
        push({
          title: `${nameOf(event.racerId)} finished`,
          detail: ordinal(event.position),
          tone: 'white',
          size: 'sm',
        });
      } else if (event.type === 'retired') {
        push({ title: `${nameOf(event.racerId)} left the race`, tone: 'red', size: 'sm' });
      }
    });
    return () => {
      off();
      offRemote();
      for (const t of timers) window.clearTimeout(t);
    };
  }, []);

  return (
    <div className="pointer-events-none absolute inset-x-0 top-[17%] flex flex-col items-center gap-1">
      {banners.map((b) => (
        <div key={b.id} className="banner flex flex-col items-center">
          <div
            className={`font-display font-black tracking-[0.18em] uppercase ${TONE_CLASS[b.tone]} ${
              b.size === 'lg' ? 'text-4xl md:text-5xl' : 'text-xl md:text-2xl'
            }`}
          >
            {b.title}
          </div>
          {b.detail && (
            <div className={`digits text-lg font-bold ${TONE_CLASS[b.tone]}`}>{b.detail}</div>
          )}
        </div>
      ))}
    </div>
  );
}
