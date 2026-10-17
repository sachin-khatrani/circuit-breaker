import { goToMenu, startRace } from '../../game/actions';
import { formatTime, toKmh } from '../../game/format';
import { useGameStore } from '../../game/store';

/** Post-race summary with lap breakdown, stats and personal-best call-outs. */
export function ResultsScreen() {
  const results = useGameStore((s) => s.results);
  if (!results) return null;
  const best = Math.min(...results.lapTimes);
  const stats: [string, string][] = [
    ['Top speed', `${Math.round(toKmh(results.topSpeed))} km/h`],
    ['Average', `${Math.round(toKmh(results.averageSpeed))} km/h`],
    ['Energy gained', `${Math.round(results.energyGained)}`],
    ['Cells', `${results.cellsCollected}`],
    ['Boosts', `${results.boosts}`],
    ['Boost pads', `${results.padsHit}`],
    ['Abilities', `${results.shortcuts + results.gateShifts + results.overdrives} used`],
    ['Shortcut runs', `${results.shortcutRuns}`],
    ['Drift time', `${results.driftTime.toFixed(1)} s`],
    ['Wall hits', `${results.wallHits}`],
    ['Off track', `${results.falls}`],
    ['Resets', `${results.respawns}`],
  ];

  return (
    <div className="absolute inset-0 flex items-start justify-center overflow-y-auto p-4 fade-in">
      <div className="scrim" />
      <div className="panel scanlines relative my-auto grid w-full max-w-3xl grid-cols-1 gap-8 p-6 sm:p-8 md:grid-cols-2">
        <div>
          <div className="label text-neon-lime">Race complete</div>
          <h2 className="title-logo mt-1 text-5xl">FINISH</h2>
          <div className="mt-5">
            <div className="label">Total time</div>
            <div className="digits text-5xl font-black text-white glow-cyan">
              {formatTime(results.totalTime)}
            </div>
            {results.newBestTotal && (
              <div className="mt-1 inline-block bg-neon-magenta/20 px-2 py-0.5 font-display text-sm font-bold tracking-[0.2em] text-neon-magenta glow-magenta">
                NEW RECORD
                {results.previous.bestTotal !== null && (
                  <span className="ml-2 text-white/70">
                    −{(results.previous.bestTotal - results.totalTime).toFixed(3)}s
                  </span>
                )}
              </div>
            )}
          </div>
          <div className="mt-5 space-y-1">
            {results.lapTimes.map((lap, i) => (
              <div
                key={i}
                className="flex items-baseline justify-between border-b border-white/10 py-1"
              >
                <span className="label">Lap {i + 1}</span>
                <span
                  className={`digits text-lg ${lap === best ? 'text-neon-magenta glow-magenta' : 'text-white/85'}`}
                >
                  {formatTime(lap)}
                  {lap === best && <span className="label ml-2 text-neon-magenta">best</span>}
                </span>
              </div>
            ))}
          </div>
          {results.newBestLap && (
            <div className="mt-2 label text-neon-lime">New personal best lap</div>
          )}
        </div>
        <div className="flex flex-col justify-between gap-6">
          <div className="grid grid-cols-2 gap-3">
            {stats.map(([label, value]) => (
              <div key={label} className="panel px-3 py-2">
                <div className="label">{label}</div>
                <div className="digits text-xl font-bold text-white">{value}</div>
              </div>
            ))}
          </div>
          <div className="flex flex-col gap-3">
            <button type="button" className="btn btn-primary" onClick={startRace} autoFocus>
              Race again
            </button>
            <button type="button" className="btn btn-ghost" onClick={goToMenu}>
              Main menu
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
