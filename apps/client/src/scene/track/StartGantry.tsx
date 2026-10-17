import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import {
  BufferAttribute,
  CircleGeometry,
  Color,
  FrontSide,
  InstancedMesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
} from 'three';
import { PALETTE } from '../../game/palette';
import { session } from '../../game/session';
import { createHologramMaterial } from '../environment/hologram';
import { getSignAtlas, panelUv } from '../textures';
import { BARRIER_OFFSET, BoxBatch, sampleFrame, surfaceY, type SampleFrame } from './trackGeometry';

const LAMPS = 5;
const TOWER_OFFSET = 4.5;
const TRUSS_HEIGHT = 15;

const RED = new Color(PALETTE.red).multiplyScalar(6);
const GREEN = new Color(PALETTE.lime).multiplyScalar(6);
const OFF = new Color('#1a0d18');
const IDLE = new Color(PALETTE.cyan).multiplyScalar(3);

function signPlane(panel: number, width: number, height: number): PlaneGeometry {
  const geometry = new PlaneGeometry(width, height);
  const rect = panelUv(panel);
  const data = new Float32Array(4 * 4);
  for (let i = 0; i < 4; i++) data.set(rect, i * 4);
  geometry.setAttribute('aRect', new BufferAttribute(data, 4));
  return geometry;
}

/** Start/finish gantry: towers, truss, holographic signs and the countdown lamps. */
export function StartGantry() {
  const track = session.track;
  const parts = useMemo(() => {
    const f = sampleFrame(track, 0, {} as SampleFrame);
    const outer = f.hw + BARRIER_OFFSET + TOWER_OFFSET;
    const structure = new BoxBatch();
    const neon = new BoxBatch();
    const glow = new Color(PALETTE.cyan).multiplyScalar(5);
    const pink = new Color(PALETTE.magenta).multiplyScalar(5);
    const top = Math.max(surfaceY(f, -f.hw), surfaceY(f, f.hw)) + TRUSS_HEIGHT;
    for (const sign of [-1, 1]) {
      const lat = sign * outer;
      const x = f.x + f.rx * lat;
      const z = f.z + f.rz * lat;
      structure.add(x, -0.3, z, x, top + 9, z, 3.4, 3.4, f.fx, f.fz);
      for (const off of [-1.8, 1.8]) {
        const ox = x + f.fx * off;
        const oz = z + f.fz * off;
        neon.add(ox, 0.4, oz, ox, top + 8.6, oz, 0.22, 0.22, f.fx, f.fz, sign < 0 ? glow : pink);
      }
    }
    const lx = f.x - f.rx * outer;
    const lz = f.z - f.rz * outer;
    const rx = f.x + f.rx * outer;
    const rz = f.z + f.rz * outer;
    structure.add(lx, top, lz, rx, top, rz, 1.8, 3.2, f.fx, f.fz);
    structure.add(lx, top + 8.4, lz, rx, top + 8.4, rz, 0.8, 1.6, f.fx, f.fz);
    neon.add(lx, top - 1, lz, rx, top - 1, rz, 0.22, 3.4, f.fx, f.fz, glow);
    neon.add(lx, top + 9, lz, rx, top + 9, rz, 0.2, 1.8, f.fx, f.fz, pink);

    const structureMesh = structure.build(
      new MeshStandardMaterial({ color: new Color('#12151f'), metalness: 0.8, roughness: 0.35 }),
    );
    const neonMesh = neon.build(new MeshBasicMaterial({ color: '#ffffff', toneMapped: false }));

    const atlas = getSignAtlas();
    const signMaterial = createHologramMaterial(atlas, 2.4);
    // Two single-sided screens back to back, so neither side shows mirrored text.
    signMaterial.side = FrontSide;
    const front = signPlane(0, (outer - 2) * 2, 7.4);
    const back = signPlane(7, (outer - 2) * 2, 7.4);
    const heading = Math.atan2(f.fx, f.fz);

    // Countdown lamps hang under the truss, facing the grid.
    const lamps = new InstancedMesh(
      new CircleGeometry(0.85, 24),
      new MeshBasicMaterial({ color: '#ffffff', toneMapped: false }),
      LAMPS,
    );
    const dummy = new Object3D();
    for (let i = 0; i < LAMPS; i++) {
      const lat = (i - (LAMPS - 1) / 2) * 2.6;
      dummy.position.set(f.x + f.rx * lat - f.fx * 1.7, top - 2.6, f.z + f.rz * lat - f.fz * 1.7);
      dummy.rotation.set(0, heading + Math.PI, 0);
      dummy.updateMatrix();
      lamps.setMatrixAt(i, dummy.matrix);
      lamps.setColorAt(i, OFF);
    }
    lamps.frustumCulled = false;

    return {
      structureMesh,
      neonMesh,
      signMaterial,
      front,
      back,
      lamps,
      frontPosition: [f.x - f.fx * 0.4, top + 4.4, f.z - f.fz * 0.4] as const,
      backPosition: [f.x + f.fx * 0.4, top + 4.4, f.z + f.fz * 0.4] as const,
      heading,
      lampColor: new Color(),
    };
  }, [track]);

  useEffect(
    () => () => {
      for (const mesh of [parts.structureMesh, parts.neonMesh, parts.lamps]) {
        mesh.geometry.dispose();
        (mesh.material as MeshBasicMaterial).dispose();
        mesh.dispose();
      }
      parts.front.dispose();
      parts.back.dispose();
      parts.signMaterial.dispose();
    },
    [parts],
  );

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    parts.signMaterial.uniforms.uTime.value = t;
    const sim = session.sim;
    const remaining = (sim.goTick - sim.tick) / 60;
    const sinceGo = (sim.tick - sim.goTick) / 60;
    for (let i = 0; i < LAMPS; i++) {
      let color: Color;
      if (session.racing && sim.phase === 'countdown') {
        // F1-style: lamps come on one by one across the last three seconds, then all go out.
        const lit = remaining > 3 ? 0 : Math.min(LAMPS, Math.floor((3 - remaining) / 0.6) + 1);
        color = i < lit ? RED : OFF;
      } else if (session.racing && sinceGo < 2.5) {
        color = Math.floor(t * 8) % 2 === 0 || sinceGo < 1 ? GREEN : OFF;
      } else {
        const chase = Math.floor(t * 4) % LAMPS === i;
        color = chase ? IDLE : OFF;
      }
      parts.lampColor.copy(color);
      parts.lamps.setColorAt(i, parts.lampColor);
    }
    if (parts.lamps.instanceColor) parts.lamps.instanceColor.needsUpdate = true;
  });

  return (
    <group>
      <primitive object={parts.structureMesh} />
      <primitive object={parts.neonMesh} />
      <primitive object={parts.lamps} />
      <mesh
        geometry={parts.front}
        material={parts.signMaterial}
        position={parts.frontPosition}
        rotation-y={parts.heading + Math.PI}
        renderOrder={3}
      />
      <mesh
        geometry={parts.back}
        material={parts.signMaterial}
        position={parts.backPosition}
        rotation-y={parts.heading}
        renderOrder={3}
      />
    </group>
  );
}
