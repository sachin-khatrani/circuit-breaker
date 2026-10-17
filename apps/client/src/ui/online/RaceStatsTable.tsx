import type { RaceResults, RaceStats } from '@circuit-breaker/shared';
import { toKmh } from '../../game/format';
import { PlayerSwatch } from './PlayerSwatch';

/** The columns: what the server counted for every car in the race. */
const COLUMNS: {
  key: keyof RaceStats;
  label: string;
  /** What the number counts, in the one-line form on narrow screens. */
  unit: string;
  title: string;
  show?: (v: number) => string;
}[] = [
  { key: 'boosts', label: 'Boosts', unit: 'boosts', title: 'Boost bursts fired' },
  { key: 'overdrives', label: 'Overdrive', unit: 'overdrive', title: 'Overdrive activations' },
  // Runs through the shortcut, not openings (those are in the ability log): say so.
  {
    key: 'shortcutRuns',
    label: 'Needle runs',
    unit: 'Needle runs',
    title: 'Drives through the Needle shortcut',
  },
  {
    key: 'energy',
    label: 'Energy',
    unit: 'energy',
    title: 'Energy collected (cells, drifts, speed lanes)',
  },
  {
    key: 'driftSeconds',
    label: 'Drift',
    unit: 'drift',
    title: 'Time spent drifting',
    show: (v) => `${v.toFixed(1)}s`,
  },
  {
    key: 'topSpeed',
    label: 'Top',
    unit: 'km/h',
    title: 'Top speed (km/h)',
    show: (v) => `${Math.round(toKmh(v))}`,
  },
];

/** Every car's numbers from the race, as the server's simulation counted them. */
export function RaceStatsTable({
  results,
  playerId,
}: {
  results: RaceResults;
  playerId: string | null;
}) {
  return (
    <>
      {/* Narrow screens: one line of numbers per driver instead of a wide table. */}
      <ul className="stats-narrow flex flex-col gap-1.5">
        {results.entries.map((entry) => (
          <li
            key={entry.id}
            className={`border-t border-white/10 pt-1.5 text-sm ${entry.id === playerId ? 'text-white' : 'text-white/80'}`}
          >
            <span className="mr-2 inline-flex items-center gap-1.5 font-bold">
              <PlayerSwatch color={entry.color} size={10} />
              {entry.name}
            </span>
            <span className="digits text-white/70">
              {COLUMNS.map(
                (c) => `${c.show ? c.show(entry.stats[c.key]) : entry.stats[c.key]} ${c.unit}`,
              ).join(' · ')}
            </span>
          </li>
        ))}
      </ul>
      <table className="stats-wide stats-table w-full table-fixed border-collapse text-left">
        <thead>
          <tr className="label text-[0.58rem]">
            <th className="w-[28%] py-1 pr-1 font-bold">Driver</th>
            {COLUMNS.map((c) => (
              <th key={c.key} className="py-1 text-right font-bold" title={c.title}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {results.entries.map((entry) => (
            <tr
              key={entry.id}
              className={`border-t border-white/10 ${entry.id === playerId ? 'bg-neon-cyan/10' : ''}`}
            >
              <td className="py-1 pr-1">
                <span className="flex min-w-0 items-center gap-1.5 text-sm font-bold">
                  <PlayerSwatch color={entry.color} size={10} />
                  <span className="truncate">{entry.name}</span>
                </span>
              </td>
              {COLUMNS.map((c) => {
                const value = entry.stats[c.key];
                return (
                  <td key={c.key} className="digits py-1 text-right text-sm text-white/85">
                    {c.show ? c.show(value) : value}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
