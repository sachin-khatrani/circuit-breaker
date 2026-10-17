import {
  AdditiveBlending,
  Color,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  PlaneGeometry,
  Quaternion,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
  Vector3,
} from 'three';
import { ADDITIVE_FOG_GLSL } from '../shaders/chunks';

const CAPACITY = 640;
const LIFETIME = 3.2;
const MIN_SEGMENT = 0.25;
const MAX_SEGMENT = 6;

/**
 * Glowing tyre marks left by a drift: a ring buffer of flat quads, each segment joining two
 * wheel positions. Fading happens in the shader from each segment's birth time, so the CPU
 * only writes when a segment is added. One draw call for every mark on the track.
 */
export class DriftMarks {
  readonly mesh: InstancedMesh;
  private readonly material: ShaderMaterial;
  private readonly births: InstancedBufferAttribute;
  private readonly colors: InstancedBufferAttribute;
  private readonly last: (Vector3 | null)[] = [null, null];
  private cursor = 0;
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly pos = new Vector3();
  private readonly scale = new Vector3();
  private readonly up = new Vector3(0, 1, 0);

  constructor() {
    const geometry = new PlaneGeometry(1, 1);
    geometry.rotateX(-Math.PI / 2);
    this.births = new InstancedBufferAttribute(new Float32Array(CAPACITY).fill(-1e4), 1);
    this.colors = new InstancedBufferAttribute(new Float32Array(CAPACITY * 3), 3);
    geometry.setAttribute('aBirth', this.births);
    geometry.setAttribute('aColor', this.colors);
    this.material = new ShaderMaterial({
      uniforms: UniformsUtils.merge([UniformsLib.fog, { uTime: { value: 0 } }]),
      vertexShader: /* glsl */ `
        #include <common>
        #include <fog_pars_vertex>
        uniform float uTime;
        attribute float aBirth;
        attribute vec3 aColor;
        varying float vAlpha;
        varying vec3 vColor;
        varying float vAcross;
        void main() {
          float age = uTime - aBirth;
          vAlpha = clamp(1.0 - age / ${LIFETIME.toFixed(1)}, 0.0, 1.0);
          vColor = aColor;
          vAcross = position.x;
          vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }
      `,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <fog_pars_fragment>
        varying float vAlpha;
        varying vec3 vColor;
        varying float vAcross;
        void main() {
          if (vAlpha <= 0.0) discard;
          float edge = 1.0 - smoothstep(0.2, 0.5, abs(vAcross));
          gl_FragColor = vec4(vColor * vAlpha * vAlpha * edge, 1.0);
          ${ADDITIVE_FOG_GLSL}
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      fog: true,
    });
    this.mesh = new InstancedMesh(geometry, this.material, CAPACITY);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
  }

  set time(t: number) {
    this.material.uniforms.uTime.value = t;
  }

  /** Extends wheel `wheel`'s mark to `point`; a long jump starts a new mark instead. */
  add(wheel: number, point: Vector3, width: number, color: Color, time: number): void {
    const prev = this.last[wheel];
    if (!prev) {
      this.last[wheel] = point.clone();
      return;
    }
    const d = prev.distanceTo(point);
    if (d < MIN_SEGMENT) return;
    if (d > MAX_SEGMENT) {
      prev.copy(point);
      return;
    }
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % CAPACITY;
    this.pos.addVectors(prev, point).multiplyScalar(0.5);
    this.pos.y += 0.04;
    this.q.setFromAxisAngle(this.up, Math.atan2(point.x - prev.x, point.z - prev.z));
    this.scale.set(width, 1, d + 0.05);
    this.m.compose(this.pos, this.q, this.scale);
    this.mesh.setMatrixAt(i, this.m);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.births.setX(i, time);
    this.births.needsUpdate = true;
    this.colors.setXYZ(i, color.r, color.g, color.b);
    this.colors.needsUpdate = true;
    prev.copy(point);
  }

  /** Ends the current mark of a wheel (the next point starts a fresh one). */
  lift(wheel: number): void {
    this.last[wheel] = null;
  }

  clear(): void {
    this.births.array.fill(-1e4);
    this.births.needsUpdate = true;
    this.last.fill(null);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.mesh.dispose();
  }
}
