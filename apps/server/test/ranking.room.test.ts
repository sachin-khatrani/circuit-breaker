import {
  EV,
  PROTOCOL_VERSION,
  type Ack,
  type RaceRating,
  type RaceResults,
  type RoomState,
  type SeatGrant,
} from '@circuit-breaker/shared';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';
import { io as connect, type Socket } from 'socket.io-client';
import { afterEach, describe, expect, it } from 'vitest';
import { createApi, SESSION_COOKIE } from '../src/api/http';
import { silentLogger } from '../src/log';
import { attachSocketServer } from '../src/net/socketServer';
import { RankingService } from '../src/ranking/service';
import { RankingStore } from '../src/ranking/store';
import type { CompletedRace, RaceRatingSink, SeatProfile } from '../src/ranking/types';
import type { Seat } from '../src/rooms/Room';
import { RoomManager } from '../src/rooms/RoomManager';
import { TEST_DATABASES, type TestDb } from './db';
import { FakePeer, runUntil, seatRef, setup, startRace, track } from './helpers';

const profile = (id: string, rating = 1000): SeatProfile => ({
  id,
  tag: id.slice(0, 4),
  rating,
  races: 0,
});

/** A ranking that records what rooms hand it, and lets the test answer later. */
class RecordingSink implements RaceRatingSink {
  readonly enabled = true;
  readonly races: CompletedRace[] = [];
  readonly notifiers: ((r: RaceRating) => void)[] = [];
  submit(race: CompletedRace, notify: (r: RaceRating) => void): RaceRating {
    this.races.push(race);
    this.notifiers.push(notify);
    return { raceId: race.raceId, status: 'pending', reason: null, entries: [], unrated: [] };
  }
}

/** A room of `profiles.length` seats (profile or none), one-lap races. */
function ratedRoom(sink: RaceRatingSink, profiles: (SeatProfile | null)[]) {
  const env = setup({ ranking: sink });
  const peers = profiles.map(() => new FakePeer());
  const host = seatRef(env.manager.create('Host', peers[0], undefined, profiles[0]));
  const refs = [host];
  for (let i = 1; i < profiles.length; i++) {
    refs.push(seatRef(env.manager.join(host.room.code, `P${i}`, peers[i], undefined, profiles[i])));
  }
  host.room.setLaps(host.seat, 1);
  return { ...env, room: host.room, refs, peers, seats: refs.map((r) => r.seat) };
}

function finish(env: ReturnType<typeof ratedRoom>, drivers: Seat[]): RaceResults {
  runUntil(env.clock, env.manager, env.room, drivers, () => env.room.publicPhase === 'results');
  const results = env.room.currentRace?.results;
  if (!results) throw new Error('the race did not finish');
  return results;
}

