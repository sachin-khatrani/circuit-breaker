import {
  NICKNAME_CHANGES_PER_DAY,
  NICKNAME_MAX,
  sanitizeNickname,
  type OwnProfile,
  type PublicProfile,
  type RaceHistoryEntry,
} from '@circuit-breaker/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { formatTime, ordinal } from '../../game/format';
import { copyText } from '../../game/multiplayer';
import {
  closeSheet,
  makeRecoveryCode,
  openSheet,
  renameProfile,
  restoreProfile,
} from '../../game/profile';
import { saveNickname } from '../../game/settings';
import { useGameStore } from '../../game/store';
import { api, ApiError } from '../../net/api';
import { ago, deltaClass, msToSeconds, shortDate, signed, winRate } from './rankingFormat';

type Loaded =
  | { status: 'loading' }
  | { status: 'ready'; player: PublicProfile; recent: RaceHistoryEntry[] }
  | { status: 'error'; message: string };

function Stat({
  label,
  value,
  hint,
  small = false,
}: {
  label: string;
  value: string;
  hint?: string;
  /** Words (a date), not a number: a size that keeps them on one line. */
  small?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5 border border-white/10 px-3 py-2">
      <span className="label text-[0.6rem]">{label}</span>
      <span
        className={`digits font-bold whitespace-nowrap text-white ${small ? 'text-base' : 'text-xl'}`}
      >
        {value}
      </span>
      {hint && <span className="text-xs text-white/50">{hint}</span>}
    </div>
  );
}

function Stats({ player, own }: { player: PublicProfile; own: OwnProfile | null }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <div className="col-span-2 flex flex-col justify-center border border-neon-cyan/40 bg-neon-cyan/5 px-4 py-2">
        <span className="label text-[0.6rem] text-neon-cyan">Global rating</span>
        <span className="digits text-4xl font-black text-neon-cyan glow-cyan">{player.rating}</span>
        <span className="text-xs text-white/55">
          Peak {player.peakRating} ·{' '}
          {player.rank === null ? 'not ranked yet' : `#${player.rank} on the leaderboard`}
        </span>
      </div>
      <Stat label="Rated races" value={String(player.races)} hint={`${player.finished} finished`} />
      <Stat
        label="Wins"
        value={String(player.wins)}
        hint={`win rate ${winRate(player.wins, player.races)}`}
      />
      <Stat label="Podiums" value={String(player.podiums)} />
      <Stat label="Best lap" value={formatTime(msToSeconds(player.bestLapMs))} />
      <Stat label="Since" value={shortDate(player.createdAt)} small />
      {own ? (
        <Stat label="Last active" value={ago(own.lastActiveAt)} small />
      ) : (
        <Stat label="Last race" value={player.lastRaceAt ? ago(player.lastRaceAt) : '—'} small />
      )}
    </div>
  );
}

function History({ recent }: { recent: RaceHistoryEntry[] }) {
  if (recent.length === 0) {
    return <div className="text-sm text-white/60">No rated races yet.</div>;
  }
  return (
    <ol className="flex flex-col" aria-label="Recent rated races">
      {recent.map((race) => (
        <li key={race.raceId} className="history-row border-t border-white/10 py-1.5 text-sm">
          <span className="text-white/55">{ago(race.completedAt)}</span>
          <span className={`font-bold ${race.finished ? 'text-white' : 'text-neon-red'}`}>
            {race.finished
              ? `${ordinal(race.position)} of ${race.fieldSize}`
              : race.dnfReason === 'left'
                ? 'DNF · left'
                : 'DNF · out of time'}
          </span>
          <span className="digits text-right text-white/75">
            {race.finished ? formatTime(msToSeconds(race.totalTimeMs)) : '—'}
          </span>
          <span className={`digits text-right font-bold ${deltaClass(race.ratingDelta)}`}>
            {signed(race.ratingDelta)}
          </span>
          <span className="digits text-right text-white/80">{race.ratingAfter}</span>
        </li>
      ))}
    </ol>
  );
}

