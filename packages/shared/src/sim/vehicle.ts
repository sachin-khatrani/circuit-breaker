import {
  angleDelta,
  clamp,
  clamp01,
  damp,
  lerp,
  moveTowards,
  smoothstep,
  wrapAngle,
} from '../math/scalar';
import { createProjection, GROUND_LEVEL, type Road, type Track } from '../track/track';
import type { TrackProjection } from '../track/types';
import { DT, RACE_RULES, VEHICLE_TUNING, type RaceRules, type VehicleTuning } from './config';
import { gateLaneAt, LEFT_LANE, RIGHT_LANE, shortcutOpenAt, type CourseState } from './course';
import type { PlayerInput } from './input';

export type DriftDir = -1 | 0 | 1;

/**
 * What the car stands on. `road` is the normal case. Driving off an open (barrier-free) edge
 * makes the car `air`borne if the road was raised, or puts it on the `ground` below.
 */
export type VehicleSurface = 'road' | 'air' | 'ground';

/** Complete physical state of one car. Plain data so it can be copied, sent and replayed. */
export interface VehicleState {
  x: number;
  y: number;
  z: number;
  /** Heading; forward is (sin yaw, cos yaw) in XZ. */
  yaw: number;
  vx: number;
  vy: number;
  vz: number;
  yawRate: number;
  surface: VehicleSurface;
  /** Engine output 0..1; follows the throttle input quickly but not instantly. */
  throttleLevel: number;
  /** Ticks the car has been held at a standstill by the brake (reverse engages after a delay). */
  stoppedTicks: number;

  energy: number;
  /** A boost burst is running this tick. */
  boosting: boolean;
  /** Ticks since the current burst started (0 when not boosting); drives the kick. */
  boostTicks: number;
  /** Ticks left in the current burst. */
  boostLeft: number;
  /** Ticks until another burst may start. */
  boostCooldown: number;
  /** Ticks a recent boost press stays remembered (pressed during a burst or its cooldown). */
  boostQueued: number;
  /** Boost input on the previous tick: a burst needs a fresh press. */
  boostHeld: boolean;
  /** Remaining ticks of a free drift or launch impulse. */
  impulseTicks: number;
  /** Remaining ticks of a boost-pad impulse. */
  padTicks: number;
  /** The car is driving inside a speed lane. */
  inLane: boolean;
  drifting: boolean;
  driftDir: DriftDir;
  driftTicks: number;
  /** Energy earned by the current drift (capped per drift). */
  driftEarned: number;
  /** Ticks before a drift may earn Energy again. */
  driftRewardCooldown: number;
  /** Ticks left of the smooth grip recovery after a drift. */
  recoverTicks: number;
  /** Ticks of physics freeze left after a respawn. */
  frozenTicks: number;
  /** Ticks spent off the road surface; the race respawns the car after a grace period. */
  offTrackTicks: number;
  /** Arc length of the last position safely inside the road: where a respawn puts the car. */
  safeS: number;
  /** Road of `safeS`. */
  safeRoad: number;
  /** Ticks of Overdrive left (an ability: a long, stronger boost). */
  overdriveTicks: number;
  /** Speed lane the car is in (-1: none) and the distance it has covered inside it. */
  laneId: number;
  laneMeters: number;
  /** Speed lanes that have paid their Energy this lap (bit per lane id). */
  laneCharged: number;
  /** Energy drifting has earned this lap (capped). */
  driftLapEnergy: number;

  // Track association, refreshed every tick.
  /** Road the car is on: 0 is the main loop, 1 and up are shortcut branches. */
  road: number;
  /** Split lane the car committed to at the divider (-1: not in a split). */
  splitLane: number;
  /** Open lane of the funnel, fixed as the car enters it (-1: not in a funnel). */
  funnelLane: number;
  trackIndex: number;
  trackS: number;
  lateral: number;
  /** Track forward direction under the car. */
  trackFx: number;
  trackFz: number;
  slope: number;
  bank: number;
  wallContact: boolean;

  // Derived each tick, for rendering and HUD.
  speed: number;
  forwardSpeed: number;
  lateralSpeed: number;
}

/** Things that happened inside one vehicle step, turned into race events by the caller. */
export interface VehicleStepResult {
  wallImpact: number;
  driftStarted: boolean;
  driftEnded: boolean;
  miniTurbo: 0 | 1 | 2;
  /** Energy a drift charged this tick. */
  driftEnergy: number;
  /** Total Energy earned by a drift that ended this tick. */
  driftReward: number;
  boostStarted: boolean;
  /** Boost was pressed without enough Energy for a burst. */
  boostDenied: boolean;
  /** The car left the road over an open edge this tick. */
  leftRoad: boolean;
  /** Overdrive ran out this tick. */
  overdriveEnded: boolean;
  /** Energy a speed lane paid this tick, and which lane (-1: none). */
  laneEnergy: number;
  laneChargeId: number;
  /** The car crossed onto another road this tick (a shortcut opening). */
  changedRoad: boolean;
}

