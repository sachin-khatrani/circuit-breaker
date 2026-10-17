import { clamp } from '../math/scalar';
import type { Track } from '../track/track';
import {
  DT,
  RACE_RULES,
  TICK_RATE,
  VEHICLE_TUNING,
  type RaceRules,
  type VehicleTuning,
} from './config';
import {
  ABILITIES,
  abilityCooldown,
  abilityCost,
  createCourseState,
  gateLaneAt,
  shortcutOpenAt,
  type AbilityDenial,
  type AbilityId,
  type CourseState,
} from './course';
import type { RaceEvent, RespawnReason } from './events';
import { copyInput, createInput, sanitizeInput, type PlayerInput } from './input';
import {
  createVehicle,
  placeVehicle,
  startOverdrive,
  stepVehicle,
  type VehicleState,
} from './vehicle';

export type RacePhase = 'countdown' | 'racing' | 'finished';

/** Crossings this far outside the road edge still count (the barrier sits at the edge). */
const GATE_MARGIN = 2;
const CELL_VERTICAL_REACH = 4;
/** A pad counts when the car's centre is this close to it (part of the car's width). */
const PAD_MARGIN = 0.6;
/** Pads fire only for a car crossing them forward at least this fast (m/s). */
const PAD_MIN_SPEED = 3;
/** Below this speed (m/s) while pressing throttle or brake, a car counts as stuck. */
const STUCK_SPEED = 1.5;

export interface RacerStats {
  topSpeed: number;
  cellsCollected: number;
  cellEnergy: number;
  driftEnergy: number;
  driftTicks: number;
  boostTicks: number;
  wallHits: number;
  respawns: number;
  /** Respawns forced by leaving the road (subset of `respawns`). */
  falls: number;
  /** Boost bursts fired. */
  boosts: number;
  padsHit: number;
  /** Energy earned from speed lanes. */
  laneEnergy: number;
  /** Abilities used, by kind. */
  shortcuts: number;
  gateShifts: number;
  overdrives: number;
  /** Laps (or part laps) driven through the shortcut. */
  shortcutRuns: number;
}

export interface RacerState {
  id: string;
  name: string;
  slot: number;
  vehicle: VehicleState;
  input: PlayerInput;
  /** Completed laps. */
  lap: number;
  nextCheckpoint: number;
  /** Has crossed the start line once (that crossing starts lap 1, it does not finish a lap). */
  started: boolean;
  lapStartTime: number;
  /** Split times (since lap start) at each checkpoint of the current lap. */
  currentSplits: number[];
  bestLapSplits: number[] | null;
  lapTimes: number[];
  bestLapTime: number | null;
  finished: boolean;
  finishTime: number | null;
  /** 1-based standing, updated every tick. */
  position: number;
  /** Metres of validated race distance; used for standings. */
  progress: number;
  wrongWay: boolean;
  stats: RacerStats;
  // Internal per-tick bookkeeping.
  prevX: number;
  prevZ: number;
  resetHeld: boolean;
  wrongWayTicks: number;
  throttleSinceTick: number | null;
  /** Per boost pad: the tick from which it can fire for this racer again. */
  padReadyTick: number[];
  /** Ticks spent pressing throttle or brake without moving. */
  stuckTicks: number;
  /** Left the race for good (multiplayer disconnect): no longer simulated, ranked last, DNF. */
  retired: boolean;
  /** Ticks until each ability (in ABILITIES order) can be used again. */
  abilityCooldown: number[];
  /** Ability buttons held on the previous tick (bit per ability): a use needs a fresh press. */
  abilityHeld: number;
}

export interface CellState {
  active: boolean;
  respawnTick: number;
}

export interface RaceOptions {
  laps?: number;
  /** Energy every car starts with; defaults to `rules.startEnergy`, clamped to the bar. */
  startEnergy?: number;
  tuning?: VehicleTuning;
  rules?: RaceRules;
  /** Start racing immediately (attract mode, tests). */
  skipCountdown?: boolean;
  /** Starting state of the changeable track (default: shortcut shut, inside lane open). */
  course?: CourseState;
}

