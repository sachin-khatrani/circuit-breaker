import {
  clamp,
  createProjection,
  damp,
  FLAG_AIR,
  FLAG_BOOSTING,
  FLAG_BRAKING,
  FLAG_DRIFT_RIGHT,
  FLAG_DRIFTING,
  FLAG_FROZEN,
  FLAG_GROUND,
  FLAG_IMPULSE,
  FLAG_OFFLINE,
  FLAG_OVERDRIVE,
  FLAG_PAD,
  PLAYER_COLORS,
  smoothstep,
  type RaceEvent,
  type TrackProjection,
} from '@circuit-breaker/shared';
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import {
  CanvasTexture,
  Color,
  Group,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  Vector3,
} from 'three';
import type { RemoteCar } from '../../game/online';
import { PALETTE } from '../../game/palette';
import { session } from '../../game/session';
import { useGameStore } from '../../game/store';
import { particles } from '../fx/particlePool';
import { LightTrail } from '../fx/trail';
import { buildCarModel, EXHAUSTS, type CarModel } from './carModel';

const BOOST_COLOR = new Color(PALETTE.magenta);
const OVERDRIVE_COLOR = new Color('#fff07a');
const BOOST_BURST = new Color(PALETTE.magenta).multiplyScalar(3);
const PAD_BURST = new Color(PALETTE.cyan).multiplyScalar(3);
const SPARK_COLORS = [new Color('#7fe9ff'), new Color('#ffb02e'), new Color('#ff5be0')];
const WALL_SPARK = new Color('#ffd27a').multiplyScalar(3);
const CELL_BURST = new Color(PALETTE.lime).multiplyScalar(3);
const REBOOT_RING = new Color(PALETTE.cyan).multiplyScalar(2.5);
const MAX_WHEEL_ANGLE = 0.42;
/** Name tags: constant on-screen size, faded out with distance so far cars do not clutter. */
const TAG_HEIGHT = 2.35;
const TAG_SCALE = 0.042;
const TAG_FADE_START = 90;
const TAG_FADE_END = 170;
/** Tags shrink to this fraction of their size between these distances (m). */
const TAG_FAR_SCALE = 0.6;
const TAG_SHRINK_START = 25;
const TAG_SHRINK_END = 120;
/**
 * Cars are ghosts (no contact), and they look it up close: a car within these distances (m) of
 * the local car fades down to GHOST_OPACITY instead of showing two solid cars in one place.
 */
const GHOST_NEAR = 3.5;
const GHOST_FAR = 8;
const GHOST_OPACITY = 0.3;

interface Rig {
  car: RemoteCar;
  model: CarModel;
  group: Group;
  trails: LightTrail[];
  tag: Sprite;
  tagMaterial: SpriteMaterial;
  tagTexture: CanvasTexture;
  tagCanvas: HTMLCanvasElement;
  accent: Color;
  projection: TrackProjection;
  offline: boolean;
  opacity: number;
  roll: number;
  pitch: number;
  airPitch: number;
  accel: number;
  lastSpeed: number;
  wheelSpin: number;
  wheelAngle: number;
  boostGlow: number;
  trailFlash: number;
  emit: number;
}

function drawTag(canvas: HTMLCanvasElement, name: string, color: string, offline: boolean): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.font = '700 34px Rajdhani, "Arial Narrow", sans-serif';
  const label = offline ? `${name} · offline` : name;
  const text = Math.min(w - 40, ctx.measureText(label).width);
  const boxW = text + 34;
  const x0 = (w - boxW) / 2;
  ctx.fillStyle = 'rgba(7, 9, 24, 0.72)';
  ctx.beginPath();
  ctx.moveTo(x0 + 8, 6);
  ctx.lineTo(x0 + boxW, 6);
  ctx.lineTo(x0 + boxW, h - 14);
  ctx.lineTo(x0 + boxW - 8, h - 6);
  ctx.lineTo(x0, h - 6);
  ctx.lineTo(x0, 14);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = color;
  ctx.fillRect(x0, 6, 6, h - 12);
  ctx.globalAlpha = offline ? 0.55 : 1;
  ctx.fillStyle = '#f2fbff';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(label, x0 + 18, h / 2 + 1, w - 40);
  ctx.globalAlpha = 1;
}

