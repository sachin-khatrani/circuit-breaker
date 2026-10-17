import {
  createInput,
  encodeInputPacket,
  EV,
  LEFT_LANE,
  packInputFrame,
  RACE_RULES,
  TICK_RATE,
  unpackCourse,
  createCourseState,
  type AbilityId,
  type EventsMessage,
  type RaceEvent,
  type RaceResults,
  type SnapshotMessage,
} from '@circuit-breaker/shared';
import { describe, expect, it } from 'vitest';
import type { Seat } from '../src/rooms/Room';
import { FakePeer, roomWith, runUntil, seatRef, setup, startRace, TICK_MS } from './helpers';

const rules = RACE_RULES;

/** A room of `players`, racing (past GO), with every car on 100 Energy. */
function racing(players = 2, graceMs = 30_000) {
  const env = setup({ graceMs });
  const ctx = roomWith(env.manager, players);
  startRace(ctx.room, ctx.seats);
  runUntil(env.clock, env.manager, ctx.room, ctx.seats, () => ctx.room.publicPhase === 'racing');
  // Let the bots' queued frames run out (the server keeps the first frame sent for a tick).
  runUntil(env.clock, env.manager, ctx.room, [], () => false, 6 / TICK_RATE);
  const sim = ctx.room.currentRace!.sim;
  for (const r of sim.racers) r.vehicle.energy = 100;
  return { ...env, ...ctx, sim };
}

type Env = ReturnType<typeof racing>;

/** Advances the room by `ticks` (the listed seats get no autopilot input: they coast). */
function tick(env: Env, ticks = 1, drivers: Seat[] = []): void {
  runUntil(env.clock, env.manager, env.room, drivers, () => false, ticks / TICK_RATE);
}

/** Sends a press of an ability for the next tick through the normal input path. */
function sendPress(env: Env, seat: Seat, ability: AbilityId, atTick = env.sim.tick + 1): void {
  const frame = packInputFrame({ ...createInput(), throttle: 1, [ability]: true });
  env.room.receiveInput(seat, encodeInputPacket(env.room.raceId, atTick, [frame]));
}

const eventsOf = (peer: FakePeer): RaceEvent[] =>
  peer.all<EventsMessage>(EV.events).flatMap((m) => m.e);

