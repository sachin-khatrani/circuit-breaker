import type { RaceEvent } from '../sim/events';
import { copyInput, createInput, type PlayerInput } from '../sim/input';
import { RaceSimulation, type RaceOptions, type RacerState } from '../sim/race';
import type { Track } from '../track/track';
import { unpackCourse } from '../sim/course';
import { packInputFrame, unpackCells, unpackInputFrame, unpackPredictedState } from './codec';
import { angleDelta } from '../math/scalar';
import type { RaceStartInfo } from './protocol';

/** Ticks of input history kept for replays (about 4 s). */
const HISTORY = 256;

export interface Reconciliation {
  /** Server tick the snapshot described. */
  tick: number;
  /** How far (m) the corrected present moved from what had been predicted. */
  error: number;
  /** The move itself, after minus before (m, rad), for smoothing it out on screen. */
  dx: number;
  dy: number;
  dz: number;
  dyaw: number;
  /** Ticks simulated again on top of the server state. */
  replayed: number;
}

/**
 * Client-side prediction for the local car. It runs the same shared RaceSimulation the server
 * runs, but with only this player's car, and records every input it applies by tick.
 *
 * When a snapshot arrives, the car is re-based on the server's state at that tick and the
 * recorded inputs since are replayed, so the prediction always converges on the authoritative
 * result. With inputs reaching the server on time and no other car involved, the replay gives
 * exactly what was already predicted, so nothing moves.
 */
export class Predictor {
  readonly sim: RaceSimulation;
  readonly racer: RacerState;
  private readonly inputs: PlayerInput[] = Array.from({ length: HISTORY }, createInput);
  private readonly inputTicks = new Int32Array(HISTORY).fill(-1);
  private readonly lastInput = createInput();
  /** Highest tick simulated so far: events of re-simulated ticks are not reported twice. */
  private frontier: number;

  constructor(
    track: Track,
    start: Readonly<RaceStartInfo>,
    playerId: string,
    options: Partial<RaceOptions> = {},
  ) {
    this.sim = new RaceSimulation(track, {
      laps: start.laps,
      startEnergy: start.startEnergy,
      ...options,
    });
    const me = start.racers.find((r) => r.id === playerId);
    if (!me) throw new Error(`Player ${playerId} is not in race ${start.raceId}`);
    this.racer = this.sim.addRacer(me.id, me.name, me.slot);
    this.frontier = this.sim.tick;
  }

  get tick(): number {
    return this.sim.tick;
  }

  /** The input recorded for a tick, if it is still in the history. */
  inputFor(tick: number): Readonly<PlayerInput> | null {
    const slot = tick % HISTORY;
    return this.inputTicks[slot] === tick ? this.inputs[slot] : null;
  }

  /**
   * Simulates the next tick with `input` and records it. The input is first quantised exactly
   * as it travels to the server, so the prediction applies what the server will apply. Returns
   * the tick's events the first time that tick is simulated; replays of it return nothing.
   */
  step(input: Readonly<PlayerInput>): RaceEvent[] {
    const tick = this.sim.tick + 1;
    const slot = tick % HISTORY;
    const quantised = unpackInputFrame(packInputFrame(input), this.inputs[slot]);
    this.inputTicks[slot] = tick;
    copyInput(quantised, this.lastInput);
    this.sim.setInput(this.racer.id, quantised);
    this.sim.step();
    const events = this.sim.drainEvents();
    if (tick <= this.frontier) return [];
    this.frontier = tick;
    return events;
  }

  /**
   * Re-bases the car (and the track's changeable state) on the server's state after `tick`
   * and replays the recorded inputs up to the present. Returns null (and changes nothing) for
   * a malformed state.
   */
  reconcile(tick: number, state: unknown, cells: unknown, course?: unknown): Reconciliation | null {
    const now = this.sim.tick;
    const v = this.racer.vehicle;
    const beforeX = v.x;
    const beforeY = v.y;
    const beforeZ = v.z;
    const beforeYaw = v.yaw;
    if (!unpackPredictedState(state, this.racer)) return null;
    // Lap times are not in the state: drop any the replay is about to record again.
    if (this.racer.lapTimes.length > this.racer.lap) this.racer.lapTimes.length = this.racer.lap;
    unpackCells(cells, this.sim.cells);
    if (course !== undefined) unpackCourse(course, this.sim.course);
    this.sim.tick = tick;
    this.sim.phase = tick < this.sim.goTick ? 'countdown' : 'racing';
    let replayed = 0;
    for (let t = tick + 1; t <= now; t++) {
      const recorded = this.inputFor(t);
      this.sim.setInput(this.racer.id, recorded ?? this.lastInput);
      this.sim.step();
      this.sim.drainEvents();
      replayed++;
    }
    const dx = v.x - beforeX;
    const dz = v.z - beforeZ;
    return {
      tick,
      error: Math.hypot(dx, dz),
      dx,
      dy: v.y - beforeY,
      dz,
      dyaw: angleDelta(beforeYaw, v.yaw),
      replayed,
    };
  }
}
