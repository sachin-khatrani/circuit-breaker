import { createHistogram, performance, type RecordableHistogram } from 'node:perf_hooks';
import type { Db, Queryable, QueryResult } from './db/db';

/** A distribution over the recent window: how many values, and their p50, p99 and max. */
export interface Spread {
  count: number;
  p50: number;
  p99: number;
  max: number;
}

const WINDOW_SECONDS = 10;
const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * Values of the last few seconds: one native histogram per second, merged when read, so a
 * reading describes the current load rather than everything since boot.
 */
export class RecentHistogram {
  private readonly slots: { second: number; h: RecordableHistogram }[] = [];

  /** `scale`: recorded as integers, so ms are kept to the microsecond (1000) by default. */
  constructor(
    private readonly scale = 1000,
    private readonly seconds = WINDOW_SECONDS,
  ) {}

  record(value: number, now = performance.now()): void {
    const second = Math.floor(now / 1000);
    let slot = this.slots.at(-1);
    if (!slot || slot.second !== second) {
      slot = { second, h: createHistogram() };
      this.slots.push(slot);
      while (this.slots[0].second <= second - this.seconds) this.slots.shift();
    }
    slot.h.record(Math.max(1, Math.round(value * this.scale)));
  }

  read(now = performance.now()): Spread {
    const second = Math.floor(now / 1000);
    const merged = createHistogram();
    for (const slot of this.slots) if (slot.second > second - this.seconds) merged.add(slot.h);
    if (merged.count === 0) return { count: 0, p50: 0, p99: 0, max: 0 };
    return {
      count: merged.count,
      p50: round2(merged.percentile(50) / this.scale),
      p99: round2(merged.percentile(99) / this.scale),
      max: round2(merged.max / this.scale),
    };
  }
}

/** A count over the recent window (and since boot), read as a rate per second. */
export class RecentCounter {
  total = 0;
  private readonly slots: { second: number; n: number }[] = [];

  add(n = 1, now = performance.now()): void {
    this.total += n;
    const second = Math.floor(now / 1000);
    let slot = this.slots.at(-1);
    if (!slot || slot.second !== second) {
      slot = { second, n: 0 };
      this.slots.push(slot);
      // The current second plus a whole window of complete ones (rate() reads those).
      while (this.slots[0].second < second - WINDOW_SECONDS) this.slots.shift();
    }
    slot.n += n;
  }

  /** Per second over the last complete seconds of the window. */
  rate(now = performance.now()): number {
    const second = Math.floor(now / 1000);
    let sum = 0;
    for (const slot of this.slots) {
      if (slot.second < second && slot.second >= second - WINDOW_SECONDS) sum += slot.n;
    }
    return round2(sum / WINDOW_SECONDS);
  }
}

export type RefusalReason = 'origin' | 'address' | 'total' | 'rate' | 'draining';

/**
 * Process-wide counters for `/metrics`, `/ready` and the load harness: connections and why
 * any were refused, messages in and refused, handler and room failures, simulation tick
 * timing, snapshots, bytes out, the event loop, CPU, and the database and API. Nothing here
 * identifies a player: there are only counts and timings.
 */
export class Metrics {
  readonly startedAt = Date.now();
  connectionsAccepted = 0;
  readonly connectionsRefused: Record<RefusalReason, number> = {
    origin: 0,
    address: 0,
    total: 0,
    rate: 0,
    draining: 0,
  };
  readonly disconnects: Record<string, number> = {};
  readonly messagesIn = new RecentCounter();
  messagesRefused = 0;
  abuseDisconnects = 0;
  handlerErrors = 0;
  roomErrors = 0;
  /** How late each simulation tick ran after its due time (ms). */
  readonly tickLateness = new RecentHistogram();
  readonly ticks = new RecentCounter();
  readonly snapshots = new RecentCounter();
  /**
   * Snapshots Socket.IO discarded: a volatile message is dropped whenever the connection is
   * still writing the previous message, not only when it is congested.
   */
  readonly snapshotsDiscarded = new RecentCounter();
  /** Sampled sizes of snapshot messages as JSON (bytes). */
  readonly snapshotBytes = new RecentHistogram(1);
  readonly bytesOut = new RecentCounter();
  readonly dbLatency = new RecentHistogram();
  dbQueries = 0;
  dbErrors = 0;
  readonly apiLatency = new RecentHistogram();
  apiRequests = 0;
  api4xx = 0;
  api5xx = 0;
  /** Time from queueing an immediate callback to it running: work waiting in the loop (ms). */
  readonly loopDelay = new RecentHistogram();
  private readonly samples: { at: number; cpu: NodeJS.CpuUsage; elu: number; idle: number }[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  /** Starts the event-loop and CPU samplers (unref'd: they never keep the process alive). */
  start(): void {
    if (this.timer) return;
    let n = 0;
    this.timer = setInterval(() => {
      const queued = performance.now();
      setImmediate(() => this.loopDelay.record(performance.now() - queued));
      if (++n % 10 === 0) this.sampleProcess();
    }, 100);
    this.timer.unref();
    this.sampleProcess();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  disconnected(reason: string): void {
    this.disconnects[reason] = (this.disconnects[reason] ?? 0) + 1;
  }

  /** CPU use and event-loop utilisation (%) over the last window. */
  process(): { cpuPercent: number; loopUtilizationPercent: number } {
    const last = this.samples.at(-1);
    const first = this.samples[0];
    if (!last || !first || last === first) return { cpuPercent: 0, loopUtilizationPercent: 0 };
    const wallMs = last.at - first.at;
    const cpuMs = (last.cpu.user - first.cpu.user + (last.cpu.system - first.cpu.system)) / 1000;
    const active = last.elu - first.elu;
    const idle = last.idle - first.idle;
    return {
      cpuPercent: round2((cpuMs / wallMs) * 100),
      loopUtilizationPercent: round2((active / Math.max(1e-9, active + idle)) * 100),
    };
  }

  private sampleProcess(): void {
    const elu = performance.eventLoopUtilization();
    this.samples.push({
      at: performance.now(),
      cpu: process.cpuUsage(),
      elu: elu.active,
      idle: elu.idle,
    });
    while (this.samples.length > WINDOW_SECONDS + 1) this.samples.shift();
  }
}

/** A database whose queries and transactions are timed into `metrics` (same behaviour). */
export function timedDb(db: Db, metrics: Metrics): Db {
  async function timed<T>(fn: () => Promise<T>): Promise<T> {
    const t0 = performance.now();
    metrics.dbQueries++;
    try {
      return await fn();
    } catch (error) {
      metrics.dbErrors++;
      throw error;
    } finally {
      metrics.dbLatency.record(performance.now() - t0);
    }
  }
  return {
    query: <R = Record<string, unknown>>(text: string, params?: unknown[]) =>
      timed<QueryResult<R>>(() => db.query<R>(text, params)),
    exec: (script: string) => timed(() => db.exec(script)),
    transaction: <T>(fn: (tx: Queryable) => Promise<T>) => timed(() => db.transaction(fn)),
    close: () => db.close(),
  };
}
