import {
  createRacerRow,
  createRemoteSample,
  encodeInputPacket,
  FLAG_FINISHED,
  FLAG_OFFLINE,
  FLAG_RETIRED,
  INPUT_REDUNDANCY,
  INPUT_SEND_INTERVAL,
  InputLead,
  packInputFrame,
  Predictor,
  RemoteDelay,
  remoteDelayMs,
  RemoteTrack,
  TICK_RATE,
  unpackCells,
  unpackCourse,
  unpackRacerRow,
  type EventsMessage,
  type InputFrame,
  type RaceEvent,
  type RaceRacerInfo,
  type RaceStartInfo,
  type RacerRow,
  type Reconciliation,
  type RemoteSample,
  type SnapshotMessage,
  type Track,
} from '@circuit-breaker/shared';
import type { NetClient } from '../net/connection';

const TICK_MS = 1000 / TICK_RATE;
/** Behind the server by more than this many ticks, wait for a snapshot to jump instead. */
const RESYNC_TICKS = 90;
/**
 * With no snapshot for this long (ticks, beyond the input lead), the link is gone rather than
 * slow: the car stops instead of driving on where the server cannot follow.
 */
const STALL_TICKS = 60;
/**
 * Snapshots kept waiting for the next frame. A hidden tab draws no frames but still receives
 * snapshots: without a cap they piled up (20 a second) until the tab came back. Only the newest
 * re-bases the car, and remote cars are drawn from recent history, so a second's worth is plenty.
 */
const MAX_PENDING = 20;

/** Events the local prediction reports at once: feedback the driver must feel immediately. */
const PREDICTED = new Set<RaceEvent['type']>([
  'countdown',
  'go',
  'launchBoost',
  'boost',
  'boostDenied',
  'boostPad',
  'cell',
  'driftStart',
  'driftEnd',
  'driftReward',
  'wallHit',
  'respawn',
  // The local car's own abilities: the press is felt at once (the server confirms or not).
  'ability',
  'abilityDenied',
  'overdriveEnd',
  'laneCharge',
]);
/** Race outcomes for the local car: only the server's word counts. */
const AUTHORITATIVE = new Set<RaceEvent['type']>(['checkpoint', 'lap', 'finish', 'retired']);
/** Announcements for the race feed: who used what, and the track changing. Server's word only. */
const FEED = new Set<RaceEvent['type']>(['ability', 'abilityDenied', 'shortcut', 'gate']);

export interface Standing {
  id: string;
  name: string;
  color: number;
  position: number;
  /** Completed laps. */
  lap: number;
  finished: boolean;
  retired: boolean;
  offline: boolean;
  finishTime: number | null;
  me: boolean;
}

export interface RemoteCar {
  readonly id: string;
  readonly name: string;
  readonly color: number;
  /** Body style (VEHICLE_STYLES index): cosmetic only. */
  readonly style: number;
  readonly sample: RemoteSample;
  /** False until the first snapshot for this car arrived. */
  visible: boolean;
}

export type EventSink = (event: RaceEvent) => void;

const scratchRow = createRacerRow();

/** Standings from a snapshot's rows, best first. */
export function standingsFromRows(
  rows: readonly number[][],
  bySlot: ReadonlyMap<number, RaceRacerInfo>,
  playerId: string | null,
  each?: (row: RacerRow, who: RaceRacerInfo) => void,
): Standing[] {
  const standings: Standing[] = [];
  for (const raw of rows) {
    const row = unpackRacerRow(raw, scratchRow);
    const who = bySlot.get(row.slot);
    if (!who) continue;
    each?.(row, who);
    standings.push({
      id: who.id,
      name: who.name,
      color: who.color,
      position: row.position,
      lap: row.lap,
      finished: (row.flags & FLAG_FINISHED) !== 0,
      retired: (row.flags & FLAG_RETIRED) !== 0,
      offline: (row.flags & FLAG_OFFLINE) !== 0,
      finishTime: row.finishTime,
      me: who.id === playerId,
    });
  }
  return standings.sort((a, b) => a.position - b.position);
}

