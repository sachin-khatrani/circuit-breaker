import { describe, expect, it } from 'vitest';
import { autopilotInput } from '../src/sim/autopilot';
import { RACE_RULES, TICK_RATE, VEHICLE_TUNING } from '../src/sim/config';
import type { RaceEvent } from '../src/sim/events';
import { createInput, type PlayerInput } from '../src/sim/input';
import { RaceSimulation } from '../src/sim/race';
import { createVehicle, placeVehicle, stepVehicle, type VehicleState } from '../src/sim/vehicle';
import { makeDragStrip, makeRing, makeTestOval } from './helpers';

const input = (p: Partial<PlayerInput> = {}): PlayerInput => ({ ...createInput(), ...p });

const strip = makeDragStrip();

/** A car at top speed on the long straight, with Energy for several bursts. */
function cruising(energy = 100): VehicleState {
  const v = createVehicle();
  placeVehicle(v, strip, 300, 0);
  for (let i = 0; i < 8 * TICK_RATE; i++) stepVehicle(v, input({ throttle: 1 }), strip);
  v.energy = energy;
  return v;
}

function drive(sim: RaceSimulation, p: Partial<PlayerInput>, ticks: number): RaceEvent[] {
  const events: RaceEvent[] = [];
  for (let i = 0; i < ticks; i++) {
    sim.setInput('p', input(p));
    sim.step();
    events.push(...sim.drainEvents());
  }
  return events;
}

describe('boost bursts', () => {
  it('fires one burst of fixed length per press, paid up front', () => {
    const v = cruising();
    const res = stepVehicle(v, input({ throttle: 1, boost: true }), strip);
    expect(res.boostStarted).toBe(true);
    expect(v.energy).toBe(100 - RACE_RULES.boostCost);
    let boostingTicks = v.boosting ? 1 : 0;
    for (let i = 0; i < 3 * TICK_RATE; i++) {
      stepVehicle(v, input({ throttle: 1 }), strip);
      if (v.boosting) boostingTicks++;
    }
    expect(boostingTicks).toBe(RACE_RULES.boostDurationTicks);
    expect(v.energy).toBe(100 - RACE_RULES.boostCost);
  });

  it('ignores a held button and never stacks bursts when the button is mashed', () => {
    const held = cruising();
    let bursts = 0;
    for (let i = 0; i < 3 * TICK_RATE; i++) {
      if (stepVehicle(held, input({ throttle: 1, boost: true }), strip).boostStarted) bursts++;
    }
    expect(bursts).toBe(1);
    expect(held.energy).toBe(100 - RACE_RULES.boostCost);

    const mashed = cruising();
    const starts: number[] = [];
    for (let i = 0; i < 3 * TICK_RATE; i++) {
      const res = stepVehicle(mashed, input({ throttle: 1, boost: i % 2 === 0 }), strip);
      if (res.boostStarted) starts.push(i);
    }
    const period = RACE_RULES.boostDurationTicks + RACE_RULES.boostCooldownTicks;
    expect(starts).toEqual([0, period]);
    expect(mashed.energy).toBe(100 - 2 * RACE_RULES.boostCost);
  });

  it('needs the full cost in Energy and reports a denied press', () => {
    const v = cruising(RACE_RULES.boostCost - 1);
    const res = stepVehicle(v, input({ throttle: 1, boost: true }), strip);
    expect(res.boostStarted).toBe(false);
    expect(res.boostDenied).toBe(true);
    expect(v.boosting).toBe(false);
    expect(v.energy).toBe(RACE_RULES.boostCost - 1);
  });

  it('remembers a press made just before the cooldown ends', () => {
    const v = cruising();
    stepVehicle(v, input({ throttle: 1, boost: true }), strip);
    const early = 5;
    const wait = RACE_RULES.boostDurationTicks - 1 + RACE_RULES.boostCooldownTicks - early;
    for (let i = 0; i < wait; i++) stepVehicle(v, input({ throttle: 1 }), strip);
    stepVehicle(v, input({ throttle: 1, boost: true }), strip);
    expect(v.boosting).toBe(false);
    let startedAfter = -1;
    for (let i = 0; i < 2 * early && startedAfter < 0; i++) {
      if (stepVehicle(v, input({ throttle: 1 }), strip).boostStarted) startedAfter = i + 1;
    }
    expect(startedAfter).toBe(early);
  });

  it('pushes past top speed as a smooth shove, then the overspeed bleeds off', () => {
    const v = cruising();
    const top = v.speed;
    let largestStep = 0;
    stepVehicle(v, input({ throttle: 1, boost: true }), strip);
    let last = v.speed;
    for (let i = 0; i < RACE_RULES.boostDurationTicks; i++) {
      stepVehicle(v, input({ throttle: 1 }), strip);
      largestStep = Math.max(largestStep, v.speed - last);
      last = v.speed;
    }
    expect(v.speed).toBeGreaterThan(top + 8);
    expect(v.speed).toBeLessThanOrEqual(VEHICLE_TUNING.boostMaxSpeed);
    // Never a jump: well under half a metre per second per tick.
    expect(largestStep).toBeLessThan(0.5);
    const boosted = v.speed;
    for (let i = 0; i < 30; i++) stepVehicle(v, input({ throttle: 1 }), strip);
    expect(v.speed).toBeLessThan(boosted);
    expect(v.speed).toBeGreaterThan(top + 2);
  });
});

