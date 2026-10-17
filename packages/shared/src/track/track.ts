import { angleDelta, clamp, clamp01, lerp, mod } from '../math/scalar';
import { sampleClosedSpline, sampleOpenSpline, type CenterlineSamples } from './spline';
import type {
  CheckpointGate,
  EnergyCellPlacement,
  GridSlot,
  Portal,
  ShortcutDef,
  TrackControlPoint,
  TrackDefinition,
  TrackFrame,
  TrackProjection,
  TrackSplit,
  TrackZone,
} from './types';

/** Target spacing between centre-line samples, in metres. */
export const TRACK_SAMPLE_SPACING = 2;
/** Projection searches this many samples either side of the hint before falling back. */
const PROJECT_WINDOW = 16;
/** Cells float this far above the road surface. */
export const ENERGY_CELL_HEIGHT = 1.4;
/** Lowest point of the road surface above y = 0. */
const MIN_ROAD_HEIGHT = 0.05;
/** Height of the ground plane under the circuit. Off-road cars drive (or land) on it. */
export const GROUND_LEVEL = -0.3;
/** Control points along a branch's openings are placed at most this far apart (m). */
const OPENING_POINT_STEP = 4;

const GRID_FIRST_ROW = 9;
const GRID_ROW_SPACING = 14;
const GRID_STAGGER = 7;
const GRID_LATERAL = 4.5;

export interface TrackBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

/**
 * A drivable centre line with everything physics, the autopilot and rendering need: uniform
 * samples, frames, projection, barriers. The main loop is closed; a shortcut branch is an
 * open road. Road 0 is always the main loop.
 */
export class Road {
  readonly roadId: number;
  readonly closed: boolean;
  readonly length: number;
  readonly count: number;
  readonly spacing: number;

  /** Centre-line position per sample. */
  readonly px: Float64Array;
  readonly py: Float64Array;
  readonly pz: Float64Array;
  /** Unit forward direction in XZ per sample. */
  readonly fx: Float64Array;
  readonly fz: Float64Array;
  /** Vertical component of the 3D unit tangent per sample. */
  readonly slope: Float64Array;
  readonly halfWidth: Float64Array;
  /** Bank in radians, positive lowers the right edge. */
  readonly bank: Float64Array;
  /** Signed curvature (1/m, positive = left turn), lightly smoothed. */
  readonly curvature: Float64Array;
  readonly heading: Float64Array;
  /** 1 where an energy barrier lines the left / right road edge, 0 on open stretches. */
  readonly wallLeft: Uint8Array;
  readonly wallRight: Uint8Array;
  /**
   * Portal id where the left / right edge is an opening into another road, else -1. An
   * opening also has its wall flag set: the barrier stands there while the opening is shut.
   */
  readonly portalLeft: Int16Array;
  readonly portalRight: Int16Array;
  /** Roof height above the road centre per sample; 0 in the open. */
  readonly roof: Float64Array;

  protected constructor(roadId: number, closed: boolean, c: CenterlineSamples) {
    this.roadId = roadId;
    this.closed = closed;
    const n = c.count;
    this.count = n;
    this.spacing = c.spacing;
    this.length = c.length;
    this.px = c.x;
    this.py = c.y;
    this.pz = c.z;
    this.halfWidth = new Float64Array(n);
    this.bank = new Float64Array(n);
    this.fx = new Float64Array(n);
    this.fz = new Float64Array(n);
    this.slope = new Float64Array(n);
    this.heading = new Float64Array(n);
    this.curvature = new Float64Array(n);

    for (let i = 0; i < n; i++) {
      this.halfWidth[i] = c.width[i] / 2;
      this.bank[i] = (c.bank[i] * Math.PI) / 180;
      // A banked corner at ground level is lifted just enough to keep its low edge above
      // the ground, as a real banked turn rises on its outside.
      const lowEdgeDrop = this.halfWidth[i] * Math.abs(Math.tan(this.bank[i]));
      c.y[i] = Math.max(c.y[i], lowEdgeDrop + MIN_ROAD_HEIGHT);
    }
    for (let i = 0; i < n; i++) {
      const a = this.neighbour(i, -1);
      const b = this.neighbour(i, 1);
      const tx = c.x[b] - c.x[a];
      const ty = c.y[b] - c.y[a];
      const tz = c.z[b] - c.z[a];
      const flat = Math.hypot(tx, tz);
      this.fx[i] = tx / flat;
      this.fz[i] = tz / flat;
      this.slope[i] = ty / Math.hypot(tx, ty, tz);
      this.heading[i] = Math.atan2(this.fx[i], this.fz[i]);
    }

    const raw = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const a = this.neighbour(i, -1);
      const b = this.neighbour(i, 1);
      const steps = closed ? 2 : b - a;
      raw[i] = angleDelta(this.heading[a], this.heading[b]) / (steps * this.spacing);
    }
    const smooth = 3;
    for (let i = 0; i < n; i++) {
      let sum = 0;
      let used = 0;
      for (let k = -smooth; k <= smooth; k++) {
        const j = i + k;
        if (!closed && (j < 0 || j >= n)) continue;
        sum += raw[(j + n) % n];
        used++;
      }
      this.curvature[i] = sum / used;
    }

