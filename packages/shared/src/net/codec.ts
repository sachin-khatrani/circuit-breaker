import { clamp } from '../math/scalar';
import { createInput, type PlayerInput } from '../sim/input';
import type { RacerState } from '../sim/race';
import type { VehicleSurface } from '../sim/vehicle';
import { MAX_FRAMES_PER_PACKET } from './protocol';

// ---------------------------------------------------------------------------------------------
// Inputs: a frame is four small integers, a packet is [firstTick, ...frames flattened].
// ---------------------------------------------------------------------------------------------

export const BUTTON_BOOST = 1;
export const BUTTON_DRIFT = 2;
export const BUTTON_RESET = 4;
export const BUTTON_SHORTCUT = 8;
export const BUTTON_GATE = 16;
export const BUTTON_OVERDRIVE = 32;
const BUTTON_MASK =
  BUTTON_BOOST | BUTTON_DRIFT | BUTTON_RESET | BUTTON_SHORTCUT | BUTTON_GATE | BUTTON_OVERDRIVE;
const FRAME_SIZE = 4;

/** [throttle 0..100, brake 0..100, steer −100..100, buttons bitmask] */
export type InputFrame = [number, number, number, number];

export function packInputFrame(input: Readonly<PlayerInput>): InputFrame {
  return [
    Math.round(clamp(input.throttle, 0, 1) * 100),
    Math.round(clamp(input.brake, 0, 1) * 100),
    Math.round(clamp(input.steer, -1, 1) * 100),
    (input.boost ? BUTTON_BOOST : 0) |
      (input.drift ? BUTTON_DRIFT : 0) |
      (input.reset ? BUTTON_RESET : 0) |
      (input.shortcut ? BUTTON_SHORTCUT : 0) |
      (input.gate ? BUTTON_GATE : 0) |
      (input.overdrive ? BUTTON_OVERDRIVE : 0),
  ];
}

export function unpackInputFrame(frame: Readonly<InputFrame>, out = createInput()): PlayerInput {
  out.throttle = frame[0] / 100;
  out.brake = frame[1] / 100;
  out.steer = frame[2] / 100;
  out.boost = (frame[3] & BUTTON_BOOST) !== 0;
  out.drift = (frame[3] & BUTTON_DRIFT) !== 0;
  out.reset = (frame[3] & BUTTON_RESET) !== 0;
  out.shortcut = (frame[3] & BUTTON_SHORTCUT) !== 0;
  out.gate = (frame[3] & BUTTON_GATE) !== 0;
  out.overdrive = (frame[3] & BUTTON_OVERDRIVE) !== 0;
  return out;
}

/**
 * An input packet: `[raceId, firstTick, …frames]`. The race id lets the server drop anything a
 * client sent for an earlier race.
 */
export function encodeInputPacket(
  raceId: number,
  firstTick: number,
  frames: readonly InputFrame[],
): number[] {
  const out = [raceId, firstTick];
  for (const f of frames) out.push(f[0], f[1], f[2], f[3]);
  return out;
}

const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

/**
 * Parses an untrusted input packet. Anything malformed (wrong types, ranges, sizes) rejects
 * the whole packet: a client that sends garbage gets nothing applied.
 */
export function decodeInputPacket(
  raw: unknown,
): { raceId: number; firstTick: number; frames: InputFrame[] } | null {
  if (!Array.isArray(raw)) return null;
  const count = (raw.length - 2) / FRAME_SIZE;
  if (!Number.isInteger(count) || count < 1 || count > MAX_FRAMES_PER_PACKET) return null;
  const raceId: unknown = raw[0];
  const firstTick: unknown = raw[1];
  if (!isInt(raceId, 0, 0x7fffffff) || !isInt(firstTick, 0, 0x7fffffff)) return null;
  const frames: InputFrame[] = [];
  for (let i = 0; i < count; i++) {
    const k = 2 + i * FRAME_SIZE;
    const t: unknown = raw[k];
    const b: unknown = raw[k + 1];
    const s: unknown = raw[k + 2];
    const m: unknown = raw[k + 3];
    if (!isInt(t, 0, 100) || !isInt(b, 0, 100) || !isInt(s, -100, 100)) return null;
    if (!isInt(m, 0, BUTTON_MASK)) return null;
    frames.push([t, b, s, m]);
  }
  return { raceId, firstTick, frames };
}

