import { describe, expect, it } from 'vitest';
import {
  ABILITIES,
  autopilotInput,
  createInput,
  DT,
  gateLaneAt,
  GRID_ZERO,
  LEFT_LANE,
  placeVehicle,
  RACE_RULES,
  RaceSimulation,
  RIGHT_LANE,
  shortcutOpenAt,
  shortcutPhase,
  Track,
  VEHICLE_TUNING,
  type AbilityId,
  type PlayerInput,
  type RaceEvent,
  type RacerState,
} from '../src';

const track = new Track(GRID_ZERO);
const branch = track.branches[0];
const split = track.splits[0];
const rules = RACE_RULES;

/** A race already running (no countdown), with the given racers and starting Energy. */
function race(ids: string[] = ['a'], startEnergy = 100, laps = 1): RaceSimulation {
  const sim = new RaceSimulation(track, { laps, skipCountdown: true, startEnergy });
  ids.forEach((id, slot) => sim.addRacer(id, id, slot));
  return sim;
}

/** Steps with each racer's input (missing racers get neutral input); returns all events. */
function step(sim: RaceSimulation, inputs: Record<string, Partial<PlayerInput>> = {}): RaceEvent[] {
  for (const r of sim.racers) sim.setInput(r.id, { ...createInput(), ...inputs[r.id] });
  sim.step();
  return sim.drainEvents();
}

/** One press of an ability button (press, then release on the next tick). */
function press(sim: RaceSimulation, id: string, ability: AbilityId): RaceEvent[] {
  const events = step(sim, { [id]: { [ability]: true } });
  return [...events, ...step(sim)];
}

const of = <T extends RaceEvent['type']>(events: RaceEvent[], type: T) =>
  events.filter((e): e is Extract<RaceEvent, { type: T }> => e.type === type);

/** Drives a racer with the autopilot for `ticks`, collecting events. */
function drive(
  sim: RaceSimulation,
  r: RacerState,
  ticks: number,
  options: { shortcut?: boolean; until?: () => boolean } = {},
): RaceEvent[] {
  const input = createInput();
  const events: RaceEvent[] = [];
  for (let k = 0; k < ticks && !(options.until?.() ?? false); k++) {
    autopilotInput(
      track,
      r.vehicle,
      { racingLine: true, course: sim.course, tick: sim.tick, shortcut: options.shortcut },
      input,
    );
    for (const other of sim.racers) sim.setInput(other.id, other === r ? input : createInput());
    sim.step();
    events.push(...sim.drainEvents());
  }
  return events;
}

/** Puts a racer on the main road at s, lateral, moving forward at `speed`. */
function launch(r: RacerState, s: number, lateral: number, speed: number, roadId = 0): void {
  placeVehicle(r.vehicle, track, s, lateral, roadId);
  const v = r.vehicle;
  v.vx = Math.sin(v.yaw) * speed;
  v.vz = Math.cos(v.yaw) * speed;
  r.prevX = v.x;
  r.prevZ = v.z;
}

describe('the track: shortcut branch and lane split', () => {
  it('has one shortcut whose openings share the main road edge exactly', () => {
    expect(track.branches).toHaveLength(1);
    expect(branch.name).toBe('The Needle');
    for (const portal of track.portals) {
      for (let j = portal.branchFrom; j <= portal.branchTo; j++) {
        const f = branch.frameAt(j * branch.spacing);
        const edge = { x: f.x + f.rx * f.halfWidth, z: f.z + f.rz * f.halfWidth };
        const p = track.project(edge.x, edge.z, -1);
        expect(Math.abs(p.lateral + p.halfWidth)).toBeLessThan(0.05);
        expect(Math.abs(branch.py[j] - p.height)).toBeLessThan(0.05);
      }
    }
  });

  it('bypasses no checkpoint, so both routes pass every gate', () => {
    const from = branch.entryMainS;
    const span = track.distanceAhead(from, branch.exitMainS + branch.exitMainSpan);
    for (const gate of track.checkpoints) {
      expect(track.distanceAhead(from, gate.s)).toBeGreaterThan(span);
    }
  });

  it('keeps the branch clear of the main road between its openings', () => {
    for (let i = 0; i < branch.count; i++) {
      if (branch.portalRight[i] >= 0) continue;
      // Just past the entrance the two barriers still stand back to back.
      if (i * branch.spacing < branch.entryEnd + 6) continue;
      const p = track.project(branch.px[i], branch.pz[i], -1);
      expect(Math.abs(p.lateral) - p.halfWidth - branch.halfWidth[i]).toBeGreaterThan(0);
    }
  });

  it('splits the Overload hairpin into two lanes behind a funnel', () => {
    expect(split.divider).toBe(1.5);
    expect(split.length).toBeGreaterThan(100);
    expect(track.splitAt(Math.floor((split.s + 20) / track.spacing))).toBe(split.id);
    expect(track.splitAt(Math.floor((split.funnelS - 30) / track.spacing))).toBe(-1);
  });
});

