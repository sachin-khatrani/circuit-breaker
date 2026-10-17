import { GROUND_LEVEL, type Road, type Track } from '@circuit-breaker/shared';
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  type Material,
} from 'three';
import { SECTOR_COLORS } from '../../game/palette';

/** Height of the energy barriers above the road edge. */
export const BARRIER_HEIGHT = 2.4;
/** Lateral distance of the barrier outside the road edge. */
export const BARRIER_OFFSET = 0.35;
const DECK_DEPTH = 1.2;
const ELEVATED = 3;

export interface SampleFrame {
  i: number;
  s: number;
  x: number;
  y: number;
  z: number;
  fx: number;
  fz: number;
  rx: number;
  rz: number;
  hw: number;
  tanBank: number;
  wallLeft: boolean;
  wallRight: boolean;
  /** The edge is an opening into another road (no barrier, shoulder or kerb). */
  portalLeft: boolean;
  portalRight: boolean;
  /** Tunnel roof height above the centre line; 0 in the open. */
  roof: number;
}

/**
 * Frame of sample i of a road. On the loop, i === count closes it with s === length; a branch
 * just ends at its last sample.
 */
export function sampleFrame(track: Road, i: number, out: SampleFrame): SampleFrame {
  const k = track.closed ? i % track.count : Math.min(i, track.count - 1);
  out.i = i;
  out.s = i * track.spacing;
  out.x = track.px[k];
  out.y = track.py[k];
  out.z = track.pz[k];
  out.fx = track.fx[k];
  out.fz = track.fz[k];
  out.rx = -track.fz[k];
  out.rz = track.fx[k];
  out.hw = track.halfWidth[k];
  out.tanBank = Math.tan(track.bank[k]);
  out.wallLeft = track.wallLeft[k] === 1;
  out.wallRight = track.wallRight[k] === 1;
  out.portalLeft = track.portalLeft[k] >= 0;
  out.portalRight = track.portalRight[k] >= 0;
  out.roof = track.roof[k];
  return out;
}

/** Road surface height at a lateral offset (the same plane the physics uses). */
export const surfaceY = (f: SampleFrame, lateral: number): number => f.y - lateral * f.tanBank;

const sectorCache = new Map<string, Color>();
function sectorBase(index: number): Color {
  const hex = SECTOR_COLORS[index % SECTOR_COLORS.length];
  let c = sectorCache.get(hex);
  if (!c) {
    c = new Color(hex);
    sectorCache.set(hex, c);
  }
  return c;
}

/** Sector colour at arc length s, cross-fading over the last 30 m before each checkpoint. */
export function sectorColorAt(track: Track, s: number, out: Color): Color {
  const gates = track.checkpoints;
  const ws = track.wrapS(s);
  let sector = gates.length - 1;
  for (let g = 0; g < gates.length; g++) if (ws >= gates[g].s) sector = g;
  const nextS = sector + 1 < gates.length ? gates[sector + 1].s : track.length;
  const toNext = nextS - ws;
  out.copy(sectorBase(sector));
  if (toNext < 30) out.lerp(sectorBase(sector + 1), 1 - toNext / 30);
  return out;
}

export interface StripColumn {
  lateral: (f: SampleFrame) => number;
  height: (f: SampleFrame) => number;
  /** v texture coordinate for this column. */
  v: number;
}

interface StripOptions {
  sector?: boolean;
  road?: boolean;
  vertexColors?: boolean;
  intensity?: number;
  /** Build only sample rows first..last (inclusive) instead of the whole road. */
  rows?: [number, number];
  /** One colour for the whole strip instead of the main loop's sector colours (branches). */
  color?: Color;
}

/**
 * A grid of vertices running along the loop: one row per sample (plus a closing row), one
 * vertex per column. Consecutive columns are joined with quads where `connect(j, i)` allows
 * (column j, sample row i to i + 1).
 */
