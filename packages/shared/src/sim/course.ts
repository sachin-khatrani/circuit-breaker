import type { RaceRules } from './config';

/**
 * The three abilities. Two change the track for everyone (and are scheduled a moment ahead,
 * so every player sees the change coming); Overdrive only affects the player's own car.
 */
export type AbilityId = 'shortcut' | 'gate' | 'overdrive';
export const ABILITIES: readonly AbilityId[] = ['shortcut', 'gate', 'overdrive'];

/** Why an ability press did nothing. */
export type AbilityDenial =
  /** Not during the countdown, after finishing, or once retired. */
  | 'phase'
  /** This player's cooldown for the ability is still running. */
  | 'cooldown'
  /** The track feature is changing or locked (or the car cannot boost right now). */
  | 'busy'
  /** Not enough Energy. Nothing is spent. */
  | 'energy'
  /** This track has no shortcut or no gate. */
  | 'unavailable';

/** Lanes of a split: 0 is the left lane, 1 the right lane. */
export const LEFT_LANE = 0;
export const RIGHT_LANE = 1;

/**
 * The logical state of the changeable track, identical for every player in a race. Every
 * change is stored with the tick it takes effect, so the state at any tick follows from it.
 */
export interface CourseState {
  /** Tick the shortcut opens, and the tick it closes again (-1: closed, nothing scheduled). */
  shortcutOpenTick: number;
  shortcutCloseTick: number;
  /** The shortcut may be opened again from this tick (it stays locked briefly after closing). */
  shortcutReadyTick: number;
  /** Open lane of the split now, and after the pending switch. */
  gateLane: number;
  gateNextLane: number;
  /** Tick the pending switch happens (-1: none pending). */
  gateSwitchTick: number;
  /** The gate may be shifted again from this tick. */
  gateReadyTick: number;
}

/** The race starts with the shortcut shut and the split's inside lane open. */
export function createCourseState(initialLane = RIGHT_LANE): CourseState {
  return {
    shortcutOpenTick: -1,
    shortcutCloseTick: -1,
    shortcutReadyTick: 0,
    gateLane: initialLane,
    gateNextLane: initialLane,
    gateSwitchTick: -1,
    gateReadyTick: 0,
  };
}

export function copyCourseState(from: Readonly<CourseState>, to: CourseState): CourseState {
  Object.assign(to, from);
  return to;
}

/** The shortcut's entrance is open at `tick`. */
export function shortcutOpenAt(c: Readonly<CourseState>, tick: number): boolean {
  return c.shortcutOpenTick >= 0 && tick >= c.shortcutOpenTick && tick < c.shortcutCloseTick;
}

/** Open lane of the split at `tick` (a pending switch counts from its tick on). */
export function gateLaneAt(c: Readonly<CourseState>, tick: number): number {
  return c.gateSwitchTick >= 0 && tick >= c.gateSwitchTick ? c.gateNextLane : c.gateLane;
}

/**
 * What players see of the shortcut: `locked`, `opening` (announced, about to open), `open`,
 * or `closing` (open, about to shut).
 */
export type ShortcutPhase = 'locked' | 'opening' | 'open' | 'closing';

export function shortcutPhase(
  c: Readonly<CourseState>,
  tick: number,
  rules: Readonly<RaceRules>,
): ShortcutPhase {
  if (c.shortcutOpenTick < 0 || tick >= c.shortcutCloseTick) return 'locked';
  if (tick < c.shortcutOpenTick) return 'opening';
  return c.shortcutCloseTick - tick <= rules.shortcutWarnTicks ? 'closing' : 'open';
}

/** Course state as seven integers for snapshots: the same for every player of a room. */
export function packCourse(c: Readonly<CourseState>): number[] {
  return [
    c.shortcutOpenTick,
    c.shortcutCloseTick,
    c.shortcutReadyTick,
    c.gateLane,
    c.gateNextLane,
    c.gateSwitchTick,
    c.gateReadyTick,
  ];
}

const COURSE_SIZE = 7;
const isTick = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= -1 && v <= 0x7fffffff;
const isLane = (v: unknown): v is number => v === LEFT_LANE || v === RIGHT_LANE;

/** Reads a packed course state; returns false (and changes nothing) if it is malformed. */
export function unpackCourse(raw: unknown, c: CourseState): boolean {
  if (!Array.isArray(raw) || raw.length !== COURSE_SIZE) return false;
  const [open, close, ready, lane, next, at, gateReady] = raw as unknown[];
  if (!isTick(open) || !isTick(close) || !isTick(ready) || !isTick(at) || !isTick(gateReady)) {
    return false;
  }
  if (!isLane(lane) || !isLane(next)) return false;
  c.shortcutOpenTick = open;
  c.shortcutCloseTick = close;
  c.shortcutReadyTick = ready;
  c.gateLane = lane;
  c.gateNextLane = next;
  c.gateSwitchTick = at;
  c.gateReadyTick = gateReady;
  return true;
}

/** Energy price of an ability. */
export function abilityCost(rules: Readonly<RaceRules>, id: AbilityId): number {
  return id === 'shortcut'
    ? rules.shortcutCost
    : id === 'gate'
      ? rules.gateCost
      : rules.overdriveCost;
}

/** Per-player cooldown after using an ability (ticks). */
export function abilityCooldown(rules: Readonly<RaceRules>, id: AbilityId): number {
  return id === 'shortcut'
    ? rules.shortcutCooldownTicks
    : id === 'gate'
      ? rules.gateCooldownTicks
      : rules.overdriveCooldownTicks;
}
