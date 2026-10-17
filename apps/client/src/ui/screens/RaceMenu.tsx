import { closeRaceMenu } from '../../game/actions';
import { leaveRoom } from '../../game/multiplayer';
import { SettingsControls } from '../SettingsControls';

/** Esc in an online race: the race keeps running underneath (it cannot pause). */
export function RaceMenu() {
  return (
    <div className="absolute inset-0 flex items-center justify-center fade-in">
      <div className="scrim" />
      <div className="panel scanlines relative flex min-w-[300px] flex-col gap-3 p-8">
        <h2 className="font-display text-3xl font-black tracking-[0.25em] text-white glow-cyan">
          RACE MENU
        </h2>
        <p className="mb-2 label text-neon-amber">The race is still running</p>
        <button type="button" className="btn btn-primary" onClick={closeRaceMenu} autoFocus>
          Back to the race
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => void leaveRoom()}>
          Leave race and room
        </button>
        <div className="mt-3 border-t border-white/10 pt-4">
          <SettingsControls />
        </div>
      </div>
    </div>
  );
}
