import { describe, expect, it } from 'vitest';
import { autopilotInput } from '../src/sim/autopilot';
import { RACE_RULES, TICK_RATE, VEHICLE_TUNING } from '../src/sim/config';
import type { RaceEvent } from '../src/sim/events';
import { createInput } from '../src/sim/input';
import { RaceSimulation, type RacerState } from '../src/sim/race';
import { placeVehicle } from '../src/sim/vehicle';
import { Track } from '../src/track/track';
import { GRID_ZERO } from '../src/track/tracks/gridZero';

const track = new Track(GRID_ZERO);

interface RaceRun {
  sim: RaceSimulation;
  racer: RacerState;
  events: RaceEvent[];
  /** Ticks the car spent off the road surface. */
  offRoadTicks: number;
  /** Largest distance past a walled road edge, in metres (should stay <= 0). */
  wallOvershoot: number;
}

/** Drives a whole race with the autopilot; `each` may meddle with the racer every tick. */
function runAutopilotRace(
  laps: number,
  boost: boolean,
  each?: (sim: RaceSimulation, racer: RacerState) => void,
): RaceRun {
  const sim = new RaceSimulation(track, { laps });
  const racer = sim.addRacer('bot', 'Bot');
  const input = createInput();
  const events: RaceEvent[] = [];
  const limit = TICK_RATE * 60 * 6;
  let offRoadTicks = 0;
  let wallOvershoot = -Infinity;
  while (sim.phase !== 'finished' && sim.tick < limit) {
    autopilotInput(track, racer.vehicle, { boost, racingLine: true }, input);
    if (sim.phase === 'countdown') input.throttle = 0;
    sim.setInput('bot', input);
    each?.(sim, racer);
    sim.step();
    events.push(...sim.drainEvents());
    const v = racer.vehicle;
    if (v.surface !== 'road') offRoadTicks++;
    if (track.hasWall(v.trackIndex, v.lateral)) {
      const limitLat = track.halfWidth[v.trackIndex] - VEHICLE_TUNING.halfWidth;
      wallOvershoot = Math.max(wallOvershoot, Math.abs(v.lateral) - limitLat);
    }
  }
  return { sim, racer, events, offRoadTicks, wallOvershoot };
}

