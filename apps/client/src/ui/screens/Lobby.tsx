import {
  MAX_LAPS,
  MAX_PLAYERS,
  MIN_LAPS,
  MIN_PLAYERS,
  PLAYER_COLORS,
  POINTS_TABLE,
  type LobbyPlayer,
  type RoomState,
} from '@circuit-breaker/shared';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { formatClock } from '../../game/format';
import {
  copyInviteLink,
  copyRoomCode,
  inviteLink,
  leaveRoom,
  newSession,
  setLaps,
  setReady,
  startOnlineRace,
} from '../../game/multiplayer';
import { useGameStore } from '../../game/store';
import { net } from '../../net/connection';
import { AfterRaceControls } from '../online/AfterRaceControls';
import { CarGlyph } from '../online/CarGlyph';
import { ConnectionStatus } from '../online/ConnectionStatus';
import { PlayerSwatch } from '../online/PlayerSwatch';
import { ResultsTable } from '../online/ResultsTable';
import { VehiclePicker } from '../online/VehiclePicker';

const LAP_CHOICES = Array.from({ length: MAX_LAPS - MIN_LAPS + 1 }, (_, i) => MIN_LAPS + i);

/** Seconds left of a disconnected player's seat (from the server's deadline). */
function graceLeft(p: LobbyPlayer, now: number): number {
  if (p.graceUntil === null) return 0;
  return Math.max(0, Math.ceil((p.graceUntil - net.clock.serverNow(now)) / 1000));
}

/** Re-renders twice a second while `active` (a disconnected player's countdown is shown). */
function useTicker(active: boolean): number {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(performance.now()), 500);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

/** Who can race, who is still getting ready, who is away: all from the server's room state. */
function readiness(room: RoomState) {
  const connected = room.players.filter((p) => p.connected);
  // The host's Start counts as their ready.
  const ready = connected.filter((p) => p.ready || p.host);
  const preparing = connected.filter((p) => !p.ready && !p.host);
  const away = room.players.filter((p) => !p.connected);
  return { connected, ready, preparing, away };
}

const names = (players: LobbyPlayer[]) => players.map((p) => p.name).join(', ');

/** The line under the room code: what is happening, and what (if anything) blocks the start. */
function statusMessage(room: RoomState, me: LobbyPlayer | undefined, host: boolean): string {
  const { connected, ready, preparing } = readiness(room);
  const hostName = room.players.find((p) => p.host)?.name ?? 'the host';
  switch (room.phase) {
    case 'countdown':
    case 'racing':
    case 'finished':
      return me?.racing ? 'Race in progress.' : 'Race in progress. You can race the next one.';
    case 'results':
      return host
        ? 'Race over. Start the next one when the others are ready.'
        : 'Race over. Get ready for the next one.';
    case 'ready':
      if (host) {
        return preparing.length > 0
          ? `${ready.length} drivers can race. ${names(preparing)} will watch unless ready.`
          : `Everyone is ready: ${ready.length} drivers. Start when you like.`;
      }
      return me?.ready ? `Ready. Waiting for ${hostName} to start.` : 'Press Ready to race.';
    case 'waiting':
    default:
      if (connected.length < MIN_PLAYERS) {
        return `A race needs ${MIN_PLAYERS} connected drivers. Share the code or the invite link.`;
      }
      if (host) return `Waiting for another driver to get ready: ${names(preparing)}.`;
      return me?.ready ? `Ready. Waiting for ${hostName} to start.` : 'Press Ready to race.';
  }
}

/**
 * One seat: car, name, host badge, session score, and its status: ready or not (between
 * races), racing or watching (during one), or how long a disconnected seat is still held.
 */
