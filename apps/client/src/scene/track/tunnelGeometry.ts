import type { Track } from '@circuit-breaker/shared';
import { BufferAttribute, BufferGeometry, Color } from 'three';
import { BoxBatch, sampleFrame, sectorColorAt, surfaceY, type SampleFrame } from './trackGeometry';

/** Inner wall offset beyond the road edge, and the shell thickness. */
const WALL_OFFSET = 0.8;
const SHELL = 1.4;
const RIB_EVERY = 4; // samples (8 m)

/** Contiguous sample ranges [first, last] where the track has a roof. */
export function tunnelRanges(track: Track): [number, number][] {
  const ranges: [number, number][] = [];
  let start = -1;
  for (let i = 0; i <= track.count; i++) {
    const roofed = i < track.count && track.roof[i] > 0;
    if (roofed && start < 0) start = i;
    if (!roofed && start >= 0) {
      ranges.push([start, i - 1]);
      start = -1;
    }
  }
  return ranges;
}

/** Cross-section of the tunnel at a frame: (lateral, height) points, left wall → roof → right. */
function profile(f: SampleFrame, grow: number): [number, number][] {
  const side = f.hw + WALL_OFFSET + grow;
  const roof = f.y + f.roof + grow;
  return [
    [-side, surfaceY(f, -f.hw) - 0.05 - (grow > 0 ? 0.3 : 0)],
    [-side, f.y + f.roof * 0.66 + grow * 0.5],
    [-f.hw * 0.5 - grow * 0.5, roof],
    [f.hw * 0.5 + grow * 0.5, roof],
    [side, f.y + f.roof * 0.66 + grow * 0.5],
    [side, surfaceY(f, f.hw) - 0.05 - (grow > 0 ? 0.3 : 0)],
  ];
}

export interface TunnelGeometry {
  /** Inner and outer shells plus the portal faces, one mesh (dark metal). */
  shell: BufferGeometry;
  /** Light strips along the roof corners: uv.x = s, `aSector` colour (pulse shader). */
  strips: BufferGeometry;
}

/**
 * Builds every tunnel on the track: a hexagonal shell around the road, portal faces, glowing
 * ribs every 8 m (added to the shared neon batch) and pulsing roof light strips.
 */
export function buildTunnels(track: Track, neon: BoxBatch): TunnelGeometry | null {
  const ranges = tunnelRanges(track);
  if (ranges.length === 0) return null;
  const shellPos: number[] = [];
  const stripPos: number[] = [];
  const stripUv: number[] = [];
  const stripColor: number[] = [];
  const f = {} as SampleFrame;
  const g = {} as SampleFrame;
  const color = new Color();
  const ribColors = [
    new Color('#19e6ff').multiplyScalar(4),
    new Color('#8a5cff').multiplyScalar(4),
  ];
  const portalColor = new Color('#e6fbff').multiplyScalar(6);

  const world = (fr: SampleFrame, lat: number, h: number): [number, number, number] => [
    fr.x + fr.rx * lat,
    h,
    fr.z + fr.rz * lat,
  ];
  const quad = (out: number[], a: number[], b: number[], c: number[], d: number[]) => {
    out.push(...a, ...b, ...c, ...b, ...d, ...c);
  };

  for (const [first, last] of ranges) {
    for (let i = first; i < last; i++) {
      sampleFrame(track, i, f);
      sampleFrame(track, i + 1, g);
      for (const grow of [0, SHELL]) {
        const pa = profile(f, grow);
        const pb = profile(g, grow);
        for (let j = 0; j < pa.length - 1; j++) {
          quad(
            shellPos,
            world(f, pa[j][0], pa[j][1]),
            world(f, pa[j + 1][0], pa[j + 1][1]),
            world(g, pb[j][0], pb[j][1]),
            world(g, pb[j + 1][0], pb[j + 1][1]),
          );
        }
      }
      // Roof-corner light strips (on the slanted panels, a little inside the shell).
      sectorColorAt(track, f.s, color).multiplyScalar(3);
      for (const sign of [-1, 1]) {
        const strip = (fr: SampleFrame, t: number) => {
          const p = profile(fr, -0.12);
          const lo = sign < 0 ? p[1] : p[4];
          const hi = sign < 0 ? p[2] : p[3];
          return world(fr, lo[0] + (hi[0] - lo[0]) * t, lo[1] + (hi[1] - lo[1]) * t);
        };
        const a = strip(f, 0.35);
        const b = strip(f, 0.55);
        const c = strip(g, 0.35);
        const d = strip(g, 0.55);
        quad(stripPos, a, b, c, d);
        stripUv.push(f.s, 0, f.s, 1, g.s, 0, f.s, 1, g.s, 1, g.s, 0);
        for (let k = 0; k < 6; k++) stripColor.push(color.r, color.g, color.b);
      }
    }

    // Portal faces closing the gap between inner and outer shell, and bright portal outlines.
    for (const end of [first, last]) {
      sampleFrame(track, end, f);
      const inner = profile(f, 0);
      const outer = profile(f, SHELL);
      for (let j = 0; j < inner.length - 1; j++) {
        quad(
          shellPos,
          world(f, inner[j][0], inner[j][1]),
          world(f, inner[j + 1][0], inner[j + 1][1]),
          world(f, outer[j][0], outer[j][1]),
          world(f, outer[j + 1][0], outer[j + 1][1]),
        );
        const a = world(f, inner[j][0], inner[j][1]);
        const b = world(f, inner[j + 1][0], inner[j + 1][1]);
        neon.add(...a, ...b, 0.3, 0.6, f.fx, f.fz, portalColor);
      }
    }

    // Ribs every 8 m along the inside of the shell, alternating cyan and violet.
    for (let i = first + 2, n = 0; i < last - 1; i += RIB_EVERY, n++) {
      sampleFrame(track, i, f);
      const p = profile(f, -0.14);
      for (let j = 0; j < p.length - 1; j++) {
        const a = world(f, p[j][0], p[j][1]);
        const b = world(f, p[j + 1][0], p[j + 1][1]);
        neon.add(...a, ...b, 0.12, 0.35, f.fx, f.fz, ribColors[n % 2]);
      }
    }
  }

  const shell = new BufferGeometry();
  shell.setAttribute('position', new BufferAttribute(new Float32Array(shellPos), 3));
  shell.computeVertexNormals();
  shell.computeBoundingSphere();

  const strips = new BufferGeometry();
  strips.setAttribute('position', new BufferAttribute(new Float32Array(stripPos), 3));
  strips.setAttribute('uv', new BufferAttribute(new Float32Array(stripUv), 2));
  strips.setAttribute('aSector', new BufferAttribute(new Float32Array(stripColor), 3));
  strips.computeBoundingSphere();
  return { shell, strips };
}
