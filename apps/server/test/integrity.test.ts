import {
  createInput,
  encodeInputPacket,
  EV,
  packInputFrame,
  placeVehicle,
  TICK_RATE,
  type EventsMessage,
  type RaceRating,
  type RaceResults,
  type RaceStartInfo,
  type RoomState,
  type SnapshotMessage,
} from '@circuit-breaker/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { silentLogger } from '../src/log';
import { Metrics } from '../src/metrics';
import { RankingService } from '../src/ranking/service';
import { RankingStore } from '../src/ranking/store';
import type { CompletedRace, RaceRatingSink, SeatProfile } from '../src/ranking/types';
import type { Room, Seat } from '../src/rooms/Room';
import { RoomManager } from '../src/rooms/RoomManager';
import { FlakyDb, TEST_DATABASES, type TestDb } from './db';
import {
  FakePeer,
  ManualClock,
  roomWith,
  runUntil,
  seatRef,
  sendBotInputs,
  setup,
  startRace,
  TICK_MS,
  track,
} from './helpers';

const profile = (id: string): SeatProfile => ({ id, tag: id.slice(0, 4), rating: 1000, races: 0 });

class RecordingSink implements RaceRatingSink {
  readonly enabled = true;
  readonly races: CompletedRace[] = [];
  submit(race: CompletedRace): RaceRating {
    this.races.push(race);
    return { raceId: race.raceId, status: 'pending', reason: null, entries: [], unrated: [] };
  }
}

/** Puts a seat's car just before the finish line of its last lap, moving at `speed`. */
function onFinalApproach(room: Room, seat: Seat, metresBefore: number, speed: number): void {
  const sim = room.currentRace!.sim;
  const r = sim.getRacer(seat.id)!;
  r.started = true;
  r.lap = sim.laps - 1;
  r.nextCheckpoint = 0;
  placeVehicle(r.vehicle, track, track.length - metresBefore, 0);
  r.vehicle.vx = Math.sin(r.vehicle.yaw) * speed;
  r.vehicle.vz = Math.cos(r.vehicle.yaw) * speed;
  r.prevX = r.vehicle.x;
  r.prevZ = r.vehicle.z;
}

describe('rooms side by side (2, 4 and 8 players)', () => {
  it('keeps whole races apart: players, cars, Energy, track changes, results and points', () => {
    const { clock, manager } = setup();
    const rooms = [2, 4, 8].map((n) => roomWith(manager, n));
    for (const r of rooms) {
      r.room.setLaps(r.seats[0], 1);
      startRace(r.room, r.seats);
    }
    // Run all three at once; in the 4-player room someone opens the shortcut mid-race.
    let opened = false;
    for (
      let i = 0;
      i < 600 * TICK_RATE && rooms.some((r) => r.room.publicPhase !== 'results');
      i++
    ) {
      for (const r of rooms) sendBotInputs(r.room, r.seats);
      const four = rooms[1].room.currentRace!;
      if (!opened && four.sim.phase === 'racing' && four.sim.tick > four.sim.goTick + 120) {
        four.sim.getRacer(rooms[1].seats[0].id)!.vehicle.energy = 100;
        const press = packInputFrame({ ...createInput(), throttle: 1, shortcut: true });
        rooms[1].room.receiveInput(
          rooms[1].seats[0],
          encodeInputPacket(four.info.raceId, four.sim.tick + 4, [press]),
        );
        opened = true;
      }
      clock.advance(TICK_MS);
      manager.update();
      // The shortcut opened in one room only.
      if (four.sim.course.shortcutOpenTick >= 0) {
        expect(rooms[0].room.currentRace!.sim.course.shortcutOpenTick).toBe(-1);
        expect(rooms[2].room.currentRace!.sim.course.shortcutOpenTick).toBe(-1);
      }
    }
    expect(opened).toBe(true);
    for (const [index, r] of rooms.entries()) {
      const ids = new Set(r.seats.map((s) => s.id));
      const results = r.room.currentRace!.results!;
      expect(results.entries).toHaveLength(r.seats.length);
      expect(results.entries.every((e) => e.finished && ids.has(e.id))).toBe(true);
      expect(results.abilities.every((a) => ids.has(a.racerId))).toBe(true);
      expect(results.abilities.length > 0).toBe(index === 1);
      for (const peer of r.peers) {
        for (const m of peer.messages) {
          const json = JSON.stringify(m.payload);
          // No other room's player id ever reaches this room.
          for (const other of rooms) {
            if (other === r) continue;
            for (const seat of other.seats) expect(json).not.toContain(seat.id);
          }
          if (m.event === EV.snapshot) {
            expect((m.payload as SnapshotMessage).r).toHaveLength(r.seats.length);
          }
          if (m.event === EV.room) expect((m.payload as RoomState).code).toBe(r.room.code);
        }
        const start = peer.last<RaceStartInfo>(EV.raceStart)!;
        expect(start.racers.map((x) => x.id).sort()).toEqual([...ids].sort());
      }
      // Points went to this room's session only.
      expect(r.seats.reduce((sum, s) => sum + s.points, 0)).toBeGreaterThan(0);
      expect(r.room.sessionRaces).toBe(1);
    }
  });

  it('closes only the room whose update fails, with an error id; the others race on', () => {
    const metrics = new Metrics();
    const clock = new ManualClock();
    const manager = new RoomManager(track, clock.now, { log: silentLogger, metrics });
    const broken = roomWith(manager, 2);
    const fine = roomWith(manager, 2);
    startRace(broken.room, broken.seats);
    startRace(fine.room, fine.seats);
    broken.room.update = () => {
      throw new Error('simulated failure');
    };
    const before = fine.room.currentRace!.sim.tick;
    // A race starts 0.6 s after Start: run a second and a half.
    for (let i = 0; i < 90; i++) {
      clock.advance(TICK_MS);
      manager.update();
    }
    expect(manager.rooms.has(broken.room.code)).toBe(false);
    expect(metrics.roomErrors).toBe(1);
    for (const peer of broken.peers)
      expect(peer.closed).toMatch(/server error .*error [0-9A-Z]{8}/);
    expect(manager.sessionCount).toBe(2);
    expect(fine.room.currentRace!.sim.tick).toBeGreaterThan(before + 25);
    expect(fine.peers.every((p) => p.closed === null)).toBe(true);
  });
});

