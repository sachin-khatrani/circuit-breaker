import type { Road } from '@circuit-breaker/shared';
import {
  AdditiveBlending,
  Color,
  DoubleSide,
  MeshStandardMaterial,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
} from 'three';
import { ADDITIVE_FOG_GLSL, HEX_GLSL, NOISE_GLSL } from '../shaders/chunks';

export interface TimeUniform {
  uTime: { value: number };
}

/** A colour multiplied into the baked sector colour (white leaves it as built). */
export interface TintUniform extends TimeUniform {
  uTint: { value: Color };
}

/**
 * Road surface: a physically based dark asphalt (so it reflects the neon environment) with
 * procedural markings injected as emissive light. Wet patches lower roughness for streaky
 * reflections.
 */
export function createRoadMaterial(track: Road): MeshStandardMaterial & { userData: TintUniform } {
  const material = new MeshStandardMaterial({
    color: new Color('#0b0c16'),
    roughness: 0.5,
    metalness: 0.45,
    envMapIntensity: 0.55,
  }) as MeshStandardMaterial & { userData: TintUniform };
  // The start line and grid are only painted on the main loop.
  const uniforms = {
    uTime: { value: 0 },
    uTint: { value: new Color(1, 1, 1) },
    uLength: { value: track.length },
    uMarks: { value: track.roadId === 0 ? 1 : 0 },
  };
  material.userData = uniforms;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec3 aRoad;
attribute vec3 aSector;
attribute vec2 aEdge;
varying vec3 vRoad;
varying vec3 vSector;
varying vec2 vEdge;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vRoad = aRoad;
vSector = aSector;
vEdge = aEdge;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uTime;
uniform vec3 uTint;
uniform float uLength;
uniform float uMarks;
varying vec3 vRoad;
varying vec3 vSector;
varying vec2 vEdge;
${NOISE_GLSL}
${HEX_GLSL}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
float grain = valueNoise(vRoad.xy * vec2(0.9, 0.9)) * 0.5 + valueNoise(vRoad.xy * 4.3) * 0.5;
diffuseColor.rgb *= 0.72 + 0.56 * grain;`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
float wet = smoothstep(0.58, 0.82, valueNoise(vRoad.xy * vec2(0.03, 0.11) + 7.3));
roughnessFactor = mix(roughnessFactor, 0.2, wet);`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
{
  float s = vRoad.x;
  float lat = vRoad.y;
  float hw = vRoad.z;
  float aa = max(fwidth(lat), 1e-4);
  float edgeDist = hw - abs(lat);
  float edgeLine = 1.0 - smoothstep(0.11, 0.11 + aa * 1.5, abs(edgeDist - 0.95));
  float kerb = (1.0 - smoothstep(0.6, 0.6 + aa, edgeDist)) * step(0.5, fract(s / 4.0));
  float laneDist = abs(abs(lat) - hw * 0.34);
  float lane = (1.0 - smoothstep(0.07, 0.07 + aa * 1.5, laneDist)) * step(0.55, fract(s / 10.0));
  float chev = fract((s + abs(lat) * 0.9) / 9.0 - uTime * 1.4);
  float chevron = smoothstep(0.0, 0.05, chev) * (1.0 - smoothstep(0.12, 0.18, chev))
    * (1.0 - smoothstep(1.4, 2.2, abs(lat)));
  float hex = 1.0 - smoothstep(0.0, 0.035 + aa, hexEdge(vec2(s, lat) * 0.55));
  vec3 em = vSector * uTint * (edgeLine * 2.4 + kerb * 1.2 + lane * 0.5 + chevron * 0.75 + hex * 0.012);

  // Open (barrier-free) edges: amber hazard chevrons pointing at the drop, slowly pulsing.
  float open = lat < 0.0 ? vEdge.x : vEdge.y;
  if (open > 0.5) {
    float zone = 1.0 - smoothstep(1.4, 1.4 + aa, edgeDist);
    float stripes = step(0.5, fract((s + edgeDist * 1.2) / 2.4));
    float pulse = 0.75 + 0.25 * sin(uTime * 5.0 - s * 0.15);
    em = mix(em, vec3(2.6, 0.75, 0.12) * stripes * pulse, zone);
  }

  // Chequered start/finish line centred on s = 0.
  float toLine = min(s, uLength - s);
  if (toLine < 1.6 && uMarks > 0.5) {
    float checker = mod(floor(s * 1.25) + floor((lat + 64.0) * 1.25), 2.0);
    em += vec3(1.6) * checker;
  }
  // Grid boxes behind the line (two staggered columns, as Track.gridSlot places cars).
  float back = uLength - s;
  if (back > 3.0 && back < 66.0 && uMarks > 0.5) {
    for (int k = 0; k < 8; k++) {
      float row = floor(float(k) / 2.0);
      float col = mod(float(k), 2.0);
      float d = 9.0 + row * 14.0 + col * 7.0;
      float cl = col < 0.5 ? -4.5 : 4.5;
      vec2 q = vec2(abs(lat - cl), back - (d + 1.8));
      vec2 box = vec2(1.7, 3.0);
      vec2 dq = abs(q) - box;
      float outside = max(dq.x, dq.y);
      float outline = 1.0 - smoothstep(0.08, 0.08 + aa * 2.0, abs(outside));
      if (q.y > box.y - 0.2) outline = 0.0;
      em += vec3(0.9, 0.95, 1.0) * outline * 0.9;
    }
  }
  totalEmissiveRadiance += em;
}`,
      );
  };
  material.customProgramCacheKey = () => 'cb-road-v3';
  return material;
}

/** Dark, slightly metallic deck sides and underside. */
export function createDeckMaterial(): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color: new Color('#0c0e18'),
    roughness: 0.6,
    metalness: 0.6,
    side: DoubleSide,
  });
}

/** Translucent hex-pattern energy walls, additive, fading toward the top. */
export function createBarrierMaterial(): ShaderMaterial & { uniforms: TintUniform } {
  return new ShaderMaterial({
    uniforms: UniformsUtils.merge([
      UniformsLib.fog,
      { uTime: { value: 0 }, uTint: { value: new Color(1, 1, 1) } },
    ]),
    vertexShader: /* glsl */ `
      #include <common>
      #include <fog_pars_vertex>
      attribute vec3 aSector;
      varying vec2 vUv;
      varying vec3 vColor;
      void main() {
        vUv = uv;
        vColor = aSector;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <fog_pars_fragment>
      uniform float uTime;
      uniform vec3 uTint;
      varying vec2 vUv;
      varying vec3 vColor;
      ${HEX_GLSL}
      void main() {
        float h = vUv.y;
        vec2 p = vec2(vUv.x * 0.85, h * 2.4 * 0.85);
        float hex = 1.0 - smoothstep(0.0, 0.05, hexEdge(p));
        float fade = pow(1.0 - h, 1.6);
        float scan = smoothstep(0.85, 1.0, fract(h * 1.5 - uTime * 0.45 + vUv.x * 0.004));
        float pulse = smoothstep(0.92, 1.0, fract(vUv.x / 60.0 - uTime * 0.35));
        float top = smoothstep(0.93, 0.985, h) * (1.0 - smoothstep(0.985, 1.0, h));
        float base = 1.0 - smoothstep(0.0, 0.08, h);
        float intensity = 0.02 + hex * 0.16 * fade + scan * 0.1 * fade + pulse * 0.35 * fade
          + top * 0.8 + base * 0.45;
        gl_FragColor = vec4(vColor * uTint * intensity * 1.4, 1.0);
        ${ADDITIVE_FOG_GLSL}
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide,
    fog: true,
  }) as ShaderMaterial & { uniforms: TintUniform };
}