/**
 * Authoritative race state machine: countdown, launch, physics, gates, laps, finish, Energy
 * cells and standings. Deterministic and framework-free so it runs unchanged on the server.
 */
export class RaceSimulation {
  readonly track: Track;
  readonly laps: number;
  readonly tuning: VehicleTuning;
  readonly rules: RaceRules;
  readonly racers: RacerState[] = [];
  readonly cells: CellState[];
  readonly goTick: number;
  readonly startEnergy: number;
  /** The changeable track: shortcut and gate. The same for everyone in the race. */
  readonly course: CourseState;
  tick = 0;
  phase: RacePhase;
  firstFinishTick: number | null = null;
  private finishedCount = 0;
  /** Cars that crossed the finish line this tick, ranked together by sub-tick time. */
  private finishing: RacerState[] = [];
  private events: RaceEvent[] = [];

  constructor(track: Track, options: RaceOptions = {}) {
    this.track = track;
    this.laps = Math.max(1, Math.round(options.laps ?? track.defaultLaps));
    this.tuning = options.tuning ?? VEHICLE_TUNING;
    this.rules = options.rules ?? RACE_RULES;
    this.goTick = options.skipCountdown ? 0 : this.rules.countdownTicks;
    this.startEnergy = clamp(
      options.startEnergy ?? this.rules.startEnergy,
      0,
      this.rules.maxEnergy,
    );
    this.phase = this.goTick > 0 ? 'countdown' : 'racing';
    this.cells = track.cells.map(() => ({ active: true, respawnTick: 0 }));
    this.course = options.course ? { ...options.course } : createCourseState();
  }

  /** Seconds since GO (negative during the countdown). */
  get raceTime(): number {
    return (this.tick - this.goTick) * DT;
  }

  /** Seconds until GO. */
  get countdownRemaining(): number {
    return Math.max(0, (this.goTick - this.tick) * DT);
  }

  addRacer(id: string, name: string, slot = this.racers.length): RacerState {
    if (this.racers.some((r) => r.id === id)) throw new Error(`Duplicate racer id ${id}`);
    const vehicle = createVehicle();
    const grid = this.track.gridSlot(slot);
    placeVehicle(vehicle, this.track, grid.s, grid.lateral);
    vehicle.energy = this.startEnergy;
    const racer: RacerState = {
      id,
      name,
      slot,
      vehicle,
      input: createInput(),
      lap: 0,
      nextCheckpoint: 0,
      started: false,
      lapStartTime: 0,
      currentSplits: [],
      bestLapSplits: null,
      lapTimes: [],
      bestLapTime: null,
      finished: false,
      finishTime: null,
      position: this.racers.length + 1,
      progress: 0,
      wrongWay: false,
      stats: {
        topSpeed: 0,
        cellsCollected: 0,
        cellEnergy: 0,
        driftEnergy: 0,
        driftTicks: 0,
        boostTicks: 0,
        wallHits: 0,
        respawns: 0,
        falls: 0,
        boosts: 0,
        padsHit: 0,
        laneEnergy: 0,
        shortcuts: 0,
        gateShifts: 0,
        overdrives: 0,
        shortcutRuns: 0,
      },
      prevX: vehicle.x,
      prevZ: vehicle.z,
      resetHeld: false,
      wrongWayTicks: 0,
      throttleSinceTick: null,
      padReadyTick: this.track.pads.map(() => 0),
      stuckTicks: 0,
      retired: false,
      abilityCooldown: ABILITIES.map(() => 0),
      abilityHeld: 0,
    };
    this.racers.push(racer);
    this.updateStandings();
    return racer;
  }

  getRacer(id: string): RacerState | undefined {
    return this.racers.find((r) => r.id === id);
  }

  /** Inputs are clamped here, so a hostile or buggy caller cannot exceed the envelope. */
  setInput(id: string, input: Readonly<PlayerInput>): void {
    const racer = this.getRacer(id);
    if (racer) copyInput(sanitizeInput(input, scratchInput), racer.input);
  }