/** Stay this far inside the road edge for the position to count as a safe respawn point. */
const SAFE_INSET = 1.5;
/** Slides wider than this (rad) are out of control and charge no Energy. */
const MAX_CHARGE_SLIP = 0.8;
/**
 * Below this forward speed (m/s) the car counts as stopped for the brake. Slopes leave a tiny
 * residual speed every tick; treating it as motion would stop the brake ever reversing.
 */
const STOP_SPEED = 0.05;

export function createVehicle(): VehicleState {
  return {
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    yawRate: 0,
    surface: 'road',
    throttleLevel: 0,
    stoppedTicks: 0,
    energy: 0,
    boosting: false,
    boostTicks: 0,
    boostLeft: 0,
    boostCooldown: 0,
    boostQueued: 0,
    boostHeld: false,
    impulseTicks: 0,
    padTicks: 0,
    inLane: false,
    drifting: false,
    driftDir: 0,
    driftTicks: 0,
    driftEarned: 0,
    driftRewardCooldown: 0,
    recoverTicks: 0,
    frozenTicks: 0,
    offTrackTicks: 0,
    safeS: 0,
    safeRoad: 0,
    overdriveTicks: 0,
    laneId: -1,
    laneMeters: 0,
    laneCharged: 0,
    driftLapEnergy: 0,
    road: 0,
    splitLane: -1,
    funnelLane: -1,
    trackIndex: -1,
    trackS: 0,
    lateral: 0,
    trackFx: 0,
    trackFz: 1,
    slope: 0,
    bank: 0,
    wallContact: false,
    speed: 0,
    forwardSpeed: 0,
    lateralSpeed: 0,
  };
}

export function copyVehicle(from: Readonly<VehicleState>, to: VehicleState): VehicleState {
  Object.assign(to, from);
  return to;
}

const projection = createProjection();

/** Puts a car at rest on a road's surface at (s, lateral), facing the race direction. */
export function placeVehicle(
  v: VehicleState,
  track: Track,
  s: number,
  lateral: number,
  roadId = 0,
): void {
  const road = track.road(roadId);
  const f = road.frameAt(s);
  v.x = f.x + f.rx * lateral;
  v.z = f.z + f.rz * lateral;
  v.yaw = f.heading;
  v.vx = 0;
  v.vy = 0;
  v.vz = 0;
  v.yawRate = 0;
  v.surface = 'road';
  v.throttleLevel = 0;
  v.stoppedTicks = 0;
  v.boosting = false;
  v.boostTicks = 0;
  v.boostLeft = 0;
  v.boostCooldown = 0;
  v.boostQueued = 0;
  v.impulseTicks = 0;
  v.padTicks = 0;
  v.drifting = false;
  v.driftDir = 0;
  v.driftTicks = 0;
  v.driftEarned = 0;
  v.recoverTicks = 0;
  v.offTrackTicks = 0;
  v.overdriveTicks = 0;
  v.road = road.roadId;
  v.safeS = road.wrapS(s);
  v.safeRoad = road.roadId;
  v.splitLane = -1;
  v.funnelLane = -1;
  v.laneId = -1;
  v.laneMeters = 0;
  v.wallContact = false;
  const hint = Math.floor(road.wrapS(s) / road.spacing);
  const p = road.project(v.x, v.z, hint, projection);
  syncTrack(v, p, true);
  v.inLane = road.roadId === 0 && track.laneAt(p.index, p.s, p.lateral) >= 0;
  updateDerived(v);
}

/** Steering authority multiplier: none at standstill, full at mid speed, tapering at top speed. */
export function steerAuthority(speed: number, t: VehicleTuning = VEHICLE_TUNING): number {
  const low = Math.min(1, speed / t.steerFullSpeed);
  const high = clamp01((speed - t.steerFullSpeed) / (t.maxSpeed - t.steerFullSpeed));
  return low * lerp(1, t.highSpeedSteer, high);
}

