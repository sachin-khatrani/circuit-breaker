import {
  clamp01,
  damp,
  gateLaneAt,
  LEFT_LANE,
  RIGHT_LANE,
  shortcutPhase,
  type BranchRoad,
  type Track,
  type TrackSplit,
} from '@circuit-breaker/shared';
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { BoxGeometry, Color, Mesh, MeshBasicMaterial, type BufferGeometry } from 'three';
import { session } from '../../game/session';
import {
  createBarrierMaterial,
  createDeckMaterial,
  createPulseMaterial,
  createRoadMaterial,
} from './materials';
import {
  createArrowMaterial,
  createRouteBarrierMaterial,
  ROUTE_CHANGING,
  ROUTE_LOCKED,
  ROUTE_OPEN,
  SignBoard,
  SPLIT_COLOR,
} from './routeMaterials';
import {
  BoxBatch,
  buildBarrierGeometry,
  buildDeckGeometry,
  buildRailGeometry,
  buildRoadGeometry,
  buildStrip,
  sampleFrame,
  surfaceY,
  type SampleFrame,
  type StripColumn,
} from './trackGeometry';

const CURTAIN_HEIGHT = 2.8;
const FENCE_HEIGHT = 2.6;
const DIVIDER_HEIGHT = 1.4;
/** Seconds-scale of the barrier animation (rise and sink). */
const BARRIER_RATE = 9;
const white = new Color('#ffffff');

/** Rows of a road strip from arc length a to b (b may pass the loop's end). */
function rowsBetween(track: Track, a: number, b: number): [number, number] {
  const first = Math.floor(a / track.spacing);
  const span = track.distanceAhead(a, b);
  return [first, first + Math.max(1, Math.round(span / track.spacing))];
}

/** Columns for a vertical wall at a lateral position given per row. */
function wallColumns(lateral: (f: SampleFrame) => number, height: number): StripColumn[] {
  return [
    { lateral, height: (f) => surfaceY(f, lateral(f)) + 0.02, v: 0 },
    { lateral, height: (f) => surfaceY(f, lateral(f)) + height, v: 1 },
  ];
}

/** Columns for a flat band painted on the road between two lateral positions. */
function bandColumns(from: number, to: number): StripColumn[] {
  return [
    { lateral: () => from, height: (f) => surfaceY(f, from) + 0.04, v: 0 },
    { lateral: () => to, height: (f) => surfaceY(f, to) + 0.04, v: 1 },
  ];
}

interface NeedleParts {
  branch: BranchRoad;
  geometries: BufferGeometry[];
  road: BufferGeometry;
  deck: BufferGeometry;
  rails: BufferGeometry;
  barriers: BufferGeometry;
  /** Road, rails and barriers are built white and tinted with the route's state. */
  roadMaterial: ReturnType<typeof createRoadMaterial>;
  railMaterial: ReturnType<typeof createPulseMaterial>;
  barrierMaterial: ReturnType<typeof createBarrierMaterial>;
  tint: Color;
  curtain: BufferGeometry;
  curtainMaterial: ReturnType<typeof createRouteBarrierMaterial>;
  arrows: BufferGeometry;
  arrowMaterial: ReturnType<typeof createArrowMaterial>;
  structure: Mesh;
  lights: Mesh;
  lightMaterial: MeshBasicMaterial;
  sign: SignBoard;
}

interface SplitParts {
  split: TrackSplit;
  geometries: BufferGeometry[];
  divider: BufferGeometry;
  /** Fence closing the left lane (up while the right lane is open), and the right lane. */
  fences: [BufferGeometry, BufferGeometry];
  fenceMaterials: [
    ReturnType<typeof createRouteBarrierMaterial>,
    ReturnType<typeof createRouteBarrierMaterial>,
  ];
  laneArrows: [BufferGeometry, BufferGeometry];
  laneArrowMaterials: [
    ReturnType<typeof createArrowMaterial>,
    ReturnType<typeof createArrowMaterial>,
  ];
  structure: Mesh;
  boards: [SignBoard, SignBoard];
  title: SignBoard;
}

