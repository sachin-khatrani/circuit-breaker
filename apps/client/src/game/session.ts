import {
  angleDelta,
  autopilotInput,
  copyInput,
  copyVehicle,
  createInput,
  createVehicle,
  DT,
  GRID_ZERO,
  lerp,
  lerpAngle,
  RaceSimulation,
  Track,
  type EventsMessage,
  type PlayerInput,
  type RaceEvent,
  type RacerState,
  type RaceStartInfo,
  type SnapshotMessage,
  type VehicleState,
  type VehicleSurface,
  placeVehicle,
} from '@circuit-breaker/shared';
import { net } from '../net/connection';
import { RACE_CONFIG } from './config';
import { inputManager } from './input';
import { OnlineRace, type RemoteCar } from './online';
import { loadRecord, saveRecord } from './records';
import { loadVehicle } from './settings';
import { useGameStore, type CountdownValue, type RaceResults } from './store';

export type SessionMode = 'attract' | 'race' | 'online';

/** Development aid: a fixed camera (e.g. straight down over the track to check the map). */
export interface DebugView {
  x: number;
  y: number;
  z: number;
  lookX: number;
  lookY: number;
  lookZ: number;
  fov: number;
  /** Optional fog density while the view is active (thin fog for overhead shots). */
  fog?: number;
}
export type CameraMode = 'attract' | 'intro' | 'chase' | 'finish';

/** Interpolated state of the local car for rendering, refreshed every rendered frame. */
export interface RenderCar {
  x: number;
  y: number;
  z: number;
  yaw: number;
  vx: number;
  vy: number;
  vz: number;
  speed: number;
  forwardSpeed: number;
  lateralSpeed: number;
  yawRate: number;
  slope: number;
  bank: number;
  trackFx: number;
  trackFz: number;
  trackS: number;
  energy: number;
  boosting: boolean;
  /** Ticks left in the current boost burst, and until another burst may start. */
  boostLeft: number;
  boostCooldown: number;
  /** A boost-pad impulse is running. */
  padBoost: boolean;
  /** The car is inside a speed lane. */
  inLane: boolean;
  /** Overdrive is running, and its ticks left. */
  overdrive: boolean;
  overdriveLeft: number;
  /** Road the car is on (0 main loop, 1+ shortcut). */
  road: number;
  drifting: boolean;
  driftDir: number;
  driftTicks: number;
  impulse: boolean;
  frozen: boolean;
  surface: VehicleSurface;
  throttle: number;
  brake: number;
  steer: number;
}

const SOLO_ID = 'player';

const MAX_STEPS_PER_FRAME = 6;
/** Online, the prediction may run this many ticks in one frame to catch up. */
const MAX_ONLINE_STEPS = 12;
const RESULTS_DELAY = 2.6;
const GO_BANNER_TICKS = 60;
const ATTRACT_STUCK_SECONDS = 2;
/** Prediction corrections fade out with this time constant (s); bigger ones snap. */
const CORRECTION_TAU = 0.12;
const SNAP_DISTANCE = 6;
/** Standings go to the store this often (s): the list does not need 60 updates a second. */
const STANDINGS_INTERVAL = 0.25;

type Listener = (event: RaceEvent) => void;

const NO_INPUT: Readonly<PlayerInput> = createInput();
/** Solo, the race feed reports these local events (online, the server's copies are used). */
const FEED_TYPES = new Set<RaceEvent['type']>(['ability', 'abilityDenied', 'shortcut', 'gate']);

/**
 * The game loop's session. Solo, it runs the shared RaceSimulation on a fixed 60 Hz tick.
 * Online, it predicts the local car with the same simulation on the server's timeline and
 * draws everyone else from server snapshots. Either way the scene and HUD read the same
 * surface: `render`, `remotes`, `racer`, the events, and the store.
 */
