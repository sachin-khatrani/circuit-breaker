import {
  rateRace,
  type ApiError,
  type LeaderboardResponse,
  type MeResponse,
  type PlayerResponse,
  type ProfileResponse,
  type RecoveryCodeResponse,
  type SearchResponse,
  type TicketResponse,
} from '@circuit-breaker/shared';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApi, SESSION_COOKIE, type ApiOptions } from '../src/api/http';
import { createLogger, silentLogger } from '../src/log';
import { RankingService } from '../src/ranking/service';
import { RankingStore } from '../src/ranking/store';
import { FlakyDb, TEST_DATABASES, type TestDb } from './db';

const pglite = TEST_DATABASES[0];

interface Running {
  url: string;
  svc: RankingService;
  store: RankingStore;
  db: FlakyDb;
}

const servers: Server[] = [];
const services: RankingService[] = [];
const dbs: TestDb[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
  for (const s of services.splice(0)) await s.close(50);
  for (const d of dbs.splice(0)) await d.drop();
});

async function serve(options: ApiOptions = {}, withDb = true): Promise<Running> {
  const t = await pglite.open();
  dbs.push(t);
  const db = new FlakyDb(t.db);
  const store = new RankingStore(db);
  const svc = new RankingService(withDb ? store : null, { log: () => {} });
  services.push(svc);
  await svc.start();
  // Generous budgets, except where a test sets its own: one address makes every request here.
  const roomy = { burst: 1000, perHour: 100_000 };
  const api = createApi(svc, {
    log: silentLogger,
    ...options,
    limits: { read: roomy, write: roomy, create: roomy, recover: roomy, ...options.limits },
  });
  const server = createServer((req, res) => {
    if (!api(req, res)) {
      res.writeHead(404);
      res.end();
    }
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, svc, store, db };
}

/** A browser: keeps the session cookie the server sets, sends it back. */
class Browser {
  cookie: string | null = null;
  lastSetCookie: string | null = null;
  constructor(private readonly base: string) {}
  async call<T = ApiError>(
    path: string,
    init: RequestInit & { json?: unknown } = {},
  ): Promise<{ status: number; headers: Headers; body: T }> {
    const headers = new Headers(init.headers);
    if (this.cookie) headers.set('cookie', `${SESSION_COOKIE}=${this.cookie}`);
    let body = init.body;
    if (init.json !== undefined) {
      headers.set('content-type', 'application/json');
      body = JSON.stringify(init.json);
    }
    const res = await fetch(this.base + path, {
      ...init,
      headers,
      body,
      method: init.method ?? (body ? 'POST' : 'GET'),
    });
    const set = res.headers.get('set-cookie');
    this.lastSetCookie = set;
    if (set) {
      const value = /^cb_player=([^;]*)/.exec(set)?.[1] ?? '';
      this.cookie = /Max-Age=0/.test(set) || value === '' ? null : value;
    }
    const text = await res.text();
    return {
      status: res.status,
      headers: res.headers,
      body: (text ? JSON.parse(text) : null) as T,
    };
  }
}

describe('ranking API', () => {
  it('makes a profile with an HTTP-only cookie, and knows the browser by it', async () => {
    const { url } = await serve();
    const browser = new Browser(url);
    expect((await browser.call<MeResponse>('/api/me')).body).toEqual({
      ranking: true,
      player: null,
    });
    const made = await browser.call<ProfileResponse>('/api/identity', {
      json: { nickname: 'Nova' },
    });
    expect(made.status).toBe(201);
    expect(browser.lastSetCookie).toMatch(
      /^cb_player=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=34560000$/,
    );
    // Plain HTTP: no Secure flag. The token is only in the cookie, never in the body.
    expect(JSON.stringify(made.body)).not.toContain(browser.cookie!);
    expect(made.body.player).toMatchObject({ nickname: 'Nova', rating: 1000, rank: null });
    const me = await browser.call<MeResponse>('/api/me');
    expect(me.body.player?.id).toBe(made.body.player.id);
    // Asking again from the same browser keeps the profile.
    const again = await browser.call<ProfileResponse>('/api/identity', { json: {} });
    expect(again.status).toBe(200);
    expect(again.body.player.id).toBe(made.body.player.id);
  });

  it('marks the cookie Secure behind a trusted HTTPS proxy only', async () => {
    const trusted = await serve({ trustProxyHops: 1 });
    const viaProxy = new Browser(trusted.url);
    await viaProxy.call('/api/identity', { json: {}, headers: { 'x-forwarded-proto': 'https' } });
    expect(viaProxy.lastSetCookie).toMatch(/; Secure$/);
    const untrusted = await serve();
    const direct = new Browser(untrusted.url);
    await direct.call('/api/identity', { json: {}, headers: { 'x-forwarded-proto': 'https' } });
    expect(direct.lastSetCookie).not.toMatch(/Secure/);
  });

  it('ignores forged cookies and clears them', async () => {
    const { url } = await serve();
    const browser = new Browser(url);
    browser.cookie = 'A'.repeat(43);
    const me = await browser.call<MeResponse>('/api/me');
    expect(me.body).toEqual({ ranking: true, player: null });
    expect(browser.lastSetCookie).toMatch(/^cb_player=; .*Max-Age=0/);
    browser.cookie = 'A'.repeat(43);
    expect((await browser.call('/api/me/ticket', { json: {} })).status).toBe(401);
    expect((await browser.call('/api/me/nickname', { json: { nickname: 'X' } })).status).toBe(401);
  });

  it('takes writes only as JSON from the game page, and small', async () => {
    const { url } = await serve();
    const browser = new Browser(url);
    const evil = await browser.call('/api/identity', {
      json: {},
      headers: { origin: 'http://evil.example' },
    });
    expect(evil.status).toBe(403);
    const form = await browser.call('/api/identity', {
      method: 'POST',
      body: 'nickname=x',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(form.status).toBe(415);
    const huge = await browser.call('/api/identity', { json: { nickname: 'x'.repeat(5000) } });
    expect(huge.status).toBe(413);
    const bad = await browser.call('/api/identity', {
      method: 'POST',
      body: '{nope',
      headers: { 'content-type': 'application/json' },
    });
    expect(bad.status).toBe(400);
    // Same origin is fine.
    const own = await browser.call('/api/identity', {
      json: {},
      headers: { origin: url },
    });
    expect(own.status).toBe(201);
    expect((await browser.call('/api/identity', { method: 'GET' })).status).toBe(405);
    expect((await browser.call('/api/nothing')).status).toBe(404);
  });

  it('restores a profile with a recovery code, issues tickets and limits renames', async () => {
    const { url, db } = await serve();
    const home = new Browser(url);
    const made = await home.call<ProfileResponse>('/api/identity', { json: { nickname: 'Ana' } });
    const code = await home.call<RecoveryCodeResponse>('/api/me/recovery-code', { json: {} });
    expect(code.body.code).toMatch(/^[0-9A-Z]{5}(-[0-9A-Z]{5}){3}$/);
    expect(code.body.player.hasRecoveryCode).toBe(true);
    // A new browser restores it.
    const phone = new Browser(url);
    const restored = await phone.call<ProfileResponse>('/api/identity/recover', {
      json: { code: code.body.code },
    });
    expect(restored.status).toBe(200);
    expect(restored.body.player.id).toBe(made.body.player.id);
    expect(phone.cookie).not.toBeNull();
    expect(phone.cookie).not.toBe(home.cookie);
    const wrong = await new Browser(url).call('/api/identity/recover', {
      json: { code: 'ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ' },
    });
    expect(wrong).toMatchObject({
      status: 400,
      body: { error: 'That recovery code is not valid.' },
    });
    // A seat ticket, with the typed room name.
    const ticket = await phone.call<TicketResponse>('/api/me/ticket', {
      json: { nickname: 'Ana Prime' },
    });
    expect(ticket.body).toMatchObject({ nicknameNote: null, player: { nickname: 'Ana Prime' } });
    expect(typeof ticket.body.ticket).toBe('string');
    // Names: validated, then five changes a day (the ticket above was the first).
    expect((await phone.call('/api/me/nickname', { json: { nickname: '<>' } })).status).toBe(400);
    for (let i = 2; i <= 5; i++) {
      expect(
        (await phone.call('/api/me/nickname', { json: { nickname: `Ana ${i}` } })).status,
      ).toBe(200);
    }
    const limited = await phone.call('/api/me/nickname', { json: { nickname: 'Ana 6' } });
    expect(limited.status).toBe(429);
    expect(limited.body.error).toMatch(/5 times a day/);
    // Every rename and ticket changed one profile: still one row, the same id, on both browsers.
    const count = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM players');
    expect(count.rows[0].n).toBe(1);
    const fromHome = await home.call<MeResponse>('/api/me');
    const fromPhone = await phone.call<MeResponse>('/api/me');
    expect(fromPhone.body.player?.id).toBe(made.body.player.id);
    expect(fromPhone.body.player?.nickname).toBe('Ana 5');
    // Restoring on the phone added a browser; `home` (which made the code) still has it too.
    expect(fromHome.body.player?.id).toBe(made.body.player.id);
  });

  it('pages and searches the leaderboard, and shows only public fields', async () => {
    const { url, store, svc } = await serve();
    const browsers = await Promise.all(
      ['Ana', 'Ben', 'Cy', 'Dee'].map(async (name) => {
        const b = new Browser(url);
        const made = await b.call<ProfileResponse>('/api/identity', { json: { nickname: name } });
        return { b, id: made.body.player.id };
      }),
    );
    // Two rated races, as the server would store them.
    for (const order of [
      [0, 1, 2],
      [0, 2, 3],
    ]) {
      const now = new Date();
      await store.applyRace(
        {
          id: randomUUID(),
          roomCode: 'ABCDEF',
          sessionId: 1,
          raceNumber: 1,
          trackId: 'grid-zero',
          laps: 1,
          fieldSize: 3,
          startedAt: now,
          completedAt: now,
          entries: order.map((i, k) => ({
            playerId: browsers[i].id,
            position: k + 1,
            finished: true,
            dnfReason: null,
            time: 45 + k,
            bestLap: 45 + k,
            stats: {
              boosts: 0,
              overdrives: 0,
              shortcuts: 0,
              gateShifts: 0,
              shortcutRuns: 0,
              energy: 0,
              driftSeconds: 0,
              topSpeed: 0,
              wallHits: 0,
            },
          })),
        },
        rateRace,
      );
    }
    const anon = new Browser(url);
    // After the two races: Ana (two wins), then Ben (one race, even: still 1000), Cy, Dee.
    const top = await anon.call<LeaderboardResponse>('/api/leaderboard?offset=0&limit=2');
    expect(top.body.total).toBe(4);
    expect(top.body.entries.map((e) => [e.rank, e.nickname])).toEqual([
      [1, 'Ana'],
      [2, 'Ben'],
    ]);
    const rest = await anon.call<LeaderboardResponse>('/api/leaderboard?offset=2&limit=2');
    expect(rest.body.entries.map((e) => [e.rank, e.nickname, e.rating])).toEqual([
      [3, 'Cy', 978],
      [4, 'Dee', 976],
    ]);
    const beyond = await anon.call<LeaderboardResponse>('/api/leaderboard?offset=40&limit=2');
    expect(beyond.body.entries).toEqual([]);
    expect((await anon.call('/api/leaderboard?limit=0')).status).toBe(400);
    expect((await anon.call('/api/leaderboard?limit=51')).status).toBe(400);
    expect((await anon.call('/api/leaderboard?offset=-1')).status).toBe(400);
    const found = await anon.call<SearchResponse>('/api/leaderboard/search?q=d');
    expect(found.body.entries.map((e) => [e.nickname, e.rank])).toEqual([['Dee', 4]]);
    // A public profile: no session, recovery or activity details.
    const ana = await anon.call<PlayerResponse>(`/api/players/${browsers[0].id}`);
    expect(ana.body.player).toMatchObject({ nickname: 'Ana', rank: 1, races: 2, wins: 2 });
    expect(ana.body.recent).toHaveLength(2);
    for (const hidden of ['lastActiveAt', 'hasRecoveryCode', 'nicknameChangesLeft']) {
      expect(ana.body.player).not.toHaveProperty(hidden);
    }
    expect(JSON.stringify(ana.body)).not.toMatch(/token|hash/i);
    expect((await anon.call('/api/players/nobody')).status).toBe(404);
    // Each browser's own view carries the private fields, and its own rank.
    const own = await browsers[3].b.call<MeResponse>('/api/me');
    expect(own.body.player).toMatchObject({ nickname: 'Dee', rank: 4, hasRecoveryCode: false });
    expect(svc.health().database).toBe('ok');
  });

  it('answers a malformed path with 404, and an unexpected failure with an error id only', async () => {
    const lines: string[] = [];
    const { url, svc } = await serve({
      log: createLogger({ format: 'json', write: (_level, line) => lines.push(line) }),
    });
    const b = new Browser(url);
    expect((await b.call('/api/players/%E0%A4%A')).status).toBe(404);
    vi.spyOn(svc, 'leaderboard').mockRejectedValueOnce(new TypeError('cannot read x of undefined'));
    const res = await b.call<ApiError & { errorId: string }>('/api/leaderboard');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Something went wrong on the server.');
    expect(res.body.errorId).toMatch(/^[0-9A-Z]{8}$/);
    expect(JSON.stringify(res.body)).not.toMatch(/TypeError|undefined|stack/);
    // The log line with the same id holds the details.
    const logged = lines.map(
      (l) => JSON.parse(l) as { errorId?: string; error?: { message: string } },
    );
    expect(logged.find((l) => l.errorId === res.body.errorId)?.error?.message).toMatch(
      /cannot read/,
    );
  });

  it('limits requests per address', async () => {
    const { url } = await serve({
      limits: { read: { burst: 2, perHour: 1 }, create: { burst: 1, perHour: 1 } },
    });
    const b = new Browser(url);
    expect((await b.call('/api/leaderboard')).status).toBe(200);
    expect((await b.call('/api/leaderboard')).status).toBe(200);
    const third = await b.call('/api/leaderboard');
    expect(third.status).toBe(429);
    expect(Number(third.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await new Browser(url).call('/api/identity', { json: {} })).status).toBe(201);
    expect((await new Browser(url).call('/api/identity', { json: {} })).status).toBe(429);
  });

  it('says when ranking is off, or when the database is away, without details', async () => {
    const off = await serve({}, false);
    const b = new Browser(off.url);
    expect((await b.call('/api/me')).body).toEqual({ ranking: false, player: null });
    expect(await b.call('/api/leaderboard')).toMatchObject({
      status: 503,
      body: { ranking: false, error: 'Global ranking is not set up on this server.' },
    });
    const down = await serve();
    down.db.break();
    const res = await new Browser(down.url).call('/api/leaderboard');
    expect(res).toMatchObject({
      status: 503,
      body: { ranking: true, error: 'Rankings are unavailable right now. Races still work.' },
    });
    expect(JSON.stringify(res.body)).not.toMatch(/ECONNREFUSED|5432|select/i);
  });

  it('answers a configured client origin with credentialed CORS and cross-site cookies', async () => {
    const client = 'https://client.example';
    const { url } = await serve({ corsOrigin: client });
    const pre = await fetch(`${url}/api/identity`, {
      method: 'OPTIONS',
      headers: { origin: client, 'access-control-request-method': 'POST' },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe(client);
    expect(pre.headers.get('access-control-allow-credentials')).toBe('true');
    const other = await fetch(`${url}/api/identity`, {
      method: 'OPTIONS',
      headers: { origin: 'https://elsewhere.example' },
    });
    expect(other.status).toBe(403);
    const b = new Browser(url);
    const made = await b.call('/api/identity', { json: {}, headers: { origin: client } });
    expect(made.status).toBe(201);
    expect(made.headers.get('access-control-allow-origin')).toBe(client);
    expect(b.lastSetCookie).toMatch(/SameSite=None; .*Secure$/);
  });
});
