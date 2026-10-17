import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { inputManager } from '../../game/input';
import { session } from '../../game/session';
import { HINT_MAX_RACES, loadHintProgress, saveHintProgress } from '../../game/settings';
import { useGameStore } from '../../game/store';
import { useAnimationFrame } from '../useAnimationFrame';

// Read once per visit and kept here, so closing the hint sticks even without storage.
const progress = loadHintProgress();
let claimedSerial = -1;
let claimedShow = false;

/** Whether this race shows the hint. Each race counts once (StrictMode renders twice). */
function claimRace(serial: number): boolean {
  if (serial !== claimedSerial) {
    claimedSerial = serial;
    claimedShow = !progress.done && progress.races < HINT_MAX_RACES;
    if (claimedShow) {
      progress.races += 1;
      saveHintProgress(progress);
    }
  }
  return claimedShow;
}

function retire(): void {
  if (progress.done) return;
  progress.done = true;
  saveHintProgress(progress);
}

function steps(device: 'keyboard' | 'gamepad', boostCost: number): [string, string] {
  return device === 'gamepad'
    ? [
        `Green cells, drifts (hold A) and glowing speed lanes fill the bar. X spends ${boostCost} on a boost.`,
        'D-pad ← opens the shortcut for everyone, ↑ swaps the open lane of the split, → fires Overdrive.',
      ]
    : [
        `Green cells, drifts (hold Space) and glowing speed lanes fill the bar. Shift spends ${boostCost} on a boost.`,
        'Q opens the shortcut for everyone, E swaps the open lane of the split, F fires Overdrive.',
      ];
}

function Step({
  index,
  done,
  title,
  text,
}: {
  index: number;
  done: boolean;
  title: string;
  text: string;
}) {
  return (
    <li className="flex gap-2.5" data-done={done}>
      <span className="hint-mark digits" aria-hidden>
        {done ? '✓' : index}
      </span>
      <span className="min-w-0">
        <span className="hint-title block">
          {title}
          {done && <span className="sr-only"> (done)</span>}
        </span>
        <span className="block text-[0.82rem] leading-snug font-medium text-white/80">{text}</span>
      </span>
    </li>
  );
}

/**
 * Over the ability slots, in a driver's first races: how Energy is charged and how it changes
 * the track. A step ticks when the driver does it (Energy goes up; one of their abilities goes
 * off, as the race confirms it). Using an ability or closing the hint ends it for good;
 * otherwise it stops after HINT_MAX_RACES races. Hidden on touch screens, which cannot drive.
 */
export function FirstRaceHint() {
  const [shown] = useState(() => claimRace(useGameStore.getState().raceSerial));
  const phase = useGameStore((s) => s.phase);
  const countdown = useGameStore((s) => s.countdown);
  const overlay = useGameStore((s) => s.overlay);
  const [device, setDevice] = useState(inputManager.device);
  const [charged, setCharged] = useState(false);
  const [spent, setSpent] = useState(false);
  const [closed, setClosed] = useState(false);
  const [over, setOver] = useState(false);
  const lastEnergy = useRef<number | null>(null);

  useAnimationFrame(() => {
    if (!shown || closed) return;
    if (inputManager.device !== device) setDevice(inputManager.device);
    const racer = session.racer;
    if (racer.finished || racer.retired) {
      if (!over) setOver(true);
      return;
    }
    if (session.sim.phase !== 'racing') return;
    // Energy only rises from a pickup: a cell, a drift or a glowing lane.
    const energy = racer.vehicle.energy;
    if (!charged && lastEnergy.current !== null && energy > lastEnergy.current + 0.01) {
      setCharged(true);
    }
    lastEnergy.current = energy;
  });

  useEffect(() => {
    if (!shown) return;
    return session.onFeed((event) => {
      if (event.type !== 'ability' || event.racerId !== session.playerId) return;
      retire();
      setSpent(true);
    });
  }, [shown]);

  // Both steps done: the ticks stay a moment, then the hint goes.
  useEffect(() => {
    if (!spent) return;
    const timer = window.setTimeout(() => setClosed(true), 1800);
    return () => window.clearTimeout(timer);
  }, [spent]);

  if (!shown || closed || over || overlay === 'results' || phase === 'finished') return null;
  // The race-start card has the screen until the countdown begins.
  if (phase === 'countdown' && countdown === null) return null;

  const [charge, spend] = steps(device, session.sim.rules.boostCost);
  const keepFocus = (e: PointerEvent<HTMLButtonElement>) => {
    // Never take keyboard focus away from driving.
    e.preventDefault();
  };
  const close = () => {
    retire();
    setClosed(true);
  };
  return (
    <section
      className="first-race-hint panel w-[min(19.5rem,calc(100vw-2rem))] px-3 pt-2 pb-3"
      data-done={spent}
      aria-label="First race tips"
    >
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="label">First race</span>
        <button
          type="button"
          tabIndex={-1}
          className="hint-close pointer-events-auto"
          aria-label="Hide these tips"
          onPointerDown={keepFocus}
          onClick={close}
        >
          ×
        </button>
      </div>
      <ol className="flex flex-col gap-2">
        <Step index={1} done={charged || spent} title="Charge Energy" text={charge} />
        <Step index={2} done={spent} title="Change the track" text={spend} />
      </ol>
    </section>
  );
}
