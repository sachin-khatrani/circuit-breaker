import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import { Color, PlaneGeometry } from 'three';
import { session } from '../../game/session';
import { createCurtainMaterial } from './materials';
import { BARRIER_OFFSET, sectorColorAt } from './trackGeometry';

const CURTAIN_HEIGHT = 12;

/**
 * Holographic curtains in every checkpoint gate (and the start/finish gantry). The next gate
 * the player needs glows brightest, and a gate flashes when it is crossed.
 */
export function Gates() {
  const track = session.track;
  const gates = useMemo(
    () =>
      track.checkpoints.map((gate) => {
        const width = 2 * (gate.halfWidth + BARRIER_OFFSET + (gate.index === 0 ? 2.5 : 1.6));
        const geometry = new PlaneGeometry(width, CURTAIN_HEIGHT);
        const material = createCurtainMaterial(
          sectorColorAt(track, gate.s + 1, new Color()).multiplyScalar(2.2),
        );
        return {
          index: gate.index,
          geometry,
          material,
          position: [gate.x, gate.y + CURTAIN_HEIGHT / 2, gate.z] as const,
          rotationY: Math.atan2(gate.fx, gate.fz),
        };
      }),
    [track],
  );

  useEffect(() => {
    const off = session.onEvent((event) => {
      if (event.type === 'checkpoint' || event.type === 'lap') {
        const index = event.type === 'checkpoint' ? event.checkpoint : 0;
        const gate = gates.find((g) => g.index === index);
        if (gate) gate.material.uniforms.uFlash.value = 1;
      }
    });
    return () => {
      off();
    };
  }, [gates]);

  useEffect(
    () => () => {
      for (const gate of gates) {
        gate.geometry.dispose();
        gate.material.dispose();
      }
    },
    [gates],
  );

  useFrame(({ clock }, delta) => {
    const racer = session.racer;
    const racing = session.racing && !racer.finished;
    for (const gate of gates) {
      const u = gate.material.uniforms;
      u.uTime.value = clock.elapsedTime;
      const next =
        racing && racer.nextCheckpoint === gate.index && (gate.index !== 0 || racer.started);
      u.uActive.value += ((next ? 1 : 0) - u.uActive.value) * Math.min(1, delta * 4);
      u.uFlash.value = Math.max(0, u.uFlash.value - delta * 1.8);
    }
  });

  return (
    <group>
      {gates.map((gate) => (
        <mesh
          key={gate.index}
          geometry={gate.geometry}
          material={gate.material}
          position={gate.position}
          rotation-y={gate.rotationY}
          renderOrder={3}
        />
      ))}
    </group>
  );
}
