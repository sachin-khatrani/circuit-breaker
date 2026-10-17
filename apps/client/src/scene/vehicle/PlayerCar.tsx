import { clamp, damp, smoothstep } from '@circuit-breaker/shared';
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { Color, SpotLight, Vector3, type Group } from 'three';
import { PALETTE } from '../../game/palette';
import { session } from '../../game/session';
import { DriftMarks } from '../fx/driftMarks';
import { particles } from '../fx/particlePool';
import { LightTrail } from '../fx/trail';
import { buildCarModel, EXHAUSTS, HULL_RIM } from './carModel';

const BOOST_COLOR = new Color(PALETTE.magenta);
/** Overdrive burns white-gold: brighter and hotter than a boost's magenta. */
const OVERDRIVE_COLOR = new Color('#fff07a');
const SPARK_COLORS = [new Color('#7fe9ff'), new Color('#ffb02e'), new Color('#ff5be0')];
const MARK_COLORS = SPARK_COLORS.map((c) => c.clone().multiplyScalar(1.6));
const WALL_SPARK = new Color('#ffd27a').multiplyScalar(3);
const CELL_BURST = new Color(PALETTE.lime).multiplyScalar(3);
const REBOOT_RING = new Color(PALETTE.cyan).multiplyScalar(2.5);
const BOOST_BURST = new Color(PALETTE.magenta).multiplyScalar(3);
const OVERDRIVE_BURST = OVERDRIVE_COLOR.clone().multiplyScalar(3);
const PAD_BURST = new Color(PALETTE.cyan).multiplyScalar(3);
const SPUTTER = new Color(PALETTE.red).multiplyScalar(1.6);
const MAX_WHEEL_ANGLE = 0.42;
/** Rear contact patches (x, z) in car space, for drift sparks and tyre marks. */
const REAR_CONTACTS: readonly [number, number][] = [
  [-0.98, -1.38],
  [0.98, -1.38],
];

/**
 * The local car: transforms from the interpolated session state plus all its effects. Online it
 * wears the player's seat colour; the headlight and fill light are what set it apart.
 */