/** The leaderboard name: changed here or by racing under a new one (limited per day). */
function NameEditor({ player }: { player: OwnProfile }) {
  const [name, setName] = useState(player.nickname ?? '');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const clean = sanitizeNickname(name);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!clean || clean === player.nickname) return;
    setBusy(true);
    const error = await renameProfile(clean);
    setBusy(false);
    if (error) {
      setMessage({ ok: false, text: error });
      return;
    }
    // The title screen's nickname follows, so the next room uses it too.
    saveNickname(clean);
    useGameStore.setState({ nickname: clean });
    setMessage({ ok: true, text: `Saved: you are “${clean}” on the leaderboard.` });
  };
  const blocked = player.nicknameChangesLeft === 0;
  return (
    <form className="flex flex-col gap-1.5" onSubmit={(e) => void submit(e)}>
      <span className="label">Leaderboard name</span>
      <div className="flex flex-wrap gap-2">
        <input
          className="field min-w-0 flex-1 py-2"
          value={name}
          maxLength={NICKNAME_MAX}
          aria-label="Leaderboard name"
          spellCheck={false}
          onChange={(e) => {
            setName(e.target.value);
            setMessage(null);
          }}
        />
        <button
          type="submit"
          className="btn px-4 py-2 text-sm"
          disabled={busy || blocked || !clean || clean === player.nickname}
        >
          Save name
        </button>
      </div>
      <span className="text-sm text-white/55" aria-live="polite">
        {message ? (
          <span className={message.ok ? 'text-neon-lime' : 'text-neon-red'}>{message.text}</span>
        ) : blocked && player.nicknameResetsAt ? (
          `No changes left today: the next one opens ${new Date(player.nicknameResetsAt).toLocaleString()}.`
        ) : (
          `${player.nicknameChangesLeft} of ${NICKNAME_CHANGES_PER_DAY} changes left today. The tag #${player.tag} stays the same.`
        )}
      </span>
    </form>
  );
}

/** A recovery code, made on request and shown once. */
function Recovery({ player }: { player: OwnProfile }) {
  const [code, setCode] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const make = async () => {
    setBusy(true);
    setError(null);
    try {
      setCode(await makeRecoveryCode());
      setConfirm(false);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Cannot reach the game server.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <span className="label">Recovery code</span>
      <p className="text-sm text-white/70">
        Your profile lives in this browser. A recovery code moves it to another browser or device,
        or brings it back after clearing site data. Anyone with the code can take the profile: keep
        it private.
      </p>
      {code ? (
        <div className="flex flex-col gap-2 border border-neon-lime/50 bg-neon-lime/5 p-3">
          <span className="digits text-base font-bold tracking-[0.06em] break-all text-neon-lime select-all sm:text-lg">
            {code}
          </span>
          <span className="text-sm text-white/75">
            Shown once: save it now. It replaces any earlier code, and every other browser using
            this profile has been signed out.
          </span>
          <div>
            <button
              type="button"
              className="chip"
              onClick={() => void copyText(code).then(setCopied)}
            >
              {copied ? 'Copied' : 'Copy code'}
            </button>
          </div>
        </div>
      ) : confirm ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-white/80">
            A new code replaces your current one and signs out your other browsers.
          </span>
          <button type="button" className="chip" disabled={busy} onClick={() => void make()}>
            Make a new code
          </button>
          <button type="button" className="chip" onClick={() => setConfirm(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <div>
          <button
            type="button"
            className="chip"
            disabled={busy}
            onClick={() => (player.hasRecoveryCode ? setConfirm(true) : void make())}
          >
            {player.hasRecoveryCode ? 'Replace my recovery code' : 'Make a recovery code'}
          </button>
        </div>
      )}
      {error && (
        <span role="alert" className="text-sm font-bold text-neon-red">
          {error}
        </span>
      )}
    </div>
  );
}

/** Signs this browser into a profile from its recovery code. */
function Restore({ hasProfile }: { hasProfile: boolean }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!code.trim()) return;
    setBusy(true);
    const error = await restoreProfile(code);
    setBusy(false);
    setMessage(error ? { ok: false, text: error } : { ok: true, text: 'Profile restored.' });
    if (!error) setCode('');
  };
  return (
    <form className="flex flex-col gap-1.5" onSubmit={(e) => void submit(e)}>
      <span className="label">{hasProfile ? 'Use another profile' : 'Restore a profile'}</span>
      <div className="flex flex-wrap gap-2">
        <input
          className="field min-w-0 flex-1 py-2 tracking-[0.1em] uppercase"
          placeholder="XXXXX-XXXXX-XXXXX-XXXXX"
          aria-label="Recovery code"
          autoComplete="off"
          spellCheck={false}
          maxLength={40}
          value={code}
          onChange={(e) => {
            setCode(e.target.value);
            setMessage(null);
          }}
        />
        <button type="submit" className="btn px-4 py-2 text-sm" disabled={busy || !code.trim()}>
          Restore
        </button>
      </div>
      <span className="text-sm text-white/55" aria-live="polite">
        {message ? (
          <span className={message.ok ? 'text-neon-lime' : 'text-neon-red'}>{message.text}</span>
        ) : hasProfile ? (
          'This browser switches to the profile the code belongs to. Make a recovery code for this one first if you want to come back to it.'
        ) : (
          'Have a recovery code from another browser? Enter it to race as that profile here.'
        )}
      </span>
    </form>
  );
}

