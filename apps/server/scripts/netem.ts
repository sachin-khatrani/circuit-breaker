/**
 * A TCP proxy that makes a link worse on purpose, to test the game on a bad network. It sits
 * between a client (a harness bot, or a real browser) and the server, and the client connects
 * to it instead: client → 127.0.0.1:listen → target. Per direction, every chunk of data is:
 *
 *   * delayed by `latencyMs` plus up to `jitterMs`, in order (as TCP delivers it);
 *   * with probability `loss`, held back `lossStallMs` more, as when a packet is lost and TCP
 *     resends it: everything behind it waits too (head-of-line blocking), then arrives at once;
 *   * during an outage, held until the outage ends (Wi-Fi gone for a moment: the connection
 *     stays open, nothing moves; long enough and the ping timeouts end it);
 *   * on a cut, thrown away with the connection (a reset: a network change, a dead router).
 *
 * Used by the harness's network scenarios, and from the command line in front of a running
 * server for browser tests:
 *
 *   npx tsx scripts/netem.ts --listen 4400 --target 3001 --latency 50 --jitter 10 --loss 0.02
 *   then type on stdin: outage 5000 | cut | cut /socket.io/ | latency 100 | loss 0.05 | quit
 */
import { createServer, connect, type Server, type Socket } from 'node:net';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export interface NetemOptions {
  /** One-way delay added in each direction (ms): the round trip grows by twice this. */
  latencyMs: number;
  jitterMs: number;
  /** Chance per chunk of a stall standing in for a lost packet, and how long it lasts (ms). */
  loss: number;
  lossStallMs: number;
}

const now = () => performance.now();

/**
 * One direction of a connection: delayed delivery, strictly in order. Everything waits in one
 * queue drained by one timer: separate timers per chunk can fire out of order (Node truncates
 * fractional delays), which corrupts the stream.
 */
class Pipe {
  private last = 0;
  private ended = false;
  private readonly queue: { at: number; run: () => void }[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly proxy: NetemProxy,
    private readonly to: Socket,
  ) {}

  push(chunk: Buffer): void {
    this.schedule(() => this.to.write(chunk));
  }

  /** The other side finished: end this side after the data in flight. */
  end(): void {
    this.schedule(() => this.to.end());
  }

  private schedule(run: () => void): void {
    if (this.ended) return;
    const o = this.proxy.options;
    let at = now() + o.latencyMs + Math.random() * o.jitterMs;
    if (o.loss > 0 && Math.random() < o.loss) at += o.lossStallMs * (0.75 + Math.random() * 0.5);
    at = Math.max(at, this.last, this.proxy.outageUntil);
    this.last = at;
    this.queue.push({ at, run });
    if (!this.timer) this.wake();
  }

  /** Delivers everything due, in order, then sleeps until the next item is due. */
  private wake(): void {
    this.timer = null;
    // An outage that started after these were queued holds them too.
    const hold = this.proxy.outageUntil;
    while (this.queue.length > 0 && this.queue[0].at <= now() && hold <= now()) {
      const item = this.queue.shift()!;
      if (!this.to.destroyed) item.run();
    }
    if (this.queue.length === 0 || this.ended) return;
    const next = Math.max(this.queue[0].at, hold);
    this.timer = setTimeout(() => this.wake(), Math.max(1, Math.ceil(next - now())));
  }

  close(): void {
    this.ended = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.queue.length = 0;
  }
}

export class NetemProxy {
  options: NetemOptions;
  /** Until this time (performance.now) nothing is delivered in either direction. */
  outageUntil = 0;
  private server: Server | null = null;
  private readonly links = new Set<{ client: Socket; upstream: Socket; request: string }>();

  constructor(
    private readonly target: { host: string; port: number },
    options: Partial<NetemOptions> = {},
  ) {
    this.options = { latencyMs: 0, jitterMs: 0, loss: 0, lossStallMs: 250, ...options };
  }

