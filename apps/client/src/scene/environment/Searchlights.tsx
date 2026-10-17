import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import {
  AdditiveBlending,
  Color,
  ConeGeometry,
  DoubleSide,
  ShaderMaterial,
  type Group,
} from 'three';
import { PALETTE } from '../../game/palette';
import { createRandom, range } from '../random';

const BEAMS = 7;

/** Slow sweeping searchlight beams from the city: cheap additive cones that sell the scale. */
export function Searchlights({ cx, cz }: { cx: number; cz: number }) {
  const group = useRef<Group>(null);
  const { geometry, materials, beams } = useMemo(() => {
    const geometry = new ConeGeometry(30, 1, 24, 1, true);
    // Apex at the origin, opening upward along +y.
    geometry.translate(0, -0.5, 0);
    geometry.rotateX(Math.PI);
    const colors = [PALETTE.cyan, PALETTE.magenta, '#ffffff', PALETTE.violet];
    const materials = colors.map(
      (hex) =>
        new ShaderMaterial({
          uniforms: { uColor: { value: new Color(hex) } },
          vertexShader: /* glsl */ `
            varying float vH;
            varying vec3 vN;
            varying vec3 vV;
            void main() {
              vH = position.y;
              vec4 mv = modelViewMatrix * vec4(position, 1.0);
              vN = normalize(normalMatrix * normal);
              vV = normalize(-mv.xyz);
              gl_Position = projectionMatrix * mv;
            }
          `,
          fragmentShader: /* glsl */ `
            uniform vec3 uColor;
            varying float vH;
            varying vec3 vN;
            varying vec3 vV;
            void main() {
              float core = pow(abs(dot(normalize(vN), normalize(vV))), 2.0);
              float a = pow(1.0 - clamp(vH, 0.0, 1.0), 2.2) * core * 0.16;
              gl_FragColor = vec4(uColor * a, 1.0);
            }
          `,
          transparent: true,
          depthWrite: false,
          blending: AdditiveBlending,
          side: DoubleSide,
        }),
    );
    const rand = createRandom(99);
    const beams = Array.from({ length: BEAMS }, (_, i) => {
      const angle = (i / BEAMS) * Math.PI * 2 + range(rand, -0.3, 0.3);
      const dist = range(rand, 650, 1150);
      return {
        x: cx + Math.cos(angle) * dist,
        z: cz + Math.sin(angle) * dist,
        length: range(rand, 900, 1300),
        phase: rand() * 10,
        speed: range(rand, 0.12, 0.25),
        material: i % materials.length,
      };
    });
    return { geometry, materials, beams };
  }, [cx, cz]);

  useEffect(
    () => () => {
      geometry.dispose();
      for (const m of materials) m.dispose();
    },
    [geometry, materials],
  );

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    group.current?.children.forEach((beam, i) => {
      const b = beams[i];
      beam.rotation.x = Math.sin(t * b.speed + b.phase) * 0.35;
      beam.rotation.z = Math.cos(t * b.speed * 0.8 + b.phase) * 0.35;
    });
  });

  return (
    <group ref={group}>
      {beams.map((b, i) => (
        <mesh
          key={i}
          geometry={geometry}
          material={materials[b.material]}
          position={[b.x, -0.3, b.z]}
          scale={[1, b.length, 1]}
          renderOrder={1}
          frustumCulled={false}
        />
      ))}
    </group>
  );
}
