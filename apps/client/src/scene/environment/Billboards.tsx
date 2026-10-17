import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import {
  Color,
  InstancedBufferAttribute,
  InstancedMesh,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
} from 'three';
import { getSignAtlas, panelUv } from '../textures';
import { BoxBatch } from '../track/trackGeometry';
import type { BillboardSpec } from './cityLayout';
import { createHologramMaterial } from './hologram';

const WIDTH = 24;
const HEIGHT = 12;

/** Holographic ad screens on pylons beside the track: one draw call for every screen. */
export function Billboards({ billboards }: { billboards: BillboardSpec[] }) {
  const parts = useMemo(() => {
    const geometry = new PlaneGeometry(WIDTH, HEIGHT);
    const rects = new Float32Array(billboards.length * 4);
    billboards.forEach((b, i) => rects.set(panelUv(b.panel), i * 4));
    geometry.setAttribute('aRect', new InstancedBufferAttribute(rects, 4));
    const material = createHologramMaterial(getSignAtlas(), 2.1);
    const screens = new InstancedMesh(geometry, material, billboards.length);
    const dummy = new Object3D();
    const pylons = new BoxBatch();
    billboards.forEach((b, i) => {
      dummy.position.set(b.x, b.y, b.z);
      dummy.rotation.set(0, b.yaw, 0);
      dummy.updateMatrix();
      screens.setMatrixAt(i, dummy.matrix);
      // Two pylons under each screen, along its width.
      const ax = Math.cos(b.yaw);
      const az = -Math.sin(b.yaw);
      const fx = Math.sin(b.yaw);
      const fz = Math.cos(b.yaw);
      for (const side of [-0.32, 0.32]) {
        const x = b.x + ax * WIDTH * side - fx * 0.6;
        const z = b.z + az * WIDTH * side - fz * 0.6;
        pylons.add(x, b.baseY, z, x, b.y - HEIGHT / 2 + 0.5, z, 0.9, 0.9, fx, fz);
      }
      pylons.add(
        b.x - ax * WIDTH * 0.5 - fx * 0.6,
        b.y - HEIGHT / 2,
        b.z - az * WIDTH * 0.5 - fz * 0.6,
        b.x + ax * WIDTH * 0.5 - fx * 0.6,
        b.y - HEIGHT / 2,
        b.z + az * WIDTH * 0.5 - fz * 0.6,
        0.6,
        0.8,
        fx,
        fz,
      );
    });
    screens.instanceMatrix.needsUpdate = true;
    screens.frustumCulled = false;
    screens.renderOrder = 3;
    const pylonMesh = pylons.build(
      new MeshStandardMaterial({ color: new Color('#11141d'), metalness: 0.7, roughness: 0.45 }),
    );
    return { screens, material, pylonMesh };
  }, [billboards]);

  useEffect(
    () => () => {
      parts.screens.geometry.dispose();
      parts.material.dispose();
      parts.screens.dispose();
      parts.pylonMesh.geometry.dispose();
      (parts.pylonMesh.material as MeshStandardMaterial).dispose();
      parts.pylonMesh.dispose();
    },
    [parts],
  );

  useFrame(({ clock }) => {
    parts.material.uniforms.uTime.value = clock.elapsedTime;
  });

  return (
    <group>
      <primitive object={parts.pylonMesh} />
      <primitive object={parts.screens} />
    </group>
  );
}