function PlayerCard({
  player,
  you,
  between,
  now,
  ranking,
}: {
  player: LobbyPlayer;
  you: boolean;
  /** In the lobby or on the results screen (ready checks apply). */
  between: boolean;
  now: number;
  /** The server rates races: show each player's global rating (or that they have none). */
  ranking: boolean;
}) {
  const hex = PLAYER_COLORS[player.color] ?? PLAYER_COLORS[0];
  // The host's Start counts as their ready.
  const ready = player.ready || player.host;
  const lit = between && ready && player.connected;
  const status = between
    ? ready
      ? 'Ready'
      : 'Getting ready…'
    : player.racing
      ? 'Racing'
      : 'Watching';
  return (
    <li
      className={`player-card panel relative flex items-center gap-3 py-2.5 pr-3 pl-4 ${
        player.connected ? '' : 'opacity-60'
      }`}
      style={{ '--player': hex } as CSSProperties}
      data-ready={lit}
    >
      <CarGlyph color={player.color} style={player.style} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-base leading-tight font-bold sm:text-lg">
          {player.name}
          {you && <span className="label ml-2 text-[0.6rem] text-neon-cyan">you</span>}
        </span>
        <span
          className={`label block text-[0.62rem] ${
            !player.connected ? 'text-neon-red' : lit ? 'text-neon-lime' : 'text-white/55'
          }`}
        >
          {player.connected ? (
            status
          ) : (
            // A narrow card wraps this line rather than cut off the seconds the seat has left.
            <>
              Disconnected ·{' '}
              <span className="whitespace-nowrap">seat held {graceLeft(player, now)} s</span>
            </>
          )}
        </span>
      </span>
      <span className="flex flex-col items-end gap-0.5">
        {player.host && (
          <span className="label border border-neon-amber/60 px-1.5 py-0.5 text-[0.58rem] text-neon-amber">
            Host
          </span>
        )}
        {player.races > 0 && (
          <span className="digits text-sm text-white/80" title="Session rank and points">
            #{player.rank} · {player.points}
          </span>
        )}
        {ranking &&
          (player.rating !== null ? (
            <span
              className="digits text-xs text-neon-cyan/85"
              title={`Global rating (profile #${player.tag ?? ''})`}
            >
              <span className="label mr-1 text-[0.5rem] text-white/45">rating</span>
              {player.rating}
            </span>
          ) : (
            <span className="label text-[0.5rem] text-white/40" title="No profile: races unrated">
              unrated
            </span>
          ))}
      </span>
    </li>
  );
}

/** Whether the next race will count for the global rating, and if not, why. */
function ratedLine(
  room: RoomState,
  me: LobbyPlayer | undefined,
  profileError: string | null,
  hasProfile: boolean,
) {
  if (!room.ranking) return null;
  // One profile in two tabs is one rated player.
  const profiles = new Set(
    room.players.filter((p) => p.connected && p.profileId).map((p) => p.profileId),
  ).size;
  if (me && me.profileId === null) {
    // A profile races in one seat at a time: a second tab or device gets an unrated seat.
    return {
      ok: false,
      text:
        hasProfile && !profileError
          ? 'Your profile is already racing in another seat (another tab or device), so this seat is unrated.'
          : `You joined without a profile${profileError ? ` (${profileError})` : ''}, so your races here are unrated.`,
    };
  }
  return profiles >= 2
    ? { ok: true, text: `Rated: ${profiles} players with profiles race for global rating.` }
    : {
        ok: false,
        text: `Unrated for now: a rated race needs 2 players with profiles (${profiles} here).`,
      };
}

