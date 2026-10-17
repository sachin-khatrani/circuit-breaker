import type { AbilityDenial, AbilityId } from './course';

/** Why a car was put back on the track: the reset button, leaving the road, or stuck. */
export type RespawnReason = 'manual' | 'offTrack' | 'stuck';

/**
 * Discrete things that happened in a tick. The server will send these reliably; locally they
 * drive HUD banners, sounds and effects. Times are race seconds (0 at GO, sub-tick precise).
 */
export type RaceEvent =
  | { type: 'countdown'; tick: number; count: 3 | 2 | 1 }
  | { type: 'go'; tick: number }
  | { type: 'launchBoost'; tick: number; racerId: string }
  | {
      type: 'checkpoint';
      tick: number;
      racerId: string;
      checkpoint: number;
      /** 1-based lap the checkpoint belongs to. */
      lap: number;
      split: number;
      /** Split at the same checkpoint on the racer's best lap, if any. */
      bestSplit: number | null;
    }
  | {
      type: 'lap';
      tick: number;
      racerId: string;
      /** Laps completed, including this one. */
      lap: number;
      lapTime: number;
      /** True when this lap beat an earlier lap of the same race. */
      improved: boolean;
    }
  | { type: 'finish'; tick: number; racerId: string; position: number; totalTime: number }
  /** `energy` is the racer's Energy after the pickup; `gained` what the cell added. */
  | {
      type: 'cell';
      tick: number;
      racerId: string;
      cellId: number;
      energy: number;
      gained: number;
    }
  /** A boost burst started; `energy` is what is left after paying for it. */
  | { type: 'boost'; tick: number; racerId: string; energy: number }
  /** Boost was pressed without enough Energy for a burst. */
  | { type: 'boostDenied'; tick: number; racerId: string }
  | { type: 'boostPad'; tick: number; racerId: string; padId: number }
  /** A drift that charged Energy ended; `energy` is the total it earned. */
  | { type: 'driftReward'; tick: number; racerId: string; energy: number }
  | {
      type: 'wallHit';
      tick: number;
      racerId: string;
      impact: number;
      x: number;
      y: number;
      z: number;
    }
  | { type: 'driftStart'; tick: number; racerId: string }
  | { type: 'driftEnd'; tick: number; racerId: string; tier: 0 | 1 | 2 }
  | { type: 'respawn'; tick: number; racerId: string; reason: RespawnReason }
  /** A racer left the race for good (multiplayer): DNF. */
  | { type: 'retired'; tick: number; racerId: string }
  | { type: 'raceFinished'; tick: number }
  /** An ability went off; `energy` is what the player has left. */
  | { type: 'ability'; tick: number; racerId: string; ability: AbilityId; energy: number }
  /** An ability press did nothing (and cost nothing). */
  | {
      type: 'abilityDenied';
      tick: number;
      racerId: string;
      ability: AbilityId;
      reason: AbilityDenial;
    }
  /**
   * The shortcut's state changed: announced (`opening`, with the ticks it opens and closes),
   * `open`, about to shut (`closing`), `closed`.
   */
  | {
      type: 'shortcut';
      tick: number;
      phase: 'opening' | 'open' | 'closing' | 'closed';
      openTick: number;
      closeTick: number;
    }
  /** The gate: a switch announced (`warning`, with its tick), then done (`switched`). */
  | {
      type: 'gate';
      tick: number;
      phase: 'warning' | 'switched';
      lane: number;
      switchTick: number;
    }
  | { type: 'overdriveEnd'; tick: number; racerId: string }
  /** A speed lane paid its Energy (once per lane per lap). */
  | {
      type: 'laneCharge';
      tick: number;
      racerId: string;
      laneId: number;
      gained: number;
      energy: number;
    };

export type RaceEventType = RaceEvent['type'];
