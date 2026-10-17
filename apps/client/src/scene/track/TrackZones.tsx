import type { RaceEvent, Track, TrackZone } from '@circuit-breaker/shared';
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  InstancedMesh,
  MeshBasicMaterial,
  Object3D,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
} from 'three';
import { PALETTE } from '../../game/palette';
import { session } from '../../game/session';
import { ADDITIVE_FOG_GLSL } from '../shaders/chunks';

/** Zones sit a few centimetres above the road so they never fight with its surface. */
const LIFT = 0.04;
/** Glowing posts at both front corners of each pad, so pads read from far down the road. */
const POST_HEIGHT = 1.5;
const POST_SIZE = 0.16;

interface ZoneUniforms {
  uTime: { value: number };
  uColor: { value: Color };
  uLength: { value: number };
  /** Pads: activation flash 0..1. Lanes: 1 while the player drives inside. */
  uLevel: { value: number };
}

type ZoneMaterial = ShaderMaterial & { uniforms: ZoneUniforms };

/** A strip of road surface covering one zone: two columns (its edges), one row per `step` m. */
function buildZoneGeometry(track: Track, zone: TrackZone, step: number): BufferGeometry {
  const rows = Math.max(2, Math.ceil(zone.length / step) + 1);
  const positions = new Float32Array(rows * 2 * 3);
  const uvs = new Float32Array(rows * 2 * 2);
  const p = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < rows; i++) {
    const along = (zone.length * i) / (rows - 1);
    for (let j = 0; j < 2; j++) {
      track.pointAt(zone.s + along, zone.lateral + (j === 0 ? -1 : 1) * zone.halfWidth, p);
      const k = i * 2 + j;
      positions[k * 3] = p.x;
      positions[k * 3 + 1] = p.y + LIFT;
      positions[k * 3 + 2] = p.z;
      uvs[k * 2] = along;
      uvs[k * 2 + 1] = j;
    }
  }
  const index: number[] = [];
  for (let i = 0; i < rows - 1; i++) {
    const a = i * 2;
    index.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
  geometry.setIndex(index);
  geometry.computeBoundingSphere();
  return geometry;
}

const VERTEX = /* glsl */ `
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
`;

/**
 * Boost pad: a lit plate with a bright rim and white-hot chevrons racing forward. It must stand
 * out on every sector colour, including the magenta sector whose road chevrons share its hue.
 */
const PAD_FRAGMENT = /* glsl */ `
  #include <common>
  #include <fog_pars_fragment>
  uniform float uTime;
  uniform vec3 uColor;
  uniform float uLength;
  uniform float uLevel;
  varying vec2 vUv;
  varying float vDepth;
  void main() {
    float across = abs(vUv.y - 0.5) * 2.0;
    float aa = fwidth(across) * 1.5;
    float rim = smoothstep(0.86 - aa, 0.9, across);
    float cap = 1.0 - smoothstep(0.0, 0.45, min(vUv.x, uLength - vUv.x));
    float phase = fract((vUv.x + across * 1.6) / 3.0 - uTime * 1.8);
    float chevron = smoothstep(0.0, 0.06, phase) * (1.0 - smoothstep(0.22, 0.32, phase));
    chevron *= 1.0 - rim;
    // The plate breathes while it waits, so a pad reads as live energy from afar.
    float breathe = 0.82 + 0.18 * sin(uTime * 4.2 - vUv.x * 0.35);
    float plate = (0.3 + rim * 1.0 + cap * 0.6) * breathe;
    vec3 hot = mix(uColor, vec3(1.6), 0.55);
    vec3 color = uColor * plate + hot * chevron * 0.9;
    // Already under the car, it need not shine into the camera.
    float near = mix(0.45, 1.0, smoothstep(3.0, 18.0, vDepth));
    gl_FragColor = vec4(color * (1.0 + uLevel * 1.3) * near, 1.0);
    ${ADDITIVE_FOG_GLSL}
  }
`;

/**
 * Speed lane: a translucent band with solid edges, small arrows and light pulses flowing down
 * it. It must not read as the road's own dashed lane markings.
 */
const LANE_FRAGMENT = /* glsl */ `
  #include <common>
  #include <fog_pars_fragment>
  uniform float uTime;
  uniform vec3 uColor;
  uniform float uLength;
  uniform float uLevel;
  varying vec2 vUv;
  varying float vDepth;
  void main() {
    float across = abs(vUv.y - 0.5) * 2.0;
    float aa = fwidth(across) * 1.5;
    float edge = smoothstep(0.84 - aa, 0.88, across);
    float phase = fract((vUv.x + across * 0.9) / 7.0);
    float arrow = smoothstep(0.0, 0.03, phase) * (1.0 - smoothstep(0.07, 0.11, phase))
      * (1.0 - smoothstep(0.45, 0.55, across));
    float flow = smoothstep(0.75, 1.0, fract(vUv.x / 18.0 - uTime * 1.4)) * (1.0 - edge);
    float ends = smoothstep(0.0, 8.0, vUv.x) * smoothstep(0.0, 8.0, uLength - vUv.x);
    float glow = (0.1 + edge * 0.9 + arrow * 0.55 + flow * 0.5) * ends * (1.0 + uLevel * 1.2);
    // Bright ahead, softer right under the camera, where it would wash over the road.
    glow *= mix(0.35, 1.0, smoothstep(4.0, 26.0, vDepth));
    gl_FragColor = vec4(uColor * glow, 1.0);
    ${ADDITIVE_FOG_GLSL}
  }
`;