/** Top speed (m/s) under the active bonuses. Bonuses do not stack: the largest one counts. */
export function speedCap(v: Readonly<VehicleState>, t: VehicleTuning = VEHICLE_TUNING): number {
  const bonus = Math.max(
    v.boosting ? t.boostMaxSpeed - t.maxSpeed : 0,
    v.overdriveTicks > 0 ? t.overdriveMaxSpeed - t.maxSpeed : 0,
    v.impulseTicks > 0 ? t.impulseSpeedBonus : 0,
    v.padTicks > 0 ? t.padSpeedBonus : 0,
    v.inLane ? t.laneSpeedBonus : 0,
  );
  return t.maxSpeed + bonus;
}

const result: VehicleStepResult = {
  wallImpact: 0,
  driftStarted: false,
  driftEnded: false,
  miniTurbo: 0,
  driftEnergy: 0,
  driftReward: 0,
  boostStarted: false,
  boostDenied: false,
  leftRoad: false,
  overdriveEnded: false,
  laneEnergy: 0,
  laneChargeId: -1,
  changedRoad: false,
};

/**
 * Advances one car by one fixed tick. Pure function of (state, input, track, course state,
 * tick, tuning): the server runs it authoritatively and the client runs it to predict its own
 * car. `course` (shortcut open or not, gate lane) defaults to the starting layout.
 * The returned object is reused between calls; copy what you need.
 */
