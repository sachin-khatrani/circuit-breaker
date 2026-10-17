import { describe, expect, it } from 'vitest';
import { TICK_RATE, VEHICLE_TUNING } from '../src/sim/config';
import { createInput, type PlayerInput } from '../src/sim/input';
import { createVehicle, placeVehicle, stepVehicle, type VehicleState } from '../src/sim/vehicle';
import { makeTestOval } from './helpers';

const oval = makeTestOval();

function onStraight(): VehicleState {
  const v = createVehicle();
  placeVehicle(v, oval, 20, 0);
  return v;
}

function drive(v: VehicleState, input: Partial<PlayerInput>, seconds: number): void {
  const full = { ...createInput(), ...input };
  for (let i = 0; i < Math.round(seconds * TICK_RATE); i++) stepVehicle(v, full, oval);
}

describe('vehicle longitudinal model', () => {
  it('reaches 100 km/h in about a second and nears top speed on a long straight', () => {
    const v = onStraight();
    let ticks = 0;
    while (v.speed < 100 / 3.6) {
      stepVehicle(v, { ...createInput(), throttle: 1 }, oval);
      ticks++;
    }
    expect(ticks / TICK_RATE).toBeLessThan(1.3);
    drive(v, { throttle: 1 }, 7);
    expect(v.speed).toBeGreaterThan(VEHICLE_TUNING.maxSpeed * 0.97);
    expect(v.speed).toBeLessThanOrEqual(VEHICLE_TUNING.maxSpeed + 0.01);
  });

  it('eases off gently when the throttle is released', () => {
    const v = onStraight();
    drive(v, { throttle: 1 }, 7);
    const top = v.speed;
    drive(v, {}, 1);
    // Lifting off is not a brake: well under 1.5 g of engine braking at top speed.
    expect(top - v.speed).toBeLessThan(14);
    expect(top - v.speed).toBeGreaterThan(4);
  });

  it('brakes from top speed to a stop in under 75 m, then reverses', () => {
    const v = onStraight();
    drive(v, { throttle: 1 }, 7);
    const startS = v.trackS;
    let ticks = 0;
    while (v.forwardSpeed > 0.01 && ticks < 600) {
      stepVehicle(v, { ...createInput(), brake: 1 }, oval);
      ticks++;
    }
    expect(oval.distanceAhead(startS, v.trackS)).toBeLessThan(75);
    drive(v, { brake: 1 }, 2);
    expect(v.forwardSpeed).toBeLessThan(-5);
  });

  it('holds the car still for a moment before the brake turns into reverse', () => {
    const v = onStraight();
    drive(v, { throttle: 1 }, 2);
    while (v.forwardSpeed > 0) stepVehicle(v, { ...createInput(), brake: 1 }, oval);
    expect(v.forwardSpeed).toBeCloseTo(0, 9);
    drive(v, { brake: 1 }, 0.1);
    expect(v.forwardSpeed).toBeCloseTo(0, 9);
    drive(v, { brake: 1 }, 0.6);
    expect(v.forwardSpeed).toBeLessThan(-1);
  });
});

describe('vehicle lateral model', () => {
  it('scrapes along the wall without leaving the road or stopping dead', () => {
    const v = onStraight();
    drive(v, { throttle: 1 }, 4);
    for (let i = 0; i < 3 * TICK_RATE; i++) {
      stepVehicle(v, { ...createInput(), throttle: 1, steer: 1 }, oval);
      const limit = oval.frameAt(v.trackS).halfWidth - VEHICLE_TUNING.halfWidth;
      expect(Math.abs(v.lateral)).toBeLessThanOrEqual(limit + 1e-6);
    }
    expect(v.speed).toBeGreaterThan(15);
  });

  it('pays a mini-turbo for a held drift and eases out of the slide without snapping', () => {
    // A 150 m wide skid pad, so the drift never reaches a wall (a wall hit cancels it).
    const pad = makeTestOval(150);
    const v = createVehicle();
    placeVehicle(v, pad, 20, 0);
    const run = (input: Partial<PlayerInput>, seconds: number) => {
      const full = { ...createInput(), ...input };
      for (let i = 0; i < Math.round(seconds * TICK_RATE); i++) stepVehicle(v, full, pad);
    };
    run({ throttle: 1 }, 3);
    run({ throttle: 1, drift: true, steer: 0.5 }, 1.2);
    expect(v.drifting).toBe(true);
    const slip = () => Math.abs(Math.atan2(v.lateralSpeed, v.forwardSpeed));
    const released = slip();
    expect(released).toBeGreaterThan(0.35);
    const res = stepVehicle(v, { ...createInput(), throttle: 1 }, pad);
    expect(res.driftEnded).toBe(true);
    expect(res.miniTurbo).toBe(1);
    expect(v.impulseTicks).toBeGreaterThan(0);
    // The slide straightens over a few tenths of a second: not instantly, not lingering.
    run({ throttle: 1 }, 0.1);
    expect(slip()).toBeGreaterThan(released * 0.6);
    run({ throttle: 1 }, 0.5);
    expect(slip()).toBeLessThan(0.1);
  });
});