describe('abilities: Energy, cooldowns, duplicates', () => {
  it('refuses an ability without enough Energy, and takes nothing', () => {
    const sim = race(['a'], 30);
    const events = press(sim, 'a', 'shortcut');
    expect(of(events, 'abilityDenied')).toMatchObject([{ ability: 'shortcut', reason: 'energy' }]);
    expect(of(events, 'ability')).toHaveLength(0);
    expect(sim.racers[0].vehicle.energy).toBe(30);
    expect(sim.course.shortcutOpenTick).toBe(-1);
  });

  it('takes the exact cost once and starts the cooldown', () => {
    const sim = race(['a'], 100);
    const events = press(sim, 'a', 'gate');
    expect(of(events, 'ability')).toMatchObject([
      { ability: 'gate', energy: 100 - rules.gateCost },
    ]);
    const r = sim.racers[0];
    expect(r.vehicle.energy).toBe(100 - rules.gateCost);
    expect(r.abilityCooldown[ABILITIES.indexOf('gate')]).toBeGreaterThan(
      rules.gateCooldownTicks - 3,
    );
    // The cooldown refuses the next press without charging.
    const again = press(sim, 'a', 'gate');
    expect(of(again, 'abilityDenied')).toMatchObject([{ reason: 'cooldown' }]);
    expect(r.vehicle.energy).toBe(100 - rules.gateCost);
  });

  it('fires once for a held button, however long it is held', () => {
    const sim = race(['a'], 100);
    const events: RaceEvent[] = [];
    for (let k = 0; k < 120; k++) events.push(...step(sim, { a: { overdrive: true } }));
    expect(of(events, 'ability')).toHaveLength(1);
    expect(of(events, 'abilityDenied')).toHaveLength(0);
    expect(sim.racers[0].vehicle.energy).toBe(100 - rules.overdriveCost);
  });

  it('resolves two shortcut presses in the same tick: one opens and pays, one is refused', () => {
    const sim = race(['a', 'b'], 100);
    const events = step(sim, { a: { shortcut: true }, b: { shortcut: true } });
    const used = of(events, 'ability');
    const denied = of(events, 'abilityDenied');
    expect(used).toHaveLength(1);
    expect(denied).toHaveLength(1);
    expect(denied[0].reason).toBe('busy');
    const [a, b] = sim.racers;
    const paid = [a, b].filter((r) => r.vehicle.energy === 100 - rules.shortcutCost);
    expect(paid).toHaveLength(1);
    expect(paid[0].id).toBe(used[0].racerId);
    // The same inputs always give the same winner (racers resolve in grid order).
    const again = race(['a', 'b'], 100);
    expect(
      of(step(again, { a: { shortcut: true }, b: { shortcut: true } }), 'ability')[0].racerId,
    ).toBe(used[0].racerId);
  });

  it('refuses abilities during the countdown and after the finish', () => {
    const sim = new RaceSimulation(track, { laps: 1, startEnergy: 100 });
    sim.addRacer('a', 'a', 0);
    // Held through the countdown: nothing fires at GO either.
    const events: RaceEvent[] = [];
    while (sim.phase === 'countdown') events.push(...step(sim, { a: { overdrive: true } }));
    events.push(...step(sim, { a: { overdrive: true } }));
    expect(of(events, 'ability')).toHaveLength(0);
    const r = sim.racers[0];
    r.finished = true;
    step(sim);
    expect(of(press(sim, 'a', 'overdrive'), 'abilityDenied')).toMatchObject([{ reason: 'phase' }]);
  });

  it('never lets Energy leave its range', () => {
    const sim = race(['a'], 100);
    const r = sim.racers[0];
    for (const ability of ABILITIES) press(sim, 'a', ability);
    expect(r.vehicle.energy).toBe(100 - rules.shortcutCost - rules.gateCost);
    // Overdrive was refused for lack of Energy: 25 left, 40 needed.
    expect(r.vehicle.energy).toBeGreaterThanOrEqual(rules.minEnergy);
    expect(r.vehicle.overdriveTicks).toBe(0);
  });
});