/**
 * A profile: anyone's public numbers and recent rated races, or (for this browser's own) the
 * name, the recovery code and restoring another profile. Everything comes from the server.
 */
export function ProfileSheet({ id }: { id: string | null }) {
  const own = useGameStore((s) => s.profile);
  const serial = useGameStore((s) => s.ratingSerial);
  const targetId = id ?? own.player?.id ?? null;
  const mine = targetId !== null && targetId === own.player?.id;
  const [reload, setReload] = useState(0);
  // An answer is kept with the request it answers: an older one is "still loading".
  const [answer, setAnswer] = useState<{ key: string; loaded: Loaded } | null>(null);
  const key = `${targetId}|${reload}|${serial}`;
  const loaded: Loaded = answer?.key === key ? answer.loaded : { status: 'loading' };

  useEffect(() => {
    if (!targetId) return;
    let live = true;
    api
      .player(targetId)
      .then(
        (r) =>
          live &&
          setAnswer({ key, loaded: { status: 'ready', player: r.player, recent: r.recent } }),
      )
      .catch(
        (error: unknown) =>
          live &&
          setAnswer({
            key,
            loaded: {
              status: 'error',
              message: error instanceof ApiError ? error.message : 'Cannot reach the game server.',
            },
          }),
      );
    return () => {
      live = false;
    };
  }, [key, targetId]);

  // This browser's own numbers are the freshest (they follow every rated race at once).
  const shown = mine && own.player ? own.player : loaded.status === 'ready' ? loaded.player : null;

  return (
    <div
      className="absolute inset-0 flex items-start justify-center overflow-y-auto p-3 fade-in sm:p-4"
      role="dialog"
      aria-label={mine ? 'Your profile' : 'Player profile'}
    >
      <div className="scrim sheet-scrim" onClick={closeSheet} />
      <div className="panel sheet-panel scanlines relative my-auto flex w-full max-w-3xl flex-col gap-4 p-4 sm:p-7">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <div className="label text-neon-magenta">
              {mine || !id ? 'Your profile' : 'Player profile'}
            </div>
            <h2 className="mt-1 flex min-w-0 items-baseline gap-2 font-display text-2xl font-black tracking-[0.08em] text-white uppercase sm:text-3xl">
              <span className="truncate">
                {shown?.nickname ?? (mine || !id ? 'No profile yet' : 'Racer')}
              </span>
              {shown && <span className="digits text-base text-white/40">#{shown.tag}</span>}
            </h2>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              className="chip"
              onClick={() => openSheet({ kind: 'leaderboard' })}
            >
              Leaderboard
            </button>
            <button type="button" className="btn px-4 py-2 text-sm" onClick={closeSheet} autoFocus>
              Back
            </button>
          </div>
        </div>

        {!targetId ? (
          own.status === 'off' ? (
            <p className="text-white/75">Global ranking is not set up on this server.</p>
          ) : (
            <>
              <p className="text-white/75">
                {own.status === 'error'
                  ? `Profiles are unavailable right now (${own.error ?? 'no answer'}). Races still work.`
                  : 'Your profile is made the first time you create or join a room. It is anonymous: a random id and your nickname, kept in this browser.'}
              </p>
              {own.status !== 'error' && <Restore hasProfile={false} />}
            </>
          )
        ) : loaded.status === 'error' && !shown ? (
          <div className="flex flex-wrap items-center gap-3" role="alert">
            <span className="font-bold text-neon-red">{loaded.message}</span>
            <button type="button" className="chip" onClick={() => setReload((n) => n + 1)}>
              Try again
            </button>
          </div>
        ) : !shown ? (
          <div className="py-4 text-white/60" aria-live="polite">
            Loading the profile…
          </div>
        ) : (
          <>
            <Stats player={shown} own={mine ? own.player : null} />
            <div>
              <div
                className="history-row label border-b border-white/10 pb-1 text-[0.6rem]"
                aria-hidden
              >
                <span>When</span>
                <span>Place</span>
                <span className="text-right">Time</span>
                <span className="text-right">Rating</span>
                <span className="text-right">After</span>
              </div>
              {loaded.status === 'ready' ? (
                <History recent={loaded.recent} />
              ) : loaded.status === 'error' ? (
                <span className="text-sm text-neon-red">{loaded.message}</span>
              ) : (
                <span className="text-sm text-white/60">Loading races…</span>
              )}
            </div>
            {mine && own.player && (
              <div className="grid gap-5 border-t border-white/10 pt-4 md:grid-cols-2">
                <div className="flex flex-col gap-5">
                  <NameEditor key={own.player.nickname} player={own.player} />
                  <Restore hasProfile />
                </div>
                <Recovery player={own.player} />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
