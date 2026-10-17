import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  PerspectiveCamera,
  Points,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
} from 'three';
import { createRandom, range } from '../random';
import { ADDITIVE_FOG_GLSL } from '../shaders/chunks';

const LANES = 6;
const PER_LANE = 14;
const LANE_LENGTH = 3600;

/**
 * Flying traffic over the city: pairs of head and tail lights gliding along air lanes. All
 * motion happens in the vertex shader from uTime, so it costs one draw call and no CPU.
 */
export function SkyTraffic({ cx, cz }: { cx: number; cz: number }) {
  const points = useMemo(() => {
    const rand = createRandom(31);
    const count = LANES * PER_LANE * 2;
    const origin = new Float32Array(count * 3);
    const dir = new Float32Array(count * 3);
    const params = new Float32Array(count * 4);
    const color = new Float32Array(count * 3);
    let k = 0;
    for (let lane = 0; lane < LANES; lane++) {
      const heading = (lane / LANES) * Math.PI + range(rand, -0.2, 0.2);
      const altitude = 85 + lane * 32 + range(rand, -8, 8);
      for (let n = 0; n < PER_LANE; n++) {
        const both = n % 2 === 0 ? 1 : -1;
        const dx = Math.cos(heading) * both;
        const dz = Math.sin(heading) * both;
        // Parallel tracks within a lane, spread across the city.
        const offset = range(rand, -900, 900);
        const ox = cx - dz * offset;
        const oz = cz + dx * offset;
        const speed = range(rand, 28, 58);
        const phase = range(rand, 0, LANE_LENGTH);
        const police = rand() < 0.06;
        for (const end of [1, -1]) {
          origin.set([ox, altitude + range(rand, -1, 1), oz], k * 3);
          dir.set([dx, 0, dz], k * 3);
          params.set([speed, phase, LANE_LENGTH, end * 1.6], k * 4);
          if (end > 0) color.set(police ? [0.4, 1.8, 3] : [3, 2.7, 2.3], k * 3);
          else color.set(police ? [3, 0.3, 1.6] : [2.6, 0.25, 0.35], k * 3);
          k++;
        }
      }
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(origin, 3));
    geometry.setAttribute('aDir', new BufferAttribute(dir, 3));
    geometry.setAttribute('aParams', new BufferAttribute(params, 4));
    geometry.setAttribute('aColor', new BufferAttribute(color, 3));
    const material = new ShaderMaterial({
      uniforms: UniformsUtils.merge([
        UniformsLib.fog,
        { uTime: { value: 0 }, uScale: { value: 600 } },
      ]),
      vertexShader: /* glsl */ `
        #include <common>
        #include <fog_pars_vertex>
        uniform float uTime;
        uniform float uScale;
        attribute vec3 aDir;
        attribute vec4 aParams;
        attribute vec3 aColor;
        varying vec3 vColor;
        void main() {
          float travel = mod(uTime * aParams.x + aParams.y, aParams.z) - aParams.z * 0.5;
          vec3 p = position + aDir * (travel + aParams.w);
          vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          gl_PointSize = max(1.5, 2.4 * uScale / max(1.0, -mvPosition.z));
          vColor = aColor;
          #include <fog_vertex>
        }
      `,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <fog_pars_fragment>
        varying vec3 vColor;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          gl_FragColor = vec4(vColor * smoothstep(0.5, 0.0, d), 1.0);
          ${ADDITIVE_FOG_GLSL}
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      fog: true,
    });
    const object = new Points(geometry, material);
    object.frustumCulled = false;
    return object;
  }, [cx, cz]);

  useEffect(
    () => () => {
      points.geometry.dispose();
      points.material.dispose();
    },
    [points],
  );

  useFrame(({ clock, camera, size, gl }) => {
    const material = points.material;
    material.uniforms.uTime.value = clock.elapsedTime;
    const fov = camera instanceof PerspectiveCamera ? camera.fov : 60;
    material.uniforms.uScale.value =
      (size.height * gl.getPixelRatio()) / (2 * Math.tan((fov * Math.PI) / 360));
  });

  return <primitive object={points} />;
}