export class GameSession {
  readonly track = new Track(GRID_ZERO);
  readonly laps = RACE_CONFIG.laps;
  sim: RaceSimulation;
  mode: SessionMode = 'attract';
  /** The current online race, if any. */
  online: OnlineRace | null = null;
  paused = false;
  /** Seconds of unpaused time since the session was created; drives UI timing. */
  clock = 0;
  /** Fraction of the next tick already elapsed, for interpolation. */
  alpha = 0;
  readonly render: RenderCar;
  /** Development aid: when set, the camera rig shows this fixed view instead. */
  debugView: DebugView | null = null;
  /** Colour index of the local car (cyan in solo races). */
  localColor = 0;

  private localId = SOLO_ID;
  private accumulator = 0;
  private readonly prev: VehicleState = createVehicle();
  private readonly curr: VehicleState = createVehicle();
  private readonly autopilot = createInput();
  private readonly applied = createInput();
  /** Scratch input for a tick the server has already played (see onlineStep). */
  private readonly staleInput = createInput();
  private readonly listeners = new Set<Listener>();
  private readonly remoteListeners = new Set<Listener>();
  private readonly feedListeners = new Set<Listener>();
  /** What is left of a prediction correction to fade out on screen (m, rad). */
  private readonly offset = { x: 0, y: 0, z: 0, yaw: 0 };
  private resultsAt: number | null = null;
  /** Session clock when the server confirmed the local car's finish (online). */
  private finishedAt: number | null = null;
  private stuckTime = 0;
  private standingsAt = 0;

  constructor() {
    this.sim = this.createAttractSim();
    this.render = {
      x: 0,
      y: 0,
      z: 0,
      yaw: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      speed: 0,
      forwardSpeed: 0,
      lateralSpeed: 0,
      yawRate: 0,
      slope: 0,
      bank: 0,
      trackFx: 0,
      trackFz: 1,
      trackS: 0,
      energy: 0,
      boosting: false,
      boostLeft: 0,
      boostCooldown: 0,
      padBoost: false,
      inLane: false,
      overdrive: false,
      overdriveLeft: 0,
      road: 0,
      drifting: false,
      driftDir: 0,
      driftTicks: 0,
      impulse: false,
      frozen: false,
      surface: 'road',
      throttle: 0,
      brake: 0,
      steer: 0,
    };
    this.snapToSim();
    useGameStore.setState({ record: loadRecord(this.track.id, this.laps), totalLaps: this.laps });
  }

  /** Racer id of the local player. */
  get playerId(): string {
    return this.localId;
  }

  get racer(): RacerState {
    const racer = this.sim.getRacer(this.localId);
    if (!racer) throw new Error('Session has no player racer');
    return racer;
  }

  /** Other players' cars (online), interpolated for this frame. */
  get remotes(): readonly RemoteCar[] {
    return this.online?.remotes ?? [];
  }

  get racing(): boolean {
    return this.mode === 'race' || this.mode === 'online';
  }

  /** A race is on screen and still running (an ended online race stands still). */
  get live(): boolean {
    return this.racing && !this.online?.ended;
  }

  get cameraMode(): CameraMode {
    if (this.mode === 'attract') return 'attract';
    if (this.racer.finished) return 'finish';
    return this.sim.phase === 'countdown' ? 'intro' : 'chase';
  }

  /** Race clock in seconds, smooth between ticks (negative before GO, frozen at the finish). */
  get raceTime(): number {
    const r = this.racer;
    if (this.racing && r.finishTime !== null) return r.finishTime;
    return (this.sim.tick + this.alpha - this.sim.goTick) * DT;
  }

  /** Current lap time in seconds. */
  get lapTime(): number {
    const r = this.racer;
    if (r.finished) return r.lapTimes.at(-1) ?? 0;
    return Math.max(0, this.raceTime - r.lapStartTime);
  }

  /** Number of event subscribers (for leak checks in development). */
  get listenerCount(): number {
    return this.listeners.size + this.remoteListeners.size + this.feedListeners.size;
  }

