import {
  createCourseState,
  encodeInputPacket,
  EV,
  POINTS_TABLE,
  RACE_RULES,
  type EventsMessage,
  type RaceResults,
  type RaceStartInfo,
  type RoomState,
  type SnapshotMessage,
} from '@circuit-breaker/shared';
import { describe, expect, it } from 'vitest';
import type { Room, Seat } from '../src/rooms/Room';
import {
  FakePeer,
  roomWith,
  runUntil,
  seatRef,
  setup,
  startRace,
  type ManualClock,
} from './helpers';
import type { RoomManager } from '../src/rooms/RoomManager';

type Env = { clock: ManualClock; manager: RoomManager; room: Room };

/** Drives `drivers` until the room shows the race's results. */
function finish(env: Env, drivers: Seat[]): RaceResults {
  runUntil(env.clock, env.manager, env.room, drivers, () => env.room.publicPhase === 'results');
  const results = env.room.currentRace?.results;
  if (!results) throw new Error('the race did not finish');
  return results;
}

/** Everyone in `others` says ready on the results screen, then the host starts the next race. */
function raceAgain(room: Room, host: Seat, others: Seat[]): void {
  for (const seat of others) expect(room.setReady(seat, true, room.raceId)).toBeNull();
  const error = room.restart(host, room.raceId);
  if (error) throw new Error(error);
}

/** A room of `players` with one-lap races. */
function lapRoom(players: number, graceMs?: number) {
  const env = setup(graceMs === undefined ? {} : { graceMs });
  const ctx = roomWith(env.manager, players);
  ctx.room.setLaps(ctx.seats[0], 1);
  return { ...env, ...ctx };
}

const lastState = (peer: FakePeer) => peer.last<RoomState>(EV.room)!;

describe('vehicle selection', () => {
  it('gives each player the car they ask for when its colour is free, else the first free colour', () => {
    const { manager } = setup();
    const a = seatRef(manager.create('Ana', new FakePeer(), { color: 3, style: 1 }));
    const b = seatRef(manager.join(a.room.code, 'Ben', new FakePeer(), { color: 3, style: 2 }));
    const c = seatRef(manager.join(a.room.code, 'Cy', new FakePeer(), { color: 99, style: 0 }));
    expect([a.seat.color, a.seat.style]).toEqual([3, 1]);
    // Ana has colour 3: Ben gets the first free colour, but keeps the style he asked for.
    expect([b.seat.color, b.seat.style]).toEqual([0, 2]);
    // Not a real choice: ignored (first free colour, default style).
    expect([c.seat.color, c.seat.style]).toEqual([1, 0]);
  });

  it('lets each player change only their own car, with unique colours, between races only', () => {
    const env = lapRoom(3);
    const { room, seats, peers } = env;
    expect(room.setVehicle(seats[1], seats[0].color, 1)).toMatch(/Another player has that colour/);
    expect(room.setVehicle(seats[1], 5, 9)).toMatch(/not available/);
    expect(room.setVehicle(seats[1], -1, 0)).toMatch(/not available/);
    expect(room.setVehicle(seats[1], 5, 2)).toBeNull();
    // Everyone sees the new car; nobody else's car changed.
    for (const peer of peers) {
      const players = lastState(peer).players;
      expect(players[1]).toMatchObject({ color: 5, style: 2 });
      expect(players[0]).toMatchObject({ color: seats[0].color, style: 0 });
    }
    startRace(room, seats);
    expect(room.setVehicle(seats[2], 6, 1)).toMatch(/between races/);
    // The cars chosen in the lobby are the cars in the race, the same for every player.
    const starts = peers.map((p) => p.last<RaceStartInfo>(EV.raceStart)!);
    expect(starts[1]).toEqual(starts[0]);
    expect(starts[0].racers.find((r) => r.id === seats[1].id)).toMatchObject({
      color: 5,
      style: 2,
    });
    finish(env, seats);
    // On the results screen the car can change again for the next race.
    expect(room.setVehicle(seats[2], 6, 1)).toBeNull();
  });
});

