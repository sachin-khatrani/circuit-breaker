import { angleDelta, clamp, clamp01 } from '../math/scalar';
import type { Road, Track } from '../track/track';
import { RACE_RULES, VEHICLE_TUNING, type RaceRules, type VehicleTuning } from './config';
import { gateLaneAt, LEFT_LANE, RIGHT_LANE, shortcutOpenAt, type CourseState } from './course';
import { createInput, type PlayerInput } from './input';
import { steerAuthority, type VehicleState } from './vehicle';

export interface AutopilotOptions {
  /** Multiplies the planned speed profile (1 = limit of grip). */
  pace?: number;
  /** Fire boost bursts on straights and steer over boost pads. */
  boost?: boolean;
  /** Lean toward the inside of upcoming corners instead of following the centre line. */
  racingLine?: boolean;
  /** Constant lane offset in metres (positive = right), added to the racing line. */
  lane?: number;
  /**
   * The changeable track and the current tick: the driver keeps to the gate's open lane and,
   * with `shortcut`, takes the shortcut when it will be open on arrival.
   */
  course?: Readonly<CourseState>;
  tick?: number;
  shortcut?: boolean;
}

const PLANNING_BRAKE = 32; // m/s², below the real 45 to leave a margin
const CORNER_MARGIN = 0.85; // fraction of the steering limit used in corners
const BOOST_LOOKAHEAD = 160; // metres of flat-out road needed before boosting
/** Steer for a boost pad that starts within this distance ahead (metres). */
const PAD_SEEK_DISTANCE = 110;
/** Line up for a split's open lane from this far before its funnel (metres). */
const SPLIT_LOOKAHEAD = 120;
/** Head for the shortcut's entrance from this far before it (metres). */
const SHORTCUT_APPROACH = 160;
/** Before the entrance, the car's centre runs this far inside the edge (its half-width is 1.1), */
const ENTRY_EDGE_MARGIN = 1.6;
/** ...eased over from the racing line, and lined up this far before the entrance (metres). */
const ENTRY_LINED_UP = 50;
/** A car further than this off the line-up has no time left to make the entrance (metres). */
const ENTRY_MAX_LAG = 5;
/** Inside a split lane the car keeps a small speed margin: the lane is narrow. */
const SPLIT_PACE = 0.95;
/** Share of the lane's curvature steered for up front (the aiming point covers the rest). */
const FEEDFORWARD = 0.5;

const profiles = new WeakMap<Road, Map<number, Float64Array>>();

/**
 * Highest speed the car may carry at each sample of a road, from the steering-authority limit
 * in corners and a backward braking pass. `lateral` plans for a line that far right of the
 * centre (a split's lane): curves are tighter on their inside. Cached per road and line.
 */
export function speedProfile(
  road: Road,
  t: VehicleTuning = VEHICLE_TUNING,
  lateral = 0,
): Float64Array {
  let byLine = profiles.get(road);
  if (!byLine) {
    byLine = new Map();
    profiles.set(road, byLine);
  }
  const cached = byLine.get(lateral);
  if (cached) return cached;
  const n = road.count;
  const profile = new Float64Array(n);
  const at = (i: number) => (road.closed ? (i + n) % n : Math.min(n - 1, Math.max(0, i)));
  for (let i = 0; i < n; i++) {
    // Plan on a wider curvature window than the physics uses: the car needs the whole turn.
    let k = 0;
    for (let w = -6; w <= 6; w++) {
      const c = road.curvature[at(i + w)];
      // Curvature of the line `lateral` metres to the right of the centre line.
      k = Math.max(k, Math.abs(c / Math.max(0.2, 1 + c * lateral)));
    }
    profile[i] = k < 1e-4 ? t.boostMaxSpeed : maxCornerSpeed(k, t);
  }
  // Braking constraint, propagated backwards (around the loop twice to settle the wrap).
  for (let pass = 0; pass < (road.closed ? 2 : 1); pass++) {
    for (let i = n - 1; i >= 0; i--) {
      if (!road.closed && i === n - 1) continue;
      const next = profile[(i + 1) % n];
      const reachable = Math.sqrt(next * next + 2 * PLANNING_BRAKE * road.spacing);
      if (reachable < profile[i]) profile[i] = reachable;
    }
  }
  byLine.set(lateral, profile);
  return profile;
}

