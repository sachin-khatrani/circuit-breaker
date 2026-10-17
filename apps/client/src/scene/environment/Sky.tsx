import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { BackSide, Color, ShaderMaterial, SphereGeometry, Vector3, type Mesh } from 'three';
import { PALETTE } from '../../game/palette';
import { NOISE_GLSL } from '../shaders/chunks';

/**
 * Night sky dome: violet horizon glow, deep zenith, procedural stars, a hazy moon and faint
 * nebula bands. It follows the camera so it never shows parallax or clips.
 */
export function Sky() {
  const mesh = useRef<Mesh>(null);
  const { geometry, material } = useMemo(() => {
    const geometry = new SphereGeometry(4000, 48, 24);
    const material = new ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uZenith: { value: new Color(PALETTE.skyZenith) },
        uHorizon: { value: new Color(PALETTE.skyHorizon) },
        uGlow: { value: new Color(PALETTE.skyGlow) },
        uMoonDir: { value: new Vector3(-0.45, 0.32, -0.83).normalize() },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position = p.xyww;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform vec3 uZenith;
        uniform vec3 uHorizon;
        uniform vec3 uGlow;
        uniform vec3 uMoonDir;
        varying vec3 vDir;
        ${NOISE_GLSL}
        void main() {
          vec3 d = normalize(vDir);
          float h = d.y;
          vec3 col = mix(uHorizon, uZenith, pow(smoothstep(-0.05, 0.6, h), 0.6));
          col += uGlow * exp(-abs(h - 0.01) * 16.0) * 0.35;
          col += uGlow * exp(-abs(h) * 5.0) * 0.06;

          // Nebula bands.
          float neb = valueNoise(vec2(atan(d.x, d.z) * 3.0, h * 6.0) + 11.0);
          neb *= valueNoise(vec2(atan(d.x, d.z) * 7.0, h * 13.0) - 4.0);
          col += vec3(0.25, 0.06, 0.4) * neb * smoothstep(0.05, 0.5, h) * 0.35;

          // Stars from a grid on the sphere, twinkling.
          vec2 sp = vec2(atan(d.x, d.z) * 180.0, asin(clamp(h, -1.0, 1.0)) * 180.0);
          vec2 cell = floor(sp);
          vec2 f = fract(sp) - 0.5;
          float r = hash12(cell);
          vec2 off = vec2(hash12(cell + 7.1), hash12(cell + 3.3)) - 0.5;
          float star = smoothstep(0.08, 0.0, length(f - off * 0.7)) * step(0.985, r);
          star *= 0.6 + 0.4 * sin(uTime * (1.5 + r * 3.0) + r * 40.0);
          col += vec3(0.85, 0.9, 1.0) * star * smoothstep(0.04, 0.35, h) * 1.6;

          // Moon with halo.
          float m = dot(d, uMoonDir);
          float disc = smoothstep(0.99935, 0.99955, m);
          float craters = 0.82 + 0.18 * valueNoise(d.xy * 900.0);
          col += vec3(1.0, 0.86, 0.95) * disc * 2.2 * craters;
          col += vec3(0.9, 0.5, 1.0) * pow(max(m, 0.0), 900.0) * 0.6;
          col += vec3(0.5, 0.25, 0.8) * pow(max(m, 0.0), 40.0) * 0.12;

          gl_FragColor = vec4(col, 1.0);
        }
      `,
      side: BackSide,
      depthWrite: false,
      fog: false,
    });
    return { geometry, material };
  }, []);

  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );

  useFrame(({ camera, clock }) => {
    material.uniforms.uTime.value = clock.elapsedTime;
    mesh.current?.position.copy(camera.position);
  });

  return (
    <mesh
      ref={mesh}
      geometry={geometry}
      material={material}
      renderOrder={-10}
      frustumCulled={false}
    />
  );
}