describe('ready check and starting a race', () => {
  it('ignores a repeated ready request and refuses one made for an earlier race', () => {
    const { manager } = setup();
    const { room, seats, peers } = roomWith(manager, 2);
    peers[0].clear();
    expect(room.setReady(seats[1], true, room.raceId)).toBeNull();
    expect(room.setReady(seats[1], true, room.raceId)).toBeNull();
    expect(peers[0].all(EV.room)).toHaveLength(1);
    expect(room.setReady(seats[1], false, room.raceId + 1)).toMatch(/earlier race/);
    expect(seats[1].ready).toBe(true);
  });

  it('starts one race: a second, stale or non-host start is refused', () => {
    const { manager } = setup();
    const { room, seats, peers } = roomWith(manager, 2);
    room.setReady(seats[1], true, 0);
    expect(room.start(seats[1], 0)).toMatch(/Only the host/);
    expect(room.start(seats[0], 0)).toBeNull();
    expect(room.start(seats[0], 0)).toMatch(/earlier race/);
    expect(room.start(seats[0], 1)).toMatch(/already running/);
    expect(room.restart(seats[0], 1)).toMatch(/already running/);
    expect(peers[1].all(EV.raceStart)).toHaveLength(1);
  });

  it('leaves a ready player who disconnected off the grid', () => {
    const { manager } = setup();
    const { room, seats, peers } = roomWith(manager, 3);
    room.setReady(seats[1], true);
    room.detach(seats[1], peers[1]);
    // The host and a disconnected player are not enough.
    expect(room.start(seats[0])).toMatch(/At least 2 connected players/);
    room.setReady(seats[2], true);
    expect(room.start(seats[0])).toBeNull();
    const info = peers[0].last<RaceStartInfo>(EV.raceStart)!;
    expect(info.racers.map((r) => r.id)).toEqual([seats[0].id, seats[2].id]);
  });
});

describe('results, statistics and points', () => {
  it('classifies, counts and scores every car the server’s way', () => {
    const env = lapRoom(3);
    const { room, seats, peers } = env;
    startRace(room, seats);
    const results = finish(env, seats);
    const sim = room.currentRace!.sim;
    expect(results.entries.map((e) => e.position)).toEqual([1, 2, 3]);
    expect(results.raceNumber).toBe(1);
    for (const entry of results.entries) {
      const racer = sim.getRacer(entry.id)!;
      expect(entry.finished).toBe(true);
      expect(entry.points).toBe(POINTS_TABLE[entry.position - 1]);
      expect(entry.sessionPoints).toBe(entry.points);
      expect(entry.sessionRank).toBe(entry.position);
      // The numbers are the simulation's own counters.
      expect(entry.stats.boosts).toBe(racer.stats.boosts);
      expect(entry.stats.energy).toBe(
        Math.round(racer.stats.cellEnergy + racer.stats.driftEnergy + racer.stats.laneEnergy),
      );
      expect(entry.stats.topSpeed).toBeGreaterThan(50);
    }
    expect(results.winnerId).toBe(results.entries[0].id);
    // Finish times in order; every player got the same results.
    const times = results.entries.map((e) => e.totalTime!);
    expect([...times].sort((x, y) => x - y)).toEqual(times);
    for (const peer of peers) expect(peer.last<RaceResults>(EV.results)).toEqual(results);
    // The room's standings carry the points too.
    const winner = lastState(peers[0]).players.find((p) => p.id === results.winnerId)!;
    expect(winner).toMatchObject({ points: 100, races: 1, wins: 1, rank: 1 });
  });

  it('scores a player who left as DNF with no points, after everyone still racing', () => {
    const env = lapRoom(3);
    const { room, seats, refs } = env;
    startRace(room, seats);
    runUntil(env.clock, env.manager, room, seats, () => false, 12);
    env.manager.leave(refs[1]);
    const results = finish(env, [seats[0], seats[2]]);
    const gone = results.entries.find((e) => e.id === seats[1].id)!;
    expect(gone).toMatchObject({ finished: false, dnf: true, dnfReason: 'left', points: 0 });
    expect(gone.position).toBe(3);
    expect(gone.sessionRank).toBe(0);
    expect(results.entries.slice(0, 2).every((e) => e.finished)).toBe(true);
    expect(room.seats).toHaveLength(2);
  });

  it('scores a car still racing when the race is called as DNF, placed by distance', () => {
    const env = lapRoom(3);
    const { room, seats } = env;
    startRace(room, seats);
    // The third player never touches the throttle: the race ends after the finish grace.
    const results = finish(env, [seats[0], seats[1]]);
    const parked = results.entries.find((e) => e.id === seats[2].id)!;
    expect(parked).toMatchObject({ finished: false, dnfReason: 'racing', points: 0, position: 3 });
    expect(seats[2].races).toBe(1);
    expect(seats[2].points).toBe(0);
  });

  it('gives each car its fastest lap as its best, and none to a car that never completed one', () => {
    const env = lapRoom(3);
    const { room, seats } = env;
    room.setLaps(seats[0], 2);
    startRace(room, seats);
    const results = finish(env, [seats[0], seats[1]]);
    const finishers = results.entries.filter((e) => e.finished);
    expect(finishers).toHaveLength(2);
    for (const entry of finishers) {
      expect(entry.lapTimes).toHaveLength(2);
      expect(entry.bestLap).toBe(Math.min(...entry.lapTimes));
      // Laps run from GO to each crossing of the line, so they add up to the race time.
      expect(entry.lapTimes[0] + entry.lapTimes[1]).toBeCloseTo(entry.totalTime!, 9);
    }
    const parked = results.entries.find((e) => e.id === seats[2].id)!;
    expect(parked).toMatchObject({ totalTime: null, bestLap: null, lapTimes: [] });
  });

  it('adds a race’s points once, whatever arrives later', () => {
    const env = lapRoom(2);
    const { room, seats, peers, manager, clock } = env;
    startRace(room, seats);
    const results = finish(env, seats);
    const points = seats.map((s) => s.points);
    // More updates, a reconnect (which re-sends the results) and requests from both players.
    runUntil(clock, manager, room, seats, () => false, 5);
    const again = new FakePeer();
    manager.resume(seats[1].token, again);
    expect(again.last<RaceResults>(EV.results)).toEqual(results);
    room.setReady(seats[1], true, room.raceId);
    room.setReady(seats[1], false, room.raceId);
    expect(seats.map((s) => s.points)).toEqual(points);
    expect(room.sessionRaces).toBe(1);
    expect(peers[0].all(EV.results)).toHaveLength(1);
  });
});

