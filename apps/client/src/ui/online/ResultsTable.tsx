import type { RaceRating, RaceResultEntry, RaceResults } from '@circuit-breaker/shared';
import { formatTime, ordinal } from '../../game/format';
import { deltaClass, signed } from '../ranking/rankingFormat';
import { CarGlyph } from './CarGlyph';

/** What the time column says: the race time, or why there is none. */
function timeOrStatus(entry: RaceResultEntry): string {
  if (entry.finished) return formatTime(entry.totalTime);
  return entry.dnfReason === 'left' ? 'DNF · left' : 'DNF · out of time';
}

/** A car's global rating in this race: its change once saved, or why there is none. */
function ratingOf(
  entry: RaceResultEntry,
  rating: RaceRating,
): { text: string; title: string; className: string } {
  if (rating.status === 'pending' || rating.status === 'retrying') {
    return { text: '…', title: 'Saving the global rating', className: 'text-white/55' };
  }
  const change = rating.entries.find((e) => e.id === entry.id);
  if (rating.status === 'rated' && change) {
    const rank = change.rank === null ? '' : `, #${change.rank} on the leaderboard`;
    return {
      text: signed(change.delta),
      title: `Rating ${change.before} → ${change.after}${rank}`,
      className: deltaClass(change.delta),
    };
  }
  const why = rating.unrated.find((u) => u.id === entry.id)?.reason ?? rating.reason ?? 'Not rated';
  return { text: '—', title: why, className: 'text-white/40' };
}

/**
 * The server's results of one race: place, driver and car, time (or why not), best lap, the
 * points this race gave and the session total with its rank, and (when the race is rated) each
 * car's global rating change. A list, not a wide table, so it fits a phone without scrolling
 * sideways: the best lap, session total and rating move under the name on narrow screens.
 */
export function ResultsTable({
  results,
  playerId,
  rating = null,
}: {
  results: RaceResults;
  playerId: string | null;
  /** The race's global rating (only for the race it belongs to); no column without one. */
  rating?: RaceRating | null;
}) {
  const rated = rating !== null && rating.raceId === results.raceId && rating.status !== 'unrated';
  return (
    <div
      className={`results-list ${rated ? 'results-rated' : ''}`}
      role="table"
      aria-label="Race results"
    >
      <div className="results-row label text-[0.62rem]" role="row">
        <span role="columnheader">Pos</span>
        <span role="columnheader">Driver</span>
        <span role="columnheader" className="text-right">
          Time
        </span>
        <span role="columnheader" className="results-wide text-right">
          Best lap
        </span>
        <span role="columnheader" className="text-right">
          Pts
        </span>
        <span role="columnheader" className="results-wide text-right">
          Session
        </span>
        {rated && (
          <span
            role="columnheader"
            className="results-wide text-right"
            title="Global rating change"
          >
            Rating
          </span>
        )}
      </div>
      {results.entries.map((entry) => {
        const winner = entry.id === results.winnerId;
        const me = entry.id === playerId;
        const change = rated ? ratingOf(entry, rating) : null;
        return (
          <div
            key={entry.id}
            role="row"
            className={`results-row border-t border-white/10 ${
              winner ? 'bg-neon-lime/10' : me ? 'bg-neon-cyan/10' : ''
            }`}
          >
            <span
              role="cell"
              className={`digits text-lg font-black ${winner ? 'text-neon-lime glow-lime' : 'text-white'}`}
            >
              {entry.finished ? ordinal(entry.position) : '—'}
            </span>
            <span role="cell" className="flex min-w-0 items-center gap-1.5 sm:gap-2">
              <CarGlyph
                color={entry.color}
                style={entry.style}
                className="h-4 w-8 sm:h-5 sm:w-10"
              />
              <span className="flex min-w-0 items-center gap-2 text-base font-bold">
                <span className="truncate">{entry.name}</span>
                {me && (
                  <span className="results-wide label text-[0.58rem] text-neon-cyan">you</span>
                )}
              </span>
            </span>
            <span
              role="cell"
              className={`digits text-right ${entry.finished ? 'text-white/90' : 'text-sm text-neon-red'}`}
            >
              {timeOrStatus(entry)}
            </span>
            <span role="cell" className="results-wide digits text-right text-neon-magenta">
              {formatTime(entry.bestLap)}
            </span>
            <span role="cell" className="digits text-right font-bold text-neon-lime">
              +{entry.points}
            </span>
            <span role="cell" className="results-wide digits text-right text-white/85">
              {entry.sessionPoints}
              {entry.sessionRank > 0 && (
                <span className="text-white/50"> #{entry.sessionRank}</span>
              )}
            </span>
            {change && (
              <span
                role="cell"
                className={`results-wide digits text-right font-bold ${change.className}`}
                title={change.title}
              >
                {change.text}
              </span>
            )}
            {/* Narrow screens: best lap, session total and rating on a line of their own. */}
            <span role="cell" className="results-narrow results-extra digits text-xs text-white/55">
              {me && <span className="label mr-2 text-[0.55rem] text-neon-cyan">you</span>}
              Best {formatTime(entry.bestLap)} · session {entry.sessionPoints}
              {entry.sessionRank > 0 && ` (#${entry.sessionRank})`}
              {change && (
                <>
                  {' · rating '}
                  <span className={change.className} title={change.title}>
                    {change.text}
                  </span>
                </>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}
