import { LEFT_LANE, type AbilityRecord, type AbilityId } from '@circuit-breaker/shared';
import { formatClock } from '../../game/format';

const NAMES: Record<AbilityId, string> = {
  shortcut: 'Shortcut',
  gate: 'Gate Shift',
  overdrive: 'Overdrive',
};

const REASONS: Record<NonNullable<AbilityRecord['reason']>, string> = {
  energy: 'not enough Energy',
  cooldown: 'cooling down',
  busy: 'track busy',
  phase: 'not during the race',
  unavailable: 'not on this track',
};

/** What a successful use did to the track. */
function outcome(r: AbilityRecord): string {
  if (!r.ok) return `refused: ${r.reason ? REASONS[r.reason] : 'refused'}`;
  if (r.ability === 'shortcut' && r.from !== null && r.until !== null) {
    return `open ${formatClock(r.from)}–${formatClock(r.until)}`;
  }
  if (r.ability === 'gate' && r.lane !== null && r.from !== null) {
    return `${r.lane === LEFT_LANE ? 'outside' : 'inside'} lane from ${formatClock(r.from)}`;
  }
  return 'ran 3 s';
}

/**
 * The race's ability record, as the server judged it: each press with its time, player,
 * ability and outcome (or why it was refused), and a count of successful uses per player.
 */
export function AbilityLog({ records }: { records: AbilityRecord[] }) {
  if (records.length === 0) {
    return <div className="label text-white/50">No abilities were used this race.</div>;
  }
  const used = records.filter((r) => r.ok);
  const byPlayer = new Map<string, { name: string; counts: Partial<Record<AbilityId, number>> }>();
  for (const r of used) {
    const entry = byPlayer.get(r.racerId) ?? { name: r.name, counts: {} };
    entry.counts[r.ability] = (entry.counts[r.ability] ?? 0) + 1;
    byPlayer.set(r.racerId, entry);
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {[...byPlayer.values()].map((p) => (
          <span key={p.name} className="text-sm font-bold text-white/85">
            {p.name}:{' '}
            <span className="font-normal text-white/65">
              {(Object.keys(p.counts) as AbilityId[])
                .map((id) => `${NAMES[id]} ×${p.counts[id]}`)
                .join(', ')}
            </span>
          </span>
        ))}
      </div>
      <ol className="max-h-32 overflow-y-auto pr-1 text-sm">
        {records.map((r, i) => (
          <li key={i} className="flex gap-3 border-b border-white/5 py-0.5">
            <span className="digits w-20 shrink-0 text-white/55">{formatClock(r.time)}</span>
            <span className="w-24 shrink-0 truncate font-bold">{r.name}</span>
            <span className={`w-24 shrink-0 ${r.ok ? 'text-neon-lime' : 'text-white/45'}`}>
              {NAMES[r.ability]}
            </span>
            <span className={r.ok ? 'text-white/75' : 'text-neon-red/80'}>{outcome(r)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
