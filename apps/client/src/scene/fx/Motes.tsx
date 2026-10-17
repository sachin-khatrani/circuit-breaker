import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  PerspectiveCamera,
  Points,
  ShaderMaterial,
  Vector3,
} from 'three';
import { PALETTE } from '../../game/palette';
import { createRandom } from '../random';

/** Side of the box of air the motes fill, centred on the camera (metres). */
const BOX = 140;
const TINTS = [PALETTE.cyan, PALETTE.magenta, PALETTE.violet].map((hex) => new Color(hex));

/**
 * Neon dust hanging in the night air: a field of dim motes that always surrounds the camera.
 * Each mote drifts slowly; its position wraps around the camera in the vertex shader, so the
 * field never runs out and costs one draw call with no per-frame CPU work beyond two uniforms.
 */
export function Motes({ count }: { count: number }) {
  const { points, eye } = useMemo(() => {
    const rand = createRandom(17);
    const seeds = new Float32Array(count * 3);
    const tints = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      seeds.set([rand(), rand(), rand()], i * 3);
      const tint = TINTS[i % TINTS.length];
      tints.set([tint.r, tint.g, tint.b], i * 3);
    }
    const geometry = new BufferGeometry();
    // The vertex shader places every mote; `position` only gives three.js a vertex count.
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(count * 3), 3));
    geometry.setAttribute('aSeed', new BufferAttribute(seeds, 3));
    geometry.setAttribute('aTint', new BufferAttribute(tints, 3));
    const eye = new Vector3();
    const material = new ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uCamera: { value: eye },
        uScale: { value: 600 },
      },
      vertexShader: /* glsl */ `
        uniform float uTime;
        uniform vec3 uCamera;
        uniform float uScale;
        attribute vec3 aSeed;
        attribute vec3 aTint;
        varying vec3 vTint;
        varying float vAlpha;
        const float BOX = ${BOX.toFixed(1)};
        void main() {
          vec3 drift = vec3(
            sin(uTime * 0.11 + aSeed.y * 40.0),
            sin(uTime * 0.07 + aSeed.z * 50.0) * 0.5 + uTime * 0.12,
            cos(uTime * 0.09 + aSeed.x * 30.0)
          ) * 4.0;
          vec3 p = aSeed * BOX + drift;
          // Wrap into the box around the camera.
          p = mod(p - uCamera + BOX * 0.5, BOX) - BOX * 0.5 + uCamera;
          vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          float depth = -mvPosition.z;
          gl_PointSize = 0.16 * uScale / max(1.0, depth);
          // Fade at the box's edge (no popping as motes wrap) and right at the lens.
          float r = length(p - uCamera) / (BOX * 0.5);
          vAlpha = (1.0 - smoothstep(0.55, 0.95, r)) * smoothstep(2.0, 9.0, depth);
          vTint = aTint;
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vTint;
        varying float vAlpha;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.0, d);
          gl_FragColor = vec4(vTint * a * a * vAlpha * 0.9, 1.0);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    const object = new Points(geometry, material);
    object.frustumCulled = false;
    object.renderOrder = 4;
    return { points: object, eye };
  }, [count]);

  useEffect(
    () => () => {
      points.geometry.dispose();
      points.material.dispose();
    },
    [points],
  );

  useFrame(({ camera, clock, size, gl }) => {
    const u = points.material.uniforms;
    u.uTime.value = clock.elapsedTime;
    eye.copy(camera.position);
    const fov = camera instanceof PerspectiveCamera ? camera.fov : 60;
    u.uScale.value = (size.height * gl.getPixelRatio()) / (2 * Math.tan((fov * Math.PI) / 360));
  });

  return <primitive object={points} />;
}
