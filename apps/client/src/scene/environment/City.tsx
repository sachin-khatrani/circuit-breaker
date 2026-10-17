import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import {
  BoxGeometry,
  Color,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
} from 'three';
import { NOISE_GLSL } from '../shaders/chunks';
import type { TowerSpec } from './cityLayout';

const WINDOW_TINTS = ['#ffcf8a', '#9fd8ff', '#ff8fd8', '#7ffcff'].map((hex) => new Color(hex));
const NEON_TINTS = ['#19e6ff', '#ff2bd6', '#8a5cff', '#ffb02e'].map((hex) => new Color(hex));

/**
 * Every tower in one instanced draw call. The shader builds facades in metres from the
 * instance scale: lit and dark windows, shopfront bands, neon corner strips and roof crowns.
 */
export function City({ towers }: { towers: TowerSpec[] }) {
  const mesh = useMemo(() => {
    const geometry = new BoxGeometry(1, 1, 1);
    geometry.translate(0, 0.5, 0);
    const count = towers.length;
    const seeds = new Float32Array(count);
    const tints = new Float32Array(count * 3);
    const neons = new Float32Array(count * 3);
    const material = new ShaderMaterial({
      uniforms: UniformsUtils.merge([UniformsLib.fog, { uTime: { value: 0 } }]),
      vertexShader: /* glsl */ `
        #include <common>
        #include <fog_pars_vertex>
        attribute float aSeed;
        attribute vec3 aTint;
        attribute vec3 aNeon;
        varying vec3 vLocal;
        varying vec3 vSize;
        varying vec3 vObjNormal;
        varying float vSeed;
        varying vec3 vTint;
        varying vec3 vNeon;
        void main() {
          vec3 size = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
          vLocal = position * size;
          vSize = size;
          vObjNormal = normal;
          vSeed = aSeed;
          vTint = aTint;
          vNeon = aNeon;
          vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }
      `,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <fog_pars_fragment>
        uniform float uTime;
        varying vec3 vLocal;
        varying vec3 vSize;
        varying vec3 vObjNormal;
        varying float vSeed;
        varying vec3 vTint;
        varying vec3 vNeon;
        ${NOISE_GLSL}
        void main() {
          vec3 base = vec3(0.016, 0.017, 0.03);
          if (vObjNormal.y > 0.5) {
            // Roof: dark with a faint service grid.
            vec2 g = abs(fract(vLocal.xz / 6.0) - 0.5);
            float line = 1.0 - smoothstep(0.0, 0.04, min(g.x, g.y));
            gl_FragColor = vec4(base + vNeon * line * 0.12, 1.0);
            #include <fog_fragment>
            return;
          }
          bool sideX = abs(vObjNormal.x) > 0.5;
          float faceW = sideX ? vSize.z : vSize.x;
          float u = (sideX ? vLocal.z : vLocal.x) + faceW * 0.5;
          float v = vLocal.y;
          float face = sideX ? (vObjNormal.x > 0.0 ? 1.0 : 2.0) : (vObjNormal.z > 0.0 ? 3.0 : 4.0);

          // Windows: 4 m bays, 3.6 m floors; a per-tower lit ratio, slow flicker.
          vec2 cellSize = vec2(4.0, 3.6);
          vec2 cell = floor(vec2(u, v) / cellSize);
          vec2 f = fract(vec2(u, v) / cellSize);
          float pane = step(0.16, f.x) * step(f.x, 0.84) * step(0.22, f.y) * step(f.y, 0.78);
          float litRatio = 0.18 + 0.5 * fract(vSeed * 7.31);
          float r = hash12(cell + vec2(face * 31.0, vSeed * 97.0));
          float lit = step(1.0 - litRatio, r);
          float flick = step(0.995, hash12(cell + floor(uTime * 0.5) + vSeed));
          lit = abs(lit - flick);
          vec3 winColor = vTint * (0.55 + 1.1 * hash12(cell.yx + vSeed * 13.0));
          float body = step(4.2, v) * step(v, vSize.y - 3.0);
          vec3 detail = base + pane * lit * winColor * body;
          // Far away the window grid shimmers; fade it to its average brightness.
          float px = max(fwidth(u), fwidth(v)) / cellSize.x;
          float near = 1.0 - smoothstep(0.18, 0.55, px);
          vec3 avg = base + winColor * litRatio * 0.36 * body;
          vec3 col = mix(avg, detail, near);

          // Shopfront band at street level.
          col += vNeon * (1.0 - step(3.6, v)) * step(0.6, v) * 0.55;
          // Neon corner strips on some towers.
          float edge = min(u, faceW - u);
          float strips = step(0.62, vSeed) * (1.0 - smoothstep(0.25, 0.5, edge));
          col += vNeon * strips * 2.4;
          // Roof crown band.
          float crown = smoothstep(vSize.y - 2.6, vSize.y - 2.2, v) * (1.0 - smoothstep(vSize.y - 1.2, vSize.y - 0.8, v));
          col += vNeon * crown * step(0.35, vSeed) * 2.6;
          // Blinking aviation light on the tallest towers.
          float beacon = step(140.0, vSize.y) * step(vSize.y - 0.6, v) * step(0.5, sin(uTime * 3.0 + vSeed * 20.0));
          col += vec3(3.0, 0.2, 0.25) * beacon * (1.0 - smoothstep(0.0, 2.0, abs(u - faceW * 0.5)));

          gl_FragColor = vec4(col, 1.0);
          #include <fog_fragment>
        }
      `,
      fog: true,
    });

    const instanced = new InstancedMesh(geometry, material, count);
    const m = new Matrix4();
    towers.forEach((t, i) => {
      m.makeScale(t.width, t.height, t.depth);
      m.setPosition(t.x, -0.3, t.z);
      instanced.setMatrixAt(i, m);
      seeds[i] = t.seed;
      const tint = WINDOW_TINTS[t.tint % WINDOW_TINTS.length];
      tints.set([tint.r, tint.g, tint.b], i * 3);
      const neon = NEON_TINTS[Math.floor(t.seed * 997) % NEON_TINTS.length];
      neons.set([neon.r, neon.g, neon.b], i * 3);
    });
    geometry.setAttribute('aSeed', new InstancedBufferAttribute(seeds, 1));
    geometry.setAttribute('aTint', new InstancedBufferAttribute(tints, 3));
    geometry.setAttribute('aNeon', new InstancedBufferAttribute(neons, 3));
    instanced.instanceMatrix.needsUpdate = true;
    instanced.computeBoundingSphere();
    instanced.frustumCulled = false;
    return instanced;
  }, [towers]);

  useEffect(
    () => () => {
      mesh.geometry.dispose();
      mesh.material.dispose();
      mesh.dispose();
    },
    [mesh],
  );

  useFrame(({ clock }) => {
    mesh.material.uniforms.uTime.value = clock.elapsedTime;
  });

  return <primitive object={mesh} />;
}
