import {
  AdditiveBlending,
  BoxGeometry,
  CircleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Euler,
  ExtrudeGeometry,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  Shape,
  ShaderMaterial,
  SphereGeometry,
  TorusGeometry,
  Vector3,
  type BufferGeometry,
  type Material,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  createFadeTexture,
  createGlowTexture,
  createRingTexture,
  createSoftSpotTexture,
} from '../textures';

/** Exhaust nozzle centres in car space (x, y, z): trails, flames and boost particles. */
export const EXHAUSTS: readonly [number, number, number][] = [
  [-0.34, 0.44, -2.36],
  [0.34, 0.44, -2.36],
];

export interface WheelRig {
  /** Positioned at the axle; steering yaw applies here (front wheels). */
  pivot: Group;
  /** Child of `pivot`; rolling rotation about the axle applies here. */
  spin: Group;
  radius: number;
  front: boolean;
}

export interface CarModel {
  root: Group;
  /** The sprung body: suspension pitch and roll apply here, the wheels stay planted. */
  body: Group;
  wheels: WheelRig[];
  accent: Color;
  neonMaterial: MeshBasicMaterial;
  rimMaterial: MeshBasicMaterial;
  /** Bright rim markers: they make the rotation readable at low and medium speed. */
  markerMaterial: MeshBasicMaterial;
  /** Rim motion-blur discs, faded in as the wheels spin up (no wagon-wheel aliasing). */
  blurMaterial: MeshBasicMaterial;
  thrusterMaterial: MeshBasicMaterial;
  flameMaterial: MeshBasicMaterial;
  flames: Mesh[];
  underglow: Mesh;
  underglowMaterial: MeshBasicMaterial;
  brakeMaterial: MeshBasicMaterial;
  reverseMaterial: MeshBasicMaterial;
  headlightMaterial: MeshBasicMaterial;
  beamMaterial: ShaderMaterial;
  /** Contact shadow under the body and wheels. */
  shadowMaterial: MeshBasicMaterial;
  /** Every opaque surface (body, glass, tyres, lights): what a ghost fade must reach. */
  solidMaterials: Material[];
  /** Strength of the body's rim light in the car's colour (raise it for a boost). */
  hullRim: { value: number };
  dispose: () => void;
}

/** Rim light strength at rest. */
export const HULL_RIM = 0.55;

/**
 * A fresnel rim in the car's own colour on the painted body: the dark metallic hull mostly
 * mirrors a dark city, and the rim keeps its silhouette readable against it at any distance.
 */
function addHullRim(material: MeshPhysicalMaterial, color: Color): { value: number } {
  const strength = { value: HULL_RIM };
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uRimColor = { value: color };
    shader.uniforms.uRimStrength = strength;
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform vec3 uRimColor;
uniform float uRimStrength;`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
{
  float facing = clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
  totalEmissiveRadiance += uRimColor * pow(1.0 - facing, 3.0) * uRimStrength;
}`,
      );
  };
  material.customProgramCacheKey = () => 'cb-hull-rim';
  return strength;
}

const FRONT_AXLE = 1.42;
const REAR_AXLE = -1.38;
const TRACK_HALF = 0.98;

/** Side profile (z forward, y up) of the fuselage, extruded across the car's width. */
function fuselageGeometry(): BufferGeometry {
  const s = new Shape();
  s.moveTo(2.3, 0.2);
  s.quadraticCurveTo(2.5, 0.26, 2.42, 0.36);
  s.quadraticCurveTo(1.6, 0.5, 0.6, 0.76);
  s.quadraticCurveTo(0.0, 0.92, -0.6, 0.94);
  s.lineTo(-1.7, 0.86);
  s.quadraticCurveTo(-2.3, 0.82, -2.38, 0.64);
  s.lineTo(-2.4, 0.34);
  s.quadraticCurveTo(-2.32, 0.18, -2.0, 0.16);
  s.lineTo(1.8, 0.14);
  s.quadraticCurveTo(2.2, 0.15, 2.3, 0.2);

  const width = 1.16;
  const geometry = new ExtrudeGeometry(s, {
    depth: width,
    bevelEnabled: true,
    bevelThickness: 0.12,
    bevelSize: 0.09,
    bevelSegments: 3,
    curveSegments: 10,
  });
  // Shape x → world z (forward), extrusion → world x (across), centred.
  geometry.rotateY(-Math.PI / 2);
  geometry.translate(width / 2, 0, 0);
  // Taper the nose and tail in plan view so the body reads as a dart, not a slab.
  const pos = geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const z = pos.getZ(i);
    const nose = Math.min(1, Math.max(0, (z - 0.7) / 1.8));
    const tail = Math.min(1, Math.max(0, (-z - 1.6) / 0.8));
    pos.setX(i, pos.getX(i) * (1 - 0.45 * nose * nose - 0.12 * tail));
  }
  geometry.computeVertexNormals();
  return geometry;
}

