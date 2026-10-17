/**
 * Load test. Starts the built server (apps/server/dist/index.js, production mode) as its own
 * process for each level, connects bot players from separate worker processes, and polls the
 * server's own /metrics while the rooms race back to back. The bots are the harness's: real
 * Socket.IO clients running the browser's netcode and the shared simulation (prediction,
 * clock sync, inputs), so the server does exactly the work real players cause.
 *
 * Every bot claims its own address through X-Forwarded-For and the server trusts one proxy
 * hop (TRUST_PROXY=1, as on Render), so the per-address limits apply as they would to real
 * players; nothing is raised for the test except the total connection cap.
 *
 *   npm run build
 *   npm run load -w @circuit-breaker/server                       every level, 90 s each
 *   npm run load -w @circuit-breaker/server -- --levels 2p,8p --seconds 60
 *   (options: --rtt 60 --jitter 10 simulated latency per bot; --workers 4; --force keeps
 *   going after an unstable level; --out file.json)
 *
 * With TEST_DATABASE_URL set, two bots per room have profiles, so every race is rated and
 * written to a throwaway schema (dropped at the end); they reload their profile and the
 * leaderboard after each rated race, as the browser does. Without it, ranking is off.
 */
import { spawn, fork, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { EV, type RaceRating } from '@circuit-breaker/shared';
import { createPgDb } from '../src/db/db';
import { Bot, BotStats, now, sleep, spreadMs, type SpreadMs } from './bot';

/** Levels in the order they run: each one only after the one before it was stable. */
const LEVELS = new Map<string, number[]>([
  ['2p', [2]],
  ['8p', [8]],
  ['5rooms', [4, 4, 4, 4, 4]],
  ['10rooms', [4, 4, 4, 4, 4, 4, 4, 4, 4, 4]],
  ['50', [8, 8, 8, 8, 8, 8, 2]],
  ['100', [8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 4]],
]);

const REPORT_MS = 5000;

interface WorkerPlan {
  worker: number;
  url: string;
  rooms: { index: number; players: number }[];
  rttMs: number;
  jitterMs: number;
  profiles: boolean;
}

interface WorkerReport {
  worker: number;
  bots: number;
  racing: number;
  gap: SpreadMs;
  age: SpreadMs;
  rtt: SpreadMs;
  bytes: SpreadMs;
  snapshots: number;
  disconnects: number;
  connectErrors: number;
  races: number;
  corrections: number;
  maxCorrection: number;
  cpuPercent: number;
  apiFailures: number;
}

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

// --- Worker: one process driving some of the rooms ------------------------------------------------

async function runWorker(plan: WorkerPlan): Promise<void> {
  const stats = new BotStats();
  const rooms: Bot[][] = [];
  let apiFailures = 0;
  for (const room of plan.rooms) {
    const bots = Array.from(
      { length: room.players },
      (_, i) =>
        new Bot(`R${room.index}P${i + 1}`, {
          rttMs: plan.rttMs,
          jitterMs: plan.jitterMs,
          address: `10.${plan.worker}.${room.index}.${i + 1}`,
          stats,
          recordCourse: false,
          autopilot: { boost: true, racingLine: true, pace: 0.97 - (i % 4) * 0.01 },
          abilities: i % 2 === 0 ? { gate: true, overdrive: true, shortcut: true } : undefined,
        }),
    );
    // Two profiles a room: every race is rated (written to the database).
    if (plan.profiles) {
      for (const b of bots.slice(0, 2)) await b.profile(plan.url);
    }
    const [host, ...guests] = bots;
    await host.connect(plan.url);
    const code = (await host.create()).room.code;
    for (const g of guests) {
      await g.connect(plan.url);
      await g.join(code);
      await g.request(EV.ready, { ready: true, raceId: 0 });
    }
    await host.request(EV.laps, { laps: 1 });
    rooms.push(bots);
  }
  const all = rooms.flat();
  const loop = setInterval(() => {
    for (const b of all) b.update();
  }, 4);

  // Races back to back: guests ready up between races, the host starts the next one.
  const seen = new Map<Bot, number>();
  const ready = setInterval(() => {
    for (const bots of rooms) {
      const [host, ...guests] = bots;
      const room = host.room;
      if (!room) continue;
      const between =
        room.phase === 'waiting' || room.phase === 'ready' || room.phase === 'results';
      for (const g of guests) {
        const me = room.players.find((p) => p.id === g.playerId);
        if (between && me && !me.ready)
          void g.request(EV.ready, { ready: true, raceId: room.raceId });
      }
      const others = room.players.filter((p) => p.id !== host.playerId);
      if (between && others.every((p) => p.ready && p.connected)) {
        const event = room.phase === 'results' ? EV.restart : EV.start;
        void host.request(event, { raceId: room.raceId });
      }
    }
    // Profiles reload after a rated race, like the browser's results screen.
    for (const b of all) {
      if (!b.cookie) continue;
      const rated = b.ratings.filter((r: RaceRating) => r.status === 'rated').length;
      if (rated > (seen.get(b) ?? 0)) {
        seen.set(b, rated);
        void b.refreshProfile(plan.url).then(
          (ok) => (apiFailures += ok ? 0 : 1),
          () => apiFailures++,
        );
      }
    }
  }, 1000);

  let cpu = process.cpuUsage();
  let at = now();
  const report = setInterval(() => {
    const used = process.cpuUsage(cpu);
    const elapsed = now() - at;
    cpu = process.cpuUsage();
    at = now();
    const message: WorkerReport = {
      worker: plan.worker,
      bots: all.length,
      racing: all.filter((b) => b.predictor && b.results?.raceId !== b.race?.raceId).length,
      gap: spreadMs(stats.snapshotGap),
      age: spreadMs(stats.snapshotAge),
      rtt: spreadMs(stats.ackRtt),
      bytes: spreadMs(stats.snapshotBytes, 1),
      snapshots: stats.snapshots,
      disconnects: stats.disconnects,
      connectErrors: stats.connectErrors,
      races: stats.races,
      corrections: stats.corrections,
      maxCorrection: Math.round(stats.maxCorrection * 100) / 100,
      cpuPercent: Math.round(((used.user + used.system) / 1000 / elapsed) * 1000) / 10,
      apiFailures,
    };
    apiFailures = 0;
    stats.reset();
    process.send?.({ type: 'report', report: message });
  }, REPORT_MS);

  process.send?.({ type: 'seated', worker: plan.worker });
  process.on('message', (m: { type: string }) => {
    if (m.type !== 'stop') return;
    clearInterval(loop);
    clearInterval(ready);
    clearInterval(report);
    for (const b of all) b.drop();
    setTimeout(() => process.exit(0), 200);
  });
}

// --- Orchestrator -----------------------------------------------------------------------------------

interface ServerSample {
  at: number;
  body: ServerMetrics;
}

/** The parts of /metrics this script reads (see src/ops.ts). */
interface ServerMetrics {
  process: {
    cpuPercent: number;
    loopUtilizationPercent: number;
    rssMB: number;
    heapUsedMB: number;
    loopDelayMs: SpreadMs;
  };
  rooms: { rooms: number; racing: number; seats: number; connectedSeats: number };
  connections: {
    open: number;
    accepted: number;
    refused: Record<string, number>;
    disconnects: Record<string, number>;
  };
  messages: {
    inPerSecond: number;
    refused: number;
    abuseDisconnects: number;
    handlerErrors: number;
  };
  simulation: { ticksPerSecond: number; tickLateMs: SpreadMs; roomErrors: number };
  snapshots: { perSecond: number; discardedPerSecond: number; bytes: SpreadMs };
  network: { bytesOutPerSecond: number };
  database: {
    database: string;
    pending: number;
    queries: number;
    errors: number;
    latencyMs: SpreadMs;
  };
  api: { requests: number; status4xx: number; status5xx: number; latencyMs: SpreadMs };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as { port: number }).port;
      probe.close(() => resolve(port));
    });
  });
}

