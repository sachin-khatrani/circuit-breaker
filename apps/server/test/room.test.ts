import {
  createInput,
  decodeInputPacket,
  encodeInputPacket,
  EV,
  FLAG_OFFLINE,
  MAX_PLAYERS,
  packInputFrame,
  RACE_RULES,
  RACE_START_DELAY_MS,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  unpackPredictedState,
  createVehicle,
  type EventsMessage,
  type RaceResults,
  type RaceStartInfo,
  type RacerState,
  type RoomState,
  type SnapshotMessage,
} from '@circuit-breaker/shared';
import { describe, expect, it } from 'vitest';
import {
  FakePeer,
  roomWith,
  runUntil,
  seatRef,
  sendBotInputs,
  setup,
  startRace,
  TICK_MS,
} from './helpers';

describe('rooms: create, join, capacity', () => {
  it('creates a room with a secure-looking code, a private token and a public id', () => {
    const { manager } = setup();
    const peer = new FakePeer();
    const ref = seatRef(manager.create('Nova', peer));
    expect(ref.room.code).toHaveLength(ROOM_CODE_LENGTH);
    for (const ch of ref.room.code) expect(ROOM_CODE_ALPHABET).toContain(ch);
    expect(ref.seat.token.length).toBeGreaterThanOrEqual(32);
    expect(ref.seat.id).not.toBe(ref.seat.token);
    const state = peer.last<RoomState>(EV.room)!;
    expect(state.players).toEqual([
      expect.objectContaining({ name: 'Nova', host: true, ready: false, connected: true }),
    ]);
    // Tokens never appear in anything broadcast.
    expect(JSON.stringify(peer.messages)).not.toContain(ref.seat.token);
  });

  it('lets others join by code, de-duplicates names and gives everyone a distinct colour', () => {
    const { manager } = setup();
    const { room, peers } = roomWith(manager, 3);
    const joiner = new FakePeer();
    seatRef(manager.join(room.code, 'Host', joiner));
    const state = joiner.last<RoomState>(EV.room)!;
    expect(state.players.map((p) => p.name)).toEqual(['Host', 'P1', 'P2', 'Host 2']);
    expect(new Set(state.players.map((p) => p.color)).size).toBe(4);
    // Everyone already in the room heard about the newcomer.
    expect(peers[0].last<RoomState>(EV.room)!.players).toHaveLength(4);
  });

  it('refuses unknown codes and a ninth player', () => {
    const { manager } = setup();
    expect(manager.join('ZZZZZZ', 'X', new FakePeer())).toMatch(/No room/);
    const { room } = roomWith(manager, MAX_PLAYERS);
    expect(room.seats).toHaveLength(MAX_PLAYERS);
    expect(manager.join(room.code, 'Late', new FakePeer())).toMatch(/full/);
    expect(room.seats).toHaveLength(MAX_PLAYERS);
  });

  it('keeps rooms apart, and deletes a room once everyone has left', () => {
    const { manager } = setup();
    const a = roomWith(manager, 2);
    const b = roomWith(manager, 2);
    expect(a.room.code).not.toBe(b.room.code);
    a.room.setReady(a.seats[1], true);
    expect(b.peers[0].all<RoomState>(EV.room).some((s) => s.code === a.room.code)).toBe(false);
    for (const ref of a.refs) manager.leave(ref);
    expect(manager.rooms.has(a.room.code)).toBe(false);
    expect(manager.rooms.has(b.room.code)).toBe(true);
    expect(manager.resume(a.seats[0].token, new FakePeer())).toMatch(/expired/);
  });
});