function buildNeedle(track: Track, branch: BranchRoad): NeedleParts {
  const geometries: BufferGeometry[] = [];
  const keep = <T extends BufferGeometry>(g: T): T => {
    geometries.push(g);
    return g;
  };
  const entry = track.portals.find((p) => p.branch === branch.roadId && p.kind === 'entry')!;
  const side = branch.side;
  // The barrier standing in the opening while the shortcut is shut.
  const curtain = keep(
    buildStrip(
      track,
      wallColumns((f) => side * f.hw, CURTAIN_HEIGHT),
      () => true,
      { rows: [entry.mainFrom, entry.mainTo] },
    ),
  );
  // Chevrons leading into the opening along the main road's edge lane.
  const arrows = keep(
    buildStrip(
      track,
      bandColumns(side * 9.6, side * 4.4).map((c, k) => ({ ...c, v: side < 0 ? 1 - k : k })),
      () => true,
      {
        rows: rowsBetween(track, branch.entryMainS - 70, branch.entryMainS + branch.entryMainSpan),
      },
    ),
  );
  // A cantilever gantry over the branch, a little way in, facing the cars coming up to it.
  // Its one post stands on the far side: the near edge is the main road's, so a post there
  // would stand in the main road's lane.
  const structure = new BoxBatch();
  const lights = new BoxBatch();
  const f = {} as SampleFrame;
  sampleFrame(branch, Math.round(9 / branch.spacing), f);
  const outer = f.hw + 1.6;
  const top = f.y + 8.2;
  const px = f.x + f.rx * side * outer;
  const pz = f.z + f.rz * side * outer;
  structure.add(px, f.y, pz, px, top + 0.8, pz, 0.9, 0.9, f.fx, f.fz);
  lights.add(
    px + f.fx * 0.5,
    f.y + 0.4,
    pz + f.fz * 0.5,
    px + f.fx * 0.5,
    top,
    pz + f.fz * 0.5,
    0.16,
    0.16,
    f.fx,
    f.fz,
    white,
  );
  // The arm reaches across the branch and stops short of the main road.
  const ax = f.x - f.rx * side * (f.hw - 0.3);
  const az = f.z - f.rz * side * (f.hw - 0.3);
  structure.add(px, top + 0.4, pz, ax, top + 0.4, az, 0.9, 1.2, f.fx, f.fz);
  lights.add(px, top - 0.2, pz, ax, top - 0.2, az, 0.2, 1.3, f.fx, f.fz, white);
  const structureMaterial = new MeshBasicMaterial({ color: '#151a2a' });
  const lightMaterial = new MeshBasicMaterial({ color: ROUTE_LOCKED.clone(), toneMapped: false });
  const sign = new SignBoard(7.5, 2.4);
  sign.mesh.position.set(f.x - f.fx * 0.7, top + 1.9, f.z - f.fz * 0.7);
  sign.mesh.rotation.y = Math.atan2(f.fx, f.fz) + Math.PI;

  return {
    branch,
    geometries,
    road: keep(buildRoadGeometry(branch, white)),
    deck: keep(buildDeckGeometry(branch)),
    rails: keep(buildRailGeometry(branch, white)),
    barriers: keep(buildBarrierGeometry(branch, white)),
    roadMaterial: createRoadMaterial(branch),
    railMaterial: createPulseMaterial(),
    barrierMaterial: createBarrierMaterial(),
    tint: lockedTint.clone(),
    curtain,
    curtainMaterial: createRouteBarrierMaterial(ROUTE_LOCKED),
    arrows,
    arrowMaterial: createArrowMaterial(ROUTE_OPEN),
    structure: structure.build(structureMaterial),
    lights: lights.build(lightMaterial),
    lightMaterial,
    sign,
  };
}