describe('Energy rewards cannot be farmed', () => {
  it('pays a speed lane once per lap, however often it is driven', () => {
    const sim = race(['a'], 0);
    const r = sim.racers[0];
    const lane = track.lanes[0];
    const input = createInput();
    const pass = () => {
      launch(r, lane.s - 15, lane.lateral, 30);
      const events: RaceEvent[] = [];
      for (let k = 0; k < 180; k++) {
        // Hold the lane's line through it.
        autopilotInput(track, r.vehicle, { lane: lane.lateral, pace: 0.6 }, input);
        sim.setInput('a', input);
        sim.step();
        events.push(...sim.drainEvents());
      }
      return of(events, 'laneCharge');
    };
    expect(pass()).toMatchObject([{ laneId: 0, gained: rules.laneEnergy }]);
    expect(pass()).toHaveLength(0);
    expect(r.vehicle.energy).toBeCloseTo(rules.laneEnergy, 6);
  });

  it('caps drift Energy per lap', () => {
    const sim = race(['a'], 0);
    const r = sim.racers[0];
    r.vehicle.driftLapEnergy = rules.driftEnergyMaxPerLap;
    launch(r, 200, 0, 40);
    let gained = 0;
    for (let k = 0; k < 240; k++) {
      const events = step(sim, {
        a: { throttle: 1, steer: k % 120 < 60 ? 0.6 : -0.6, drift: true },
      });
      for (const e of of(events, 'driftReward')) gained += e.energy;
    }
    expect(gained).toBe(0);
    expect(r.vehicle.energy).toBe(0);
  });
});

