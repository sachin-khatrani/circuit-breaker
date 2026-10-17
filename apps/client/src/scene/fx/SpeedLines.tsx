import { clamp, damp } from '@circuit-breaker/shared';
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  LineBasicMaterial,
  LineSegments,
  type Group,
} from 'three';
import { PALETTE } from '../../game/palette';
import { session } from '../../game/session';
import { createRandom, range } from '../random';

const LINES = 110;
const DEPTH = 70;

/** Streaks rushing past the camera near top speed and while boosting. */
export function SpeedLines() {
  const group = useRef<Group>(null);
  const opacity = useRef(0);
  const parts = useMemo(() => {
    const rand = createRandom(5);
    const positions = new Float32Array(LINES * 6);
    const lengths = new Float32Array(LINES);
    for (let i = 0; i < LINES; i++) {
      const a = rand() * Math.PI * 2;
      const r = range(rand, 2.2, 7.5);
      const z = -range(rand, 4, DEPTH);
      lengths[i] = range(rand, 2.5, 7);
      positions.set(
        [
          Math.cos(a) * r,
          Math.sin(a) * r * 0.7,
          z,
          Math.cos(a) * r,
          Math.sin(a) * r * 0.7,
          z - lengths[i],
        ],
        i * 6,
      );
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3).setUsage(DynamicDrawUsage));
    const material = new LineBasicMaterial({
      color: new Color(PALETTE.cyan).multiplyScalar(1.8),
      transparent: true,
      opacity: 0,
      blending: AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
      fog: false,
    });
    const lines = new LineSegments(geometry, material);
    lines.frustumCulled = false;
    lines.renderOrder = 6;
    return { lines, positions, lengths, material };
  }, []);

  useEffect(
    () => () => {
      parts.lines.geometry.dispose();
      parts.material.dispose();
    },
    [parts],
  );

  useFrame(({ camera }, delta) => {
    const g = group.current;
    if (!g) return;
    g.position.copy(camera.position);
    g.quaternion.copy(camera.quaternion);
    const car = session.render;
    const racing = session.cameraMode === 'chase';
    const boosted = car.boosting || car.overdrive || car.padBoost;
    const target = racing ? Math.max(clamp((car.speed - 62) / 28, 0, 0.6), boosted ? 1 : 0) : 0;
    opacity.current = damp(opacity.current, target, 5, delta);
    parts.material.opacity = opacity.current * 0.5;
    parts.material.color.set(boosted ? PALETTE.magenta : PALETTE.cyan).multiplyScalar(1.8);
    g.visible = opacity.current > 0.01;
    if (!g.visible) return;
    const move = car.speed * delta * 1.3;
    const p = parts.positions;
    for (let i = 0; i < LINES; i++) {
      const k = i * 6;
      p[k + 2] += move;
      if (p[k + 2] > -1.5) p[k + 2] -= DEPTH;
      p[k + 5] = p[k + 2] - parts.lengths[i] * (1 + opacity.current);
    }
    parts.lines.geometry.attributes.position.needsUpdate = true;
  });

  return (
    <group ref={group}>
      <primitive object={parts.lines} />
    </group>
  );
}
