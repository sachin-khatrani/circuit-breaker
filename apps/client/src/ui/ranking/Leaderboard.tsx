import type { LeaderboardEntry, LeaderboardResponse } from '@circuit-breaker/shared';
import { useEffect, useState } from 'react';
import { closeSheet, openSheet } from '../../game/profile';
import { useGameStore } from '../../game/store';
import { api, ApiError } from '../../net/api';
import { RatingRules } from './RatingRules';
import { count, winRate, WIN_RATE_MIN_RACES } from './rankingFormat';

const PAGE = 25;
/** The headline list: pages within it are offered as buttons. */
const TOP = 100;

type View =
  | { status: 'loading' }
  | { status: 'page'; page: LeaderboardResponse }
  | { status: 'search'; entries: LeaderboardEntry[] }
  | { status: 'error'; message: string; off: boolean };

/** One row: rank, driver and tag, rating, then the record (folded under the name on phones). */
function Row({ entry, me }: { entry: LeaderboardEntry; me: boolean }) {
  return (
    <li>
      <button
        type="button"
        className={`board-row w-full border-t border-white/10 text-left hover:bg-white/5 focus-visible:bg-white/5 ${
          me ? 'bg-neon-cyan/10' : ''
        }`}
        onClick={() => openSheet({ kind: 'profile', id: entry.id })}
        aria-label={`${entry.nickname}, rank ${entry.rank}, rating ${entry.rating}: open profile`}
      >
        <span
          className={`digits text-lg font-black ${entry.rank <= 3 ? 'text-neon-lime glow-lime' : 'text-white'}`}
        >
          {entry.rank}
        </span>
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate text-base font-bold">{entry.nickname}</span>
          <span className="digits text-xs text-white/40">#{entry.tag}</span>
          {me && <span className="label text-[0.55rem] text-neon-cyan">you</span>}
        </span>
        <span className="digits text-right text-lg font-bold text-neon-cyan">{entry.rating}</span>
        <span className="board-wide digits text-right text-white/85">{entry.wins}</span>
        <span className="board-wide digits text-right text-white/85">{entry.podiums}</span>
        <span className="board-wide digits text-right text-white/85">{entry.races}</span>
        <span
          className="board-wide digits text-right text-white/65"
          title={
            entry.races < WIN_RATE_MIN_RACES
              ? `Shown after ${WIN_RATE_MIN_RACES} rated races`
              : undefined
          }
        >
          {winRate(entry.wins, entry.races)}
        </span>
        <span className="board-narrow board-extra digits text-xs text-white/55">
          {count(entry.wins, 'win', 'wins')} · {count(entry.podiums, 'podium', 'podiums')} ·{' '}
          {count(entry.races, 'race', 'races')}
          {entry.races >= WIN_RATE_MIN_RACES && ` · ${winRate(entry.wins, entry.races)}`}
        </span>
      </button>
    </li>
  );
}

/**
 * The global leaderboard: everyone with a rated race, ranked by the server (rating, then
 * wins, then the older profile). Pages of 25 come from the server; nothing is ranked here.
 */
