import { useEffect, useRef } from 'react';
import { session } from '../../game/session';

/**
 * A brief glow around the screen edges for a boost, a boost pad, a pickup or a race call. The
 * centre of the view always stays clear, and reduced motion turns it off (see styles.css).
 */
export function ScreenFlash() {
  const el = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const flash = (color: string, strength: number) => {
      const node = el.current;
      if (!node) return;
      node.style.setProperty('--flash-color', color);
      node.style.setProperty('--flash-strength', String(strength));
      node.classList.remove('flash');
      // Force a reflow so the animation restarts on every call.
      void node.offsetWidth;
      node.classList.add('flash');
    };
    const off = session.onEvent((event) => {
      if (!session.racing) return;
      if ('racerId' in event && event.racerId !== session.playerId) return;
      switch (event.type) {
        case 'boost':
        case 'boostPad':
          flash('rgb(255 43 214 / 0.5)', 0.85);
          break;
        case 'launchBoost':
          flash('rgb(198 255 58 / 0.4)', 0.7);
          break;
        case 'cell':
          flash('rgb(198 255 58 / 0.3)', 0.35);
          break;
        case 'lap':
          if (event.lap === session.sim.laps - 1) flash('rgb(255 43 214 / 0.45)', 1);
          break;
        case 'finish':
          flash('rgb(198 255 58 / 0.5)', 1);
          break;
        default:
          break;
      }
    });
    return () => {
      off();
    };
  }, []);

  return <div ref={el} className="screen-flash" aria-hidden />;
}