describe('lobby: ready, host, start', () => {
  it('is waiting until two players (the host counts) can race, then ready', () => {
    const { manager } = setup();
    const { room, seats } = roomWith(manager, 3);
    expect(room.publicPhase).toBe('waiting');
    room.setReady(seats[1], true);
    expect(room.publicPhase).toBe('ready');
    room.setReady(seats[1], false);
    expect(room.publicPhase).toBe('waiting');
  });

  it('only lets the host start, and only with enough ready players', () => {
    const { manager } = setup();
    const { room, seats, peers } = roomWith(manager, 3);
    expect(room.start(seats[1])).toMatch(/Only the host/);
    expect(room.setLaps(seats[1], 5)).toMatch(/Only the host/);
    expect(room.start(seats[0])).toMatch(/At least 2/);
    expect(peers[1].all(EV.raceStart)).toHaveLength(0);
    room.setReady(seats[2], true);
    expect(room.start(seats[0])).toBeNull();
    expect(room.publicPhase).toBe('countdown');
    expect(room.start(seats[0])).toMatch(/already running/);
    expect(room.setReady(seats[1], true)).toMatch(/lobby/);
  });

  it('hands the host role on when the host leaves', () => {
    const { manager } = setup();
    const { room, refs, peers } = roomWith(manager, 3);
    manager.leave(refs[0]);
    expect(room.hostId).toBe(refs[1].seat.id);
    expect(peers[2].last<RoomState>(EV.room)!.players.find((p) => p.host)?.name).toBe('P1');
  });
});

describe('race lifecycle', () => {
  it('starts everyone on the same server tick from a shared timestamp, on distinct grid slots', () => {
    const { manager, clock } = setup();
    const { room, seats, peers } = roomWith(manager, 4);
    room.setReady(seats[1], true);
    room.setReady(seats[3], true); // seat 2 is not ready: it watches this race
    room.start(seats[0]);
    const infos = peers.map((p) => p.last<RaceStartInfo>(EV.raceStart)!);
    expect(new Set(infos.map((i) => i.startTime)).size).toBe(1);
    expect(infos[0].startTime).toBe(clock.t + RACE_START_DELAY_MS);
    expect(infos[0].goTick).toBe(RACE_RULES.countdownTicks);
    expect(infos[0].racers.map((r) => r.name)).toEqual(['Host', 'P1', 'P3']);
    expect(infos[0].racers.map((r) => r.slot)).toEqual([0, 1, 2]);
    // Nothing moves before the start time, then the countdown runs to GO.
    clock.advance(RACE_START_DELAY_MS - 1);
    manager.update();
    expect(room.currentRace!.sim.tick).toBe(0);
    runUntil(clock, manager, room, seats, () => room.publicPhase === 'racing');
    expect(room.currentRace!.sim.tick).toBe(RACE_RULES.countdownTicks);
    const state = peers[2].last<RoomState>(EV.room)!;
    expect(state.players.find((p) => p.name === 'P2')?.racing).toBe(false);
  });

  it('announces its snapshot rate and keeps to it', () => {
    const { manager, clock } = setup({ snapshotRate: 30 });
    const { room, seats, peers } = roomWith(manager, 2);
    startRace(room, seats);
    expect(peers[1].last<RaceStartInfo>(EV.raceStart)!.snapshotRate).toBe(30);
    clock.advance(RACE_START_DELAY_MS + 1005);
    manager.update();
    const ticks = peers[1].all<SnapshotMessage>(EV.snapshot).map((s) => s.t);
    expect(ticks.length).toBe(30);
    expect(ticks.every((t, i) => i === 0 || t - ticks[i - 1] === 2)).toBe(true);
  });

  for (const players of [2, 4, 8]) {
    it(`runs a full ${players}-player race to server-made results`, () => {
      const { manager, clock } = setup();
      const { room, seats, peers } = roomWith(manager, players);
      room.setLaps(seats[0], 1);
      startRace(room, seats);
      runUntil(clock, manager, room, seats, () => room.publicPhase === 'results', 240);
      const results = peers[players - 1].last<RaceResults>(EV.results)!;
      expect(results.entries).toHaveLength(players);
      expect(results.entries.every((e) => e.finished && !e.dnf)).toBe(true);
      expect(results.entries.map((e) => e.position)).toEqual(
        Array.from({ length: players }, (_, i) => i + 1),
      );
      // Finish order follows the times, to the sub-tick.
      const times = results.entries.map((e) => e.totalTime!);
      expect([...times].sort((a, b) => a - b)).toEqual(times);
      expect(results.winnerId).toBe(results.entries[0].id);
      // Every player got the same results, and laps came from the server's gates.
      for (const peer of peers) expect(peer.last<RaceResults>(EV.results)).toEqual(results);
      const lapEvents = peers[0]
        .all<EventsMessage>(EV.events)
        .flatMap((m) => m.e)
        .filter((e) => e.type === 'lap');
      expect(lapEvents).toHaveLength(players);
    });
  }

  it('restarts in the same room, or returns everyone to the lobby', () => {
    const { manager, clock } = setup();
    const { room, seats, peers } = roomWith(manager, 2);
    room.setLaps(seats[0], 1);
    startRace(room, seats);
    runUntil(clock, manager, room, seats, () => room.publicPhase === 'results', 240);
    expect(room.restart(seats[1])).toMatch(/Only the host/);
    // The next race needs the others ready for it again (the host's request counts as ready).
    expect(room.restart(seats[0])).toMatch(/At least 2/);
    room.setReady(seats[1], true);
    expect(room.restart(seats[0])).toBeNull();
    expect(peers[1].last<RaceStartInfo>(EV.raceStart)!.raceId).toBe(2);
    runUntil(clock, manager, room, seats, () => room.publicPhase === 'results', 240);
    expect(room.toLobby(seats[0])).toBeNull();
    expect(room.publicPhase).toBe('waiting');
    expect(room.seats.every((s) => !s.ready)).toBe(true);
  });
});