describe('one seat per profile', () => {
  it('races a second seat unrated while the profile is seated and connected elsewhere', () => {
    const { manager } = setup({ ranking: new RecordingSink() });
    const p = profile('PROF1111PROF1111');
    const a = seatRef(manager.create('Tab one', new FakePeer(), undefined, p));
    const b = seatRef(manager.create('Tab two', new FakePeer(), undefined, p));
    const sameRoom = seatRef(manager.join(a.room.code, 'Tab three', new FakePeer(), undefined, p));
    expect(a.seat.profile?.id).toBe(p.id);
    expect(b.seat.profile).toBeNull();
    expect(sameRoom.seat.profile).toBeNull();
    expect(manager.profileCount).toBe(1);
    // Its lobby says so: no profile on the second seat.
    expect(b.room.state().players[0].profileId).toBeNull();
  });

  it('gives up a seat the profile left behind (dropped) for the new one, in any room', () => {
    const { manager } = setup({ ranking: new RecordingSink() });
    const p = profile('PROF2222PROF2222');
    const oldPeer = new FakePeer();
    const old = seatRef(manager.create('Old', oldPeer, undefined, p));
    seatRef(manager.join(old.room.code, 'Friend', new FakePeer()));
    manager.drop(old, oldPeer);
    const fresh = seatRef(manager.create('New', new FakePeer(), undefined, p));
    expect(fresh.seat.profile?.id).toBe(p.id);
    expect(old.room.seats.map((s) => s.name)).toEqual(['Friend']);
    expect(manager.profileCount).toBe(1);

    // Back into the same room by code while the old seat waits: the room is never left empty.
    const solo = profile('SOLO3333SOLO3333');
    const firstPeer = new FakePeer();
    const first = seatRef(manager.create('Solo', firstPeer, undefined, solo));
    manager.drop(first, firstPeer);
    const again = seatRef(manager.join(first.room.code, 'Solo', new FakePeer(), undefined, solo));
    expect(manager.rooms.has(first.room.code)).toBe(true);
    expect(again.room.seats).toEqual([again.seat]);
    expect(again.seat.profile?.id).toBe(solo.id);
  });
});

