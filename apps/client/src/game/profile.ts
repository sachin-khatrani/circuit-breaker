import type { OwnProfile, RaceRating } from '@circuit-breaker/shared';
import { api, ApiError } from '../net/api';
import { useGameStore, type ProfileState, type Sheet } from './store';

/**
 * This browser's persistent profile: read at start, made on the first online race, and the
 * single-use ticket that ties a room seat to it. The server decides everything (ratings,
 * ranks, names); this only asks, and shows what it answers.
 */

function setProfile(change: Partial<ProfileState>): void {
  useGameStore.setState((s) => ({ profile: { ...s.profile, ...change } }));
}

const messageOf = (error: unknown) =>
  error instanceof ApiError ? error.message : 'Cannot reach the game server.';

function failed(error: unknown): void {
  const off = error instanceof ApiError && error.rankingOff;
  setProfile({ status: off ? 'off' : 'error', error: off ? null : messageOf(error) });
}

let loading: Promise<void> | null = null;

/** Reads this browser's profile (at start, and again after a rated race). */
export function loadProfile(): Promise<void> {
  loading ??= (async () => {
    try {
      const me = await api.me();
      if (!me.ranking) setProfile({ status: 'off', player: null, error: null });
      else setProfile({ status: me.player ? 'ready' : 'none', player: me.player, error: null });
    } catch (error) {
      failed(error);
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/**
 * A ticket that ties the next room seat to this browser's profile, which is made now if this
 * is its first online race. The typed nickname becomes the profile's name (within the daily
 * limit). Null when the seat will race unrated: no ranking on this server, or no answer.
 */
export async function seatTicket(nickname: string): Promise<string | null> {
  if (loading) await loading;
  const status = useGameStore.getState().profile.status;
  if (status === 'off') return null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (!useGameStore.getState().profile.player) {
        const made = await api.createIdentity(nickname);
        setProfile({ status: 'ready', player: made.player, error: null });
      }
      const pass = await api.ticket(nickname);
      setProfile({ status: 'ready', player: pass.player, error: null, note: pass.nicknameNote });
      return pass.ticket;
    } catch (error) {
      // This browser's session ended (a new recovery code was made elsewhere): a new profile.
      if (error instanceof ApiError && error.status === 401 && attempt === 0) {
        setProfile({ status: 'none', player: null });
        continue;
      }
      failed(error);
      return null;
    }
  }
  return null;
}

/** Changes the leaderboard name; the error message, or null when done. */
export async function renameProfile(nickname: string): Promise<string | null> {
  try {
    const { player } = await api.rename(nickname);
    setProfile({ player, note: null, error: null });
    return null;
  } catch (error) {
    return messageOf(error);
  }
}

/** A new recovery code (shown once); the old one stops working. */
export async function makeRecoveryCode(): Promise<string> {
  const { code, player } = await api.recoveryCode();
  setProfile({ player });
  return code;
}

/** Signs this browser into the profile a recovery code belongs to; an error message or null. */
export async function restoreProfile(code: string): Promise<string | null> {
  try {
    const { player } = await api.recover(code);
    setProfile({ status: 'ready', player, error: null, note: null });
    useGameStore.setState((s) => ({ ratingSerial: s.ratingSerial + 1 }));
    return null;
  } catch (error) {
    return messageOf(error);
  }
}

/**
 * A race's rating as the server confirmed it: this player's new rating and rank show at once,
 * and the rest of the profile (wins, best lap) is read again.
 */
export function noteRating(rating: RaceRating, seatId: string | null): void {
  if (rating.status !== 'rated') return;
  useGameStore.setState((s) => ({ ratingSerial: s.ratingSerial + 1 }));
  const mine = seatId ? rating.entries.find((e) => e.id === seatId) : undefined;
  const player = useGameStore.getState().profile.player;
  if (mine && player && player.id === mine.profileId) {
    const updated: OwnProfile = {
      ...player,
      rating: mine.after,
      peakRating: Math.max(player.peakRating, mine.after),
      rank: mine.rank ?? player.rank,
    };
    setProfile({ player: updated });
  }
  void loadProfile();
}

// --- Sheets ------------------------------------------------------------------------------------

export function openSheet(sheet: Sheet): void {
  useGameStore.setState({ sheet });
}

export function closeSheet(): void {
  // Closing restarts the title screen's quick-start grace period, like any other overlay.
  useGameStore.setState({ sheet: null, menuSince: performance.now() });
}
