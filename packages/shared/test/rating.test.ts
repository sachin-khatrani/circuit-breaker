import { describe, expect, it } from 'vitest';
import {
  expectedScore,
  headToHead,
  kFactor,
  RATING_RULES,
  rateRace,
  rematchWeight,
  type RatedRacer,
} from '../src';

/** A racer who finished in `time` seconds (rating 1000, established unless `races` says not). */
const fin = (id: string, time: number, rating = 1000, races = 20): RatedRacer => ({
  id,
  rating,
  races,
  finished: true,
  time,
  dnfReason: null,
});
const dnf = (id: string, dnfReason: 'racing' | 'left', rating = 1000, races = 20): RatedRacer => ({
  id,
  rating,
  races,
  finished: false,
  time: null,
  dnfReason,
});
const deltas = (racers: RatedRacer[], shared?: (a: string, b: string) => number) =>
  Object.fromEntries(rateRace(racers, shared).map((c) => [c.id, c.delta]));

describe('rating rules', () => {
  it('starts everyone at 1000 with K 48 for ten races, then 32', () => {
    expect(RATING_RULES.initial).toBe(1000);
    expect(kFactor(0)).toBe(48);
    expect(kFactor(9)).toBe(48);
    expect(kFactor(10)).toBe(32);
    expect(expectedScore(1000, 1000)).toBe(0.5);
    // 400 points apart: 10 to 1.
    expect(expectedScore(1400, 1000)).toBeCloseTo(10 / 11, 12);
  });

  it('scores a two-player race as plain Elo', () => {
    expect(deltas([fin('a', 45), fin('b', 46)])).toEqual({ a: 16, b: -16 });
    // New players move faster.
    expect(deltas([fin('a', 45, 1000, 0), fin('b', 46, 1000, 0)])).toEqual({ a: 24, b: -24 });
    // Beating a stronger player is worth more than beating a weaker one.
    const upset = deltas([fin('low', 45, 1000), fin('high', 46, 1400)]);
    const expectedWin = deltas([fin('high', 45, 1400), fin('low', 46, 1000)]);
    expect(upset.low).toBe(29);
    expect(expectedWin.high).toBe(3);
    expect(upset.low).toBeGreaterThan(expectedWin.high);
  });

  it('averages the head-to-head results of a larger race, worth the same at most', () => {
    const field = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'].map((id, i) => fin(id, 45 + i));
    const d = deltas(field);
    // Equal ratings: the winner beats everyone (+K/2), the last loses to everyone (−K/2).
    expect(d.p1).toBe(16);
    expect(d.p8).toBe(-16);
    // 4th beats 4 and loses to 3: (4 − 3) × 0.5 / 7 × 32 = 2.3.
    expect(d.p4).toBe(2);
    expect(d.p5).toBe(-2);
    // Places are monotonic.
    const order = field.map((r) => d[r.id]);
    expect([...order].sort((x, y) => y - x)).toEqual(order);
  });

  it('puts finishers above non-finishers, and a car that left below one still racing', () => {
    const a = fin('a', 50);
    const racing = dnf('r', 'racing');
    const left = dnf('l', 'left');
    expect(headToHead(a, racing)).toBe(1);
    expect(headToHead(racing, a)).toBe(0);
    expect(headToHead(racing, left)).toBe(1);
    expect(headToHead(left, racing)).toBe(0);
    // Two cars that did not finish for the same reason draw.
    expect(headToHead(dnf('x', 'racing'), dnf('y', 'racing'))).toBe(0.5);
    expect(headToHead(dnf('x', 'left'), dnf('y', 'left'))).toBe(0.5);
    const d = deltas([a, racing, left]);
    expect(d.a).toBeGreaterThan(0);
    expect(d.l).toBeLessThan(d.r);
  });

  it('makes an exactly equal finish time a draw', () => {
    expect(headToHead(fin('a', 45.5), fin('b', 45.5))).toBe(0.5);
    expect(deltas([fin('a', 45.5), fin('b', 45.5)])).toEqual({ a: 0, b: 0 });
    // A draw between unequal ratings moves them toward each other.
    const d = deltas([fin('a', 45.5, 1200), fin('b', 45.5, 1000)]);
    expect(d.a).toBeLessThan(0);
    expect(d.b).toBeGreaterThan(0);
  });

  it('never moves a rating by more than K, never below the floor, and is near zero-sum', () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let race = 0; race < 2000; race++) {
      const n = 2 + Math.floor(random() * 7);
      const racers: RatedRacer[] = [];
      for (let i = 0; i < n; i++) {
        const rating = 100 + Math.floor(random() * 2900);
        const races = Math.floor(random() * 30);
        const roll = random();
        racers.push(
          roll < 0.7
            ? fin(`r${i}`, 40 + random() * 20, rating, races)
            : dnf(`r${i}`, roll < 0.85 ? 'racing' : 'left', rating, races),
        );
      }
      const changes = rateRace(racers);
      for (const [i, change] of changes.entries()) {
        expect(Math.abs(change.delta)).toBeLessThanOrEqual(kFactor(racers[i].races));
        expect(change.after).toBeGreaterThanOrEqual(RATING_RULES.floor);
        expect(change.after).toBe(change.before + change.delta);
      }
      // Same K for everyone and nobody at the floor: what one gains, the others lose, give or
      // take the rounding of each change.
      const sameK = racers.every((r) => kFactor(r.races) === kFactor(racers[0].races));
      const atFloor = racers.some((r) => r.rating < RATING_RULES.floor + 50);
      if (sameK && !atFloor) {
        const total = changes.reduce((sum, c) => sum + c.delta, 0);
        expect(Math.abs(total)).toBeLessThanOrEqual(n / 2);
      }
    }
  });

  it('stops at the floor', () => {
    const d = rateRace([fin('a', 45, 110), fin('b', 46, 110), dnf('c', 'left', 105, 0)]);
    expect(d.find((c) => c.id === 'c')!.after).toBe(RATING_RULES.floor);
    // Losing to far stronger players costs next to nothing: Elo expected the loss.
    const favourites = rateRace([fin('a', 45, 2900), dnf('c', 'left', 105, 0)]);
    expect(favourites.find((c) => c.id === 'c')!.delta).toBe(0);
  });

  it('does not depend on the order of the racers', () => {
    const racers = [fin('a', 47, 1100), dnf('b', 'racing', 990), fin('c', 45, 1250, 3)];
    const forward = deltas(racers);
    expect(deltas([...racers].reverse())).toEqual(forward);
    expect(deltas([racers[1], racers[2], racers[0]])).toEqual(forward);
  });

  it('counts rematches less: half after 5 shared races in a day, nothing after 20', () => {
    expect([0, 4, 5, 9, 10, 19, 20, 99].map(rematchWeight)).toEqual([
      1, 1, 0.5, 0.5, 0.25, 0.25, 0, 0,
    ]);
    const pair = [fin('a', 45), fin('b', 46)];
    expect(deltas(pair, () => 5)).toEqual({ a: 8, b: -8 });
    expect(deltas(pair, () => 20)).toEqual({ a: 0, b: 0 });
    // Only the pair that keeps meeting is damped.
    const trio = [fin('a', 45), fin('b', 46), fin('c', 47)];
    const farmed = (x: string, y: string) => ([x, y].sort().join() === 'a,b' ? 25 : 0);
    const d = deltas(trio, farmed);
    expect(d.a).toBe(8); // only its win over c counts: 32 / 2 × 0.5
    expect(d.c).toBe(-16);
  });

  it('changes nothing for a lone rated racer', () => {
    expect(rateRace([fin('a', 45)])).toEqual([{ id: 'a', before: 1000, delta: 0, after: 1000 }]);
  });
});
