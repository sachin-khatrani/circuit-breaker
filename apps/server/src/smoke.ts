import {
  autopilotInput,
  createInput,
  GRID_ZERO,
  RaceSimulation,
  TICK_RATE,
  Track,
} from '@circuit-breaker/shared';

export interface SmokeReport {
  track: string;
  lengthMetres: number;
  finished: boolean;
  lapSeconds: number | null;
  ticks: number;
  microsPerTick: number;
}

/**
 * Drives one autopilot lap through the authoritative simulation. Proves on every boot that the
 * shared sim runs under Node and reports its cost per tick (the multiplayer budget).
 */
export function runSmokeRace(): SmokeReport {
  const track = new Track(GRID_ZERO);
  const sim = new RaceSimulation(track, { laps: 1, skipCountdown: true });
  const bot = sim.addRacer('smoke', 'Smoke');
  const input = createInput();
  const started = performance.now();
  while (sim.phase !== 'finished' && sim.tick < TICK_RATE * 180) {
    autopilotInput(track, bot.vehicle, { racingLine: true }, input);
    sim.setInput(bot.id, input);
    sim.step();
    sim.drainEvents();
  }
  const elapsed = performance.now() - started;
  return {
    track: track.name,
    lengthMetres: Math.round(track.length),
    finished: bot.finished,
    lapSeconds: bot.finishTime,
    ticks: sim.tick,
    microsPerTick: Math.round((elapsed * 1000) / Math.max(1, sim.tick)),
  };
}