describe('boost pads', () => {
  const track = makeDragStrip({ boostPads: [{ at: 2, lateral: 4, length: 12, width: 5 }] });
  const pad = track.pads[0];
  const approach = (lateral: number) => {
    const sim = new RaceSimulation(track, { skipCountdown: true });
    const racer = sim.addRacer('p', 'P');
    placeVehicle(racer.vehicle, track, pad.s - 120, lateral);
    return { sim, racer };
  };
  const padEvents = (events: RaceEvent[]) => events.filter((e) => e.type === 'boostPad');

  it('fires once for a car crossing it, pushing it past top speed within the pad cap', () => {
    const { sim, racer } = approach(pad.lateral);
    const events: RaceEvent[] = [];
    let peak = 0;
    for (let i = 0; i < 6 * TICK_RATE; i++) {
      events.push(...drive(sim, { throttle: 1 }, 1));
      peak = Math.max(peak, racer.vehicle.speed);
    }
    expect(padEvents(events)).toHaveLength(1);
    expect(racer.stats.padsHit).toBe(1);
    expect(peak).toBeLessThanOrEqual(VEHICLE_TUNING.maxSpeed + VEHICLE_TUNING.padSpeedBonus);
  });

  it('stays inert for the same car until its cooldown has passed', () => {
    const { sim, racer } = approach(pad.lateral);
    const first = padEvents(drive(sim, { throttle: 1 }, 4 * TICK_RATE));
    expect(first).toHaveLength(1);
    // Straight back to just before the pad and over it again, inside the cooldown.
    placeVehicle(racer.vehicle, track, pad.s - 25, pad.lateral);
    racer.vehicle.vx = racer.vehicle.trackFx * 40;
    racer.vehicle.vz = racer.vehicle.trackFz * 40;
    expect(padEvents(drive(sim, { throttle: 1 }, TICK_RATE))).toHaveLength(0);
    // After the cooldown it works again.
    drive(sim, {}, RACE_RULES.padCooldownTicks);
    placeVehicle(racer.vehicle, track, pad.s - 25, pad.lateral);
    racer.vehicle.vx = racer.vehicle.trackFx * 40;
    racer.vehicle.vz = racer.vehicle.trackFz * 40;
    expect(padEvents(drive(sim, { throttle: 1 }, TICK_RATE))).toHaveLength(1);
  });

  it('does nothing for a car that misses it or reverses over it', () => {
    const wide = approach(pad.lateral - 7);
    expect(padEvents(drive(wide.sim, { throttle: 1 }, 4 * TICK_RATE))).toHaveLength(0);
    const back = approach(pad.lateral);
    placeVehicle(back.racer.vehicle, track, pad.s + pad.length + 8, pad.lateral);
    expect(padEvents(drive(back.sim, { brake: 1 }, 4 * TICK_RATE))).toHaveLength(0);
    expect(back.racer.vehicle.forwardSpeed).toBeLessThan(-5);
  });
});

describe('speed lanes', () => {
  it('lift top speed and pull harder while the car is inside one', () => {
    const track = makeDragStrip({ speedLanes: [{ from: 1, to: 15, lateral: -4, width: 4.5 }] });
    const run = (lateral: number) => {
      const v = createVehicle();
      placeVehicle(v, track, 300, lateral);
      let at100 = -1;
      for (let i = 0; i < 9 * TICK_RATE; i++) {
        stepVehicle(v, input({ throttle: 1 }), track);
        if (at100 < 0 && v.speed > 100 / 3.6) at100 = i;
      }
      return { top: v.speed, at100, inLane: v.inLane };
    };
    const lane = run(-4);
    const open = run(4);
    expect(lane.inLane).toBe(true);
    expect(open.inLane).toBe(false);
    expect(open.top).toBeLessThanOrEqual(VEHICLE_TUNING.maxSpeed);
    expect(lane.top).toBeGreaterThan(VEHICLE_TUNING.maxSpeed + VEHICLE_TUNING.laneSpeedBonus * 0.6);
    expect(lane.at100).toBeLessThan(open.at100);
  });
});

