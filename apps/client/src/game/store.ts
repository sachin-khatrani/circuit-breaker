import type {
  OwnProfile,
  RacePhase,
  RaceRating,
  RaceResults as ServerResults,
  RoomState,
} from '@circuit-breaker/shared';
import { create } from 'zustand';
import type { NetStatus } from '../net/connection';
import type { Standing } from './online';
import type { TrackRecord } from './records';
import {
  loadAudioSettings,
  loadMotionSetting,
  loadNickname,
  loadQuality,
  loadVehicle,
  resolveReducedMotion,
  type MotionSetting,
  type Quality,
} from './settings';

export type Screen = 'menu' | 'lobby' | 'race';
/** `raceMenu` is the online race's menu: the race keeps running underneath it. */
export type Overlay = 'none' | 'pause' | 'results' | 'controls' | 'raceMenu';
export type RaceKind = 'solo' | 'online';
/** 3, 2, 1, then 0 for "GO"; null when nothing is shown. */
export type CountdownValue = 3 | 2 | 1 | 0 | null;
/**
 * A panel over whatever is on screen (menu, lobby or results): the global leaderboard, or a
 * profile (null: this browser's own).
 */
export type Sheet = { kind: 'leaderboard' } | { kind: 'profile'; id: string | null };

/** This browser's persistent profile, as the server last described it. */
export interface ProfileState {
  /**
   * `loading` at first; `off` when the server has no ranking; `none` before the first online
   * race (a profile is made then); `ready`; `error` when profiles cannot be reached.
   */
  status: 'loading' | 'off' | 'none' | 'ready' | 'error';
  player: OwnProfile | null;
  error: string | null;
  /** Why the typed nickname did not become the leaderboard name (the daily limit). */
  note: string | null;
}

export interface RaceResults {
  totalTime: number;
  lapTimes: number[];
  bestLap: number;
  topSpeed: number;
  /** Race distance over race time, m/s. */
  averageSpeed: number;
  cellsCollected: number;
  energyGained: number;
  driftTime: number;
  boostTime: number;
  /** Boost bursts fired and boost pads hit. */
  boosts: number;
  padsHit: number;
  /** Abilities used (successfully), Energy from speed lanes, and runs through the shortcut. */
  shortcuts: number;
  gateShifts: number;
  overdrives: number;
  shortcutRuns: number;
  laneEnergy: number;
  wallHits: number;
  respawns: number;
  /** Respawns caused by leaving the track. */
  falls: number;
  newBestTotal: boolean;
  newBestLap: boolean;
  previous: TrackRecord;
}

/** Everything about the online room, as the server last described it. */
export interface OnlineState {
  status: NetStatus;
  room: RoomState | null;
  /** This player's public id in the room (null when not seated). */
  playerId: string | null;
  /** A request in flight (create, join, start…): buttons wait for it. */
  busy: boolean;
  /** The last refusal or connection problem, shown in the lobby screens. */
  error: string | null;
  /** The server's results of the last race in this room. */
  results: ServerResults | null;
  /** Live standings of the race being run (updated a few times a second). */
  standings: Standing[];
  /** The global rating of the race whose results are shown: pending, saved, or why not. */
  rating: RaceRating | null;
}

/**
 * Discrete UI state only. Per-frame values (speed, Energy, timers) are read straight from the
 * session in animation-frame hooks so React never re-renders at 60 Hz.
 */
export interface GameState {
  screen: Screen;
  overlay: Overlay;
  raceKind: RaceKind;
  /** Bumped whenever a new race (or the attract loop) is put on screen. */
  raceSerial: number;
  /** Colour (PLAYER_COLORS) and body style (VEHICLE_STYLES) of the local car. */
  carColor: number;
  carStyle: number;
  phase: RacePhase;
  countdown: CountdownValue;
  /** 1-based lap shown on the HUD. */
  lap: number;
  totalLaps: number;
  /** 1-based standing and field size (1/1 in solo races). */
  position: number;
  racerCount: number;
  bestLap: number | null;
  wrongWay: boolean;
  /** The car has left the road and is about to be respawned. */
  offTrack: boolean;
  rebooting: boolean;
  results: RaceResults | null;
  record: TrackRecord;
  quality: Quality;
  /** The player's motion choice, and whether motion is reduced right now (resolved). */
  motion: MotionSetting;
  reducedMotion: boolean;
  /** Master volume 0..1 and mute; sound starts only after the first key press or click. */
  volume: number;
  muted: boolean;
  /** performance.now() when the title screen last became interactive (quick-start guard). */
  menuSince: number;
  /** The nickname typed for online play (kept between visits). */
  nickname: string;
  /** Which online action the title screen asked for: it decides what has focus first. */
  entryIntent: 'create' | 'join' | null;
  online: OnlineState;
  profile: ProfileState;
  sheet: Sheet | null;
  /** Bumped when a race's rating is saved: open leaderboards and profiles reload. */
  ratingSerial: number;
}

export const OFFLINE: OnlineState = {
  status: 'offline',
  room: null,
  playerId: null,
  busy: false,
  error: null,
  results: null,
  standings: [],
  rating: null,
};

export const useGameStore = create<GameState>()(() => ({
  screen: 'menu',
  overlay: 'none',
  raceKind: 'solo',
  raceSerial: 0,
  carColor: loadVehicle().color,
  carStyle: loadVehicle().style,
  phase: 'countdown',
  countdown: null,
  lap: 1,
  totalLaps: 3,
  position: 1,
  racerCount: 1,
  bestLap: null,
  wrongWay: false,
  offTrack: false,
  rebooting: false,
  results: null,
  record: { bestTotal: null, bestLap: null },
  quality: loadQuality(),
  motion: loadMotionSetting(),
  reducedMotion: resolveReducedMotion(loadMotionSetting()),
  volume: loadAudioSettings().volume,
  muted: loadAudioSettings().muted,
  menuSince: performance.now(),
  nickname: loadNickname(),
  entryIntent: null,
  online: OFFLINE,
  profile: { status: 'loading', player: null, error: null, note: null },
  sheet: null,
  ratingSerial: 0,
}));

/** Merges a change into the online slice. */
export function setOnline(change: Partial<OnlineState>): void {
  useGameStore.setState((s) => ({ online: { ...s.online, ...change } }));
}
