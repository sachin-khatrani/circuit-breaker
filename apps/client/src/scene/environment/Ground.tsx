import { useEffect, useMemo } from 'react';
import { Color, PlaneGeometry, ShaderMaterial, UniformsLib, UniformsUtils, Vector2 } from 'three';
import { PALETTE } from '../../game/palette';

/** Dark ground plane with an anti-aliased neon survey grid and a warm haze around the reactor. */
export function Ground({ center }: { center: Vector2 }) {
  const { geometry, material } = useMemo(() => {
    const geometry = new PlaneGeometry(9000, 9000, 1, 1);
    geometry.rotateX(-Math.PI / 2);
    const material = new ShaderMaterial({
      uniforms: UniformsUtils.merge([
        UniformsLib.fog,
        {
          uBase: { value: new Color(PALETTE.ground) },
          uMinor: { value: new Color('#3a1a6e') },
          uMajor: { value: new Color('#7a3cff') },
          uHalo: { value: new Color('#ff4fb0') },
          uCenter: { value: center.clone() },
        },
      ]),
      vertexShader: /* glsl */ `
        #include <common>
        #include <fog_pars_vertex>
        varying vec3 vWorld;
        void main() {
          vec4 world = modelMatrix * vec4(position, 1.0);
          vWorld = world.xyz;
          vec4 mvPosition = viewMatrix * world;
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }
      `,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <fog_pars_fragment>
        uniform vec3 uBase;
        uniform vec3 uMinor;
        uniform vec3 uMajor;
        uniform vec3 uHalo;
        uniform vec2 uCenter;
        varying vec3 vWorld;
        float grid(vec2 p, float size, float width) {
          vec2 q = p / size;
          vec2 g = abs(fract(q - 0.5) - 0.5) / fwidth(q);
          return 1.0 - min(min(g.x, g.y) / width, 1.0);
        }
        void main() {
          vec2 p = vWorld.xz;
          float minor = grid(p, 20.0, 1.0);
          float major = grid(p, 100.0, 1.6);
          float dist = length(p - uCenter);
          vec3 col = uBase;
          col += uMinor * minor * 0.35;
          col += uMajor * major * 0.9;
          col += uHalo * 0.05 * exp(-dist / 380.0);
          gl_FragColor = vec4(col, 1.0);
          #include <fog_fragment>
        }
      `,
      fog: true,
    });
    return { geometry, material };
  }, [center]);

  useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );

  return <mesh geometry={geometry} material={material} position-y={-0.32} renderOrder={-5} />;
}
