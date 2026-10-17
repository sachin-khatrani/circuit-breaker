/**
 * Session scoring: points for each race by finishing position, added up over the races of one
 * room session. This is configuration plus two small pure functions; the server applies them
 * once per race (see Room). Nothing here knows about the race engine, so it can be tuned alone.
 */

/** Points by finishing position: 1st, 2nd, … A finisher below the table's end scores 0. */
export const POINTS_TABLE: readonly number[] = [100, 80, 65, 50, 40, 30, 20, 10];

/**
 * A car that did not finish (it left, never came back, or was still racing when the race was
 * called) scores this, whatever its place in the results.
 */
export const DNF_POINTS = 0;

/** Points one result is worth. `position` is 1-based. */
export function racePoints(
  position: number,
  finished: boolean,
  table: readonly number[] = POINTS_TABLE,
): number {
  if (!finished) return DNF_POINTS;
  return table[position - 1] ?? 0;
}

/** What the session order is decided on. */
export interface SessionRecord {
  points: number;
  wins: number;
  /** Join order in the room (0 first). */
  order: number;
}

/**
 * Session standings: more points first; equal points go to more wins, then to whoever joined
 * the room first. Every player gets a distinct rank, so the order never depends on timing.
 */
export function compareSession(a: SessionRecord, b: SessionRecord): number {
  return b.points - a.points || b.wins - a.wins || a.order - b.order;
}

/**
 * The starting grid of the next race: the reverse of the session standings, so the fewest
 * points start at the front and the leader starts last. Ties (everyone at 0 in a session's
 * first race) go by join order, the host first.
 */
export function compareGrid(a: SessionRecord, b: SessionRecord): number {
  return a.points - b.points || a.wins - b.wins || a.order - b.order;
}
