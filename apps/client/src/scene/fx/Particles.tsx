import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
  PerspectiveCamera,
  Points,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
} from 'three';
import { QUALITY_PRESETS } from '../../game/settings';
import { useGameStore } from '../../game/store';
import { ADDITIVE_FOG_GLSL } from '../shaders/chunks';
import { PARTICLE_CAPACITY, particles } from './particlePool';

/** Renders the shared particle pool: sparks, pickups, embers. One draw call. */
export function Particles() {
  const quality = useGameStore((s) => s.quality);

  const points = useMemo(() => {
    const geometry = new BufferGeometry();
    const position = new BufferAttribute(particles.positions, 3).setUsage(DynamicDrawUsage);
    const color = new BufferAttribute(particles.colors, 3).setUsage(DynamicDrawUsage);
    const size = new BufferAttribute(particles.sizes, 1).setUsage(DynamicDrawUsage);
    const alpha = new BufferAttribute(particles.alphas, 1).setUsage(DynamicDrawUsage);
    geometry.setAttribute('position', position);
    geometry.setAttribute('aColor', color);
    geometry.setAttribute('aSize', size);
    geometry.setAttribute('aAlpha', alpha);
    geometry.setDrawRange(0, PARTICLE_CAPACITY);
    const material = new ShaderMaterial({
      uniforms: UniformsUtils.merge([UniformsLib.fog, { uScale: { value: 600 } }]),
      vertexShader: /* glsl */ `
        #include <common>
        #include <fog_pars_vertex>
        uniform float uScale;
        attribute vec3 aColor;
        attribute float aSize;
        attribute float aAlpha;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          gl_PointSize = aSize * uScale / max(0.5, -mvPosition.z);
          vColor = aColor;
          vAlpha = aAlpha;
          #include <fog_vertex>
        }
      `,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <fog_pars_fragment>
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.0, d);
          gl_FragColor = vec4(vColor * a * a * vAlpha, 1.0);
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
    object.renderOrder = 5;
    return object;
  }, []);

  useEffect(() => {
    particles.limit = QUALITY_PRESETS[quality].particles;
  }, [quality]);

  useEffect(
    () => () => {
      points.geometry.dispose();
      points.material.dispose();
    },
    [points],
  );

  useFrame(({ camera, size, gl }, delta) => {
    particles.update(Math.min(delta, 0.05));
    const geometry = points.geometry;
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.aColor.needsUpdate = true;
    geometry.attributes.aSize.needsUpdate = true;
    geometry.attributes.aAlpha.needsUpdate = true;
    // gl_PointSize is in device pixels: world size × pixels-per-metre at unit depth.
    const fov = camera instanceof PerspectiveCamera ? camera.fov : 60;
    const material = points.material;
    material.uniforms.uScale.value =
      (size.height * gl.getPixelRatio()) / (2 * Math.tan((fov * Math.PI) / 360));
  });

  return <primitive object={points} />;
}