export function stepVehicle(
  v: VehicleState,
  input: Readonly<PlayerInput>,
  track: Track,
  t: VehicleTuning = VEHICLE_TUNING,
  rules: RaceRules = RACE_RULES,
  course: Readonly<CourseState> | null = null,
  tick = 0,
): VehicleStepResult {
  result.wallImpact = 0;
  result.driftStarted = false;
  result.driftEnded = false;
  result.miniTurbo = 0;
  result.driftEnergy = 0;
  result.driftReward = 0;
  result.boostStarted = false;
  result.boostDenied = false;
  result.leftRoad = false;
  result.overdriveEnded = false;
  result.laneEnergy = 0;
  result.laneChargeId = -1;
  result.changedRoad = false;
  const dt = DT;
  // Edge detection runs on every tick, so a held key never fires twice and a press made while
  // frozen or airborne is not replayed later.
  const boostPressed = input.boost && !v.boostHeld;
  v.boostHeld = input.boost;
  if (v.driftRewardCooldown > 0) v.driftRewardCooldown--;

  if (v.frozenTicks > 0) {
    v.frozenTicks--;
    v.vx = 0;
    v.vy = 0;
    v.vz = 0;
    v.yawRate = 0;
    v.throttleLevel = 0;
    cancelBoost(v);
    updateDerived(v);
    return result;
  }

  if (v.surface === 'air') {
    tickOverdrive(v);
    stepAirborne(v, input, track, t, rules);
    updateDerived(v);
    return result;
  }

  const offRoad = v.surface === 'ground';
  const throttle = clamp01(input.throttle);
  const brake = clamp01(input.brake);
  const steer = clamp(input.steer, -1, 1);
  v.throttleLevel = moveTowards(v.throttleLevel, throttle, t.throttleResponse * dt);

  // --- Drift state machine (decided in the current heading frame) -------------------------
  let sin = Math.sin(v.yaw);
  let cos = Math.cos(v.yaw);
  let vF = v.vx * sin + v.vz * cos;

  if (v.drifting) {
    if (!input.drift || vF < t.driftExitSpeed || offRoad) endDrift(v, t, rules, offRoad);
    else v.driftTicks++;
  } else if (!offRoad && input.drift && Math.abs(steer) > t.driftMinSteer && vF > t.driftMinSpeed) {
    v.drifting = true;
    v.driftDir = steer > 0 ? 1 : -1;
    v.driftTicks = 0;
    v.driftEarned = 0;
    v.recoverTicks = 0;
    v.yawRate -= v.driftDir * t.driftKick;
    result.driftStarted = true;
  }
  // After a drift, grip and steering response blend back over a moment instead of snapping
  // the car straight (0 = drift handling, 1 = normal grip).
  if (!v.drifting && v.recoverTicks > 0) v.recoverTicks--;
  let recovery = 1;
  if (v.drifting) recovery = 0;
  else if (v.recoverTicks > 0 && t.driftRecoveryTicks > 0) {
    recovery = smoothstep(0, 1, 1 - v.recoverTicks / t.driftRecoveryTicks);
  }

  // --- Steering: yaw rate chases a target set by speed-dependent authority ------------------
  const authority = steerAuthority(Math.abs(vF), t);
  let targetYawRate: number;
  if (v.drifting) {
    // Steering into the drift tightens it, counter-steering opens it up (0.6x .. 1.4x).
    const modulation = 1 + 0.4 * steer * v.driftDir;
    targetYawRate = -v.driftDir * t.driftYawRate * authority * modulation;
  } else {
    // Reversing steers like a real car: the nose swings the other way.
    targetYawRate = -steer * t.maxYawRate * authority * (vF < -0.5 ? -1 : 1);
  }
  const response = t.yawResponse * (v.drifting ? 1 : lerp(0.3, 1, recovery));
  v.yawRate = damp(v.yawRate, targetYawRate, response, dt);
  v.yaw = wrapAngle(v.yaw + v.yawRate * dt);

  // --- Velocity in the new heading frame -------------------------------------------------
  sin = Math.sin(v.yaw);
  cos = Math.cos(v.yaw);
  vF = v.vx * sin + v.vz * cos;
  let vR = -v.vx * cos + v.vz * sin;

  // --- Energy boost: one press starts a fixed burst, paid up front -------------------------
  // Overdrive and a burst never run together: Overdrive replaces a burst and blocks new ones.
  stepBoost(v, boostPressed, rules, !offRoad && v.overdriveTicks === 0);
  const overdrive = v.overdriveTicks > 0;

  // --- Longitudinal forces -------------------------------------------------------------
  const impulse = v.impulseTicks > 0;
  const pad = v.padTicks > 0;
  const cap = speedCap(v, t);
  if (impulse) v.impulseTicks--;
  if (pad) v.padTicks--;
  const headroom = vF >= 0 ? Math.max(0, 1 - (vF / cap) * (vF / cap)) : 1;
  const engine = (offRoad ? t.offRoadEngine : 1) * (v.drifting ? t.driftEngine : 1);
  let accel = 0;
  if (vF < -0.5) {
    // Throttle while rolling backwards brakes first.
    if (throttle > 0) accel += t.brakeDecel * throttle;
  } else {
    accel += t.engineAccel * engine * v.throttleLevel * headroom;
  }
  if (v.boosting) {
    const ramp = Math.min(1, v.boostTicks / Math.max(1, t.boostRampTicks));
    const kick = v.boostTicks <= t.boostKickTicks ? t.boostKickScale : 1;
    accel += t.boostAccel * engine * headroom * kick * ramp;
  }
  if (overdrive) accel += t.overdriveAccel * engine * headroom;
  if (impulse) accel += t.impulseAccel * engine * headroom;
  if (pad) accel += t.padAccel * engine * headroom;
  if (v.inLane && throttle > 0) accel += t.laneAccel * engine * headroom;
  // At a standstill the brake holds the car for a moment, then turns into reverse.
  let holding = false;
  if (brake > 0) {
    if (vF > STOP_SPEED) accel -= t.brakeDecel * brake;
    else if (vF < -0.5 || v.stoppedTicks >= t.reverseDelayTicks) {
      if (vF > -t.maxReverseSpeed) accel -= t.reverseAccel * engine * brake;
    } else holding = true;
  }
  v.stoppedTicks = brake > 0 && Math.abs(vF) <= 0.5 ? v.stoppedTicks + 1 : 0;
  const before = vF;
  vF += accel * dt;
  // Braking stops the car dead; reversing only starts from a standstill on a later tick.
  if (brake > 0 && before > STOP_SPEED && vF < 0) vF = 0;

  if (throttle === 0 && brake === 0 && !v.boosting && !overdrive && !impulse && !pad) {
    const decel = (t.coastDecel + t.coastDrag * Math.abs(vF)) * dt;
    vF = Math.abs(vF) <= decel ? 0 : vF - Math.sign(vF) * decel;
  }
  // Speed above the current cap (end of a boost) bleeds off instead of being clamped.
  if (vF > cap) vF = cap + (vF - cap) * Math.exp(-t.overspeedDecay * dt);
  if (vF < -t.maxReverseSpeed) vF = -t.maxReverseSpeed;

  // Gravity along the grade, as seen along the car's heading. A held brake keeps the car still.
  if (!offRoad) {
    const along = sin * v.trackFx + cos * v.trackFz;
    vF -= t.gravity * t.slopeFactor * v.slope * along * dt;
  }
  if (holding) vF = 0;

  // --- Grip: the core of the handling -----------------------------------------------------
  // The velocity keeps its magnitude while grip swings it toward the nose (or the tail when
  // reversing). Damping the sideways component instead would bleed speed at yawRate²/grip,
  // which makes low-grip drifts stall. Speed is lost only through the explicit slip scrub.
  let speed = Math.hypot(vF, vR);
  let slip = 0;
  if (speed > 1e-4) {
    const axis = vF < 0 ? -1 : 1;
    slip = Math.atan2(vR * axis, vF * axis);
    const scrub = v.drifting ? t.driftScrub : lerp(t.driftScrub, t.scrub, recovery);
    speed = Math.max(0, speed - scrub * speed * Math.abs(Math.sin(slip)) * dt);
    if (offRoad) speed *= Math.exp(-t.offRoadDrag * dt);
    const grip = offRoad
      ? t.offRoadGrip
      : v.drifting
        ? t.driftGrip
        : lerp(t.driftGrip, t.grip, recovery);
    const settled = slip * Math.exp(-grip * dt);
    vF = axis * speed * Math.cos(settled);
    vR = axis * speed * Math.sin(settled);
  }

  // Recompose: velocity = forward * vF + right * vR, with right = (-cos, sin).
  v.vx = sin * vF - cos * vR;
  v.vz = cos * vF + sin * vR;

  if (v.drifting) chargeDrift(v, rules, t, vF, Math.abs(slip), speed);

  v.x += v.vx * dt;
  v.z += v.vz * dt;

  tickOverdrive(v);
  if (offRoad) stepGroundContact(v, track);
  else stepRoadContact(v, track, t, rules, course, tick);
  updateDerived(v);
  return result;
}

