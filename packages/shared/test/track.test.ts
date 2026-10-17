import { describe, expect, it } from 'vitest';
import { Track } from '../src/track/track';
import { GRID_ZERO } from '../src/track/tracks/gridZero';

const track = new Track(GRID_ZERO);

describe('Grid Zero layout', () => {
  it('is a closed loop of about 3 km sampled every ~2 m', () => {
    expect(track.length).toBeGreaterThan(2800);
    expect(track.length).toBeLessThan(3200);
    expect(track.spacing).toBeCloseTo(2, 1);
    const last = track.count - 1;
    const gap = Math.hypot(track.px[0] - track.px[last], track.pz[0] - track.pz[last]);
    expect(gap).toBeLessThan(track.spacing * 1.05);
  });

  it('has no corner tighter than 20 m and no folded inner edge', () => {
    for (let i = 0; i < track.count; i++) {
      const k = Math.abs(track.curvature[i]);
      expect(k).toBeLessThan(1 / 20);
      // The inner edge folds back on itself when the half-width reaches the turn radius.
      expect(k * track.halfWidth[i]).toBeLessThan(0.5);
    }
  });

  it('never brings two sections of road closer than 30 m edge to edge', () => {
    let minClearance = Infinity;
    for (let i = 0; i < track.count; i += 2) {
      for (let j = i + 2; j < track.count; j += 2) {
        const along = Math.min(j - i, track.count - (j - i)) * track.spacing;
        if (along < 150) continue;
        const d = Math.hypot(track.px[i] - track.px[j], track.pz[i] - track.pz[j]);
        minClearance = Math.min(minClearance, d - track.halfWidth[i] - track.halfWidth[j]);
      }
    }
    expect(minClearance).toBeGreaterThan(30);
  });

  it('keeps grades drivable', () => {
    for (let i = 0; i < track.count; i++) expect(Math.abs(track.slope[i])).toBeLessThan(0.1);
  });

  it('orders checkpoints along the lap, starting at the line', () => {
    expect(track.checkpoints[0].s).toBe(0);
    for (let i = 1; i < track.checkpoints.length; i++) {
      expect(track.checkpoints[i].s).toBeGreaterThan(track.checkpoints[i - 1].s);
    }
  });

  it('places grid slots behind the line, on the road', () => {
    for (let slot = 0; slot < 8; slot++) {
      const g = track.gridSlot(slot);
      const p = track.project(g.x, g.z, -1);
      expect(track.distanceAhead(p.s, 0)).toBeLessThan(80);
      expect(Math.abs(p.lateral)).toBeLessThan(p.halfWidth - 2);
    }
  });

  it('places every Energy cell on the road surface', () => {
    for (const cell of track.cells) {
      const p = track.project(cell.x, cell.z, -1);
      expect(Math.abs(p.lateral)).toBeLessThan(p.halfWidth - 1);
    }
  });
});

describe('track projection', () => {
  it('round-trips (s, lateral) through pointAt and project', () => {
    const out = { x: 0, y: 0, z: 0 };
    for (let k = 0; k < 200; k++) {
      const s = (k / 200) * track.length;
      const lateral = Math.sin(k * 1.7) * 8;
      track.pointAt(s, lateral, out);
      const hint = Math.floor(s / track.spacing);
      const p = track.project(out.x, out.z, hint);
      const ds = Math.min(Math.abs(p.s - s), track.length - Math.abs(p.s - s));
      expect(ds).toBeLessThan(0.75);
      expect(p.lateral).toBeCloseTo(lateral, 0);
      expect(p.height).toBeCloseTo(out.y, 0);
    }
  });

  it('finds the same answer with a stale hint as with a global search', () => {
    const out = { x: 0, y: 0, z: 0 };
    track.pointAt(1234, 3, out);
    const global = track.projectGlobal(out.x, out.z);
    const hinted = track.project(out.x, out.z, 0);
    expect(hinted.index).toBe(global.index);
  });
});
