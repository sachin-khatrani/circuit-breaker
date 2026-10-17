import { LEFT_LANE, type CheckpointGate, type RaceEvent } from '@circuit-breaker/shared';
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { Color, Vector3 } from 'three';
import { PALETTE } from '../../game/palette';
import { session } from '../../game/session';
import { useGameStore } from '../../game/store';
import { ROUTE_CHANGING, ROUTE_LOCKED, ROUTE_OPEN } from '../track/routeMaterials';
import { BARRIER_OFFSET, sectorColorAt } from '../track/trackGeometry';
import { particles } from './particlePool';

const WHITE = new Color('#ffffff').multiplyScalar(2.5);
const FIREWORKS = [PALETTE.cyan, PALETTE.magenta, PALETTE.lime, PALETTE.amber].map((hex) =>
  new Color(hex).multiplyScalar(3),
);
const OPEN = ROUTE_OPEN.clone().multiplyScalar(3);
const CHANGING = ROUTE_CHANGING.clone().multiplyScalar(3);
const LOCKED = ROUTE_LOCKED.clone().multiplyScalar(3);
/** Seconds the finish fireworks keep going. */
const FIREWORK_SECONDS = 2.6;

/** A firework shell: a sphere of sparks moving at a carrying velocity (no drag, light fall). */
function shellBurst(
  x: number,
  y: number,
  z: number,
  vx: number,
  vz: number,
  count: number,
  speed: number,
  color: Color,
  size: number,
): void {
  for (let k = 0; k < count; k++) {
    const a = Math.random() * Math.PI * 2;
    const e = Math.asin(Math.random() * 2 - 1);
    const v = speed * (0.75 + Math.random() * 0.25);
    particles.emit(
      x,
      y,
      z,
      vx + Math.cos(a) * Math.cos(e) * v,
      Math.sin(e) * v,
      vz + Math.sin(a) * Math.cos(e) * v,
      1.1 + Math.random() * 0.5,
      color,
      size * (0.7 + Math.random() * 0.6),
      0,
      -2.5,
    );
  }
}

interface Firework {
  at: number;
  /** Where the shell bursts, relative to the camera's view: ahead, across, and up. */
  ahead: number;
  across: number;
  up: number;
  color: Color;
}

/**
 * Race moments told in light, all from the shared particle pool.
 * * A checkpoint (or a lap) throws a sheet of sparks across the road at the car, in the
 *   sector's colour: they start with the car and fall back past the chase camera.
 * * A finish sets off fireworks wherever the finish camera is looking.
 * * Track changes, anyone's ability, spark where they happen in the route colours (green
 *   open, amber changing, red shut), in big embers that read from a hundred metres away.
 * Purely visual: nothing here touches the race; it only reads the events it is told.
 */
