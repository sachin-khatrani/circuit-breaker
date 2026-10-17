import { useRef } from 'react';
import { inputManager } from '../../game/input';
import { useAnimationFrame } from '../useAnimationFrame';

/**
 * Over the ability slots on touch screens: there are no touch driving controls yet, so say
 * what does work (a keyboard or a gamepad) instead of leaving a car that will not move. Only
 * the slots answer taps. A gamepad in use drives fine, so the note goes. Shown by CSS on
 * coarse pointers only.
 */
export function TouchDrivingNote() {
  const note = useRef<HTMLDivElement>(null);
  const gamepad = useRef(false);

  useAnimationFrame(() => {
    const active = inputManager.device === 'gamepad';
    if (active === gamepad.current) return;
    gamepad.current = active;
    if (note.current) note.current.hidden = active;
  });

  return (
    <div
      ref={note}
      className="hud-touch-note panel w-[17rem] max-w-[calc(100vw-2rem)] px-3 py-2 text-sm leading-snug font-semibold text-white/85"
      role="note"
    >
      No touch driving yet: connect a keyboard or a gamepad to race. The ability slots below take
      taps.
    </div>
  );
}