describe('authoritative race rules', () => {
  function racing(players = 2) {
    const env = setup();
    const ctx = roomWith(env.manager, players);
    startRace(ctx.room, ctx.seats);
    runUntil(env.clock, env.manager, ctx.room, ctx.seats, () => ctx.room.publicPhase === 'racing');
    return { ...env, ...ctx, sim: ctx.room.currentRace!.sim };
  }
  const step = (env: ReturnType<typeof racing>, ticks: number, drivers = env.seats) => {
    for (let i = 0; i < ticks; i++) {
      sendBotInputs(env.room, drivers);
      env.clock.advance(TICK_MS);
      env.manager.update();
    }
  };

  it('ignores malformed, late, far-future and over-limit input packets', () => {
    const env = racing();
    const seat = env.seats[0];
    const before = seat.malformed;
    for (const bad of [null, 'go', [1], [env.sim.tick + 1, 101, 0, 0, 0], { t: 1 }]) {
      env.room.receiveInput(seat, bad);
    }
    expect(seat.malformed).toBe(before + 5);
    const frame = packInputFrame({ ...createInput(), throttle: 1 });
    env.room.receiveInput(seat, encodeInputPacket(env.room.raceId, env.sim.tick, [frame]));
    expect(seat.late).toBeGreaterThan(0);
    env.room.receiveInput(seat, encodeInputPacket(env.room.raceId, env.sim.tick + 500, [frame]));
    expect(seat.inputs.has(env.sim.tick + 500)).toBe(false);
    // A flood is cut off by the rate limit.
    const refusedBefore = seat.inputBucket.refused;
    for (let i = 0; i < 200; i++) {
      env.room.receiveInput(seat, encodeInputPacket(env.room.raceId, env.sim.tick + 1, [frame]));
    }
    expect(seat.inputBucket.refused).toBeGreaterThan(refusedBefore + 100);
    expect(decodeInputPacket(encodeInputPacket(1, 1, [frame]))).not.toBeNull();
  });

  it("only moves the sender's own car", () => {
    const { manager, clock } = setup();
    const { room, seats } = roomWith(manager, 2);
    startRace(room, seats);
    const [a, b] = seats;
    const sim = room.currentRace!.sim;
    const carB = sim.getRacer(b.id)!.vehicle;
    const start = { x: carB.x, z: carB.z };
    // Only A ever sends inputs, through countdown and racing.
    runUntil(clock, manager, room, [a], () => sim.tick > sim.goTick + 120);
    expect(Math.hypot(carB.x - start.x, carB.z - start.z)).toBeLessThan(0.01);
    expect(sim.getRacer(b.id)!.input.throttle).toBe(0);
    expect(sim.getRacer(a.id)!.vehicle.speed).toBeGreaterThan(20);
  });

  it('keeps Energy and boost on the server: one burst per press, and none without Energy', () => {
    const env = racing();
    const seat = env.seats[0];
    const racer = env.sim.getRacer(seat.id)!;
    step(env, 90);
    const energy = racer.vehicle.energy;
    const press = (boost: boolean) => packInputFrame({ ...createInput(), throttle: 1, boost });
    // Press for one tick, then hold it pressed for 2 s: exactly one burst is paid for.
    env.room.receiveInput(
      seat,
      encodeInputPacket(env.room.raceId, env.sim.tick + 1, [press(true)]),
    );
    for (let i = 0; i < 120; i++) {
      env.room.receiveInput(
        seat,
        encodeInputPacket(env.room.raceId, env.sim.tick + 2, [press(true)]),
      );
      env.clock.advance(TICK_MS);
      env.manager.update();
    }
    expect(racer.stats.boosts).toBe(1);
    expect(racer.vehicle.energy).toBeLessThanOrEqual(energy - RACE_RULES.boostCost + 13);
    // The snapshot each client re-bases on carries the server's number, not the client's.
    const snap = env.peers[0].last<SnapshotMessage>(EV.snapshot)!;
    const copy: RacerState = {
      ...racer,
      vehicle: createVehicle(),
      padReadyTick: [...racer.padReadyTick],
    };
    expect(unpackPredictedState(snap.me, copy)).toBe(true);
    expect(Math.abs(copy.vehicle.energy - racer.vehicle.energy)).toBeLessThan(13);
    // With no Energy, presses do nothing.
    racer.vehicle.energy = 5;
    const boosts = racer.stats.boosts;
    for (let i = 0; i < 60; i++) {
      env.room.receiveInput(
        seat,
        encodeInputPacket(env.room.raceId, env.sim.tick + 1, [press(i % 2 === 0)]),
      );
      env.clock.advance(TICK_MS);
      env.manager.update();
    }
    expect(racer.stats.boosts).toBe(boosts);
  });

  it('counts laps only through the gates in order: no client message can add one', () => {
    const env = racing();
    const racer = env.sim.getRacer(env.seats[0].id)!;
    step(env, 300);
    // Whatever a client sends, it is an input frame or nothing: there is no lap, finish,
    // position or Energy message to fake. Laps advance only from the simulation.
    expect(racer.lap).toBe(0);
    expect(racer.nextCheckpoint).toBeGreaterThanOrEqual(1);
    const events = env.peers[0].all<EventsMessage>(EV.events).flatMap((m) => m.e);
    expect(events.filter((e) => e.type === 'lap')).toHaveLength(0);
  });
});