function buildSplit(track: Track, split: TrackSplit): SplitParts {
  const geometries: BufferGeometry[] = [];
  const keep = <T extends BufferGeometry>(g: T): T => {
    geometries.push(g);
    return g;
  };
  const d = split.divider;
  const end = split.s + split.length;
  // The divider: two faces and a lit top, from the nose to the end of the split.
  const divider = keep(
    buildStrip(
      track,
      [
        { lateral: () => -d, height: (f) => surfaceY(f, -d), v: 0 },
        { lateral: () => -d, height: (f) => surfaceY(f, -d) + DIVIDER_HEIGHT, v: 1 },
        { lateral: () => d, height: (f) => surfaceY(f, d) + DIVIDER_HEIGHT, v: 1 },
        { lateral: () => d, height: (f) => surfaceY(f, d), v: 0 },
      ],
      () => true,
      { rows: rowsBetween(track, split.s, end), sector: true, color: SPLIT_COLOR },
    ),
  );
  // Funnel fences: each runs from one road edge at the funnel's start to the far side of the
  // divider's nose, shutting its lane off (the same line the physics uses).
  const u = (f: SampleFrame) => clamp01(track.distanceAhead(split.funnelS, f.s) / split.funnel);
  const fenceLeft = keep(
    buildStrip(
      track,
      wallColumns((f) => -f.hw + (f.hw + d) * u(f), FENCE_HEIGHT),
      () => true,
      { rows: rowsBetween(track, split.funnelS, split.s) },
    ),
  );
  const fenceRight = keep(
    buildStrip(
      track,
      wallColumns((f) => f.hw - (f.hw + d) * u(f), FENCE_HEIGHT),
      () => true,
      { rows: rowsBetween(track, split.funnelS, split.s) },
    ),
  );
  // Chevrons down the middle of each lane, lit for the open one.
  const hwAt = track.halfWidth[Math.floor(split.s / track.spacing) % track.count];
  const laneRows = rowsBetween(track, split.funnelS - 50, split.s + 40);
  const laneLeft = keep(
    buildStrip(track, bandColumns(-hwAt + 1.5, -d - 1.5), () => true, { rows: laneRows }),
  );
  const laneRight = keep(
    buildStrip(track, bandColumns(d + 1.5, hwAt - 1.5), () => true, { rows: laneRows }),
  );

  // Gate gantry before the funnel, a signal over each lane.
  const structure = new BoxBatch();
  const f = {} as SampleFrame;
  sampleFrame(track, Math.round((split.funnelS - 14) / track.spacing), f);
  const outer = f.hw + 2;
  const top = Math.max(surfaceY(f, -f.hw), surfaceY(f, f.hw)) + 9;
  for (const s of [-1, 1]) {
    const x = f.x + f.rx * s * outer;
    const z = f.z + f.rz * s * outer;
    structure.add(x, surfaceY(f, s * f.hw), z, x, top + 1, z, 1.1, 1.1, f.fx, f.fz);
  }
  structure.add(
    f.x - f.rx * outer,
    top + 0.5,
    f.z - f.rz * outer,
    f.x + f.rx * outer,
    top + 0.5,
    f.z + f.rz * outer,
    1,
    1.4,
    f.fx,
    f.fz,
  );
  const facing = Math.atan2(f.fx, f.fz) + Math.PI;
  const lane = (hwAt + d) / 2;
  const boards: [SignBoard, SignBoard] = [new SignBoard(4.2, 3.4), new SignBoard(4.2, 3.4)];
  boards.forEach((board, k) => {
    const lat = (k === LEFT_LANE ? -1 : 1) * lane;
    board.mesh.position.set(
      f.x + f.rx * lat - f.fx * 0.8,
      top - 1.4,
      f.z + f.rz * lat - f.fz * 0.8,
    );
    board.mesh.rotation.y = facing;
  });
  const title = new SignBoard(9, 1.6, 384);
  title.mesh.position.set(f.x - f.fx * 0.8, top + 1.6, f.z - f.fz * 0.8);
  title.mesh.rotation.y = facing;
  title.draw('GATE', 'OVERLOAD SPLIT · E TO SHIFT', '#8a5cff');

  return {
    split,
    geometries,
    divider,
    fences: [fenceLeft, fenceRight],
    fenceMaterials: [
      createRouteBarrierMaterial(ROUTE_LOCKED),
      createRouteBarrierMaterial(ROUTE_LOCKED),
    ],
    laneArrows: [laneLeft, laneRight],
    laneArrowMaterials: [createArrowMaterial(ROUTE_OPEN), createArrowMaterial(ROUTE_OPEN)],
    structure: structure.build(new MeshBasicMaterial({ color: '#151a2a' })),
    boards,
    title,
  };
}

const blink = (t: number, hz = 3) => (Math.sin(t * Math.PI * 2 * hz) > 0 ? 1 : 0.25);
/** The shut shortcut glows a dim red, so it reads as a route that is not there yet. */
const lockedTint = ROUTE_LOCKED.clone().multiplyScalar(0.45);
const tintTarget = new Color();
const hex = (c: Color) => `#${c.getHexString()}`;

/**
 * The changeable track: the shortcut branch with its entrance barrier, gantry sign and lead-in
 * arrows; the split's divider, funnel fences and gate signals. Everything follows the course
 * state on the local car's timeline, so what the player sees is what the physics does.
 */
