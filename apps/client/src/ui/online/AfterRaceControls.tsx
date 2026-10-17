import { MIN_PLAYERS } from '@circuit-breaker/shared';
import { leaveRoom, raceAgain, returnToLobby, setReady } from '../../game/multiplayer';
import { useGameStore } from '../../game/store';
import { PlayerSwatch } from './PlayerSwatch';

/**
 * After a race: everyone says whether they are ready for the next one (shown to all), and the
 * host starts it once enough are, or takes the room back to the lobby. Anyone may leave.
 */
export function AfterRaceControls() {
  const room = useGameStore((s) => s.online.room);
  const playerId = useGameStore((s) => s.online.playerId);
  const busy = useGameStore((s) => s.online.busy);
  const error = useGameStore((s) => s.online.error);
  if (!room) return null;
  const host = room.hostId === playerId;
  const me = room.players.find((p) => p.id === playerId);
  const connected = room.players.filter((p) => p.connected);
  // The host's "Race again" counts as their ready.
  const ready = connected.filter((p) => p.ready || p.host);
  const preparing = connected.filter((p) => !p.ready && !p.host);
  const enough = ready.length >= MIN_PLAYERS;
  const hostName = room.players.find((p) => p.host)?.name ?? 'the host';
  const resultsShown = room.phase === 'results';

  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className="label mb-1.5">
          Next race · ready {ready.length}/{connected.length}
        </div>
        <ul className="flex flex-wrap gap-1.5" aria-label="Who is ready for the next race">
          {room.players.map((p) => {
            const isReady = p.connected && (p.ready || p.host);
            return (
              <li
                key={p.id}
                className={`flex items-center gap-1.5 border px-2 py-1 text-sm font-bold ${
                  isReady ? 'border-neon-lime/60 text-white' : 'border-white/15 text-white/55'
                }`}
              >
                <PlayerSwatch color={p.color} size={10} />
                {p.name}
                <span className={`label text-[0.55rem] ${isReady ? 'text-neon-lime' : ''}`}>
                  {!p.connected ? 'away' : isReady ? 'ready' : 'not yet'}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
      {host ? (
        <>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !enough || !resultsShown}
            onClick={() => void raceAgain()}
            autoFocus
          >
            Race again{enough ? ` · ${ready.length} drivers` : ''}
          </button>
          {!enough && (
            <div className="text-sm text-white/65">
              {connected.length < MIN_PLAYERS
                ? `The next race needs ${MIN_PLAYERS} drivers. Share the room code to invite someone.`
                : `Waiting for someone to get ready: ${preparing.map((p) => p.name).join(', ')}.`}
            </div>
          )}
          {enough && preparing.length > 0 && (
            <div className="text-sm text-white/60">
              {preparing.map((p) => p.name).join(', ')} will watch unless ready.
            </div>
          )}
          <button
            type="button"
            className="btn"
            disabled={busy || !resultsShown}
            onClick={() => void returnToLobby()}
          >
            Return to lobby
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            className={`btn ${me?.ready ? '' : 'btn-primary'}`}
            aria-pressed={me?.ready ?? false}
            disabled={busy || !me || !resultsShown}
            onClick={() => void setReady(!(me?.ready ?? false))}
            autoFocus
          >
            {me?.ready ? 'Not ready' : 'Ready for the next race'}
          </button>
          <div className="text-sm text-white/65">
            {me?.ready
              ? `Ready. ${hostName} starts the next race.`
              : `${hostName} starts the next race with everyone who is ready.`}
          </div>
        </>
      )}
      <button type="button" className="btn btn-ghost" onClick={() => void leaveRoom()}>
        Leave room
      </button>
      {error && (
        <div role="alert" className="font-bold text-neon-red">
          {error}
        </div>
      )}
    </div>
  );
}
