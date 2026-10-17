/**
 * Local personal bests. The race total is kept per lap count (a 1-lap time is no 3-lap
 * record); the best lap is shared by every race length. Multiplayer results will come from the
 * server instead.
 */
export interface TrackRecord {
  bestTotal: number | null;
  bestLap: number | null;
}

const totalKey = (trackId: string, laps: number) => `circuit-breaker.best-race.${trackId}.${laps}`;
const lapKey = (trackId: string) => `circuit-breaker.best-lap.${trackId}`;

function readNumber(key: string): number | null {
  try {
    const raw = window.localStorage.getItem(key);
    const value = raw === null ? NaN : Number(raw);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    // Blocked or unavailable storage means no record yet.
    return null;
  }
}

function writeNumber(key: string, value: number): void {
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // Not fatal: the record just will not survive a reload.
  }
}

export function loadRecord(trackId: string, laps: number): TrackRecord {
  return { bestTotal: readNumber(totalKey(trackId, laps)), bestLap: readNumber(lapKey(trackId)) };
}

export function saveRecord(trackId: string, laps: number, record: TrackRecord): void {
  if (record.bestTotal !== null) writeNumber(totalKey(trackId, laps), record.bestTotal);
  if (record.bestLap !== null) writeNumber(lapKey(trackId), record.bestLap);
}