// ---------------------------------------------------------------------------------------------
// Snapshots: one compact row per racer (everything needed to draw the car and the standings),
// plus the full predictable state of the recipient's own car.
// ---------------------------------------------------------------------------------------------

export const FLAG_BOOSTING = 1;
export const FLAG_DRIFTING = 2;
export const FLAG_DRIFT_RIGHT = 4;
export const FLAG_PAD = 8;
export const FLAG_IMPULSE = 16;
export const FLAG_FROZEN = 32;
export const FLAG_BRAKING = 64;
export const FLAG_IN_LANE = 128;
export const FLAG_AIR = 256;
export const FLAG_GROUND = 512;
export const FLAG_FINISHED = 1024;
export const FLAG_RETIRED = 2048;
export const FLAG_OFFLINE = 4096;
export const FLAG_WRONG_WAY = 8192;
export const FLAG_OVERDRIVE = 16384;

/** Decoded racer row (positions in metres, angles in radians, times in seconds). */
export interface RacerRow {
  slot: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  vx: number;
  vy: number;
  vz: number;
  yawRate: number;
  flags: number;
  steer: number;
  throttle: number;
  energy: number;
  /** Completed laps. */
  lap: number;
  nextCheckpoint: number;
  /** 1-based standing. */
  position: number;
  trackS: number;
  finishTime: number | null;
  bestLap: number | null;
  driftTicks: number;
  /** Road the car is on: 0 the main loop, 1+ a shortcut branch. */
  road: number;
}

export const ROW_SIZE = 21;

const cm = (v: number) => Math.round(v * 100);
const ms = (v: number | null) => (v === null ? -1 : Math.round(v * 1000));

/** `offline` is the server's view of the player's connection (shown as a ghost). */
export function packRacerRow(r: RacerState, offline: boolean, out: number[] = []): number[] {
  const v = r.vehicle;
  let flags = 0;
  if (v.boosting) flags |= FLAG_BOOSTING;
  if (v.drifting) flags |= FLAG_DRIFTING;
  if (v.driftDir > 0) flags |= FLAG_DRIFT_RIGHT;
  if (v.padTicks > 0) flags |= FLAG_PAD;
  if (v.impulseTicks > 0) flags |= FLAG_IMPULSE;
  if (v.frozenTicks > 0) flags |= FLAG_FROZEN;
  if (r.input.brake > 0.05 && v.forwardSpeed > 0.5) flags |= FLAG_BRAKING;
  if (v.inLane) flags |= FLAG_IN_LANE;
  if (v.surface === 'air') flags |= FLAG_AIR;
  if (v.surface === 'ground') flags |= FLAG_GROUND;
  if (r.finished) flags |= FLAG_FINISHED;
  if (r.retired) flags |= FLAG_RETIRED;
  if (offline) flags |= FLAG_OFFLINE;
  if (r.wrongWay) flags |= FLAG_WRONG_WAY;
  if (v.overdriveTicks > 0) flags |= FLAG_OVERDRIVE;
  out.length = 0;
  out.push(
    r.slot,
    cm(v.x),
    cm(v.y),
    cm(v.z),
    Math.round(v.yaw * 1000),
    cm(v.vx),
    cm(v.vy),
    cm(v.vz),
    Math.round(v.yawRate * 1000),
    flags,
    Math.round(clamp(r.input.steer, -1, 1) * 100),
    Math.round(clamp(r.input.throttle, 0, 1) * 100),
    Math.floor(v.energy),
    r.lap,
    r.nextCheckpoint,
    r.position,
    cm(v.trackS),
    ms(r.finishTime),
    ms(r.bestLapTime),
    Math.min(v.driftTicks, 9999),
    v.road,
  );
  return out;
}

