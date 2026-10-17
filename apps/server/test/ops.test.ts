import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createLogger, newErrorId, silentLogger } from '../src/log';
import { Metrics, RecentCounter, RecentHistogram } from '../src/metrics';
import { BucketMap } from '../src/net/rateLimit';
import { createOpsHandler, type OpsOptions } from '../src/ops';
import { RankingService } from '../src/ranking/service';
import { RoomManager } from '../src/rooms/RoomManager';
import { ManualClock, roomWith, setup, startRace, TICK_MS, track } from './helpers';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

const smoke = {
  track: 'Grid Zero',
  lengthMetres: 3010,
  finished: true,
  lapSeconds: 44.1,
  ticks: 2650,
  microsPerTick: 9,
};

async function serve(overrides: Partial<OpsOptions> = {}) {
  const { manager } = setup();
  const metrics = new Metrics();
  let accepting = true;
  const ops = createOpsHandler({
    manager,
    ranking: new RankingService(null),
    metrics,
    connections: () => 3,
    maxRooms: 10,
    maxConnections: 100,
    accepting: () => accepting,
    smoke,
    ...overrides,
  });
  const http = createServer((req, res) => {
    if (!ops(req, res)) res.writeHead(418).end();
  });
  servers.push(http);
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const port = (http.address() as AddressInfo).port;
  const get = (path: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path, headers }, (res) => {
        let body = '';
        res.on('data', (c: Buffer) => (body += c.toString()));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on('error', reject);
      req.end();
    });
  return { manager, metrics, get, drain: () => (accepting = false) };
}

describe('operational endpoints', () => {
  it('answers liveness and readiness, and says when it is draining', async () => {
    const s = await serve();
    const health = await s.get('/health');
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toMatchObject({ status: 'ok', rooms: 0, players: 0 });
    const ready = await s.get('/ready');
    expect(ready.status).toBe(200);
    expect(JSON.parse(ready.body)).toMatchObject({
      ready: true,
      status: 'ok',
      checks: { simulation: 'ok', database: 'off', connections: { open: 3, max: 100 } },
    });
    s.drain();
    const draining = await s.get('/ready');
    expect(draining.status).toBe(503);
    expect(JSON.parse(draining.body)).toMatchObject({ ready: false, status: 'draining' });
    expect((await s.get('/health')).status).toBe(200);
  });

  it('is not ready when the simulation failed its boot check', async () => {
    const s = await serve({ smoke: { ...smoke, finished: false } });
    const ready = await s.get('/ready');
    expect(ready.status).toBe(503);
    expect(JSON.parse(ready.body)).toMatchObject({ status: 'failed' });
  });

  it('serves metrics to this machine only, or with the token, and never a secret', async () => {
    const local = await serve();
    const { seats } = roomWith(local.manager, 2);
    local.metrics.tickLateness.record(3);
    const ok = await local.get('/metrics');
    expect(ok.status).toBe(200);
    const body = JSON.parse(ok.body) as Record<string, unknown>;
    expect(body).toMatchObject({ rooms: { rooms: 1, seats: 2 }, connections: { open: 3 } });
    for (const seat of seats) expect(ok.body).not.toContain(seat.token);
    expect(ok.body).not.toMatch(/token|password|DATABASE_URL/i);
    // A request relayed by a proxy is not "this machine".
    expect((await local.get('/metrics', { 'x-forwarded-for': '203.0.113.9' })).status).toBe(404);

    const guarded = await serve({ metricsToken: 'sekret-value' });
    expect((await guarded.get('/metrics')).status).toBe(404);
    expect((await guarded.get('/metrics', { authorization: 'Bearer wrong' })).status).toBe(404);
    const allowed = await guarded.get('/metrics', { authorization: 'Bearer sekret-value' });
    expect(allowed.status).toBe(200);
    expect(allowed.body).not.toContain('sekret-value');
  });

  it('leaves every other path alone', async () => {
    const s = await serve();
    expect((await s.get('/api/leaderboard')).status).toBe(418);
    expect((await s.get('/')).status).toBe(418);
  });
});

describe('logs and metrics', () => {
  it('writes one JSON object per line in JSON mode, with the error details only in the log', () => {
    const lines: string[] = [];
    const log = createLogger({ format: 'json', write: (_level, line) => lines.push(line) });
    const errorId = newErrorId();
    log.error('socket', 'handler failed', { errorId, error: new Error('kaboom') });
    log.line('[db] migrations: up to date');
    const [first, second] = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(first).toMatchObject({
      level: 'error',
      scope: 'socket',
      msg: 'handler failed',
      errorId,
    });
    expect((first.error as { stack: string }).stack).toContain('kaboom');
    expect(second).toMatchObject({ level: 'info', scope: 'db', msg: 'migrations: up to date' });
    expect(errorId).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    const text: string[] = [];
    createLogger({ format: 'text', write: (_l, line) => text.push(line) }).warn('net', 'refused', {
      origin: 2,
    });
    expect(text).toEqual(['[net] refused origin=2']);
  });

  it('reports the last ten seconds, not everything since boot', () => {
    const h = new RecentHistogram();
    h.record(100, 1_000);
    h.record(2, 15_000);
    h.record(4, 15_500);
    expect(h.read(16_000)).toMatchObject({ count: 2, max: 4 });
    const c = new RecentCounter();
    for (let t = 0; t < 10_000; t += 100) c.add(1, 20_000 + t);
    expect(c.rate(30_000)).toBeCloseTo(10, 0);
    expect(c.total).toBe(100);
  });

  it('forgets rate-limit buckets once they refill, never a busy one', () => {
    const buckets = new BucketMap(2, 1);
    expect(buckets.take('a', 0)).toBe(true);
    expect(buckets.take('a', 0)).toBe(true);
    expect(buckets.take('a', 0)).toBe(false);
    expect(buckets.take('b', 0)).toBe(true);
    buckets.sweep(500);
    expect(buckets.size).toBe(2);
    buckets.sweep(2500);
    expect(buckets.size).toBe(0);
    // A forgotten address starts again with a full burst, which it had earned anyway.
    expect(buckets.take('a', 2500)).toBe(true);
  });

  it('counts what the rooms do: ticks, how late they ran, and snapshots', () => {
    const metrics = new Metrics();
    const clock = new ManualClock();
    const manager = new RoomManager(track, clock.now, { metrics, log: silentLogger });
    const { room, seats } = roomWith(manager, 2);
    startRace(room, seats);
    for (let i = 0; i < 120; i++) {
      clock.advance(TICK_MS);
      manager.update();
    }
    const ticks = room.currentRace!.sim.tick;
    expect(ticks).toBeGreaterThan(60);
    expect(metrics.ticks.total).toBe(ticks);
    const late = metrics.tickLateness.read();
    expect(late.count).toBe(ticks);
    // Updated every 16.7 ms, a tick never runs a whole tick late.
    expect(late.max).toBeLessThan(TICK_MS + 0.01);
    expect(metrics.snapshots.total).toBe(Math.floor(ticks / 3) * 2);
    expect(metrics.snapshotBytes.read().count).toBeGreaterThan(0);
  });
});