/** Counts Overdrive down; reports the tick it runs out. */
function tickOverdrive(v: VehicleState): void {
  if (v.overdriveTicks <= 0) return;
  v.overdriveTicks--;
  if (v.overdriveTicks === 0) result.overdriveEnded = true;
}

/**
 * Starts Overdrive on a car (the race has already checked and taken the Energy). A running
 * burst ends: the two never stack.
 */
export function startOverdrive(v: VehicleState, rules: RaceRules = RACE_RULES): void {
  cancelBoost(v);
  v.overdriveTicks = rules.overdriveTicks;
}

/**
 * Boost bursts: a fresh press (or one remembered from the last moments of a burst or its
 * cooldown) starts a burst of fixed length if the Energy for it is there. Holding the button
 * or pressing again during a burst never adds anything.
 */
function stepBoost(v: VehicleState, pressed: boolean, rules: RaceRules, canStart: boolean): void {
  if (pressed) v.boostQueued = rules.boostBufferTicks;
  else if (v.boostQueued > 0) v.boostQueued--;
  if (v.boostQueued > 0 && v.boostLeft === 0 && v.boostCooldown === 0 && canStart) {
    if (v.energy >= rules.boostCost) {
      v.energy -= rules.boostCost;
      v.boostLeft = rules.boostDurationTicks;
      v.boostTicks = 0;
      v.boostQueued = 0;
      result.boostStarted = true;
    } else if (pressed) {
      result.boostDenied = true;
    }
  }
  if (v.boostLeft > 0) {
    v.boosting = true;
    v.boostTicks++;
    v.boostLeft--;
    if (v.boostLeft === 0) v.boostCooldown = rules.boostCooldownTicks;
  } else {
    v.boosting = false;
    v.boostTicks = 0;
    if (v.boostCooldown > 0) v.boostCooldown--;
  }
}

/** Ends a burst early (respawn, leaving the road); its cost is not refunded. */
function cancelBoost(v: VehicleState): void {
  v.boosting = false;
  v.boostTicks = 0;
  v.boostLeft = 0;
  v.boostQueued = 0;
}

/**
 * Drift Energy: only a sustained, controlled slide that is still heading down the track
 * charges, up to a cap per drift, and a rewarded drift is followed by a cooldown. Spinning in
 * circles or tapping the drift button earns little or nothing.
 */
function chargeDrift(
  v: VehicleState,
  rules: RaceRules,
  t: VehicleTuning,
  vF: number,
  slip: number,
  speed: number,
): void {
  if (v.driftTicks < rules.driftEnergyDelayTicks || v.driftRewardCooldown > 0) return;
  if (vF <= t.driftMinSpeed || slip < rules.driftChargeSlip || slip > MAX_CHARGE_SLIP) return;
  const along = v.vx * v.trackFx + v.vz * v.trackFz;
  if (along < 0.5 * speed) return;
  const gain = Math.min(
    rules.driftEnergyPerSecond * DT,
    rules.driftEnergyMaxPerDrift - v.driftEarned,
    rules.driftEnergyMaxPerLap - v.driftLapEnergy,
    rules.maxEnergy - v.energy,
  );
  if (gain <= 0) return;
  v.energy += gain;
  v.driftEarned += gain;
  v.driftLapEnergy += gain;
  result.driftEnergy = gain;
}