export function unpackRacerRow(raw: readonly number[], out: RacerRow): RacerRow {
  out.slot = raw[0];
  out.x = raw[1] / 100;
  out.y = raw[2] / 100;
  out.z = raw[3] / 100;
  out.yaw = raw[4] / 1000;
  out.vx = raw[5] / 100;
  out.vy = raw[6] / 100;
  out.vz = raw[7] / 100;
  out.yawRate = raw[8] / 1000;
  out.flags = raw[9];
  out.steer = raw[10] / 100;
  out.throttle = raw[11] / 100;
  out.energy = raw[12];
  out.lap = raw[13];
  out.nextCheckpoint = raw[14];
  out.position = raw[15];
  out.trackS = raw[16] / 100;
  out.finishTime = raw[17] < 0 ? null : raw[17] / 1000;
  out.bestLap = raw[18] < 0 ? null : raw[18] / 1000;
  out.driftTicks = raw[19];
  out.road = raw[20];
  return out;
}

export function createRacerRow(): RacerRow {
  return {
    slot: 0,
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    yawRate: 0,
    flags: 0,
    steer: 0,
    throttle: 0,
    energy: 0,
    lap: 0,
    nextCheckpoint: 0,
    position: 0,
    trackS: 0,
    finishTime: null,
    bestLap: null,
    driftTicks: 0,
    road: 0,
  };
}

const SURFACES: readonly VehicleSurface[] = ['road', 'air', 'ground'];
/**
 * Floats travel at full precision (JSON round-trips a double exactly). The client re-bases on
 * this state every snapshot, and an exact copy is what makes its replay bit-identical to the
 * server whenever its inputs arrived on time.
 */
const f = (v: number) => v;
const b = (v: boolean) => (v ? 1 : 0);

/**
 * Everything the client needs to re-run its own car exactly as the server does: the whole
 * vehicle state plus the race bookkeeping that feeds back into driving (reset edge, stuck and
 * wrong-way timers, pad cooldowns, the launch window, checkpoints and laps).
 */
export function packPredictedState(r: RacerState): number[] {
  const v = r.vehicle;
  const out = [
    f(v.x),
    f(v.y),
    f(v.z),
    f(v.yaw),
    f(v.vx),
    f(v.vy),
    f(v.vz),
    f(v.yawRate),
    SURFACES.indexOf(v.surface),
    f(v.throttleLevel),
    v.stoppedTicks,
    f(v.energy),
    b(v.boosting),
    v.boostTicks,
    v.boostLeft,
    v.boostCooldown,
    v.boostQueued,
    b(v.boostHeld),
    v.impulseTicks,
    v.padTicks,
    b(v.inLane),
    b(v.drifting),
    v.driftDir,
    v.driftTicks,
    f(v.driftEarned),
    v.driftRewardCooldown,
    v.recoverTicks,
    v.frozenTicks,
    v.offTrackTicks,
    f(v.safeS),
    v.trackIndex,
    f(v.trackS),
    f(v.lateral),
    f(v.trackFx),
    f(v.trackFz),
    f(v.slope),
    f(v.bank),
    b(v.wallContact),
    f(v.speed),
    f(v.forwardSpeed),
    f(v.lateralSpeed),
    v.overdriveTicks,
    v.laneId,
    f(v.laneMeters),
    v.laneCharged,
    f(v.driftLapEnergy),
    v.road,
    v.splitLane,
    v.funnelLane,
    v.safeRoad,
    // Race bookkeeping.
    r.lap,
    r.nextCheckpoint,
    b(r.started),
    f(r.lapStartTime),
    b(r.finished),
    r.finishTime === null ? -1 : f(r.finishTime),
    b(r.resetHeld),
    r.wrongWayTicks,
    r.stuckTicks,
    r.throttleSinceTick === null ? -1 : r.throttleSinceTick,
    r.bestLapTime === null ? -1 : f(r.bestLapTime),
    r.abilityCooldown[0],
    r.abilityCooldown[1],
    r.abilityCooldown[2],
    r.abilityHeld,
    r.padReadyTick.length,
    ...r.padReadyTick,
  ];
  return out;
}

const PREDICTED_FIXED = 66;

