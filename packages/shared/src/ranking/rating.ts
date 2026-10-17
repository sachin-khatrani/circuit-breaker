/**
 * The global rating: multiplayer Elo. A rated race counts as one head-to-head result against
 * each other rated player in it, and those results are averaged, so one race moves a rating by
 * less than K whatever its size. Pure configuration and functions: the server applies them
 * inside the database transaction that stores the race (see apps/server/src/ranking).
 */

export const RATING_RULES = {
  /** Every profile starts here. */
  initial: 1000,
  /** No rating goes below this. */
  floor: 100,
  /** The most one race can move an established rating. */
  k: 32,
  /** The same for a profile's first `provisionalRaces` rated races, so it finds its level. */
  kProvisional: 48,
  provisionalRaces: 10,
  /** Elo scale: 400 points apart means 10 to 1 expected odds. */
  scale: 400,
  /**
   * Rematch damping: results against one opponent count less when the two have already had
   * this many rated races together in the last `rematchWindowHours`.
   */
  rematchWindowHours: 24,
  rematchSteps: [
    { from: 20, weight: 0 },
    { from: 10, weight: 0.25 },
    { from: 5, weight: 0.5 },
  ],
} as const;

/** One rated player's part in a race, from the server's results. */
export interface RatedRacer {
  id: string;
  /** Rating and rated races before this race. */
  rating: number;
  races: number;
  finished: boolean;
  /** Finish time (s) when finished; equal times are a draw. */
  time: number | null;
  /** Why not finished: still racing when the race was called, or left it. */
  dnfReason: 'racing' | 'left' | null;
}

export interface RatingChange {
  id: string;
  before: number;
  delta: number;
  after: number;
}

/** Finished first, then cars still racing when the race was called, then cars that left. */
function tier(racer: RatedRacer): number {
  if (racer.finished) return 0;
  return racer.dnfReason === 'left' ? 2 : 1;
}

/**
 * The result of `a` against `b`: 1 a win, 0 a loss, 0.5 a draw. Finishing beats not
 * finishing and the faster time wins; two cars that did not finish draw, except that a car
 * whose player left loses to one still racing.
 */
export function headToHead(a: RatedRacer, b: RatedRacer): number {
  const ta = tier(a);
  const tb = tier(b);
  if (ta !== tb) return ta < tb ? 1 : 0;
  if (ta === 0 && a.time !== null && b.time !== null && a.time !== b.time) {
    return a.time < b.time ? 1 : 0;
  }
  return 0.5;
}

/** Elo's expected result for a player rated `rating` against one rated `opponent`. */
export function expectedScore(rating: number, opponent: number): number {
  return 1 / (1 + 10 ** ((opponent - rating) / RATING_RULES.scale));
}

/** How much one head-to-head result counts, by rated races already shared in the window. */
export function rematchWeight(shared: number): number {
  for (const step of RATING_RULES.rematchSteps) if (shared >= step.from) return step.weight;
  return 1;
}

/** K for a profile with this many rated races before the race. */
export function kFactor(races: number): number {
  return races < RATING_RULES.provisionalRaces ? RATING_RULES.kProvisional : RATING_RULES.k;
}

/** Rounds half away from zero, so a gain and an equal loss round alike. */
function roundHalfAway(x: number): number {
  return Math.sign(x) * Math.round(Math.abs(x));
}

/**
 * Every rated player's change for one race. `shared(a, b)` is how many rated races players a
 * and b already had together in the rematch window (symmetric). The result does not depend on
 * the order of `racers`. Fewer than two racers change nothing.
 */
export function rateRace(
  racers: readonly RatedRacer[],
  shared: (a: string, b: string) => number = () => 0,
): RatingChange[] {
  const n = racers.length;
  return racers.map((racer) => {
    let sum = 0;
    for (const other of racers) {
      if (other.id === racer.id) continue;
      const weight = rematchWeight(shared(racer.id, other.id));
      sum += weight * (headToHead(racer, other) - expectedScore(racer.rating, other.rating));
    }
    const raw = n < 2 ? 0 : (kFactor(racer.races) / (n - 1)) * sum;
    const after = Math.max(RATING_RULES.floor, racer.rating + roundHalfAway(raw));
    return { id: racer.id, before: racer.rating, delta: after - racer.rating, after };
  });
}