  /** Returns and clears the events produced since the last drain. */
  drainEvents(): RaceEvent[] {
    const events = this.events;
    this.events = [];
    return events;
  }

  step(): void {
    this.tick++;
    if (this.phase === 'countdown') {
      this.stepCountdown();
      // Cars start moving on the tick after GO, so race time 0 is the first moving instant.
      return;
    }
    this.updateCourse();
    for (const racer of this.racers) if (!racer.retired) this.stepRacer(racer);
    this.rankFinishers();
    this.updateCells();
    this.updateStandings();
    this.checkRaceEnd();
  }

  /**
   * Takes a racer out of the race for good (a multiplayer player who left): the car stops, is
   * no longer simulated, and ranks behind everyone still racing. It never finishes (DNF).
   */
  retire(id: string): void {
    const r = this.getRacer(id);
    if (!r || r.finished || r.retired) return;
    r.retired = true;
    const v = r.vehicle;
    v.vx = 0;
    v.vy = 0;
    v.vz = 0;
    v.yawRate = 0;
    v.speed = 0;
    v.forwardSpeed = 0;
    v.lateralSpeed = 0;
    v.boosting = false;
    v.boostLeft = 0;
    v.drifting = false;
    v.padTicks = 0;
    v.impulseTicks = 0;
    v.overdriveTicks = 0;
    this.events.push({ type: 'retired', tick: this.tick, racerId: r.id });
    this.updateStandings();
    this.checkRaceEnd();
  }

  /**
   * Finish positions are handed out after every car has moved, in order of the sub-tick
   * crossing time, so two cars finishing within the same tick are still ranked fairly.
   */
  private rankFinishers(): void {
    if (this.finishing.length === 0) return;
    // Exactly equal crossing times go to the lower grid slot (see session/results.ts).
    this.finishing.sort((a, b) => (a.finishTime ?? 0) - (b.finishTime ?? 0) || a.slot - b.slot);
    for (const r of this.finishing) {
      this.finishedCount++;
      r.position = this.finishedCount;
      this.events.push({
        type: 'finish',
        tick: this.tick,
        racerId: r.id,
        position: r.position,
        totalTime: r.finishTime ?? 0,
      });
    }
    this.finishing = [];
  }

  private stepCountdown(): void {
    const remaining = this.goTick - this.tick;
    if (remaining === 3 * TICK_RATE || remaining === 2 * TICK_RATE || remaining === TICK_RATE) {
      this.events.push({
        type: 'countdown',
        tick: this.tick,
        count: (remaining / TICK_RATE) as 3 | 2 | 1,
      });
    }
    for (const racer of this.racers) {
      if (racer.input.throttle > 0.5) racer.throttleSinceTick ??= this.tick;
      else racer.throttleSinceTick = null;
      // Ability buttons pressed during the countdown are spent: nothing fires at GO.
      racer.abilityHeld = abilityBits(racer.input);
    }
    if (remaining > 0) return;

    this.phase = 'racing';
    this.events.push({ type: 'go', tick: this.tick });
    for (const racer of this.racers) {
      const pressedAt = racer.throttleSinceTick;
      // Only a press inside the final window earns the launch; holding from earlier does not.
      if (pressedAt !== null && this.tick - pressedAt <= this.rules.launchWindowTicks) {
        racer.vehicle.impulseTicks = this.rules.launchImpulseTicks;
        this.events.push({ type: 'launchBoost', tick: this.tick, racerId: racer.id });
      }
      racer.throttleSinceTick = null;
    }
  }