function createZoneMaterial(fragmentShader: string, color: Color, length: number): ZoneMaterial {
  return new ShaderMaterial({
    uniforms: UniformsUtils.merge([
      UniformsLib.fog,
      {
        uTime: { value: 0 },
        uColor: { value: color },
        uLength: { value: length },
        uLevel: { value: 0 },
      },
    ]),
    vertexShader: VERTEX,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide,
    fog: true,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -4,
  }) as ZoneMaterial;
}

/**
 * Boost pads (magenta chevrons that flash when a car fires them) and speed lanes (cyan dashed
 * lanes that brighten while the player drives inside one). Geometry and rules both come from
 * the shared Track, so what you see is exactly what triggers.
 */
export function TrackZones() {
  const track = session.track;
  const zones = useMemo(() => {
    const padColor = new Color(PALETTE.magenta).multiplyScalar(1.6);
    const laneColor = new Color('#7fe9ff').multiplyScalar(1.3);
    // Two posts per pad, at its front corners.
    const posts = new InstancedMesh(
      new BoxGeometry(POST_SIZE, POST_HEIGHT, POST_SIZE),
      new MeshBasicMaterial({ color: padColor.clone().multiplyScalar(1.8), toneMapped: false }),
      track.pads.length * 2,
    );
    const dummy = new Object3D();
    const p = { x: 0, y: 0, z: 0 };
    track.pads.forEach((zone, i) => {
      const f = track.frameAt(zone.s);
      for (let side = 0; side < 2; side++) {
        const lateral = zone.lateral + (side === 0 ? -1 : 1) * (zone.halfWidth + 0.3);
        track.pointAt(zone.s, lateral, p);
        dummy.position.set(p.x, p.y + POST_HEIGHT / 2, p.z);
        dummy.rotation.set(0, f.heading, 0);
        dummy.updateMatrix();
        posts.setMatrixAt(i * 2 + side, dummy.matrix);
      }
    });
    posts.instanceMatrix.needsUpdate = true;
    posts.computeBoundingSphere();
    return {
      posts,
      pads: track.pads.map((zone) => ({
        zone,
        geometry: buildZoneGeometry(track, zone, 1),
        material: createZoneMaterial(PAD_FRAGMENT, padColor.clone(), zone.length),
      })),
      lanes: track.lanes.map((zone) => ({
        zone,
        geometry: buildZoneGeometry(track, zone, 2),
        material: createZoneMaterial(LANE_FRAGMENT, laneColor.clone(), zone.length),
      })),
    };
  }, [track]);

  useEffect(() => {
    // Any car's pad flashes, the local one's and (online) everyone else's.
    const flash = (event: RaceEvent) => {
      if (event.type !== 'boostPad') return;
      const pad = zones.pads[event.padId];
      if (pad) pad.material.uniforms.uLevel.value = 1;
    };
    const off = session.onEvent(flash);
    const offRemote = session.onRemoteEvent(flash);
    return () => {
      off();
      offRemote();
    };
  }, [zones]);

  useEffect(
    () => () => {
      for (const z of [...zones.pads, ...zones.lanes]) {
        z.geometry.dispose();
        z.material.dispose();
      }
      zones.posts.geometry.dispose();
      zones.posts.material.dispose();
      zones.posts.dispose();
    },
    [zones],
  );

  useFrame(({ clock }, delta) => {
    const t = clock.elapsedTime;
    for (const pad of zones.pads) {
      const u = pad.material.uniforms;
      u.uTime.value = t;
      u.uLevel.value = Math.max(0, u.uLevel.value - delta * 1.6);
    }
    const v = session.racer.vehicle;
    const lane = v.surface === 'road' ? track.laneAt(v.trackIndex, v.trackS, v.lateral) : -1;
    zones.lanes.forEach((entry, i) => {
      const u = entry.material.uniforms;
      u.uTime.value = t;
      u.uLevel.value += ((lane === i ? 1 : 0) - u.uLevel.value) * Math.min(1, delta * 8);
    });
  }, -2);

  return (
    <group>
      {[...zones.pads, ...zones.lanes].map((z, i) => (
        <mesh key={i} geometry={z.geometry} material={z.material} renderOrder={1} />
      ))}
      <primitive object={zones.posts} />
    </group>
  );
}