describe('abilities through the server', () => {
  it('charges once on the server, and every player sees the same Energy and track state', () => {
    const env = racing(3);
    const [a] = env.seats;
    sendPress(env, a, 'shortcut');
    tick(env, 6);
    const racer = env.sim.getRacer(a.id)!;
    expect(racer.vehicle.energy).toBeCloseTo(100 - rules.shortcutCost, 6);
    expect(env.sim.course.shortcutOpenTick).toBeGreaterThan(0);
    // Everyone was told, and everyone's snapshot carries the same track state.
    for (const peer of env.peers) {
      const events = eventsOf(peer);
      expect(events.filter((e) => e.type === 'ability')).toMatchObject([
        { racerId: a.id, ability: 'shortcut' },
      ]);
      expect(events.filter((e) => e.type === 'shortcut')).toMatchObject([{ phase: 'opening' }]);
    }
    const snaps = env.peers.map((p) => p.last<SnapshotMessage>(EV.snapshot)!);
    expect(new Set(snaps.map((s) => s.t)).size).toBe(1);
    expect(new Set(snaps.map((s) => JSON.stringify(s.k))).size).toBe(1);
    const course = createCourseState();
    expect(unpackCourse(snaps[0].k, course)).toBe(true);
    expect(course.shortcutOpenTick).toBe(env.sim.course.shortcutOpenTick);
    // The row every client draws holds the same Energy.
    for (const snap of snaps) expect(snap.r[0][12]).toBe(Math.floor(racer.vehicle.energy));
  });

  it('tells only the player when an ability is refused, and charges nothing', () => {
    const env = racing(2);
    const [a] = env.seats;
    env.sim.getRacer(a.id)!.vehicle.energy = 10;
    sendPress(env, a, 'gate');
    tick(env, 6);
    expect(env.sim.getRacer(a.id)!.vehicle.energy).toBe(10);
    expect(eventsOf(env.peers[0]).filter((e) => e.type === 'abilityDenied')).toMatchObject([
      { ability: 'gate', reason: 'energy' },
    ]);
    expect(eventsOf(env.peers[1]).some((e) => e.type === 'abilityDenied')).toBe(false);
    expect(env.sim.course.gateSwitchTick).toBe(-1);
  });

  it('fires once for repeated packets and a held button, then enforces the cooldown', () => {
    const env = racing(2);
    const [a] = env.seats;
    const start = env.sim.tick + 1;
    // The same press, sent again and again (as the client's redundancy does), then held.
    for (let k = 0; k < 4; k++) sendPress(env, a, 'overdrive', start);
    for (let k = 0; k < 60; k++) {
      sendPress(env, a, 'overdrive', env.sim.tick + 1);
      tick(env, 1);
    }
    const used = eventsOf(env.peers[0]).filter((e) => e.type === 'ability');
    expect(used).toHaveLength(1);
    expect(env.sim.getRacer(a.id)!.vehicle.energy).toBe(100 - rules.overdriveCost);
    // Released (the server repeats the last frame until told otherwise), then pressed again
    // inside the cooldown: refused by the server.
    const release = packInputFrame({ ...createInput(), throttle: 1 });
    env.room.receiveInput(
      a,
      encodeInputPacket(env.room.raceId, env.sim.tick + 1, [release, release]),
    );
    tick(env, 2);
    sendPress(env, a, 'overdrive');
    tick(env, 3);
    expect(eventsOf(env.peers[0]).filter((e) => e.type === 'abilityDenied')).toMatchObject([
      { reason: 'cooldown' },
    ]);
  });

  it('resolves simultaneous presses deterministically: one shortcut, paid once', () => {
    const env = racing(3);
    const [a, b, c] = env.seats;
    const at = env.sim.tick + 1;
    for (const seat of [c, b, a]) sendPress(env, seat, 'shortcut', at);
    tick(env, 4);
    const events = eventsOf(env.peers[0]);
    const used = events.filter((e) => e.type === 'ability');
    const denied = eventsOf(env.peers[1])
      .concat(eventsOf(env.peers[2]))
      .filter((e) => e.type === 'abilityDenied');
    expect(used).toHaveLength(1);
    expect(denied).toHaveLength(2);
    expect(denied.every((e) => e.type === 'abilityDenied' && e.reason === 'busy')).toBe(true);
    const paid = env.sim.racers.filter((r) => r.vehicle.energy < 100 - rules.shortcutCost + 1);
    expect(paid.map((r) => r.id)).toEqual([used[0].type === 'ability' ? used[0].racerId : '']);
  });

  it('ignores abilities from a player who is only watching, and refuses unknown buttons', () => {
    const env = racing(2);
    const watcher = new FakePeer();
    const ref = seatRef(env.manager.join(env.room.code, 'Watcher', watcher));
    sendPress(env, ref.seat, 'gate');
    tick(env, 4);
    expect(
      eventsOf(env.peers[0]).some((e) => e.type === 'ability' || e.type === 'abilityDenied'),
    ).toBe(false);
    expect(env.sim.course.gateSwitchTick).toBe(-1);
    // A racer sending a button outside the protocol: the whole packet is refused.
    const seat = env.seats[0];
    const before = seat.malformed;
    env.room.receiveInput(seat, [env.sim.tick + 1, 100, 0, 0, 64]);
    expect(seat.malformed).toBe(before + 1);
  });

  it('gives a player who reconnects during a track change the current track state', () => {
    const env = racing(2);
    const [a, b] = env.refs;
    env.manager.drop(b, env.peers[1]);
    sendPress(env, a.seat, 'gate');
    tick(env, 10);
    expect(env.sim.course.gateSwitchTick).toBeGreaterThan(env.sim.tick);
    const fresh = new FakePeer();
    seatRef(env.manager.resume(b.seat.token, fresh));
    tick(env, 6);
    const snap = fresh.last<SnapshotMessage>(EV.snapshot)!;
    const course = createCourseState();
    expect(unpackCourse(snap.k, course)).toBe(true);
    expect(course).toEqual(env.sim.course);
    expect(course.gateNextLane).toBe(LEFT_LANE);
    // ...and after the switch, the switched state.
    tick(env, rules.gateWarnTicks);
    unpackCourse(fresh.last<SnapshotMessage>(EV.snapshot)!.k, course);
    expect(course.gateLane).toBe(LEFT_LANE);
    expect(course.gateSwitchTick).toBe(-1);
  });

  it('keeps rooms apart: one room’s ability changes nothing in another', () => {
    const one = racing(2);
    const two = racing(2);
    sendPress(one, one.seats[0], 'shortcut');
    tick(one, 6);
    tick(two, 6);
    expect(one.sim.course.shortcutOpenTick).toBeGreaterThan(0);
    expect(two.sim.course.shortcutOpenTick).toBe(-1);
    for (const peer of two.peers) {
      expect(eventsOf(peer).some((e) => e.type === 'ability' || e.type === 'shortcut')).toBe(false);
    }
  });

  it('records every press in the results: who, what, when, the outcome and the track change', () => {
    const env = racing(2);
    const [a, b] = env.seats;
    sendPress(env, a, 'shortcut');
    tick(env, 3);
    env.sim.getRacer(b.id)!.vehicle.energy = 0;
    sendPress(env, b, 'overdrive');
    tick(env, 3);
    runUntil(
      env.clock,
      env.manager,
      env.room,
      env.seats,
      () => env.room.publicPhase === 'results',
      400,
    );
    const results = env.peers[1].last<RaceResults>(EV.results)!;
    expect(results.abilities).toHaveLength(2);
    const [opened, refused] = results.abilities;
    expect(opened).toMatchObject({
      racerId: a.id,
      name: 'Host',
      ability: 'shortcut',
      ok: true,
      reason: null,
    });
    expect(opened.until! - opened.from!).toBeCloseTo(rules.shortcutOpenTicks / TICK_RATE, 3);
    expect(opened.from! - opened.time).toBeCloseTo(rules.shortcutOpenDelayTicks / TICK_RATE, 3);
    expect(refused).toMatchObject({
      racerId: b.id,
      ability: 'overdrive',
      ok: false,
      reason: 'energy',
    });
    expect(refused.time).toBeGreaterThan(opened.time);
  });

  it('times the shortcut on the server: it opens and closes on schedule for everyone', () => {
    const env = racing(2);
    sendPress(env, env.seats[0], 'shortcut');
    tick(env, rules.shortcutOpenDelayTicks + rules.shortcutOpenTicks + 10, env.seats);
    for (const peer of env.peers) {
      const phases = eventsOf(peer)
        .filter((e) => e.type === 'shortcut')
        .map((e) => (e.type === 'shortcut' ? e.phase : ''));
      expect(phases).toEqual(['opening', 'open', 'closing', 'closed']);
    }
    expect(env.sim.course.shortcutOpenTick).toBe(-1);
    expect(TICK_MS).toBeGreaterThan(0);
  });
});