  private stepRacer(r: RacerState): void {
    const v = r.vehicle;
    r.prevX = v.x;
    r.prevZ = v.z;

    const resetPressed = r.input.reset && !r.resetHeld;
    r.resetHeld = r.input.reset;
    if (resetPressed && v.frozenTicks === 0) this.respawn(r, 'manual');

    // Abilities: a fresh press of each button, checked and paid before the car moves.
    for (let k = 0; k < r.abilityCooldown.length; k++) {
      if (r.abilityCooldown[k] > 0) r.abilityCooldown[k]--;
    }
    const held = abilityBits(r.input);
    const pressed = held & ~r.abilityHeld;
    r.abilityHeld = held;
    if (pressed) {
      ABILITIES.forEach((id, k) => {
        if (pressed & (1 << k)) this.useAbility(r, id);
      });
    }

    const roadBefore = v.road;
    const res = stepVehicle(
      v,
      r.input,
      this.track,
      this.tuning,
      this.rules,
      this.course,
      this.tick,
    );
    if (res.changedRoad && roadBefore === 0 && v.road !== 0) r.stats.shortcutRuns++;
    if (res.overdriveEnded) {
      this.events.push({ type: 'overdriveEnd', tick: this.tick, racerId: r.id });
    }
    if (res.laneChargeId >= 0 && res.laneEnergy > 0) {
      r.stats.laneEnergy += res.laneEnergy;
      this.events.push({
        type: 'laneCharge',
        tick: this.tick,
        racerId: r.id,
        laneId: res.laneChargeId,
        gained: res.laneEnergy,
        energy: v.energy,
      });
    }
    if (res.wallImpact > 0) {
      r.stats.wallHits++;
      this.events.push({
        type: 'wallHit',
        tick: this.tick,
        racerId: r.id,
        impact: res.wallImpact,
        x: v.x,
        y: v.y,
        z: v.z,
      });
    }
    if (res.driftStarted) this.events.push({ type: 'driftStart', tick: this.tick, racerId: r.id });
    if (res.driftEnded) {
      this.events.push({ type: 'driftEnd', tick: this.tick, racerId: r.id, tier: res.miniTurbo });
    }
    if (res.driftReward > 0) {
      this.events.push({
        type: 'driftReward',
        tick: this.tick,
        racerId: r.id,
        energy: res.driftReward,
      });
    }
    if (res.boostStarted) {
      r.stats.boosts++;
      this.events.push({ type: 'boost', tick: this.tick, racerId: r.id, energy: v.energy });
    }
    if (res.boostDenied) this.events.push({ type: 'boostDenied', tick: this.tick, racerId: r.id });
    r.stats.driftEnergy += res.driftEnergy;
    // Off the road for long enough (flying off a raised edge, or stuck on the ground below):
    // put the car back where it last was safely on the road.
    if (v.surface !== 'road') {
      const grace =
        v.surface === 'air' ? this.rules.airRespawnTicks : this.rules.groundRespawnTicks;
      if (v.offTrackTicks >= grace) {
        this.respawn(r, 'offTrack');
        return;
      }
    }
    // Pressing throttle or brake without moving (wedged against something): put it back.
    const pushing = r.input.throttle > 0.3 || r.input.brake > 0.3;
    const still = v.surface === 'road' && v.frozenTicks === 0 && v.speed < STUCK_SPEED;
    r.stuckTicks = pushing && still && !r.finished ? r.stuckTicks + 1 : 0;
    if (r.stuckTicks >= this.rules.stuckRespawnTicks) {
      this.respawn(r, 'stuck');
      return;
    }
    r.stats.topSpeed = Math.max(r.stats.topSpeed, v.speed);
    if (v.drifting) r.stats.driftTicks++;
    if (v.boosting) r.stats.boostTicks++;

    if (v.surface === 'road' && v.frozenTicks === 0) this.checkPad(r);
    if (!r.finished) this.checkGate(r);

    // Wrong way: travelling backwards along the track while facing backwards.
    const travelAlong = v.vx * v.trackFx + v.vz * v.trackFz;
    const facing = Math.sin(v.yaw) * v.trackFx + Math.cos(v.yaw) * v.trackFz;
    r.wrongWayTicks = travelAlong < -3 && facing < -0.2 ? r.wrongWayTicks + 1 : 0;
    r.wrongWay = r.wrongWayTicks >= this.rules.wrongWayTicks;
  }

