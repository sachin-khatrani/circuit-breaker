import type { Track } from '@circuit-breaker/shared';
import { createRandom, range } from '../random';

export interface TowerSpec {
  x: number;
  z: number;
  width: number;
  depth: number;
  height: number;
  seed: number;
  tint: number;
}

export interface BillboardSpec {
  x: number;
  y: number;
  z: number;
  yaw: number;
  panel: number;
  baseY: number;
}

export interface CityPlan {
  reactor: { x: number; z: number };
  towers: TowerSpec[];
  billboards: BillboardSpec[];
}

const CELL = 10;
const TRACK_CLEARANCE = 22;
const REACH = 1900;

/** Even-odd test against the centre line as a polygon. */
function insideLoop(track: Track, x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = track.count - 1; i < track.count; j = i++) {
    const xi = track.px[i];
    const zi = track.pz[i];
    const xj = track.px[j];
    const zj = track.pz[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function distanceToTrack(track: Track, x: number, z: number, stride = 4): number {
  let best = Infinity;
  for (let i = 0; i < track.count; i += stride) {
    const dx = track.px[i] - x;
    const dz = track.pz[i] - z;
    const d = dx * dx + dz * dz - track.halfWidth[i] * track.halfWidth[i];
    if (d < best) best = d;
  }
  return Math.sqrt(Math.max(0, best));
}

/**
 * Lays out the district around a track: the reactor at the infield point furthest from the
 * road, towers on a jittered grid that keeps clear of the road, and trackside billboards.
 * Seeded, so every client sees the same city.
 */
export function planCity(track: Track, maxTowers: number, seed = 7): CityPlan {
  const rand = createRandom(seed);
  const b = track.bounds;
  const cx = (b.minX + b.maxX) / 2;
  const cz = (b.minZ + b.maxZ) / 2;

  // Reactor: the infield point with the most clearance from the road.
  let reactor = { x: cx, z: cz };
  let bestClear = -Infinity;
  for (let x = b.minX; x <= b.maxX; x += 15) {
    for (let z = b.minZ; z <= b.maxZ; z += 15) {
      if (!insideLoop(track, x, z)) continue;
      const d = distanceToTrack(track, x, z);
      if (d > bestClear) {
        bestClear = d;
        reactor = { x, z };
      }
    }
  }

  // Occupancy grid: cells near the road (or the reactor plaza) are off limits.
  const ox = cx - REACH;
  const oz = cz - REACH;
  const size = Math.ceil((REACH * 2) / CELL);
  const blocked = new Uint8Array(size * size);
  const mark = (x: number, z: number, radius: number) => {
    const r = Math.ceil(radius / CELL);
    const gx = Math.floor((x - ox) / CELL);
    const gz = Math.floor((z - oz) / CELL);
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dz * dz > r * r) continue;
        const ix = gx + dx;
        const iz = gz + dz;
        if (ix >= 0 && iz >= 0 && ix < size && iz < size) blocked[iz * size + ix] = 1;
      }
    }
  };
  for (let i = 0; i < track.count; i += 2) {
    mark(track.px[i], track.pz[i], track.halfWidth[i] + TRACK_CLEARANCE);
  }
  mark(reactor.x, reactor.z, Math.min(90, bestClear - 10));
  const isBlocked = (x: number, z: number) => {
    const ix = Math.floor((x - ox) / CELL);
    const iz = Math.floor((z - oz) / CELL);
    if (ix < 0 || iz < 0 || ix >= size || iz >= size) return true;
    return blocked[iz * size + ix] === 1;
  };

  type Candidate = TowerSpec & { distance: number };
  const candidates: Candidate[] = [];
  const spacing = 38;
  for (let gx = -REACH; gx <= REACH; gx += spacing) {
    for (let gz = -REACH; gz <= REACH; gz += spacing) {
      const x = cx + gx + range(rand, -8, 8);
      const z = cz + gz + range(rand, -8, 8);
      if (Math.hypot(gx, gz) > REACH) continue;
      const width = range(rand, 14, 30);
      const depth = range(rand, 14, 30);
      const hx = width / 2;
      const hz = depth / 2;
      if (
        isBlocked(x, z) ||
        isBlocked(x - hx, z - hz) ||
        isBlocked(x + hx, z - hz) ||
        isBlocked(x - hx, z + hz) ||
        isBlocked(x + hx, z + hz)
      ) {
        continue;
      }
      const distance = distanceToTrack(track, x, z, 6);
      let height: number;
      if (distance < 90) height = range(rand, 16, 62);
      else if (distance < 400) height = range(rand, 28, 150);
      else height = range(rand, 60, 300);
      if (rand() < 0.08) height *= 1.7;
      candidates.push({
        x,
        z,
        width,
        depth,
        height,
        seed: rand(),
        tint: Math.floor(rand() * 4),
        distance,
      });
    }
  }

  // Keep everything close to the road (it frames the racing), then sample the skyline ring.
  candidates.sort((a, b) => a.distance - b.distance);
  const near = candidates.filter((c) => c.distance < 450);
  const far = candidates.filter((c) => c.distance >= 450);
  const towers: TowerSpec[] = near.slice(0, Math.floor(maxTowers * 0.65));
  const remaining = maxTowers - towers.length;
  for (let i = 0; i < far.length && towers.length < maxTowers; i++) {
    if (rand() < remaining / far.length) towers.push(far[i]);
  }

  // Billboards: alternating sides, angled toward oncoming cars, clear of every road section.
  const billboards: BillboardSpec[] = [];
  const count = 12;
  for (let k = 0; k < count; k++) {
    const s = ((k + 0.35) / count) * track.length;
    const f = track.frameAt(s);
    const side = k % 2 === 0 ? 1 : -1;
    const lateral = side * (f.halfWidth + 15);
    const x = f.x + f.rx * lateral;
    const z = f.z + f.rz * lateral;
    if (distanceToTrack(track, x, z, 2) < 9) continue;
    billboards.push({
      x,
      y: f.y + 10 + rand() * 6,
      z,
      yaw: f.heading + Math.PI - side * 0.45,
      panel: 1 + (k % 7),
      baseY: -0.3,
    });
  }

  return { reactor, towers, billboards };
}