export function RaceFx() {
  const reducedMotion = useGameStore((s) => s.reducedMotion);
  const amount = useRef(1);
  useEffect(() => {
    amount.current = reducedMotion ? 0.5 : 1;
  }, [reducedMotion]);

  const fx = useMemo(() => {
    const track = session.track;
    const branch = track.branches[0];
    const entry = branch
      ? track.portals.find((p) => p.branch === branch.roadId && p.kind === 'entry')
      : undefined;
    return {
      track,
      gateColors: track.checkpoints.map((g) =>
        sectorColorAt(track, g.s + 1, new Color()).multiplyScalar(3),
      ),
      entry,
      split: track.splits[0],
      point: new Vector3(),
      view: new Vector3(),
      queue: [] as Firework[],
      clock: 0,
    };
  }, []);

  useEffect(() => {
    const { track } = fx;
    const n = (count: number) => Math.max(1, Math.round(count * amount.current));
    const halfWidthAt = (s: number) =>
      track.halfWidth[Math.floor(track.wrapS(s) / track.spacing) % track.count];

    /** A sheet of sparks across the road where the car is, flying on with it. */
    const passBurst = (gate: CheckpointGate, color: Color, count: number, height: number) => {
      const car = session.render;
      const width = halfWidthAt(car.trackS) + BARRIER_OFFSET;
      for (let k = 0; k < n(count); k++) {
        const u = Math.random() * 2 - 1;
        const carry = 0.55 + Math.random() * 0.4;
        particles.emit(
          car.x + gate.rx * u * width,
          car.y + 0.4 + Math.random() * height,
          car.z + gate.rz * u * width,
          car.vx * carry + gate.rx * u * 3,
          1 + Math.random() * 3,
          car.vz * carry + gate.rz * u * 3,
          0.5 + Math.random() * 0.45,
          k % 5 === 0 ? WHITE : color,
          0.3 + Math.random() * 0.4,
          1.4,
          -3,
        );
      }
    };

    /** Big embers rising off a stretch of road, at one lateral offset (an edge or a lane). */
    const stretchBurst = (
      from: number,
      to: number,
      lateral: (s: number) => number,
      lift: number,
      color: Color,
      count: number,
    ) => {
      for (let k = 0; k < n(count); k++) {
        const s = from + Math.random() * (to - from);
        track.pointAt(s, lateral(s), fx.point);
        particles.emit(
          fx.point.x,
          fx.point.y + 0.3 + Math.random() * lift,
          fx.point.z,
          (Math.random() - 0.5) * 4,
          3 + Math.random() * 6,
          (Math.random() - 0.5) * 4,
          0.9 + Math.random() * 0.6,
          color,
          1 + Math.random() * 0.8,
          1.1,
          -5,
        );
      }
    };

    /** The Needle's opening along the main road's edge. */
    const needle = (color: Color, count: number) => {
      const entry = fx.entry;
      if (!entry) return;
      const from = entry.mainFrom * track.spacing;
      const to = entry.mainTo * track.spacing;
      stretchBurst(from, to, (s) => entry.side * halfWidthAt(s), 2.5, color, count);
    };

    /** The split: over one lane, along the funnel and at the divider's nose. */
    const gate = (lane: number, color: Color, count: number) => {
      const split = fx.split;
      if (!split) return;
      const sign = lane === LEFT_LANE ? -1 : 1;
      const centre = (s: number) => sign * (halfWidthAt(s) + split.divider) * 0.5;
      stretchBurst(split.funnelS + split.funnel * 0.4, split.s + 6, centre, 4, color, count);
    };

    const offLocal = session.onEvent((event: RaceEvent) => {
      if (!('racerId' in event) || event.racerId !== session.playerId) return;
      if (event.type === 'checkpoint') {
        const g = track.checkpoints[event.checkpoint];
        if (g) passBurst(g, fx.gateColors[g.index], 60, 6);
      } else if (event.type === 'lap' && event.lap < session.sim.laps) {
        passBurst(track.checkpoints[0], fx.gateColors[0], 120, 8);
      } else if (event.type === 'finish') {
        passBurst(track.checkpoints[0], fx.gateColors[0], 150, 9);
        const shells = n(8);
        for (let k = 0; k < shells; k++) {
          fx.queue.push({
            at: fx.clock + 0.1 + (k / shells) * FIREWORK_SECONDS + Math.random() * 0.15,
            // Inside the road corridor, in front of the buildings that line the straight.
            ahead: 22 + Math.random() * 12,
            across: (Math.random() * 2 - 1) * 14,
            up: 5 + Math.random() * 7,
            color: FIREWORKS[k % FIREWORKS.length],
          });
        }
      }
    });
    const offFeed = session.onFeed((event: RaceEvent) => {
      if (event.type === 'shortcut') {
        if (event.phase === 'opening') needle(CHANGING, 45);
        else if (event.phase === 'open') needle(OPEN, 80);
        else if (event.phase === 'closing') needle(CHANGING, 35);
        else needle(LOCKED, 55);
      } else if (event.type === 'gate') {
        const other = event.lane === LEFT_LANE ? 1 : LEFT_LANE;
        if (event.phase === 'warning') {
          gate(event.lane, CHANGING, 35);
          gate(other, CHANGING, 35);
        } else {
          gate(event.lane, OPEN, 70);
          gate(other, LOCKED, 50);
        }
      }
    });
    return () => {
      offLocal();
      offFeed();
    };
  }, [fx]);

  useFrame(({ camera }, delta) => {
    fx.clock += Math.min(delta, 0.05);
    const queue = fx.queue;
    if (queue.length === 0) return;
    // Fireworks go off where the camera looks (the finish camera circles the car).
    camera.getWorldDirection(fx.view);
    const len = Math.hypot(fx.view.x, fx.view.z) || 1;
    const fwdX = fx.view.x / len;
    const fwdZ = fx.view.z / len;
    const car = session.render;
    for (let i = queue.length - 1; i >= 0; i--) {
      const shell = queue[i];
      if (shell.at > fx.clock) continue;
      const x = camera.position.x + fwdX * shell.ahead + fwdZ * shell.across;
      const y = car.y + shell.up;
      const z = camera.position.z + fwdZ * shell.ahead - fwdX * shell.across;
      // The car is still doing race speed: the shells travel with it, or it would pass them
      // before they had faded.
      shellBurst(x, y, z, car.vx, car.vz, Math.round(48 * amount.current), 10, shell.color, 0.9);
      shellBurst(x, y, z, car.vx, car.vz, Math.round(12 * amount.current), 4, WHITE, 0.7);
      queue.splice(i, 1);
    }
  });

  return null;
}