export function Leaderboard() {
  const profile = useGameStore((s) => s.profile);
  const serial = useGameStore((s) => s.ratingSerial);
  const me = profile.player;
  // The server already said ranking is off: one message, no search box and no request.
  const off = profile.status === 'off';
  const [offset, setOffset] = useState(0);
  const [query, setQuery] = useState('');
  const [reload, setReload] = useState(0);
  // Each answer is kept with the request it answers: an older one is "still loading".
  const [answer, setAnswer] = useState<{ key: string; view: View } | null>(null);
  const q = query.trim();
  const key = `${offset}|${q}|${reload}|${serial}`;
  const view: View = answer?.key === key ? answer.view : { status: 'loading' };

  useEffect(() => {
    if (off) return;
    let live = true;
    // Typing waits a moment before searching; pages load at once.
    const timer = setTimeout(
      () => {
        const request = q
          ? api.search(q).then((r): View => ({ status: 'search', entries: r.entries }))
          : api.leaderboard(offset, PAGE).then((page): View => ({ status: 'page', page }));
        request
          .then((next) => live && setAnswer({ key, view: next }))
          .catch(
            (error: unknown) =>
              live &&
              setAnswer({
                key,
                view: {
                  status: 'error',
                  message: error instanceof ApiError ? error.message : 'Cannot reach the server.',
                  off: error instanceof ApiError && error.rankingOff,
                },
              }),
          );
      },
      q ? 250 : 0,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [key, offset, q, off]);

  const total = view.status === 'page' ? view.page.total : null;
  const entries =
    view.status === 'page' ? view.page.entries : view.status === 'search' ? view.entries : [];
  const myRank = me && me.races > 0 ? me.rank : null;

  return (
    <div
      className="absolute inset-0 flex items-start justify-center overflow-y-auto p-3 fade-in sm:p-4"
      role="dialog"
      aria-label="Global leaderboard"
    >
      <div className="scrim sheet-scrim" onClick={closeSheet} />
      <div className="panel sheet-panel scanlines relative my-auto flex w-full max-w-4xl flex-col gap-4 p-4 sm:p-7">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="label text-neon-magenta">Rated online races · every room</div>
            <h2 className="title-logo mt-1 text-3xl sm:text-5xl">LEADERBOARD</h2>
          </div>
          <div className="flex gap-2">
            <button type="button" className="chip" onClick={() => setReload((n) => n + 1)}>
              Refresh
            </button>
            <button type="button" className="btn px-4 py-2 text-sm" onClick={closeSheet} autoFocus>
              Back
            </button>
          </div>
        </div>

        <div className="panel flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3">
          {profile.status === 'off' ? (
            <span className="text-white/75">
              Global ranking is not set up on this server. Races still run; they are just unrated.
            </span>
          ) : me && me.races > 0 ? (
            <>
              <span className="label">You</span>
              <span className="font-bold">
                {me.nickname ?? 'Racer'}{' '}
                <span className="digits text-xs text-white/40">#{me.tag}</span>
              </span>
              <span className="digits text-2xl font-black text-neon-cyan glow-cyan">
                {me.rating}
              </span>
              <span className="digits text-white/80">#{myRank}</span>
              <span className="digits text-sm text-white/60">
                {count(me.races, 'race', 'races')} · {count(me.wins, 'win', 'wins')} ·{' '}
                {count(me.podiums, 'podium', 'podiums')}
              </span>
              <span className="ml-auto flex gap-2">
                {myRank !== null && (
                  <button
                    type="button"
                    className="chip"
                    onClick={() => {
                      setQuery('');
                      setOffset(Math.floor((myRank - 1) / PAGE) * PAGE);
                    }}
                  >
                    Show me
                  </button>
                )}
                <button
                  type="button"
                  className="chip"
                  onClick={() => openSheet({ kind: 'profile', id: null })}
                >
                  My profile
                </button>
              </span>
            </>
          ) : (
            <span className="text-sm text-white/75">
              You are not ranked yet. Your rank appears after your first rated race: an online race
              with at least one other player who has a profile.
            </span>
          )}
        </div>

        {!off && (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <input
                className="field min-w-0 flex-1 py-2 text-base"
                placeholder="Search by nickname"
                aria-label="Search players by nickname"
                value={query}
                maxLength={16}
                spellCheck={false}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setOffset(0);
                }}
              />
              {query && (
                <button type="button" className="chip" onClick={() => setQuery('')}>
                  Clear
                </button>
              )}
            </div>

            <div>
              <div className="board-row label text-[0.6rem]" aria-hidden>
                <span>Rank</span>
                <span>Driver</span>
                <span className="text-right">Rating</span>
                <span className="board-wide text-right">Wins</span>
                <span className="board-wide text-right">Podiums</span>
                <span className="board-wide text-right">Races</span>
                <span className="board-wide text-right" title={`After ${WIN_RATE_MIN_RACES} races`}>
                  Win %
                </span>
              </div>
              {view.status === 'loading' && (
                <div
                  className="border-t border-white/10 px-2 py-6 text-center text-white/60"
                  aria-live="polite"
                >
                  Loading the standings…
                </div>
              )}
              {view.status === 'error' && (
                <div
                  className="flex flex-wrap items-center justify-center gap-3 border-t border-white/10 px-2 py-6"
                  role="alert"
                >
                  <span className={view.off ? 'text-white/75' : 'font-bold text-neon-red'}>
                    {view.message}
                  </span>
                  {!view.off && (
                    <button type="button" className="chip" onClick={() => setReload((n) => n + 1)}>
                      Try again
                    </button>
                  )}
                </div>
              )}
              {(view.status === 'page' || view.status === 'search') && entries.length === 0 && (
                <div className="border-t border-white/10 px-2 py-6 text-center text-white/65">
                  {view.status === 'search'
                    ? `No ranked player's name starts with “${query.trim()}”.`
                    : offset > 0
                      ? 'No more players.'
                      : 'No rated races yet. The first online race between two players with profiles starts the leaderboard.'}
                </div>
              )}
              {entries.length > 0 && (
                <ol aria-label={view.status === 'search' ? 'Search results' : 'Rankings'}>
                  {entries.map((entry) => (
                    <Row key={entry.id} entry={entry} me={entry.id === me?.id} />
                  ))}
                </ol>
              )}
            </div>
          </>
        )}

        {view.status === 'page' && total !== null && total > 0 && (
          <div className="flex flex-wrap items-center gap-2" aria-label="Pages">
            {total > PAGE &&
              Array.from({ length: Math.ceil(Math.min(TOP, total) / PAGE) }, (_, i) => (
                <button
                  key={i}
                  type="button"
                  className="chip digits"
                  aria-pressed={offset === i * PAGE}
                  onClick={() => setOffset(i * PAGE)}
                >
                  {i * PAGE + 1}–{Math.min(total, (i + 1) * PAGE)}
                </button>
              ))}
            {/* Past the top 100: one page at a time. */}
            {offset >= TOP && (
              <>
                <button type="button" className="chip" onClick={() => setOffset(offset - PAGE)}>
                  Previous
                </button>
                <span className="chip digits" aria-current="page">
                  {offset + 1}–{Math.min(total, offset + PAGE)}
                </span>
              </>
            )}
            {offset + PAGE < total && offset + PAGE >= TOP && (
              <button type="button" className="chip" onClick={() => setOffset(offset + PAGE)}>
                Next
              </button>
            )}
            <span className="label ml-auto text-white/55">
              {total} ranked {total === 1 ? 'player' : 'players'}
            </span>
          </div>
        )}

        <details className="results-details">
          <summary className="label cursor-pointer select-none">How rating works</summary>
          <div className="mt-2">
            <RatingRules />
          </div>
        </details>
      </div>
    </div>
  );
}
