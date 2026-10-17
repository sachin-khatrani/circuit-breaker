import {
  ABILITIES,
  abilityCooldown,
  abilityCost,
  shortcutPhase,
  type AbilityDenial,
  type AbilityId,
} from '@circuit-breaker/shared';
import { useEffect, useRef, type PointerEvent } from 'react';
import { ABILITY_KEYS, inputManager } from '../../game/input';
import { session } from '../../game/session';
import { useAnimationFrame } from '../useAnimationFrame';

const NAMES: Record<AbilityId, string> = {
  shortcut: 'Shortcut',
  gate: 'Gate shift',
  overdrive: 'Overdrive',
};

/** Small glyphs: a branching route, a gate, a double chevron. */
export function AbilityIcon({ id }: { id: AbilityId }) {
  const common = {
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2.4,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden>
      {id === 'shortcut' && <path {...common} d="M5 21V12a6 6 0 0 1 6-6h8M15 2l4 4-4 4M5 12V3" />}
      {id === 'gate' && <path {...common} d="M3 21V5h18v16M3 10h18M9 10v11M15 10v11" />}
      {id === 'overdrive' && <path {...common} d="M4 5l7 7-7 7M12 5l7 7-7 7" />}
    </svg>
  );
}

type SlotState = 'off' | 'ready' | 'low' | 'cooldown' | 'active' | 'locked';

const DENIAL_TEXT: Record<AbilityDenial, string> = {
  energy: 'No Energy',
  cooldown: 'Cooling',
  busy: 'Busy',
  phase: 'Not now',
  unavailable: 'Not here',
};

const secs = (ticks: number) => Math.max(0, Math.ceil(ticks / 60));
/** A whole-second countdown, compact enough for a slot's state line. */
const clock = (ticks: number) => `${secs(ticks)}s`;

/** Restarts a one-shot CSS animation class. */
function replay(el: HTMLElement | null, className: string): void {
  if (!el) return;
  el.classList.remove(className);
  void el.offsetWidth;
  el.classList.add(className);
}

/**
 * Three ability slots above the BOOST meter: icon, name, key, Energy cost, and a state line
 * (ready, not enough Energy, cooling down, active, or locked while the track changes). Each
 * slot is also a button for mouse and touch. Written to the DOM every frame, no re-renders.
 */