/** Lateral limits of the drivable surface where the car is, and which of them are dividers. */
interface Limits {
  lo: number;
  hi: number;
  /** The limit is a divider or funnel barrier (always solid), not the road's own edge. */
  loSplit: boolean;
  hiSplit: boolean;
}
const limits: Limits = { lo: 0, hi: 0, loSplit: false, hiSplit: false };

/**
 * The road edges, narrowed inside a lane split. Before the divider a funnel barrier closes
 * the shut lane; the open lane is fixed as the car enters the funnel, so a gate switch never
 * moves a barrier onto a car already there. At the divider's nose the car commits to its
 * lane and keeps it to the end of the split, whatever the gate does meanwhile.
 */
function roadLimits(
  v: VehicleState,
  track: Track,
  road: Road,
  p: TrackProjection,
  course: Readonly<CourseState> | null,
  tick: number,
): Limits {
  limits.lo = -p.halfWidth;
  limits.hi = p.halfWidth;
  limits.loSplit = false;
  limits.hiSplit = false;
  const id = road.roadId === 0 ? track.splitAt(p.index) : -1;
  const split = id >= 0 ? track.splits[id] : null;
  const along = split ? track.distanceAhead(split.funnelS, p.s) : 0;
  if (!split || along > split.funnel + split.length) {
    v.splitLane = -1;
    v.funnelLane = -1;
    return limits;
  }
  if (v.funnelLane < 0) v.funnelLane = course ? gateLaneAt(course, tick) : RIGHT_LANE;
  if (along < split.funnel) {
    v.splitLane = -1;
    const u = along / split.funnel;
    if (v.funnelLane === LEFT_LANE) {
      limits.hi = lerp(p.halfWidth, -split.divider, u);
      limits.hiSplit = true;
    } else {
      limits.lo = lerp(-p.halfWidth, split.divider, u);
      limits.loSplit = true;
    }
    return limits;
  }
  if (v.splitLane < 0) v.splitLane = v.funnelLane;
  if (v.splitLane === LEFT_LANE) {
    limits.hi = -split.divider;
    limits.hiSplit = true;
  } else {
    limits.lo = split.divider;
    limits.loSplit = true;
  }
  return limits;
}

/**
 * Whether a car may cross an opening from `road`. Leaving a branch, and the merge stretch, are
 * always open: nobody is ever trapped on a shortcut. Turning in needs the shortcut open.
 */
function portalOpen(
  track: Track,
  road: Road,
  portalId: number,
  course: Readonly<CourseState> | null,
  tick: number,
): boolean {
  if (road.roadId !== 0) return true;
  if (track.portals[portalId].kind === 'exit') return true;
  return course !== null && shortcutOpenAt(course, tick);
}

/** Moves the car's road association across an opening (its position does not change). */
function crossPortal(
  v: VehicleState,
  track: Track,
  road: Road,
  p: TrackProjection,
  portalId: number,
): Road {
  const portal = track.portals[portalId];
  const toBranch = road.roadId === 0;
  v.road = toBranch ? portal.branch : 0;
  v.trackIndex = toBranch ? track.portalHint(portal, p.index) : track.mainHint(portal, p.index);
  v.splitLane = -1;
  v.funnelLane = -1;
  result.changedRoad = true;
  return track.road(v.road);
}

/** Barrier response: push out, reflect the inward speed, scrape, turn the nose along. */
function hitWall(
  v: VehicleState,
  p: TrackProjection,
  side: number,
  penetration: number,
  t: VehicleTuning,
  rules: RaceRules,
): void {
  const nx = p.rx * side;
  const nz = p.rz * side;
  v.x -= nx * penetration;
  v.z -= nz * penetration;
  v.wallContact = true;

  const vn = v.vx * nx + v.vz * nz;
  if (vn > 0) {
    v.vx -= (1 + t.wallRestitution) * vn * nx;
    v.vz -= (1 + t.wallRestitution) * vn * nz;
    const speed = Math.hypot(v.vx, v.vz);
    if (speed > 0) {
      const k = Math.max(0, speed - t.wallFriction * vn) / speed;
      v.vx *= k;
      v.vz *= k;
    }
    // Deflect the nose toward the wall tangent so a hit costs time but never traps the car.
    const forwardAlong = v.vx * p.fx + v.vz * p.fz >= 0;
    const tangentYaw = forwardAlong ? Math.atan2(p.fx, p.fz) : Math.atan2(-p.fx, -p.fz);
    v.yaw = wrapAngle(v.yaw + angleDelta(v.yaw, tangentYaw) * clamp(vn / 20, 0.12, 0.55));
    v.yawRate *= 0.5;
    if (vn > t.wallImpactEvent) {
      result.wallImpact = vn;
      if (v.drifting) endDrift(v, t, rules, true);
    }
  }
  const drag = Math.exp(-t.wallScrapeDrag * DT);
  v.vx *= drag;
  v.vz *= drag;
}

