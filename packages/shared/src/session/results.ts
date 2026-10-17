import type { RaceStats } from '../net/protocol';
import type { RacerStats } from '../sim/race';
import { TICK_RATE } from '../sim/config';

/** What the final classification of a race is decided on. */
export interface ClassifiedRacer {
  finished: boolean;
  /** Race time at the finish line (sub-tick precise); null when not finished. */
  finishTime: number | null;
  /** Left the race (or never came back after a disconnect). */
  retired: boolean;
  /** Validated race distance (m). */
  progress: number;
  /** Grid slot (0 = pole). */
  slot: number;
}

/** 0 finishers, 1 still racing when the race was called, 2 left the race. */
function group(r: ClassifiedRacer): number {
  return r.finished ? 0 : r.retired ? 2 : 1;
}

/**
 * The final classification of a race, as the server publishes it:
 * 1. Finishers, by finish time. Finish times are sub-tick precise, so two cars crossing the
 *    line in the same tick are still told apart.
 * 2. Cars still racing when the race was called, by distance covered.
 * 3. Cars that left the race, by distance covered when they left.
 * Exactly equal results (the same finish time, or the same distance) go to the lower grid
 * slot. Slots are distinct, so the order is always total.
 */
export function compareResults(a: ClassifiedRacer, b: ClassifiedRacer): number {
  const ga = group(a);
  const gb = group(b);
  if (ga !== gb) return ga - gb;
  if (ga === 0) return (a.finishTime ?? 0) - (b.finishTime ?? 0) || a.slot - b.slot;
  return b.progress - a.progress || a.slot - b.slot;
}

/** Racers in result order (a new array; the input is not touched). */
export function classifyRacers<T extends ClassifiedRacer>(racers: readonly T[]): T[] {
  return [...racers].sort(compareResults);
}

/** A racer's simulation counters as the results show them. */
export function raceStats(stats: Readonly<RacerStats>): RaceStats {
  return {
    boosts: stats.boosts,
    overdrives: stats.overdrives,
    shortcuts: stats.shortcuts,
    gateShifts: stats.gateShifts,
    shortcutRuns: stats.shortcutRuns,
    energy: Math.round(stats.cellEnergy + stats.driftEnergy + stats.laneEnergy),
    driftSeconds: Math.round((stats.driftTicks / TICK_RATE) * 10) / 10,
    topSpeed: Math.round(stats.topSpeed * 10) / 10,
    wallHits: stats.wallHits,
  };
}
