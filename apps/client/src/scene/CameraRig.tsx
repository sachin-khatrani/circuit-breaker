import {
  clamp,
  createProjection,
  damp,
  dampAngle,
  lerp,
  lerpAngle,
  smoothstep,
} from '@circuit-breaker/shared';
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { FogExp2, PerspectiveCamera, Vector3 } from 'three';
import { session, type CameraMode } from '../game/session';
import { useGameStore } from '../game/store';

const SHOT_SECONDS = 6.5;
const ATTRACT_SHOTS = 5;
/** The camera keeps this far inside a walled road edge (the barrier sits 0.35 m outside it). */
const WALL_CLEARANCE = 0.1;
const ROOF_CLEARANCE = 1.1;
/** Seconds the chase camera takes to settle after a respawn cut. */
const SETTLE_SECONDS = 0.7;
/** Seconds from the chase view into the finish orbit. */
const FINISH_BLEND_SECONDS = 1.2;

interface RigState {
  yaw: number;
  fov: number;
  trauma: number;
  roll: number;
  accel: number;
  lastSpeed: number;
  boostPull: number;
  snap: boolean;
  mode: CameraMode | null;
  modeStart: number;
  shot: number;
  shotStart: number;
  side: number;
  /** Time of the last respawn cut (the camera then settles in from further back). */
  settleStart: number;
  /** Brief FOV kick when Overdrive ignites, decaying to 0. */
  kick: number;
}

/**
 * All camera work. The chase camera is rigid in translation and smoothed in rotation, so it
 * never drops behind the car at 300+ km/h; speed reads through FOV and distance. It never
 * leaves the road corridor where there are walls, stays under tunnel roofs and above the
 * road, and honours the reduced-motion preference.
 */