/** The room: code and invite link, players, the car picker, ready check and host controls. */
export function Lobby() {
  const room = useGameStore((s) => s.online.room);
  const playerId = useGameStore((s) => s.online.playerId);
  const busy = useGameStore((s) => s.online.busy);
  const error = useGameStore((s) => s.online.error);
  const results = useGameStore((s) => s.online.results);
  const standings = useGameStore((s) => s.online.standings);
  const rating = useGameStore((s) => s.online.rating);
  const profile = useGameStore((s) => s.profile);
  const [copied, setCopied] = useState<'idle' | 'code' | 'link' | 'failed'>('idle');
  const [confirmReset, setConfirmReset] = useState(false);
  const copyTimer = useRef(0);
  const now = useTicker(room?.players.some((p) => !p.connected) ?? false);

  useEffect(() => () => window.clearTimeout(copyTimer.current), []);

  if (!room) return null;
  const me = room.players.find((p) => p.id === playerId);
  const host = room.hostId === playerId;
  const inLobby = room.phase === 'waiting' || room.phase === 'ready';
  const racing = room.phase === 'countdown' || room.phase === 'racing' || room.phase === 'finished';
  const { ready, preparing, away } = readiness(room);
  const canStart = room.phase === 'ready';
  const rated = ratedLine(
    room,
    me,
    profile.status === 'error' ? profile.error : null,
    profile.status === 'ready' && profile.player !== null,
  );
  const startHint = canStart
    ? null
    : `Needs ${MIN_PLAYERS} connected, ready drivers (${ready.length} now).`;

  const copy = async (what: 'code' | 'link') => {
    const ok = await (what === 'code' ? copyRoomCode(room.code) : copyInviteLink(room.code));
    setCopied(ok ? what : 'failed');
    window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied('idle'), 2400);
  };

  return (
    <div className="absolute inset-0 fade-in">
      <div className="absolute inset-0 bg-gradient-to-r from-ink/92 via-ink/70 to-ink/25" />
      <div className="relative h-full overflow-y-auto">
        <div className="mx-auto flex min-h-full max-w-[1180px] flex-col justify-center gap-5 px-5 py-5 sm:px-10 lg:flex-row lg:items-center lg:gap-10">
          <div className="flex w-full max-w-[640px] flex-col gap-4">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <div className="label text-neon-magenta/90">
                  Room code · session {room.sessionId}
                  {room.sessionRaces > 0 &&
                    ` · ${room.sessionRaces} ${room.sessionRaces === 1 ? 'race' : 'races'}`}
                </div>
                <div
                  className="digits text-[clamp(2.4rem,7vw,3.6rem)] leading-none font-black tracking-[0.18em] text-white glow-cyan"
                  aria-label={`Room code ${room.code.split('').join(' ')}`}
                >
                  {room.code}
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="btn px-4 py-2.5 text-sm"
                  onClick={() => void copy('code')}
                >
                  {copied === 'code' ? 'Code copied' : 'Copy code'}
                </button>
                <button
                  type="button"
                  className="btn px-4 py-2.5 text-sm"
                  onClick={() => void copy('link')}
                >
                  {copied === 'link' ? 'Link copied' : 'Copy invite link'}
                </button>
              </div>
            </div>
            <label className="flex flex-col gap-1">
              <span className="label text-white/55">Invite link</span>
              <input
                className="field py-2 text-sm font-medium tracking-normal"
                readOnly
                value={inviteLink(room.code)}
                onFocus={(e) => e.currentTarget.select()}
              />
              {copied === 'failed' && (
                <span className="text-sm text-neon-amber">
                  Copying is blocked here: select the link and copy it by hand.
                </span>
              )}
            </label>

            <div className="font-bold tracking-wide text-white/90" aria-live="polite">
              {statusMessage(room, me, host)}
            </div>

            <div className="panel p-4">
              <div className="label mb-2 flex flex-wrap justify-between gap-2">
                <span>
                  Players {room.players.length}/{MAX_PLAYERS}
                </span>
                {inLobby && (
                  <span className={ready.length >= MIN_PLAYERS ? 'text-neon-lime' : ''}>
                    Ready {ready.length}/{room.players.filter((p) => p.connected).length}
                    {preparing.length > 0 && ` · getting ready: ${names(preparing)}`}
                  </span>
                )}
              </div>
              <ul className="grid gap-2 sm:grid-cols-2">
                {room.players.map((p) => (
                  <PlayerCard
                    key={p.id}
                    player={p}
                    you={p.id === playerId}
                    between={inLobby || room.phase === 'results'}
                    now={now}
                    ranking={room.ranking}
                  />
                ))}
                {room.players.length < MIN_PLAYERS && (
                  <li className="flex items-center border border-dashed border-white/15 px-4 py-3 text-sm text-white/50">
                    A race needs {MIN_PLAYERS} drivers: share the code or the invite link.
                  </li>
                )}
              </ul>
              {away.length > 0 && inLobby && (
                <div className="mt-2 text-sm text-white/60">
                  A disconnected player is not on the grid. The seat is held until they come back or
                  the time runs out.
                </div>
              )}
              {rated && (
                <div className={`mt-2 text-sm ${rated.ok ? 'text-neon-lime/90' : 'text-white/60'}`}>
                  {rated.text}
                </div>
              )}
              {profile.note && <div className="mt-1 text-sm text-neon-amber">{profile.note}</div>}
            </div>

            {racing && standings.length > 0 && (
              <div className="panel p-4">
                <div className="label mb-2">Live standings</div>
                <ol className="flex flex-col gap-1">
                  {standings.map((s) => (
                    <li key={s.id} className="flex items-center gap-3 font-bold">
                      <span className="digits w-5 text-right text-white/60">{s.position}</span>
                      <PlayerSwatch color={s.color} />
                      <span className="min-w-0 flex-1 truncate">{s.name}</span>
                      <span className="digits text-sm text-white/60">
                        {s.finished
                          ? formatClock(s.finishTime)
                          : s.retired
                            ? 'DNF'
                            : `Lap ${Math.min(s.lap + 1, room.laps)}/${room.laps}`}
                      </span>
                    </li>
                  ))}
                </ol>
              </div>
            )}

            {room.phase === 'results' && results && (
              <div className="panel p-4">
                <div className="label mb-2">Last race</div>
                <ResultsTable results={results} playerId={playerId} rating={rating} />
              </div>
            )}
          </div>

          <div className="flex w-full max-w-[640px] flex-col gap-4 lg:max-w-[400px]">
            {me && !racing && (
              <div className="panel p-4">
                <div className="label mb-3">Your car</div>
                <VehiclePicker me={me} players={room.players} />
              </div>
            )}

            {inLobby && (
              <div className="flex flex-col gap-4">
                {!host && (
                  <button
                    type="button"
                    className={`btn ${me?.ready ? '' : 'btn-primary'} w-full`}
                    aria-pressed={me?.ready ?? false}
                    disabled={busy || !me}
                    onClick={() => void setReady(!(me?.ready ?? false))}
                  >
                    {me?.ready ? 'Not ready' : 'Ready'}
                  </button>
                )}
                <div>
                  <div className="label mb-2">Laps{host ? '' : ' (the host sets them)'}</div>
                  <div className="flex gap-1">
                    {LAP_CHOICES.map((laps) => (
                      <button
                        key={laps}
                        type="button"
                        className="chip"
                        aria-pressed={room.laps === laps}
                        disabled={!host || busy}
                        onClick={() => void setLaps(laps)}
                      >
                        {laps}
                      </button>
                    ))}
                  </div>
                </div>
                {host && (
                  <div className="flex flex-col gap-1.5">
                    <button
                      type="button"
                      className="btn btn-primary w-full"
                      disabled={busy || !canStart}
                      onClick={() => void startOnlineRace()}
                    >
                      Start race
                    </button>
                    {startHint && <div className="text-sm text-white/65">{startHint}</div>}
                  </div>
                )}
                <div className="text-sm text-white/55">
                  Points by place: {POINTS_TABLE.join(', ')}; a DNF scores 0. The fewest points
                  start at the front of the grid. Points stay in this room; the global rating is
                  separate.
                </div>
                {host && room.sessionRaces > 0 && (
                  <div className="flex flex-wrap items-center gap-2">
                    {confirmReset ? (
                      <>
                        <span className="text-sm text-white/75">Everyone back to 0 points?</span>
                        <button
                          type="button"
                          className="chip"
                          onClick={() => {
                            setConfirmReset(false);
                            void newSession();
                          }}
                        >
                          Yes, new session
                        </button>
                        <button
                          type="button"
                          className="chip"
                          onClick={() => setConfirmReset(false)}
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button type="button" className="chip" onClick={() => setConfirmReset(true)}>
                        New session
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}

            {room.phase === 'results' ? (
              <AfterRaceControls />
            ) : (
              <div className="flex flex-wrap items-center gap-4">
                <button type="button" className="btn btn-ghost" onClick={() => void leaveRoom()}>
                  Leave room
                </button>
                <ConnectionStatus />
              </div>
            )}

            <div className="min-h-[1.5rem]" aria-live="polite">
              {error && room.phase !== 'results' && (
                <div role="alert" className="font-bold text-neon-red">
                  {error}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