describe('Shortcut: the Needle', () => {
  it('opens after a warning, closes on time, then stays locked briefly', () => {
    const sim = race(['a'], 100);
    const start = sim.tick + 1;
    const events = press(sim, 'a', 'shortcut');
    expect(of(events, 'shortcut')).toMatchObject([{ phase: 'opening' }]);
    const openTick = start + rules.shortcutOpenDelayTicks;
    const closeTick = openTick + rules.shortcutOpenTicks;
    expect(sim.course.shortcutOpenTick).toBe(openTick);
    expect(sim.course.shortcutCloseTick).toBe(closeTick);
    expect(shortcutPhase(sim.course, openTick - 1, rules)).toBe('opening');
    expect(shortcutOpenAt(sim.course, openTick - 1)).toBe(false);
    expect(shortcutOpenAt(sim.course, openTick)).toBe(true);
    expect(shortcutPhase(sim.course, closeTick - rules.shortcutWarnTicks, rules)).toBe('closing');
    const phases: string[] = [];
    while (sim.tick < closeTick + 2)
      for (const e of of(step(sim), 'shortcut')) phases.push(e.phase);
    expect(phases).toEqual(['open', 'closing', 'closed']);
    expect(sim.course.shortcutOpenTick).toBe(-1);
    // Locked just after closing, for everyone.
    sim.racers[0].abilityCooldown.fill(0);
    expect(of(press(sim, 'a', 'shortcut'), 'abilityDenied')).toMatchObject([{ reason: 'busy' }]);
  });

  it('keeps a closed entrance shut: the car stays on the main road', () => {
    const sim = race(['a'], 0);
    const r = sim.racers[0];
    launch(r, branch.entryMainS - 30, -6, 22);
    let touched = false;
    for (let k = 0; k < 150; k++) {
      // Steer hard at the entrance.
      step(sim, { a: { throttle: 0.5, steer: -0.5 } });
      touched ||= r.vehicle.wallContact;
      expect(r.vehicle.road).toBe(0);
      expect(r.vehicle.lateral).toBeGreaterThan(-track.halfWidth[r.vehicle.trackIndex]);
    }
    // It met the barrier across the entrance.
    expect(touched).toBe(true);
  });

  it('lets a car through when open, and back onto the main road at the merge', () => {
    const sim = race(['a'], 100);
    const r = sim.racers[0];
    launch(r, branch.entryMainS - 120, 0, 30);
    press(sim, 'a', 'shortcut');
    let wasOnBranch = false;
    const events = drive(sim, r, 900, {
      shortcut: true,
      until: () => {
        if (r.vehicle.road === branch.roadId) wasOnBranch = true;
        return wasOnBranch && r.vehicle.road === 0;
      },
    });
    expect(wasOnBranch).toBe(true);
    expect(of(events, 'wallHit').length).toBeLessThan(3);
    expect(r.stats.shortcutRuns).toBe(1);
    expect(r.vehicle.road).toBe(0);
    // Back on the main road after the merge.
    expect(track.distanceAhead(branch.exitMainS, r.vehicle.trackS)).toBeLessThan(80);
  });

  it('never traps a car inside when it closes: the merge is always open', () => {
    const sim = race(['a'], 100);
    const r = sim.racers[0];
    // On the branch, then the shortcut closes (it was never open: the worst case).
    launch(r, branch.entryEnd + 4, 0, 18, branch.roadId);
    expect(r.vehicle.road).toBe(branch.roadId);
    expect(sim.shortcutOpen).toBe(false);
    drive(sim, r, 600, { until: () => r.vehicle.road === 0 });
    expect(r.vehicle.road).toBe(0);
    expect(r.vehicle.frozenTicks).toBe(0);
  });

  it('counts a lap through the shortcut, with every checkpoint, and is faster', () => {
    const lap = (useShortcut: boolean) => {
      const sim = race(['a'], 100);
      const r = sim.racers[0];
      const input = createInput();
      const events: RaceEvent[] = [];
      let opened = false;
      while (!r.finished && sim.tick < 60 * 120) {
        autopilotInput(
          track,
          r.vehicle,
          { racingLine: true, course: sim.course, tick: sim.tick, shortcut: useShortcut },
          input,
        );
        // Open the shortcut 250 m before its entrance.
        const toEntry = track.distanceAhead(r.vehicle.trackS, branch.entryMainS);
        if (useShortcut && !opened && r.started && toEntry < 250) {
          input.shortcut = true;
          opened = true;
        }
        sim.setInput('a', input);
        sim.step();
        events.push(...sim.drainEvents());
      }
      return { r, events };
    };
    const main = lap(false);
    const cut = lap(true);
    for (const run of [main, cut]) {
      expect(run.r.finished).toBe(true);
      expect(of(run.events, 'checkpoint').map((e) => e.checkpoint)).toEqual([1, 2, 3]);
      expect(of(run.events, 'lap')).toHaveLength(1);
    }
    expect(cut.r.stats.shortcutRuns).toBe(1);
    expect(main.r.stats.shortcutRuns).toBe(0);
    const saved = (main.r.finishTime ?? 0) - (cut.r.finishTime ?? 0);
    expect(saved).toBeGreaterThan(0.3);
    expect(saved).toBeLessThan(3);
  });
});

