import { goToMenu, resumeRace, startRace } from '../../game/actions';
import { SettingsControls } from '../SettingsControls';

export function PauseMenu() {
  return (
    <div className="absolute inset-0 flex items-center justify-center fade-in">
      <div className="scrim" />
      <div className="panel scanlines relative flex min-w-[300px] flex-col gap-3 p-8">
        <h2 className="mb-2 font-display text-3xl font-black tracking-[0.25em] text-white glow-cyan">
          PAUSED
        </h2>
        <button type="button" className="btn btn-primary" onClick={resumeRace} autoFocus>
          Resume
        </button>
        <button type="button" className="btn" onClick={startRace}>
          Restart race
        </button>
        <button type="button" className="btn btn-ghost" onClick={goToMenu}>
          Quit to menu
        </button>
        <div className="mt-3 border-t border-white/10 pt-4">
          <SettingsControls />
        </div>
      </div>
    </div>
  );
}
