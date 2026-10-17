import { smoothstep } from '@circuit-breaker/shared';
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import {
  AdditiveBlending,
  Color,
  CylinderGeometry,
  DoubleSide,
  MeshBasicMaterial,
  MeshStandardMaterial,
  ShaderMaterial,
  SphereGeometry,
  TorusGeometry,
  UniformsLib,
  UniformsUtils,
  type Group,
} from 'three';
import { PALETTE } from '../../game/palette';
import { NOISE_GLSL } from '../shaders/chunks';

const CORE_HEIGHT = 170;
const RING_COLORS = [PALETTE.cyan, PALETTE.magenta, PALETTE.violet];

/** The infield reactor that "powers" the circuit: a landmark visible from every corner. */
export function Reactor({ x, z }: { x: number; z: number }) {
  const rings = useRef<Group>(null);
  const parts = useMemo(() => {
    const core = new ShaderMaterial({
      uniforms: UniformsUtils.merge([
        UniformsLib.fog,
        {
          uTime: { value: 0 },
          uColor: { value: new Color(PALETTE.cyan).multiplyScalar(1.4) },
          uRim: { value: new Color('#ffffff') },
        },
      ]),
      vertexShader: /* glsl */ `
        #include <common>
        #include <fog_pars_vertex>
        varying vec2 vUv;
        varying vec3 vN;
        varying vec3 vV;
        varying float vDepth;
        void main() {
          vUv = uv;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          vN = normalize(normalMatrix * normal);
          vV = normalize(-mvPosition.xyz);
          vDepth = -mvPosition.z;
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }
      `,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <fog_pars_fragment>
        uniform float uTime;
        uniform vec3 uColor;
        uniform vec3 uRim;
        varying vec2 vUv;
        varying vec3 vN;
        varying vec3 vV;
        varying float vDepth;
        ${NOISE_GLSL}
        void main() {
          float flow = fract(vUv.y * 16.0 - uTime * 0.8);
          float bands = smoothstep(0.0, 0.08, flow) * (1.0 - smoothstep(0.18, 0.45, flow));
          float streak = pow(valueNoise(vec2(vUv.x * 28.0, vUv.y * 7.0 - uTime * 2.2)), 4.0);
          float fres = pow(1.0 - abs(dot(vN, vV)), 2.5);
          vec3 col = uColor * (0.45 + bands * 1.3 + streak * 3.5) + uRim * fres * 1.6;
          // A beacon from across the city, not a floodlight up close: where the camera passes
          // near the infield, the core dims so bloom never washes the track out.
          col *= mix(0.22, 1.0, smoothstep(40.0, 260.0, vDepth));
          gl_FragColor = vec4(col, 1.0);
          #include <fog_fragment>
        }
      `,
      fog: true,
    });
    const beam = new ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uColor: { value: new Color(PALETTE.cyan) } },
      vertexShader: /* glsl */ `
        varying float vH;
        void main() {
          // 0 at the core's cap, 1 at the top. (The cylinder is 1600 m tall: its uv.y, not
          // its position, is the normalised height.)
          vH = uv.y;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform vec3 uColor;
        varying float vH;
        void main() {
          float a = pow(1.0 - vH, 1.6) * (0.75 + 0.25 * sin(vH * 60.0 - uTime * 4.0));
          gl_FragColor = vec4(uColor * a * 0.55, 1.0);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
    });
    return {
      core,
      beam,
      coreGeometry: new CylinderGeometry(7, 9, CORE_HEIGHT, 48, 1, true),
      capGeometry: new SphereGeometry(10, 32, 16),
      baseGeometry: new CylinderGeometry(36, 40, 5, 64),
      bandGeometry: new TorusGeometry(37.5, 0.35, 8, 96),
      beamGeometry: new CylinderGeometry(2.5, 6, 1600, 24, 1, true),
      ringGeometries: [20, 27, 34].map((r) => new TorusGeometry(r, 0.7, 10, 96)),
      ringMaterials: RING_COLORS.map(
        (hex) =>
          new MeshBasicMaterial({ color: new Color(hex).multiplyScalar(4), toneMapped: false }),
      ),
      capMaterial: new MeshBasicMaterial({
        color: new Color('#d8fbff').multiplyScalar(5),
        toneMapped: false,
      }),
      baseMaterial: new MeshStandardMaterial({
        color: new Color('#10131e'),
        metalness: 0.8,
        roughness: 0.35,
      }),
      bandMaterial: new MeshBasicMaterial({
        color: new Color(PALETTE.magenta).multiplyScalar(4),
        toneMapped: false,
      }),
    };
  }, []);

  useEffect(
    () => () => {
      const all = [
        parts.core,
        parts.beam,
        parts.coreGeometry,
        parts.capGeometry,
        parts.baseGeometry,
        parts.bandGeometry,
        parts.beamGeometry,
        parts.capMaterial,
        parts.baseMaterial,
        parts.bandMaterial,
        ...parts.ringGeometries,
        ...parts.ringMaterials,
      ];
      for (const item of all) item.dispose();
    },
    [parts],
  );

  useFrame(({ clock, camera }) => {
    const t = clock.elapsedTime;
    parts.core.uniforms.uTime.value = t;
    parts.beam.uniforms.uTime.value = t;
    // The rings dim the same way as the core when the camera comes close.
    const near = smoothstep(60, 260, Math.hypot(camera.position.x - x, camera.position.z - z));
    parts.ringMaterials.forEach((material, i) => {
      material.color.set(RING_COLORS[i]).multiplyScalar(1.2 + 2.8 * near);
    });
    const group = rings.current;
    if (group) {
      group.children.forEach((ring, i) => {
        ring.rotation.z = t * (0.25 + i * 0.12) * (i % 2 === 0 ? 1 : -1);
        ring.rotation.x = Math.PI / 2 + Math.sin(t * 0.4 + i * 2) * 0.22;
        ring.position.y = 40 + i * 42 + Math.sin(t * 0.7 + i) * 3;
      });
    }
  });

  return (
    <group position={[x, -0.3, z]}>
      <mesh geometry={parts.baseGeometry} material={parts.baseMaterial} position-y={2.5} />
      <mesh
        geometry={parts.bandGeometry}
        material={parts.bandMaterial}
        position-y={4.6}
        rotation-x={Math.PI / 2}
      />
      <mesh geometry={parts.coreGeometry} material={parts.core} position-y={CORE_HEIGHT / 2 + 5} />
      <mesh
        geometry={parts.capGeometry}
        material={parts.capMaterial}
        position-y={CORE_HEIGHT + 8}
      />
      <mesh
        geometry={parts.beamGeometry}
        material={parts.beam}
        position-y={CORE_HEIGHT + 800}
        renderOrder={2}
        frustumCulled={false}
      />
      <group ref={rings}>
        {parts.ringGeometries.map((geometry, i) => (
          <mesh key={i} geometry={geometry} material={parts.ringMaterials[i]} />
        ))}
      </group>
    </group>
  );
}