    this.wallLeft = new Uint8Array(n).fill(1);
    this.wallRight = new Uint8Array(n).fill(1);
    this.portalLeft = new Int16Array(n).fill(-1);
    this.portalRight = new Int16Array(n).fill(-1);
    this.roof = new Float64Array(n);
  }

  /** Sample index `step` (±1) away from i: wraps on a loop, stops at the ends of a branch. */
  private neighbour(i: number, step: number): number {
    const j = i + step;
    if (this.closed) return (j + this.count) % this.count;
    return Math.min(this.count - 1, Math.max(0, j));
  }

  /** True when an energy barrier lines the edge on the side of `lateral` at sample `index`. */
  hasWall(index: number, lateral: number): boolean {
    return (lateral > 0 ? this.wallRight[index] : this.wallLeft[index]) === 1;
  }

  /** Portal id of the opening on the side of `lateral` at sample `index`, or -1. */
  portalAt(index: number, lateral: number): number {
    return lateral > 0 ? this.portalRight[index] : this.portalLeft[index];
  }

  /** Arc length wrapped onto a loop, or clamped onto a branch. */
  wrapS(s: number): number {
    return this.closed ? mod(s, this.length) : clamp(s, 0, this.length);
  }

  /** Distance travelled going forward from `fromS` to `toS` (on a loop, in [0, length)). */
  distanceAhead(fromS: number, toS: number): number {
    return this.closed ? mod(toS - fromS, this.length) : toS - fromS;
  }

  /** Interpolated frame at arc length `s`. */
  frameAt(s: number, out: TrackFrame = createFrame()): TrackFrame {
    const ws = this.wrapS(s);
    const fi = ws / this.spacing;
    if (this.closed) {
      const i = Math.floor(fi) % this.count;
      return this.fillFrame(out, i, (i + 1) % this.count, fi - Math.floor(fi), ws);
    }
    const i = Math.min(Math.floor(fi), this.count - 2);
    return this.fillFrame(out, i, i + 1, Math.min(1, fi - i), ws);
  }

  /** World position of the road surface at (s, lateral). */
  pointAt(s: number, lateral: number, out: { x: number; y: number; z: number }): void {
    const f = this.frameAt(s, scratchFrame);
    out.x = f.x + f.rx * lateral;
    out.y = f.y - lateral * Math.tan(f.bank);
    out.z = f.z + f.rz * lateral;
  }

  /**
   * Closest centre-line point to (x, z), searched near `hint` (a sample index). A negative
   * hint, or a best match on the edge of the search window, triggers a full search.
   */
  project(
    x: number,
    z: number,
    hint: number,
    out: TrackProjection = createProjection(),
  ): TrackProjection {
    if (hint < 0 || hint >= this.count) return this.projectGlobal(x, z, out);
    const n = this.count;
    let best = -1;
    let bestK = 0;
    let bestU = 0;
    let bestD2 = Infinity;
    for (let k = -PROJECT_WINDOW; k <= PROJECT_WINDOW; k++) {
      let i = hint + k;
      if (this.closed) i = (i + n) % n;
      else if (i < 0 || i > n - 2) continue;
      const r = this.segmentDistance(i, x, z);
      if (r.d2 < bestD2) {
        bestD2 = r.d2;
        best = i;
        bestU = r.u;
        bestK = k;
      }
    }
    // On a branch the window may simply end at the road's end: that is not a miss.
    const atEnd = !this.closed && (best === 0 || best === n - 2);
    if (Math.abs(bestK) === PROJECT_WINDOW && !atEnd) return this.projectGlobal(x, z, out);
    return this.fillProjection(out, best, bestU, x, z);
  }

  projectGlobal(x: number, z: number, out: TrackProjection = createProjection()): TrackProjection {
    let best = 0;
    let bestU = 0;
    let bestD2 = Infinity;
    const segments = this.closed ? this.count : this.count - 1;
    for (let i = 0; i < segments; i++) {
      const r = this.segmentDistance(i, x, z);
      if (r.d2 < bestD2) {
        bestD2 = r.d2;
        best = i;
        bestU = r.u;
      }
    }
    return this.fillProjection(out, best, bestU, x, z);
  }

  /**
   * For a branch: -1 when (x, z) lies before its first sample, 1 past its last one, else 0.
   * Always 0 on the loop.
   */
  beyondEnds(x: number, z: number): -1 | 0 | 1 {
    if (this.closed) return 0;
    const n = this.count - 1;
    if ((x - this.px[0]) * this.fx[0] + (z - this.pz[0]) * this.fz[0] < 0) return -1;
    if ((x - this.px[n]) * this.fx[n] + (z - this.pz[n]) * this.fz[n] > 0) return 1;
    return 0;
  }

  private segmentDistance(i: number, x: number, z: number): { d2: number; u: number } {
    const j = this.closed ? (i + 1) % this.count : i + 1;
    const ax = this.px[i];
    const az = this.pz[i];
    const dx = this.px[j] - ax;
    const dz = this.pz[j] - az;
    const len2 = dx * dx + dz * dz;
    const u = len2 > 0 ? clamp01(((x - ax) * dx + (z - az) * dz) / len2) : 0;
    const cx = ax + dx * u - x;
    const cz = az + dz * u - z;
    segmentResult.d2 = cx * cx + cz * cz;
    segmentResult.u = u;
    return segmentResult;
  }

  private fillProjection(
    out: TrackProjection,
    i: number,
    u: number,
    x: number,
    z: number,
  ): TrackProjection {
    const j = this.closed ? (i + 1) % this.count : i + 1;
    const f = this.fillFrame(scratchFrame, i, j, u, this.wrapS((i + u) * this.spacing));
    out.index = i;
    out.s = f.s;
    out.lateral = (x - f.x) * f.rx + (z - f.z) * f.rz;
    out.halfWidth = f.halfWidth;
    out.height = f.y - out.lateral * Math.tan(f.bank);
    out.fx = f.fx;
    out.fz = f.fz;
    out.rx = f.rx;
    out.rz = f.rz;
    out.slope = f.slope;
    out.bank = f.bank;
    return out;
  }

  private fillFrame(out: TrackFrame, i: number, j: number, u: number, s: number): TrackFrame {
    const v = 1 - u;
    out.s = s;
    out.x = this.px[i] * v + this.px[j] * u;
    out.y = this.py[i] * v + this.py[j] * u;
    out.z = this.pz[i] * v + this.pz[j] * u;
    let fx = this.fx[i] * v + this.fx[j] * u;
    let fz = this.fz[i] * v + this.fz[j] * u;
    const len = Math.hypot(fx, fz) || 1;
    fx /= len;
    fz /= len;
    out.fx = fx;
    out.fz = fz;
    out.rx = -fz;
    out.rz = fx;
    out.slope = this.slope[i] * v + this.slope[j] * u;
    out.halfWidth = this.halfWidth[i] * v + this.halfWidth[j] * u;
    out.bank = this.bank[i] * v + this.bank[j] * u;
    out.heading = Math.atan2(fx, fz);
    out.curvature = this.curvature[i] * v + this.curvature[j] * u;
    return out;
  }
}

