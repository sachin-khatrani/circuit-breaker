import { RACE_RULES } from '@circuit-breaker/shared';
import { useEffect, useRef } from 'react';
import { toKmh } from '../../game/format';
import { session } from '../../game/session';
import { useAnimationFrame } from '../useAnimationFrame';

const TIER_COLORS = ['#7fe9ff', '#ffb02e', '#ff5be0'];
/** One segment of the bar per boost burst. */
const SEGMENTS = Math.max(1, Math.round(RACE_RULES.maxEnergy / RACE_RULES.boostCost));

type BoostState = 'ready' | 'active' | 'cooldown' | 'low' | 'overdrive';

/** Restarts a one-shot CSS animation class on an element. */
function replay(el: HTMLElement | null, className: string): void {
  if (!el) return;
  el.classList.remove(className);
  // Force a reflow so the animation starts again from the beginning.
  void el.offsetWidth;
  el.classList.add(className);
}

/**
 * Bottom-right: a compact speed readout over the BOOST gauge. The bar is the car's Energy in
 * segments of one burst each; the label and colours say whether a burst is ready (and how
 * many), running, cooling down, or out of reach. The strip under the bar shows the running
 * burst, the cooldown, or the drift charge. Written straight to the DOM every frame.
 */
export function BoostMeter() {
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const fill = useRef<HTMLDivElement>(null);
  const value = useRef<HTMLSpanElement>(null);
  const speed = useRef<HTMLSpanElement>(null);
  const status = useRef<HTMLSpanElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const popups = useRef<HTMLDivElement>(null);
  const shown = useRef({ speed: -1, energy: -1, status: '', state: '' });

  useAnimationFrame(() => {
    const car = session.render;
    const s = shown.current;
    const kmh = Math.round(toKmh(car.speed));
    if (speed.current && kmh !== s.speed) {
      speed.current.textContent = String(kmh);
      s.speed = kmh;
    }
    const energy = Math.floor(car.energy);
    if (value.current && energy !== s.energy) {
      value.current.textContent = String(energy);
      s.energy = energy;
    }
    if (fill.current) fill.current.style.width = `${(car.energy / RACE_RULES.maxEnergy) * 100}%`;

    const bursts = Math.floor(car.energy / RACE_RULES.boostCost);
    const state: BoostState = car.overdrive
      ? 'overdrive'
      : car.boosting
        ? 'active'
        : car.boostCooldown > 0
          ? 'cooldown'
          : bursts > 0
            ? 'ready'
            : 'low';
    if (state !== s.state) {
      s.state = state;
      if (root.current) root.current.dataset.state = state;
    }
    const boosting = car.boosting || car.overdrive || car.impulse || car.padBoost;
    if (root.current) root.current.dataset.boost = String(boosting);
    const label =
      state === 'overdrive'
        ? 'Overdrive'
        : state === 'active'
          ? 'Boosting'
          : state === 'cooldown'
            ? 'Cooling'
            : state === 'ready'
              ? `Ready ×${bursts} · Shift`
              : `Need ${RACE_RULES.boostCost}`;
    if (status.current && label !== s.status) {
      status.current.textContent = label;
      s.status = label;
    }

    // Strip: drift charge while sliding, otherwise the burst draining or the cooldown filling.
    const el = strip.current;
    if (el) {
      let width = 0;
      let color = TIER_COLORS[0];
      if (car.drifting) {
        const ticks = car.driftTicks;
        const tier =
          ticks >= RACE_RULES.miniTurboTier2Ticks
            ? 2
            : ticks >= RACE_RULES.miniTurboTier1Ticks
              ? 1
              : 0;
        width = Math.min(1, ticks / RACE_RULES.miniTurboTier2Ticks);
        color = TIER_COLORS[tier];
      } else if (car.overdrive) {
        width = car.overdriveLeft / RACE_RULES.overdriveTicks;
        color = '#fff07a';
      } else if (car.boosting) {
        width = car.boostLeft / RACE_RULES.boostDurationTicks;
        color = '#ff2bd6';
      } else if (car.boostCooldown > 0) {
        width = 1 - car.boostCooldown / RACE_RULES.boostCooldownTicks;
        color = 'rgb(127 233 255 / 0.55)';
      }
      el.style.width = `${width * 100}%`;
      el.style.background = color;
      el.style.boxShadow = width > 0 ? `0 0 10px ${color}` : 'none';
    }
  });

  useEffect(() => {
    const popup = (text: string, tone: 'lime' | 'cyan') => {
      const host = popups.current;
      if (!host) return;
      const el = document.createElement('span');
      el.className = `energy-popup digits ${tone === 'lime' ? 'text-neon-lime glow-lime' : 'text-neon-cyan glow-cyan'}`;
      el.textContent = text;
      el.addEventListener('animationend', () => el.remove(), { once: true });
      host.append(el);
      // Never let a burst of pickups pile up.
      while (host.childElementCount > 3) host.firstElementChild?.remove();
    };
    const off = session.onEvent((event) => {
      if ('racerId' in event && event.racerId !== session.playerId) return;
      switch (event.type) {
        case 'cell':
          if (event.gained > 0) popup(`+${Math.round(event.gained)}`, 'lime');
          replay(track.current, 'energy-flash');
          break;
        case 'driftReward':
          popup(`+${Math.round(event.energy)} drift`, 'cyan');
          replay(track.current, 'energy-flash');
          break;
        case 'boost':
          replay(panel.current, 'boost-fire');
          break;
        case 'boostDenied':
          replay(panel.current, 'boost-denied');
          break;
        case 'boostPad':
          replay(speed.current, 'speed-flash');
          break;
        default:
          break;
      }
    });
    return () => {
      off();
    };
  }, []);

  return (
    <div
      ref={root}
      className="boost-meter group relative w-[270px]"
      data-boost="false"
      data-state="ready"
    >
      {/* Beside the meter, clear of the ability slots stacked above it. */}
      <div
        ref={popups}
        className="pointer-events-none absolute right-full bottom-10 mr-3 flex flex-col items-end"
      />
      <div className="mb-2 flex items-baseline justify-end gap-2">
        <span
          ref={speed}
          className="digits text-3xl leading-none font-black text-white glow-cyan group-data-[boost=true]:text-neon-magenta group-data-[boost=true]:glow-magenta"
        >
          0
        </span>
        <span className="label">km/h</span>
      </div>
      <div ref={panel} className="panel px-3 pt-2 pb-2.5">
        <div className="mb-1.5 flex items-baseline justify-between">
          <span className="boost-title font-display text-sm font-black tracking-[0.3em]">
            BOOST
          </span>
          <span className="flex items-baseline gap-2">
            <span ref={status} className="boost-status label">
              Ready
            </span>
            <span ref={value} className="boost-value digits text-lg font-bold text-white">
              0
            </span>
          </span>
        </div>
        <div ref={track} className="energy-track">
          <div ref={fill} className="energy-fill" />
          <div className="energy-ticks" style={{ backgroundSize: `${100 / SEGMENTS}% 100%` }} />
        </div>
        <div className="mt-1 h-[3px] w-full bg-white/5">
          <div ref={strip} className="h-full w-0" />
        </div>
      </div>
    </div>
  );
}
