import { isVehicleChoice } from '@circuit-breaker/shared';

export type Quality = 'low' | 'medium' | 'high';

export interface QualityPreset {
  label: string;
  maxDpr: number;
  /** SMAA edge anti-aliasing in the post chain (MSAA render targets are not used). */
  smaa: boolean;
  bloomLevels: number;
  bloomScale: number;
  towers: number;
  particles: number;
  chromaticAberration: boolean;
  speedLines: boolean;
  /** Neon dust in the air around the camera (0: none). */
  motes: number;
}

export const QUALITY_PRESETS: Record<Quality, QualityPreset> = {
  low: {
    label: 'Low',
    maxDpr: 1,
    smaa: false,
    bloomLevels: 5,
    bloomScale: 0.5,
    towers: 450,
    particles: 128,
    chromaticAberration: false,
    speedLines: false,
    motes: 0,
  },
  medium: {
    label: 'Medium',
    maxDpr: 1.5,
    smaa: true,
    bloomLevels: 7,
    bloomScale: 1,
    towers: 900,
    particles: 384,
    chromaticAberration: true,
    speedLines: true,
    motes: 260,
  },
  high: {
    label: 'High',
    maxDpr: 2,
    smaa: true,
    bloomLevels: 8,
    bloomScale: 1,
    towers: 1300,
    particles: 512,
    chromaticAberration: true,
    speedLines: true,
    motes: 520,
  },
};

const QUALITY_KEY = 'circuit-breaker.quality';
const AUDIO_KEY = 'circuit-breaker.audio';
const MOTION_KEY = 'circuit-breaker.motion';
const NICKNAME_KEY = 'circuit-breaker.nickname';
const VEHICLE_KEY = 'circuit-breaker.vehicle';
const HINT_KEY = 'circuit-breaker.first-race-hint';
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** `auto` follows the operating system's "reduce motion" preference. */
export type MotionSetting = 'auto' | 'reduced' | 'full';

export interface AudioSettings {
  /** 0..1 */
  volume: number;
  muted: boolean;
}

export const DEFAULT_AUDIO: AudioSettings = { volume: 0.7, muted: false };

/** The OS-level "reduce motion" preference: no camera shake, roll or speed streaks. */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

/** Calls `listener` whenever the reduced-motion preference changes; returns an unsubscribe. */
export function watchReducedMotion(listener: (reduced: boolean) => void): () => void {
  const query = window.matchMedia(REDUCED_MOTION_QUERY);
  const onChange = (e: MediaQueryListEvent) => listener(e.matches);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

function isTouchDevice(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;
}

export function loadQuality(): Quality {
  try {
    const saved = window.localStorage.getItem(QUALITY_KEY);
    if (saved === 'low' || saved === 'medium' || saved === 'high') return saved;
  } catch {
    // Storage can be unavailable (private mode, blocked site data); fall through to defaults.
  }
  return isTouchDevice() ? 'low' : 'medium';
}

export function saveQuality(quality: Quality): void {
  try {
    window.localStorage.setItem(QUALITY_KEY, quality);
  } catch {
    // Not fatal: the choice just will not survive a reload.
  }
}

export function loadAudioSettings(): AudioSettings {
  try {
    const raw = window.localStorage.getItem(AUDIO_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        const { volume, muted } = parsed as Partial<AudioSettings>;
        return {
          volume:
            typeof volume === 'number' && Number.isFinite(volume)
              ? Math.min(1, Math.max(0, volume))
              : DEFAULT_AUDIO.volume,
          muted: muted === true,
        };
      }
    }
  } catch {
    // Unavailable or malformed storage: use the defaults.
  }
  return { ...DEFAULT_AUDIO };
}

export function saveAudioSettings(settings: AudioSettings): void {
  try {
    window.localStorage.setItem(AUDIO_KEY, JSON.stringify(settings));
  } catch {
    // Not fatal: the choice just will not survive a reload.
  }
}

export function loadMotionSetting(): MotionSetting {
  try {
    const saved = window.localStorage.getItem(MOTION_KEY);
    if (saved === 'auto' || saved === 'reduced' || saved === 'full') return saved;
  } catch {
    // Fall through to following the system preference.
  }
  return 'auto';
}

export function saveMotionSetting(setting: MotionSetting): void {
  try {
    window.localStorage.setItem(MOTION_KEY, setting);
  } catch {
    // Not fatal: the choice just will not survive a reload.
  }
}

/** Whether motion should be reduced under a setting (`auto` asks the operating system). */
export function resolveReducedMotion(setting: MotionSetting): boolean {
  return setting === 'auto' ? prefersReducedMotion() : setting === 'reduced';
}

/** A car: colour (PLAYER_COLORS index) and body style (VEHICLE_STYLES index). */
export interface VehiclePick {
  color: number;
  style: number;
}

/** The car this player last picked (solo races use it; online it is asked for, not owned). */
export function loadVehicle(): VehiclePick {
  try {
    const raw = window.localStorage.getItem(VEHICLE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        const { color, style } = parsed as Partial<VehiclePick>;
        if (isVehicleChoice(color, style)) return { color: color!, style: style! };
      }
    }
  } catch {
    // Unavailable or malformed storage: the default car.
  }
  return { color: 0, style: 0 };
}

export function saveVehicle(vehicle: VehiclePick): void {
  try {
    window.localStorage.setItem(VEHICLE_KEY, JSON.stringify(vehicle));
  } catch {
    // Not fatal: the choice just will not survive a reload.
  }
}

/** The nickname last used online (the server cleans it again; this only pre-fills the form). */
export function loadNickname(): string {
  try {
    return (window.localStorage.getItem(NICKNAME_KEY) ?? '').slice(0, 32);
  } catch {
    return '';
  }
}

export function saveNickname(name: string): void {
  try {
    window.localStorage.setItem(NICKNAME_KEY, name);
  } catch {
    // Not fatal: the form just starts empty next time.
  }
}

/** Races the first-race hint may appear in before it stops by itself. */
export const HINT_MAX_RACES = 3;

/** The first-race hint: finished (an ability used, or the hint closed) and races shown in. */
export interface HintProgress {
  done: boolean;
  races: number;
}

export function loadHintProgress(): HintProgress {
  try {
    const raw = window.localStorage.getItem(HINT_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        const { done, races } = parsed as Partial<HintProgress>;
        return {
          done: done === true,
          races:
            typeof races === 'number' && Number.isFinite(races)
              ? Math.max(0, Math.floor(races))
              : 0,
        };
      }
    }
  } catch {
    // Unavailable or malformed storage: the hint starts over.
  }
  return { done: false, races: 0 };
}

export function saveHintProgress(progress: HintProgress): void {
  try {
    window.localStorage.setItem(HINT_KEY, JSON.stringify(progress));
  } catch {
    // Not fatal: the hint may show again after a reload.
  }
}
