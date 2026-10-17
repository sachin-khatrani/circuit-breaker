import { PLAYER_COLORS, type RaceRating } from '@circuit-breaker/shared';
import type { CSSProperties } from 'react';
import { formatTime, ordinal } from '../../game/format';
import { openSheet } from '../../game/profile';
import { useGameStore } from '../../game/store';
import { deltaClass, signed } from '../ranking/rankingFormat';
import { AbilityLog } from '../online/AbilityLog';
import { AfterRaceControls } from '../online/AfterRaceControls';
import { CarGlyph } from '../online/CarGlyph';
import { RaceStatsTable } from '../online/RaceStatsTable';
import { ResultsTable } from '../online/ResultsTable';

/** What the global rating of this race is doing, in one line (never "saved" before it is). */
function RatingStatus({
  rating,
  playerId,
}: {
  rating: RaceRating | null;
  playerId: string | null;
}) {
  if (!rating) return null;
  const mine = rating.entries.find((e) => e.id === playerId);
  const myReason = rating.unrated.find((u) => u.id === playerId)?.reason;
  let text: string;
  let tone = 'text-white/75';
  switch (rating.status) {
    case 'pending':
      text = 'Saving global ratings…';
      break;
    case 'retrying':
      text = rating.reason ?? 'Rating pending: retrying.';
      tone = 'text-neon-amber';
      break;
    case 'failed':
      text = rating.reason ?? 'Rating not saved.';
      tone = 'text-neon-red';
      break;
    case 'unrated':
      text = rating.reason ?? 'Unrated race.';
      break;
    case 'rated':
      text = mine
        ? 'Rated race: global ratings saved.'
        : `Rated race: global ratings saved.${myReason ? ` You were not rated (${myReason.toLowerCase()}).` : ''}`;
      tone = 'text-neon-lime';
      break;
  }
  return (
    <div
      className="flex flex-wrap items-center gap-x-4 gap-y-2 border border-white/10 px-3 py-2"
      aria-live="polite"
    >
      <span className={`font-bold ${tone}`}>{text}</span>
      {mine && (
        <span className="digits text-white/85">
          Rating <span className="font-bold text-neon-cyan">{mine.after}</span>{' '}
          <span className={deltaClass(mine.delta)}>({signed(mine.delta)})</span>
          {mine.rank !== null && <span className="text-white/70"> · #{mine.rank} global</span>}
        </span>
      )}
      <button
        type="button"
        className="chip ml-auto"
        onClick={() => openSheet({ kind: 'leaderboard' })}
      >
        Leaderboard
      </button>
    </div>
  );
}

/**
 * Online race results, exactly as the server ranked and scored them: the winner, every car's
 * place, time, points and session total, the global rating once the server has saved it, the
 * race's numbers and abilities, and the ready check for the next race.
 */
export function OnlineResults() {
  const results = useGameStore((s) => s.online.results);
  const playerId = useGameStore((s) => s.online.playerId);
  const storedRating = useGameStore((s) => s.online.rating);
  if (!results) return null;
  const rating = storedRating?.raceId === results.raceId ? storedRating : null;
  const winner = results.entries.find((e) => e.id === results.winnerId);
  const mine = results.entries.find((e) => e.id === playerId);
  const winnerHex = winner ? (PLAYER_COLORS[winner.color] ?? PLAYER_COLORS[0]) : PLAYER_COLORS[0];
  return (
    <div className="absolute inset-0 flex items-start justify-center overflow-y-auto p-3 fade-in sm:p-4">
      <div className="scrim" />
      {/* my-auto centres the panel, yet a panel taller than the screen still scrolls from its top. */}
      <div className="panel scanlines relative my-auto flex w-full max-w-3xl flex-col gap-4 p-4 sm:gap-5 sm:p-7">
        <div>
          <div className="label text-neon-lime">
            Race {results.raceNumber} of session {results.sessionId} · {results.laps}{' '}
            {results.laps === 1 ? 'lap' : 'laps'}
          </div>
          <h2 className="title-logo mt-1 text-4xl sm:text-5xl">RESULTS</h2>
        </div>
        {winner ? (
          <div
            className="winner-card panel relative flex flex-wrap items-center gap-x-5 gap-y-2 px-5 py-4"
            style={{ '--player': winnerHex } as CSSProperties}
          >
            <span className="font-display text-4xl font-black text-neon-amber glow-lime">1ST</span>
            <CarGlyph color={winner.color} style={winner.style} className="h-10 w-20" />
            <div className="min-w-0">
              <div className="label">Winner{winner.id === playerId ? ' · you' : ''}</div>
              <div
                className="truncate font-display text-2xl font-black tracking-[0.08em] uppercase"
                style={{ color: winnerHex, textShadow: `0 0 14px ${winnerHex}` }}
              >
                {winner.name}
              </div>
              <div className="label text-neon-lime">
                +{winner.points} pts · session {winner.sessionPoints}
              </div>
            </div>
            <div className="ml-auto text-right">
              <div className="label">Race time</div>
              <div className="digits text-2xl font-bold text-white glow-cyan">
                {formatTime(winner.totalTime)}
              </div>
              <div className="label text-neon-magenta">Best lap {formatTime(winner.bestLap)}</div>
            </div>
          </div>
        ) : (
          <div className="font-bold text-white/80">Nobody finished this race.</div>
        )}
        {mine && mine.id !== results.winnerId && (
          <div className="font-bold tracking-wide text-white/85">
            {mine.finished
              ? `You finished ${ordinal(mine.position)} of ${results.entries.length} in ${formatTime(mine.totalTime)}: +${mine.points} points.`
              : `You did not finish this race (${mine.dnfReason === 'left' ? 'you left it' : 'out of time'}): no points.`}{' '}
            {mine.sessionRank > 0 &&
              `Session: ${mine.sessionPoints} points, ${ordinal(mine.sessionRank)} place.`}
          </div>
        )}
        <RatingStatus rating={rating} playerId={playerId} />
        <ResultsTable results={results} playerId={playerId} rating={rating} />
        <div className="-mt-2 text-xs text-white/50">
          Points count for this room's session; your rating is global and follows your profile into
          every room.
        </div>
        <details className="results-details" open>
          <summary className="label cursor-pointer select-none">Race stats</summary>
          <div className="mt-2">
            <RaceStatsTable results={results} playerId={playerId} />
          </div>
        </details>
        <details className="results-details">
          <summary className="label cursor-pointer select-none">
            Abilities · {results.abilities.filter((a) => a.ok).length} used
          </summary>
          <div className="mt-2">
            <AbilityLog records={results.abilities ?? []} />
          </div>
        </details>
        <AfterRaceControls />
      </div>
    </div>
  );
}
