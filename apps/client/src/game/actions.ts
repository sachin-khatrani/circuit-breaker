import { session } from './session';
import {
  resolveReducedMotion,
  saveAudioSettings,
  saveMotionSetting,
  saveQuality,
  type MotionSetting,
  type Quality,
} from './settings';
import { useGameStore } from './store';

export function startRace(): void {
  session.startRace();
}

export function goToMenu(): void {
  session.startAttract();
}

/** Solo races pause; an online race cannot (it runs on the server's clock). */
export function pauseRace(): void {
  const { screen, overlay, raceKind } = useGameStore.getState();
  if (screen !== 'race' || overlay !== 'none' || raceKind !== 'solo') return;
  if (session.racer.finished) return;
  session.setPaused(true);
  useGameStore.setState({ overlay: 'pause' });
}

export function resumeRace(): void {
  session.setPaused(false);
  useGameStore.setState({ overlay: 'none' });
}

export function togglePause(): void {
  const { overlay, raceKind } = useGameStore.getState();
  if (raceKind === 'online') {
    // Online, Esc opens a menu over the running race instead.
    if (overlay === 'none' || overlay === 'raceMenu') {
      useGameStore.setState({ overlay: overlay === 'raceMenu' ? 'none' : 'raceMenu' });
    }
    return;
  }
  if (overlay === 'pause') resumeRace();
  else pauseRace();
}

export function closeRaceMenu(): void {
  if (useGameStore.getState().overlay === 'raceMenu') useGameStore.setState({ overlay: 'none' });
}

export function setQuality(quality: Quality): void {
  saveQuality(quality);
  useGameStore.setState({ quality });
}

export function showControls(show: boolean): void {
  // Closing an overlay restarts the quick-start grace period on the title screen.
  useGameStore.setState(
    show ? { overlay: 'controls' } : { overlay: 'none', menuSince: performance.now() },
  );
}

export function setVolume(volume: number): void {
  const v = Math.min(1, Math.max(0, volume));
  // Turning the volume up from silence unmutes, as a player would expect.
  const muted = v > 0 ? false : useGameStore.getState().muted;
  useGameStore.setState({ volume: v, muted });
  saveAudioSettings({ volume: v, muted });
}

export function setMuted(muted: boolean): void {
  useGameStore.setState({ muted });
  saveAudioSettings({ volume: useGameStore.getState().volume, muted });
}

export function toggleMute(): void {
  setMuted(!useGameStore.getState().muted);
}

export function setMotion(motion: MotionSetting): void {
  saveMotionSetting(motion);
  useGameStore.setState({ motion, reducedMotion: resolveReducedMotion(motion) });
}