function buildRig(car: RemoteCar): Rig {
  const hex = PLAYER_COLORS[car.color] ?? PLAYER_COLORS[0];
  const model = buildCarModel(hex, car.style);
  // Drawn in the transparent pass from the start (at full opacity it looks the same), so the
  // ghost fade never has to switch shader variants mid-race.
  for (const material of model.solidMaterials) material.transparent = true;
  const group = new Group();
  group.add(model.root);
  group.visible = false;
  const accent = new Color(hex);
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  drawTag(canvas, car.name, hex, false);
  const tagTexture = new CanvasTexture(canvas);
  tagTexture.colorSpace = SRGBColorSpace;
  const tagMaterial = new SpriteMaterial({
    map: tagTexture,
    sizeAttenuation: false,
    depthWrite: false,
    transparent: true,
  });
  const tag = new Sprite(tagMaterial);
  tag.center.set(0.5, 0);
  tag.scale.set(TAG_SCALE * 4, TAG_SCALE, 1);
  tag.renderOrder = 6;
  tag.visible = false;
  return {
    car,
    model,
    group,
    trails: EXHAUSTS.map(() => new LightTrail(accent.clone())),
    tag,
    tagMaterial,
    tagTexture,
    tagCanvas: canvas,
    accent,
    projection: createProjection(),
    offline: false,
    opacity: 1,
    roll: 0,
    pitch: 0,
    airPitch: 0,
    accel: 0,
    lastSpeed: 0,
    wheelSpin: 0,
    wheelAngle: 0,
    boostGlow: 0,
    trailFlash: 0,
    emit: 0,
  };
}

const scratch = {
  point: new Vector3(),
  color: new Color(),
  trail: new Color(),
};

/**
 * The other players' cars, drawn from the server's snapshots (interpolated a little in the
 * past). Same model as the local car in each player's colour, with wheels, lights, exhaust
 * flames, underglow and trails driven by the snapshot flags. They are ghosts: no contact.
 * Cheaper than the local car: no spotlight or point light, two trails, sparks thinned out.
 */
