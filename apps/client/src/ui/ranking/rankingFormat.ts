/** A rating change with its sign: "+14", "−9", "±0". */
export function signed(delta: number): string {
  if (delta > 0) return `+${delta}`;
  if (delta < 0) return `−${Math.abs(delta)}`;
  return '±0';
}

/** Colour of a rating change. */
export function deltaClass(delta: number): string {
  if (delta > 0) return 'text-neon-lime';
  if (delta < 0) return 'text-neon-red';
  return 'text-white/55';
}

/** Win rate is shown once there are enough rated races for it to mean something. */
export const WIN_RATE_MIN_RACES = 5;

export function winRate(wins: number, races: number): string {
  return races >= WIN_RATE_MIN_RACES ? `${Math.round((wins / races) * 100)}%` : '—';
}

/** "13 Oct 2026" */
export function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** "5 min ago", "3 h ago", "2 days ago", or the date for anything older than a month. */
export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 30 * 86_400) {
    const days = Math.floor(s / 86_400);
    return `${days} ${days === 1 ? 'day' : 'days'} ago`;
  }
  return shortDate(iso);
}

/** "1 win", "3 wins". */
export const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Lap and race times arrive in milliseconds from the profile API. */
export const msToSeconds = (ms: number | null) => (ms === null ? null : ms / 1000);