describe('race records and the end of a race', () => {
  it('keeps at most 20 refused ability presses per car, and every press that worked', () => {
    const { clock, manager } = setup();
    const { room, seats, peers } = roomWith(manager, 2);
    room.setLaps(seats[0], 1);
    startRace(room, seats);
    const race = room.currentRace!;
    const spammer = seats[1];
    // Two minutes of a button tapped on cooldown (on, off, on, off …), inside the rate limit.
    for (let i = 0; i < 120 * TICK_RATE && !race.results; i++) {
      sendBotInputs(room, [seats[0]]);
      if (i % 2 === 0) {
        room.receiveInput(
          spammer,
          encodeInputPacket(race.info.raceId, race.sim.tick + 1, [
            [0, 0, 0, 16],
            [0, 0, 0, 0],
          ]),
        );
      }
      clock.advance(TICK_MS);
      manager.update();
    }
    runUntil(clock, manager, room, [seats[0]], () => race.results !== null);
    const results = peers[0].last<RaceResults>(EV.results)!;
    const mine = results.abilities.filter((a) => a.racerId === spammer.id);
    expect(mine.filter((a) => a.ok)).toHaveLength(race.sim.getRacer(spammer.id)!.stats.gateShifts);
    expect(mine.filter((a) => !a.ok)).toHaveLength(20);
    expect(JSON.stringify(results).length).toBeLessThan(20_000);
    // The presser is still told about each refusal, privately.
    const told = peers[1]
      .all<EventsMessage>(EV.events)
      .flatMap((m) => m.e)
      .filter((e) => e.type === 'abilityDenied');
    expect(told.length).toBeGreaterThan(100);
  });

  it('gives a race its results and one rating when its last players leave', () => {
    const sink = new RecordingSink();
    const { clock, manager } = setup({ ranking: sink });
    const winner = seatRef(
      manager.create('Winner', new FakePeer(), undefined, profile('WINS1111WINS1111')),
    );
    const loser = seatRef(
      manager.join(
        winner.room.code,
        'Loser',
        new FakePeer(),
        undefined,
        profile('LOSE2222LOSE2222'),
      ),
    );
    const room = winner.room;
    room.setLaps(winner.seat, 1);
    startRace(room, [winner.seat, loser.seat]);
    runUntil(clock, manager, room, [], () => room.publicPhase === 'racing');
    onFinalApproach(room, winner.seat, 3, 40);
    runUntil(
      clock,
      manager,
      room,
      [],
      () => room.currentRace!.sim.getRacer(winner.seat.id)!.finished,
    );
    // Both leave during the finish grace: the room closes, the race still counts.
    manager.leave(loser);
    manager.leave(winner);
    expect(manager.rooms.size).toBe(0);
    expect(sink.races).toHaveLength(1);
    expect(
      sink.races[0].entries.map((e) => [e.profileId, e.position, e.finished, e.dnfReason]),
    ).toEqual([
      ['WINS1111WINS1111', 1, true, null],
      ['LOSE2222LOSE2222', 2, false, 'left'],
    ]);
  });

  it('runs on when everyone disconnects, ends by the rules, and rates the race once', () => {
    const sink = new RecordingSink();
    const { clock, manager } = setup({ ranking: sink, graceMs: 60_000 });
    const peers = [new FakePeer(), new FakePeer()];
    const a = seatRef(manager.create('A', peers[0], undefined, profile('AAAA4444AAAA4444')));
    const b = seatRef(
      manager.join(a.room.code, 'B', peers[1], undefined, profile('BBBB5555BBBB5555')),
    );
    const room = a.room;
    room.setLaps(a.seat, 1);
    startRace(room, [a.seat, b.seat]);
    runUntil(clock, manager, room, [], () => room.publicPhase === 'racing');
    onFinalApproach(room, a.seat, 3, 40);
    manager.drop(a, peers[0]);
    manager.drop(b, peers[1]);
    // Nobody connected: A coasts over the line, B never comes back; the finish grace ends it.
    runUntil(clock, manager, room, [], () => room.publicPhase === 'results', 60);
    expect(sink.races).toHaveLength(1);
    expect(sink.races[0].entries.map((e) => [e.position, e.finished, e.dnfReason])).toEqual([
      [1, true, null],
      [2, false, 'racing'],
    ]);
    // Then the seats expire and the room goes; nothing is rated again.
    clock.advance(61_000);
    manager.update();
    expect(manager.rooms.size).toBe(0);
    expect(manager.sessionCount).toBe(0);
    expect(manager.profileCount).toBe(0);
    expect(sink.races).toHaveLength(1);
  });

  it('lets a car whose player dropped just before the line coast over it and finish', () => {
    const { clock, manager } = setup();
    const { room, seats, refs, peers } = roomWith(manager, 2);
    room.setLaps(seats[0], 1);
    startRace(room, seats);
    runUntil(clock, manager, room, seats, () => room.publicPhase === 'racing');
    onFinalApproach(room, seats[1], 25, 35);
    manager.drop(refs[1], peers[1]);
    runUntil(
      clock,
      manager,
      room,
      [seats[0]],
      () => room.currentRace!.sim.getRacer(seats[1].id)!.finished,
      5,
    );
    const racer = room.currentRace!.sim.getRacer(seats[1].id)!;
    expect(racer.finished).toBe(true);
    expect(racer.position).toBe(1);
  });

  it('ignores an ability press sent for the previous race after a restart', () => {
    const { clock, manager } = setup();
    const { room, seats } = roomWith(manager, 2);
    room.setLaps(seats[0], 1);
    startRace(room, seats);
    runUntil(clock, manager, room, seats, () => room.publicPhase === 'results');
    const oldRace = room.raceId;
    room.setReady(seats[1], true, oldRace);
    expect(room.restart(seats[0], oldRace)).toBeNull();
    runUntil(clock, manager, room, seats, () => room.publicPhase === 'racing');
    const race = room.currentRace!;
    race.sim.getRacer(seats[1].id)!.vehicle.energy = 100;
    // A press that was in flight for the old race arrives now: it is dropped as stale.
    const stale = seats[1].stale;
    const press = packInputFrame({ ...createInput(), overdrive: true });
    room.receiveInput(seats[1], encodeInputPacket(oldRace, race.sim.tick + 2, [press, press]));
    runUntil(clock, manager, room, seats, () => false, 1);
    expect(seats[1].stale).toBe(stale + 1);
    expect(race.sim.getRacer(seats[1].id)!.stats.overdrives).toBe(0);
    // And lobby requests made for the old race are refused.
    expect(room.setReady(seats[1], false, oldRace)).toMatch(/earlier race/);
  });

  it('never rates a race again when a player comes back after the results', () => {
    const sink = new RecordingSink();
    const { clock, manager } = setup({ ranking: sink });
    const peers = [new FakePeer(), new FakePeer()];
    const a = seatRef(manager.create('A', peers[0], undefined, profile('CCCC6666CCCC6666')));
    const b = seatRef(
      manager.join(a.room.code, 'B', peers[1], undefined, profile('DDDD7777DDDD7777')),
    );
    a.room.setLaps(a.seat, 1);
    startRace(a.room, [a.seat, b.seat]);
    runUntil(clock, manager, a.room, [a.seat, b.seat], () => a.room.publicPhase === 'results');
    expect(sink.races).toHaveLength(1);
    manager.drop(b, peers[1]);
    for (let i = 0; i < 3; i++) {
      const back = new FakePeer();
      const resumed = manager.resume(b.seat.token, back);
      expect(typeof resumed).not.toBe('string');
      expect(back.last<RaceResults>(EV.results)?.raceId).toBe(a.room.raceId);
      expect(back.last<RaceRating>(EV.rating)?.status).toBe('pending');
      runUntil(clock, manager, a.room, [], () => false, 1);
    }
    expect(sink.races).toHaveLength(1);
  });
});