  /**
   * Boost pads fire for a car crossing them forward; each pad then stays inert for that car
   * for a while, so sitting on it or crossing it again and again gives nothing.
   */
  private checkPad(r: RacerState): void {
    const v = r.vehicle;
    if (v.road !== 0) return;
    const pad = this.track.padAt(v.trackIndex, v.trackS, v.lateral, PAD_MARGIN);
    if (pad < 0 || this.tick < r.padReadyTick[pad]) return;
    if (v.vx * v.trackFx + v.vz * v.trackFz < PAD_MIN_SPEED) return;
    v.padTicks = this.rules.padBoostTicks;
    r.padReadyTick[pad] = this.tick + this.rules.padCooldownTicks;
    r.stats.padsHit++;
    this.events.push({ type: 'boostPad', tick: this.tick, racerId: r.id, padId: pad });
  }

  private checkGate(r: RacerState): void {
    const gate = this.track.checkpoints[r.nextCheckpoint];
    const v = r.vehicle;
    const d0 = (r.prevX - gate.x) * gate.fx + (r.prevZ - gate.z) * gate.fz;
    const d1 = (v.x - gate.x) * gate.fx + (v.z - gate.z) * gate.fz;
    if (!(d0 < 0 && d1 >= 0)) return;
    const t = d0 / (d0 - d1);
    const cx = r.prevX + (v.x - r.prevX) * t;
    const cz = r.prevZ + (v.z - r.prevZ) * t;
    const lateral = (cx - gate.x) * gate.rx + (cz - gate.z) * gate.rz;
    if (Math.abs(lateral) > gate.halfWidth + GATE_MARGIN) return;
    this.passCheckpoint(r, gate.index, (this.tick - 1 + t - this.goTick) * DT);
  }

  private passCheckpoint(r: RacerState, index: number, time: number): void {
    const count = this.track.checkpoints.length;
    if (index !== 0) {
      const split = time - r.lapStartTime;
      r.currentSplits[index] = split;
      this.events.push({
        type: 'checkpoint',
        tick: this.tick,
        racerId: r.id,
        checkpoint: index,
        lap: r.lap + 1,
        split,
        bestSplit: r.bestLapSplits?.[index] ?? null,
      });
      r.nextCheckpoint = (index + 1) % count;
      return;
    }
    if (!r.started) {
      // Grid → start line. Lap 1 is timed from GO, like the race clock.
      r.started = true;
      r.nextCheckpoint = 1;
      this.newLap(r);
      return;
    }

    const lapTime = time - r.lapStartTime;
    const improved = r.bestLapTime !== null && lapTime < r.bestLapTime;
    if (r.bestLapTime === null || lapTime < r.bestLapTime) {
      r.bestLapTime = lapTime;
      r.bestLapSplits = r.currentSplits.slice();
    }
    r.lap++;
    r.lapTimes.push(lapTime);
    r.lapStartTime = time;
    r.currentSplits = [];
    this.newLap(r);
    this.events.push({
      type: 'lap',
      tick: this.tick,
      racerId: r.id,
      lap: r.lap,
      lapTime,
      improved,
    });

    if (r.lap >= this.laps) {
      r.finished = true;
      r.finishTime = time;
      this.firstFinishTick ??= this.tick;
      // The position is assigned once every car has moved this tick (rankFinishers).
      this.finishing.push(r);
    } else {
      r.nextCheckpoint = 1;
    }
  }

  /** Per-lap Energy limits start again. */
  private newLap(r: RacerState): void {
    r.vehicle.laneCharged = 0;
    r.vehicle.driftLapEnergy = 0;
  }

