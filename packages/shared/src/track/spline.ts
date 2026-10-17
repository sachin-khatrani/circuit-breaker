import type { TrackControlPoint } from './types';

/** Uniformly spaced samples of a centre line plus per-sample road attributes. */
export interface CenterlineSamples {
  count: number;
  spacing: number;
  length: number;
  x: Float64Array;
  y: Float64Array;
  z: Float64Array;
  width: Float64Array;
  /** Bank in degrees. */
  bank: Float64Array;
  /** Arc length at each control point; on a loop, one extra entry equals the length. */
  controlPointS: number[];
}

const ALPHA = 0.5; // centripetal parameterisation: no cusps or self-loops inside a segment
const DENSE_STEPS = 64; // evaluations per control-point segment before arc-length resampling

function knot(t: number, a: TrackControlPoint, b: TrackControlPoint): number {
  const d = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  return t + Math.pow(Math.max(d, 1e-6), ALPHA);
}

/**
 * Barry-Goldman evaluation of a centripetal Catmull-Rom segment between p1 and p2 for a
 * scalar channel. The knot vector comes from the 3D positions, so width and bank follow
 * the same parameterisation as the curve.
 */
function evalChannel(
  v0: number,
  v1: number,
  v2: number,
  v3: number,
  t0: number,
  t1: number,
  t2: number,
  t3: number,
  t: number,
): number {
  const a1 = ((t1 - t) / (t1 - t0)) * v0 + ((t - t0) / (t1 - t0)) * v1;
  const a2 = ((t2 - t) / (t2 - t1)) * v1 + ((t - t1) / (t2 - t1)) * v2;
  const a3 = ((t3 - t) / (t3 - t2)) * v2 + ((t - t2) / (t3 - t2)) * v3;
  const b1 = ((t2 - t) / (t2 - t0)) * a1 + ((t - t0) / (t2 - t0)) * a2;
  const b2 = ((t3 - t) / (t3 - t1)) * a2 + ((t - t1) / (t3 - t1)) * a3;
  return ((t2 - t) / (t2 - t1)) * b1 + ((t - t1) / (t2 - t1)) * b2;
}

/** Evaluates the closed spline densely, then resamples it at uniform arc length. */
export function sampleClosedSpline(
  points: readonly TrackControlPoint[],
  targetSpacing: number,
): CenterlineSamples {
  const n = points.length;
  if (n < 4) throw new Error('A closed track needs at least 4 control points');
  return sampleSpline(points, targetSpacing, true);
}

/**
 * The same for an open road (a branch): it starts at the first point and ends at the last.
 * The ends continue straight, so the road leaves its first point heading at the second.
 * Samples include both ends: `count` samples, `spacing = length / (count - 1)`.
 */
export function sampleOpenSpline(
  points: readonly TrackControlPoint[],
  targetSpacing: number,
): CenterlineSamples {
  if (points.length < 2) throw new Error('An open road needs at least 2 control points');
  return sampleSpline(points, targetSpacing, false);
}

function mirror(a: TrackControlPoint, b: TrackControlPoint): TrackControlPoint {
  return {
    x: 2 * a.x - b.x,
    y: 2 * a.y - b.y,
    z: 2 * a.z - b.z,
    width: a.width,
    bank: a.bank ?? 0,
  };
}

function sampleSpline(
  points: readonly TrackControlPoint[],
  targetSpacing: number,
  closed: boolean,
): CenterlineSamples {
  const n = points.length;
  const segments = closed ? n : n - 1;
  const at = (i: number): TrackControlPoint => {
    if (closed) return points[(i + n) % n];
    if (i < 0) return mirror(points[0], points[1]);
    if (i >= n) return mirror(points[n - 1], points[n - 2]);
    return points[i];
  };

  const denseCount = segments * DENSE_STEPS;
  const dx = new Float64Array(denseCount + 1);
  const dy = new Float64Array(denseCount + 1);
  const dz = new Float64Array(denseCount + 1);
  const dw = new Float64Array(denseCount + 1);
  const db = new Float64Array(denseCount + 1);

  for (let seg = 0; seg < segments; seg++) {
    const p0 = at(seg - 1);
    const p1 = at(seg);
    const p2 = at(seg + 1);
    const p3 = at(seg + 2);
    const t0 = 0;
    const t1 = knot(t0, p0, p1);
    const t2 = knot(t1, p1, p2);
    const t3 = knot(t2, p2, p3);
    for (let k = 0; k < DENSE_STEPS; k++) {
      const t = t1 + ((t2 - t1) * k) / DENSE_STEPS;
      const i = seg * DENSE_STEPS + k;
      dx[i] = evalChannel(p0.x, p1.x, p2.x, p3.x, t0, t1, t2, t3, t);
      dy[i] = evalChannel(p0.y, p1.y, p2.y, p3.y, t0, t1, t2, t3, t);
      dz[i] = evalChannel(p0.z, p1.z, p2.z, p3.z, t0, t1, t2, t3, t);
      dw[i] = evalChannel(p0.width, p1.width, p2.width, p3.width, t0, t1, t2, t3, t);
      db[i] = evalChannel(
        p0.bank ?? 0,
        p1.bank ?? 0,
        p2.bank ?? 0,
        p3.bank ?? 0,
        t0,
        t1,
        t2,
        t3,
        t,
      );
    }
  }
  // Close the dense polyline: back onto point 0, or onto the last point of an open road.
  const last = closed ? points[0] : points[n - 1];
  dx[denseCount] = last.x;
  dy[denseCount] = last.y;
  dz[denseCount] = last.z;
  dw[denseCount] = last.width;
  db[denseCount] = last.bank ?? 0;

  const cumulative = new Float64Array(denseCount + 1);
  for (let i = 1; i <= denseCount; i++) {
    cumulative[i] =
      cumulative[i - 1] + Math.hypot(dx[i] - dx[i - 1], dy[i] - dy[i - 1], dz[i] - dz[i - 1]);
  }
  const length = cumulative[denseCount];
  const controlPointS: number[] = [];
  for (let k = 0; k <= segments; k++) controlPointS.push(cumulative[k * DENSE_STEPS]);

  // A closed loop's last sample is not repeated (sample `count` is sample 0); an open road
  // keeps both ends.
  const intervals = Math.max(closed ? 8 : 1, Math.round(length / targetSpacing));
  const count = closed ? intervals : intervals + 1;
  const spacing = length / intervals;
  const x = new Float64Array(count);
  const y = new Float64Array(count);
  const z = new Float64Array(count);
  const width = new Float64Array(count);
  const bank = new Float64Array(count);

  let j = 0;
  for (let i = 0; i < count; i++) {
    const s = Math.min(length, i * spacing);
    while (j < denseCount - 1 && cumulative[j + 1] < s) j++;
    const segLen = cumulative[j + 1] - cumulative[j];
    const u = segLen > 0 ? Math.min(1, (s - cumulative[j]) / segLen) : 0;
    x[i] = dx[j] + (dx[j + 1] - dx[j]) * u;
    y[i] = dy[j] + (dy[j + 1] - dy[j]) * u;
    z[i] = dz[j] + (dz[j + 1] - dz[j]) * u;
    width[i] = dw[j] + (dw[j + 1] - dw[j]) * u;
    bank[i] = db[j] + (db[j + 1] - db[j]) * u;
  }

  return { count, spacing, length, x, y, z, width, bank, controlPointS };
}
