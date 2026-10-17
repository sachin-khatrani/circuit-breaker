import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import {
  Color,
  DoubleSide,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  PlaneGeometry,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
  Vector3,
} from 'three';
import { session } from '../../game/session';
import { useGameStore } from '../../game/store';
import { BARRIER_OFFSET, sectorColorAt } from './trackGeometry';

/** Corners tighter than this radius get chevron boards on their outside (metres). */
const MAX_RADIUS = 75;
/** Board spacing along the barrier, and how far before and after the corner they run. */
const SPACING = 9;
const LEAD_IN = 14;
const LEAD_OUT = 6;
const WIDTH = 2.4;
const HEIGHT = 1.3;

/**
 * Chevron boards along the outside barrier of the tight corners: they point the way the road
 * turns, and a soft light runs along them in the driving direction, so the line through a
 * corner reads from its entry. Placed only where the outside edge has a wall (never on an
 * opening, a barrier-free edge, in a tunnel or on the split), just behind the barrier: purely
 * visual, nothing to collide with.
 */
export function TurnMarkers() {
  const track = session.track;
  const reducedMotion = useGameStore((s) => s.reducedMotion);
  const mesh = useMemo(() => {
    const boards: { s: number; side: number; phase: number }[] = [];
    const kMin = 1 / MAX_RADIUS;
    let i = 0;
    while (i < track.count) {
      const k = track.curvature[i];
      if (Math.abs(k) < kMin) {
        i++;
        continue;
      }
      const sign = Math.sign(k);
      let j = i;
      while (j + 1 < track.count && Math.sign(track.curvature[j + 1]) === sign) {
        if (Math.abs(track.curvature[j + 1]) < kMin * 0.6) break;
        j++;
      }
      const from = i * track.spacing - LEAD_IN;
      const to = j * track.spacing + LEAD_OUT;
      if (to - from > 20) {
        // Positive curvature turns left: the outside is on the right (positive lateral).
        for (let s = from; s <= to; s += SPACING) {
          boards.push({ s, side: sign, phase: (s - from) / 32 });
        }
      }
      i = j + 1;
    }

    const kept: { s: number; side: number; phase: number }[] = [];
    for (const b of boards) {
      const index = Math.floor(track.wrapS(b.s) / track.spacing) % track.count;
      const edge = b.side * track.halfWidth[index];
      if (!track.hasWall(index, edge)) continue;
      if (track.portalAt(index, edge) >= 0) continue;
      if (track.roof[index] > 0 || track.splitAt(index) >= 0) continue;
      kept.push(b);
    }

    const geometry = new PlaneGeometry(WIDTH, HEIGHT);
    const phases = new Float32Array(kept.length);
    const colors = new Float32Array(kept.length * 3);
    const material = new ShaderMaterial({
      uniforms: UniformsUtils.merge([
        UniformsLib.fog,
        { uTime: { value: 0 }, uMotion: { value: 1 } },
      ]),
      vertexShader: /* glsl */ `
        #include <common>
        #include <fog_pars_vertex>
        attribute float aPhase;
        attribute vec3 aColor;
        varying vec2 vUv;
        varying float vPhase;
        varying vec3 vColor;
        void main() {
          vUv = uv;
          vPhase = aPhase;
          vColor = aColor;
          vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }
      `,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <fog_pars_fragment>
        uniform float uTime;
        uniform float uMotion;
        varying vec2 vUv;
        varying float vPhase;
        varying vec3 vColor;
        void main() {
          // Two chevrons whose tips point along +x, the driving direction.
          float across = abs(vUv.y - 0.5) * 2.0;
          float c = fract(vUv.x * 2.0 + across * 0.42);
          float chevron = smoothstep(0.0, 0.07, c) * (1.0 - smoothstep(0.3, 0.38, c));
          chevron *= 1.0 - smoothstep(0.78, 0.9, across);
          float border = min(min(vUv.x, 1.0 - vUv.x), min(vUv.y, 1.0 - vUv.y));
          float frame = 1.0 - smoothstep(0.02, 0.05, border);
          float chase = smoothstep(0.65, 1.0, fract(uTime * 0.9 - vPhase));
          float level = mix(0.95, 0.55 + 1.5 * chase, uMotion);
          vec3 color = vec3(0.012, 0.014, 0.03) + vColor * (chevron * level + frame * 0.45);
          gl_FragColor = vec4(color, 1.0);
          #include <fog_fragment>
        }
      `,
      side: DoubleSide,
      fog: true,
    });
    const instanced = new InstancedMesh(geometry, material, Math.max(1, kept.length));
    instanced.count = kept.length;
    const f = track.frameAt(0);
    const centre = new Vector3();
    const x = new Vector3();
    const y = new Vector3(0, 1, 0);
    const z = new Vector3();
    const m = new Matrix4();
    const color = new Color();
    kept.forEach((b, n) => {
      track.frameAt(b.s, f);
      const lateral = b.side * (f.halfWidth + BARRIER_OFFSET + 0.15);
      track.pointAt(b.s, b.side * f.halfWidth, centre);
      const baseY = centre.y;
      track.pointAt(b.s, lateral, centre);
      centre.y = baseY + 0.25 + HEIGHT / 2;
      x.set(f.fx, 0, f.fz).normalize();
      z.crossVectors(x, y);
      m.makeBasis(x, y, z).setPosition(centre);
      instanced.setMatrixAt(n, m);
      phases[n] = b.phase;
      sectorColorAt(track, b.s, color).multiplyScalar(1.6);
      colors.set([color.r, color.g, color.b], n * 3);
    });
    geometry.setAttribute('aPhase', new InstancedBufferAttribute(phases, 1));
    geometry.setAttribute('aColor', new InstancedBufferAttribute(colors, 3));
    instanced.instanceMatrix.needsUpdate = true;
    instanced.frustumCulled = false;
    return instanced;
  }, [track]);

  useEffect(() => {
    mesh.material.uniforms.uMotion.value = reducedMotion ? 0 : 1;
  }, [mesh, reducedMotion]);

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
