import { describe, expect, it } from 'vitest';
import {
  createInput,
  GRID_ZERO,
  placeVehicle,
  RACE_RULES,
  RaceSimulation,
  Track,
  type AbilityId,
  type PlayerInput,
  type RaceEvent,
  type RacerState,
} from '../src';

/**
 * Race-rule boundary cases (Step 9 audit): things that happen on the same tick, or on the
 * exact tick a rule changes. Every case must end in one documented, deterministic state.
 */

const track = new Track(GRID_ZERO);
const rules = RACE_RULES;

function race(ids: string[], startEnergy = 100, laps = 1): RaceSimulation {
  const sim = new RaceSimulation(track, { laps, skipCountdown: true, startEnergy });
  ids.forEach((id, slot) => sim.addRacer(id, id, slot));
  return sim;
}

function step(sim: RaceSimulation, inputs: Record<string, Partial<PlayerInput>> = {}): RaceEvent[] {
  for (const r of sim.racers) sim.setInput(r.id, { ...createInput(), ...inputs[r.id] });
  sim.step();
  return sim.drainEvents();
}

/** Steps until the simulation's tick is `tick` (no input). */
function stepTo(sim: RaceSimulation, tick: number): void {
  while (sim.tick < tick) step(sim);
}

/** Puts a racer on the main road at s, lateral, moving forward at `speed`. */
function launch(r: RacerState, s: number, lateral: number, speed: number): void {
  placeVehicle(r.vehicle, track, s, lateral);
  const v = r.vehicle;
  v.vx = Math.sin(v.yaw) * speed;
  v.vz = Math.cos(v.yaw) * speed;
  r.prevX = v.x;
  r.prevZ = v.z;
}

const denials = (events: RaceEvent[], ability: AbilityId) =>
  events.filter((e) => e.type === 'abilityDenied' && e.ability === ability);
const uses = (events: RaceEvent[], ability: AbilityId) =>
  events.filter((e) => e.type === 'ability' && e.ability === ability);

describe('race rules at their boundaries', () => {
  it('pays three abilities pressed in one tick in a fixed order, until the Energy runs out', () => {
    const sim = race(['a']);
    const events = step(sim, { a: { shortcut: true, gate: true, overdrive: true } });
    const presses = events.filter((e) => e.type === 'ability' || e.type === 'abilityDenied');
    // Shortcut (45) and Gate Shift (30) fit in 100 Energy; Overdrive (40) no longer does.
    expect(presses.map((e) => `${e.type} ${'ability' in e ? e.ability : ''}`)).toEqual([
      'ability shortcut',
      'ability gate',
      'abilityDenied overdrive',
    ]);
    expect(denials(events, 'overdrive')[0]).toMatchObject({ reason: 'energy' });
    expect(sim.racers[0].vehicle.energy).toBe(100 - rules.shortcutCost - rules.gateCost);
  });

  it('refuses the shortcut on the tick it closes, and opens it again from its ready tick', () => {
    const sim = race(['a', 'b']);
    step(sim, { a: { shortcut: true } });
    const course = sim.course;
    const closeTick = course.shortcutCloseTick;
    stepTo(sim, closeTick - 1);
    // B presses on the closing tick: the track closes first, then the lock refuses B.
    const atClose = step(sim, { b: { shortcut: true } });
    expect(sim.tick).toBe(closeTick);
    expect(denials(atClose, 'shortcut')[0]).toMatchObject({ racerId: 'b', reason: 'busy' });
    expect(course.shortcutReadyTick).toBe(closeTick + rules.shortcutLockTicks);
    stepTo(sim, course.shortcutReadyTick - 1);
    const atReady = step(sim, { b: { shortcut: true } });
    expect(uses(atReady, 'shortcut')).toHaveLength(1);
    expect(sim.racers[1].vehicle.energy).toBe(100 - rules.shortcutCost);
  });

  it('refuses a gate shift on the tick the last one lands, and allows one once it unlocks', () => {
    const sim = race(['a', 'b']);
    step(sim, { a: { gate: true } });
    const course = sim.course;
    const switchTick = course.gateSwitchTick;
    stepTo(sim, switchTick - 1);
    const atSwitch = step(sim, { b: { gate: true } });
    expect(denials(atSwitch, 'gate')[0]).toMatchObject({ racerId: 'b', reason: 'busy' });
    expect(course.gateReadyTick).toBe(switchTick + rules.gateLockTicks);
    stepTo(sim, course.gateReadyTick - 1);
    expect(uses(step(sim, { b: { gate: true } }), 'gate')).toHaveLength(1);
  });

  it('pays one Energy cell once when two cars reach it in the same tick', () => {
    const sim = race(['a', 'b'], 0);
    const cell = track.cells[0];
    for (const r of sim.racers) launch(r, cell.s - 6, cell.lateral, 30);
    const pickups: Extract<RaceEvent, { type: 'cell' }>[] = [];
    for (let i = 0; i < 30; i++) {
      for (const e of step(sim, { a: { throttle: 1 }, b: { throttle: 1 } })) {
        if (e.type === 'cell' && e.cellId === 0) pickups.push(e);
      }
    }
    // The first car in racer order takes it; the other finds it gone in the same tick.
    expect(pickups).toHaveLength(1);
    expect(pickups[0]).toMatchObject({ racerId: 'a', gained: rules.cellEnergy });
    expect(sim.cells[0].active).toBe(false);
  });

  it('counts a car crossing the line on the very last tick of the finish grace', () => {
    const sim = race(['a', 'b']);
    const [a, b] = sim.racers;
    // A is about to finish its last lap; B waits further back.
    a.started = true;
    a.nextCheckpoint = 0;
    a.lap = sim.laps - 1;
    launch(a, track.length - 5, 0, 40);
    b.started = true;
    b.nextCheckpoint = 0;
    b.lap = sim.laps - 1;
    placeVehicle(b.vehicle, track, track.length - 200, 0);
    while (!a.finished) step(sim);
    const lastTick = sim.firstFinishTick! + rules.finishGraceTicks;
    stepTo(sim, lastTick - 1);
    expect(sim.phase).toBe('racing');
    // B crosses within the tick that ends the race: it still finishes, second.
    launch(b, track.length - 0.2, 0, 40);
    const events = step(sim);
    expect(sim.tick).toBe(lastTick);
    expect(events.some((e) => e.type === 'finish' && e.racerId === 'b')).toBe(true);
    expect(events.some((e) => e.type === 'raceFinished')).toBe(true);
    expect(b.finished).toBe(true);
    expect(b.position).toBe(2);
  });
});
