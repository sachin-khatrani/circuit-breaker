import {
  normalizeRoomCode,
  sanitizeNickname,
  type Ack,
  type RaceRacerInfo,
  type RaceRating,
  type RaceResults,
  type RaceStartInfo,
  type RoomState,
  type SeatGrant,
  type SnapshotMessage,
} from '@circuit-breaker/shared';
import { net } from '../net/connection';
import { standingsFromRows } from './online';
import { noteRating, seatTicket } from './profile';
import { session } from './session';
import { loadVehicle, saveNickname, saveVehicle, type VehiclePick } from './settings';
import { OFFLINE, setOnline, useGameStore } from './store';

/**
 * The online flow: rooms, the lobby, and handing races to the session. Everything here only
 * *asks* the server; the room state, races and results shown are always what it sent back.
 */

/** The race the server announced last (kept until the room is back in its lobby). */
let announced: RaceStartInfo | null = null;
/** A race this player is not in (joined late or was not ready): watched from the lobby. */
let watching: { info: RaceStartInfo; bySlot: Map<number, RaceRacerInfo> } | null = null;
let watchedAt = 0;
const WATCH_INTERVAL_MS = 250;

/** The room code in this page's address (`?room=CODE` from an invite link). */
export function invitedRoomCode(): string | null {
  return normalizeRoomCode(new URLSearchParams(window.location.search).get('room'));
}

export function inviteLink(code: string): string {
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('room', code);
  return url.toString();
}

/** Keeps `?room=CODE` in the address bar while seated (a reload resumes, a copy invites). */
function showRoomInAddress(code: string | null): void {
  const url = new URL(window.location.href);
  if (code) url.searchParams.set('room', code);
  else url.searchParams.delete('room');
  window.history.replaceState(window.history.state, '', url);
}

/** Copies text. Falls back to a hidden text field where the Clipboard API is off. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const field = document.createElement('textarea');
    field.value = text;
    field.setAttribute('readonly', '');
    field.style.position = 'fixed';
    field.style.opacity = '0';
    document.body.appendChild(field);
    field.select();
    try {
      return document.execCommand('copy');
    } catch {
      return false;
    } finally {
      field.remove();
    }
  }
}

/** Copies the invite link (the page address with `?room=CODE`). */
export function copyInviteLink(code: string): Promise<boolean> {
  return copyText(inviteLink(code));
}

/** Copies the bare room code, for typing into Join on another device. */
export function copyRoomCode(code: string): Promise<boolean> {
  return copyText(code);
}

// --- Screens ----------------------------------------------------------------------------------

/**
 * Online play starts on the title screen (nickname, Create room, Join). Seated, it opens the
 * lobby; otherwise `intent` decides what the title screen focuses.
 */
export function openMultiplayer(intent: 'create' | 'join' | null = null): void {
  setOnline({ error: null });
  if (useGameStore.getState().online.room) {
    useGameStore.setState({ screen: 'lobby', overlay: 'none' });
  } else {
    useGameStore.setState({ screen: 'menu', overlay: 'none', entryIntent: intent });
  }
}

// --- Seats ------------------------------------------------------------------------------------

/** Checks a typed nickname the way the server will clean it; null (with a message) if unusable. */
function nicknameOrError(raw: string): string | null {
  const name = sanitizeNickname(raw);
  if (!name) {
    setOnline({ error: 'Pick a nickname first (letters and numbers).' });
    return null;
  }
  saveNickname(name);
  useGameStore.setState({ nickname: name });
  return name;
}