describe('race again and the session', () => {
  it('needs a new ready check, resets the race, and keeps the players, cars and points', () => {
    const env = lapRoom(3);
    const { room, seats, peers } = env;
    room.setVehicle(seats[2], 7, 2);
    startRace(room, seats);
    finish(env, seats);
    const points = seats.map((s) => s.points);
    expect(room.restart(seats[0], room.raceId)).toMatch(/At least 2 connected players/);
    // Only one other player gets ready: the third watches the next race.
    room.setReady(seats[1], true, room.raceId);
    expect(room.restart(seats[0], room.raceId)).toBeNull();
    const race = room.currentRace!;
    expect(race.info.raceId).toBe(2);
    expect(race.info.racers.map((r) => r.id).sort()).toEqual([seats[0].id, seats[1].id].sort());
    // A fresh race: tick, laps, checkpoints, Energy, cooldowns, cells and the track all reset.
    expect(race.sim.tick).toBe(0);
    for (const r of race.sim.racers) {
      expect(r.lap).toBe(0);
      expect(r.nextCheckpoint).toBe(0);
      expect(r.vehicle.energy).toBe(RACE_RULES.startEnergy);
      expect(r.abilityCooldown.every((c) => c === 0)).toBe(true);
    }
    expect(race.sim.cells.every((c) => c.active)).toBe(true);
    expect(race.sim.course).toEqual(createCourseState());
    // Identities, cars and points carried over.
    expect(seats.map((s) => s.points)).toEqual(points);
    expect(seats[2]).toMatchObject({ color: 7, style: 2 });
    expect(lastState(peers[2]).players.find((p) => p.id === seats[2].id)!.racing).toBe(false);
  });

  it('runs three races in a row in one room, scoring each once', () => {
    const env = lapRoom(3);
    const { room, seats, peers } = env;
    const all: RaceResults[] = [];
    const grids: string[][] = [];
    for (let n = 1; n <= 3; n++) {
      if (n === 1) startRace(room, seats);
      else raceAgain(room, seats[0], seats.slice(1));
      grids.push(room.currentRace!.info.racers.map((r) => r.id));
      all.push(finish(env, seats));
      for (const peer of peers) expect(peer.last<RaceResults>(EV.results)).toEqual(all.at(-1));
    }
    expect(all.map((r) => [r.raceId, r.raceNumber])).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
    expect(room.sessionRaces).toBe(3);
    for (const seat of seats) {
      const earned = all.reduce(
        (sum, r) => sum + r.entries.find((e) => e.id === seat.id)!.points,
        0,
      );
      expect(seat.points).toBe(earned);
      expect(seat.races).toBe(3);
      expect(all[2].entries.find((e) => e.id === seat.id)!.sessionPoints).toBe(earned);
    }
    // The grid of races 2 and 3 is the reverse of the standings after the race before.
    for (const n of [1, 2]) {
      const before = all[n - 1].entries;
      const expected = [...before]
        .sort((a, b) => a.sessionPoints - b.sessionPoints)
        .map((e) => e.id);
      if (new Set(before.map((e) => e.sessionPoints)).size === before.length) {
        expect(grids[n]).toEqual(expected);
      }
    }
    expect(grids[0]).toEqual(seats.map((s) => s.id));
  });

  it('starts a new session only from the lobby, by the host, with everyone back to zero', () => {
    const env = lapRoom(2);
    const { room, seats, peers } = env;
    startRace(room, seats);
    finish(env, seats);
    expect(room.newSession(seats[0])).toMatch(/from the lobby/);
    expect(room.toLobby(seats[1], room.raceId)).toMatch(/Only the host/);
    expect(room.toLobby(seats[0], room.raceId)).toBeNull();
    expect(room.newSession(seats[1])).toMatch(/Only the host/);
    expect(room.newSession(seats[0])).toBeNull();
    const state = lastState(peers[1]);
    expect(state).toMatchObject({ sessionId: 2, sessionRaces: 0 });
    expect(state.players.every((p) => p.points === 0 && p.races === 0 && p.wins === 0)).toBe(true);
    startRace(room, seats);
    expect(finish(env, seats).raceNumber).toBe(1);
  });
});

