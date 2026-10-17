/** A point the centre line passes through. Units are metres; `y` is the road surface height. */
export interface TrackControlPoint {
  x: number;
  y: number;
  z: number;
  /** Full road width at this point. */
  width: number;
  /** Bank angle in degrees. Positive lowers the right edge (banked for right-hand turns). */
  bank?: number;
}

export interface EnergyCellDef {
  /** Position along the loop as a control-point parameter: 3.5 is halfway from point 3 to 4. */
  at: number;
  /** Offset from the centre line in metres, positive to the right of the driving direction. */
  lateral: number;
}

export type EdgeSide = 'left' | 'right' | 'both';

/**
 * A stretch with no energy barrier on one or both sides. A car can leave the road there; the
 * race respawns it after a short grace period. Ranges use control-point parameters.
 */
export interface OpenEdgeDef {
  from: number;
  to: number;
  side: EdgeSide;
}

/** A covered stretch: the roof sits `height` metres above the road centre line. */
export interface TunnelDef {
  from: number;
  to: number;
  height: number;
}

/** A glowing pad on the road that gives a short speed impulse to a car driving over it. */
export interface BoostPadDef {
  /** Start of the pad as a control-point parameter. */
  at: number;
  /** Centre offset from the centre line in metres, positive to the right. */
  lateral: number;
  /** Length along the road and full width, in metres. */
  length: number;
  width: number;
}

/**
 * A lane painted along the line a good driver takes (usually a corner exit). Driving inside
 * it gives a small push and top-speed bonus, rewarding the right line.
 */
export interface SpeedLaneDef {
  from: number;
  to: number;
  lateral: number;
  width: number;
}

/**
 * A branch road (a shortcut) that leaves the main loop through an opening in one road edge
 * and rejoins it through a second opening on the same side further on. Each opening is a
 * stretch where the branch runs alongside the main road, sharing its edge, so a car crosses
 * from one road to the other simply by driving over that edge. The entrance can be closed
 * (a barrier); the merge back is always open, so a car inside can never be trapped.
 */
export interface ShortcutDef {
  name: string;
  /** Side of the main road the branch opens from. */
  side: 'left' | 'right';
  /** Main-loop stretch (control-point parameters) where a car can turn in. */
  entry: { from: number; to: number };
  /** Main-loop stretch where the branch merges back. */
  exit: { from: number; to: number };
  /** Full width of the branch road (m). */
  width: number;
  /** Width the branch narrows to at its very end, steering cars into the main road. */
  endWidth: number;
  /** Points the branch passes through between the openings, in world metres. */
  via: { x: number; y: number; z: number }[];
}

/**
 * A stretch split lengthwise by a divider into a left and a right lane. A gate decides which
 * lane is open: before the divider, a funnel barrier closes off the other side.
 */
export interface SplitDef {
  name: string;
  /** Where the divider starts (its nose) and ends, as control-point parameters. */
  from: number;
  to: number;
  /** Length of the funnel before the nose (m). */
  funnel: number;
  /** Width of the divider (m). */
  dividerWidth: number;
}

export interface TrackDefinition {
  id: string;
  name: string;
  /** Closed loop in driving order. Point 0 sits on the start/finish line. */
  points: TrackControlPoint[];
  /** Control-point indices of the checkpoints, increasing. Index 0 (start/finish) comes first. */
  checkpoints: number[];
  energyCells: EnergyCellDef[];
  defaultLaps: number;
  /** Barrier-free stretches. Everything else is walled. */
  openEdges?: OpenEdgeDef[];
  tunnels?: TunnelDef[];
  boostPads?: BoostPadDef[];
  speedLanes?: SpeedLaneDef[];
  /** At most one shortcut branch (the Shortcut ability opens it). */
  shortcuts?: ShortcutDef[];
  /** At most one lane split (the Gate Shift ability switches it). */
  splits?: SplitDef[];
}

/** Interpolated track data at an arc length. */
export interface TrackFrame {
  s: number;
  x: number;
  y: number;
  z: number;
  /** Unit forward direction in the XZ plane. */
  fx: number;
  fz: number;
  /** Unit right direction in the XZ plane. */
  rx: number;
  rz: number;
  /** Vertical component of the 3D unit tangent (sine of the grade). */
  slope: number;
  halfWidth: number;
  /** Bank in radians, positive lowers the right edge. */
  bank: number;
  /** Heading of the forward direction (three.js rotation.y convention). */
  heading: number;
  /** Signed curvature in 1/m, positive for left-hand turns. */
  curvature: number;
}

export interface TrackProjection {
  /** Sample index at the start of the closest centre-line segment. */
  index: number;
  /** Arc length of the closest centre-line point, in [0, length). */
  s: number;
  /** Signed horizontal offset from the centre line, positive to the right. */
  lateral: number;
  halfWidth: number;
  /** Road surface height directly under the projected point. */
  height: number;
  /** Unit forward and right directions at the projection. */
  fx: number;
  fz: number;
  rx: number;
  rz: number;
  slope: number;
  bank: number;
}

/** A start/finish or checkpoint gate: a vertical plane across the road. */
export interface CheckpointGate {
  index: number;
  s: number;
  x: number;
  y: number;
  z: number;
  /** Forward normal of the gate plane (race direction). */
  fx: number;
  fz: number;
  rx: number;
  rz: number;
  halfWidth: number;
}

export interface EnergyCellPlacement {
  id: number;
  s: number;
  lateral: number;
  x: number;
  y: number;
  z: number;
}

/** A boost pad or speed lane resolved onto the track: an s range and a lateral band. */
export interface TrackZone {
  id: number;
  /** Arc length where the zone starts, and its length along the road. */
  s: number;
  length: number;
  /** Centre offset from the centre line, and half the zone's width. */
  lateral: number;
  halfWidth: number;
}

/** A lane split resolved onto the main loop. */
export interface TrackSplit {
  id: number;
  name: string;
  /** Arc length of the divider's nose, and where the divider ends. */
  s: number;
  length: number;
  /** Arc length where the funnel starts (`funnel` metres before the nose). */
  funnelS: number;
  funnel: number;
  /** Half the divider's width: the lanes are |lateral| >= this. */
  divider: number;
}

/** Which way a car crosses an opening between two roads. */
export type PortalKind = 'entry' | 'exit';

/**
 * An opening between the main loop and a branch: a run of main-loop samples whose edge on
 * `side` is shared with a run of branch samples (on the branch's opposite edge).
 */
export interface Portal {
  id: number;
  kind: PortalKind;
  /** Road id of the branch (the main loop is road 0). */
  branch: number;
  /** Side of the main road the opening is on: -1 left, 1 right. */
  side: -1 | 1;
  /** Inclusive sample ranges on the main loop and on the branch. */
  mainFrom: number;
  mainTo: number;
  branchFrom: number;
  branchTo: number;
}

export interface GridSlot {
  slot: number;
  s: number;
  lateral: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
}