async function takeSeat(request: () => Promise<Ack<SeatGrant>>): Promise<boolean> {
  setOnline({ busy: true, error: null });
  let ack: Ack<SeatGrant>;
  try {
    ack = await request();
  } catch {
    ack = { ok: false, error: 'Cannot reach the game server.' };
  }
  if (!ack.ok) {
    setOnline({ busy: false, error: ack.error });
    return false;
  }
  setOnline({
    busy: false,
    error: null,
    room: ack.data.room,
    playerId: ack.data.playerId,
    status: net.status,
  });
  showRoomInAddress(ack.data.room.code);
  showOwnCar(ack.data.room, ack.data.playerId);
  // A race the server announced before this answer (resuming mid-race) starts now.
  if (announced && isRacePhase(ack.data.room.phase)) void enterRace(announced);
  if (useGameStore.getState().screen !== 'race') {
    useGameStore.setState({ screen: 'lobby', overlay: 'none' });
  }
  return true;
}

export async function createRoom(rawName: string): Promise<void> {
  const name = nicknameOrError(rawName);
  if (!name || useGameStore.getState().online.busy) return;
  // The ticket first: it ties the seat to this browser's profile (or the seat races unrated).
  await takeSeat(async () => net.createRoom(name, loadVehicle(), await seatTicket(name)));
}

export async function joinRoom(rawCode: string, rawName: string): Promise<void> {
  const code = normalizeRoomCode(rawCode);
  if (!code) {
    setOnline({ error: 'Room codes are 6 letters and digits.' });
    return;
  }
  const name = nicknameOrError(rawName);
  if (!name || useGameStore.getState().online.busy) return;
  await takeSeat(async () => net.joinRoom(code, name, loadVehicle(), await seatTicket(name)));
}

/** After a reload: take back the seat this tab held, if the server still keeps it. */
export async function resumeStoredSeat(): Promise<boolean> {
  const seat = net.storedSeat;
  if (!seat) return false;
  useGameStore.setState({ screen: 'menu', overlay: 'none' });
  const code = seat.code;
  const ok = await takeSeat(() => net.resume());
  if (!ok) setOnline({ error: `Your seat in room ${code} has expired.` });
  return ok;
}

export async function leaveRoom(): Promise<void> {
  await net.leave();
  forgetRoom(null);
}

function forgetRoom(error: string | null): void {
  announced = null;
  watching = null;
  setOnline({ ...OFFLINE, status: net.status, error });
  showRoomInAddress(null);
  if (session.mode === 'online') session.startAttract('menu');
  else useGameStore.setState({ screen: 'menu', overlay: 'none', menuSince: performance.now() });
  showOwnCar(null, null);
}

/**
 * The car behind the lobby is this player's own, in the colour and style the server gave
 * them (a live preview of the choice); away from a room it is their saved pick.
 */
function showOwnCar(room: RoomState | null, playerId: string | null): void {
  if (session.mode === 'online') return;
  const me = room?.players.find((p) => p.id === playerId);
  const car: VehiclePick = me ? { color: me.color, style: me.style } : loadVehicle();
  const state = useGameStore.getState();
  if (state.carColor !== car.color || state.carStyle !== car.style) {
    useGameStore.setState({ carColor: car.color, carStyle: car.style });
  }
}

// --- Lobby requests (the server checks who may do what) ---------------------------------------

async function lobbyRequest(request: () => Promise<Ack<null>>): Promise<boolean> {
  setOnline({ busy: true, error: null });
  const ack = await request();
  setOnline({ busy: false, error: ack.ok ? null : ack.error });
  return ack.ok;
}

/** The race the screen is showing: lobby and results requests name it (see Room). */
const shownRace = () => useGameStore.getState().online.room?.raceId ?? 0;

export const setReady = (ready: boolean) => lobbyRequest(() => net.setReady(ready, shownRace()));
export const setLaps = (laps: number) => lobbyRequest(() => net.setLaps(laps));
export const startOnlineRace = () => lobbyRequest(() => net.start(shownRace()));
export const raceAgain = () => lobbyRequest(() => net.restart(shownRace()));
export const returnToLobby = () => lobbyRequest(() => net.toLobby(shownRace()));
export const newSession = () => lobbyRequest(() => net.newSession());

/** Picks a car; the choice is also remembered for solo races and the next room. */
export async function pickVehicle(vehicle: VehiclePick): Promise<void> {
  if (await lobbyRequest(() => net.setVehicle(vehicle))) saveVehicle(vehicle);
}