/** Writes a packed state into a racer. Returns false (and changes nothing) if it is malformed. */
export function unpackPredictedState(raw: unknown, r: RacerState): boolean {
  if (!Array.isArray(raw) || raw.length < PREDICTED_FIXED) return false;
  if (!raw.every((n) => typeof n === 'number' && Number.isFinite(n))) return false;
  const a = raw as number[];
  const pads = a[PREDICTED_FIXED - 1];
  if (a.length !== PREDICTED_FIXED + pads || pads !== r.padReadyTick.length) return false;
  const v = r.vehicle;
  let i = 0;
  v.x = a[i++];
  v.y = a[i++];
  v.z = a[i++];
  v.yaw = a[i++];
  v.vx = a[i++];
  v.vy = a[i++];
  v.vz = a[i++];
  v.yawRate = a[i++];
  v.surface = SURFACES[a[i++]] ?? 'road';
  v.throttleLevel = a[i++];
  v.stoppedTicks = a[i++];
  v.energy = a[i++];
  v.boosting = a[i++] === 1;
  v.boostTicks = a[i++];
  v.boostLeft = a[i++];
  v.boostCooldown = a[i++];
  v.boostQueued = a[i++];
  v.boostHeld = a[i++] === 1;
  v.impulseTicks = a[i++];
  v.padTicks = a[i++];
  v.inLane = a[i++] === 1;
  v.drifting = a[i++] === 1;
  v.driftDir = (Math.sign(a[i++]) || 0) as -1 | 0 | 1;
  v.driftTicks = a[i++];
  v.driftEarned = a[i++];
  v.driftRewardCooldown = a[i++];
  v.recoverTicks = a[i++];
  v.frozenTicks = a[i++];
  v.offTrackTicks = a[i++];
  v.safeS = a[i++];
  v.trackIndex = a[i++];
  v.trackS = a[i++];
  v.lateral = a[i++];
  v.trackFx = a[i++];
  v.trackFz = a[i++];
  v.slope = a[i++];
  v.bank = a[i++];
  v.wallContact = a[i++] === 1;
  v.speed = a[i++];
  v.forwardSpeed = a[i++];
  v.lateralSpeed = a[i++];
  v.overdriveTicks = a[i++];
  v.laneId = a[i++];
  v.laneMeters = a[i++];
  v.laneCharged = a[i++];
  v.driftLapEnergy = a[i++];
  v.road = a[i++];
  v.splitLane = a[i++];
  v.funnelLane = a[i++];
  v.safeRoad = a[i++];
  r.lap = a[i++];
  r.nextCheckpoint = a[i++];
  r.started = a[i++] === 1;
  r.lapStartTime = a[i++];
  r.finished = a[i++] === 1;
  const finishTime = a[i++];
  r.finishTime = finishTime < 0 ? null : finishTime;
  r.resetHeld = a[i++] === 1;
  r.wrongWayTicks = a[i++];
  r.stuckTicks = a[i++];
  const since = a[i++];
  r.throttleSinceTick = since < 0 ? null : since;
  const best = a[i++];
  r.bestLapTime = best < 0 ? null : best;
  r.abilityCooldown[0] = a[i++];
  r.abilityCooldown[1] = a[i++];
  r.abilityCooldown[2] = a[i++];
  r.abilityHeld = a[i++];
  i++; // pad count, checked above
  for (let k = 0; k < pads; k++) r.padReadyTick[k] = a[i++];
  r.prevX = v.x;
  r.prevZ = v.z;
  return true;
}

/** Inactive Energy cells as [id, respawnTick, id, respawnTick, …]. */
export function packCells(cells: readonly { active: boolean; respawnTick: number }[]): number[] {
  const out: number[] = [];
  cells.forEach((c, id) => {
    if (!c.active) out.push(id, c.respawnTick);
  });
  return out;
}

export function unpackCells(
  raw: unknown,
  cells: { active: boolean; respawnTick: number }[],
): boolean {
  if (!Array.isArray(raw) || raw.length % 2 !== 0) return false;
  for (const c of cells) {
    c.active = true;
    c.respawnTick = 0;
  }
  for (let i = 0; i < raw.length; i += 2) {
    const id: unknown = raw[i];
    const tick: unknown = raw[i + 1];
    if (typeof id !== 'number' || typeof tick !== 'number' || !cells[id]) return false;
    cells[id].active = false;
    cells[id].respawnTick = tick;
  }
  return true;
}