  /** Events about the local car and the race as a whole. */
  onEvent(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Online: server events about other players' cars (boosts, pads, finishes…). */
  onRemoteEvent(listener: Listener): () => void {
    this.remoteListeners.add(listener);
    return () => this.remoteListeners.delete(listener);
  }

  /**
   * Announcements for the race feed: abilities used (by anyone) and the track changing. Online
   * they are the server's events only; solo, the local race's.
   */
  onFeed(listener: Listener): () => void {
    this.feedListeners.add(listener);
    return () => this.feedListeners.delete(listener);
  }

  startRace(): void {
    this.leaveOnline();
    this.mode = 'race';
    this.localId = SOLO_ID;
    // Solo races use the car this player last picked.
    const car = loadVehicle();
    this.localColor = car.color;
    this.sim = new RaceSimulation(this.track, {
      laps: this.laps,
      startEnergy: RACE_CONFIG.startEnergy,
    });
    this.sim.addRacer(SOLO_ID, 'You', 0);
    this.resetLoop();
    useGameStore.setState((s) => ({
      raceSerial: s.raceSerial + 1,
      carColor: car.color,
      carStyle: car.style,
      screen: 'race',
      raceKind: 'solo',
      overlay: 'none',
      results: null,
      totalLaps: this.laps,
      record: loadRecord(this.track.id, this.laps),
    }));
    this.publish();
  }

  /** Starts (or rejoins) an online race the server announced, driving this player's car. */
  startOnline(info: RaceStartInfo, playerId: string): void {
    this.leaveOnline();
    this.online = new OnlineRace(
      this.track,
      info,
      playerId,
      net,
      (event) => {
        if (event.type === 'finish' && event.racerId === playerId) this.finishedAt = this.clock;
        this.emit(event);
      },
      (event) => this.emitRemote(event),
      (event) => this.emitFeed(event),
    );
    this.mode = 'online';
    this.localId = playerId;
    const me = info.racers.find((r) => r.id === playerId);
    this.localColor = me?.color ?? 0;
    this.sim = this.online.predictor.sim;
    this.resetLoop();
    useGameStore.setState((s) => ({
      raceSerial: s.raceSerial + 1,
      carColor: this.localColor,
      carStyle: me?.style ?? 0,
      screen: 'race',
      raceKind: 'online',
      overlay: 'none',
      results: null,
      totalLaps: info.laps,
      bestLap: null,
    }));
    this.publish();
  }

  /**
   * The server's results are in: the race stops where it is, and the results open once the
   * finish has had its moment on screen.
   */
  showOnlineResults(): void {
    if (!this.online || this.mode !== 'online') return;
    this.online.ended = true;
    const shown = this.finishedAt === null ? 0 : this.finishedAt + RESULTS_DELAY;
    this.resultsAt = Math.max(this.clock + 0.6, shown);
  }

  receiveSnapshot(snapshot: SnapshotMessage): void {
    this.online?.receiveSnapshot(snapshot);
  }

  receiveEvents(message: EventsMessage): void {
    if (this.online && message.t >= 0) this.online.receiveEvents(message);
  }

  startAttract(screen: 'menu' | 'lobby' = 'menu'): void {
    this.leaveOnline();
    this.mode = 'attract';
    this.localId = SOLO_ID;
    // The attract car is the player's own pick (in a lobby, multiplayer sets the seat's).
    const car = loadVehicle();
    this.localColor = car.color;
    this.sim = this.createAttractSim();
    this.resetLoop();
    useGameStore.setState((s) => ({
      raceSerial: s.raceSerial + 1,
      carColor: car.color,
      carStyle: car.style,
      screen,
      raceKind: 'solo',
      overlay: 'none',
      menuSince: performance.now(),
      results: null,
      totalLaps: this.laps,
      record: loadRecord(this.track.id, this.laps),
    }));
    this.publish();
  }

  /** Development aid: drop the car at (s, lateral) on the track, at rest. */
  debugTeleport(s: number, lateral = 0): void {
    placeVehicle(this.racer.vehicle, this.track, s, lateral);
    this.snapToSim();
  }

  setPaused(paused: boolean): void {
    // An online race runs on the server's clock: it cannot pause.
    this.paused = paused && this.mode !== 'online';
  }

  /** Called once per rendered frame with the frame delta in seconds. */
  update(frameDt: number): void {
    inputManager.update(Math.min(frameDt, 0.1));
    if (this.paused) {
      // Keys tapped in a menu must not leak into the race when it resumes.
      inputManager.consumeTaps();
      inputManager.dropAbilityPresses();
      return;
    }
    const dt = Math.min(frameDt, 0.1);
    this.clock += dt;
    if (this.mode === 'online' && this.online) {
      this.updateOnline(this.online, dt);
    } else {
      this.accumulator += dt;
      let steps = 0;
      while (this.accumulator >= DT && steps < MAX_STEPS_PER_FRAME) {
        this.fixedStep();
        this.accumulator -= DT;
        steps++;
      }
      // After a long stall, drop the backlog rather than fast-forwarding the race.
      if (steps === MAX_STEPS_PER_FRAME) this.accumulator = 0;
      this.alpha = this.accumulator / DT;
      this.interpolate();
    }
    this.publish();
    if (this.resultsAt !== null && this.clock >= this.resultsAt) {
      this.resultsAt = null;
      useGameStore.setState({ overlay: 'results' });
    }
  }

  private updateOnline(online: OnlineRace, dt: number): void {
    net.clock.update(dt * 1000);
    const now = performance.now();
    if (online.ended) {
      // Frozen at the final moment; other cars glide into their last reported place and the
      // standings take the final snapshot.
      online.applySnapshots();
      online.updateRemotes(now);
      return;
    }
    // 1. Snapshots: re-base the prediction. The car stays where it was drawn and the
    //    correction fades out, unless it is too big to hide.
    const rec = online.applySnapshots();
    if (rec) {
      const v = this.racer.vehicle;
      if (rec.error > SNAP_DISTANCE) {
        this.offset.x = this.offset.y = this.offset.z = this.offset.yaw = 0;
        copyVehicle(v, this.prev);
      } else {
        this.offset.x -= rec.dx;
        this.offset.y -= rec.dy;
        this.offset.z -= rec.dz;
        this.offset.yaw -= rec.dyaw;
        // Shift the previous frame by the same amount, so the interpolation stays continuous.
        this.prev.x += rec.dx;
        this.prev.y += rec.dy;
        this.prev.z += rec.dz;
        this.prev.yaw += rec.dyaw;
      }
      copyVehicle(v, this.curr);
    }
    // 2. Predict up to the server's tick plus the input lead.
    const target = online.targetTick(now);
    const targetTick = Math.floor(target);
    if (online.canPredict(target)) {
      // After a stall, the first ticks run here are ones the server has already played: input
      // for them arrives too late to count, so presses wait for the first tick still ahead.
      const played = online.serverTick(now);
      let steps = 0;
      while (online.predictor.tick < targetTick && steps < MAX_ONLINE_STEPS) {
        this.onlineStep(online, online.predictor.tick + 1 <= played);
        steps++;
      }
    }
    this.alpha = online.predictor.tick >= targetTick ? Math.min(1, target - targetTick) : 1;
    // 3. Draw: interpolated local car plus the fading correction; remote cars from history.
    this.interpolate();
    const fade = Math.exp(-dt / CORRECTION_TAU);
    this.offset.x *= fade;
    this.offset.y *= fade;
    this.offset.z *= fade;
    this.offset.yaw *= fade;
    this.render.x += this.offset.x;
    this.render.y += this.offset.y;
    this.render.z += this.offset.z;
    this.render.yaw += this.offset.yaw;
    online.updateRemotes(now);
  }

  private onlineStep(online: OnlineRace, stale = false): void {
    const racer = this.racer;
    copyVehicle(racer.vehicle, this.prev);
    let input: PlayerInput;
    if (racer.finished) {
      input = autopilotInput(
        this.track,
        racer.vehicle,
        { pace: 0.75, racingLine: true, course: this.sim.course, tick: this.sim.tick },
        this.autopilot,
      );
    } else if (useGameStore.getState().overlay !== 'none') {
      // The race menu is open: the race goes on, but the car rolls with no one at the wheel.
      input = NO_INPUT;
      inputManager.dropAbilityPresses();
    } else if (RACE_CONFIG.autopilot) {
      // Development aid: the autopilot also takes the shortcut whenever it is open.
      input = autopilotInput(
        this.track,
        racer.vehicle,
        {
          boost: RACE_CONFIG.autopilotBoost,
          racingLine: true,
          course: this.sim.course,
          tick: this.sim.tick,
          shortcut: true,
        },
        this.autopilot,
      );
      // The player can still fire abilities while the autopilot drives.
      const human = inputManager.current;
      input.shortcut = human.shortcut;
      input.gate = human.gate;
      input.overdrive = human.overdrive;
      if (this.sim.phase === 'countdown') {
        input.throttle = this.sim.goTick - this.sim.tick < 15 ? 1 : 0;
      }
    } else {
      input = inputManager.current;
    }
    if (stale && (input.shortcut || input.gate || input.overdrive)) {
      input = copyInput(input, this.staleInput);
      input.shortcut = input.gate = input.overdrive = false;
    }
    const pressed =
      (input.shortcut && !this.applied.shortcut) ||
      (input.gate && !this.applied.gate) ||
      (input.overdrive && !this.applied.overdrive);
    copyInput(input, this.applied);
    const events = online.predictor.step(input);
    if (!stale) inputManager.consumeTaps();
    online.sendInputs(pressed);
    let teleported = false;
    for (const event of events) if (event.type === 'respawn') teleported = true;
    online.forwardPredicted(events);
    copyVehicle(racer.vehicle, this.curr);
    if (teleported) copyVehicle(this.curr, this.prev);
  }

  private emit(event: RaceEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private emitRemote(event: RaceEvent): void {
    for (const listener of this.remoteListeners) listener(event);
  }

  private emitFeed(event: RaceEvent): void {
    for (const listener of this.feedListeners) listener(event);
  }

  private leaveOnline(): void {
    this.online = null;
    this.finishedAt = null;
    this.offset.x = this.offset.y = this.offset.z = this.offset.yaw = 0;
  }

  private createAttractSim(): RaceSimulation {
    const sim = new RaceSimulation(this.track, { laps: 999, skipCountdown: true });
    sim.addRacer(SOLO_ID, 'Demo', 0);
    return sim;
  }

  private resetLoop(): void {
    this.accumulator = 0;
    this.alpha = 0;
    this.resultsAt = null;
    this.stuckTime = 0;
    this.paused = false;
    this.standingsAt = 0;
    this.snapToSim();
  }

  private fixedStep(): void {
    const racer = this.racer;
    copyVehicle(racer.vehicle, this.prev);

    let input: PlayerInput;
    if (this.mode === 'attract') {
      input = autopilotInput(
        this.track,
        racer.vehicle,
        { boost: true, racingLine: true, course: this.sim.course, tick: this.sim.tick },
        this.autopilot,
      );
      this.stuckTime = racer.vehicle.speed < 2 ? this.stuckTime + DT : 0;
      if (this.stuckTime > ATTRACT_STUCK_SECONDS) {
        this.stuckTime = 0;
        this.sim.respawn(racer);
      }
    } else if (racer.finished) {
      // Cool-down lap: the car drives itself while the finish camera orbits.
      input = autopilotInput(
        this.track,
        racer.vehicle,
        { pace: 0.75, racingLine: true, course: this.sim.course, tick: this.sim.tick },
        this.autopilot,
      );
    } else if (RACE_CONFIG.autopilot) {
      // Development aid: the autopilot also takes the shortcut whenever it is open.
      input = autopilotInput(
        this.track,
        racer.vehicle,
        {
          boost: RACE_CONFIG.autopilotBoost,
          racingLine: true,
          course: this.sim.course,
          tick: this.sim.tick,
          shortcut: true,
        },
        this.autopilot,
      );
      // The player can still fire abilities while the autopilot drives.
      const human = inputManager.current;
      input.shortcut = human.shortcut;
      input.gate = human.gate;
      input.overdrive = human.overdrive;
      // Hold the throttle until the last moment of the countdown: a perfect launch.
      if (this.sim.phase === 'countdown') {
        input.throttle = this.sim.goTick - this.sim.tick < 15 ? 1 : 0;
      }
    } else {
      input = inputManager.current;
    }
    copyInput(input, this.applied);
    this.sim.setInput(SOLO_ID, input);
    inputManager.consumeTaps();
    this.sim.step();

    let teleported = false;
    for (const event of this.sim.drainEvents()) {
      if (event.type === 'respawn') teleported = true;
      if (FEED_TYPES.has(event.type) && this.mode === 'race') this.emitFeed(event);
      if (event.type === 'finish' && event.racerId === SOLO_ID && this.mode === 'race') {
        this.onPlayerFinished();
      }
      this.emit(event);
    }
    copyVehicle(racer.vehicle, this.curr);
    if (teleported) copyVehicle(this.curr, this.prev);
  }

  private onPlayerFinished(): void {
    const r = this.racer;
    const total = r.finishTime ?? 0;
    const bestLap = r.bestLapTime ?? total;
    const previous = loadRecord(this.track.id, this.laps);
    const newBestTotal = previous.bestTotal === null || total < previous.bestTotal;
    const newBestLap = previous.bestLap === null || bestLap < previous.bestLap;
    const record = {
      bestTotal: newBestTotal ? total : previous.bestTotal,
      bestLap: newBestLap ? bestLap : previous.bestLap,
    };
    saveRecord(this.track.id, this.laps, record);
    const results: RaceResults = {
      totalTime: total,
      lapTimes: [...r.lapTimes],
      bestLap,
      topSpeed: r.stats.topSpeed,
      averageSpeed: total > 0 ? (this.track.length * this.sim.laps) / total : 0,
      cellsCollected: r.stats.cellsCollected,
      energyGained: r.stats.cellEnergy + r.stats.driftEnergy + r.stats.laneEnergy,
      driftTime: r.stats.driftTicks * DT,
      boostTime: r.stats.boostTicks * DT,
      boosts: r.stats.boosts,
      padsHit: r.stats.padsHit,
      shortcuts: r.stats.shortcuts,
      gateShifts: r.stats.gateShifts,
      overdrives: r.stats.overdrives,
      shortcutRuns: r.stats.shortcutRuns,
      laneEnergy: r.stats.laneEnergy,
      wallHits: r.stats.wallHits,
      respawns: r.stats.respawns,
      falls: r.stats.falls,
      newBestTotal,
      newBestLap,
      previous,
    };
    useGameStore.setState({ results, record });
    this.resultsAt = this.clock + RESULTS_DELAY;
  }

  private snapToSim(): void {
    copyVehicle(this.racer.vehicle, this.prev);
    copyVehicle(this.racer.vehicle, this.curr);
    copyInput(createInput(), this.applied);
    this.interpolate();
  }

  private interpolate(): void {
    const a = this.alpha;
    const p = this.prev;
    const c = this.curr;
    const out = this.render;
    out.x = lerp(p.x, c.x, a);
    out.y = lerp(p.y, c.y, a);
    out.z = lerp(p.z, c.z, a);
    out.yaw = lerpAngle(p.yaw, c.yaw, a);
    out.vx = lerp(p.vx, c.vx, a);
    out.vy = lerp(p.vy, c.vy, a);
    out.vz = lerp(p.vz, c.vz, a);
    out.speed = lerp(p.speed, c.speed, a);
    out.forwardSpeed = lerp(p.forwardSpeed, c.forwardSpeed, a);
    out.lateralSpeed = lerp(p.lateralSpeed, c.lateralSpeed, a);
    out.yawRate = lerp(p.yawRate, c.yawRate, a);
    out.slope = c.slope;
    out.bank = lerp(p.bank, c.bank, a);
    out.trackFx = c.trackFx;
    out.trackFz = c.trackFz;
    out.trackS = c.trackS;
    out.energy = c.energy;
    out.boosting = c.boosting;
    out.boostLeft = c.boostLeft;
    out.boostCooldown = c.boostCooldown;
    out.padBoost = c.padTicks > 0;
    out.inLane = c.inLane;
    out.overdrive = c.overdriveTicks > 0;
    out.overdriveLeft = c.overdriveTicks;
    out.road = c.road;
    out.drifting = c.drifting;
    out.driftDir = c.driftDir;
    out.driftTicks = c.driftTicks;
    out.impulse = c.impulseTicks > 0;
    out.frozen = c.frozenTicks > 0;
    out.surface = c.surface;
    out.throttle = this.applied.throttle;
    out.brake = this.applied.brake;
    out.steer = this.applied.steer;
  }

  /** Pushes discrete UI state to the store, only when something changed. */
  private publish(): void {
    const sim = this.sim;
    const racer = this.racer;
    const online = this.mode === 'online' ? this.online : null;
    let countdown: CountdownValue = null;
    if (sim.phase === 'countdown') {
      const remaining = sim.goTick - sim.tick;
      if (remaining <= 180) countdown = Math.ceil(remaining / 60) as 1 | 2 | 3;
    } else if (sim.tick - sim.goTick < GO_BANNER_TICKS && this.racing) {
      countdown = 0;
    }
    const racing = this.racing && sim.phase === 'racing' && !racer.finished;
    const v = racer.vehicle;
    // Online, the race standing, laps and best lap are the server's numbers.
    const row = online?.myRow ?? null;
    const laps = sim.laps;
    const lapsDone = row ? row.lap : racer.lap;
    const finished = row ? row.finishTime !== null : racer.finished;
    const next = {
      phase: sim.phase,
      countdown,
      lap: finished ? laps : Math.min(lapsDone + 1, laps),
      position: row ? row.position : racer.position,
      racerCount: online ? online.info.racers.length : sim.racers.length,
      bestLap: row ? row.bestLap : racer.bestLapTime,
      wrongWay: racing && racer.wrongWay,
      offTrack: racing && v.surface !== 'road',
      rebooting: v.frozenTicks > 0,
    };
    const state = useGameStore.getState();
    if (
      state.phase !== next.phase ||
      state.countdown !== next.countdown ||
      state.lap !== next.lap ||
      state.position !== next.position ||
      state.racerCount !== next.racerCount ||
      state.bestLap !== next.bestLap ||
      state.wrongWay !== next.wrongWay ||
      state.offTrack !== next.offTrack ||
      state.rebooting !== next.rebooting
    ) {
      useGameStore.setState(next);
    }
    if (online && this.clock - this.standingsAt >= STANDINGS_INTERVAL) {
      this.standingsAt = this.clock;
      const standings = online.standings;
      const current = state.online.standings;
      const changed =
        standings.length !== current.length ||
        standings.some((s, i) => {
          const c = current[i];
          return (
            c.id !== s.id ||
            c.lap !== s.lap ||
            c.finished !== s.finished ||
            c.retired !== s.retired ||
            c.offline !== s.offline
          );
        });
      if (changed) useGameStore.setState({ online: { ...state.online, standings } });
    }
  }
}

/** Shortest-arc helper kept for the debug readout of corrections. */
export const yawError = (a: number, b: number): number => Math.abs(angleDelta(a, b));

export const session = new GameSession();
