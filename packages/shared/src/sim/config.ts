/** Simulation clock. Every timer in the sim is an integer number of ticks. */
export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;

export const ticksFromSeconds = (seconds: number): number => Math.round(seconds * TICK_RATE);

/** Every handling constant in one place. Units are metres, seconds and radians. */
export interface VehicleTuning {
  /** Half the car's width: wall contact distance from the centre. */
  halfWidth: number;
  maxSpeed: number;
  boostMaxSpeed: number;
  /** Top-speed bonus while a free drift or launch impulse runs. */
  impulseSpeedBonus: number;
  engineAccel: number;
  boostAccel: number;
  impulseAccel: number;
  brakeDecel: number;
  reverseAccel: number;
  maxReverseSpeed: number;
  /** Braking to a stop and holding the brake waits this long before reversing. */
  reverseDelayTicks: number;
  /** How fast the engine follows the throttle (full travel per second); smooths key presses. */
  throttleResponse: number;
  coastDecel: number;
  coastDrag: number;
  /** Rate at which speed above the current cap bleeds away (1/s). */
  overspeedDecay: number;
  gravity: number;
  slopeFactor: number;

  maxYawRate: number;
  /** Speed at which steering reaches full authority. */
  steerFullSpeed: number;
  /** Steering authority multiplier at top speed. */
  highSpeedSteer: number;
  yawResponse: number;
  grip: number;
  scrub: number;

  driftMinSpeed: number;
  driftExitSpeed: number;
  driftGrip: number;
  driftScrub: number;
  /** Engine power while drifting: a slide trades straight-line speed for rotation. */
  driftEngine: number;
  driftYawRate: number;
  driftKick: number;
  driftMinSteer: number;
  /** After a drift, grip and steering response blend back to normal over this many ticks. */
  driftRecoveryTicks: number;

  wallRestitution: number;
  wallFriction: number;
  wallScrapeDrag: number;
  wallImpactEvent: number;

  /** First ticks of a boost burst push harder (the "kick"), by this factor. */
  boostKickTicks: number;
  boostKickScale: number;
  /** A burst's thrust ramps in over this many ticks: a shove, never a jump. */
  boostRampTicks: number;

  /** Boost pads: extra thrust and top speed while the pad impulse runs. */
  padAccel: number;
  padSpeedBonus: number;
  /** Speed lanes: a small push and top-speed bonus while driving inside one. */
  laneAccel: number;
  laneSpeedBonus: number;

  /** Overdrive (an ability): top speed and thrust while it runs. Above a boost burst's. */
  overdriveMaxSpeed: number;
  overdriveAccel: number;

  /** How far past an open road edge the car's centre may go before it leaves the road. */
  edgeMargin: number;
  /** Gravity multiplier while airborne: snappier than real falls, so recovery is quick. */
  fallGravity: number;
  airDrag: number;
  /** Off-road (on the ground below the circuit): weak engine, low grip, heavy drag. */
  offRoadEngine: number;
  offRoadGrip: number;
  offRoadDrag: number;
}

export const VEHICLE_TUNING: VehicleTuning = {
  halfWidth: 1.1,
  maxSpeed: 72,
  boostMaxSpeed: 90,
  impulseSpeedBonus: 10,
  engineAccel: 30,
  boostAccel: 26,
  impulseAccel: 18,
  brakeDecel: 45,
  reverseAccel: 12,
  maxReverseSpeed: 14,
  reverseDelayTicks: ticksFromSeconds(0.2),
  throttleResponse: 9,
  coastDecel: 2,
  coastDrag: 0.15,
  overspeedDecay: 0.9,
  gravity: 9.81,
  slopeFactor: 0.6,

  maxYawRate: 1.9,
  steerFullSpeed: 12,
  highSpeedSteer: 0.5,
  yawResponse: 12,
  grip: 7.5,
  scrub: 0.6,

  driftMinSpeed: 22,
  driftExitSpeed: 15,
  driftGrip: 2.2,
  driftScrub: 0.42,
  driftEngine: 0.85,
  driftYawRate: 1.8,
  driftKick: 0.5,
  driftMinSteer: 0.25,
  driftRecoveryTicks: ticksFromSeconds(0.35),

  wallRestitution: 0.25,
  wallFriction: 0.35,
  wallScrapeDrag: 0.4,
  wallImpactEvent: 3,

  boostKickTicks: 15,
  boostKickScale: 1.6,
  boostRampTicks: 4,

  padAccel: 30,
  padSpeedBonus: 14,
  laneAccel: 8,
  laneSpeedBonus: 5,

  overdriveMaxSpeed: 98,
  overdriveAccel: 30,

  edgeMargin: 0.6,
  fallGravity: 1.8,
  airDrag: 0.15,
  offRoadEngine: 0.4,
  offRoadGrip: 2.5,
  offRoadDrag: 1.4,
};

