import type { ReactNode } from 'react';
import { openSheet } from '../../game/profile';
import { useGameStore } from '../../game/store';

/**
 * The title screen's line about the player's profile: name, tag, rating and rank, with the way
 * to the leaderboard and the profile. Shows what the server said, or why there is nothing.
 */
export function ProfileStrip() {
  const profile = useGameStore((s) => s.profile);
  const player = profile.player;
  let text: ReactNode;
  if (profile.status === 'off') {
    text = <span className="text-white/55">Global ranking is off on this server.</span>;
  } else if (player) {
    text = (
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
        <span className="label">Profile</span>
        <span className="truncate font-bold text-white">{player.nickname ?? 'Unnamed'}</span>
        <span className="digits text-xs text-white/40">#{player.tag}</span>
        <span className="digits font-bold text-neon-cyan">{player.rating}</span>
        <span className="digits text-white/70">
          {player.rank === null ? 'not ranked yet' : `#${player.rank}`}
        </span>
      </span>
    );
  } else if (profile.status === 'loading') {
    text = <span className="text-white/55">Reading your profile…</span>;
  } else if (profile.status === 'error') {
    text = (
      <span className="text-white/60">Profiles are unavailable right now. Races still work.</span>
    );
  } else {
    text = (
      <span className="text-white/60">
        No profile yet: your first online race makes one, with a global rating.
      </span>
    );
  }
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-white/10 pt-3 text-sm">
      <div className="min-w-0">{text}</div>
      <div className="flex gap-2">
        <button
          type="button"
          className="chip"
          onClick={() => openSheet({ kind: 'leaderboard' })}
          data-menu-item
        >
          Leaderboard
        </button>
        {profile.status !== 'off' && (
          <button
            type="button"
            className="chip"
            onClick={() => openSheet({ kind: 'profile', id: null })}
            data-menu-item
          >
            {player ? 'Profile' : 'Restore'}
          </button>
        )}
      </div>
    </div>
  );
}