describe('race flow', () => {
  it('lets the autopilot finish three laps in a plausible time', () => {
    const run = runAutopilotRace(3, true);
    const { sim, racer, events } = run;
    expect(sim.phase).toBe('finished');
    expect(racer.finished).toBe(true);
    expect(racer.lapTimes).toHaveLength(3);
    for (const lap of racer.lapTimes) {
      expect(lap).toBeGreaterThan(35);
      expect(lap).toBeLessThan(75);
    }
    expect(racer.finishTime).toBeCloseTo(
      racer.lapTimes.reduce((a, b) => a + b, 0),
      6,
    );
    const checkpoints = events.filter((e) => e.type === 'checkpoint');
    expect(checkpoints).toHaveLength(3 * (track.checkpoints.length - 1));
    expect(events.filter((e) => e.type === 'lap')).toHaveLength(3);
    expect(events.at(-1)?.type).toBe('raceFinished');
    expect(racer.stats.cellsCollected).toBeGreaterThan(0);
    expect(racer.stats.wallHits).toBeLessThan(6);
    // The open Skyway edges must not catch a clean racing line.
    expect(racer.stats.falls).toBe(0);
    // Every pad on every lap, a burst whenever the road allows, and never off the surface.
    expect(racer.stats.padsHit).toBe(3 * track.pads.length);
    expect(racer.stats.boosts).toBeGreaterThan(6);
    expect(run.offRoadTicks).toBe(0);
    // The finish comes exactly once, right after the final lap.
    const finishes = events.filter((e) => e.type === 'finish');
    expect(finishes).toHaveLength(1);
    const lastLap = events.findLastIndex((e) => e.type === 'lap');
    expect(events[lastLap + 1]?.type).toBe('finish');
  });

  it('keeps a car boosting flat out inside the barriers and through every checkpoint', () => {
    // A burst that never ends: the car runs at boost speed wherever the autopilot allows.
    const run = runAutopilotRace(2, true, (sim, racer) => {
      if (sim.phase === 'racing') racer.vehicle.boostLeft = Math.max(racer.vehicle.boostLeft, 2);
    });
    expect(run.racer.finished).toBe(true);
    expect(run.events.filter((e) => e.type === 'checkpoint')).toHaveLength(
      2 * (track.checkpoints.length - 1),
    );
    expect(run.wallOvershoot).toBeLessThan(1e-6);
    expect(run.racer.stats.falls).toBe(0);
    expect(run.racer.stats.topSpeed).toBeLessThanOrEqual(VEHICLE_TUNING.boostMaxSpeed + 0.5);
  });

  it('still counts laps and finishes correctly when the car is reset mid-race', () => {
    let resets = 0;
    const run = runAutopilotRace(2, false, (sim, racer) => {
      // Press reset twice on lap 1 and once on lap 2, well clear of any gate.
      const due =
        (racer.lap === 0 && (sim.tick === 1500 || sim.tick === 2100)) || sim.tick === 4200;
      sim.setInput('bot', { ...racer.input, reset: due });
      if (due) resets++;
    });
    expect(resets).toBe(3);
    expect(run.racer.stats.respawns).toBe(3);
    expect(run.racer.finished).toBe(true);
    expect(run.racer.lapTimes).toHaveLength(2);
    expect(run.events.filter((e) => e.type === 'checkpoint')).toHaveLength(
      2 * (track.checkpoints.length - 1),
    );
  });

  it('holds cars during the countdown and emits 3-2-1-GO', () => {
    const sim = new RaceSimulation(track);
    const racer = sim.addRacer('p', 'P');
    const start = { x: racer.vehicle.x, z: racer.vehicle.z };
    const input = { ...createInput(), throttle: 1 };
    const counts: number[] = [];
    while (sim.phase === 'countdown') {
      sim.setInput('p', input);
      sim.step();
      for (const e of sim.drainEvents()) if (e.type === 'countdown') counts.push(e.count);
    }
    expect(counts).toEqual([3, 2, 1]);
    expect(sim.tick).toBe(RACE_RULES.countdownTicks);
    expect(racer.vehicle.x).toBe(start.x);
    expect(racer.vehicle.z).toBe(start.z);
  });

  it('reverses from a standstill on the real grid, which sits on a slight grade', () => {
    const sim = new RaceSimulation(track, { skipCountdown: true });
    const racer = sim.addRacer('p', 'P');
    for (let i = 0; i < TICK_RATE; i++) {
      sim.setInput('p', { ...createInput(), brake: 1 });
      sim.step();
    }
    expect(racer.vehicle.forwardSpeed).toBeLessThan(-5);
  });

  it('awards the launch boost only for a late throttle press', () => {
    const run = (pressAtRemaining: number) => {
      const sim = new RaceSimulation(track);
      sim.addRacer('p', 'P');
      let launched = false;
      while (sim.phase === 'countdown') {
        const remaining = sim.goTick - sim.tick;
        sim.setInput('p', { ...createInput(), throttle: remaining <= pressAtRemaining ? 1 : 0 });
        sim.step();
        launched ||= sim.drainEvents().some((e) => e.type === 'launchBoost');
      }
      return launched;
    };
    expect(run(10)).toBe(true);
    expect(run(RACE_RULES.launchWindowTicks + 30)).toBe(false);
  });
});

describe('race options', () => {
  it('starts every car with the configured Energy, clamped to the bar', () => {
    const custom = new RaceSimulation(track, { startEnergy: 70 });
    expect(custom.addRacer('a', 'A').vehicle.energy).toBe(70);
    const empty = new RaceSimulation(track, { startEnergy: 0 });
    expect(empty.addRacer('a', 'A').vehicle.energy).toBe(0);
    const over = new RaceSimulation(track, { startEnergy: 500 });
    expect(over.addRacer('a', 'A').vehicle.energy).toBe(RACE_RULES.maxEnergy);
    const fallback = new RaceSimulation(track);
    expect(fallback.addRacer('a', 'A').vehicle.energy).toBe(RACE_RULES.startEnergy);
  });
});