export function AbilityBar() {
  const slots = useRef<(HTMLButtonElement | null)[]>([]);
  const labels = useRef<(HTMLSpanElement | null)[]>([]);
  const bars = useRef<(HTMLSpanElement | null)[]>([]);
  const shown = useRef<{ state: string; label: string }[]>(
    ABILITIES.map(() => ({ state: '', label: '' })),
  );
  /** A refusal message holds its slot's label for a moment. */
  const holds = useRef<{ until: number; text: string }[]>(
    ABILITIES.map(() => ({ until: 0, text: '' })),
  );

  useAnimationFrame(() => {
    const sim = session.sim;
    const rules = sim.rules;
    const racer = session.racer;
    const v = racer.vehicle;
    const c = sim.course;
    const tick = sim.tick;
    const now = performance.now();
    const running = session.racing && sim.phase === 'racing' && !racer.finished && !racer.retired;
    ABILITIES.forEach((id, k) => {
      let state: SlotState = 'ready';
      let label = 'Ready';
      let progress = 0;
      const cooldown = racer.abilityCooldown[k];
      if (!running) {
        state = 'off';
        label = sim.phase === 'countdown' ? 'At GO' : '—';
      } else if (id === 'overdrive' && v.overdriveTicks > 0) {
        state = 'active';
        label = `On ${clock(v.overdriveTicks)}`;
        progress = v.overdriveTicks / rules.overdriveTicks;
      } else if (id === 'shortcut' && shortcutPhase(c, tick, rules) !== 'locked') {
        const phase = shortcutPhase(c, tick, rules);
        state = 'active';
        label = phase === 'opening' ? 'Opening' : `Open ${clock(c.shortcutCloseTick - tick)}`;
        progress = phase === 'opening' ? 1 : (c.shortcutCloseTick - tick) / rules.shortcutOpenTicks;
      } else if (id === 'gate' && c.gateSwitchTick >= 0 && tick < c.gateSwitchTick) {
        state = 'active';
        label = `Shift ${clock(c.gateSwitchTick - tick)}`;
        progress = (c.gateSwitchTick - tick) / rules.gateWarnTicks;
      } else if (id === 'shortcut' && tick < c.shortcutReadyTick) {
        state = 'locked';
        label = `Lock ${clock(c.shortcutReadyTick - tick)}`;
      } else if (id === 'gate' && tick < c.gateReadyTick) {
        // Track-wide: nobody can shift the gate again until the lock runs out.
        state = 'locked';
        label = `Lock ${clock(c.gateReadyTick - tick)}`;
      } else if (cooldown > 0) {
        state = 'cooldown';
        label = `Cool ${clock(cooldown)}`;
        progress = 1 - cooldown / abilityCooldown(rules, id);
      } else if (v.energy < abilityCost(rules, id)) {
        state = 'low';
        label = `Need +${Math.ceil(abilityCost(rules, id) - v.energy)}`;
      }
      const hold = holds.current[k];
      if (now < hold.until) label = hold.text;
      const s = shown.current[k];
      const slot = slots.current[k];
      if (slot && state !== s.state) {
        slot.dataset.state = state;
        s.state = state;
      }
      const text = labels.current[k];
      if (text && label !== s.label) {
        text.textContent = label;
        s.label = label;
      }
      const bar = bars.current[k];
      if (bar) bar.style.width = `${Math.round(progress * 100)}%`;
    });
  });

  useEffect(() => {
    const feedback = (ability: AbilityId, used: boolean, reason?: AbilityDenial) => {
      const k = ABILITIES.indexOf(ability);
      const slot = slots.current[k];
      if (used) replay(slot, 'ability-fire');
      else {
        replay(slot, 'ability-denied');
        const short = abilityCost(session.sim.rules, ability) - session.racer.vehicle.energy;
        const text =
          reason === 'energy' && short > 0
            ? `Need +${Math.ceil(short)}`
            : DENIAL_TEXT[reason ?? 'busy'];
        holds.current[k] = { until: performance.now() + 1100, text };
      }
    };
    // The local car's own presses, felt at once.
    const offLocal = session.onEvent((event) => {
      if (!('racerId' in event) || event.racerId !== session.playerId) return;
      if (event.type === 'ability') feedback(event.ability, true);
      else if (event.type === 'abilityDenied') feedback(event.ability, false, event.reason);
    });
    // Online, the server may still refuse a press the car predicted (someone got there first).
    const offFeed = session.onFeed((event) => {
      if (session.mode !== 'online' || event.type !== 'abilityDenied') return;
      if (event.racerId !== session.playerId || event.reason !== 'busy') return;
      feedback(event.ability, false, event.reason);
    });
    return () => {
      offLocal();
      offFeed();
    };
  }, []);

  const tap = (id: AbilityId) => (e: PointerEvent<HTMLButtonElement>) => {
    // Never take keyboard focus away from driving.
    e.preventDefault();
    inputManager.tapAbility(id);
  };

  return (
    <div className="ability-bar pointer-events-auto flex gap-1.5" aria-label="Abilities">
      {ABILITIES.map((id, k) => (
        <button
          key={id}
          ref={(el) => {
            slots.current[k] = el;
          }}
          type="button"
          tabIndex={-1}
          className="ability-slot panel relative flex w-[5.4rem] flex-col items-start gap-0.5 px-2 pt-1.5 pb-2 text-left"
          onPointerDown={tap(id)}
          aria-label={`${NAMES[id]}, key ${ABILITY_KEYS[id]}, costs ${abilityCost(session.sim.rules, id)} Energy`}
          data-state="off"
        >
          <span className="flex w-full items-center gap-1.5">
            <span className="ability-icon">
              <AbilityIcon id={id} />
            </span>
            <span className="ability-cost digits text-[0.7rem]" title="Energy cost">
              {abilityCost(session.sim.rules, id)}
            </span>
            <kbd className="kbd ml-auto">{ABILITY_KEYS[id]}</kbd>
          </span>
          <span className="ability-name label">{NAMES[id]}</span>
          <span
            ref={(el) => {
              labels.current[k] = el;
            }}
            className="ability-state label"
          />
          <span className="absolute inset-x-1 bottom-0.5 h-[3px] overflow-hidden">
            <span
              ref={(el) => {
                bars.current[k] = el;
              }}
              className="ability-progress block h-full"
            />
          </span>
        </button>
      ))}
    </div>
  );
}
