import { AbilityBar } from './hud/AbilityBar';
import { Banners } from './hud/Banners';
import { BoostMeter } from './hud/BoostMeter';
import { ControlsHint } from './hud/ControlsHint';
import { Countdown } from './hud/Countdown';
import { FinishOverlay } from './hud/FinishOverlay';
import { FirstRaceHint } from './hud/FirstRaceHint';
import { LapPanel } from './hud/LapPanel';
import { MiniMap } from './hud/MiniMap';
import { PositionPanel } from './hud/PositionPanel';
import { RaceFeed } from './hud/RaceFeed';
import { RaceIntro } from './hud/RaceIntro';
import { ScreenFlash } from './hud/ScreenFlash';
import { Standings } from './hud/Standings';
import { TimePanel } from './hud/TimePanel';
import { TouchDrivingNote } from './hud/TouchDrivingNote';
import { Warnings } from './hud/Warnings';
import { useGameStore } from '../game/store';

/**
 * In-race heads-up display, layered over the canvas:
 * LAP (and, online, the live standings) top-left · POSITION top-centre · TIME (and the race
 * feed) top-right · abilities over BOOST bottom-right (in the first races, a hint over them;
 * on touch screens, a note that driving needs keys or a gamepad) · control hint (and track
 * map) bottom-left.
 */
export function Hud() {
  const online = useGameStore((s) => s.raceKind === 'online');
  const serial = useGameStore((s) => s.raceSerial);
  return (
    <div className="pointer-events-none absolute inset-0 select-none">
      <ScreenFlash />
      <div className="hud-tl absolute top-4 left-4 flex flex-col items-start gap-2 md:top-6 md:left-6">
        <LapPanel />
        {/* A phone held upright has no room between LAP and TIME: POSITION moves under LAP. */}
        <div className="hidden max-[520px]:block">
          <PositionPanel />
        </div>
        {online && <Standings />}
      </div>
      <div className="hud-tc absolute top-4 left-1/2 -translate-x-1/2 max-[520px]:hidden md:top-6">
        <PositionPanel />
      </div>
      <div className="hud-tr absolute top-4 right-4 flex flex-col items-end gap-2 md:top-6 md:right-6">
        <TimePanel />
        <RaceFeed />
      </div>
      <div className="hud-bl absolute bottom-4 left-4 flex flex-col items-start gap-3 md:bottom-6 md:left-6">
        <div className="hidden sm:block">
          <MiniMap />
        </div>
        <ControlsHint />
      </div>
      <div className="hud-br absolute right-4 bottom-4 flex flex-col items-end gap-2 md:right-6 md:bottom-6">
        {/* Remounted for every race: each race decides afresh whether it shows. */}
        <FirstRaceHint key={serial} />
        <TouchDrivingNote />
        <AbilityBar />
        <BoostMeter />
      </div>
      <Banners />
      <Warnings />
      <RaceIntro />
      <Countdown />
      <FinishOverlay />
    </div>
  );
}