describe('disconnects and reconnects around races', () => {
  it('passes the host role on when the host leaves after a race, and the room races on', () => {
    const env = lapRoom(3);
    const { room, seats, refs, manager } = env;
    startRace(room, seats);
    finish(env, seats);
    manager.leave(refs[0]);
    expect(room.hostId).toBe(seats[1].id);
    expect(room.state().players.some((p) => p.id === seats[0].id)).toBe(false);
    raceAgain(room, seats[1], [seats[2]]);
    expect(room.currentRace!.info.racers).toHaveLength(2);
    expect(finish(env, [seats[1], seats[2]]).raceNumber).toBe(2);
  });

  it('keeps a disconnected player’s points while the seat is held, and drops them with it', () => {
    const env = lapRoom(3, 5000);
    const { room, seats, peers, clock, manager } = env;
    startRace(room, seats);
    finish(env, seats);
    const points = seats[2].points;
    clock.advance(100);
    room.detach(seats[2], peers[2]);
    const away = lastState(peers[0]).players.find((p) => p.id === seats[2].id)!;
    expect(away).toMatchObject({ connected: false, points, graceUntil: clock.t + 5000 });
    clock.advance(5100);
    manager.update();
    const state = lastState(peers[0]);
    expect(state.players.map((p) => p.id)).toEqual([seats[0].id, seats[1].id]);
    expect(state.players.map((p) => p.rank).sort()).toEqual([1, 2]);
  });

  it('gives a player who reconnects between races the results and the session', () => {
    const env = lapRoom(2);
    const { room, seats, peers, manager } = env;
    startRace(room, seats);
    const results = finish(env, seats);
    room.detach(seats[1], peers[1]);
    const back = new FakePeer();
    manager.resume(seats[1].token, back);
    expect(back.last<RaceResults>(EV.results)).toEqual(results);
    const state = back.last<RoomState>(EV.room)!;
    expect(state.players.find((p) => p.id === seats[1].id)).toMatchObject({
      connected: true,
      points: seats[1].points,
      races: 1,
    });
    // And in the lobby: the state alone (no race to show).
    room.toLobby(seats[0], room.raceId);
    room.detach(seats[1], back);
    const later = new FakePeer();
    manager.resume(seats[1].token, later);
    expect(later.all(EV.results)).toHaveLength(0);
    expect(later.last<RoomState>(EV.room)!).toMatchObject({ phase: 'waiting', sessionRaces: 1 });
  });

  it('drops input sent for an earlier race, and names the race in every snapshot and event', () => {
    const env = lapRoom(2);
    const { room, seats, peers } = env;
    startRace(room, seats);
    finish(env, seats);
    raceAgain(room, seats[0], [seats[1]]);
    const sim = room.currentRace!.sim;
    room.receiveInput(seats[1], encodeInputPacket(1, sim.tick + 1, [[100, 0, 0, 0]]));
    expect(seats[1].stale).toBe(1);
    expect(seats[1].inputs.size).toBe(0);
    room.receiveInput(seats[1], encodeInputPacket(2, sim.tick + 1, [[100, 0, 0, 0]]));
    expect(seats[1].inputs.size).toBe(1);
    peers[0].clear();
    runUntil(env.clock, env.manager, room, seats, () => false, 8);
    const snaps = peers[0].all<SnapshotMessage>(EV.snapshot);
    const events = peers[0].all<EventsMessage>(EV.events);
    expect(snaps.length).toBeGreaterThan(10);
    expect(events.length).toBeGreaterThan(0);
    expect([...snaps, ...events].every((m) => m.id === 2)).toBe(true);
  });

  it('keeps two rooms’ sessions apart', () => {
    const { manager, clock } = setup();
    const one = roomWith(manager, 2);
    const two = roomWith(manager, 2);
    one.room.setLaps(one.seats[0], 1);
    startRace(one.room, one.seats);
    finish({ clock, manager, room: one.room }, one.seats);
    expect(one.room.sessionRaces).toBe(1);
    expect(two.room.sessionRaces).toBe(0);
    expect(two.seats.every((s) => s.points === 0)).toBe(true);
    expect(two.peers[0].all(EV.results)).toHaveLength(0);
    const ids = new Set(one.seats.map((s) => s.id));
    const leaked = two.peers
      .flatMap((p) => p.messages)
      .some((m) => {
        const text = JSON.stringify(m.payload);
        return [...ids].some((id) => text.includes(id));
      });
    expect(leaked).toBe(false);
  });
});