/**
 * One online race on the client. The local car is predicted (shared Predictor) and re-based
 * on every snapshot; inputs go out stamped with their tick, far enough ahead (InputLead) to
 * reach the server before that tick runs. Other cars are drawn from their snapshot history a
 * little in the past (RemoteTrack). Standings, laps, finish order and results are the server's.
 */
export class OnlineRace {
  readonly predictor: Predictor;
  readonly lead = new InputLead();
  readonly remotes: RemoteCar[];
  standings: Standing[] = [];
  /** The server's latest row for the local car (laps, position, best lap). */
  myRow: RacerRow | null = null;
  /** Corrections applied so far, and the largest (m): for the debug readout. */
  corrections = 0;
  largestCorrection = 0;
  /** Server stopped the race (results are in): stop predicting and sending. */
  ended = false;
  /** performance.now() when the last snapshot arrived (for the connection warning). */
  lastSnapshotAt = performance.now();
  private readonly tracks = new Map<string, RemoteTrack>();
  private readonly bySlot = new Map<number, RaceRacerInfo>();
  private readonly pending: SnapshotMessage[] = [];
  /** Other cars' events, held until the moment they are drawn at (they are drawn in the past). */
  private readonly remoteEvents: RaceEvent[] = [];
  private lastSentTick = 0;
  private lastSnapshotTick = 0;
  private synced: boolean;
  private readonly delay = new RemoteDelay();
  private lastDrawn = performance.now();

  constructor(
    readonly track: Track,
    readonly info: RaceStartInfo,
    readonly playerId: string,
    private readonly net: NetClient,
    private readonly emitLocal: EventSink,
    private readonly emitRemote: EventSink,
    private readonly emitFeed: EventSink,
  ) {
    this.predictor = new Predictor(track, info, playerId);
    this.lead.fromRtt(net.clock.rtt || 100, net.clock.jitter, TICK_MS);
    for (const r of info.racers) this.bySlot.set(r.slot, r);
    this.remotes = info.racers
      .filter((r) => r.id !== playerId)
      .map((r) => ({
        id: r.id,
        name: r.name,
        color: r.color,
        style: r.style,
        sample: createRemoteSample(),
        visible: false,
      }));
    for (const car of this.remotes) this.tracks.set(car.id, new RemoteTrack());
    // Joining a race already under way: wait for a snapshot instead of simulating from zero.
    this.synced = this.serverTick(performance.now()) < RESYNC_TICKS;
  }

  /** The server's tick right now (fractional), from the synced clock. */
  serverTick(now: number): number {
    return (this.net.clock.serverNow(now) - this.info.startTime) / TICK_MS;
  }

  /** The tick the local prediction should be at: the server's tick plus the input lead. */
  targetTick(now: number): number {
    return this.serverTick(now) + this.lead.lead;
  }

  /** May the prediction run up to `target`, or must it wait for a snapshot to catch up? */
  canPredict(target: number): boolean {
    if (this.ended) return false;
    if (!this.synced) return false;
    if (this.predictor.tick - this.lastSnapshotTick > this.lead.lead + STALL_TICKS) return false;
    return target - this.predictor.tick < RESYNC_TICKS * 4;
  }

  receiveSnapshot(snapshot: SnapshotMessage): void {
    // Anything from another race (one that has ended) is not about this one.
    if (snapshot.id !== this.info.raceId) return;
    this.pending.push(snapshot);
    if (this.pending.length > MAX_PENDING)
      this.pending.splice(0, this.pending.length - MAX_PENDING);
    this.lastSnapshotAt = performance.now();
  }

  /**
   * Server events: announcements for the feed (abilities, track changes), the local car's race
   * outcomes, and everything visible about other cars.
   */
  receiveEvents(message: EventsMessage): void {
    if (message.id !== this.info.raceId) return;
    for (const event of message.e) {
      if (FEED.has(event.type)) this.emitFeed(event);
      if (!('racerId' in event)) {
        // Track changes are shown from the track state itself; the feed has them too.
        if (event.type !== 'shortcut' && event.type !== 'gate') this.emitLocal(event);
      } else if (event.racerId === this.playerId) {
        if (AUTHORITATIVE.has(event.type)) this.emitLocal(event);
      } else {
        // Someone else took a cell: it is gone for the local car too, right away (the next
        // snapshot brings its respawn time).
        if (event.type === 'cell') {
          const cell = this.predictor.sim.cells[event.cellId];
          if (cell) {
            cell.active = false;
            cell.respawnTick = Number.MAX_SAFE_INTEGER;
          }
        }
        this.remoteEvents.push(event);
      }
    }
    if (this.remoteEvents.length > 256) this.remoteEvents.splice(0, this.remoteEvents.length - 256);
  }

