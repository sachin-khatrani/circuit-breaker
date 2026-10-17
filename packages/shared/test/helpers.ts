import { Track } from '../src/track/track';
import type { TrackControlPoint, TrackDefinition } from '../src/track/types';

/**
 * A 5 km straight closed by wide turns, for top-speed, boost, pad and lane tests. Point k sits
 * k × 250 m down the straight, so `at: 2` is 500 m from the start. The road is dead straight
 * from 300 m to 4.6 km (before that it still bends out of the closing turn).
 */
export function makeDragStrip(extra: Partial<TrackDefinition> = {}, width = 24): Track {
  const points: TrackControlPoint[] = [];
  const straight = 5000;
  const radius = 400;
  for (let x = 0; x < straight; x += 250) points.push({ x, y: 0, z: 0, width });
  for (let a = 0; a < 180; a += 30) {
    const r = (a * Math.PI) / 180;
    points.push({
      x: straight + Math.sin(r) * radius,
      y: 0,
      z: radius - Math.cos(r) * radius,
      width,
    });
  }
  for (let x = straight; x > 0; x -= 250) points.push({ x, y: 0, z: 2 * radius, width });
  for (let a = 0; a < 180; a += 30) {
    const r = (a * Math.PI) / 180;
    points.push({ x: -Math.sin(r) * radius, y: 0, z: radius + Math.cos(r) * radius, width });
  }
  return new Track({
    id: 'drag-strip',
    name: 'Drag Strip',
    points,
    checkpoints: [0, 20, 26],
    energyCells: [],
    defaultLaps: 1,
    ...extra,
  });
}

/** A circular road of the given centre-line radius, driven as one endless right-hand turn. */
export function makeRing(radius: number, width: number): Track {
  const points: TrackControlPoint[] = [];
  const n = Math.max(12, Math.round((2 * Math.PI * radius) / 15));
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    points.push({ x: Math.cos(a) * radius, y: 0, z: Math.sin(a) * radius, width });
  }
  return new Track({
    id: `ring-${radius}`,
    name: 'Ring',
    points,
    checkpoints: [0, Math.floor(n / 2)],
    energyCells: [],
    defaultLaps: 1,
  });
}

/**
 * A stadium oval with 1.2 km straights, used to test the vehicle away from Grid Zero's
 * corners: point 0 sits at the start of the bottom straight, heading +x.
 */
export function makeTestOval(width = 24): Track {
  const points: TrackControlPoint[] = [];
  const straight = 1200;
  const radius = 160;
  for (let x = 0; x < straight; x += 200) points.push({ x, y: 0, z: 0, width });
  for (let a = 0; a < 180; a += 30) {
    const r = (a * Math.PI) / 180;
    points.push({
      x: straight + Math.sin(r) * radius,
      y: 0,
      z: radius - Math.cos(r) * radius,
      width,
    });
  }
  for (let x = straight; x > 0; x -= 200) points.push({ x, y: 0, z: 2 * radius, width });
  for (let a = 0; a < 180; a += 30) {
    const r = (a * Math.PI) / 180;
    points.push({ x: -Math.sin(r) * radius, y: 0, z: radius + Math.cos(r) * radius, width });
  }
  const def: TrackDefinition = {
    id: 'test-oval',
    name: 'Test Oval',
    points,
    checkpoints: [0, 7, 13, 19],
    energyCells: [{ at: 2, lateral: 0 }],
    defaultLaps: 2,
  };
  return new Track(def);
}