describe('Gate Shift: the Overload split', () => {
  /** Drives a car from before the funnel through the split; returns the lane it ends in. */
  const through = (sim: RaceSimulation, r: RacerState, lateral: number) => {
    launch(r, split.funnelS - 40, lateral, 30);
    let lane = -1;
    let walls = 0;
    for (let k = 0; k < 400; k++) {
      const events = drive(sim, r, 1);
      walls += of(events, 'wallHit').length;
      if (r.vehicle.splitLane >= 0) lane = r.vehicle.splitLane;
      if (track.distanceAhead(split.s, r.vehicle.trackS) > split.length + 10 && lane >= 0) break;
    }
    return { lane, walls };
  };

  it('starts with the inside lane open and funnels every car into it', () => {
    const sim = race(['a'], 100);
    expect(gateLaneAt(sim.course, sim.tick)).toBe(RIGHT_LANE);
    expect(through(sim, sim.racers[0], -8).lane).toBe(RIGHT_LANE);
  });

  it('switches after its warning, then locks; one lane is always open', () => {
    const sim = race(['a', 'b'], 100);
    const start = sim.tick + 1;
    const events = press(sim, 'a', 'gate');
    expect(of(events, 'gate')).toMatchObject([
      { phase: 'warning', lane: LEFT_LANE, switchTick: start + rules.gateWarnTicks },
    ]);
    expect(gateLaneAt(sim.course, start + rules.gateWarnTicks - 1)).toBe(RIGHT_LANE);
    expect(gateLaneAt(sim.course, start + rules.gateWarnTicks)).toBe(LEFT_LANE);
    const switched: RaceEvent[] = [];
    while (sim.tick < start + rules.gateWarnTicks + 1) switched.push(...step(sim));
    expect(of(switched, 'gate')).toMatchObject([{ phase: 'switched', lane: LEFT_LANE }]);
    // Locked for everyone for a while after the switch.
    expect(of(press(sim, 'b', 'gate'), 'abilityDenied')).toMatchObject([{ reason: 'busy' }]);
    for (let k = 0; k < rules.gateLockTicks; k++) step(sim);
    expect(of(press(sim, 'b', 'gate'), 'ability')).toHaveLength(1);
    expect([LEFT_LANE, RIGHT_LANE]).toContain(gateLaneAt(sim.course, sim.tick + 1000));
    // Then the next car through takes the outside lane.
    const sim2 = race(['a'], 100);
    sim2.course.gateLane = LEFT_LANE;
    sim2.course.gateNextLane = LEFT_LANE;
    expect(through(sim2, sim2.racers[0], 8).lane).toBe(LEFT_LANE);
  });

  it('never moves a barrier onto a car already in the funnel or the split', () => {
    const sim = race(['a'], 100);
    const r = sim.racers[0];
    // In the funnel, in the inside lane's half, when the gate switches to the outside lane.
    launch(r, split.funnelS + 10, 6, 30);
    drive(sim, r, 2);
    expect(r.vehicle.funnelLane).toBe(RIGHT_LANE);
    sim.course.gateLane = LEFT_LANE;
    sim.course.gateNextLane = LEFT_LANE;
    let walls = 0;
    let lane = -1;
    for (let k = 0; k < 300; k++) {
      walls += of(drive(sim, r, 1), 'wallHit').length;
      if (r.vehicle.splitLane >= 0) lane = r.vehicle.splitLane;
    }
    expect(lane).toBe(RIGHT_LANE);
    expect(walls).toBe(0);
  });
});

describe('Overdrive', () => {
  it('runs for its duration, beats boost top speed, ends with an event, and never stacks', () => {
    const sim = race(['a'], 100);
    const r = sim.racers[0];
    // On the main straight, clear of its Energy cells and boost pad.
    launch(r, 30, 6, 60);
    // A boost burst first: Overdrive replaces it.
    step(sim, { a: { boost: true, throttle: 1 } });
    expect(r.vehicle.boosting).toBe(true);
    const events = step(sim, { a: { overdrive: true, throttle: 1 } });
    expect(of(events, 'ability')).toMatchObject([{ ability: 'overdrive' }]);
    expect(r.vehicle.boosting).toBe(false);
    let top = 0;
    let ticks = 0;
    const all: RaceEvent[] = [];
    while (r.vehicle.overdriveTicks > 0 && ticks < 400) {
      // Boost presses during Overdrive start nothing and cost nothing.
      const e = step(sim, { a: { throttle: 1, boost: ticks % 20 === 0 } });
      all.push(...e);
      top = Math.max(top, r.vehicle.speed);
      ticks++;
      expect(r.vehicle.boosting).toBe(false);
    }
    expect(ticks).toBe(rules.overdriveTicks - 1);
    expect(of(all, 'overdriveEnd')).toHaveLength(1);
    expect(of(all, 'boost')).toHaveLength(0);
    expect(top).toBeGreaterThan(VEHICLE_TUNING.boostMaxSpeed);
    expect(top).toBeLessThanOrEqual(VEHICLE_TUNING.overdriveMaxSpeed + 1);
    expect(r.vehicle.energy).toBe(100 - rules.boostCost - rules.overdriveCost);
    // The cooldown is still running: no second Overdrive.
    expect(of(press(sim, 'a', 'overdrive'), 'abilityDenied')).toMatchObject([
      { reason: 'cooldown' },
    ]);
    expect(rules.overdriveTicks * DT).toBeCloseTo(3, 6);
  });
});