async function startServer(port: number, databaseUrl: string | null, log: string[]) {
  const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
  if (!existsSync(entry)) throw new Error('Build the server first: npm run build');
  const child = spawn(process.execPath, ['--enable-source-maps', entry], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: String(port),
      TRUST_PROXY: '1',
      LOG_FORMAT: 'json',
      MAX_CONNECTIONS: '2000',
      DATABASE_URL: databaseUrl ?? '',
      METRICS_TOKEN: '',
      CLIENT_DIST: fileURLToPath(new URL('./no-client/', import.meta.url)),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const collect = (chunk: Buffer) => log.push(...chunk.toString().split('\n').filter(Boolean));
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const url = `http://127.0.0.1:${port}`;
  const deadline = now() + 20_000;
  for (;;) {
    try {
      const res = await fetch(`${url}/ready`);
      if (res.ok) {
        const body = (await res.json()) as { checks: { database: string } };
        if (!databaseUrl || body.checks.database === 'ok') break;
      }
    } catch {
      // not listening yet
    }
    if (now() > deadline) throw new Error('the server did not become ready');
    await sleep(200);
  }
  return { child, url };
}

const median = (values: number[]) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
const max = (values: number[]) => (values.length === 0 ? 0 : Math.max(...values));
const mean = (values: number[]) =>
  values.length === 0
    ? 0
    : Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10;
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

async function runLevel(
  name: string,
  rooms: number[],
  options: { seconds: number; warmup: number; workers: number; rttMs: number; jitterMs: number },
  databaseUrl: string | null,
) {
  const port = await freePort();
  const serverLog: string[] = [];
  const { child, url } = await startServer(port, databaseUrl, serverLog);
  const clients = sum(rooms);
  const workerCount = Math.min(options.workers, rooms.length);
  const plans: WorkerPlan[] = Array.from({ length: workerCount }, (_, w) => ({
    worker: w,
    url,
    rooms: [],
    rttMs: options.rttMs,
    jitterMs: options.jitterMs,
    profiles: databaseUrl !== null,
  }));
  rooms.forEach((players, index) => plans[index % workerCount].rooms.push({ index, players }));

  const reports: { at: number; report: WorkerReport }[] = [];
  const workers: ChildProcess[] = [];
  let seated = 0;
  const started = now();
  for (const plan of plans) {
    const worker = fork(fileURLToPath(import.meta.url), ['--worker', JSON.stringify(plan)], {
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    worker.on('message', (m: { type: string; report?: WorkerReport }) => {
      if (m.type === 'seated') seated++;
      if (m.type === 'report' && m.report) reports.push({ at: now(), report: m.report });
    });
    workers.push(worker);
  }
  while (seated < workers.length) {
    if (now() - started > 120_000) throw new Error(`${name}: bots could not all take a seat`);
    await sleep(100);
  }
  const seatedAt = now();
  console.log(
    `  ${name}: ${clients} bots seated in ${rooms.length} room(s) after ${((seatedAt - started) / 1000).toFixed(1)} s`,
  );

  const samples: ServerSample[] = [];
  const measureFrom = seatedAt + options.warmup * 1000;
  const until = measureFrom + options.seconds * 1000;
  let first: ServerMetrics | null = null;
  while (now() < until) {
    await sleep(REPORT_MS);
    try {
      const body = (await (await fetch(`${url}/metrics`)).json()) as ServerMetrics;
      if (now() >= measureFrom) {
        first ??= body;
        samples.push({ at: now(), body });
      }
    } catch (error) {
      console.warn(`  /metrics failed: ${String(error)}`);
    }
  }
  for (const w of workers) w.send({ type: 'stop' });
  await sleep(1000);
  child.kill();
  for (const w of workers) if (w.exitCode === null) w.kill();

  const measured = reports.filter((r) => r.at >= measureFrom + REPORT_MS && r.at <= until + 1000);
  const s = samples.map((x) => x.body);
  const last = s.at(-1)!;
  const disconnectsDuring = Object.entries(last.connections.disconnects).filter(
    ([reason]) => reason !== 'server shutting down',
  );
  const errorsInLog = serverLog.filter((l) => /"level":"(error|warn)"/.test(l));
  const result = {
    level: name,
    clients,
    rooms: rooms.length,
    seconds: Math.round((samples.at(-1)!.at - samples[0].at) / 1000) + REPORT_MS / 1000,
    server: {
      cpuPercentMean: mean(s.map((b) => b.process.cpuPercent)),
      cpuPercentMax: max(s.map((b) => b.process.cpuPercent)),
      loopUtilizationPercentMean: mean(s.map((b) => b.process.loopUtilizationPercent)),
      rssMBMax: max(s.map((b) => b.process.rssMB)),
      heapUsedMBMax: max(s.map((b) => b.process.heapUsedMB)),
      loopDelayMsP99Max: max(s.map((b) => b.process.loopDelayMs.p99)),
      tickLateMsP50: median(s.map((b) => b.simulation.tickLateMs.p50)),
      tickLateMsP99Max: max(s.map((b) => b.simulation.tickLateMs.p99)),
      tickLateMsMax: max(s.map((b) => b.simulation.tickLateMs.max)),
      ticksPerSecondMean: mean(s.map((b) => b.simulation.ticksPerSecond)),
      racingRoomsMean: mean(s.map((b) => b.rooms.racing)),
      snapshotsPerSecondMean: mean(s.map((b) => b.snapshots.perSecond)),
      snapshotsDiscardedPerSecondMean: mean(s.map((b) => b.snapshots.discardedPerSecond)),
      snapshotBytesP50: median(s.map((b) => b.snapshots.bytes.p50)),
      snapshotBytesMax: max(s.map((b) => b.snapshots.bytes.max)),
      bytesOutPerSecondMean: mean(s.map((b) => b.network.bytesOutPerSecond)),
      messagesInPerSecondMean: mean(s.map((b) => b.messages.inPerSecond)),
      connectionsOpenMax: max(s.map((b) => b.connections.open)),
      disconnects: Object.fromEntries(disconnectsDuring),
      refused: last.connections.refused,
      messagesRefused: last.messages.refused,
      abuseDisconnects: last.messages.abuseDisconnects,
      handlerErrors: last.messages.handlerErrors,
      roomErrors: last.simulation.roomErrors,
      dbQueries: last.database.queries - (first?.database.queries ?? 0),
      dbErrors: last.database.errors,
      dbLatencyMsP50: median(s.map((b) => b.database.latencyMs.p50).filter((v) => v > 0)),
      dbLatencyMsP99Max: max(s.map((b) => b.database.latencyMs.p99)),
      dbLatencyMsMax: max(s.map((b) => b.database.latencyMs.max)),
      ratingsPending: last.database.pending,
      api5xx: last.api.status5xx,
      apiLatencyMsP99Max: max(s.map((b) => b.api.latencyMs.p99)),
      logWarningsOrErrors: errorsInLog.length,
    },
    clients_: {
      snapshotGapMsP50: median(measured.map((r) => r.report.gap.p50)),
      snapshotGapMsP99Max: max(measured.map((r) => r.report.gap.p99)),
      snapshotGapMsMax: max(measured.map((r) => r.report.gap.max)),
      snapshotAgeMsP50: median(measured.map((r) => r.report.age.p50)),
      snapshotAgeMsP99Max: max(measured.map((r) => r.report.age.p99)),
      snapshotAgeMsMax: max(measured.map((r) => r.report.age.max)),
      ackRttMsP50: median(measured.map((r) => r.report.rtt.p50)),
      ackRttMsP99Max: max(measured.map((r) => r.report.rtt.p99)),
      snapshotBytesP50: median(measured.map((r) => r.report.bytes.p50)),
      snapshotsReceived: sum(measured.map((r) => r.report.snapshots)),
      racesFinished: sum(measured.map((r) => r.report.races)),
      corrections: sum(measured.map((r) => r.report.corrections)),
      maxCorrectionM: max(measured.map((r) => r.report.maxCorrection)),
      disconnects: sum(reports.map((r) => r.report.disconnects)),
      connectErrors: sum(reports.map((r) => r.report.connectErrors)),
      apiFailures: sum(reports.map((r) => r.report.apiFailures)),
      botCpuPercentMax: max(measured.map((r) => r.report.cpuPercent)),
    },
  };
  const stable =
    result.clients_.disconnects === 0 &&
    result.clients_.connectErrors === 0 &&
    result.server.handlerErrors === 0 &&
    result.server.roomErrors === 0 &&
    result.server.abuseDisconnects === 0 &&
    result.server.tickLateMsP99Max < 50 &&
    result.server.cpuPercentMax < 90;
  return { ...result, stable, serverLogTail: errorsInLog.slice(-10) };
}

async function main(): Promise<void> {
  if (process.argv.includes('--worker')) {
    await runWorker(JSON.parse(arg('worker', '{}')) as WorkerPlan);
    return;
  }
  const wanted = arg('levels', [...LEVELS.keys()].join(',')).split(',');
  for (const n of wanted) if (!LEVELS.has(n)) throw new Error(`Unknown level ${n}`);
  // Always in increasing order, whatever order they were asked for in.
  const names = [...LEVELS.keys()].filter((n) => wanted.includes(n));
  const options = {
    seconds: Number(arg('seconds', '90')),
    warmup: Number(arg('warmup', '15')),
    workers: Number(arg('workers', '4')),
    rttMs: Number(arg('rtt', '0')),
    jitterMs: Number(arg('jitter', '0')),
  };
  const force = process.argv.includes('--force');

  // A throwaway schema for the ratings, never the server's own database.
  let databaseUrl: string | null = null;
  let dropSchema: (() => Promise<void>) | null = null;
  const testUrl = process.env.TEST_DATABASE_URL;
  if (testUrl) {
    if (testUrl === process.env.DATABASE_URL) throw new Error('TEST_DATABASE_URL is DATABASE_URL');
    const schema = `cb_load_${randomBytes(6).toString('hex')}`;
    const admin = createPgDb({ connectionString: testUrl, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(testUrl);
    scoped.searchParams.set('options', `-c search_path=${schema}`);
    databaseUrl = scoped.toString();
    dropSchema = async () => {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.close();
    };
  }

  console.log(
    `load test: levels ${names.join(', ')}; ${options.seconds} s measured per level after ` +
      `${options.warmup} s warm-up; ${options.workers} bot workers; simulated rtt ` +
      `${options.rttMs} ms; ratings ${databaseUrl ? 'in a throwaway PostgreSQL schema' : 'off'}`,
  );
  const results = [];
  try {
    for (const name of names) {
      const result = await runLevel(name, LEVELS.get(name)!, options, databaseUrl);
      results.push(result);
      const sv = result.server;
      const cl = result.clients_;
      console.log(
        `  ${result.stable ? 'STABLE  ' : 'UNSTABLE'} ${name}: ${result.clients} clients, ` +
          `${result.rooms} rooms, ${result.seconds} s | server cpu ${sv.cpuPercentMean}% ` +
          `(max ${sv.cpuPercentMax}%), rss ${sv.rssMBMax} MB, tick late p50 ${sv.tickLateMsP50} ` +
          `p99 ${sv.tickLateMsP99Max} max ${sv.tickLateMsMax} ms, loop p99 ` +
          `${sv.loopDelayMsP99Max} ms, ${sv.snapshotsPerSecondMean} snap/s of ` +
          `${sv.snapshotBytesP50} B (${sv.snapshotsDiscardedPerSecondMean}/s discarded), ` +
          `${Math.round(sv.bytesOutPerSecondMean / 1024)} KB/s out, ` +
          `db ${sv.dbQueries} queries p99 ${sv.dbLatencyMsP99Max} ms | clients: snapshot gap ` +
          `p99 ${cl.snapshotGapMsP99Max} ms, age p50 ${cl.snapshotAgeMsP50} p99 ` +
          `${cl.snapshotAgeMsP99Max} ms, ack rtt p99 ${cl.ackRttMsP99Max} ms, ` +
          `${cl.racesFinished} race results, ${cl.corrections} corrections, ` +
          `${cl.disconnects} disconnects, bot cpu max ${cl.botCpuPercentMax}%`,
      );
      if (!result.stable && !force) {
        console.log('  stopping: this level was not stable (use --force to go on)');
        break;
      }
    }
  } finally {
    await dropSchema?.();
  }
  const out = arg('out', 'load-results.json');
  writeFileSync(out, JSON.stringify({ options, results }, null, 2));
  console.log(`results written to ${out}`);
  process.exit(0);
}

void main();