/** Groups geometry by material and merges each group into one mesh (few draw calls). */
class PartBuilder {
  private readonly buckets = new Map<Material, BufferGeometry[]>();
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly e = new Euler();

  add(
    geometry: BufferGeometry,
    material: Material,
    position: readonly [number, number, number],
    rotation: readonly [number, number, number] = [0, 0, 0],
  ): void {
    const g = geometry.index ? geometry.toNonIndexed() : geometry;
    if (g !== geometry) geometry.dispose();
    for (const name of Object.keys(g.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
    }
    g.clearGroups();
    this.e.set(rotation[0], rotation[1], rotation[2]);
    this.q.setFromEuler(this.e);
    this.m.compose(new Vector3(...position), this.q, new Vector3(1, 1, 1));
    g.applyMatrix4(this.m);
    const list = this.buckets.get(material) ?? [];
    list.push(g);
    this.buckets.set(material, list);
  }

  build(parent: Group, geometries: BufferGeometry[]): void {
    for (const [material, list] of this.buckets) {
      const merged = mergeGeometries(list, false);
      for (const g of list) g.dispose();
      if (!merged) continue;
      geometries.push(merged);
      parent.add(new Mesh(merged, material));
    }
    this.buckets.clear();
  }
}

/**
 * Procedural electric racer: a dart-shaped fuselage on four open wheels with neon rims, fender
 * pods, a glass canopy, LED head and brake lights, twin exhausts and underglow. `style` picks
 * the body kit (VEHICLE_STYLES): Dart has a low rear wing, Apex a tall wing with end plates
 * and a dorsal fin, Brute a ducktail spoiler, armoured side pods and a roof light bar. Kits are
 * cosmetic: the wheels, lights and exhausts sit in the same places on every car.
 */
export function buildCarModel(accentHex: string, style = 0): CarModel {
  const accent = new Color(accentHex);
  const geometries: BufferGeometry[] = [];
  const materials: Material[] = [];
  const own = <T extends Material>(material: T): T => {
    materials.push(material);
    return material;
  };

  const hull = own(
    new MeshPhysicalMaterial({
      color: new Color('#3a4766'),
      metalness: 0.78,
      roughness: 0.26,
      clearcoat: 1,
      clearcoatRoughness: 0.08,
      envMapIntensity: 2.4,
    }),
  );
  const hullRim = addHullRim(hull, accent);
  const trim = own(
    new MeshStandardMaterial({ color: new Color('#0b0d14'), metalness: 0.6, roughness: 0.45 }),
  );
  const glass = own(
    new MeshPhysicalMaterial({
      color: new Color('#03050b'),
      metalness: 0.3,
      roughness: 0.05,
      clearcoat: 1,
      envMapIntensity: 2.4,
    }),
  );
  const tire = own(
    new MeshStandardMaterial({ color: new Color('#0d0e12'), metalness: 0.1, roughness: 0.85 }),
  );
  const rimMetal = own(
    new MeshStandardMaterial({ color: new Color('#1d2333'), metalness: 0.9, roughness: 0.3 }),
  );
  const neonMaterial = own(
    new MeshBasicMaterial({ color: accent.clone().multiplyScalar(4), toneMapped: false }),
  );
  const rimMaterial = own(
    new MeshBasicMaterial({ color: accent.clone().multiplyScalar(3.5), toneMapped: false }),
  );
  const markerMaterial = own(
    new MeshBasicMaterial({ color: new Color('#ffffff').multiplyScalar(3), toneMapped: false }),
  );
  const ring = createRingTexture();
  const blurMaterial = own(
    new MeshBasicMaterial({
      map: ring,
      color: accent.clone().multiplyScalar(1.6),
      transparent: true,
      opacity: 0,
      blending: AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  const spot = createSoftSpotTexture();
  const shadowMaterial = own(
    new MeshBasicMaterial({
      color: new Color('#000000'),
      alphaMap: spot,
      transparent: true,
      opacity: 0.8,
      depthWrite: false,
    }),
  );
  const headlightMaterial = own(
    new MeshBasicMaterial({ color: new Color('#dff8ff').multiplyScalar(6), toneMapped: false }),
  );
  const brakeMaterial = own(
    new MeshBasicMaterial({ color: new Color('#ff2b4f').multiplyScalar(2), toneMapped: false }),
  );
  const reverseMaterial = own(
    new MeshBasicMaterial({ color: new Color('#ffffff').multiplyScalar(0.4), toneMapped: false }),
  );
  const thrusterMaterial = own(
    new MeshBasicMaterial({ color: accent.clone().multiplyScalar(3), toneMapped: false }),
  );
  const fade = createFadeTexture();
  const flameMaterial = own(
    new MeshBasicMaterial({
      color: accent.clone().multiplyScalar(2.5),
      alphaMap: fade,
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
      side: DoubleSide,
    }),
  );
  const glow = createGlowTexture();
  const underglowMaterial = own(
    new MeshBasicMaterial({
      map: glow,
      color: accent.clone().multiplyScalar(1.4),
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  const beamMaterial = own(
    new ShaderMaterial({
      uniforms: { uIntensity: { value: 1 }, uColor: { value: new Color('#bfefff') } },
      vertexShader: /* glsl */ `
        varying float vAlong;
        varying vec3 vN;
        varying vec3 vV;
        void main() {
          vAlong = position.y;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vN = normalize(normalMatrix * normal);
          vV = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uIntensity;
        uniform vec3 uColor;
        varying float vAlong;
        varying vec3 vN;
        varying vec3 vV;
        void main() {
          float core = pow(abs(dot(normalize(vN), normalize(vV))), 1.5);
          float a = pow(1.0 - clamp(vAlong, 0.0, 1.0), 1.8) * core * 0.11 * uIntensity;
          gl_FragColor = vec4(uColor * a, 1.0);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
    }),
  );

  const root = new Group();
  root.name = 'car';
  const body = new Group();
  root.add(body);

  // --- Sprung body, merged per material --------------------------------------------------
  const parts = new PartBuilder();
  const box = (w: number, h: number, d: number) => new BoxGeometry(w, h, d);
  parts.add(fuselageGeometry(), hull, [0, 0, 0]);
  for (const side of [-1, 1]) {
    const x = side * TRACK_HALF;
    // Fender pods arching over each wheel: partial cylinders around the axle line.
    const front = new CylinderGeometry(0.47, 0.47, 0.42, 20, 1, true, -0.35, Math.PI + 0.7);
    parts.add(front, hull, [x, 0.36, FRONT_AXLE], [0, 0, Math.PI / 2]);
    const rear = new CylinderGeometry(0.51, 0.51, 0.48, 20, 1, true, -0.35, Math.PI + 0.7);
    parts.add(rear, hull, [x, 0.39, REAR_AXLE], [0, 0, Math.PI / 2]);
    // Side pods joining the fenders, with a neon line on the outer face.
    parts.add(box(0.4, 0.26, 1.7), hull, [side * 0.84, 0.32, 0.02]);
    parts.add(box(0.05, 0.05, 1.6), neonMaterial, [side * 1.05, 0.34, 0.02]);
    // Strakes from the pods to the nose.
    parts.add(box(0.05, 0.035, 1.2), neonMaterial, [side * 0.62, 0.32, 1.55], [0, side * 0.2, 0]);
    // Headlights: LED bars in the nose plus a running-light dot.
    parts.add(
      box(0.4, 0.045, 0.05),
      headlightMaterial,
      [side * 0.42, 0.36, 2.2],
      [0, side * 0.32, 0],
    );
    parts.add(box(0.08, 0.08, 0.04), headlightMaterial, [side * 0.18, 0.28, 2.34]);
    // Brake lamps, reverse lamps, exhaust housings.
    parts.add(box(0.06, 0.24, 0.05), brakeMaterial, [side * 0.7, 0.56, -2.4]);
    parts.add(box(0.16, 0.06, 0.04), reverseMaterial, [side * 0.42, 0.42, -2.41]);
    parts.add(
      new CylinderGeometry(0.16, 0.19, 0.3, 18),
      trim,
      [side * 0.34, 0.44, -2.27],
      [Math.PI / 2, 0, 0],
    );
  }
  // Front splitter with a neon leading edge.
  parts.add(box(2.0, 0.045, 0.46), trim, [0, 0.13, 2.04]);
  parts.add(box(2.0, 0.035, 0.05), neonMaterial, [0, 0.15, 2.29]);
  // Diffuser and the full-width brake light bar.
  parts.add(box(1.5, 0.16, 0.4), trim, [0, 0.16, -2.2]);
  parts.add(box(1.2, 0.05, 0.04), brakeMaterial, [0, 0.66, -2.42]);
  // The body kit: wings, fins, spoilers and stripes (the silhouette from behind).
  if (style === 1) {
    // Apex: a tall swan-neck wing with end plates, a dorsal fin, twin hood stripes.
    for (const side of [-1, 1]) {
      parts.add(box(0.06, 0.8, 0.2), trim, [side * 0.45, 1.2, -2.0]);
      parts.add(box(0.04, 0.42, 0.62), trim, [side * 0.96, 1.55, -2.08]);
      parts.add(box(0.045, 0.03, 0.62), neonMaterial, [side * 0.96, 1.77, -2.08]);
      parts.add(box(0.06, 0.02, 1.2), neonMaterial, [side * 0.2, 0.64, 1.25], [0.2, 0, 0]);
    }
    parts.add(box(1.92, 0.05, 0.56), trim, [0, 1.62, -2.08]);
    parts.add(box(1.92, 0.03, 0.05), neonMaterial, [0, 1.66, -2.37]);
    parts.add(box(0.04, 0.4, 0.8), hull, [0, 1.06, -1.65]);
    parts.add(box(0.045, 0.03, 0.8), neonMaterial, [0, 1.27, -1.65]);
  } else if (style === 2) {
    // Brute: a low ducktail spoiler, armour on the side pods, a roof light bar, a wide stripe.
    parts.add(box(2.2, 0.09, 0.4), trim, [0, 0.95, -2.22]);
    parts.add(box(2.2, 0.03, 0.05), neonMaterial, [0, 1.0, -2.43]);
    for (const side of [-1, 1]) {
      parts.add(box(0.12, 0.34, 1.4), hull, [side * 1.1, 0.34, 0.02]);
      parts.add(box(0.05, 0.05, 1.3), neonMaterial, [side * 1.17, 0.4, 0.02]);
    }
    parts.add(box(0.95, 0.04, 0.16), trim, [0, 1.17, -0.2]);
    parts.add(box(0.9, 0.05, 0.1), neonMaterial, [0, 1.21, -0.2]);
    parts.add(box(0.32, 0.02, 1.1), neonMaterial, [0, 0.64, 1.25], [0.2, 0, 0]);
  } else {
    // Dart: a low rear wing on two struts, one hood stripe.
    for (const side of [-1, 1]) parts.add(box(0.07, 0.4, 0.24), trim, [side * 0.6, 1.0, -2.0]);
    parts.add(box(2.1, 0.06, 0.5), trim, [0, 1.22, -2.05]);
    parts.add(box(2.1, 0.03, 0.05), neonMaterial, [0, 1.26, -2.31]);
    parts.add(box(0.12, 0.02, 1.2), neonMaterial, [0, 0.64, 1.25], [0.2, 0, 0]);
  }
  // Exhaust glow discs, facing backwards.
  for (const [x, y, z] of EXHAUSTS) {
    parts.add(new CircleGeometry(0.15, 20), thrusterMaterial, [x, y, z], [0, Math.PI, 0]);
  }
  parts.build(body, geometries);

  const canopy = new Mesh(new SphereGeometry(1, 28, 18), glass);
  geometries.push(canopy.geometry);
  canopy.position.set(0, 0.8, -0.2);
  canopy.scale.set(0.52, 0.36, 1.25);
  body.add(canopy);

  // Exhaust flames: open cones with their base on the nozzle, scaled along y for length.
  const flames: Mesh[] = [];
  for (const [x, y, z] of EXHAUSTS) {
    const geometry = new ConeGeometry(0.15, 1, 16, 1, true);
    geometry.translate(0, 0.5, 0);
    geometries.push(geometry);
    const flame = new Mesh(geometry, flameMaterial);
    flame.position.set(x, y, z - 0.02);
    flame.rotation.x = -Math.PI / 2;
    flames.push(flame);
    body.add(flame);
  }

  // Headlight beams: soft additive cones reaching ahead into the fog (apex at the lamp).
  const beamGeometry = new ConeGeometry(3.2, 1, 20, 1, true);
  beamGeometry.translate(0, -0.5, 0);
  beamGeometry.rotateX(Math.PI);
  geometries.push(beamGeometry);
  for (const side of [-1, 1]) {
    const beam = new Mesh(beamGeometry, beamMaterial);
    beam.position.set(side * 0.45, 0.36, 2.25);
    beam.rotation.x = Math.PI / 2 - 0.06;
    beam.scale.set(1, 22, 1);
    beam.renderOrder = 2;
    beam.frustumCulled = false;
    body.add(beam);
  }

  // --- Wheels: tyre, rim and spokes merged, plus a neon rim ring --------------------------
  const wheels: WheelRig[] = [];
  const wheelSpecs: [number, number, number, number, boolean][] = [
    [TRACK_HALF, FRONT_AXLE, 0.36, 0.3, true],
    [-TRACK_HALF, FRONT_AXLE, 0.36, 0.3, true],
    [TRACK_HALF, REAR_AXLE, 0.39, 0.36, false],
    [-TRACK_HALF, REAR_AXLE, 0.39, 0.36, false],
  ];
  for (const [x, z, r, w, front] of wheelSpecs) {
    const outward = Math.sign(x);
    const pivot = new Group();
    pivot.position.set(x, r, z);
    const spin = new Group();
    pivot.add(spin);
    const wheelParts = new PartBuilder();
    wheelParts.add(new CylinderGeometry(r, r, w, 28), tire, [0, 0, 0], [0, 0, Math.PI / 2]);
    wheelParts.add(
      new CylinderGeometry(r * 0.72, r * 0.72, w + 0.02, 24),
      rimMetal,
      [0, 0, 0],
      [0, 0, Math.PI / 2],
    );
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2;
      wheelParts.add(
        box(0.03, r * 1.35, 0.07),
        rimMetal,
        [outward * (w / 2 + 0.02), 0, 0],
        [a, 0, 0],
      );
    }
    wheelParts.add(
      new TorusGeometry(r * 0.8, 0.03, 8, 36),
      rimMaterial,
      [outward * (w / 2 + 0.01), 0, 0],
      [0, Math.PI / 2, 0],
    );
    // Three bright markers on the rim ring: an unmistakable rolling cue.
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2;
      wheelParts.add(
        box(0.03, 0.12, 0.12),
        markerMaterial,
        [outward * (w / 2 + 0.035), Math.sin(a) * r * 0.8, Math.cos(a) * r * 0.8],
        [a, 0, 0],
      );
    }
    wheelParts.build(spin, geometries);
    // Motion-blur disc on the outer face (not spinning: it stands for the blur itself).
    const blur = new Mesh(new CircleGeometry(r * 0.92, 32), blurMaterial);
    geometries.push(blur.geometry);
    blur.position.x = outward * (w / 2 + 0.05);
    blur.rotation.y = outward * (Math.PI / 2);
    blur.renderOrder = 2;
    pivot.add(blur);
    root.add(pivot);
    wheels.push({ pivot, spin, radius: r, front });

    // Dark contact patch where the tyre meets the road.
    const patch = new Mesh(new PlaneGeometry(w + 0.25, r * 2.2), shadowMaterial);
    geometries.push(patch.geometry);
    patch.rotation.x = -Math.PI / 2;
    patch.position.set(x, 0.03, z);
    patch.renderOrder = 0;
    root.add(patch);
  }

  // Soft contact shadow under the body: grounds the car (the lights above it cast none).
  const shadow = new Mesh(new PlaneGeometry(2.9, 5.6), shadowMaterial);
  geometries.push(shadow.geometry);
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.025;
  shadow.renderOrder = 0;
  root.add(shadow);

  // Underglow decal on the road: reads as both a neon underglow and a contact shadow.
  const underglow = new Mesh(new PlaneGeometry(3.1, 5.6), underglowMaterial);
  geometries.push(underglow.geometry);
  underglow.rotation.x = -Math.PI / 2;
  underglow.position.y = 0.05;
  underglow.renderOrder = 1;
  root.add(underglow);

  return {
    root,
    body,
    wheels,
    accent,
    neonMaterial,
    rimMaterial,
    markerMaterial,
    blurMaterial,
    thrusterMaterial,
    flameMaterial,
    flames,
    underglow,
    underglowMaterial,
    brakeMaterial,
    reverseMaterial,
    headlightMaterial,
    beamMaterial,
    shadowMaterial,
    solidMaterials: [
      hull,
      trim,
      glass,
      tire,
      rimMetal,
      neonMaterial,
      rimMaterial,
      markerMaterial,
      headlightMaterial,
      brakeMaterial,
      reverseMaterial,
      thrusterMaterial,
    ],
    hullRim,
    dispose: () => {
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
      fade.dispose();
      glow.dispose();
      ring.dispose();
      spot.dispose();
    },
  };
}
