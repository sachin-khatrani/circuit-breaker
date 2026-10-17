import { describe, expect, it } from 'vitest';
import {
  classifyRacers,
  compareGrid,
  compareResults,
  compareSession,
  DNF_POINTS,
  GRID_ZERO,
  isVehicleChoice,
  PLAYER_COLORS,
  POINTS_TABLE,
  RaceSimulation,
  racePoints,
  raceStats,
  Track,
  VEHICLE_STYLES,
  autopilotInput,
  createInput,
  type ClassifiedRacer,
} from '../src';

const finisher = (slot: number, finishTime: number): ClassifiedRacer & { id: string } => ({
  id: `f${slot}`,
  slot,
  finished: true,
  finishTime,
  retired: false,
  progress: Infinity,
});
const running = (slot: number, progress: number): ClassifiedRacer & { id: string } => ({
  id: `r${slot}`,
  slot,
  finished: false,
  finishTime: null,
  retired: false,
  progress,
});
const left = (slot: number, progress: number): ClassifiedRacer & { id: string } => ({
  id: `l${slot}`,
  slot,
  finished: false,
  finishTime: null,
  retired: true,
  progress,
});

describe('scoring table', () => {
  it('gives points by place, nothing past the table, and DNF_POINTS to a non-finisher', () => {
    expect(POINTS_TABLE).toEqual([100, 80, 65, 50, 40, 30, 20, 10]);
    expect(racePoints(1, true)).toBe(100);
    expect(racePoints(3, true)).toBe(65);
    expect(racePoints(8, true)).toBe(10);
    expect(racePoints(9, true)).toBe(0);
    expect(DNF_POINTS).toBe(0);
    // A car that did not finish scores nothing, whatever its place in the classification.
    expect(racePoints(1, false)).toBe(0);
    expect(racePoints(4, false)).toBe(DNF_POINTS);
    // The table is configuration: another one can be passed in.
    expect(racePoints(2, true, [10, 6, 4])).toBe(6);
  });

  it('ranks the session by points, then wins, then join order, every rank distinct', () => {
    const players = [
      { name: 'a', points: 180, wins: 1, order: 0 },
      { name: 'b', points: 180, wins: 2, order: 1 },
      { name: 'c', points: 245, wins: 1, order: 2 },
      { name: 'd', points: 180, wins: 2, order: 3 },
      { name: 'e', points: 0, wins: 0, order: 4 },
    ];
    const order = [...players].sort(compareSession).map((p) => p.name);
    expect(order).toEqual(['c', 'b', 'd', 'a', 'e']);
  });

  it('builds the grid in reverse: fewest points at the front, join order breaking ties', () => {
    const players = [
      { name: 'leader', points: 200, wins: 2, order: 0 },
      { name: 'last', points: 40, wins: 0, order: 1 },
      { name: 'mid', points: 145, wins: 0, order: 2 },
    ];
    expect([...players].sort(compareGrid).map((p) => p.name)).toEqual(['last', 'mid', 'leader']);
    // A session's first race: everyone on zero, so join order (the host first).
    const fresh = [2, 0, 1].map((order) => ({ name: `j${order}`, points: 0, wins: 0, order }));
    expect([...fresh].sort(compareGrid).map((p) => p.name)).toEqual(['j0', 'j1', 'j2']);
  });
});

describe('race classification', () => {
  it('puts finishers first by finish time, then cars still racing by distance, then leavers', () => {
    const racers = [
      left(0, 5000),
      running(1, 2500),
      finisher(2, 47.1),
      running(3, 2900),
      finisher(4, 45.9),
      left(5, 900),
    ];
    expect(classifyRacers(racers).map((r) => r.id)).toEqual(['f4', 'f2', 'r3', 'r1', 'l0', 'l5']);
  });

  it('breaks exact ties by grid slot, and never depends on the input order', () => {
    const tie = [finisher(3, 45.5), finisher(1, 45.5), finisher(2, 45.25)];
    expect(classifyRacers(tie).map((r) => r.slot)).toEqual([2, 1, 3]);
    const reversed = [...tie].reverse();
    expect(classifyRacers(reversed).map((r) => r.slot)).toEqual([2, 1, 3]);
    const parked = [running(4, 1200), running(0, 1200), left(6, 300), left(2, 300)];
    expect(classifyRacers(parked).map((r) => r.slot)).toEqual([0, 4, 2, 6]);
    expect(compareResults(finisher(0, 50), running(1, 99999))).toBeLessThan(0);
  });

  it('matches the simulation’s own final standings in a real race', () => {
    const track = new Track(GRID_ZERO);
    const sim = new RaceSimulation(track, { laps: 1 });
    const paces = [1, 0.97, 0.93];
    paces.forEach((_, slot) => sim.addRacer(`p${slot}`, `p${slot}`, slot));
    const input = createInput();
    while (sim.phase !== 'finished' && sim.tick < 60 * 200) {
      for (const r of sim.racers) {
        autopilotInput(track, r.vehicle, { racingLine: true, pace: paces[r.slot] }, input);
        if (sim.phase === 'countdown') input.throttle = sim.goTick - sim.tick < 15 ? 1 : 0;
        sim.setInput(r.id, input);
      }
      sim.step();
    }
    const classified = classifyRacers(sim.racers);
    expect(classified.map((r) => r.position)).toEqual([1, 2, 3]);
    expect(classified.every((r) => r.finished)).toBe(true);
    const stats = raceStats(classified[0].stats);
    expect(stats.energy).toBe(
      Math.round(
        classified[0].stats.cellEnergy +
          classified[0].stats.driftEnergy +
          classified[0].stats.laneEnergy,
      ),
    );
    expect(stats.topSpeed).toBeGreaterThan(60);
    expect(stats.boosts).toBe(classified[0].stats.boosts);
  });
});

describe('vehicle choices', () => {
  it('accepts only colour and style indices that exist', () => {
    expect(isVehicleChoice(0, 0)).toBe(true);
    expect(isVehicleChoice(PLAYER_COLORS.length - 1, VEHICLE_STYLES.length - 1)).toBe(true);
    for (const [color, style] of [
      [PLAYER_COLORS.length, 0],
      [-1, 0],
      [0, VEHICLE_STYLES.length],
      [1.5, 0],
      ['1', 0],
      [null, 0],
      [0, undefined],
    ] as const) {
      expect(isVehicleChoice(color, style)).toBe(false);
    }
  });
});