/** Energy economy and race-level rules. */
export interface RaceRules {
  /** Energy never goes below this or above `maxEnergy`. */
  minEnergy: number;
  maxEnergy: number;
  startEnergy: number;
  /** Energy paid up front for one boost burst. */
  boostCost: number;
  /** Length of one burst. */
  boostDurationTicks: number;
  /** After a burst ends, the next one can start after this long. */
  boostCooldownTicks: number;
  /** A press this early (during a burst or its cooldown) is remembered and fires on time. */
  boostBufferTicks: number;
  driftEnergyPerSecond: number;
  /** Minimum slip angle (rad) for a drift to charge Energy. */
  driftChargeSlip: number;
  /** A drift starts charging Energy only once it has lasted this long. */
  driftEnergyDelayTicks: number;
  /** Most Energy one drift can earn. */
  driftEnergyMaxPerDrift: number;
  /** After a drift that earned Energy, the next drift earns nothing for this long. */
  driftEnergyCooldownTicks: number;
  /** Most Energy drifting can earn in one lap, so drifting on a straight cannot farm it. */
  driftEnergyMaxPerLap: number;
  /** Energy for driving a speed lane through, once per lane per lap. */
  laneEnergy: number;
  /** Share of a lane's length a car must cover inside it to earn its Energy. */
  laneChargeFraction: number;
  cellEnergy: number;
  cellRespawnTicks: number;
  cellPickupRadius: number;

  /** Impulse a boost pad gives, and how long that pad then stays inert for the same car. */
  padBoostTicks: number;
  padCooldownTicks: number;

  miniTurboTier1Ticks: number;
  miniTurboTier2Ticks: number;
  miniTurboTier1Impulse: number;
  miniTurboTier2Impulse: number;

  launchWindowTicks: number;
  launchImpulseTicks: number;

  /** Countdown length including the camera lead-in before "3". */
  countdownTicks: number;
  respawnFreezeTicks: number;
  /** Off the road for this long (in the air / on the ground below), the car is respawned. */
  airRespawnTicks: number;
  groundRespawnTicks: number;
  /** Pressing throttle or brake without moving for this long respawns the car (stuck). */
  stuckRespawnTicks: number;
  wrongWayTicks: number;
  /** After the first finisher, the others get this long (multiplayer). */
  finishGraceTicks: number;

  // Abilities. Costs are paid up front; cooldowns are per player and start on use.
  /** Shortcut: opens the branch for everyone, after a short warning, for a while. */
  shortcutCost: number;
  shortcutCooldownTicks: number;
  shortcutOpenDelayTicks: number;
  shortcutOpenTicks: number;
  /** The shortcut flashes this long before it closes. */
  shortcutWarnTicks: number;
  /** After closing, nobody can reopen it for this long. */
  shortcutLockTicks: number;
  /** Gate Shift: switches the split's open lane after a warning; then the gate locks. */
  gateCost: number;
  gateCooldownTicks: number;
  gateWarnTicks: number;
  gateLockTicks: number;
  /** Overdrive: a long, stronger boost for the player's own car. */
  overdriveCost: number;
  overdriveTicks: number;
  overdriveCooldownTicks: number;
}

export const RACE_RULES: RaceRules = {
  minEnergy: 0,
  maxEnergy: 100,
  startEnergy: 40,
  boostCost: 20,
  boostDurationTicks: ticksFromSeconds(1),
  boostCooldownTicks: ticksFromSeconds(0.5),
  boostBufferTicks: ticksFromSeconds(0.25),
  driftEnergyPerSecond: 7,
  driftChargeSlip: 0.15,
  driftEnergyDelayTicks: ticksFromSeconds(0.5),
  driftEnergyMaxPerDrift: 8,
  driftEnergyCooldownTicks: ticksFromSeconds(1.5),
  driftEnergyMaxPerLap: 30,
  laneEnergy: 5,
  laneChargeFraction: 0.75,
  cellEnergy: 12,
  cellRespawnTicks: ticksFromSeconds(5),
  cellPickupRadius: 3,

  padBoostTicks: ticksFromSeconds(0.8),
  padCooldownTicks: ticksFromSeconds(3),

  miniTurboTier1Ticks: ticksFromSeconds(0.9),
  miniTurboTier2Ticks: ticksFromSeconds(2.0),
  miniTurboTier1Impulse: ticksFromSeconds(0.5),
  miniTurboTier2Impulse: ticksFromSeconds(0.9),

  launchWindowTicks: ticksFromSeconds(0.4),
  launchImpulseTicks: ticksFromSeconds(1.2),

  countdownTicks: ticksFromSeconds(5),
  respawnFreezeTicks: ticksFromSeconds(1),
  airRespawnTicks: ticksFromSeconds(0.75),
  groundRespawnTicks: ticksFromSeconds(0.5),
  stuckRespawnTicks: ticksFromSeconds(3),
  wrongWayTicks: ticksFromSeconds(1),
  finishGraceTicks: ticksFromSeconds(25),

  shortcutCost: 45,
  shortcutCooldownTicks: ticksFromSeconds(25),
  shortcutOpenDelayTicks: ticksFromSeconds(0.75),
  shortcutOpenTicks: ticksFromSeconds(8),
  shortcutWarnTicks: ticksFromSeconds(2),
  shortcutLockTicks: ticksFromSeconds(2),
  gateCost: 30,
  gateCooldownTicks: ticksFromSeconds(20),
  gateWarnTicks: ticksFromSeconds(2.5),
  gateLockTicks: ticksFromSeconds(10),
  overdriveCost: 40,
  overdriveTicks: ticksFromSeconds(3),
  overdriveCooldownTicks: ticksFromSeconds(15),
};