  /**
   * The track's scheduled changes, applied at the start of their tick so every car of the
   * tick sees the same track: the shortcut opening, its closing warning and closing, and a
   * gate switch. Each is announced with an event.
   */
  private updateCourse(): void {
    const c = this.course;
    const tick = this.tick;
    if (c.shortcutOpenTick >= 0) {
      const base = { openTick: c.shortcutOpenTick, closeTick: c.shortcutCloseTick };
      if (tick === c.shortcutOpenTick) {
        this.events.push({ type: 'shortcut', tick, phase: 'open', ...base });
      }
      if (tick === c.shortcutCloseTick - this.rules.shortcutWarnTicks) {
        this.events.push({ type: 'shortcut', tick, phase: 'closing', ...base });
      }
      if (tick >= c.shortcutCloseTick) {
        this.events.push({ type: 'shortcut', tick, phase: 'closed', ...base });
        c.shortcutOpenTick = -1;
        c.shortcutCloseTick = -1;
        c.shortcutReadyTick = tick + this.rules.shortcutLockTicks;
      }
    }
    if (c.gateSwitchTick >= 0 && tick >= c.gateSwitchTick) {
      c.gateLane = c.gateNextLane;
      this.events.push({
        type: 'gate',
        tick,
        phase: 'switched',
        lane: c.gateLane,
        switchTick: c.gateSwitchTick,
      });
      c.gateSwitchTick = -1;
      c.gateReadyTick = tick + this.rules.gateLockTicks;
    }
  }

  /**
   * One ability press. Everything is checked first and the Energy is taken in the same step
   * as the effect, so a press either works and pays, or does nothing and costs nothing. Racers
   * are processed in a fixed order each tick, so two presses in one tick resolve the same way
   * on every machine: the first one that is valid wins, the next finds the track busy.
   */
  private useAbility(r: RacerState, id: AbilityId): void {
    const v = r.vehicle;
    const c = this.course;
    const tick = this.tick;
    const rules = this.rules;
    const k = ABILITIES.indexOf(id);
    const deny = (reason: AbilityDenial) => {
      this.events.push({ type: 'abilityDenied', tick, racerId: r.id, ability: id, reason });
    };
    if (this.phase !== 'racing' || r.finished || r.retired) return deny('phase');
    if (r.abilityCooldown[k] > 0) return deny('cooldown');
    if (id === 'shortcut') {
      if (this.track.branches.length === 0) return deny('unavailable');
      if (c.shortcutOpenTick >= 0 || tick < c.shortcutReadyTick) return deny('busy');
    } else if (id === 'gate') {
      if (this.track.splits.length === 0) return deny('unavailable');
      if (c.gateSwitchTick >= 0 || tick < c.gateReadyTick) return deny('busy');
    } else if (v.surface !== 'road' || v.frozenTicks > 0 || v.overdriveTicks > 0) {
      return deny('busy');
    }
    const cost = abilityCost(rules, id);
    if (v.energy < cost) return deny('energy');

    v.energy = Math.max(rules.minEnergy, v.energy - cost);
    r.abilityCooldown[k] = abilityCooldown(rules, id);
    this.events.push({ type: 'ability', tick, racerId: r.id, ability: id, energy: v.energy });
    if (id === 'shortcut') {
      r.stats.shortcuts++;
      c.shortcutOpenTick = tick + rules.shortcutOpenDelayTicks;
      c.shortcutCloseTick = c.shortcutOpenTick + rules.shortcutOpenTicks;
      this.events.push({
        type: 'shortcut',
        tick,
        phase: 'opening',
        openTick: c.shortcutOpenTick,
        closeTick: c.shortcutCloseTick,
      });
    } else if (id === 'gate') {
      r.stats.gateShifts++;
      c.gateNextLane = 1 - c.gateLane;
      c.gateSwitchTick = tick + rules.gateWarnTicks;
      this.events.push({
        type: 'gate',
        tick,
        phase: 'warning',
        lane: c.gateNextLane,
        switchTick: c.gateSwitchTick,
      });
    } else {
      r.stats.overdrives++;
      startOverdrive(v, rules);
    }
  }

  /** Is the shortcut open, and which split lane is open, right now. */
  get shortcutOpen(): boolean {
    return shortcutOpenAt(this.course, this.tick);
  }

  get gateLane(): number {
    return gateLaneAt(this.course, this.tick);
  }