describe('checkpoint rules', () => {
  it('does not count a lap when checkpoints are skipped', () => {
    const sim = new RaceSimulation(track, { skipCountdown: true });
    const racer = sim.addRacer('p', 'P');
    const input = { ...createInput(), throttle: 1 };
    // Cross the start line to begin lap 1.
    for (let i = 0; i < 60; i++) {
      sim.setInput('p', input);
      sim.step();
    }
    expect(racer.started).toBe(true);
    expect(racer.nextCheckpoint).toBe(1);
    // Teleport to just before the line, skipping checkpoints 1-3, and drive over it.
    placeVehicle(racer.vehicle, track, track.length - 20, 0);
    for (let i = 0; i < 120; i++) {
      sim.setInput('p', input);
      sim.step();
    }
    expect(racer.lap).toBe(0);
    expect(racer.nextCheckpoint).toBe(1);
    expect(sim.drainEvents().some((e) => e.type === 'lap')).toBe(false);
  });

  it('ignores a gate crossed in reverse', () => {
    const sim = new RaceSimulation(track, { skipCountdown: true });
    const racer = sim.addRacer('p', 'P');
    const gate = track.checkpoints[1];
    racer.started = true;
    racer.nextCheckpoint = 1;
    // Start just past checkpoint 1, turned around, and drive back over it.
    placeVehicle(racer.vehicle, track, gate.s + 15, 0);
    racer.vehicle.yaw += Math.PI;
    for (let i = 0; i < 120; i++) {
      sim.setInput('p', { ...createInput(), throttle: 1 });
      sim.step();
    }
    expect(racer.nextCheckpoint).toBe(1);
    expect(sim.drainEvents().some((e) => e.type === 'checkpoint')).toBe(false);
  });

  it('respawns on the centre line, frozen, without crossing anything', () => {
    const sim = new RaceSimulation(track, { skipCountdown: true });
    const racer = sim.addRacer('p', 'P');
    for (let i = 0; i < 90; i++) {
      sim.setInput('p', { ...createInput(), throttle: 1, steer: 0.4 });
      sim.step();
    }
    sim.setInput('p', { ...createInput(), reset: true });
    sim.step();
    expect(racer.vehicle.frozenTicks).toBeGreaterThan(0);
    expect(Math.abs(racer.vehicle.lateral)).toBeLessThan(0.01);
    const frozenAt = { x: racer.vehicle.x, z: racer.vehicle.z };
    sim.setInput('p', { ...createInput(), throttle: 1 });
    for (let i = 0; i < RACE_RULES.respawnFreezeTicks - 2; i++) sim.step();
    expect(racer.vehicle.x).toBe(frozenAt.x);
    expect(racer.vehicle.z).toBe(frozenAt.z);
    expect(sim.drainEvents().filter((e) => e.type === 'respawn')).toHaveLength(1);
  });

  it('never pays out a collected cell twice before it respawns', () => {
    const sim = new RaceSimulation(track, { skipCountdown: true });
    const racer = sim.addRacer('p', 'P');
    const cell = track.cells[0];
    /** Drives over cell 0 and returns how many times it paid out. */
    const pass = () => {
      placeVehicle(racer.vehicle, track, cell.s - 10, cell.lateral);
      let paid = 0;
      for (let i = 0; i < 75; i++) {
        sim.setInput('p', { ...createInput(), throttle: 1 });
        sim.step();
        for (const e of sim.drainEvents()) if (e.type === 'cell' && e.cellId === 0) paid++;
      }
      return paid;
    };
    expect(pass()).toBe(1);
    expect(sim.cells[0].active).toBe(false);
    expect(pass()).toBe(0);
    for (let i = 0; i < RACE_RULES.cellRespawnTicks; i++) sim.step();
    expect(pass()).toBe(1);
  });

  it('collects Energy cells and respawns them later', () => {
    const sim = new RaceSimulation(track, { skipCountdown: true });
    const racer = sim.addRacer('p', 'P');
    const cell = track.cells[0];
    placeVehicle(racer.vehicle, track, cell.s - 10, cell.lateral);
    const before = racer.vehicle.energy;
    for (let i = 0; i < 75; i++) {
      sim.setInput('p', { ...createInput(), throttle: 1 });
      sim.step();
    }
    expect(racer.vehicle.energy).toBeGreaterThan(before);
    expect(sim.cells[0].active).toBe(false);
    for (let i = 0; i < RACE_RULES.cellRespawnTicks; i++) sim.step();
    expect(sim.cells[0].active).toBe(true);
  });
});