/**
 * A shortcut branch: an open road from an opening in the main loop's edge to a second
 * opening further on. Its first and last stretches run alongside the main road, sharing an
 * edge with it (the openings).
 */
export class BranchRoad extends Road {
  readonly name: string;
  /** Side of the main road it opens from: -1 left, 1 right. */
  readonly side: -1 | 1;
  /** Branch arc length where the entrance stretch ends and the merge stretch starts. */
  readonly entryEnd: number;
  readonly exitStart: number;
  /** Main-loop arc lengths and spans of the two openings. */
  readonly entryMainS: number;
  readonly entryMainSpan: number;
  readonly exitMainS: number;
  readonly exitMainSpan: number;
  private readonly main: Track;

  constructor(
    roadId: number,
    main: Track,
    def: ShortcutDef,
    samples: CenterlineSamples,
    openings: {
      entryEnd: number;
      exitStart: number;
      entry: [number, number];
      exit: [number, number];
    },
  ) {
    super(roadId, false, samples);
    this.name = def.name;
    this.side = def.side === 'left' ? -1 : 1;
    this.main = main;
    this.entryEnd = openings.entryEnd;
    this.exitStart = openings.exitStart;
    [this.entryMainS, this.entryMainSpan] = openings.entry;
    [this.exitMainS, this.exitMainSpan] = openings.exit;
  }