function maxCornerSpeed(curvature: number, t: VehicleTuning): number {
  const fits = (v: number) => v * curvature <= CORNER_MARGIN * t.maxYawRate * steerAuthority(v, t);
  let lo = t.steerFullSpeed;
  let hi = t.boostMaxSpeed;
  if (fits(hi)) return hi;
  if (!fits(lo)) return lo;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

const target = { x: 0, y: 0, z: 0 };

/**
 * Which split lane to drive: the one the car is committed to, or the open one by the time
 * it reaches the funnel. Null when no split is near.
 */
function splitLane(
  track: Track,
  v: Readonly<VehicleState>,
  course: Readonly<CourseState> | undefined,
  tick: number,
): { lane: number; centre: number; approach: number } | null {
  const split = track.splits[0];
  if (!split || v.road !== 0) return null;
  const toFunnel = track.distanceAhead(v.trackS, split.funnelS);
  const along = track.distanceAhead(split.funnelS, v.trackS);
  const inside = along <= split.funnel + split.length;
  if (!inside && toFunnel > SPLIT_LOOKAHEAD) return null;
  let lane = v.splitLane >= 0 ? v.splitLane : v.funnelLane;
  if (lane < 0) lane = course ? gateLaneAt(course, tick) : RIGHT_LANE;
  const hw = track.halfWidth[Math.floor(split.s / track.spacing) % track.count];
  const centre = ((hw + split.divider) / 2) * (lane === LEFT_LANE ? -1 : 1);
  // 0 → 1 over the approach: fully lined up with the lane by the funnel.
  const approach = inside ? 1 : clamp01(1 - toFunnel / SPLIT_LOOKAHEAD);
  return { lane, centre, approach };
}

/**
 * Pure-pursuit driver. It only produces a PlayerInput, exactly like a human, so bots and the
 * attract mode obey the same physics and validation as players.
 */
export function autopilotInput(
  track: Track,
  v: Readonly<VehicleState>,
  options: AutopilotOptions = {},
  out: PlayerInput = createInput(),
  t: VehicleTuning = VEHICLE_TUNING,
  rules: RaceRules = RACE_RULES,
): PlayerInput {
  const pace = options.pace ?? 1;
  const tick = options.tick ?? 0;
  const road = track.road(v.road);
  const speed = Math.max(0, v.forwardSpeed);
  const lookahead = 10 + speed * 0.45;
  let allowed: number;
  let feedforward = 0;

  if (road.roadId !== 0) {
    // On the shortcut: follow its centre line, then the main road beyond its end.
    const ahead = v.trackS + lookahead;
    if (ahead <= road.length) road.pointAt(ahead, 0, target);
    else {
      const branch = track.branches[road.roadId - 1];
      const s = track.wrapS(branch.exitMainS + branch.exitMainSpan + (ahead - road.length));
      track.pointAt(s, branch.side * (track.halfWidth[0] * 0.3), target);
    }
    const profile = speedProfile(road, t);
    const i = Math.min(road.count - 1, Math.floor(v.trackS / road.spacing) + 2);
    allowed = profile[i] * pace;
  } else {
    const profile = speedProfile(track, t);
    const n = track.count;
    let lateral = options.lane ?? 0;
    if (options.racingLine) {
      const ahead = Math.floor(track.wrapS(v.trackS + lookahead * 1.4) / track.spacing);
      const k = track.curvature[ahead % n];
      const hw = track.halfWidth[ahead % n];
      // Positive curvature turns left, so the inside is to the left (negative lateral).
      lateral += -Math.sign(k) * Math.min(hw * 0.55, Math.abs(k) * 420);
    }
    const lane = splitLane(track, v, options.course, tick);
    if (options.boost) {
      // Line up with a pad ahead and hold its line until the car is across it, unless the pad
      // is on the far side of a split lane coming up (swerving across at speed is no plan).
      for (const pad of track.pads) {
        if (lane && Math.sign(pad.lateral) !== Math.sign(lane.centre)) continue;
        const onPad = track.distanceAhead(pad.s, v.trackS) < pad.length;
        if (onPad || track.distanceAhead(v.trackS, pad.s) < PAD_SEEK_DISTANCE)
          lateral = pad.lateral;
      }
    }
    const i = Math.floor(v.trackS / track.spacing) % n;
    allowed = profile[(i + 3) % n] * pace;
    if (lane) {
      // Ease across to the lane over the approach; inside, plan for the lane's own line
      // (tighter on the inside of the curve) with a small margin: the lane is narrow.
      lateral += (lane.centre - lateral) * lane.approach;
      if (lane.approach >= 1) {
        allowed = speedProfile(track, t, lane.centre)[(i + 3) % n] * pace * SPLIT_PACE;
      }
    }
    track.pointAt(v.trackS + lookahead, lateral, target);
    if (lane && lane.approach >= 1) {
      // Hold the lane's curve: steer for its curvature up front (the aiming point alone lets
      // the car run wide in a long turn), plus a correction toward the lane's centre.
      const k = track.curvature[i];
      const kLane = k / Math.max(0.2, 1 + k * lane.centre);
      const authority = Math.max(0.2, steerAuthority(speed, t));
      feedforward = (-FEEDFORWARD * speed * kLane) / (t.maxYawRate * authority);
      feedforward += clamp((lane.centre - v.lateral) * 0.06, -0.25, 0.25);
    }

    const branch = track.branches[0];
    if (options.shortcut && branch && options.course) {
      const toEntry = track.distanceAhead(v.trackS, branch.entryMainS);
      const intoEntry = track.distanceAhead(branch.entryMainS, v.trackS);
      // Time to the entrance at the current speed, against the time the shortcut is open.
      const arrival =
        tick + Math.ceil(((toEntry < track.length / 2 ? toEntry : 0) / Math.max(10, speed)) * 60);
      const open =
        shortcutOpenAt(options.course, arrival) || shortcutOpenAt(options.course, arrival + 30);
      const inside = intoEntry < branch.entryMainSpan;
      // The line-up: eased from the racing line over to the edge on the shortcut's side. A car
      // far off it (the shortcut opened too late to line up) lets the shortcut go.
      const edge = branch.side * (track.halfWidth[i] - ENTRY_EDGE_MARGIN);
      const u = inside
        ? 1
        : clamp01((SHORTCUT_APPROACH - toEntry) / (SHORTCUT_APPROACH - ENTRY_LINED_UP));
      const lineUp = lateral + (edge - lateral) * u;
      // How far the car is short of the line-up (beyond it, toward the edge, is fine); inside
      // the opening, less and less is allowed as it runs out.
      const short = branch.side * (lineUp - v.lateral);
      const allowance = inside
        ? ENTRY_MAX_LAG * (1 - intoEntry / branch.entryMainSpan)
        : ENTRY_MAX_LAG;
      if (open && (toEntry < SHORTCUT_APPROACH || inside) && short < allowance) {
        // The wall only opens at the entrance: line up along the edge on the shortcut's side,
        // and aim at the shortcut's centre line once inside the opening. Brake for its hairpin
        // in time.
        if (inside) branch.pointAt(intoEntry + lookahead, 0, target);
        else {
          // A longer aim than usual: the line-up crosses most of the road at speed.
          track.pointAt(v.trackS + lookahead * 1.6, lineUp, target);
        }
        const entrySpeed = speedProfile(branch, t)[0] * pace;
        const brakeDistance = toEntry < track.length / 2 ? toEntry : 0;
        allowed = Math.min(
          allowed,
          Math.sqrt(entrySpeed * entrySpeed + 2 * PLANNING_BRAKE * brakeDistance),
        );
      }
    }
  }

  const desired = Math.atan2(target.x - v.x, target.z - v.z);
  const error = angleDelta(v.yaw, desired);
  out.steer = clamp(feedforward - error * 2.4, -1, 1);

  if (speed < allowed - 1.5) {
    out.throttle = 1;
    out.brake = 0;
  } else if (speed > allowed + 2.5) {
    out.throttle = 0;
    out.brake = clamp01((speed - allowed) / 10);
  } else {
    out.throttle = 0.6;
    out.brake = 0;
  }

  // A burst needs a fresh press: press when one can start, release while it runs. Bonuses do
  // not stack, so a burst is not wasted right before a boost pad.
  let clear =
    options.boost === true &&
    road.roadId === 0 &&
    speed > 30 &&
    !v.boosting &&
    v.overdriveTicks === 0 &&
    v.padTicks === 0 &&
    v.boostCooldown === 0 &&
    v.energy >= rules.boostCost;
  if (clear) {
    for (const pad of track.pads) {
      if (track.distanceAhead(v.trackS, pad.s) < PAD_SEEK_DISTANCE + 40) clear = false;
    }
  }
  if (clear) {
    const profile = speedProfile(track, t);
    const n = track.count;
    const i = Math.floor(v.trackS / track.spacing) % n;
    const steps = Math.ceil(BOOST_LOOKAHEAD / track.spacing);
    for (let k = 0; k < steps && clear; k++) {
      if (profile[(i + k) % n] < t.boostMaxSpeed * 0.98) clear = false;
    }
  }
  out.boost = clear && !v.boostHeld;
  out.drift = false;
  out.reset = false;
  out.shortcut = false;
  out.gate = false;
  out.overdrive = false;
  return out;
}
