import {
  AdditiveBlending,
  CanvasTexture,
  Color,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  ShaderMaterial,
  SRGBColorSpace,
  UniformsLib,
  UniformsUtils,
} from 'three';
import { ADDITIVE_FOG_GLSL, HEX_GLSL } from '../shaders/chunks';

/** Route colours: open, shut, and changing (the same language on the track and in the HUD). */
export const ROUTE_OPEN = new Color('#2bff9e');
export const ROUTE_LOCKED = new Color('#ff3b4f');
export const ROUTE_CHANGING = new Color('#ffb02e');
export const SPLIT_COLOR = new Color('#8a5cff');

export interface RouteBarrierUniforms {
  uTime: { value: number };
  uColor: { value: Color };
  /** How far the barrier stands up: 0 down (open), 1 fully up (shut). */
  uLevel: { value: number };
  /** Warning flash, 0..1. */
  uFlash: { value: number };
}

/**
 * A barrier that rises and sinks: an energy wall with hazard stripes, visible up to `uLevel`
 * of its height, with a bright moving edge at the top. uv.x is metres along it, uv.y 0 → 1
 * bottom to top.
 */
export function createRouteBarrierMaterial(
  color: Color,
): ShaderMaterial & { uniforms: RouteBarrierUniforms } {
  return new ShaderMaterial({
    uniforms: UniformsUtils.merge([
      UniformsLib.fog,
      {
        uTime: { value: 0 },
        uColor: { value: color.clone() },
        uLevel: { value: 1 },
        uFlash: { value: 0 },
      },
    ]),
    vertexShader: /* glsl */ `
      #include <common>
      #include <fog_pars_vertex>
      varying vec2 vUv;
      void main() {
        vUv = uv;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <fog_pars_fragment>
      uniform float uTime;
      uniform vec3 uColor;
      uniform float uLevel;
      uniform float uFlash;
      varying vec2 vUv;
      ${HEX_GLSL}
      void main() {
        float h = vUv.y;
        if (h > uLevel + 0.002 || uLevel < 0.01) discard;
        float hex = 1.0 - smoothstep(0.0, 0.06, hexEdge(vec2(vUv.x * 0.8, h * 2.2)));
        float stripes = step(0.5, fract((vUv.x + h * 2.4) / 1.6));
        float edge = smoothstep(uLevel - 0.06, uLevel, h);
        float base = 1.0 - smoothstep(0.0, 0.1, h);
        float scan = smoothstep(0.8, 1.0, fract(h * 2.0 - uTime * 0.8));
        float a = 0.05 + hex * 0.22 + stripes * 0.16 + scan * 0.1 + edge * 1.1 + base * 0.5;
        a *= 0.75 + 0.25 * sin(uTime * 6.0 + vUv.x * 0.4);
        a += uFlash * 0.45;
        gl_FragColor = vec4(uColor * a * 1.5, 1.0);
        ${ADDITIVE_FOG_GLSL}
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide,
    fog: true,
  }) as ShaderMaterial & { uniforms: RouteBarrierUniforms };
}

export interface ArrowUniforms {
  uTime: { value: number };
  uColor: { value: Color };
  /** 0 hidden, 1 fully lit. */
  uLevel: { value: number };
}

/**
 * Animated chevrons painted on the road, pointing along +uv.x (metres) and leaning toward
 * uv.y = 1 (the side the route turns to). Additive, flush with the surface.
 */
export function createArrowMaterial(color: Color): ShaderMaterial & { uniforms: ArrowUniforms } {
  return new ShaderMaterial({
    uniforms: UniformsUtils.merge([
      UniformsLib.fog,
      { uTime: { value: 0 }, uColor: { value: color.clone() }, uLevel: { value: 0 } },
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
      uniform float uLevel;
      varying vec2 vUv;
      varying float vDepth;
      void main() {
        if (uLevel < 0.01) discard;
        float across = vUv.y;
        float c = fract((vUv.x - abs(across - 0.5) * 3.0) / 5.0 - uTime * 1.6);
        float chevron = smoothstep(0.0, 0.08, c) * (1.0 - smoothstep(0.28, 0.4, c));
        float sides = smoothstep(0.0, 0.15, across) * (1.0 - smoothstep(0.85, 1.0, across));
        // Bright ahead, softer right under the car, where they would wash over the road.
        float near = mix(0.35, 1.0, smoothstep(4.0, 24.0, vDepth));
        float a = chevron * sides * uLevel * near;
        gl_FragColor = vec4(uColor * a * 1.6, 1.0);
        ${ADDITIVE_FOG_GLSL}
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    fog: true,
  }) as ShaderMaterial & { uniforms: ArrowUniforms };
}

/**
 * A glowing sign: a plane with a canvas texture redrawn only when its text or colour changes.
 */
export class SignBoard {
  readonly mesh: Mesh;
  private readonly canvas: HTMLCanvasElement;
  private readonly texture: CanvasTexture;
  private readonly material: MeshBasicMaterial;
  private key = '';

  constructor(width: number, height: number, pixels = 256) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = pixels;
    this.canvas.height = Math.round((pixels * height) / width);
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.material = new MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      toneMapped: false,
      side: DoubleSide,
      depthWrite: false,
    });
    this.mesh = new Mesh(new PlaneGeometry(width, height), this.material);
    this.mesh.renderOrder = 5;
  }

  /** Draws up to two lines (a big one and a small one) in `color`; cheap when unchanged. */
  draw(big: string, small: string, color: string, glyph: 'arrow' | 'cross' | null = null): void {
    const key = `${big}|${small}|${color}|${glyph}`;
    if (key === this.key) return;
    this.key = key;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(7, 9, 24, 0.82)';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(3, w / 64);
    ctx.strokeRect(ctx.lineWidth, ctx.lineWidth, w - ctx.lineWidth * 2, h - ctx.lineWidth * 2);
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    if (glyph === 'arrow') {
      // A downward arrow: "this lane".
      const cx = w / 2;
      const top = h * 0.12;
      const bottom = small ? h * 0.62 : h * 0.86;
      ctx.lineWidth = w / 12;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(cx, top);
      ctx.lineTo(cx, bottom);
      ctx.moveTo(cx - w * 0.2, bottom - h * 0.22);
      ctx.lineTo(cx, bottom);
      ctx.lineTo(cx + w * 0.2, bottom - h * 0.22);
      ctx.stroke();
    } else if (glyph === 'cross') {
      const cx = w / 2;
      const cy = small ? h * 0.38 : h / 2;
      const r = Math.min(w, h) * 0.24;
      ctx.lineWidth = w / 12;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(cx - r, cy - r);
      ctx.lineTo(cx + r, cy + r);
      ctx.moveTo(cx + r, cy - r);
      ctx.lineTo(cx - r, cy + r);
      ctx.stroke();
    } else if (big) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `900 ${Math.round(h * (small ? 0.38 : 0.5))}px Orbitron, "Arial Black", sans-serif`;
      ctx.fillText(big, w / 2, small ? h * 0.38 : h / 2, w * 0.9);
    }
    if (small) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `700 ${Math.round(h * 0.2)}px Rajdhani, "Arial Narrow", sans-serif`;
      ctx.fillText(small, w / 2, h * 0.8, w * 0.9);
    }
    this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
  }
}