export function CameraRig() {
  const camera = useThree((s) => s.camera);
  const scene = useThree((s) => s.scene);
  const fogDensity = useRef<number | null>(null);
  const reducedMotion = useGameStore((s) => s.reducedMotion);
  const motion = useRef(reducedMotion ? 0 : 1);
  useEffect(() => {
    motion.current = reducedMotion ? 0 : 1;
  }, [reducedMotion]);

  const rig = useRef<RigState>({
    yaw: 0,
    fov: 64,
    trauma: 0,
    roll: 0,
    accel: 0,
    lastSpeed: 0,
    boostPull: 0,
    snap: true,
    mode: null,
    modeStart: 0,
    shot: 0,
    shotStart: -100,
    side: 1,
    settleStart: -100,
    kick: 0,
  });
  const v = useMemo(
    () => ({
      pos: new Vector3(),
      look: new Vector3(),
      chasePos: new Vector3(),
      chaseLook: new Vector3(),
      anchor: new Vector3(),
      car: new Vector3(),
      projection: createProjection(),
      frame: session.track.frameAt(0),
    }),
    [],
  );

  useEffect(() => {
    const off = session.onEvent((event) => {
      const r = rig.current;
      // Small, capped knocks only: the camera should feel physical, never jarring.
      if (event.type === 'wallHit') r.trauma = Math.min(0.5, r.trauma + event.impact / 45);
      else if (event.type === 'launchBoost') r.trauma = Math.min(0.5, r.trauma + 0.15);
      else if (event.type === 'driftEnd' && event.tier > 0) {
        r.trauma = Math.min(0.5, r.trauma + 0.06 * event.tier);
      } else if (event.type === 'respawn') {
        r.snap = true;
        r.settleStart = performance.now() / 1000;
      } else if (
        event.type === 'ability' &&
        event.ability === 'overdrive' &&
        event.racerId === session.playerId
      ) {
        r.kick = 1;
      }
    });
    return () => {
      off();
    };
  }, []);

  useFrame((state, delta) => {
    if (!(camera instanceof PerspectiveCamera)) return;
    const fog = scene.fog instanceof FogExp2 ? scene.fog : null;
    const debug = session.debugView;
    if (debug) {
      // Development view: a fixed camera. "Up" is +y, or -z when looking (nearly) straight down
      // so that view is still well defined.
      if (fog && debug.fog !== undefined) {
        fogDensity.current ??= fog.density;
        fog.density = debug.fog;
      }
      const run = Math.hypot(debug.lookX - debug.x, debug.lookZ - debug.z);
      const steep = Math.abs(debug.lookY - debug.y) > 20 * run;
      camera.up.set(0, steep ? 0 : 1, steep ? -1 : 0);
      camera.position.set(debug.x, debug.y, debug.z);
      camera.lookAt(debug.lookX, debug.lookY, debug.lookZ);
      if (camera.fov !== debug.fov) {
        camera.fov = debug.fov;
        camera.updateProjectionMatrix();
      }
      return;
    }
    if (fog && fogDensity.current !== null) {
      fog.density = fogDensity.current;
      fogDensity.current = null;
    }
    camera.up.set(0, 1, 0);
    const r = rig.current;
    const m = motion.current;
    const dt = Math.min(delta, 0.05);
    const t = state.clock.elapsedTime;
    const car = session.render;
    const mode = session.cameraMode;
    const fresh = r.mode !== mode;
    if (fresh) {
      r.mode = mode;
      r.modeStart = t;
      r.shotStart = -100;
    }
    v.car.set(car.x, car.y, car.z);

    // Shared chase basis: heading blended toward the velocity so drifts show the slide.
    const speedN = clamp(car.speed / 72, 0, 1.3);
    // Only while moving forward: reversing must not swing the camera round to the side.
    const velYaw = car.forwardSpeed > 4 ? Math.atan2(car.vx, car.vz) : car.yaw;
    const targetYaw = lerpAngle(car.yaw, velYaw, 0.5);
    r.yaw = fresh || r.snap ? targetYaw : dampAngle(r.yaw, targetYaw, 6.5, dt);
    r.snap = false;
    const accel = (car.forwardSpeed - r.lastSpeed) / Math.max(dt, 1e-3);
    r.lastSpeed = car.forwardSpeed;
    r.accel = damp(r.accel, clamp(accel, -60, 40), 3, dt);
    r.boostPull = damp(
      r.boostPull,
      car.overdrive ? 1.25 : car.boosting ? 1 : car.padBoost ? 0.8 : car.impulse ? 0.5 : 0,
      3.5,
      dt,
    );
    const fx = Math.sin(r.yaw);
    const fz = Math.cos(r.yaw);
    // After a respawn cut, dolly in from a little further back and higher: a settle, not a jump.
    const settle =
      1 - smoothstep(0, 1, (performance.now() / 1000 - r.settleStart) / SETTLE_SECONDS);
    r.kick = Math.max(0, r.kick - dt * 2.2);
    // Distance: a touch more at speed, a slight pull-back on boost, squat and dive with accel.
    const dist =
      7.4 +
      speedN * 1.2 +
      r.boostPull * 1.4 +
      clamp(r.accel * 0.02, -0.6, 0.7) * (0.5 + m * 0.5) +
      settle * 3.5;
    const height = 2.5 + speedN * 0.3 + r.boostPull * 0.15 + settle * 1.6;
    const lookAhead = 5 + car.speed * 0.05;
    v.chasePos.set(car.x - fx * dist, car.y + height, car.z - fz * dist);
    v.chaseLook.set(car.x + fx * lookAhead, car.y + 1.2, car.z + fz * lookAhead);
    // FOV reacts subtly: a few degrees with speed, a few more on boost (less with reduced motion).
    const speedFov = 11 * Math.pow(Math.min(1, speedN), 1.3);
    // Overdrive: a stronger but brief punch on top of the boost widening.
    const boostFov = 5 * r.boostPull + 7 * r.kick * r.kick;
    let fov = 64 + (speedFov + boostFov) * (0.35 + 0.65 * m);
    let rollTarget = clamp(car.yawRate * 0.025, -0.05, 0.05) * m;

    const hx = Math.sin(car.yaw);
    const hz = Math.cos(car.yaw);
    const rx = -hz;
    const rz = hx;
    let cut = fresh;
    switch (mode) {
      case 'chase':
        v.pos.copy(v.chasePos);
        v.look.copy(v.chaseLook);
        break;
      case 'intro': {
        // Sweep from a low front-quarter view round to the chase position before "3".
        const sim = session.sim;
        const introTicks = Math.max(1, sim.goTick - 180);
        const e = smoothstep(0, 1, Math.min(1, (sim.tick + session.alpha) / introTicks));
        const theta = lerp(0.5, Math.PI, e);
        const radius = lerp(8.5, dist, e);
        const h = lerp(1.2, height, e);
        v.pos.set(
          car.x + (hx * Math.cos(theta) + rx * Math.sin(theta)) * radius,
          car.y + h,
          car.z + (hz * Math.cos(theta) + rz * Math.sin(theta)) * radius,
        );
        v.look.set(car.x, car.y + 0.9, car.z).lerp(v.chaseLook, e);
        fov = lerp(48, 64, e);
        rollTarget = 0;
        break;
      }
      case 'finish': {
        const age = t - r.modeStart;
        const theta = Math.PI + age * 0.3;
        const radius = 11;
        v.pos.set(
          car.x + (hx * Math.cos(theta) + rx * Math.sin(theta)) * radius,
          car.y + 3.4,
          car.z + (hz * Math.cos(theta) + rz * Math.sin(theta)) * radius,
        );
        v.look.set(car.x, car.y + 1, car.z);
        // Glide from the chase view into the orbit instead of cutting.
        const blend = smoothstep(0, 1, age / FINISH_BLEND_SECONDS);
        if (blend < 1) {
          v.pos.lerpVectors(v.chasePos, v.pos, blend);
          v.look.lerpVectors(v.chaseLook, v.look, blend);
        }
        fov = 58;
        rollTarget = 0;
        break;
      }
      case 'attract': {
        const shotAge = t - r.shotStart;
        const passed =
          r.shot === 1 && (v.car.x - v.anchor.x) * hx + (v.car.z - v.anchor.z) * hz > 35;
        if (shotAge > SHOT_SECONDS || passed) {
          cut = true;
          r.shot = r.shotStart < 0 ? 0 : (r.shot + 1) % ATTRACT_SHOTS;
          r.shotStart = t;
          r.side = -r.side;
          // Trackside shot: stand well outside and above the barrier, ahead of the car.
          const f = session.track.frameAt(car.trackS + 120, v.frame);
          const lat = r.side * (f.halfWidth + 10);
          v.anchor.set(f.x + f.rx * lat, f.y - lat * Math.tan(f.bank) + 5.5, f.z + f.rz * lat);
        }
        rollTarget = 0;
        switch (r.shot) {
          case 0: {
            const theta = t * 0.22;
            v.pos.set(car.x + Math.sin(theta) * 13, car.y + 4.2, car.z + Math.cos(theta) * 13);
            v.look.set(car.x, car.y + 1, car.z);
            fov = 55;
            break;
          }
          case 1:
            v.pos.copy(v.anchor);
            v.look.set(car.x, car.y + 0.8, car.z);
            fov = 40;
            break;
          case 2:
            // Low rear three-quarter: wide lens, road rushing past.
            v.pos.set(car.x - fx * 6.5 + rx * 2.6, car.y + 1.5, car.z - fz * 6.5 + rz * 2.6);
            v.look.set(car.x + fx * 18, car.y + 1.0, car.z + fz * 18);
            fov = 72;
            break;
          case 3:
            v.pos.set(car.x - fx * 28 + rx * 9, car.y + 15, car.z - fz * 28 + rz * 9);
            v.look.set(car.x + fx * 22, car.y, car.z + fz * 22);
            fov = 55;
            break;
          default:
            v.pos.set(car.x + hx * 11 - rx * 2.5, car.y + 1.6, car.z + hz * 11 - rz * 2.5);
            v.look.set(car.x, car.y + 0.7, car.z);
            fov = 48;
            break;
        }
        break;
      }
    }

    // Never clip through the track: stay inside walled edges and tunnel walls, under the
    // tunnel roof, and above the road surface.
    const track = session.track.road(session.racer.vehicle.road);
    const p = track.project(v.pos.x, v.pos.z, session.racer.vehicle.trackIndex, v.projection);
    const followingCar = mode === 'chase' || mode === 'intro';
    if (followingCar && car.surface === 'road') {
      const limit = p.halfWidth - WALL_CLEARANCE;
      // Across an opening into the shortcut there is no wall to keep the camera off.
      const opening = track.portalAt(p.index, p.lateral) >= 0;
      if (Math.abs(p.lateral) > limit && track.hasWall(p.index, p.lateral) && !opening) {
        const push = Math.abs(p.lateral) - limit;
        const sign = Math.sign(p.lateral);
        v.pos.x -= p.rx * sign * push;
        v.pos.z -= p.rz * sign * push;
      }
      const roof = track.roof[p.index];
      if (roof > 0) {
        const ceiling = track.py[p.index] + roof - ROOF_CLEARANCE;
        if (v.pos.y > ceiling) v.pos.y = ceiling;
      }
    }
    const overRoad = Math.abs(p.lateral) < p.halfWidth + 3;
    const floor = overRoad && car.surface === 'road' ? p.height + 0.7 : 0.4;
    if (v.pos.y < floor) v.pos.y = floor;

    // Trauma-based shake: squared and small, off entirely with reduced motion.
    r.trauma = Math.max(0, r.trauma - dt * 1.8);
    const shake = r.trauma * r.trauma * m;
    if (shake > 0) {
      v.pos.x += (Math.sin(t * 47.3) + Math.sin(t * 23.1) * 0.5) * shake * 0.18;
      v.pos.y += (Math.sin(t * 53.7) + Math.sin(t * 31.9) * 0.5) * shake * 0.14;
      v.pos.z += (Math.sin(t * 41.9) + Math.sin(t * 19.3) * 0.5) * shake * 0.18;
    }

    camera.position.copy(v.pos);
    camera.lookAt(v.look);
    r.roll = damp(r.roll, rollTarget, 5, dt);
    camera.rotateZ(r.roll);
    r.fov = cut && mode === 'attract' ? fov : damp(r.fov, fov, 4, dt);
    if (Math.abs(camera.fov - r.fov) > 0.01) {
      camera.fov = r.fov;
      camera.updateProjectionMatrix();
    }
  }, -1);

  return null;
}