export function PlayerCar({ color = PALETTE.cyan, style = 0 }: { color?: string; style?: number }) {
  const model = useMemo(() => buildCarModel(color, style), [color, style]);
  const trails = useMemo(() => EXHAUSTS.map(() => new LightTrail(new Color(color))), [color]);
  // A wide magenta streak from the tail that only shows while a boost runs, then fades.
  const streak = useMemo(() => new LightTrail(new Color(PALETTE.magenta)), []);
  const marks = useMemo(() => new DriftMarks(), []);
  const headlight = useMemo(() => {
    const light = new SpotLight('#d6f3ff', 160, 75, 0.42, 0.6, 1.3);
    light.position.set(0, 0.75, 2.1);
    light.target.position.set(0, -1.5, 24);
    return light;
  }, []);
  const group = useRef<Group>(null);
  const visual = useRef({
    roll: 0,
    pitch: 0,
    airPitch: 0,
    accel: 0,
    lastSpeed: 0,
    emit: 0,
    wheelAngle: 0,
    wheelSpin: 0,
    wasBoosting: false,
    trailFlash: 0,
    /** Smoothed boost presence, for the underglow and the streak. */
    boostGlow: 0,
  });
  const scratch = useMemo(
    () => ({
      point: new Vector3(),
      color: new Color(),
      trailColor: new Color(),
      accent: new Color(color),
    }),
    [color],
  );

  useEffect(
    () => () => {
      model.dispose();
      marks.dispose();
      headlight.dispose();
      streak.dispose();
      for (const trail of trails) trail.dispose();
    },
    [model, marks, headlight, trails, streak],
  );

  // Event-driven bursts: wall sparks, Energy pickups, mini-turbos, launch and reboot.
  useEffect(() => {
    const exhaustBurst = (count: number, color: Color, speed: number) => {
      const car = session.render;
      const sin = Math.sin(car.yaw);
      const cos = Math.cos(car.yaw);
      for (const [nx, ny, nz] of EXHAUSTS) {
        const x = car.x + nx * -cos + nz * sin;
        const z = car.z + nx * sin + nz * cos;
        particles.burst(x, car.y + ny, z, count, speed, color, 0.4, 0.45);
      }
    };
    const off = session.onEvent((event) => {
      const car = session.render;
      switch (event.type) {
        case 'wallHit':
          particles.burst(
            event.x,
            event.y + 0.8,
            event.z,
            Math.min(36, 8 + event.impact * 2),
            9,
            WALL_SPARK,
            0.22,
            0.5,
          );
          break;
        case 'cell': {
          const cell = session.track.cells[event.cellId];
          particles.burst(cell.x, cell.y, cell.z, 26, 7, CELL_BURST, 0.5, 0.7);
          break;
        }
        case 'driftEnd':
          if (event.tier > 0) {
            exhaustBurst(18, scratch.color.copy(SPARK_COLORS[event.tier]).multiplyScalar(3), 6);
          }
          break;
        case 'launchBoost':
          exhaustBurst(18, scratch.color.copy(SPARK_COLORS[2]).multiplyScalar(3), 6);
          break;
        case 'boostPad':
          // A ring of light off the pad under the car, and the trails flare.
          visual.current.trailFlash = 1;
          for (let k = 0; k < 28; k++) {
            const a = (k / 28) * Math.PI * 2;
            particles.emit(
              car.x,
              car.y + 0.25,
              car.z,
              Math.cos(a) * 7 + car.vx * 0.5,
              0.8,
              Math.sin(a) * 7 + car.vz * 0.5,
              0.45,
              k % 2 === 0 ? PAD_BURST : BOOST_BURST,
              0.4,
              2.5,
              0,
            );
          }
          break;
        case 'boostDenied':
          // Not enough Energy: the exhausts sputter instead of igniting.
          exhaustBurst(5, SPUTTER, 2.5);
          break;
        case 'respawn':
          for (const trail of trails) trail.clear();
          streak.clear();
          marks.lift(0);
          marks.lift(1);
          for (let k = 0; k < 36; k++) {
            const a = (k / 36) * Math.PI * 2;
            particles.emit(
              car.x,
              car.y + 0.6,
              car.z,
              Math.cos(a) * 9,
              1.5,
              Math.sin(a) * 9,
              0.7,
              REBOOT_RING,
              0.5,
              2.5,
              0,
            );
          }
          break;
        default:
          break;
      }
    });
    return () => {
      off();
    };
  }, [scratch, trails, marks, streak]);

  useFrame(({ camera, clock }, delta) => {
    const g = group.current;
    if (!g) return;
    const car = session.render;
    const dt = Math.min(delta, 0.05);
    const v = visual.current;
    const t = clock.elapsedTime;
    marks.time = t;
    const airborne = car.surface === 'air';

    // Root follows the road plane (slope, bank); the body adds suspension pitch and roll.
    const sin = Math.sin(car.yaw);
    const cos = Math.cos(car.yaw);
    const align = sin * car.trackFx + cos * car.trackFz;
    const onRoad = car.surface === 'road';
    const surfacePitch = onRoad ? -Math.asin(clamp(car.slope * align, -1, 1)) : 0;
    const surfaceRoll = onRoad ? car.bank * align : 0;
    v.airPitch = damp(v.airPitch, airborne ? clamp(-car.vy * 0.03, 0, 0.45) : 0, 4, dt);
    g.position.set(car.x, car.y, car.z);
    g.rotation.set(surfacePitch + v.airPitch, car.yaw, surfaceRoll, 'YXZ');

    const accel = (car.forwardSpeed - v.lastSpeed) / Math.max(dt, 1e-3);
    v.lastSpeed = car.forwardSpeed;
    v.accel = damp(v.accel, clamp(accel, -60, 40), 6, dt);
    // Body rolls away from the turn and squats or dives with acceleration.
    const roll = clamp(car.yawRate * 0.05 * Math.min(1, car.speed / 20), -0.07, 0.07);
    v.roll = damp(v.roll, airborne ? 0 : roll, 7, dt);
    v.pitch = damp(v.pitch, airborne ? 0 : clamp(-v.accel * 0.0016, -0.05, 0.06), 6, dt);
    model.body.rotation.set(v.pitch, 0, v.roll);
    g.visible = !car.frozen || Math.floor(t * 18) % 2 === 0;
    g.updateMatrixWorld();

    // Wheels: roll with ground speed, front wheels steer (counter-steer while drifting).
    v.wheelSpin += (car.forwardSpeed / 0.38) * dt;
    const steerScale = 1 - 0.6 * clamp(car.speed / 72, 0, 1);
    const targetAngle = car.drifting
      ? -car.driftDir * 0.3 + car.steer * 0.12
      : car.steer * MAX_WHEEL_ANGLE * steerScale;
    v.wheelAngle = damp(v.wheelAngle, targetAngle, 14, dt);
    for (const wheel of model.wheels) {
      wheel.spin.rotation.x = (v.wheelSpin * 0.38) / wheel.radius;
      if (wheel.front) wheel.pivot.rotation.y = -v.wheelAngle;
    }
    // Rim markers read the rotation up to ~70 km/h; above that, where per-frame rotation would
    // alias into a stutter or a backwards spin, a motion-blur ring takes over.
    const rimSpeed = Math.abs(car.forwardSpeed);
    // The blur disc is additive, so the markers fade out fully rather than show through it.
    const markers = 1 - smoothstep(12, 24, rimSpeed);
    model.markerMaterial.color.setRGB(1, 1, 1).multiplyScalar(3 * markers);
    model.markerMaterial.visible = markers > 0;
    model.blurMaterial.opacity = smoothstep(8, 26, rimSpeed) * (airborne ? 0.4 : 0.9);

    // Lights: brake bar on braking, reverse lamps when backing up, tail glow otherwise.
    const braking = car.brake > 0.05 && car.forwardSpeed > 0.5;
    const reversing = car.forwardSpeed < -0.5;
    model.brakeMaterial.color.setRGB(1, 0.17, 0.31).multiplyScalar(braking ? 7 : 1.8);
    model.reverseMaterial.color.setRGB(1, 1, 1).multiplyScalar(reversing ? 5 : 0.25);

    // Exhausts: idle glow, throttle, boost, pad and free-impulse states.
    const boosted = car.boosting || car.overdrive || car.padBoost;
    const thrust = boosted ? 1 : car.impulse ? 0.85 : car.throttle * 0.5;
    const boostMix = car.boosting || car.overdrive ? 1 : car.padBoost ? 0.9 : car.impulse ? 0.6 : 0;
    const hot = car.overdrive ? OVERDRIVE_COLOR : BOOST_COLOR;
    v.boostGlow = damp(v.boostGlow, boosted ? 1 : 0, boosted ? 14 : 2.5, dt);
    scratch.color
      .copy(scratch.accent)
      .lerp(hot, boostMix)
      .multiplyScalar(2 + thrust * 4 + v.boostGlow * 3);
    model.thrusterMaterial.color.copy(scratch.color);
    model.flameMaterial.color.copy(scratch.color).multiplyScalar(0.6);
    const flicker = 0.85 + Math.sin(t * 61) * 0.08 + Math.sin(t * 37) * 0.07;
    for (const flame of model.flames) {
      const length = (0.2 + thrust * 2.2 + v.boostGlow * 1.3) * flicker;
      flame.scale.set(0.9 + thrust * 0.5, length, 0.9 + thrust * 0.5);
      flame.visible = thrust > 0.04;
    }
    model.rimMaterial.color
      .copy(scratch.accent)
      .lerp(hot, boostMix * 0.7)
      .multiplyScalar(3 + thrust);
    // The body's rim light flares with a boost, a little more in Overdrive.
    model.hullRim.value = HULL_RIM + v.boostGlow * (car.overdrive ? 0.7 : 0.4);
    // The underglow swells and turns magenta while a boost runs.
    model.underglow.visible = !airborne;
    model.underglow.scale.setScalar(1 + v.boostGlow * (car.overdrive ? 0.45 : 0.22));
    model.underglowMaterial.color
      .copy(scratch.accent)
      .lerp(hot, Math.max(boostMix * 0.6, v.boostGlow * 0.8))
      .multiplyScalar(1.1 + Math.sin(t * 4) * 0.12 + thrust * 0.5 + v.boostGlow * 1.4);

    // Boost ignition: a burst from the exhausts and a flash along the trails.
    const burning = car.boosting || car.overdrive;
    if (burning && !v.wasBoosting) {
      v.trailFlash = 1;
      for (const [nx, ny, nz] of EXHAUSTS) {
        scratch.point.set(nx, ny, nz - 0.2).applyMatrix4(g.matrixWorld);
        particles.burst(
          scratch.point.x,
          scratch.point.y,
          scratch.point.z,
          car.overdrive ? 30 : 22,
          car.overdrive ? 10 : 8,
          car.overdrive ? OVERDRIVE_BURST : BOOST_BURST,
          0.35,
          0.4,
        );
      }
    }
    v.wasBoosting = burning;
    v.trailFlash = Math.max(0, v.trailFlash - dt * 3);

    // Energy trails from both exhausts; brighter and wider while boosting.
    const speedFactor = clamp((car.speed - 8) / 50, 0, 1);
    scratch.trailColor
      .copy(scratch.accent)
      .lerp(hot, boostMix)
      .multiplyScalar(1.25 + boostMix * 1.8 + v.trailFlash * 2);
    trails.forEach((trail, i) => {
      const [nx, ny, nz] = EXHAUSTS[i];
      scratch.point.set(nx, ny, nz - 0.2).applyMatrix4(g.matrixWorld);
      trail.color.copy(scratch.trailColor);
      trail.update(
        scratch.point,
        camera.position,
        dt,
        0.26 + boostMix * 0.2 + v.trailFlash * 0.15,
        car.frozen ? 0 : speedFactor,
      );
    });
    // The boost streak: a wide ribbon from the middle of the tail, only while boosting.
    scratch.point.set(0, EXHAUSTS[0][1], EXHAUSTS[0][2] - 0.3).applyMatrix4(g.matrixWorld);
    streak.color.copy(hot).multiplyScalar(1.6 + v.trailFlash * 1.5);
    streak.update(
      scratch.point,
      camera.position,
      dt,
      (car.overdrive ? 1.5 : 0.95) + v.trailFlash * 0.35,
      car.frozen ? 0 : v.boostGlow * speedFactor * (car.overdrive ? 1.1 : 0.8),
    );

    // Drift: glowing tyre marks and sparks from both rear contact patches.
    const tier = car.driftTicks >= 120 ? 2 : car.driftTicks >= 54 ? 1 : 0;
    REAR_CONTACTS.forEach(([cx, cz], i) => {
      if (car.drifting && onRoad && car.speed > 15) {
        scratch.point.set(cx, 0, cz).applyMatrix4(g.matrixWorld);
        marks.add(i, scratch.point, 0.3, MARK_COLORS[tier], t);
      } else {
        marks.lift(i);
      }
    });

    v.emit += dt;
    const interval = 1 / 90;
    while (v.emit > interval) {
      v.emit -= interval;
      if (car.drifting && car.speed > 15) {
        const color = scratch.color.copy(SPARK_COLORS[tier]).multiplyScalar(2.5);
        for (const [cx, cz] of REAR_CONTACTS) {
          scratch.point.set(cx * 1.1, 0.12, cz).applyMatrix4(g.matrixWorld);
          particles.emit(
            scratch.point.x,
            scratch.point.y,
            scratch.point.z,
            -sin * car.speed * 0.15 + (Math.random() - 0.5) * 5,
            1.5 + Math.random() * 3,
            -cos * car.speed * 0.15 + (Math.random() - 0.5) * 5,
            0.25 + Math.random() * 0.25,
            color,
            0.16 + Math.random() * 0.1,
            2,
            -14,
          );
        }
      }
      if (car.boosting || car.overdrive) {
        const [nx, ny, nz] = EXHAUSTS[Math.random() < 0.5 ? 0 : 1];
        scratch.point.set(nx, ny, nz - 0.3).applyMatrix4(g.matrixWorld);
        particles.emit(
          scratch.point.x,
          scratch.point.y,
          scratch.point.z,
          car.vx * 0.6 + (Math.random() - 0.5) * 3,
          (Math.random() - 0.3) * 2,
          car.vz * 0.6 + (Math.random() - 0.5) * 3,
          0.35,
          car.overdrive ? OVERDRIVE_BURST : BOOST_BURST,
          0.3,
          3,
          0,
        );
      }
    }
  }, -2);

  return (
    <>
      <group ref={group}>
        <primitive object={model.root} />
        <primitive object={headlight} />
        <primitive object={headlight.target} />
        {/* Car-borne fill light: lifts the body out of the dark and pools on the road. */}
        <pointLight
          position={[0, 3.2, -0.5]}
          color={color}
          intensity={18}
          distance={14}
          decay={1.6}
        />
      </group>
      <primitive object={marks.mesh} />
      {trails.map((trail, i) => (
        <primitive key={i} object={trail.mesh} />
      ))}
      <primitive object={streak.mesh} />
    </>
  );
}
