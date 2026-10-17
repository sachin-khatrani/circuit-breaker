import type { PointerEvent } from 'react';
import { setMotion, setMuted, setVolume } from '../game/actions';
import { useGameStore } from '../game/store';

/** After a mouse or touch drag, hand focus back to the page so the game keys work again. */
function releaseAfterPointer(e: PointerEvent<HTMLElement>): void {
  e.currentTarget.blur();
}

/**
 * Sound (on/off and volume) and motion settings, shared by the title screen and the pause
 * menu. Every control is a real button or slider, so it works with keyboard, mouse and touch.
 */
export function SettingsControls() {
  const volume = useGameStore((s) => s.volume);
  const muted = useGameStore((s) => s.muted);
  const motion = useGameStore((s) => s.motion);
  const reduced = useGameStore((s) => s.reducedMotion);

  return (
    <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
      <div>
        <div className="label mb-2">Sound · M</div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="chip min-w-[5.5rem]"
            aria-pressed={!muted}
            onClick={() => setMuted(!muted)}
            onPointerUp={releaseAfterPointer}
            data-menu-item
          >
            {muted ? 'Muted' : 'On'}
          </button>
          <input
            type="range"
            className="volume-slider"
            min={0}
            max={100}
            step={5}
            value={Math.round(volume * 100)}
            aria-label="Volume"
            onChange={(e) => setVolume(Number(e.currentTarget.value) / 100)}
            onPointerUp={releaseAfterPointer}
            data-menu-item
          />
        </div>
      </div>
      <div>
        <div className="label mb-2">Motion</div>
        <button
          type="button"
          className="chip"
          aria-pressed={reduced}
          onClick={() => setMotion(reduced ? 'full' : 'reduced')}
          onPointerUp={releaseAfterPointer}
          data-menu-item
        >
          Reduce motion: {reduced ? 'on' : 'off'}
          {motion === 'auto' && <span className="ml-1 text-white/45">(system)</span>}
        </button>
      </div>
    </div>
  );
}