describe('drift balance', () => {
  const pad = makeTestOval(150);
  const rolling = (speed: number) => {
    const v = createVehicle();
    placeVehicle(v, pad, 30, 0);
    v.vx = Math.sin(v.yaw) * speed;
    v.vz = Math.cos(v.yaw) * speed;
    return v;
  };

  it('turns tighter than grip at the same speed: the reward in a hairpin', () => {
    const radius = (drift: boolean) => {
      const v = rolling(50);
      for (let i = 0; i < 48; i++) {
        stepVehicle(v, input({ throttle: 0.5, steer: 1, drift }), pad);
      }
      expect(v.drifting).toBe(drift);
      return v.speed / Math.abs(v.yawRate);
    };
    expect(radius(true)).toBeLessThan(radius(false) * 0.85);
  });

  it('settles well below top speed in a held slide', () => {
    const v = rolling(50);
    for (let i = 0; i < 3 * TICK_RATE; i++) {
      stepVehicle(v, input({ throttle: 1, steer: 0.6, drift: true }), pad);
    }
    expect(v.drifting).toBe(true);
    expect(v.speed).toBeLessThan(VEHICLE_TUNING.maxSpeed * 0.82);
  });

  it('loses to driving straight when weaving down a straight for mini-turbos', () => {
    const wide = makeDragStrip({}, 60);
    const race = (weave: boolean) => {
      const v = createVehicle();
      placeVehicle(v, wide, 300, 0);
      v.vx = Math.sin(v.yaw) * 30;
      v.vz = Math.cos(v.yaw) * 30;
      const start = v.trackS;
      const cycle = 100;
      const steer = createInput();
      for (let i = 0; i < 14 * TICK_RATE; i++) {
        const phase = i % cycle;
        const dir = Math.floor(i / cycle) % 2 === 0 ? 1 : -1;
        if (weave && phase < 60) {
          // Long enough for a mini-turbo (0.9 s), then straighten up before the next one.
          stepVehicle(v, input({ throttle: 1, drift: true, steer: 0.7 * dir }), wide);
        } else {
          autopilotInput(wide, v, {}, steer);
          stepVehicle(v, input({ throttle: 1, steer: steer.steer }), wide);
        }
      }
      return wide.distanceAhead(start, v.trackS);
    };
    expect(race(false)).toBeGreaterThan(race(true));
  });
});

describe('drift Energy', () => {
  // A wide ring near the radius of a steady drift, so the slide keeps following the road
  // without touching a wall.
  const ring = makeRing(34, 60);
  const sliding = () => {
    const v = createVehicle();
    placeVehicle(v, ring, 0, 0);
    v.vx = Math.sin(v.yaw) * 48;
    v.vz = Math.cos(v.yaw) * 48;
    v.energy = 0;
    return v;
  };
  const hold = input({ throttle: 1, drift: true, steer: 0.6 });

  it('charges only a sustained slide, up to a cap per drift', () => {
    const v = sliding();
    let firstGain = -1;
    for (let i = 0; i < 4 * TICK_RATE; i++) {
      const res = stepVehicle(v, hold, ring);
      if (res.driftEnergy > 0 && firstGain < 0) firstGain = i;
    }
    expect(v.drifting).toBe(true);
    expect(firstGain).toBeGreaterThanOrEqual(RACE_RULES.driftEnergyDelayTicks);
    expect(v.energy).toBeCloseTo(RACE_RULES.driftEnergyMaxPerDrift, 6);
    const res = stepVehicle(v, input({ throttle: 1, steer: 0.6 }), ring);
    expect(res.driftEnded).toBe(true);
    expect(res.driftReward).toBeCloseTo(RACE_RULES.driftEnergyMaxPerDrift, 6);
  });

  it('earns nothing from a new drift during the cooldown', () => {
    const v = sliding();
    for (let i = 0; i < 3 * TICK_RATE; i++) stepVehicle(v, hold, ring);
    stepVehicle(v, input({ throttle: 1, steer: 0.6 }), ring);
    const after = v.energy;
    let gained = 0;
    for (let i = 0; i < RACE_RULES.driftEnergyCooldownTicks - 2; i++) {
      gained += stepVehicle(v, hold, ring).driftEnergy;
    }
    expect(v.drifting).toBe(true);
    expect(gained).toBe(0);
    expect(v.energy).toBe(after);
  });

  it('charges nothing for sliding against the race direction', () => {
    const v = sliding();
    v.yaw += Math.PI;
    v.vx = -v.vx;
    v.vz = -v.vz;
    for (let i = 0; i < 3 * TICK_RATE; i++) {
      stepVehicle(v, input({ throttle: 1, drift: true, steer: -0.6 }), ring);
    }
    expect(v.energy).toBe(0);
  });
});

describe('stuck cars', () => {
  it('respawns a car that presses throttle without moving', () => {
    const sim = new RaceSimulation(makeTestOval(), { skipCountdown: true });
    const racer = sim.addRacer('p', 'P');
    // Throttle and brake together hold it in place, like a car wedged against something.
    const events = drive(sim, { throttle: 1, brake: 1 }, RACE_RULES.stuckRespawnTicks + 30);
    expect(events.filter((e) => e.type === 'respawn')).toMatchObject([
      { type: 'respawn', reason: 'stuck' },
    ]);
    expect(racer.stats.falls).toBe(0);
  });

  it('leaves a car that is simply waiting alone', () => {
    const sim = new RaceSimulation(makeTestOval(), { skipCountdown: true });
    sim.addRacer('p', 'P');
    const events = drive(sim, {}, RACE_RULES.stuckRespawnTicks * 2);
    expect(events.some((e) => e.type === 'respawn')).toBe(false);
  });
});