  /**
   * Main-loop arc length a branch position is worth, for standings: the openings map one to
   * one onto the main road beside them, the stretch between maps evenly onto the main-loop
   * stretch it bypasses.
   */
  mainS(s: number): number {
    const main = this.main;
    if (s <= this.entryEnd) {
      return main.wrapS(this.entryMainS + (s / Math.max(1e-6, this.entryEnd)) * this.entryMainSpan);
    }
    if (s >= this.exitStart) {
      const u = (s - this.exitStart) / Math.max(1e-6, this.length - this.exitStart);
      return main.wrapS(this.exitMainS + u * this.exitMainSpan);
    }
    const from = this.entryMainS + this.entryMainSpan;
    const span = main.distanceAhead(from, this.exitMainS);
    const u = (s - this.entryEnd) / Math.max(1e-6, this.exitStart - this.entryEnd);
    return main.wrapS(from + u * span);
  }
}

/**
 * Runtime track model built from a TrackDefinition: the main loop (road 0), plus its
 * shortcut branch and lane split if it has them. Shared by physics, race rules, the autopilot
 * and all render geometry, so every consumer sees exactly the same surface.
 */
export class Track extends Road {
  readonly def: TrackDefinition;
  readonly id: string;
  readonly name: string;
  readonly defaultLaps: number;
  /** Arc length of each control point (plus a final entry equal to the length). */
  readonly controlPointS: readonly number[];

  readonly checkpoints: readonly CheckpointGate[];
  readonly cells: readonly EnergyCellPlacement[];
  readonly pads: readonly TrackZone[];
  readonly lanes: readonly TrackZone[];
  /** Shortcut branches; branch k is road k + 1. */
  readonly branches: readonly BranchRoad[];
  /** Openings between the main loop and the branches. */
  readonly portals: readonly Portal[];
  readonly splits: readonly TrackSplit[];
  readonly bounds: TrackBounds;
  /** Pad / lane id touching each sample (-1 for none), so lookups cost O(1) per tick. */
  private readonly padBySample: Int16Array;
  private readonly laneBySample: Int16Array;
  /** Split id for samples in a split or its funnel, else -1. */
  private readonly splitBySample: Int16Array;

