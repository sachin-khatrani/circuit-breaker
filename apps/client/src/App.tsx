import { useEffect } from 'react';
import { pauseRace, showControls, startRace, toggleMute, togglePause } from './game/actions';
import { audio } from './game/audio';
import { inputManager } from './game/input';
import {
  initMultiplayer,
  invitedRoomCode,
  openMultiplayer,
  resumeStoredSeat,
} from './game/multiplayer';
import { closeSheet, loadProfile } from './game/profile';
import { resolveReducedMotion, watchReducedMotion } from './game/settings';
import { useGameStore } from './game/store';
import { GameCanvas } from './scene/GameCanvas';
import { Hud } from './ui/Hud';
import { ConnectionWarning } from './ui/hud/ConnectionWarning';
import { ControlsOverlay } from './ui/screens/ControlsOverlay';
import { Lobby } from './ui/screens/Lobby';
import { MainMenu } from './ui/screens/MainMenu';
import { OnlineResults } from './ui/screens/OnlineResults';
import { PauseMenu } from './ui/screens/PauseMenu';
import { RaceMenu } from './ui/screens/RaceMenu';
import { ResultsScreen } from './ui/screens/ResultsScreen';
import { Leaderboard } from './ui/ranking/Leaderboard';
import { ProfileSheet } from './ui/ranking/ProfileSheet';

/** Quick-start keys are ignored for this long after the title screen becomes interactive. */
const QUICK_START_DELAY_MS = 400;

/**
 * W / ↑ start a race only from the idle title screen: never while typing, never while another
 * menu control has focus (the key belongs to that control), and not right after the menu
 * appears or an overlay closes (a key still held from the previous screen).
 */
function quickStartAllowed(target: EventTarget | null): boolean {
  if (useGameStore.getState().sheet) return false;
  if (isTextEntry(target)) return false;
  if (target instanceof HTMLElement) {
    const idle = target === document.body || target === document.documentElement;
    if (!idle && !target.closest('[data-quick-start]')) return false;
  }
  return performance.now() - useGameStore.getState().menuSince > QUICK_START_DELAY_MS;
}

/** A key typed into a form control belongs to that control, not to the game. */
function isTextEntry(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.closest('input, textarea, select') !== null)
  );
}

export function App() {
  const screen = useGameStore((s) => s.screen);
  const overlay = useGameStore((s) => s.overlay);
  const raceKind = useGameStore((s) => s.raceKind);
  const sheet = useGameStore((s) => s.sheet);

  useEffect(() => {
    initMultiplayer();
    // This browser's persistent profile (if it has one) for the menus and the leaderboard.
    void loadProfile();
    // A reload keeps this tab's seat (the server holds it for a while); an invite link fills
    // in the title screen's join code.
    void resumeStoredSeat().then((resumed) => {
      if (!resumed && invitedRoomCode()) openMultiplayer('join');
    });
  }, []);

  useEffect(() => {
    const detach = inputManager.attach();
    inputManager.onAction((action, target) => {
      const state = useGameStore.getState();
      const onMenu = state.screen === 'menu' && state.overlay === 'none' && !state.sheet;
      if (action === 'pause') {
        if (state.sheet) closeSheet();
        else if (state.overlay === 'controls') showControls(false);
        else if (state.screen === 'race' && state.overlay !== 'results') togglePause();
      } else if (action === 'start') {
        // Throttle on the title screen starts driving straight away.
        if (onMenu && quickStartAllowed(target)) startRace();
      } else if (action === 'mute') {
        if (!isTextEntry(target)) toggleMute();
      } else if ((state.overlay === 'results' && state.raceKind === 'solo') || onMenu) {
        startRace();
      }
    });
    // Sound may only start after a user gesture: the first key press or click unlocks it.
    const unlockAudio = () => audio.unlock();
    window.addEventListener('keydown', unlockAudio, true);
    window.addEventListener('pointerdown', unlockAudio, true);
    const detachAudio = audio.attach();
    // "Auto" motion follows the operating system, live.
    const stopWatching = watchReducedMotion(() => {
      const { motion } = useGameStore.getState();
      useGameStore.setState({ reducedMotion: resolveReducedMotion(motion) });
    });
    // CSS reads the resolved choice from the root element.
    const applyMotion = (reduced: boolean) => {
      document.documentElement.dataset.motion = reduced ? 'reduced' : 'full';
    };
    applyMotion(useGameStore.getState().reducedMotion);
    const stopMotion = useGameStore.subscribe((s, prev) => {
      if (s.reducedMotion !== prev.reducedMotion) applyMotion(s.reducedMotion);
    });
    // Never let a race run in a background tab or behind another window: held keys are lost
    // when focus goes, so pausing is the only safe choice.
    const onVisibility = () => {
      if (document.hidden) pauseRace();
    };
    const onBlur = () => pauseRace();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', onBlur);
    return () => {
      detach();
      stopWatching();
      stopMotion();
      detachAudio();
      inputManager.onAction(null);
      window.removeEventListener('keydown', unlockAudio, true);
      window.removeEventListener('pointerdown', unlockAudio, true);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  return (
    <div className="relative h-full w-full">
      <GameCanvas />
      {screen === 'menu' && <MainMenu />}
      {screen === 'lobby' && <Lobby />}
      {screen === 'race' && <Hud />}
      {overlay === 'pause' && <PauseMenu />}
      {overlay === 'raceMenu' && <RaceMenu />}
      {overlay === 'results' && (raceKind === 'online' ? <OnlineResults /> : <ResultsScreen />)}
      {overlay === 'controls' && <ControlsOverlay />}
      {raceKind === 'online' && screen === 'race' && <ConnectionWarning />}
      {sheet?.kind === 'leaderboard' && <Leaderboard />}
      {sheet?.kind === 'profile' && <ProfileSheet key={sheet.id ?? 'me'} id={sheet.id} />}
    </div>
  );
}
