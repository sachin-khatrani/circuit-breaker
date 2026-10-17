import { angleDelta, wrapAngle } from '../math/scalar';
import { DT } from '../sim/config';
import { createRacerRow, FLAG_FROZEN, type RacerRow } from './codec';
import { SNAPSHOT_RATE } from './protocol';

/** Remote cars are drawn at least this far behind the newest snapshot (ms). */
export const MIN_INTERP_MS = 100;

/**
 * How far in the past (ms of server time) to draw other players' cars, so that a snapshot
 * normally exists on both sides of the drawn moment: snapshots arrive about half a round trip
 * after the server made them, then one every interval, give or take the jitter. Without the
 * half round trip, at 200 ms the newest snapshot was nearly always older than the drawn
 * moment and nine frames in ten were guessed ahead (Step 9 harness, `net-latency`).
 */
export function remoteDelayMs(snapshotRate: number, rttMs: number, jitterMs: number): number {
  const interval = 1000 / (snapshotRate || SNAPSHOT_RATE);
  return Math.max(MIN_INTERP_MS, 2.2 * interval + jitterMs) + rttMs / 2;
}

/**
 * The remote delay as drawn: it follows `remoteDelayMs`, whose round trip and jitter change
 * with every ping, but eases toward it (at most a tenth of real time), so the drawn moment
 * never jumps and remote cars never skip forward or back.
 */
export class RemoteDelay {
  private value: number | null = null;

  /** The delay for a frame `frameMs` after the last one, given the latest target. */
  update(targetMs: number, frameMs: number): number {
    if (this.value === null) return (this.value = targetMs);
    const step = Math.min(Math.abs(targetMs - this.value), Math.max(0, frameMs) * 0.1);
    this.value += Math.sign(targetMs - this.value) * step;
    return this.value;
  }
}

export interface RemoteSample extends RacerRow {
  /** Server tick of the snapshot this sample came from. */
  tick: number;
}

export function createRemoteSample(): RemoteSample {
  return { ...createRacerRow(), tick: 0 };
}

export type SampleResult = 'interpolated' | 'extrapolated' | 'held' | 'none';

/** Two samples further apart than this (m), beyond what speed explains, are a teleport. */
const TELEPORT_SLACK = 12;

/**
 * Snapshot history of one remote car. It is drawn a little in the past (see `sample`) so a
 * snapshot normally exists on both sides of the render time:
 * * position: cubic Hermite from position and velocity, smooth through 20 Hz snapshots
 * * yaw: the shortest arc
 * * discrete state (flags, steer, lap…): the nearer snapshot
 *
 * A respawn (or any jump speed cannot explain) snaps instead of sliding across the map. With no
 * newer snapshot (a delayed packet) the car is extrapolated from its velocity for a short time,
 * then held where it is.
 */
export class RemoteTrack {
  private readonly samples: RemoteSample[] = [];

  constructor(private readonly capacity = 48) {}

  get latestTick(): number {
    return this.samples.length > 0 ? this.samples[this.samples.length - 1].tick : -1;
  }

  get size(): number {
    return this.samples.length;
  }

  clear(): void {
    this.samples.length = 0;
  }

  /** Adds a snapshot row. Out-of-order or duplicate ticks are ignored. */
  push(tick: number, row: Readonly<RacerRow>): void {
    if (tick <= this.latestTick) return;
    const sample =
      this.samples.length >= this.capacity ? this.samples.shift()! : createRemoteSample();
    Object.assign(sample, row);
    sample.tick = tick;
    this.samples.push(sample);
  }

  /** Writes the car's state at `renderTick` (fractional) into `out`. */
  sample(renderTick: number, out: RemoteSample, maxExtrapolateTicks = 9): SampleResult {
    const n = this.samples.length;
    if (n === 0) return 'none';
    const last = this.samples[n - 1];
    if (renderTick >= last.tick) {
      const ahead = Math.min(renderTick - last.tick, maxExtrapolateTicks);
      Object.assign(out, last);
      if (ahead > 0 && (last.flags & FLAG_FROZEN) === 0) {
        const t = ahead * DT;
        out.x = last.x + last.vx * t;
        out.y = last.y + last.vy * t;
        out.z = last.z + last.vz * t;
        out.yaw = wrapAngle(last.yaw + last.yawRate * t);
      }
      out.tick = renderTick;
      return renderTick - last.tick > maxExtrapolateTicks ? 'held' : 'extrapolated';
    }
    // Find the pair around the render time (newest first: the render time is near the end).
    let i = n - 2;
    while (i > 0 && this.samples[i].tick > renderTick) i--;
    const a = this.samples[Math.max(0, i)];
    const b = this.samples[Math.max(0, i) + 1] ?? a;
    if (renderTick <= a.tick || a === b) {
      Object.assign(out, a);
      out.tick = renderTick;
      return 'interpolated';
    }
    const span = b.tick - a.tick;
    const u = (renderTick - a.tick) / span;
    const dt = span * DT;
    const jump = Math.hypot(b.x - a.x, b.z - a.z);
    const reach = Math.max(Math.hypot(a.vx, a.vz), Math.hypot(b.vx, b.vz)) * dt + TELEPORT_SLACK;
    if (jump > reach || (b.flags & FLAG_FROZEN && !(a.flags & FLAG_FROZEN))) {
      // Respawned between the two snapshots: show it at its new place, no slide.
      Object.assign(out, b);
      out.tick = renderTick;
      return 'interpolated';
    }
    Object.assign(out, u < 0.5 ? a : b);
    const h00 = 2 * u * u * u - 3 * u * u + 1;
    const h10 = u * u * u - 2 * u * u + u;
    const h01 = -2 * u * u * u + 3 * u * u;
    const h11 = u * u * u - u * u;
    out.x = h00 * a.x + h10 * dt * a.vx + h01 * b.x + h11 * dt * b.vx;
    out.y = h00 * a.y + h10 * dt * a.vy + h01 * b.y + h11 * dt * b.vy;
    out.z = h00 * a.z + h10 * dt * a.vz + h01 * b.z + h11 * dt * b.vz;
    out.vx = a.vx + (b.vx - a.vx) * u;
    out.vy = a.vy + (b.vy - a.vy) * u;
    out.vz = a.vz + (b.vz - a.vz) * u;
    out.yaw = wrapAngle(a.yaw + angleDelta(a.yaw, b.yaw) * u);
    out.yawRate = a.yawRate + (b.yawRate - a.yawRate) * u;
    out.steer = a.steer + (b.steer - a.steer) * u;
    out.throttle = a.throttle + (b.throttle - a.throttle) * u;
    out.trackS = u < 0.5 ? a.trackS : b.trackS;
    out.tick = renderTick;
    // Drop history the render time has passed (keep one sample behind it).
    if (i > 1) this.samples.splice(0, i - 1);
    return 'interpolated';
  }
}
