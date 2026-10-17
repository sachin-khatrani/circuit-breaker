import {
  AdditiveBlending,
  DoubleSide,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
  type Texture,
} from 'three';
import { ADDITIVE_FOG_GLSL, NOISE_GLSL } from '../shaders/chunks';

export interface HologramUniforms {
  uTime: { value: number };
  uAtlas: { value: Texture };
  uIntensity: { value: number };
}

/**
 * Additive holographic screen. Each vertex carries `aRect` (u0, v0, u1, v1): the panel of the
 * sign atlas it shows. Works for plain meshes and InstancedMesh (aRect per instance).
 */
export function createHologramMaterial(
  atlas: Texture,
  intensity = 2.2,
): ShaderMaterial & { uniforms: HologramUniforms } {
  const material = new ShaderMaterial({
    uniforms: UniformsUtils.merge([
      UniformsLib.fog,
      { uTime: { value: 0 }, uAtlas: { value: null }, uIntensity: { value: intensity } },
    ]),
    vertexShader: /* glsl */ `
      #include <common>
      #include <fog_pars_vertex>
      attribute vec4 aRect;
      varying vec2 vUv;
      varying vec2 vLocal;
      varying float vSeed;
      void main() {
        vLocal = uv;
        vUv = mix(aRect.xy, aRect.zw, uv);
        vSeed = aRect.x * 17.0 + aRect.y * 31.0;
        #ifdef USE_INSTANCING
          vSeed += float(gl_InstanceID) * 3.7;
          vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        #else
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        #endif
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <fog_pars_fragment>
      uniform float uTime;
      uniform sampler2D uAtlas;
      uniform float uIntensity;
      varying vec2 vUv;
      varying vec2 vLocal;
      varying float vSeed;
      ${NOISE_GLSL}
      void main() {
        // Horizontal tearing: occasionally shift a band of rows sideways.
        float band = floor(vLocal.y * 24.0);
        float tear = step(0.975, hash12(vec2(band, floor(uTime * 9.0) + vSeed))) * 0.012;
        vec4 tex = texture2D(uAtlas, vUv + vec2(tear, 0.0));
        float scan = 0.78 + 0.22 * sin(vLocal.y * 260.0 - uTime * 9.0);
        float flicker = 0.9 + 0.1 * sin(uTime * 21.0 + vSeed) * sin(uTime * 3.3 + vSeed * 2.0);
        float dropout = 1.0 - 0.7 * step(0.992, hash12(vec2(floor(uTime * 12.0), vSeed)));
        vec3 color = tex.rgb * tex.a * scan * flicker * dropout * uIntensity;
        gl_FragColor = vec4(color, 1.0);
        ${ADDITIVE_FOG_GLSL}
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide,
    fog: true,
  }) as ShaderMaterial & { uniforms: HologramUniforms };
  // UniformsUtils.merge would clone a texture; assign it after so the atlas stays shared.
  material.uniforms.uAtlas.value = atlas;
  return material;
}
