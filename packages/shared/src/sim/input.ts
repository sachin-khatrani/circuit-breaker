import { clamp } from '../math/scalar';

/**
 * Everything a player controls, sampled once per tick. This is the only thing a client is
 * allowed to send to the server: held state, never outcomes.
 */
export interface PlayerInput {
  /** 0..1 */
  throttle: number;
  /** 0..1, reverses once stopped. */
  brake: number;
  /** -1..1, positive steers right. */
  steer: number;
  boost: boolean;
  drift: boolean;
  /** Held reset button; the sim acts on the press edge. */
  reset: boolean;
  /** Ability buttons (held state; each fires on its press edge). */
  shortcut: boolean;
  gate: boolean;
  overdrive: boolean;
}

export const NEUTRAL_INPUT: Readonly<PlayerInput> = Object.freeze({
  throttle: 0,
  brake: 0,
  steer: 0,
  boost: false,
  drift: false,
  reset: false,
  shortcut: false,
  gate: false,
  overdrive: false,
});

export function createInput(): PlayerInput {
  return { ...NEUTRAL_INPUT };
}

export function copyInput(from: Readonly<PlayerInput>, to: PlayerInput): PlayerInput {
  to.throttle = from.throttle;
  to.brake = from.brake;
  to.steer = from.steer;
  to.boost = from.boost;
  to.drift = from.drift;
  to.reset = from.reset;
  to.shortcut = from.shortcut;
  to.gate = from.gate;
  to.overdrive = from.overdrive;
  return to;
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Clamps an untrusted input into range. NaN, Infinity and wrong types become neutral values,
 * so a malformed packet can never push the simulation outside its envelope.
 */
export function sanitizeInput(
  raw: Partial<Record<keyof PlayerInput, unknown>>,
  out = createInput(),
): PlayerInput {
  out.throttle = clamp(finiteOr(raw.throttle, 0), 0, 1);
  out.brake = clamp(finiteOr(raw.brake, 0), 0, 1);
  out.steer = clamp(finiteOr(raw.steer, 0), -1, 1);
  out.boost = raw.boost === true;
  out.drift = raw.drift === true;
  out.reset = raw.reset === true;
  out.shortcut = raw.shortcut === true;
  out.gate = raw.gate === true;
  out.overdrive = raw.overdrive === true;
  return out;
}