export interface CurtainUniforms extends TimeUniform {
  uColor: { value: Color };
  uActive: { value: number };
  uFlash: { value: number };
}

/** Holographic curtain across a checkpoint gate. */
export function createCurtainMaterial(
  color: Color,
): ShaderMaterial & { uniforms: CurtainUniforms } {
  return new ShaderMaterial({
    uniforms: UniformsUtils.merge([
      UniformsLib.fog,
      {
        uTime: { value: 0 },
        uColor: { value: color },
        uActive: { value: 0 },
        uFlash: { value: 0 },
      },
    ]),
    vertexShader: /* glsl */ `
      #include <common>
      #include <fog_pars_vertex>
      varying vec2 vUv;
      varying float vDepth;
      void main() {
        vUv = uv;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
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
      uniform float uActive;
      uniform float uFlash;
      varying vec2 vUv;
      varying float vDepth;
      void main() {
        float edge = smoothstep(0.035, 0.0, min(min(vUv.x, 1.0 - vUv.x), 1.0 - vUv.y));
        float lines = smoothstep(0.75, 1.0, fract(vUv.y * 26.0 - uTime * 1.2));
        float sweep = smoothstep(0.9, 1.0, fract(vUv.x * 0.5 + uTime * 0.25));
        float fade = smoothstep(0.0, 0.25, vUv.y) * 0.6 + 0.4;
        float a = (0.04 + lines * 0.08 + sweep * 0.1) * fade * (0.25 + uActive * 0.75) + edge * 0.5;
        // A crossing lights the frame and a thin veil, not the whole plane.
        a += uFlash * (0.12 + edge * 1.2 + lines * 0.2);
        // The camera drives through the curtain right behind the car: fade it out up close,
        // so it never fills the screen.
        a *= smoothstep(3.0, 24.0, vDepth);
        gl_FragColor = vec4(uColor * a, 1.0);
        ${ADDITIVE_FOG_GLSL}
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide,
    fog: true,
  }) as ShaderMaterial & { uniforms: CurtainUniforms };
}

/**
 * Neon rails and light strips: the sector colour breathes, and bright energy pulses race along
 * the track in the driving direction (uv.x is the arc length in metres).
 */
export function createPulseMaterial(): ShaderMaterial & { uniforms: TintUniform } {
  return new ShaderMaterial({
    uniforms: UniformsUtils.merge([
      UniformsLib.fog,
      { uTime: { value: 0 }, uTint: { value: new Color(1, 1, 1) } },
    ]),
    vertexShader: /* glsl */ `
      #include <common>
      #include <fog_pars_vertex>
      attribute vec3 aSector;
      varying vec3 vColor;
      varying float vS;
      void main() {
        vColor = aSector;
        vS = uv.x;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <fog_pars_fragment>
      uniform float uTime;
      uniform vec3 uTint;
      varying vec3 vColor;
      varying float vS;
      void main() {
        float pulse = smoothstep(0.86, 1.0, fract(vS / 46.0 - uTime * 0.9));
        float fast = smoothstep(0.94, 1.0, fract(vS / 13.0 - uTime * 2.4)) * 0.35;
        float breathe = 0.88 + 0.12 * sin(uTime * 1.7 + vS * 0.02);
        gl_FragColor = vec4(vColor * uTint * (breathe + pulse * 2.2 + fast), 1.0);
        #include <fog_fragment>
      }
    `,
    side: DoubleSide,
    fog: true,
  }) as ShaderMaterial & { uniforms: TintUniform };
}