describe('disconnect and reconnect', () => {
  function racingPair(graceMs = 30_000) {
    const env = setup({ graceMs });
    const ctx = roomWith(env.manager, 3);
    startRace(env.manager.rooms.get(ctx.room.code)!, ctx.seats);
    runUntil(env.clock, env.manager, ctx.room, ctx.seats, () => ctx.room.publicPhase === 'racing');
    runUntil(env.clock, env.manager, ctx.room, ctx.seats, () => false, 8);
    return { ...env, ...ctx };
  }

  it('keeps a dropped player’s car and progress, and restores them on resume without a duplicate', () => {
    const env = racingPair();
    const [, b] = env.refs;
    const sim = env.room.currentRace!.sim;
    const racer = sim.getRacer(b.seat.id)!;
    env.manager.drop(b, env.peers[1]);
    expect(env.peers[0].last<RoomState>(EV.room)!.players[1].connected).toBe(false);
    // While away the car coasts (neutral input after a short timeout), still in the race.
    const others = [env.seats[0], env.seats[2]];
    runUntil(env.clock, env.manager, env.room, others, () => false, 0.5);
    const coasting = racer.vehicle.speed;
    runUntil(env.clock, env.manager, env.room, others, () => false, 2.5);
    expect(racer.input.throttle).toBe(0);
    expect(racer.input.boost).toBe(false);
    expect(racer.vehicle.speed).toBeLessThan(coasting - 5);
    expect(env.peers[0].last<SnapshotMessage>(EV.snapshot)!.r[1][9] & FLAG_OFFLINE).toBeTruthy();
    // Resuming changes nothing about the car: no lap, checkpoint or Energy reset.
    const progress = { lap: racer.lap, next: racer.nextCheckpoint };
    const energy = racer.vehicle.energy;
    const fresh = new FakePeer();
    const back = seatRef(env.manager.resume(b.seat.token, fresh));
    expect(back.seat).toBe(b.seat);
    expect(env.room.seats).toHaveLength(3);
    expect(sim.racers).toHaveLength(3);
    expect(racer.lap).toBe(progress.lap);
    expect(racer.nextCheckpoint).toBe(progress.next);
    expect(racer.vehicle.energy).toBe(energy);
    // The returning client gets the race to rebuild its view, then snapshots with its car.
    expect(fresh.last<RaceStartInfo>(EV.raceStart)!.raceId).toBe(1);
    runUntil(env.clock, env.manager, env.room, env.seats, () => false, 0.2);
    expect(fresh.last<SnapshotMessage>(EV.snapshot)!.me).toBeDefined();
  });

  it('closes the older connection when a seat is resumed elsewhere', () => {
    const env = racingPair();
    const old = env.peers[2];
    seatRef(env.manager.resume(env.seats[2].token, new FakePeer()));
    expect(old.closed).toMatch(/another window/);
    expect(env.room.seats).toHaveLength(3);
  });

  it('retires a player who does not come back (DNF), passes on the host, and finishes the race', () => {
    const env = racingPair(5_000);
    const [host] = env.refs;
    env.manager.drop(host, env.peers[0]);
    runUntil(env.clock, env.manager, env.room, env.seats.slice(1), () => false, 6);
    expect(env.room.seats).toHaveLength(2);
    expect(env.room.hostId).toBe(env.seats[1].id);
    expect(env.manager.resume(host.seat.token, new FakePeer())).toMatch(/expired/);
    runUntil(
      env.clock,
      env.manager,
      env.room,
      env.seats.slice(1),
      () => env.room.publicPhase === 'results',
      600,
    );
    const results = env.peers[1].last<RaceResults>(EV.results)!;
    const gone = results.entries.find((e) => e.name === 'Host')!;
    expect(gone.dnf).toBe(true);
    expect(gone.position).toBe(3);
    expect(results.entries.filter((e) => e.finished)).toHaveLength(2);
  });

  it('lets a player join mid-race to watch, then race the next one', () => {
    const env = racingPair();
    const late = new FakePeer();
    const ref = seatRef(env.manager.join(env.room.code, 'Late', late));
    expect(late.last<RaceStartInfo>(EV.raceStart)!.racers.some((r) => r.id === ref.seat.id)).toBe(
      false,
    );
    runUntil(env.clock, env.manager, env.room, env.seats, () => false, 0.2);
    const snap = late.last<SnapshotMessage>(EV.snapshot)!;
    expect(snap.r).toHaveLength(3);
    expect(snap.me).toBeUndefined();
    env.room.receiveInput(
      ref.seat,
      encodeInputPacket(env.room.raceId, env.room.currentRace!.sim.tick + 1, [[100, 0, 0, 0]]),
    );
    expect(ref.seat.inputs.size).toBe(0);
  });
});