  constructor(def: TrackDefinition, spacing = TRACK_SAMPLE_SPACING) {
    validateDefinition(def);
    const c = sampleClosedSpline(def.points, spacing);
    super(0, true, c);
    this.def = def;
    this.id = def.id;
    this.name = def.name;
    this.defaultLaps = def.defaultLaps;
    this.controlPointS = c.controlPointS;
    const n = this.count;

    for (const edge of def.openEdges ?? []) {
      this.forEachSampleBetween(edge.from, edge.to, (i) => {
        if (edge.side !== 'right') this.wallLeft[i] = 0;
        if (edge.side !== 'left') this.wallRight[i] = 0;
      });
    }
    for (const tunnel of def.tunnels ?? []) {
      this.forEachSampleBetween(tunnel.from, tunnel.to, (i) => {
        this.roof[i] = tunnel.height;
      });
    }

    this.checkpoints = def.checkpoints.map((pointIndex, index) => {
      const f = this.frameAt(this.controlPointS[pointIndex]);
      return {
        index,
        s: f.s,
        x: f.x,
        y: f.y,
        z: f.z,
        fx: f.fx,
        fz: f.fz,
        rx: f.rx,
        rz: f.rz,
        halfWidth: f.halfWidth,
      };
    });

    this.cells = def.energyCells.map((cell, id) => {
      const s = this.paramToS(cell.at);
      const f = this.frameAt(s);
      return {
        id,
        s,
        lateral: cell.lateral,
        x: f.x + f.rx * cell.lateral,
        y: f.y - cell.lateral * Math.tan(f.bank) + ENERGY_CELL_HEIGHT,
        z: f.z + f.rz * cell.lateral,
      };
    });

    this.pads = (def.boostPads ?? []).map((pad, id) => ({
      id,
      s: this.paramToS(pad.at),
      length: pad.length,
      lateral: pad.lateral,
      halfWidth: pad.width / 2,
    }));
    this.lanes = (def.speedLanes ?? []).map((lane, id) => {
      const s = this.paramToS(lane.from);
      return {
        id,
        s,
        length: this.distanceAhead(s, this.paramToS(lane.to)),
        lateral: lane.lateral,
        halfWidth: lane.width / 2,
      };
    });
    this.padBySample = this.indexZones(this.pads, 'boost pad');
    this.laneBySample = this.indexZones(this.lanes, 'speed lane');

    const branches: BranchRoad[] = [];
    const portals: Portal[] = [];
    (def.shortcuts ?? []).forEach((shortcut, k) => {
      branches.push(this.buildBranch(shortcut, k + 1, portals));
    });
    this.branches = branches;
    this.portals = portals;

    this.splits = (def.splits ?? []).map((split, id) => {
      const s = this.paramToS(split.from);
      return {
        id,
        name: split.name,
        s,
        length: this.distanceAhead(s, this.paramToS(split.to)),
        funnelS: this.wrapS(s - split.funnel),
        funnel: split.funnel,
        divider: split.dividerWidth / 2,
      };
    });
    this.splitBySample = new Int16Array(n).fill(-1);
    for (const split of this.splits) {
      const first = Math.floor(split.funnelS / this.spacing);
      const last = Math.ceil((split.funnelS + split.funnel + split.length) / this.spacing);
      for (let k = first; k <= last; k++) this.splitBySample[mod(k, n)] = split.id;
    }

    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const road of [this as Road, ...branches]) {
      for (let i = 0; i < road.count; i++) {
        const r = road.halfWidth[i];
        minX = Math.min(minX, road.px[i] - r);
        maxX = Math.max(maxX, road.px[i] + r);
        minZ = Math.min(minZ, road.pz[i] - r);
        maxZ = Math.max(maxZ, road.pz[i] + r);
        minY = Math.min(minY, road.py[i]);
        maxY = Math.max(maxY, road.py[i]);
      }
    }
    this.bounds = { minX, maxX, minY, maxY, minZ, maxZ };
  }

  /** Road by id: 0 is the main loop, then the branches. */
  road(id: number): Road {
    return id === 0 ? this : (this.branches[id - 1] ?? this);
  }

  /** Main-loop arc length a position on any road is worth (for standings). */
  mainS(roadId: number, s: number): number {
    if (roadId === 0) return s;
    const branch = this.branches[roadId - 1];
    return branch ? branch.mainS(s) : s;
  }

  /** The split whose funnel or divider covers main-loop sample `index`, or -1. */
  splitAt(index: number): number {
    return index >= 0 && index < this.count ? this.splitBySample[index] : -1;
  }

  /**
   * Boost pad under a point at sample `index`, arc length `s` and `lateral` offset, or -1.
   * `margin` widens the pad (e.g. by part of the car's width).
   */
  padAt(index: number, s: number, lateral: number, margin = 0): number {
    return this.zoneAt(this.padBySample, this.pads, index, s, lateral, margin);
  }

  /** Speed lane under a point, or -1. Same arguments as `padAt`. */
  laneAt(index: number, s: number, lateral: number, margin = 0): number {
    return this.zoneAt(this.laneBySample, this.lanes, index, s, lateral, margin);
  }

  private zoneAt(
    table: Int16Array,
    zones: readonly TrackZone[],
    index: number,
    s: number,
    lateral: number,
    margin: number,
  ): number {
    const id = index >= 0 && index < this.count ? table[index] : -1;
    if (id < 0) return -1;
    const zone = zones[id];
    if (this.distanceAhead(zone.s, s) > zone.length) return -1;
    return Math.abs(lateral - zone.lateral) <= zone.halfWidth + margin ? id : -1;
  }

  /** Marks the samples each zone touches; zones of one kind must not overlap along the road. */
  private indexZones(zones: readonly TrackZone[], kind: string): Int16Array {
    const table = new Int16Array(this.count).fill(-1);
    for (const zone of zones) {
      const first = Math.floor(zone.s / this.spacing) - 1;
      const last = Math.ceil((zone.s + zone.length) / this.spacing);
      for (let k = first; k <= last; k++) {
        const i = mod(k, this.count);
        if (table[i] !== -1)
          throw new Error(`Track ${this.id}: ${kind}s ${table[i]} and ${zone.id} overlap`);
        table[i] = zone.id;
      }
    }
    return table;
  }

  /**
   * Builds a shortcut branch: its centre line runs alongside the main road through the
   * entrance (sharing the main road's edge), follows the via points, then runs alongside
   * again through the merge while it narrows. Both stretches become portals.
   */
  private buildBranch(def: ShortcutDef, roadId: number, portals: Portal[]): BranchRoad {
    const sign = def.side === 'left' ? -1 : 1;
    const opening = (from: number, to: number, width: (u: number) => number) => {
      const s0 = this.paramToS(from);
      const span = this.distanceAhead(s0, this.paramToS(to));
      const steps = Math.max(2, Math.ceil(span / OPENING_POINT_STEP));
      const points: TrackControlPoint[] = [];
      for (let q = 0; q <= steps; q++) {
        const u = q / steps;
        const f = this.frameAt(s0 + span * u);
        const w = width(u);
        const lateral = sign * (f.halfWidth + w / 2);
        points.push({
          x: f.x + f.rx * lateral,
          // Level with the main road's edge, so the surfaces meet without a step.
          y: f.y - sign * f.halfWidth * Math.tan(f.bank),
          z: f.z + f.rz * lateral,
          width: w,
          bank: 0,
        });
      }
      return { s0, span, points };
    };
    const entry = opening(def.entry.from, def.entry.to, () => def.width);
    const exit = opening(def.exit.from, def.exit.to, (u) => lerp(def.width, def.endWidth, u));
    const points: TrackControlPoint[] = [
      ...entry.points,
      ...def.via.map((p) => ({ x: p.x, y: p.y, z: p.z, width: def.width, bank: 0 })),
      ...exit.points,
    ];
    const samples = sampleOpenSpline(points, this.spacing);
    const cps = samples.controlPointS;
    const entryEnd = cps[entry.points.length - 1];
    const exitStart = cps[entry.points.length + def.via.length];
    const branch = new BranchRoad(roadId, this, def, samples, {
      entryEnd,
      exitStart,
      entry: [entry.s0, entry.span],
      exit: [exit.s0, exit.span],
    });

    const addPortal = (
      kind: Portal['kind'],
      mainS: number,
      mainSpan: number,
      branchFromS: number,
      branchToS: number,
    ) => {
      const id = portals.length;
      const mainFrom = Math.ceil(mainS / this.spacing);
      const mainTo = Math.floor((mainS + mainSpan) / this.spacing);
      const branchFrom = Math.max(0, Math.ceil(branchFromS / branch.spacing));
      const branchTo = Math.min(branch.count - 1, Math.floor(branchToS / branch.spacing));
      portals.push({
        id,
        kind,
        branch: roadId,
        side: sign,
        mainFrom,
        mainTo,
        branchFrom,
        branchTo,
      });
      const mainEdge = sign < 0 ? this.portalLeft : this.portalRight;
      for (let k = mainFrom; k <= mainTo; k++) mainEdge[mod(k, this.count)] = id;
      // The branch shares its opposite edge with the main road.
      const branchEdge = sign < 0 ? branch.portalRight : branch.portalLeft;
      for (let k = branchFrom; k <= branchTo; k++) branchEdge[k] = id;
    };
    addPortal('entry', entry.s0, entry.span, 0, entryEnd);
    addPortal('exit', exit.s0, exit.span, exitStart, branch.length);
    return branch;
  }

  /** Branch sample beside main-loop sample `mainIndex` of a portal (a projection hint). */
  portalHint(portal: Portal, mainIndex: number): number {
    const span = Math.max(1, mod(portal.mainTo - portal.mainFrom, this.count));
    const u = clamp01(mod(mainIndex - portal.mainFrom, this.count) / span);
    return Math.round(portal.branchFrom + u * (portal.branchTo - portal.branchFrom));
  }

  /** Main-loop sample beside branch sample `branchIndex` of a portal. */
  mainHint(portal: Portal, branchIndex: number): number {
    const span = Math.max(1, portal.branchTo - portal.branchFrom);
    const u = clamp01((branchIndex - portal.branchFrom) / span);
    return mod(
      Math.round(portal.mainFrom + u * mod(portal.mainTo - portal.mainFrom, this.count)),
      this.count,
    );
  }

  /** Calls `fn` with every sample index between two control-point parameters, in order. */
  forEachSampleBetween(fromParam: number, toParam: number, fn: (index: number) => void): void {
    const from = this.paramToS(fromParam);
    const span = this.distanceAhead(from, this.paramToS(toParam));
    const first = Math.ceil(from / this.spacing);
    const last = Math.floor((from + span) / this.spacing);
    for (let k = first; k <= last; k++) fn(k % this.count);
  }

  /** Converts a control-point parameter (e.g. 3.5) to arc length. */
  paramToS(param: number): number {
    const n = this.def.points.length;
    const p = mod(param, n);
    const k = Math.floor(p);
    const u = p - k;
    const a = this.controlPointS[k];
    const b = this.controlPointS[k + 1];
    return this.wrapS(a + (b - a) * u);
  }

  /** Start grid: two staggered columns behind the start/finish line. */
  gridSlot(slot: number): GridSlot {
    const row = Math.floor(slot / 2);
    const col = slot % 2;
    const s = this.wrapS(-(GRID_FIRST_ROW + row * GRID_ROW_SPACING + col * GRID_STAGGER));
    const lateral = col === 0 ? -GRID_LATERAL : GRID_LATERAL;
    const f = this.frameAt(s);
    return {
      slot,
      s,
      lateral,
      x: f.x + f.rx * lateral,
      y: f.y - lateral * Math.tan(f.bank),
      z: f.z + f.rz * lateral,
      yaw: f.heading,
    };
  }
}

