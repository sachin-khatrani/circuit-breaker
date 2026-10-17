import { describe, expect, it } from 'vitest';
import { MIN_INTERP_MS, RemoteDelay, remoteDelayMs } from '../src';

/**
 * Remote cars are drawn a little in the past so a snapshot exists on both sides of the drawn
 * moment. Snapshots arrive about half a round trip after the server made them, so the delay
 * must grow with the round trip (Step 9: at 200 ms, a fixed 110 ms left nine frames in ten
 * guessed ahead).
 */
describe('remote car delay', () => {
  /** Share of 60 Hz frames whose drawn moment already has a newer snapshot on hand. */
  function covered(rttMs: number, delay: (rtt: number, jitter: number) => number): number {
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    // The server makes a snapshot every 50 ms; each arrives half a round trip later, + jitter.
    const arrivals = Array.from({ length: 400 }, (_, k) => ({
      made: k * 50,
      at: k * 50 + rttMs / 2 + random() * 10,
    }));
    let frames = 0;
    let ok = 0;
    for (let t = 1000; t < 19_000; t += 1000 / 60) {
      const drawn = t - delay(rttMs, 5);
      let newest = -Infinity;
      for (const a of arrivals) if (a.at <= t) newest = Math.max(newest, a.made);
      frames++;
      if (newest >= drawn) ok++;
    }
    return ok / frames;
  }

  it('keeps a snapshot on both sides of the drawn moment at 50, 100 and 200 ms', () => {
    for (const rtt of [50, 100, 200]) {
      expect(covered(rtt, (r, j) => remoteDelayMs(20, r, j))).toBeGreaterThan(0.99);
    }
    // The fixed delay it replaced ran out at 200 ms.
    const fixed = () => Math.max(MIN_INTERP_MS, 2.2 * 50 + 5);
    expect(covered(200, fixed)).toBeLessThan(0.5);
  });

  it('eases to a new delay instead of jumping: the drawn moment never skips', () => {
    const delay = new RemoteDelay();
    expect(delay.update(110, 16)).toBe(110);
    // The round trip grows by 200 ms: the delay follows at a tenth of real time.
    let value = 110;
    let frames = 0;
    while (value < 210 && frames < 1000) {
      const next = delay.update(210, 1000 / 60);
      expect(next - value).toBeLessThanOrEqual(1000 / 60 / 10 + 1e-9);
      value = next;
      frames++;
    }
    // A 100 ms change takes about a second (60 frames).
    expect(value).toBe(210);
    expect(frames).toBeGreaterThanOrEqual(60);
    expect(frames).toBeLessThanOrEqual(61);
    // And back down the same way.
    expect(delay.update(110, 1000)).toBe(110);
  });

  it('is 2.2 snapshot intervals plus jitter (at least 100 ms), plus half the round trip', () => {
    expect(remoteDelayMs(20, 0, 0)).toBeCloseTo(110, 9);
    expect(remoteDelayMs(20, 200, 10)).toBeCloseTo(220, 9);
    expect(remoteDelayMs(60, 0, 0)).toBe(MIN_INTERP_MS);
  });
});
