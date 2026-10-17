import { EV, PROTOCOL_VERSION, type Ack, type SeatGrant } from '@circuit-breaker/shared';
import { fork } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { io as connect, type Socket } from 'socket.io-client';
import { describe, expect, it } from 'vitest';

/**
 * The real server process (src/index.ts, production mode, ranking off), shut down while two
 * players sit in a room: new players are refused, the seated ones are told why, the process
 * exits on its own.
 */

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const port = (probe.address() as { port: number }).port;
      probe.close(() => resolve(port));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('the server process', () => {
  it('shuts down gracefully: refuses newcomers, tells every player, exits by itself', async () => {
    const port = await freePort();
    const child = fork(fileURLToPath(new URL('../src/index.ts', import.meta.url)), [], {
      execArgv: ['--import', 'tsx'],
      env: {
        ...process.env,
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
        PORT: String(port),
        DATABASE_URL: '',
        LOG_FORMAT: 'json',
        CLIENT_DIST: fileURLToPath(new URL('./no-client/', import.meta.url)),
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const logs: string[] = [];
    child.stdout?.on('data', (d: Buffer) => logs.push(...d.toString().split('\n').filter(Boolean)));
    child.stderr?.on('data', (d: Buffer) => logs.push(...d.toString().split('\n').filter(Boolean)));
    const exited = new Promise<number | null>((resolve) =>
      child.once('exit', (code) => resolve(code)),
    );
    const url = `http://127.0.0.1:${port}`;
    try {
      for (let i = 0; i < 100; i++) {
        try {
          if ((await fetch(`${url}/ready`)).ok) break;
        } catch {
          // not listening yet
        }
        await sleep(100);
      }
      const ready = (await (await fetch(`${url}/ready`)).json()) as { ready: boolean };
      expect(ready.ready).toBe(true);

      const sockets: Socket[] = [];
      const seat = async (payload: Record<string, unknown>, event: string) => {
        const s = connect(url, { transports: ['websocket'], forceNew: true, reconnection: false });
        sockets.push(s);
        await new Promise<void>((r) => s.once('connect', () => r()));
        const ack = (await s.timeout(3000).emitWithAck(event, {
          ...payload,
          version: PROTOCOL_VERSION,
        })) as Ack<SeatGrant>;
        if (!ack.ok) throw new Error(ack.error);
        return { socket: s, grant: ack.data };
      };
      const host = await seat({ name: 'Host' }, EV.create);
      const guest = await seat({ name: 'Guest', code: host.grant.room.code }, EV.join);
      const told = sockets.map(
        (s) =>
          new Promise<string>((resolve) =>
            s.once(EV.kicked, (p: { reason: string }) => resolve(p.reason)),
          ),
      );
      const closed = sockets.map(
        (s) => new Promise<void>((resolve) => s.once('disconnect', () => resolve())),
      );
      void guest;

      child.send('shutdown');
      const reasons = await Promise.all(told);
      for (const reason of reasons) expect(reason).toMatch(/restarting/);
      await Promise.all(closed);
      // Nobody new gets in while it closes.
      const late = connect(url, { transports: ['websocket'], forceNew: true, reconnection: false });
      const refused = await new Promise<boolean>((resolve) => {
        late.once('connect', () => resolve(false));
        late.once('connect_error', () => resolve(true));
      });
      late.close();
      expect(refused).toBe(true);
      expect(await exited).toBe(0);
      const lines = logs.map((l) => JSON.parse(l) as { scope: string; msg: string; why?: string });
      expect(lines.some((l) => l.msg === 'shutting down' && l.why === 'IPC request')).toBe(true);
    } finally {
      if (child.exitCode === null) child.kill();
    }
  }, 30_000);
});
