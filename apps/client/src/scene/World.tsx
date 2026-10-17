import { PLAYER_COLORS } from '@circuit-breaker/shared';
import { Environment, Lightformer } from '@react-three/drei';
import { useMemo } from 'react';
import { Vector2 } from 'three';
import { PALETTE } from '../game/palette';
import { session } from '../game/session';
import { QUALITY_PRESETS } from '../game/settings';
import { useGameStore } from '../game/store';
import { Billboards } from './environment/Billboards';
import { City } from './environment/City';
import { planCity } from './environment/cityLayout';
import { Ground } from './environment/Ground';
import { Reactor } from './environment/Reactor';
import { Searchlights } from './environment/Searchlights';
import { Sky } from './environment/Sky';
import { SkyTraffic } from './environment/SkyTraffic';
import { Motes } from './fx/Motes';
import { Particles } from './fx/Particles';
import { RaceFx } from './fx/RaceFx';
import { SpeedLines } from './fx/SpeedLines';
import { EnergyCells } from './track/EnergyCells';
import { Gates } from './track/Gates';
import { StartGantry } from './track/StartGantry';
import { TrackSigns } from './track/TrackSigns';
import { TrackScene } from './track/TrackScene';
import { RouteScene } from './track/RouteScene';
import { TrackZones } from './track/TrackZones';
import { TurnMarkers } from './track/TurnMarkers';
import { PlayerCar } from './vehicle/PlayerCar';
import { RemoteCars } from './vehicle/RemoteCars';

export const FOG_DENSITY = 0.0014;

/** Everything in the world: atmosphere, district, circuit, car and effects. */
export function World() {
  const quality = useGameStore((s) => s.quality);
  const preset = QUALITY_PRESETS[quality];
  const reducedMotion = useGameStore((s) => s.reducedMotion);
  const carColor = useGameStore((s) => s.carColor);
  const carStyle = useGameStore((s) => s.carStyle);
  const plan = useMemo(() => planCity(session.track, preset.towers), [preset.towers]);
  const center = useMemo(() => new Vector2(plan.reactor.x, plan.reactor.z), [plan]);

  return (
    <>
      <color attach="background" args={[PALETTE.fog]} />
      <fogExp2 attach="fog" args={[PALETTE.fog, FOG_DENSITY]} />
      <hemisphereLight args={['#6b5cff', '#1a0b24', 0.55]} />
      <directionalLight position={[-400, 600, -300]} intensity={0.6} color="#a9b8ff" />

      {/* A neon reflection probe rendered once from coloured panels: no HDR download. */}
      <Environment resolution={256} frames={1}>
        <color attach="background" args={['#04030a']} />
        <Lightformer
          form="rect"
          intensity={3}
          color={PALETTE.magenta}
          position={[-12, 3, -8]}
          scale={[18, 3, 1]}
        />
        <Lightformer
          form="rect"
          intensity={3}
          color={PALETTE.cyan}
          position={[12, 3, 8]}
          scale={[18, 3, 1]}
        />
        <Lightformer
          form="rect"
          intensity={0.6}
          color={PALETTE.violet}
          position={[0, 16, 0]}
          rotation-x={Math.PI / 2}
          scale={[30, 30, 1]}
        />
        <Lightformer form="ring" intensity={4} color="#ffffff" position={[0, 5, -15]} scale={3} />
        <Lightformer
          form="rect"
          intensity={2}
          color={PALETTE.amber}
          position={[0, 2, 16]}
          scale={[10, 2, 1]}
        />
      </Environment>

      <Sky />
      <Ground center={center} />
      <City towers={plan.towers} />
      <Reactor x={plan.reactor.x} z={plan.reactor.z} />
      <Billboards billboards={plan.billboards} />
      <Searchlights cx={plan.reactor.x} cz={plan.reactor.z} />
      <SkyTraffic cx={plan.reactor.x} cz={plan.reactor.z} />

      <TrackScene />
      <TrackZones />
      <RouteScene />
      <Gates />
      <StartGantry />
      <TrackSigns />
      <TurnMarkers />
      <EnergyCells />

      <PlayerCar
        key={`${carColor}-${carStyle}`}
        color={PLAYER_COLORS[carColor] ?? PALETTE.cyan}
        style={carStyle}
      />
      <RemoteCars />
      <Particles />
      <RaceFx />
      {preset.motes > 0 && <Motes count={preset.motes} />}
      {preset.speedLines && !reducedMotion && <SpeedLines />}
    </>
  );
}