/**
 * Road contact after integration. Energy barriers (and split dividers) push the car back; an
 * open edge lets it leave the road; an opening into another road lets it cross over when its
 * centre passes the shared edge. A car past either end of a branch is back on the main loop.
 */
function stepRoadContact(
  v: VehicleState,
  track: Track,
  t: VehicleTuning,
  rules: RaceRules,
  course: Readonly<CourseState> | null,
  tick: number,
): void {
  let road = track.road(v.road);
  let p = road.project(v.x, v.z, v.trackIndex, projection);
  const end = road.beyondEnds(v.x, v.z);
  if (end !== 0) {
    // Off the end of a branch (normally the merge has already taken the car across).
    const portal = track.portals.find(
      (q) => q.branch === road.roadId && q.kind === (end > 0 ? 'exit' : 'entry'),
    );
    v.road = 0;
    v.trackIndex = portal
      ? track.mainHint(portal, end > 0 ? portal.branchTo : portal.branchFrom)
      : -1;
    road = track;
    p = road.project(v.x, v.z, v.trackIndex, projection);
    result.changedRoad = true;
  }
  v.wallContact = false;
  let crossed = false;
  for (let pass = 0; pass < 2; pass++) {
    const lim = roadLimits(v, track, road, p, course, tick);
    let moved = false;
    for (const side of SIDES) {
      const bound = side > 0 ? lim.hi : lim.lo;
      const over = side > 0 ? p.lateral - (bound - t.halfWidth) : bound + t.halfWidth - p.lateral;
      if (over <= 0) continue;
      if (!(side > 0 ? lim.hiSplit : lim.loSplit)) {
        const portal = road.portalAt(p.index, side);
        if (portal >= 0 && portalOpen(track, road, portal, course, tick)) {
          // Over an opening: no barrier. Once the centre is across, the car is on the other road.
          if (!crossed && side * p.lateral > p.halfWidth) {
            road = crossPortal(v, track, road, p, portal);
            p = road.project(v.x, v.z, v.trackIndex, projection);
            crossed = true;
            moved = true;
            break;
          }
          continue;
        }
        if (!road.hasWall(p.index, side)) {
          if (side * p.lateral > p.halfWidth + t.edgeMargin) {
            leaveRoad(v, p, t, rules);
            return;
          }
          continue;
        }
      }
      hitWall(v, p, side, over, t, rules);
      p = road.project(v.x, v.z, p.index, projection);
    }
    if (!moved) break;
  }
  syncTrack(v, p, true);
  v.offTrackTicks = 0;
  const lane = road.roadId === 0 ? track.laneAt(p.index, p.s, p.lateral) : -1;
  v.inLane = lane >= 0;
  chargeLane(v, track, lane, rules);
  // A respawn point must be a place anyone can drive: never inside a split or its funnel.
  const inSplit = road.roadId === 0 && track.splitAt(p.index) >= 0;
  if (!inSplit && Math.abs(p.lateral) < p.halfWidth - SAFE_INSET) {
    v.safeS = p.s;
    v.safeRoad = road.roadId;
  }
}

const SIDES = [1, -1] as const;

/**
 * Speed lanes pay a little Energy for being driven through: once per lane per lap, after the
 * car has covered most of the lane inside it (moving forward). Sitting in a lane, or driving
 * back and forth through it, earns nothing more.
 */
function chargeLane(v: VehicleState, track: Track, lane: number, rules: RaceRules): void {
  if (lane !== v.laneId) {
    v.laneId = lane;
    v.laneMeters = 0;
  }
  if (lane < 0) return;
  const forward = v.vx * v.trackFx + v.vz * v.trackFz;
  if (forward > 0) v.laneMeters += forward * DT;
  const bit = 1 << lane;
  if (v.laneCharged & bit) return;
  if (v.laneMeters < rules.laneChargeFraction * track.lanes[lane].length) return;
  v.laneCharged |= bit;
  const gained = Math.min(rules.laneEnergy, rules.maxEnergy - v.energy);
  v.energy += gained;
  result.laneEnergy = gained;
  result.laneChargeId = lane;
}