describe.each(TEST_DATABASES)('the database failing at the finish ($name)', (database) => {
  const open: TestDb[] = [];
  const services: RankingService[] = [];
  afterEach(async () => {
    for (const s of services.splice(0)) await s.close(100);
    for (const t of open.splice(0)) await t.drop();
  });

  it('holds the rating, retries, and saves it once when the database is back', async () => {
    const t = await database.open();
    open.push(t);
    const flaky = new FlakyDb(t.db);
    const svc = new RankingService(new RankingStore(flaky), {
      log: () => {},
      retryDelaysMs: [20],
    });
    services.push(svc);
    await svc.start();
    const made = await Promise.all(['Ana', 'Ben'].map((n) => svc.createIdentity(null, n)));
    const tickets = await Promise.all(made.map((m) => svc.issueTicket(m.token, m.player.nickname)));
    const { clock, manager } = setup({ ranking: svc });
    const peers = [new FakePeer(), new FakePeer()];
    const host = seatRef(
      manager.create('Ana', peers[0], undefined, svc.redeemTicket(tickets[0].ticket)),
    );
    const guest = seatRef(
      manager.join(host.room.code, 'Ben', peers[1], undefined, svc.redeemTicket(tickets[1].ticket)),
    );
    host.room.setLaps(host.seat, 1);
    startRace(host.room, [host.seat, guest.seat]);
    runUntil(clock, manager, host.room, [host.seat, guest.seat], () => {
      // The database goes away just before the last car finishes.
      if (host.room.publicPhase === 'finished') flaky.break();
      return host.room.publicPhase === 'results';
    });
    const statuses = () => peers[1].all<RaceRating>(EV.rating).map((r) => r.status);
    await new Promise((r) => setTimeout(r, 200));
    expect(statuses()).toEqual(['pending', 'retrying']);
    // Nothing was written while it was away.
    flaky.heal();
    const done = Date.now() + 8000;
    while (!statuses().includes('rated') && Date.now() < done) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(statuses()).toEqual(['pending', 'retrying', 'rated']);
    const rows = await t.db.query<{ n: number }>('SELECT count(*)::int AS n FROM rated_races');
    expect(rows.rows[0].n).toBe(1);
    const me = await svc.me(made[0].token);
    expect(me?.races).toBe(1);
  });
});
