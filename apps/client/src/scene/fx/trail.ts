import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  Mesh,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
  Vector3,
} from 'three';
import { ADDITIVE_FOG_GLSL } from '../shaders/chunks';

const POINTS = 22;
const SAMPLE_INTERVAL = 1 / 60;

/**
 * Camera-facing light ribbon behind a thruster. Points are sampled at a fixed 60 Hz, so the
 * trail's length scales with speed regardless of the display refresh rate.
 */
export class LightTrail {
  readonly mesh: Mesh;
  private readonly points = new Float32Array(POINTS * 3);
  private count = 0;
  private sinceSample = 0;
  private readonly positions: Float32Array;
  private readonly alphas: Float32Array;
  private readonly material: ShaderMaterial;
  private readonly dir = new Vector3();
  private readonly toCam = new Vector3();
  private readonly side = new Vector3();

  constructor(color: Color) {
    const geometry = new BufferGeometry();
    this.positions = new Float32Array(POINTS * 2 * 3);
    this.alphas = new Float32Array(POINTS * 2);
    geometry.setAttribute(
      'position',
      new BufferAttribute(this.positions, 3).setUsage(DynamicDrawUsage),
    );
    geometry.setAttribute('aAlpha', new BufferAttribute(this.alphas, 1).setUsage(DynamicDrawUsage));
    const index: number[] = [];
    for (let i = 0; i < POINTS - 1; i++) {
      const a = i * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    geometry.setIndex(index);
    geometry.setDrawRange(0, 0);
    this.material = new ShaderMaterial({
      uniforms: UniformsUtils.merge([UniformsLib.fog, { uColor: { value: color } }]),
      vertexShader: /* glsl */ `
        #include <common>
        #include <fog_pars_vertex>
        attribute float aAlpha;
        varying float vAlpha;
        void main() {
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          // Fade the part of the ribbon that passes near the lens, or it fills the screen.
          vAlpha = aAlpha * smoothstep(3.0, 11.0, -mvPosition.z);
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }
      `,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <fog_pars_fragment>
        uniform vec3 uColor;
        varying float vAlpha;
        void main() {
          gl_FragColor = vec4(uColor * vAlpha, 1.0);
          ${ADDITIVE_FOG_GLSL}
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      fog: true,
    });
    this.mesh = new Mesh(geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
  }

  get color(): Color {
    return this.material.uniforms.uColor.value as Color;
  }

  clear(): void {
    this.count = 0;
    this.mesh.geometry.setDrawRange(0, 0);
  }

  /** Feeds the current nozzle position; the newest point always tracks it exactly. */
  update(head: Vector3, camera: Vector3, dt: number, width: number, intensity: number): void {
    const p = this.points;
    this.sinceSample += dt;
    if (this.count === 0) {
      p[0] = head.x;
      p[1] = head.y;
      p[2] = head.z;
      this.count = 1;
    }
    if (this.sinceSample >= SAMPLE_INTERVAL) {
      this.sinceSample %= SAMPLE_INTERVAL;
      p.copyWithin(3, 0, (POINTS - 1) * 3);
      this.count = Math.min(POINTS, this.count + 1);
    }
    p[0] = head.x;
    p[1] = head.y;
    p[2] = head.z;

    const n = this.count;
    if (n < 2 || intensity <= 0.001) {
      this.mesh.geometry.setDrawRange(0, 0);
      return;
    }
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1);
      const b = Math.min(n - 1, i + 1);
      this.dir.set(p[a * 3] - p[b * 3], p[a * 3 + 1] - p[b * 3 + 1], p[a * 3 + 2] - p[b * 3 + 2]);
      this.toCam.set(camera.x - p[i * 3], camera.y - p[i * 3 + 1], camera.z - p[i * 3 + 2]);
      this.side.crossVectors(this.dir, this.toCam);
      const len = this.side.length();
      const t = i / (n - 1);
      const w = (width * (1 - t * 0.85)) / 2;
      if (len > 1e-5) this.side.multiplyScalar(w / len);
      else this.side.set(0, w, 0);
      const k = i * 6;
      this.positions[k] = p[i * 3] + this.side.x;
      this.positions[k + 1] = p[i * 3 + 1] + this.side.y;
      this.positions[k + 2] = p[i * 3 + 2] + this.side.z;
      this.positions[k + 3] = p[i * 3] - this.side.x;
      this.positions[k + 4] = p[i * 3 + 1] - this.side.y;
      this.positions[k + 5] = p[i * 3 + 2] - this.side.z;
      const alpha = Math.pow(1 - t, 1.4) * intensity;
      this.alphas[i * 2] = alpha;
      this.alphas[i * 2 + 1] = alpha;
    }
    const geometry = this.mesh.geometry;
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.aAlpha.needsUpdate = true;
    geometry.setDrawRange(0, (n - 1) * 6);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
