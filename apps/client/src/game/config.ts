import { GRID_ZERO, RACE_RULES } from '@circuit-breaker/shared';

const devParams = import.meta.env.DEV ? new URLSearchParams(window.location.search) : null;

function devNumber(name: string): number | null {
  const raw = devParams?.get(name);
  if (raw === null || raw === undefined || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * Solo race settings, in one place for balancing. Development builds also accept URL
 * overrides for quick playtests: `?laps=N`, `?energy=N` (starting Energy, 0–100),
 * `?autopilot=1` (the autopilot drives the player's car) and `?boost=0` (the autopilot never
 * bursts, so it keeps its Energy for abilities).
 */
export const RACE_CONFIG = {
  laps: devNumber('laps') ?? GRID_ZERO.defaultLaps,
  /** Energy every car starts a race with. 40 while testing; balance it here. */
  startEnergy: devNumber('energy') ?? RACE_RULES.startEnergy,
  autopilot: devParams?.has('autopilot') ?? false,
  autopilotBoost: devParams?.get('boost') !== '0',
};