async function until(test: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!test()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('rooms and the global rating', () => {
  it('shows profiles in the lobby and hands each finished race over once, as it started', () => {
    const sink = new RecordingSink();
    const env = ratedRoom(sink, [
      profile('AAAA1111AAAA1111'),
      profile('BBBB2222BBBB2222', 1100),
      null,
    ]);
    const state = env.peers[0].last<RoomState>(EV.room)!;
    expect(state.ranking).toBe(true);
    expect(state.players.map((p) => [p.profileId, p.tag, p.rating])).toEqual([
      ['AAAA1111AAAA1111', 'AAAA', 1000],
      ['BBBB2222BBBB2222', 'BBBB', 1100],
      [null, null, null],
    ]);
    startRace(env.room, env.seats);
    // The second player leaves mid-race: their car is still rated, as a DNF that left.
    runUntil(env.clock, env.manager, env.room, env.seats, () => false, 5);
    env.manager.leave(env.refs[1]);
    const results = finish(env, [env.seats[0], env.seats[2]]);
    expect(sink.races).toHaveLength(1);
    const race = sink.races[0];
    expect(race.uid).toMatch(/^[0-9a-f-]{36}$/);
    expect(race.raceId).toBe(results.raceId);
    expect(race.entries.map((e) => [e.seatId, e.profileId, e.position, e.dnfReason])).toEqual(
      results.entries.map((e) => [
        e.id,
        e.id === env.seats[0].id
          ? 'AAAA1111AAAA1111'
          : e.id === env.seats[1].id
            ? 'BBBB2222BBBB2222'
            : null,
        e.position,
        e.dnfReason,
      ]),
    );
    expect(race.entries.find((e) => e.seatId === env.seats[1].id)?.dnfReason).toBe('left');
    // Everyone is told the rating is on its way, and a late joiner hears it too.
    expect(env.peers[0].last<RaceRating>(EV.rating)).toMatchObject({ status: 'pending' });
    const late = new FakePeer();
    seatRef(env.manager.join(env.room.code, 'Late', late));
    expect(late.last<RaceResults>(EV.results)?.raceId).toBe(results.raceId);
    expect(late.last<RaceRating>(EV.rating)).toMatchObject({ status: 'pending' });
    // The rating arrives: shown to the room, and the seat's rating in the lobby follows.
    sink.notifiers[0]({
      raceId: results.raceId,
      status: 'rated',
      reason: null,
      unrated: [],
      entries: [
        {
          id: env.seats[0].id,
          profileId: 'AAAA1111AAAA1111',
          before: 1000,
          delta: 20,
          after: 1020,
          rank: 1,
        },
      ],
    });
    expect(env.peers[0].last<RaceRating>(EV.rating)).toMatchObject({ status: 'rated' });
    expect(late.last<RaceRating>(EV.rating)).toMatchObject({ status: 'rated' });
    const after = env.peers[0].last<RoomState>(EV.room)!;
    expect(after.players.find((p) => p.profileId === 'AAAA1111AAAA1111')?.rating).toBe(1020);
    // Nothing more is handed over, however the results are asked for again.
    expect(sink.races).toHaveLength(1);
  });

  it('marks races unrated on a server without ranking', () => {
    const off = new RankingService(null);
    const env = ratedRoom(off, [null, null]);
    expect(env.peers[0].last<RoomState>(EV.room)!.ranking).toBe(false);
    startRace(env.room, env.seats);
    finish(env, env.seats);
    const rating = env.peers[1].last<RaceRating>(EV.rating);
    expect(rating?.status).toBe('unrated');
    expect(rating?.reason).toMatch(/off on this server/);
  });

  describe.each(TEST_DATABASES)('with the real service on $name', (database) => {
    const open: TestDb[] = [];
    const services: RankingService[] = [];
    afterEach(async () => {
      for (const s of services.splice(0)) await s.close(100);
      for (const t of open.splice(0)) await t.drop();
    });

    it('rates three races in a row: pending, then saved, with ranks and new seat ratings', async () => {
      const t = await database.open();
      open.push(t);
      const svc = new RankingService(new RankingStore(t.db), { log: () => {} });
      services.push(svc);
      await svc.start();
      const ids = await Promise.all(['Ana', 'Ben', 'Cy'].map((n) => svc.createIdentity(null, n)));
      const seats = await Promise.all(ids.map((i) => svc.issueTicket(i.token, i.player.nickname)));
      const env = ratedRoom(
        svc,
        seats.map((s) => svc.redeemTicket(s.ticket)),
      );
      const ratings: RaceRating[][] = [];
      for (let n = 1; n <= 3; n++) {
        if (n === 1) startRace(env.room, env.seats);
        else {
          for (const seat of env.seats.slice(1)) env.room.setReady(seat, true, env.room.raceId);
          const error = env.room.restart(env.seats[0], env.room.raceId);
          if (error) throw new Error(error);
        }
        const results = finish(env, env.seats);
        await until(
          () =>
            env.peers[2].last<RaceRating>(EV.rating)?.status === 'rated' &&
            env.peers[2].last<RaceRating>(EV.rating)?.raceId === results.raceId,
        );
        ratings.push(
          env.peers[2].all<RaceRating>(EV.rating).filter((r) => r.raceId === results.raceId),
        );
        const rated = ratings.at(-1)!.at(-1)!;
        expect(rated.entries.map((e) => e.id).sort()).toEqual(env.seats.map((s) => s.id).sort());
        expect(rated.entries.every((e) => e.rank !== null && e.after === e.before + e.delta)).toBe(
          true,
        );
        // The lobby shows the new ratings.
        const state = env.peers[0].last<RoomState>(EV.room)!;
        for (const e of rated.entries) {
          expect(state.players.find((p) => p.id === e.id)?.rating).toBe(e.after);
        }
      }
      // Each race: pending first, then rated, nothing else.
      expect(ratings.map((rs) => rs.map((r) => r.status))).toEqual([
        ['pending', 'rated'],
        ['pending', 'rated'],
        ['pending', 'rated'],
      ]);
      // Three rated races per profile; the chain of ratings is unbroken.
      for (const id of ids) {
        const me = (await svc.me(id.token))!;
        expect(me.races).toBe(3);
        const { recent } = await svc.player(id.player.id);
        expect(recent).toHaveLength(3);
        const chain = [...recent].reverse();
        for (let i = 1; i < chain.length; i++)
          expect(chain[i].ratingBefore).toBe(chain[i - 1].ratingAfter);
        expect(chain.at(-1)!.ratingAfter).toBe(me.rating);
      }
    });
  });
});

describe('seat tickets over the wire', () => {
  let http: HttpServer;
  let manager: RoomManager;
  let svc: RankingService;
  let base = '';
  const sockets: Socket[] = [];
  let db: TestDb;

  afterEach(async () => {
    for (const s of sockets.splice(0)) s.disconnect();
    manager?.stop();
    await new Promise<void>((r) => (http ? http.close(() => r()) : r()));
    await svc?.close(100);
    await db?.drop();
  });

  async function start() {
    db = await TEST_DATABASES[0].open();
    svc = new RankingService(new RankingStore(db.db), { log: () => {} });
    await svc.start();
    manager = new RoomManager(track, () => performance.now(), { ranking: svc });
    const api = createApi(svc, { log: silentLogger });
    http = createServer((req, res) => {
      if (!api(req, res)) res.writeHead(404).end();
    });
    attachSocketServer(http, manager, () => performance.now(), {
      redeemTicket: (t) => svc.redeemTicket(t),
    });
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  }

  async function profileWithTicket(name: string) {
    const made = await fetch(`${base}/api/identity`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nickname: name }),
    });
    const cookie = /^(cb_player=[^;]+)/.exec(made.headers.get('set-cookie') ?? '')![1];
    expect(cookie.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
    const id = ((await made.json()) as { player: { id: string } }).player.id;
    const ticketRes = await fetch(`${base}/api/me/ticket`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ nickname: name }),
    });
    const { ticket } = (await ticketRes.json()) as { ticket: string };
    return { id, ticket };
  }

  async function socket(): Promise<Socket> {
    const s = connect(base, { transports: ['websocket'], forceNew: true, reconnection: false });
    sockets.push(s);
    await new Promise<void>((resolve, reject) => {
      s.once('connect', () => resolve());
      s.once('connect_error', reject);
    });
    return s;
  }

  const ask = (s: Socket, event: string, payload: unknown) =>
    s.timeout(3000).emitWithAck(event, payload) as Promise<Ack<SeatGrant>>;

  it('binds a seat to the profile its ticket was issued for, once, and to nothing else', async () => {
    await start();
    const ana = await profileWithTicket('Ana');
    const ben = await profileWithTicket('Ben');
    const host = await ask(await socket(), EV.create, {
      name: 'Ana',
      version: PROTOCOL_VERSION,
      ticket: ana.ticket,
    });
    if (!host.ok) throw new Error(host.error);
    const code = host.data.room.code;
    expect(host.data.room.players[0]).toMatchObject({ profileId: ana.id, rating: 1000 });
    // The same ticket again: a seat, but no profile.
    const reused = await ask(await socket(), EV.join, {
      code,
      name: 'Copy',
      version: PROTOCOL_VERSION,
      ticket: ana.ticket,
    });
    if (!reused.ok) throw new Error(reused.error);
    // A client naming a profile itself is ignored.
    const forged = await ask(await socket(), EV.join, {
      code,
      name: 'Forger',
      version: PROTOCOL_VERSION,
      profileId: ben.id,
      ticket: 'made-up',
    });
    if (!forged.ok) throw new Error(forged.error);
    const real = await ask(await socket(), EV.join, {
      code,
      name: 'Ben',
      version: PROTOCOL_VERSION,
      ticket: ben.ticket,
    });
    if (!real.ok) throw new Error(real.error);
    const players = real.data.room.players;
    expect(players.map((p) => [p.name, p.profileId])).toEqual([
      ['Ana', ana.id],
      ['Copy', null],
      ['Forger', null],
      ['Ben', ben.id],
    ]);
    expect(real.data.room.ranking).toBe(true);
    // Room state never carries a ticket or a cookie.
    expect(JSON.stringify(real.data.room)).not.toContain(ana.ticket);
  });
});