  /** Starts listening (port 0: any free port); resolves to the port. */
  listen(port = 0, host = '127.0.0.1'): Promise<number> {
    this.server = createServer((client) => this.link(client));
    return new Promise((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(port, host, () => {
        resolve((this.server!.address() as { port: number }).port);
      });
    });
  }

  /** Open connections right now. */
  get connections(): number {
    return this.links.size;
  }

  /** Nothing crosses the link for `ms` (connections stay open); data waits, then flows. */
  outage(ms: number): void {
    this.outageUntil = Math.max(this.outageUntil, now() + ms);
  }

  /**
   * Resets open connections: both ends see them drop now. With `match`, only connections whose
   * first request line contains it (`/socket.io/`: the game's own, not a dev server's).
   */
  cut(match?: string): void {
    for (const link of [...this.links]) {
      if (match && !link.request.includes(match)) continue;
      link.client.destroy();
      link.upstream.destroy();
      this.links.delete(link);
    }
  }

  async close(): Promise<void> {
    this.cut();
    await new Promise<void>((resolve) =>
      this.server ? this.server.close(() => resolve()) : resolve(),
    );
  }

  private link(client: Socket): void {
    const upstream = connect(this.target.port, this.target.host);
    client.setNoDelay(true);
    upstream.setNoDelay(true);
    const link = { client, upstream, request: '' };
    this.links.add(link);
    const up = new Pipe(this, upstream);
    const down = new Pipe(this, client);
    client.on('data', (chunk: Buffer) => {
      if (!link.request) link.request = chunk.toString('latin1', 0, 200).split('\r\n')[0];
      up.push(chunk);
    });
    upstream.on('data', (chunk: Buffer) => down.push(chunk));
    client.on('end', () => up.end());
    upstream.on('end', () => down.end());
    const drop = () => {
      up.close();
      down.close();
      client.destroy();
      upstream.destroy();
      this.links.delete(link);
    };
    client.on('error', drop);
    upstream.on('error', drop);
    client.on('close', () => {
      // A clean close travels through the delay; a reset (cut) is immediate.
      if (!upstream.destroyed) setTimeout(drop, this.options.latencyMs + 50);
    });
    upstream.on('close', () => {
      if (!client.destroyed) setTimeout(drop, this.options.latencyMs + 50);
    });
  }
}

// --- Command line ---------------------------------------------------------------------------------

async function main(): Promise<void> {
  const arg = (name: string, fallback: string) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
  };
  const target = arg('target', '3001');
  const [host, port] = target.includes(':') ? target.split(':') : ['127.0.0.1', target];
  const proxy = new NetemProxy(
    { host, port: Number(port) },
    {
      latencyMs: Number(arg('latency', '0')),
      jitterMs: Number(arg('jitter', '0')),
      loss: Number(arg('loss', '0')),
      lossStallMs: Number(arg('stall', '250')),
    },
  );
  const listen = await proxy.listen(Number(arg('listen', '4400')), arg('host', '127.0.0.1'));
  const show = () => JSON.stringify(proxy.options);
  console.log(`netem: 127.0.0.1:${listen} -> ${host}:${port} ${show()}`);
  createInterface({ input: process.stdin }).on('line', (line) => {
    const [command, value] = line.trim().split(/\s+/);
    const n = Number(value);
    if (command === 'outage') proxy.outage(n);
    else if (command === 'cut') proxy.cut(value);
    else if (command === 'latency') proxy.options.latencyMs = n;
    else if (command === 'jitter') proxy.options.jitterMs = n;
    else if (command === 'loss') proxy.options.loss = n;
    else if (command === 'quit') void proxy.close().then(() => process.exit(0));
    else if (command)
      console.log('commands: outage MS | cut [TEXT] | latency MS | jitter MS | loss P | quit');
    console.log(`netem: ${command ?? ''} ${show()} open ${proxy.connections}`);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void main();
