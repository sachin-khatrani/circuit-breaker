import { describe, expect, it } from 'vitest';
import { RACE_RULES, TICK_RATE } from '../src/sim/config';
import type { RaceEvent } from '../src/sim/events';
import { createInput } from '../src/sim/input';
import { RaceSimulation } from '../src/sim/race';
import { placeVehicle } from '../src/sim/vehicle';
import { GROUND_LEVEL, Track } from '../src/track/track';
import { GRID_ZERO } from '../src/track/tracks/gridZero';
import type { TrackDefinition } from '../src/track/types';
import { makeTestOval } from './helpers';

/** The test oval raised 12 m into the air with an open (barrier-free) first straight. */
function raisedOval(side: 'left' | 'right' | 'both'): Track {
  const base = makeTestOval().def;
  const def: TrackDefinition = {
    ...base,
    id: `raised-${side}`,
    points: base.points.map((p) => ({ ...p, y: 12 })),
    openEdges: [{ from: 0.5, to: 5.5, side }],
  };
  return new Track(def);
}

function drive(sim: RaceSimulation, steer: number, ticks: number, events: RaceEvent[] = []) {
  for (let i = 0; i < ticks; i++) {
    sim.setInput('p', { ...createInput(), throttle: 1, steer });
    sim.step();
    events.push(...sim.drainEvents());
  }
  return events;
}

describe('leaving the track', () => {
  it('flies off an open raised edge, falls, and respawns at the last safe point', () => {
    const track = raisedOval('both');
    const sim = new RaceSimulation(track, { skipCountdown: true });
    const racer = sim.addRacer('p', 'P');
    placeVehicle(racer.vehicle, track, 300, 0);
    drive(sim, 0, 90);
    expect(racer.vehicle.surface).toBe('road');
    const safeBefore = racer.vehicle.safeS;

    // Steer hard right off the open edge.
    let airborne = false;
    const events: RaceEvent[] = [];
    for (let i = 0; i < 4 * TICK_RATE && racer.stats.falls === 0; i++) {
      drive(sim, 1, 1, events);
      if (racer.vehicle.surface === 'air') {
        airborne = true;
        expect(racer.vehicle.y).toBeLessThanOrEqual(12.5);
      }
    }
    expect(airborne).toBe(true);
    expect(racer.stats.falls).toBe(1);
    const respawn = events.find((e) => e.type === 'respawn');
    expect(respawn).toMatchObject({ type: 'respawn', reason: 'offTrack' });

    const v = racer.vehicle;
    expect(v.surface).toBe('road');
    expect(v.frozenTicks).toBeGreaterThan(0);
    expect(Math.abs(v.lateral)).toBeLessThan(0.01);
    expect(v.y).toBeCloseTo(12, 1);
    // Back where it last drove safely, not where it fell.
    expect(track.distanceAhead(safeBefore, v.trackS)).toBeLessThan(120);
  });

  it('still blocks the walled side of a half-open stretch', () => {
    const track = raisedOval('left');
    const sim = new RaceSimulation(track, { skipCountdown: true });
    const racer = sim.addRacer('p', 'P');
    placeVehicle(racer.vehicle, track, 300, 0);
    drive(sim, 0, 90);
    drive(sim, 1, 2 * TICK_RATE);
    expect(racer.stats.falls).toBe(0);
    expect(racer.vehicle.surface).toBe('road');
    expect(racer.stats.wallHits).toBeGreaterThan(0);
  });

  it('respawns a car stranded on the ground after the grace period', () => {
    const track = raisedOval('both');
    const sim = new RaceSimulation(track, { skipCountdown: true });
    const racer = sim.addRacer('p', 'P');
    placeVehicle(racer.vehicle, track, 300, 0);
    const v = racer.vehicle;
    // Drop the car beside the road, as if it had already fallen.
    v.x += 40 * -v.trackFz;
    v.z += 40 * v.trackFx;
    v.surface = 'ground';
    v.y = GROUND_LEVEL;
    drive(sim, 0, RACE_RULES.groundRespawnTicks + 2);
    expect(racer.stats.falls).toBe(1);
    expect(v.surface).toBe('road');
  });
});

describe('Grid Zero open edges and tunnel', () => {
  const track = new Track(GRID_ZERO);

  it('only opens barriers where the road is raised well above the ground', () => {
    let open = 0;
    for (let i = 0; i < track.count; i++) {
      if (track.wallLeft[i] === 0 || track.wallRight[i] === 0) {
        open++;
        expect(track.py[i] - GROUND_LEVEL).toBeGreaterThan(3);
      }
    }
    expect(open * track.spacing).toBeGreaterThan(150);
  });

  it('has a roofed tunnel at ground level', () => {
    let roofed = 0;
    for (let i = 0; i < track.count; i++) {
      if (track.roof[i] > 0) {
        roofed++;
        expect(track.py[i]).toBeLessThan(1);
        expect(track.wallLeft[i] + track.wallRight[i]).toBe(2);
      }
    }
    expect(roofed * track.spacing).toBeGreaterThan(180);
  });
});
