/** 83.456 → "01:23.456" (the HUD clock's style, with milliseconds). Null renders dashes. */
export function formatTime(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return '--:--.---';
  }
  const totalMs = Math.round(seconds * 1000);
  const minutes = Math.floor(totalMs / 60000);
  const secs = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

/** Signed delta for split comparisons: "-0.42" / "+1.07". */
export function formatDelta(seconds: number): string {
  const sign = seconds < 0 ? '-' : '+';
  return `${sign}${Math.abs(seconds).toFixed(2)}`;
}

export const toKmh = (metresPerSecond: number): number => metresPerSecond * 3.6;

/** Race clock: 32.42 s → "00:32.42" (minutes, seconds, hundredths). */
export function formatClock(seconds: number | null | undefined): string {
  const value = seconds !== null && seconds !== undefined && Number.isFinite(seconds) ? seconds : 0;
  const hundredths = Math.floor(Math.max(0, value) * 100);
  const minutes = Math.floor(hundredths / 6000);
  const secs = Math.floor((hundredths % 6000) / 100);
  const frac = hundredths % 100;
  return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(frac).padStart(2, '0')}`;
}

/** 1 → "st", 2 → "nd", 3 → "rd", 11 → "th"… */
export function ordinalSuffix(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return 'th';
  return ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
}

export const ordinal = (n: number): string => `${n}${ordinalSuffix(n)}`;