  /** Back on the centre line at the last safe point, facing forward, briefly frozen. */
  respawn(r: RacerState, reason: RespawnReason = 'manual'): void {
    const v = r.vehicle;
    placeVehicle(v, this.track, v.safeS, 0, v.safeRoad);
    v.frozenTicks = this.rules.respawnFreezeTicks;
    r.prevX = v.x;
    r.prevZ = v.z;
    r.wrongWayTicks = 0;
    r.wrongWay = false;
    r.stuckTicks = 0;
    r.stats.respawns++;
    if (reason === 'offTrack') r.stats.falls++;
    this.events.push({ type: 'respawn', tick: this.tick, racerId: r.id, reason });
  }

  private updateCells(): void {
    const reach2 = this.rules.cellPickupRadius * this.rules.cellPickupRadius;
    for (let i = 0; i < this.cells.length; i++) {
      const cell = this.cells[i];
      if (!cell.active) {
        if (this.tick >= cell.respawnTick) cell.active = true;
        continue;
      }
      const place = this.track.cells[i];
      for (const r of this.racers) {
        const v = r.vehicle;
        if (r.finished || r.retired || v.frozenTicks > 0) continue;
        const dx = v.x - place.x;
        const dz = v.z - place.z;
        if (dx * dx + dz * dz > reach2 || Math.abs(v.y - place.y) > CELL_VERTICAL_REACH) continue;
        const gained = Math.min(this.rules.cellEnergy, this.rules.maxEnergy - v.energy);
        v.energy += gained;
        r.stats.cellsCollected++;
        r.stats.cellEnergy += gained;
        cell.active = false;
        cell.respawnTick = this.tick + this.rules.cellRespawnTicks;
        this.events.push({
          type: 'cell',
          tick: this.tick,
          racerId: r.id,
          cellId: i,
          energy: v.energy,
          gained,
        });
        break;
      }
    }
  }

  /**
   * Validated distance: never beyond the next unpassed checkpoint, so cutting cannot help. On
   * the shortcut, a car is worth its matching place on the stretch the shortcut bypasses.
   */
  private computeProgress(r: RacerState): number {
    const track = this.track;
    const v = r.vehicle;
    const s = track.mainS(v.road, v.trackS);
    if (!r.started) return -track.distanceAhead(s, 0);
    const gates = track.checkpoints;
    const prev = gates[(r.nextCheckpoint - 1 + gates.length) % gates.length];
    const next = gates[r.nextCheckpoint];
    const segment = track.distanceAhead(prev.s, next.s) || track.length;
    let d = track.distanceAhead(prev.s, s);
    // Slightly behind the previous gate wraps to almost a full lap; treat it as zero.
    if (d > segment + (track.length - segment) / 2) d = 0;
    else d = Math.min(d, segment);
    return r.lap * track.length + prev.s + d;
  }

  private updateStandings(): void {
    for (const r of this.racers) r.progress = r.finished ? Infinity : this.computeProgress(r);
    // Finishers first (in finishing order), then cars still racing by distance, then retired.
    const group = (r: RacerState) => (r.finished ? 0 : r.retired ? 2 : 1);
    const order = [...this.racers].sort((a, b) => {
      if (group(a) !== group(b)) return group(a) - group(b);
      if (a.finished) return a.position - b.position;
      return b.progress - a.progress || a.slot - b.slot;
    });
    order.forEach((r, i) => {
      if (!r.finished) r.position = i + 1;
    });
  }

  private checkRaceEnd(): void {
    if (this.phase === 'finished' || this.racers.length === 0) return;
    const allDone = this.racers.every((r) => r.finished || r.retired);
    // During the countdown only a field that has entirely left ends the race.
    if (this.phase === 'countdown' && !allDone) return;
    const graceOver =
      this.firstFinishTick !== null &&
      this.tick - this.firstFinishTick >= this.rules.finishGraceTicks;
    if (allDone || graceOver) {
      this.phase = 'finished';
      this.events.push({ type: 'raceFinished', tick: this.tick });
    }
  }
}

const scratchInput = createInput();

/** Ability buttons of an input as bits, in ABILITIES order. */
function abilityBits(input: Readonly<PlayerInput>): number {
  return (input.shortcut ? 1 : 0) | (input.gate ? 2 : 0) | (input.overdrive ? 4 : 0);
}