  /** Predicted events of a freshly simulated tick: only immediate driving feedback. */
  forwardPredicted(events: RaceEvent[]): void {
    for (const event of events) if (PREDICTED.has(event.type)) this.emitLocal(event);
  }

  /**
   * Applies the snapshots that arrived since the last frame: remote car history, standings,
   * and a re-base of the local prediction. Returns the latest re-base (null if none).
   */
  applySnapshots(): Reconciliation | null {
    let latest: Reconciliation | null = null;
    for (const snapshot of this.pending) {
      this.lastSnapshotTick = Math.max(this.lastSnapshotTick, snapshot.t);
      this.applyRows(snapshot);
      // After the end only the standings still matter: the car stays where it stopped.
      if (snapshot.me && !this.ended) {
        const rec = this.predictor.reconcile(snapshot.t, snapshot.me, snapshot.c, snapshot.k);
        if (rec) {
          // The first re-base after joining a race under way is the car arriving, not an error.
          const counted = this.synced;
          this.synced = true;
          latest = rec;
          if (counted && rec.error > 0.001) {
            this.corrections++;
            this.largestCorrection = Math.max(this.largestCorrection, rec.error);
          }
        }
        this.lead.feedback(snapshot.b ?? 0, snapshot.m ?? 0, performance.now(), this.net.clock.rtt);
      } else {
        unpackCells(snapshot.c, this.predictor.sim.cells);
        // Watching (or out of the race): the track still changes for everyone else.
        unpackCourse(snapshot.k, this.predictor.sim.course);
        if (snapshot.t > this.predictor.sim.tick) this.predictor.sim.tick = snapshot.t;
      }
    }
    this.pending.length = 0;
    return latest;
  }

  /**
   * Sends the recorded inputs every few ticks, each packet repeating the last few frames.
   * `now` sends at once (a fresh ability press: a slow frame must not hold it past its tick).
   */
  sendInputs(now = false): void {
    const tick = this.predictor.tick;
    if (!now && tick - this.lastSentTick < INPUT_SEND_INTERVAL) return;
    const first = Math.max(1, tick - INPUT_REDUNDANCY + 1);
    const frames: InputFrame[] = [];
    for (let k = first; k <= tick; k++) {
      const input = this.predictor.inputFor(k);
      frames.push(input ? packInputFrame(input) : [0, 0, 0, 0]);
    }
    this.net.sendInput(encodeInputPacket(this.info.raceId, first, frames));
    this.lastSentTick = tick;
  }

  /** Moves every remote car to its interpolated place for this frame. */
  updateRemotes(now: number): void {
    const clock = this.net.clock;
    const target = remoteDelayMs(this.info.snapshotRate, clock.rtt, clock.jitter);
    const delayMs = this.delay.update(target, now - this.lastDrawn);
    this.lastDrawn = now;
    const renderTick = this.serverTick(now) - delayMs / TICK_MS;
    for (const car of this.remotes) {
      // Once the race is over nothing new arrives: stop at the last known place.
      const result = this.tracks.get(car.id)!.sample(renderTick, car.sample, this.ended ? 0 : 9);
      car.visible = result !== 'none' && (car.sample.flags & FLAG_RETIRED) === 0;
    }
    const events = this.remoteEvents;
    let due = 0;
    while (due < events.length && (this.ended || events[due].tick <= renderTick)) due++;
    if (due > 0) for (const event of events.splice(0, due)) this.emitRemote(event);
  }

  private applyRows(snapshot: SnapshotMessage): void {
    this.standings = standingsFromRows(snapshot.r, this.bySlot, this.playerId, (row, who) => {
      if (who.id === this.playerId) this.myRow = { ...row };
      else this.tracks.get(who.id)?.push(snapshot.t, row);
    });
  }
}