// --- Server messages --------------------------------------------------------------------------

function isRacePhase(phase: RoomState['phase']): boolean {
  return phase === 'countdown' || phase === 'racing' || phase === 'finished';
}

async function enterRace(info: RaceStartInfo): Promise<void> {
  const playerId = net.playerId;
  // Not seated yet (the answer to a resume is still on its way): takeSeat calls back.
  if (!playerId) return;
  // The race timeline is the server's clock: it must be measured first.
  await net.whenClockReady();
  if (announced !== info) return;
  if (!info.racers.some((r) => r.id === playerId)) {
    // Not on this grid (not ready, or arrived late): the race is watched from the lobby.
    watching = { info, bySlot: new Map(info.racers.map((r) => [r.slot, r])) };
    setOnline({ standings: [] });
    if (session.mode === 'online') session.startAttract('lobby');
    else useGameStore.setState({ screen: 'lobby', overlay: 'none' });
    return;
  }
  watching = null;
  // The race fills the screen: the leaderboard or a profile panel closes.
  if (useGameStore.getState().sheet) useGameStore.setState({ sheet: null });
  const current = session.online;
  // Reconnected to the race already on screen: keep it, the next snapshot re-bases the car.
  if (
    session.mode === 'online' &&
    current &&
    current.info.raceId === info.raceId &&
    current.info.startTime === info.startTime &&
    session.playerId === playerId
  ) {
    return;
  }
  setOnline({ results: null, standings: [] });
  session.startOnline(info, playerId);
}

function onRoom(state: RoomState): void {
  setOnline({ room: state });
  if (state.phase === 'waiting' || state.phase === 'ready') {
    // Back in the lobby (the host chose to, or everyone else left): leave the race view.
    announced = null;
    watching = null;
    if (session.mode === 'online') session.startAttract('lobby');
  }
  showOwnCar(state, net.playerId);
}

function onRaceStart(info: RaceStartInfo): void {
  announced = info;
  void enterRace(info);
}

function onSnapshot(snapshot: SnapshotMessage): void {
  if (session.online) {
    session.receiveSnapshot(snapshot);
    return;
  }
  // Watching from the lobby: standings only, a few times a second.
  if (!watching || snapshot.id !== watching.info.raceId) return;
  const now = performance.now();
  if (now - watchedAt < WATCH_INTERVAL_MS) return;
  watchedAt = now;
  setOnline({ standings: standingsFromRows(snapshot.r, watching.bySlot, net.playerId) });
}

function onResults(results: RaceResults): void {
  // Results of a race older than the room's latest are history: nothing to show.
  const room = useGameStore.getState().online.room;
  if (room && results.raceId < room.raceId) return;
  watching = null;
  const rating = useGameStore.getState().online.rating;
  setOnline({
    results,
    standings: [],
    // The rating shown belongs to these results (it follows them from the server).
    rating: rating?.raceId === results.raceId ? rating : null,
  });
  if (session.mode === 'online' && session.online?.info.raceId === results.raceId) {
    session.showOnlineResults();
  }
}

/** A race's global rating: shown with its results; a saved one updates the profile. */
function onRating(rating: RaceRating): void {
  const { results, room } = useGameStore.getState().online;
  const shown = results?.raceId ?? room?.raceId;
  if (shown === undefined || rating.raceId >= shown) setOnline({ rating });
  noteRating(rating, net.playerId);
}

let wired = false;

/** Connects the network client to the store and the session (once). */
export function initMultiplayer(): void {
  if (wired) return;
  wired = true;
  net.on({
    room: onRoom,
    raceStart: onRaceStart,
    snapshot: onSnapshot,
    events: (message) => session.receiveEvents(message),
    results: onResults,
    rating: onRating,
    closed: (reason) => forgetRoom(reason),
    status: (status) => setOnline({ status }),
  });
}
