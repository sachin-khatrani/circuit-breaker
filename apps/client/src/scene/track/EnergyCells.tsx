import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  InstancedMesh,
  MeshBasicMaterial,
  Object3D,
  OctahedronGeometry,
  Points,
  PointsMaterial,
} from 'three';
import { PALETTE } from '../../game/palette';
import { session } from '../../game/session';
import { createGlowTexture } from '../textures';

/** Energy cells: instanced crystals with a halo sprite each, synced to the sim's cell state. */
export function EnergyCells() {
  const track = session.track;
  const parts = useMemo(() => {
    const count = track.cells.length;
    const crystal = new InstancedMesh(
      new OctahedronGeometry(0.85, 0),
      new MeshBasicMaterial({
        color: new Color(PALETTE.lime).multiplyScalar(3.2),
        toneMapped: false,
      }),
      count,
    );
    crystal.frustumCulled = false;
    const inner = new InstancedMesh(
      new OctahedronGeometry(0.4, 0),
      new MeshBasicMaterial({ color: new Color('#ffffff').multiplyScalar(4), toneMapped: false }),
      count,
    );
    inner.frustumCulled = false;
    const haloGeometry = new BufferGeometry();
    const positions = new Float32Array(count * 3);
    track.cells.forEach((c, i) => positions.set([c.x, c.y, c.z], i * 3));
    haloGeometry.setAttribute('position', new BufferAttribute(positions, 3));
    const glow = createGlowTexture();
    const halo = new Points(
      haloGeometry,
      new PointsMaterial({
        size: 6,
        map: glow,
        color: new Color(PALETTE.lime).multiplyScalar(1.4),
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
        sizeAttenuation: true,
        toneMapped: false,
      }),
    );
    halo.frustumCulled = false;
    return { crystal, inner, halo, glow, positions, scale: new Float32Array(count).fill(1) };
  }, [track]);

  useEffect(
    () => () => {
      for (const mesh of [parts.crystal, parts.inner]) {
        mesh.geometry.dispose();
        mesh.material.dispose();
        mesh.dispose();
      }
      parts.halo.geometry.dispose();
      parts.halo.material.dispose();
      parts.glow.dispose();
    },
    [parts],
  );

  const dummy = useMemo(() => new Object3D(), []);

  useFrame(({ clock }, delta) => {
    const t = clock.elapsedTime;
    const cells = session.sim.cells;
    const haloPositions = parts.halo.geometry.attributes.position;
    track.cells.forEach((cell, i) => {
      const active = cells[i]?.active ?? true;
      // Pop back in over ~0.3 s after a respawn, vanish instantly on pickup.
      const target = active ? 1 : 0;
      parts.scale[i] = active ? Math.min(1, parts.scale[i] + delta * 3.5) : target;
      const s = parts.scale[i];
      const bob = Math.sin(t * 2.4 + i * 1.7) * 0.25;
      dummy.position.set(cell.x, cell.y + bob, cell.z);
      dummy.rotation.set(t * 0.9 + i, t * 1.6 + i * 0.5, 0);
      dummy.scale.setScalar(s * (1 + Math.sin(t * 6 + i) * 0.06));
      dummy.updateMatrix();
      parts.crystal.setMatrixAt(i, dummy.matrix);
      dummy.rotation.set(-t * 1.3, -t * 2.2, 0);
      dummy.updateMatrix();
      parts.inner.setMatrixAt(i, dummy.matrix);
      // Hide the halo of a collected cell by dropping it below the world.
      haloPositions.setY(i, s > 0.01 ? cell.y + bob : -1000);
    });
    parts.crystal.instanceMatrix.needsUpdate = true;
    parts.inner.instanceMatrix.needsUpdate = true;
    haloPositions.needsUpdate = true;
  }, -2);

  return (
    <group>
      <primitive object={parts.crystal} />
      <primitive object={parts.inner} />
      <primitive object={parts.halo} />
    </group>
  );
}