export function RouteScene() {
  const track = session.track;
  const parts = useMemo(() => {
    const branch = track.branches[0];
    const split = track.splits[0];
    return {
      needle: branch ? buildNeedle(track, branch) : null,
      split: split ? buildSplit(track, split) : null,
      deckMaterial: createDeckMaterial(),
      barrierMaterial: createBarrierMaterial(),
      noseGeometry: new BoxGeometry(1, 1, 1),
    };
  }, [track]);
  const levels = useRef({ curtain: 1, fences: [1, 0] as [number, number] });

  useEffect(
    () => () => {
      const { needle, split } = parts;
      for (const g of [...(needle?.geometries ?? []), ...(split?.geometries ?? [])]) g.dispose();
      if (needle) {
        needle.roadMaterial.dispose();
        needle.railMaterial.dispose();
        needle.barrierMaterial.dispose();
        needle.curtainMaterial.dispose();
        needle.arrowMaterial.dispose();
        needle.lightMaterial.dispose();
        needle.sign.dispose();
        for (const m of [needle.structure, needle.lights]) {
          m.geometry.dispose();
          m.dispose();
        }
      }
      if (split) {
        for (const m of [...split.fenceMaterials, ...split.laneArrowMaterials]) m.dispose();
        for (const b of [...split.boards, split.title]) b.dispose();
        split.structure.geometry.dispose();
        split.structure.dispose();
      }
      parts.deckMaterial.dispose();
      parts.barrierMaterial.dispose();
      parts.noseGeometry.dispose();
    },
    [parts],
  );

  useFrame(({ clock }, delta) => {
    const time = clock.elapsedTime;
    const dt = Math.min(delta, 0.05);
    const sim = session.sim;
    const rules = sim.rules;
    const c = sim.course;
    const tick = sim.tick + session.alpha;
    const t = Math.floor(tick);
    const secs = (ticks: number) => Math.max(0, ticks / 60);
    parts.barrierMaterial.uniforms.uTime.value = time;

    const { needle, split } = parts;
    if (needle) {
      needle.roadMaterial.userData.uTime.value = time;
      needle.railMaterial.uniforms.uTime.value = time;
      needle.barrierMaterial.uniforms.uTime.value = time;
      const phase = shortcutPhase(c, t, rules);
      let target = 1;
      let color = ROUTE_LOCKED;
      let flash = 0;
      let arrows = 0;
      if (phase === 'opening') {
        target = clamp01((c.shortcutOpenTick - tick) / rules.shortcutOpenDelayTicks);
        color = ROUTE_CHANGING;
        flash = blink(time) * 0.6;
        arrows = blink(time);
        needle.sign.draw('OPENING', 'THE NEEDLE', hex(ROUTE_CHANGING));
      } else if (phase === 'open') {
        target = 0;
        color = ROUTE_OPEN;
        arrows = 1;
        needle.sign.draw(
          'OPEN',
          `THE NEEDLE · ${Math.ceil(secs(c.shortcutCloseTick - tick))} S`,
          hex(ROUTE_OPEN),
        );
      } else if (phase === 'closing') {
        // Still passable: the barrier only stands up at the closing tick.
        target = 0.18 * blink(time, 2);
        color = ROUTE_CHANGING;
        flash = blink(time, 2) * 0.4;
        arrows = blink(time, 2);
        needle.sign.draw(
          'CLOSING',
          `${Math.ceil(secs(c.shortcutCloseTick - tick))} S`,
          hex(ROUTE_CHANGING),
        );
      } else {
        needle.sign.draw('THE NEEDLE', 'LOCKED · Q OPENS IT', hex(ROUTE_LOCKED));
      }
      levels.current.curtain = damp(levels.current.curtain, target, BARRIER_RATE, dt);
      const u = needle.curtainMaterial.uniforms;
      u.uTime.value = time;
      u.uLevel.value = levels.current.curtain;
      u.uFlash.value = flash;
      u.uColor.value.copy(color);
      const a = needle.arrowMaterial.uniforms;
      a.uTime.value = time;
      a.uLevel.value = arrows;
      a.uColor.value.copy(phase === 'open' ? ROUTE_OPEN : ROUTE_CHANGING);
      needle.lightMaterial.color.copy(color).multiplyScalar(4 + flash * 4);
      // The whole branch takes the route colour: dim red shut, amber changing, green open.
      if (phase === 'locked') tintTarget.copy(lockedTint);
      else tintTarget.copy(color).multiplyScalar(phase === 'open' ? 1 : 0.6 + flash * 0.6);
      needle.tint.lerp(tintTarget, 1 - Math.exp(-dt * 10));
      needle.roadMaterial.userData.uTint.value.copy(needle.tint);
      needle.railMaterial.uniforms.uTint.value.copy(needle.tint);
      needle.barrierMaterial.uniforms.uTint.value.copy(needle.tint);
    }

    if (split) {
      const lane = gateLaneAt(c, t);
      const pending = c.gateSwitchTick >= 0 && t < c.gateSwitchTick;
      const next = pending ? c.gateNextLane : lane;
      const left = secs(c.gateSwitchTick - tick);
      split.fenceMaterials.forEach((m, k) => {
        // Fence k shuts lane k: it stands while the other lane is the open one.
        const shut = (k === LEFT_LANE ? RIGHT_LANE : LEFT_LANE) === lane;
        const closing = pending && next !== k && lane === k;
        const target = shut ? 1 : closing ? 0.2 * blink(time) : 0;
        levels.current.fences[k] = damp(levels.current.fences[k], target, BARRIER_RATE, dt);
        m.uniforms.uTime.value = time;
        m.uniforms.uLevel.value = levels.current.fences[k];
        m.uniforms.uColor.value.copy(closing ? ROUTE_CHANGING : ROUTE_LOCKED);
        m.uniforms.uFlash.value = closing ? blink(time) * 0.5 : 0;
      });
      split.laneArrowMaterials.forEach((m, k) => {
        const open = lane === k;
        const opening = pending && next === k && lane !== k;
        m.uniforms.uTime.value = time;
        m.uniforms.uLevel.value = open
          ? pending
            ? blink(time)
            : 1
          : opening
            ? blink(time) * 0.7
            : 0;
        m.uniforms.uColor.value.copy(pending ? ROUTE_CHANGING : ROUTE_OPEN);
      });
      split.boards.forEach((board, k) => {
        const open = lane === k;
        if (pending) {
          const count = `${Math.ceil(left)}`;
          if (open) board.draw('', `SHUTS IN ${count}`, hex(ROUTE_CHANGING), 'cross');
          else board.draw('', `OPENS IN ${count}`, hex(ROUTE_CHANGING), 'arrow');
        } else if (open) board.draw('', 'OPEN', hex(ROUTE_OPEN), 'arrow');
        else board.draw('', 'SHUT', hex(ROUTE_LOCKED), 'cross');
      });
    }
  }, -1);

  const { needle, split } = parts;
  const nose = split ? track.frameAt(split.split.s) : null;
  return (
    <group>
      {needle && (
        <>
          <mesh geometry={needle.road} material={needle.roadMaterial} />
          <mesh geometry={needle.deck} material={parts.deckMaterial} />
          <mesh geometry={needle.rails} material={needle.railMaterial} />
          <mesh geometry={needle.barriers} material={needle.barrierMaterial} renderOrder={2} />
          <mesh geometry={needle.curtain} material={needle.curtainMaterial} renderOrder={3} />
          <mesh geometry={needle.arrows} material={needle.arrowMaterial} renderOrder={1} />
          <primitive object={needle.structure} />
          <primitive object={needle.lights} />
          <primitive object={needle.sign.mesh} />
        </>
      )}
      {split && nose && (
        <>
          <mesh geometry={split.divider} material={parts.barrierMaterial} renderOrder={2} />
          <mesh geometry={split.fences[0]} material={split.fenceMaterials[0]} renderOrder={3} />
          <mesh geometry={split.fences[1]} material={split.fenceMaterials[1]} renderOrder={3} />
          <mesh
            geometry={split.laneArrows[0]}
            material={split.laneArrowMaterials[0]}
            renderOrder={1}
          />
          <mesh
            geometry={split.laneArrows[1]}
            material={split.laneArrowMaterials[1]}
            renderOrder={1}
          />
          <primitive object={split.structure} />
          {split.boards.map((b, k) => (
            <primitive key={k} object={b.mesh} />
          ))}
          <primitive object={split.title.mesh} />
          {/* The divider's nose: a lit post where the lanes part. */}
          <mesh
            geometry={parts.noseGeometry}
            position={[nose.x, nose.y + DIVIDER_HEIGHT, nose.z]}
            scale={[split.split.divider * 2, DIVIDER_HEIGHT * 2, 1.2]}
            rotation={[0, nose.heading, 0]}
          >
            <meshBasicMaterial color={SPLIT_COLOR.clone().multiplyScalar(3)} toneMapped={false} />
          </mesh>
        </>
      )}
    </group>
  );
}