export function RemoteCars() {
  const raceSerial = useGameStore((s) => s.raceSerial);
  // A new race brings a new field.
  const rigs = useMemo(() => {
    void raceSerial;
    return session.remotes.map(buildRig);
  }, [raceSerial]);

  useEffect(
    () => () => {
      for (const rig of rigs) {
        rig.model.dispose();
        for (const trail of rig.trails) trail.dispose();
        rig.tagMaterial.dispose();
        rig.tagTexture.dispose();
      }
    },
    [rigs],
  );

  // Their visible moments, timed to where each car is drawn.
  useEffect(() => {
    const byId = new Map(rigs.map((rig) => [rig.car.id, rig]));
    const exhaustBurst = (rig: Rig, count: number, color: Color, speed: number) => {
      for (const [nx, ny, nz] of EXHAUSTS) {
        scratch.point.set(nx, ny, nz - 0.2).applyMatrix4(rig.group.matrixWorld);
        particles.burst(
          scratch.point.x,
          scratch.point.y,
          scratch.point.z,
          count,
          speed,
          color,
          0.35,
          0.4,
        );
      }
    };
    const off = session.onRemoteEvent((event: RaceEvent) => {
      if (!('racerId' in event)) return;
      const rig = byId.get(event.racerId);
      if (!rig || !rig.group.visible) return;
      const s = rig.car.sample;
      switch (event.type) {
        case 'boost':
        case 'launchBoost':
          rig.trailFlash = 1;
          exhaustBurst(rig, 12, BOOST_BURST, 7);
          break;
        case 'boostPad':
          rig.trailFlash = 1;
          for (let k = 0; k < 16; k++) {
            const a = (k / 16) * Math.PI * 2;
            particles.emit(
              s.x,
              s.y + 0.25,
              s.z,
              Math.cos(a) * 7 + s.vx * 0.5,
              0.8,
              Math.sin(a) * 7 + s.vz * 0.5,
              0.4,
              k % 2 === 0 ? PAD_BURST : BOOST_BURST,
              0.4,
              2.5,
              0,
            );
          }
          break;
        case 'driftEnd':
          if (event.tier > 0)
            exhaustBurst(
              rig,
              10,
              scratch.color.copy(SPARK_COLORS[event.tier]).multiplyScalar(3),
              6,
            );
          break;
        case 'wallHit':
          particles.burst(
            event.x,
            event.y + 0.8,
            event.z,
            Math.min(24, 6 + event.impact),
            9,
            WALL_SPARK,
            0.22,
            0.5,
          );
          break;
        case 'cell': {
          const cell = session.track.cells[event.cellId];
          if (cell) particles.burst(cell.x, cell.y, cell.z, 16, 7, CELL_BURST, 0.5, 0.7);
          break;
        }
        case 'respawn':
          for (const trail of rig.trails) trail.clear();
          for (let k = 0; k < 20; k++) {
            const a = (k / 20) * Math.PI * 2;
            particles.emit(
              s.x,
              s.y + 0.6,
              s.z,
              Math.cos(a) * 9,
              1.5,
              Math.sin(a) * 9,
              0.6,
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
  }, [rigs]);

  useFrame(({ camera, clock }, delta) => {
    const dt = Math.min(delta, 0.05);
    const t = clock.elapsedTime;
    const track = session.track;
    for (const rig of rigs) {
      const s = rig.car.sample;
      const g = rig.group;
      const flags = s.flags;
      const frozen = (flags & FLAG_FROZEN) !== 0;
      const shown = rig.car.visible;
      g.visible = shown && (!frozen || Math.floor(t * 18) % 2 === 0);
      rig.tag.visible = shown;
      if (!shown) {
        for (const trail of rig.trails) trail.clear();
        continue;
      }
      const offline = (flags & FLAG_OFFLINE) !== 0;
      if (offline !== rig.offline) {
        rig.offline = offline;
        drawTag(
          rig.tagCanvas,
          rig.car.name,
          PLAYER_COLORS[rig.car.color] ?? PLAYER_COLORS[0],
          offline,
        );
        rig.tagTexture.needsUpdate = true;
      }

      // Pose: on the road plane where the car is, like the local car.
      const airborne = (flags & FLAG_AIR) !== 0;
      const onRoad = (flags & (FLAG_AIR | FLAG_GROUND)) === 0;
      const road = track.road(s.road);
      const hint = Math.min(road.count - 1, Math.round(s.trackS / road.spacing) % road.count);
      const p = road.project(s.x, s.z, hint, rig.projection);
      const sin = Math.sin(s.yaw);
      const cos = Math.cos(s.yaw);
      const align = sin * p.fx + cos * p.fz;
      const surfacePitch = onRoad ? -Math.asin(clamp(p.slope * align, -1, 1)) : 0;
      const surfaceRoll = onRoad ? p.bank * align : 0;
      rig.airPitch = damp(rig.airPitch, airborne ? clamp(-s.vy * 0.03, 0, 0.45) : 0, 4, dt);
      g.position.set(s.x, s.y, s.z);
      g.rotation.set(surfacePitch + rig.airPitch, s.yaw, surfaceRoll, 'YXZ');
      const speed = Math.hypot(s.vx, s.vz);
      const forward = s.vx * sin + s.vz * cos;
      rig.accel = damp(
        rig.accel,
        clamp((forward - rig.lastSpeed) / Math.max(dt, 1e-3), -60, 40),
        6,
        dt,
      );
      rig.lastSpeed = forward;
      const roll = clamp(s.yawRate * 0.05 * Math.min(1, speed / 20), -0.07, 0.07);
      rig.roll = damp(rig.roll, airborne ? 0 : roll, 7, dt);
      rig.pitch = damp(rig.pitch, airborne ? 0 : clamp(-rig.accel * 0.0016, -0.05, 0.06), 6, dt);
      rig.model.body.rotation.set(rig.pitch, 0, rig.roll);
      g.updateMatrixWorld();

      // Wheels.
      const drifting = (flags & FLAG_DRIFTING) !== 0;
      const driftDir = (flags & FLAG_DRIFT_RIGHT) !== 0 ? 1 : -1;
      rig.wheelSpin += (forward / 0.38) * dt;
      const steerScale = 1 - 0.6 * clamp(speed / 72, 0, 1);
      const targetAngle = drifting
        ? -driftDir * 0.3 + s.steer * 0.12
        : s.steer * MAX_WHEEL_ANGLE * steerScale;
      rig.wheelAngle = damp(rig.wheelAngle, targetAngle, 14, dt);
      for (const wheel of rig.model.wheels) {
        wheel.spin.rotation.x = (rig.wheelSpin * 0.38) / wheel.radius;
        if (wheel.front) wheel.pivot.rotation.y = -rig.wheelAngle;
      }
      // Ghost fade near the local car.
      const me = session.render;
      const apart = Math.hypot(s.x - me.x, s.y - me.y, s.z - me.z);
      const opacity = 1 - (1 - GHOST_OPACITY) * smoothstep(GHOST_FAR, GHOST_NEAR, apart);
      if (Math.abs(opacity - rig.opacity) > 0.004) {
        rig.opacity = opacity;
        for (const material of rig.model.solidMaterials) material.opacity = opacity;
        rig.model.flameMaterial.opacity = opacity;
        rig.model.underglowMaterial.opacity = opacity;
        rig.model.shadowMaterial.opacity = 0.8 * opacity;
        rig.model.beamMaterial.uniforms.uIntensity.value = opacity;
      }

      const rim = Math.abs(forward);
      const markers = 1 - smoothstep(12, 24, rim);
      rig.model.markerMaterial.color.setRGB(1, 1, 1).multiplyScalar(3 * markers);
      rig.model.markerMaterial.visible = markers > 0;
      rig.model.blurMaterial.opacity =
        smoothstep(8, 26, rim) * (airborne ? 0.4 : 0.9) * rig.opacity;

      // Lights.
      const braking = (flags & FLAG_BRAKING) !== 0;
      rig.model.brakeMaterial.color.setRGB(1, 0.17, 0.31).multiplyScalar(braking ? 7 : 1.8);
      rig.model.reverseMaterial.color.setRGB(1, 1, 1).multiplyScalar(forward < -0.5 ? 5 : 0.25);

      // Exhausts, underglow and trails from the boost flags.
      const overdrive = (flags & FLAG_OVERDRIVE) !== 0;
      const boosting = (flags & FLAG_BOOSTING) !== 0 || overdrive;
      const hot = overdrive ? OVERDRIVE_COLOR : BOOST_COLOR;
      const pad = (flags & FLAG_PAD) !== 0;
      const impulse = (flags & FLAG_IMPULSE) !== 0;
      const boosted = boosting || pad;
      const thrust = boosted ? 1 : impulse ? 0.85 : s.throttle * 0.5;
      const boostMix = boosting ? 1 : pad ? 0.9 : impulse ? 0.6 : 0;
      rig.boostGlow = damp(rig.boostGlow, boosted ? 1 : 0, boosted ? 14 : 2.5, dt);
      scratch.color
        .copy(rig.accent)
        .lerp(hot, boostMix)
        .multiplyScalar(2 + thrust * 4 + rig.boostGlow * 3);
      rig.model.thrusterMaterial.color.copy(scratch.color);
      rig.model.flameMaterial.color.copy(scratch.color).multiplyScalar(0.6);
      const flicker = 0.85 + Math.sin(t * 61 + rig.car.color) * 0.08 + Math.sin(t * 37) * 0.07;
      for (const flame of rig.model.flames) {
        flame.scale.set(
          0.9 + thrust * 0.5,
          (0.2 + thrust * 2.2 + rig.boostGlow * 1.3) * flicker,
          0.9 + thrust * 0.5,
        );
        flame.visible = thrust > 0.04;
      }
      rig.model.rimMaterial.color
        .copy(rig.accent)
        .lerp(hot, boostMix * 0.7)
        .multiplyScalar(3 + thrust);
      rig.model.underglow.visible = !airborne;
      rig.model.underglow.scale.setScalar(1 + rig.boostGlow * (overdrive ? 0.45 : 0.22));
      rig.model.underglowMaterial.color
        .copy(rig.accent)
        .lerp(hot, Math.max(boostMix * 0.6, rig.boostGlow * 0.8))
        .multiplyScalar(1.1 + thrust * 0.5 + rig.boostGlow * 1.4);
      rig.trailFlash = Math.max(0, rig.trailFlash - dt * 3);
      const speedFactor = clamp((speed - 8) / 50, 0, 1);
      scratch.trail
        .copy(rig.accent)
        .lerp(hot, boostMix)
        .multiplyScalar(1.25 + boostMix * 1.8 + rig.trailFlash * 2);
      rig.trails.forEach((trail, i) => {
        const [nx, ny, nz] = EXHAUSTS[i];
        scratch.point.set(nx, ny, nz - 0.2).applyMatrix4(g.matrixWorld);
        trail.color.copy(scratch.trail);
        trail.update(
          scratch.point,
          camera.position,
          dt,
          0.26 + boostMix * 0.2 + rig.trailFlash * 0.15,
          frozen ? 0 : speedFactor,
        );
      });

      // Drift sparks (thinner than the local car's) and boost embers.
      rig.emit += dt;
      const interval = 1 / 30;
      while (rig.emit > interval) {
        rig.emit -= interval;
        if (drifting && speed > 15 && onRoad) {
          const tier = s.driftTicks >= 120 ? 2 : s.driftTicks >= 54 ? 1 : 0;
          scratch.color.copy(SPARK_COLORS[tier]).multiplyScalar(2.5);
          const side = Math.random() < 0.5 ? -1.08 : 1.08;
          scratch.point.set(side, 0.12, -1.38).applyMatrix4(g.matrixWorld);
          particles.emit(
            scratch.point.x,
            scratch.point.y,
            scratch.point.z,
            -sin * speed * 0.15 + (Math.random() - 0.5) * 5,
            1.5 + Math.random() * 3,
            -cos * speed * 0.15 + (Math.random() - 0.5) * 5,
            0.3,
            scratch.color,
            0.16,
            2,
            -14,
          );
        }
        if (boosting) {
          const [nx, ny, nz] = EXHAUSTS[Math.random() < 0.5 ? 0 : 1];
          scratch.point.set(nx, ny, nz - 0.3).applyMatrix4(g.matrixWorld);
          particles.emit(
            scratch.point.x,
            scratch.point.y,
            scratch.point.z,
            s.vx * 0.6 + (Math.random() - 0.5) * 3,
            (Math.random() - 0.3) * 2,
            s.vz * 0.6 + (Math.random() - 0.5) * 3,
            0.35,
            BOOST_BURST,
            0.3,
            3,
            0,
          );
        }
      }

      // Name tag above the car, fading out with distance.
      rig.tag.position.set(s.x, s.y + TAG_HEIGHT, s.z);
      const distance = camera.position.distanceTo(rig.tag.position);
      const fade = 1 - smoothstep(TAG_FADE_START, TAG_FADE_END, distance);
      const size =
        TAG_SCALE *
        (1 - (1 - TAG_FAR_SCALE) * smoothstep(TAG_SHRINK_START, TAG_SHRINK_END, distance));
      rig.tag.scale.set(size * 4, size, 1);
      rig.tagMaterial.opacity = fade * (offline ? 0.7 : 1);
      rig.tag.visible = fade > 0.01;
    }
  }, -2);

  return (
    <>
      {rigs.map((rig) => (
        <group key={rig.car.id}>
          <primitive object={rig.group} />
          <primitive object={rig.tag} />
          {rig.trails.map((trail, i) => (
            <primitive key={i} object={trail.mesh} />
          ))}
        </group>
      ))}
    </>
  );
}
