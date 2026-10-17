import type {
  BoostPadDef,
  EnergyCellDef,
  ShortcutDef,
  SpeedLaneDef,
  SplitDef,
  TrackControlPoint,
  TrackDefinition,
} from '../types';

// Grid Zero: a night circuit around the reactor district.
// Driving order, x east, z south, y up. Mostly right-handers (clockwise on a map).
// Sections: main straight → T1 sweeper → the Esses → Skyway climb and the banked Overload
// hairpin → the Canyon back straight → West hairpin → the Switchback → return to the line.
// Plan coordinates are authored on a loose grid and scaled so a lap is about 3 km.
const PLAN_SCALE = 0.8;
const P = (x: number, y: number, z: number, width: number, bank = 0): TrackControlPoint => ({
  x: x * PLAN_SCALE,
  y,
  z: z * PLAN_SCALE,
  width,
  bank,
});

const points: TrackControlPoint[] = [
  P(0, 0, 0, 26), //               0  start / finish
  P(170, 0, 0, 26),
  P(330, 0, 2, 24),
  P(450, 0, 32, 22, 5), //          3  T1 entry
  P(522, 0, 108, 22, 7),
  P(545, 0, 215, 22, 3), //         5  T1 exit (checkpoint 1)
  P(512, 0, 312, 20),
  P(430, 0, 362, 20, -3), //        7  the Esses
  P(388, 0, 440, 20, 3),
  P(420, 1, 525, 20),
  P(520, 6, 575, 22), //            10 Skyway climb
  P(645, 14, 592, 22),
  P(752, 18, 625, 24, 10), //       12 Overload hairpin (banked)
  P(800, 18, 708, 24, 14),
  P(770, 18, 795, 24, 12), //       14 apex exit (checkpoint 2)
  P(668, 15, 828, 22, 4),
  P(520, 7, 838, 22),
  P(345, 0, 842, 22), //            17 Canyon straight
  P(165, 0, 840, 22),
  P(10, 0, 822, 22, 3),
  P(-110, 0, 768, 22, 9), //        20 West hairpin
  P(-160, 0, 665, 22, 7),
  P(-145, 0, 550, 20, 2), //        22 checkpoint 3
  P(-62, 0, 488, 20, 3),
  P(30, 0, 457, 20),
  // 25-29 the Switchback: a left hairpin laid on a true semicircle (r 36 before scaling),
  // so the curvature stays even instead of peaking at one control point.
  P(85, 0, 457, 20, -4),
  P(110.5, 0, 446.5, 20, -8),
  P(121, 0, 421, 20, -9),
  P(110.5, 0, 395.5, 20, -8),
  P(85, 0, 385, 20, -4),
  P(10, 0, 372, 20),
  P(-140, 0, 262, 20, 4), //        31 right kink
  P(-178, 0, 160, 22, 5),
  P(-160, 0, 62, 24, 4),
  P(-90, 0, 8, 26, 2), //           34 back onto the line
];

const line = (at: number, lateral: number, count: number, step: number): EnergyCellDef[] =>
  Array.from({ length: count }, (_, i) => ({ at: at + i * step, lateral }));

const row = (at: number, laterals: number[]): EnergyCellDef[] =>
  laterals.map((lateral) => ({ at, lateral }));

const energyCells: EnergyCellDef[] = [
  ...line(0.55, 0, 3, 0.08), //                 main straight, on the racing line
  ...line(3.55, 7.5, 3, 0.12), //               T1 inside apex, tight to the wall
  ...row(6.5, [-5]),
  ...row(7.5, [5]),
  ...row(8.5, [-5]), //                         the Esses, alternating
  ...line(10.4, 0, 3, 0.12), //                 Skyway climb
  ...line(12.7, 9, 4, 0.12), //                 Overload hairpin inside apex (risky)
  ...row(17.6, [-7, 0, 7]), //                  Canyon straight: pick a lane
  ...row(18.6, [-7, 0, 7]),
  ...line(20.3, 7.5, 3, 0.15), //               West hairpin inside
  ...line(23.6, 0, 2, 0.15),
  ...line(26.4, -6, 3, 0.4), //                 Switchback inside (left-hander)
  ...row(31.5, [5]),
  ...line(33.3, 0, 3, 0.1), //                  run back to the line
];

// Three pads, each a line choice on a straight: the outside entry to T1, the right half of the
// barrier-free Skyway (faster than the cells down the middle, but nearer the open edge), and a
// push into the Ion Tunnel.
const boostPads: BoostPadDef[] = [
  { at: 0.9, lateral: -6, length: 12, width: 5 },
  { at: 10.75, lateral: 5, length: 12, width: 5 },
  { at: 16.85, lateral: 6, length: 12, width: 5 },
];

// Speed lanes on the exits of the three slowest corners, along the line that tracks out to
// the outside edge: the Esses onto the Skyway climb, the Overload hairpin, the Switchback.
const speedLanes: SpeedLaneDef[] = [
  { from: 9.15, to: 9.85, lateral: 2.5, width: 4.5 },
  // The outside lane of the Overload split (see `splits`): the fast line when it is open.
  { from: 12.35, to: 13.85, lateral: -7, width: 4.5 },
  { from: 14.3, to: 15.05, lateral: -3.5, width: 4.5 },
  { from: 29.3, to: 30.0, lateral: 3.5, width: 4.5 },
];

// The Needle: a narrow shortcut across the inside of the Switchback. It leaves the entry
// straight through an opening in the left edge, turns a tight hairpin of its own (radius about
// 17.5 m, against the Switchback's 29 m) and merges back on the left of the exit straight.
// Much shorter, but the hairpin has to be taken slowly. No checkpoint lies on the stretch it
// bypasses. Via points are world metres (already scaled).
const NEEDLE_CENTRE = { x: 21, z: 334.25 };
const NEEDLE_RADIUS = 17.6;
const needleVia = [30, 60, 90, 120, 150].map((deg) => {
  const a = (deg * Math.PI) / 180;
  return {
    x: NEEDLE_CENTRE.x + NEEDLE_RADIUS * Math.sin(a),
    y: 0.1,
    z: NEEDLE_CENTRE.z + NEEDLE_RADIUS * Math.cos(a),
  };
});
const shortcuts: ShortcutDef[] = [
  {
    name: 'The Needle',
    side: 'left',
    entry: { from: 23.55, to: 24.0 },
    exit: { from: 29.68, to: 30.05 },
    width: 8,
    endWidth: 2.5,
    via: needleVia,
  },
];

// The Overload split: a divider down the banked hairpin. The inside lane is shorter and holds
// the Energy cells; the outside lane is longer but faster, with a speed lane. A funnel before
// the divider closes whichever lane the gate has shut.
const splits: SplitDef[] = [
  { name: 'Overload split', from: 12.15, to: 14.1, funnel: 36, dividerWidth: 3 },
];

export const GRID_ZERO: TrackDefinition = {
  id: 'grid-zero',
  name: 'Grid Zero',
  points,
  checkpoints: [0, 5, 14, 22],
  energyCells,
  boostPads,
  speedLanes,
  shortcuts,
  splits,
  defaultLaps: 3,
  // The Skyway straights have no barriers: a long way down if you run wide.
  openEdges: [
    { from: 10.3, to: 11.7, side: 'both' },
    { from: 15.35, to: 16.5, side: 'both' },
  ],
  // The Canyon straight runs through a covered ion tunnel.
  tunnels: [{ from: 17.15, to: 18.85, height: 8.5 }],
};
