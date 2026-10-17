import { useRef } from 'react';
import { inputManager } from '../../game/input';
import { useGameStore } from '../../game/store';
import { useAnimationFrame } from '../useAnimationFrame';

const KEYBOARD: [string, string][] = [
  ['WASD', 'Drive'],
  ['Space', 'Drift'],
  ['Shift', 'Boost'],
  ['Q E F', 'Abilities'],
  ['R', 'Reset'],
  ['M', 'Mute'],
  ['Esc', 'Pause'],
];
const GAMEPAD: [string, string][] = [
  ['RT/LT', 'Drive'],
  ['A', 'Drift'],
  ['X', 'Boost'],
  ['Y', 'Reset'],
  ['D-pad', 'Abilities'],
  ['Start', 'Pause'],
];

function Row({ items }: { items: [string, string][] }) {
  return (
    <>
      {items.map(([key, action]) => (
        <span key={action} className="flex items-baseline gap-1.5">
          <kbd className="digits text-[0.7rem] font-bold text-neon-cyan">{key}</kbd>
          <span className="label text-[0.65rem]">{action}</span>
        </span>
      ))}
    </>
  );
}

/** Bottom-left: a minimal, always-on control hint that follows the active input device. */
export function ControlsHint() {
  const muted = useGameStore((s) => s.muted);
  const keyboard = useRef<HTMLDivElement>(null);
  const gamepad = useRef<HTMLDivElement>(null);
  const shown = useRef<'keyboard' | 'gamepad'>('keyboard');

  useAnimationFrame(() => {
    const device = inputManager.device;
    if (device === shown.current) return;
    shown.current = device;
    if (keyboard.current) keyboard.current.hidden = device !== 'keyboard';
    if (gamepad.current) gamepad.current.hidden = device !== 'gamepad';
  });

  return (
    <div className="hud-hint flex max-w-[calc(100vw-22rem)] flex-wrap gap-x-3 gap-y-1 opacity-70">
      <div ref={keyboard} className="flex flex-wrap gap-x-3 gap-y-1">
        <Row items={KEYBOARD} />
      </div>
      <div ref={gamepad} className="flex flex-wrap gap-x-3" hidden>
        <Row items={GAMEPAD} />
      </div>
      {muted && <span className="label text-[0.65rem] text-neon-amber">Sound off</span>}
    </div>
  );
}