const segmentResult = { d2: 0, u: 0 };
const scratchFrame = createFrame();

export function createFrame(): TrackFrame {
  return {
    s: 0,
    x: 0,
    y: 0,
    z: 0,
    fx: 0,
    fz: 1,
    rx: -1,
    rz: 0,
    slope: 0,
    halfWidth: 0,
    bank: 0,
    heading: 0,
    curvature: 0,
  };
}

export function createProjection(): TrackProjection {
  return {
    index: -1,
    s: 0,
    lateral: 0,
    halfWidth: 0,
    height: 0,
    fx: 0,
    fz: 1,
    rx: -1,
    rz: 0,
    slope: 0,
    bank: 0,
  };
}

function validateDefinition(def: TrackDefinition): void {
  const n = def.points.length;
  if (n < 4) throw new Error(`Track ${def.id}: needs at least 4 control points`);
  if (def.checkpoints[0] !== 0) throw new Error(`Track ${def.id}: checkpoint 0 must be point 0`);
  for (let i = 1; i < def.checkpoints.length; i++) {
    const cp = def.checkpoints[i];
    if (cp <= def.checkpoints[i - 1] || cp >= n) {
      throw new Error(`Track ${def.id}: checkpoints must increase within the point range`);
    }
  }
  if (def.checkpoints.length < 2) throw new Error(`Track ${def.id}: needs at least 2 checkpoints`);
  // The race keeps one shortcut state and one gate state.
  if ((def.shortcuts?.length ?? 0) > 1) throw new Error(`Track ${def.id}: at most one shortcut`);
  if ((def.splits?.length ?? 0) > 1) throw new Error(`Track ${def.id}: at most one lane split`);
}