function leaveRoad(v: VehicleState, p: TrackProjection, t: VehicleTuning, rules: RaceRules): void {
  // Carry the road's vertical motion into the jump: climbing launches up, descending drops.
  const along = v.vx * p.fx + v.vz * p.fz;
  const raised = p.height - GROUND_LEVEL > 1;
  v.surface = raised ? 'air' : 'ground';
  v.vy = raised ? along * p.slope : 0;
  v.offTrackTicks = 0;
  v.inLane = false;
  v.padTicks = 0;
  cancelBoost(v);
  if (v.drifting) endDrift(v, t, rules, true);
  result.leftRoad = true;
  syncTrack(v, p, !raised);
  if (!raised) v.y = GROUND_LEVEL;
}

/** Ballistic flight after leaving a raised open edge. No traction, gravity pulls hard. */
function stepAirborne(
  v: VehicleState,
  input: Readonly<PlayerInput>,
  track: Track,
  t: VehicleTuning,
  rules: RaceRules,
): void {
  const step = DT;
  const drag = Math.exp(-t.airDrag * step);
  v.vx *= drag;
  v.vz *= drag;
  v.vy -= t.gravity * t.fallGravity * step;
  v.x += v.vx * step;
  v.z += v.vz * step;
  v.y += v.vy * step;
  v.yawRate *= Math.exp(-1.5 * step);
  v.yaw = wrapAngle(v.yaw + v.yawRate * step);
  v.throttleLevel = moveTowards(
    v.throttleLevel,
    clamp01(input.throttle),
    t.throttleResponse * step,
  );
  cancelBoost(v);
  if (v.boostCooldown > 0) v.boostCooldown--;
  if (v.drifting) endDrift(v, t, rules, true);
  v.offTrackTicks++;

  const p = track.road(v.road).project(v.x, v.z, v.trackIndex, projection);
  if (Math.abs(p.lateral) <= p.halfWidth && v.y <= p.height) {
    // Came down back over the road: land on it.
    v.surface = 'road';
    v.vy = 0;
    v.offTrackTicks = 0;
    syncTrack(v, p, true);
    return;
  }
  syncTrack(v, p, false);
  if (v.y <= GROUND_LEVEL) {
    v.y = GROUND_LEVEL;
    v.vy = 0;
    v.surface = 'ground';
  }
}

/** Off-road on the ground: the car may climb back where the road sits at ground level. */
function stepGroundContact(v: VehicleState, track: Track): void {
  v.offTrackTicks++;
  const road = track.road(v.road);
  const p = road.project(v.x, v.z, v.trackIndex, projection);
  const roadAtGround = p.height - GROUND_LEVEL <= 1;
  if (roadAtGround && Math.abs(p.lateral) <= p.halfWidth && !road.hasWall(p.index, p.lateral)) {
    v.surface = 'road';
    v.offTrackTicks = 0;
    syncTrack(v, p, true);
    return;
  }
  syncTrack(v, p, false);
  v.y = GROUND_LEVEL;
}

function endDrift(v: VehicleState, t: VehicleTuning, rules: RaceRules, cancelled: boolean): void {
  if (!cancelled) {
    if (v.driftTicks >= rules.miniTurboTier2Ticks) {
      v.impulseTicks = Math.max(v.impulseTicks, rules.miniTurboTier2Impulse);
      result.miniTurbo = 2;
    } else if (v.driftTicks >= rules.miniTurboTier1Ticks) {
      v.impulseTicks = Math.max(v.impulseTicks, rules.miniTurboTier1Impulse);
      result.miniTurbo = 1;
    }
  }
  if (v.driftEarned > 0) {
    result.driftReward = v.driftEarned;
    v.driftRewardCooldown = rules.driftEnergyCooldownTicks;
  }
  v.drifting = false;
  v.driftDir = 0;
  v.driftTicks = 0;
  v.driftEarned = 0;
  v.recoverTicks = t.driftRecoveryTicks;
  result.driftEnded = true;
}

function syncTrack(v: VehicleState, p: TrackProjection, setHeight: boolean): void {
  v.trackIndex = p.index;
  v.trackS = p.s;
  v.lateral = p.lateral;
  v.trackFx = p.fx;
  v.trackFz = p.fz;
  v.slope = p.slope;
  v.bank = p.bank;
  if (setHeight) v.y = p.height;
}

function updateDerived(v: VehicleState): void {
  const sin = Math.sin(v.yaw);
  const cos = Math.cos(v.yaw);
  v.forwardSpeed = v.vx * sin + v.vz * cos;
  v.lateralSpeed = -v.vx * cos + v.vz * sin;
  v.speed = Math.hypot(v.vx, v.vz);
}