export function buildStrip(
  track: Road,
  columns: StripColumn[],
  connect: (j: number, i: number) => boolean,
  options: StripOptions = {},
): BufferGeometry {
  const first = options.rows?.[0] ?? 0;
  const rows = options.rows
    ? options.rows[1] - options.rows[0] + 1
    : track.closed
      ? track.count + 1
      : track.count;
  const cols = columns.length;
  const positions = new Float32Array(rows * cols * 3);
  const uvs = new Float32Array(rows * cols * 2);
  const sector = options.sector || options.vertexColors ? new Float32Array(rows * cols * 3) : null;
  const road = options.road ? new Float32Array(rows * cols * 3) : null;
  const edges = options.road ? new Float32Array(rows * cols * 2) : null;
  const f = {} as SampleFrame;
  const color = new Color();
  const intensity = options.intensity ?? 1;

  for (let i = 0; i < rows; i++) {
    sampleFrame(track, first + i, f);
    if (sector) {
      if (options.color) color.copy(options.color);
      else sectorColorAt(track as Track, f.s, color);
      color.multiplyScalar(intensity);
    }
    for (let j = 0; j < cols; j++) {
      const col = columns[j];
      const lat = col.lateral(f);
      const k = i * cols + j;
      positions[k * 3] = f.x + f.rx * lat;
      positions[k * 3 + 1] = col.height(f);
      positions[k * 3 + 2] = f.z + f.rz * lat;
      uvs[k * 2] = f.s;
      uvs[k * 2 + 1] = col.v;
      if (sector) {
        sector[k * 3] = color.r;
        sector[k * 3 + 1] = color.g;
        sector[k * 3 + 2] = color.b;
      }
      if (road && edges) {
        road[k * 3] = f.s;
        road[k * 3 + 1] = lat;
        road[k * 3 + 2] = f.hw;
        edges[k * 2] = f.wallLeft ? 0 : 1;
        edges[k * 2 + 1] = f.wallRight ? 0 : 1;
      }
    }
  }

  const indices: number[] = [];
  for (let i = 0; i < rows - 1; i++) {
    for (let j = 0; j < cols - 1; j++) {
      if (!connect(j, first + i)) continue;
      const a = i * cols + j;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      indices.push(a, b, c, b, d, c);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
  if (sector)
    geometry.setAttribute(
      options.vertexColors ? 'color' : 'aSector',
      new BufferAttribute(sector, 3),
    );
  if (road) geometry.setAttribute('aRoad', new BufferAttribute(road, 3));
  if (edges) geometry.setAttribute('aEdge', new BufferAttribute(edges, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

/** The driving surface: left edge → right edge, upward-facing. */
export function buildRoadGeometry(track: Road, color?: Color): BufferGeometry {
  return buildStrip(
    track,
    [
      { lateral: (f) => -f.hw, height: (f) => surfaceY(f, -f.hw), v: 0 },
      { lateral: () => 0, height: (f) => f.y, v: 0.5 },
      { lateral: (f) => f.hw, height: (f) => surfaceY(f, f.hw), v: 1 },
    ],
    () => true,
    { road: true, sector: true, color },
  );
}

const deckBottom = (y: number) => (y > ELEVATED ? y - DECK_DEPTH : GROUND_LEVEL);

/** Walled stretches get a shoulder beyond the road edge for barriers, posts and arch feet. */
export const SHOULDER = 2.8;
const shoulderL = (f: SampleFrame) => (f.wallLeft && !f.portalLeft ? SHOULDER : 0);
const shoulderR = (f: SampleFrame) => (f.wallRight && !f.portalRight ? SHOULDER : 0);

/**
 * The road deck: shoulders, side walls and underside (an embankment at ground level, a slab
 * when raised). Open edges have no shoulder, so the drop-off is right at the road edge.
 */
export function buildDeckGeometry(track: Road): BufferGeometry {
  return buildStrip(
    track,
    [
      { lateral: (f) => -f.hw, height: (f) => surfaceY(f, -f.hw) - 0.02, v: 0 },
      { lateral: (f) => -f.hw - shoulderL(f), height: (f) => surfaceY(f, -f.hw) - 0.02, v: 0.2 },
      {
        lateral: (f) => -f.hw - shoulderL(f),
        height: (f) => deckBottom(surfaceY(f, -f.hw)),
        v: 0.4,
      },
      {
        lateral: (f) => f.hw + shoulderR(f),
        height: (f) => deckBottom(surfaceY(f, f.hw)),
        v: 0.6,
      },
      { lateral: (f) => f.hw + shoulderR(f), height: (f) => surfaceY(f, f.hw) - 0.02, v: 0.8 },
      { lateral: (f) => f.hw, height: (f) => surfaceY(f, f.hw) - 0.02, v: 1 },
    ],
    () => true,
  );
}

/** Neon kerb rails along both edges (box section), coloured per sector in HDR; none at openings. */
export function buildRailGeometry(track: Road, color?: Color): BufferGeometry {
  const w = 0.32;
  const h = 0.32;
  const side = (sign: number): StripColumn[] => [
    { lateral: (f) => sign * f.hw, height: (f) => surfaceY(f, sign * f.hw), v: 0 },
    { lateral: (f) => sign * f.hw, height: (f) => surfaceY(f, sign * f.hw) + h, v: 0.33 },
    { lateral: (f) => sign * (f.hw + w), height: (f) => surfaceY(f, sign * f.hw) + h, v: 0.66 },
    { lateral: (f) => sign * (f.hw + w), height: (f) => surfaceY(f, sign * f.hw), v: 1 },
  ];
  const opening = (i: number, sign: number) => {
    const k = track.closed ? i % track.count : Math.min(i, track.count - 1);
    return (sign < 0 ? track.portalLeft[k] : track.portalRight[k]) >= 0;
  };
  return buildStrip(
    track,
    [...side(-1), ...side(1)],
    (j, i) => j !== 3 && !opening(i, j < 3 ? -1 : 1) && !opening(i + 1, j < 3 ? -1 : 1),
    {
      sector: true,
      intensity: 3.2,
      color,
    },
  );
}

/**
 * True where an energy barrier stands at sample i (walled side, not inside a tunnel, not an
 * opening into the shortcut: that one has its own barrier, raised and lowered with its state).
 */
export function hasBarrier(track: Road, i: number, sign: number): boolean {
  const k = track.closed ? i % track.count : Math.min(i, track.count - 1);
  if (track.roof[k] > 0) return false;
  if ((sign < 0 ? track.portalLeft[k] : track.portalRight[k]) >= 0) return false;
  return (sign < 0 ? track.wallLeft[k] : track.wallRight[k]) === 1;
}

/**
 * Translucent energy barriers: uv.x = s in metres, uv.y = 0 bottom → 1 top. Open edges get
 * none, and inside tunnels the tunnel wall takes over.
 */
export function buildBarrierGeometry(track: Road, color?: Color): BufferGeometry {
  const at = (sign: number, top: boolean): StripColumn => ({
    lateral: (f) => sign * (f.hw + BARRIER_OFFSET),
    height: (f) => surfaceY(f, sign * f.hw) + (top ? BARRIER_HEIGHT : 0),
    v: top ? 1 : 0,
  });
  return buildStrip(
    track,
    [at(-1, false), at(-1, true), at(1, false), at(1, true)],
    (j, i) => {
      if (j === 1) return false;
      const sign = j === 0 ? -1 : 1;
      return hasBarrier(track, i, sign) && hasBarrier(track, i + 1, sign);
    },
    { sector: true, color },
  );
}

/**
 * Collects oriented boxes (from point a to point b) into one InstancedMesh. Used for arches,
 * gates, posts and pillars: hundreds of boxes, one draw call per material.
 */
export class BoxBatch {
  private readonly matrices: number[] = [];
  private readonly colors: number[] = [];
  private readonly m = new Matrix4();

  get count(): number {
    return this.matrices.length / 16;
  }

  /**
   * Box whose length axis runs from a to b. `width` is across, `depth` along the reference
   * direction (fx, fz) made perpendicular to the length axis.
   */
  add(
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    width: number,
    depth: number,
    fx: number,
    fz: number,
    color?: Color,
  ): void {
    let yx = bx - ax;
    let yy = by - ay;
    let yz = bz - az;
    const len = Math.hypot(yx, yy, yz) || 1e-4;
    yx /= len;
    yy /= len;
    yz /= len;
    // Depth axis: reference direction with its component along the length axis removed.
    let zx = fx;
    let zy = 0;
    let zz = fz;
    const dot = zx * yx + zy * yy + zz * yz;
    zx -= yx * dot;
    zy -= yy * dot;
    zz -= yz * dot;
    let zl = Math.hypot(zx, zy, zz);
    if (zl < 1e-4) {
      zx = 0;
      zy = 1;
      zz = 0;
      zl = 1;
    }
    zx /= zl;
    zy /= zl;
    zz /= zl;
    // X = Y × Z keeps the basis right-handed.
    const xx = yy * zz - yz * zy;
    const xy = yz * zx - yx * zz;
    const xz = yx * zy - yy * zx;
    this.m.set(
      xx * width,
      yx * len,
      zx * depth,
      (ax + bx) / 2,
      xy * width,
      yy * len,
      zy * depth,
      (ay + by) / 2,
      xz * width,
      yz * len,
      zz * depth,
      (az + bz) / 2,
      0,
      0,
      0,
      1,
    );
    this.matrices.push(...this.m.elements);
    if (color) this.colors.push(color.r, color.g, color.b);
  }

  build(material: Material): InstancedMesh {
    const count = this.count;
    const mesh = new InstancedMesh(new BoxGeometry(1, 1, 1), material, count);
    mesh.instanceMatrix.array.set(this.matrices);
    mesh.instanceMatrix.needsUpdate = true;
    if (this.colors.length === count * 3) {
      mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(this.colors), 3);
    }
    mesh.computeBoundingSphere();
    mesh.frustumCulled = false;
    return mesh;
  }
}

export interface TrackFurniture {
  structure: BoxBatch;
  neon: BoxBatch;
}

const POST_SPACING = 12;
const ARCH_SPACING = 72;

/**
 * Posts, arches, checkpoint gates and elevated-deck pillars, as two box batches:
 * dark structure and HDR neon.
 */
export function buildTrackFurniture(track: Track): TrackFurniture {
  const structure = new BoxBatch();
  const neon = new BoxBatch();
  const f = {} as SampleFrame;
  const color = new Color();
  const gateS = track.checkpoints.map((g) => g.s);
  const nearGate = (s: number, range: number) =>
    gateS.some((g) => Math.min(Math.abs(s - g), track.length - Math.abs(s - g)) < range);

  // Barrier posts with glowing caps.
  const postEvery = Math.max(1, Math.round(POST_SPACING / track.spacing));
  for (let i = 0; i < track.count; i += postEvery) {
    sampleFrame(track, i, f);
    if (nearGate(f.s, 8)) continue;
    sectorColorAt(track, f.s, color).multiplyScalar(5);
    for (const sign of [-1, 1]) {
      if (!hasBarrier(track, i, sign)) continue;
      const lat = sign * (f.hw + BARRIER_OFFSET + 0.15);
      const x = f.x + f.rx * lat;
      const z = f.z + f.rz * lat;
      const y = surfaceY(f, sign * f.hw);
      structure.add(x, y, z, x, y + 2.7, z, 0.22, 0.22, f.fx, f.fz);
      neon.add(x, y + 2.7, z, x, y + 2.95, z, 0.32, 0.32, f.fx, f.fz, color);
    }
  }

  // Hexagonal arches spanning the road.
  const archEvery = Math.round(ARCH_SPACING / track.spacing);
  const clearForArch = (i: number) => {
    for (let k = -8; k <= 8; k++) {
      const j = (i + k + track.count) % track.count;
      if (track.roof[j] > 0 || track.wallLeft[j] === 0 || track.wallRight[j] === 0) return false;
      // Openings and the split have their own structures.
      if (track.portalLeft[j] >= 0 || track.portalRight[j] >= 0 || track.splitAt(j) >= 0) {
        return false;
      }
    }
    return true;
  };
  for (let i = Math.round(60 / track.spacing); i < track.count; i += archEvery) {
    sampleFrame(track, i, f);
    if (nearGate(f.s, 45) || !clearForArch(i)) continue;
    sectorColorAt(track, f.s, color).multiplyScalar(4);
    addArch(structure, neon, f, color, 7.2, 3.4);
  }

  // Checkpoint gates (the start/finish line has its own gantry).
  for (const gate of track.checkpoints) {
    if (gate.index === 0) continue;
    const i = Math.round(gate.s / track.spacing);
    sampleFrame(track, i, f);
    sectorColorAt(track, gate.s + 1, color).multiplyScalar(7);
    addGate(structure, neon, f, color);
  }

  // Pillars under the raised Skyway.
  const pillarEvery = Math.round(22 / track.spacing);
  for (let i = 0; i < track.count; i += pillarEvery) {
    sampleFrame(track, i, f);
    if (f.y < ELEVATED + 1) continue;
    for (const sign of [-1, 1]) {
      const lat = sign * f.hw * 0.55;
      const x = f.x + f.rx * lat;
      const z = f.z + f.rz * lat;
      const top = surfaceY(f, lat) - DECK_DEPTH;
      structure.add(x, GROUND_LEVEL, z, x, top, z, 1.7, 1.7, f.fx, f.fz);
      color.set('#ff2bd6').multiplyScalar(3);
      neon.add(x, top - 1.6, z, x, top - 1.3, z, 1.8, 1.8, f.fx, f.fz, color);
    }
    // Cross beam under the deck.
    const lx = f.x - f.rx * f.hw * 0.62;
    const lz = f.z - f.rz * f.hw * 0.62;
    const rx = f.x + f.rx * f.hw * 0.62;
    const rz = f.z + f.rz * f.hw * 0.62;
    const y = f.y - DECK_DEPTH - 0.4;
    structure.add(lx, y, lz, rx, y, rz, 0.9, 1.2, f.fx, f.fz);
  }

  return { structure, neon };
}

function addArch(
  structure: BoxBatch,
  neon: BoxBatch,
  f: SampleFrame,
  color: Color,
  height: number,
  rise: number,
): void {
  const outer = f.hw + BARRIER_OFFSET + 1.2;
  const inner = f.hw * 0.55;
  const baseL = surfaceY(f, -f.hw);
  const baseR = surfaceY(f, f.hw);
  const top = Math.max(baseL, baseR) + height + rise;
  // Points in the cross-section plane: (lateral, height).
  const pts: [number, number][] = [
    [-outer, baseL],
    [-outer, Math.max(baseL, baseR) + height],
    [-inner, top],
    [inner, top],
    [outer, Math.max(baseL, baseR) + height],
    [outer, baseR],
  ];
  const cx = 0;
  const cy = top - rise - height * 0.5;
  for (let k = 0; k < pts.length - 1; k++) {
    const [la, ha] = pts[k];
    const [lb, hb] = pts[k + 1];
    const ax = f.x + f.rx * la;
    const az = f.z + f.rz * la;
    const bx = f.x + f.rx * lb;
    const bz = f.z + f.rz * lb;
    structure.add(ax, ha, az, bx, hb, bz, 0.75, 0.9, f.fx, f.fz);
    // Neon strip on the inner face: offset toward the arch centre in the cross-section.
    let nl = -(hb - ha);
    let nh = lb - la;
    const ml = (la + lb) / 2;
    const mh = (ha + hb) / 2;
    if (nl * (cx - ml) + nh * (cy - mh) < 0) {
      nl = -nl;
      nh = -nh;
    }
    const nlen = Math.hypot(nl, nh) || 1;
    const o = 0.45;
    const ol = (nl / nlen) * o;
    const oh = (nh / nlen) * o;
    neon.add(
      f.x + f.rx * (la + ol),
      ha + oh,
      f.z + f.rz * (la + ol),
      f.x + f.rx * (lb + ol),
      hb + oh,
      f.z + f.rz * (lb + ol),
      0.14,
      0.5,
      f.fx,
      f.fz,
      color,
    );
  }
}

function addGate(structure: BoxBatch, neon: BoxBatch, f: SampleFrame, color: Color): void {
  const outer = f.hw + BARRIER_OFFSET + 1.6;
  const baseL = surfaceY(f, -f.hw);
  const baseR = surfaceY(f, f.hw);
  const top = Math.max(baseL, baseR) + 12.5;
  for (const [lat, base] of [
    [-outer, baseL],
    [outer, baseR],
  ] as const) {
    const x = f.x + f.rx * lat;
    const z = f.z + f.rz * lat;
    structure.add(x, base, z, x, top + 1.2, z, 1.6, 1.6, f.fx, f.fz);
    for (const off of [-0.9, 0.9]) {
      const ox = x + f.fx * off;
      const oz = z + f.fz * off;
      neon.add(ox, base + 0.5, oz, ox, top, oz, 0.18, 0.18, f.fx, f.fz, color);
    }
  }
  const lx = f.x - f.rx * outer;
  const lz = f.z - f.rz * outer;
  const rx = f.x + f.rx * outer;
  const rz = f.z + f.rz * outer;
  structure.add(lx, top + 0.6, lz, rx, top + 0.6, rz, 1.4, 1.8, f.fx, f.fz);
  neon.add(lx, top - 0.25, lz, rx, top - 0.25, rz, 0.22, 2.0, f.fx, f.fz, color);
}
