import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import { Color, DoubleSide, MeshBasicMaterial, MeshStandardMaterial } from 'three';
import { session } from '../../game/session';
import {
  createBarrierMaterial,
  createDeckMaterial,
  createPulseMaterial,
  createRoadMaterial,
} from './materials';
import {
  buildBarrierGeometry,
  buildDeckGeometry,
  buildRailGeometry,
  buildRoadGeometry,
  buildTrackFurniture,
} from './trackGeometry';
import { buildTunnels } from './tunnelGeometry';

/**
 * Road, deck, neon rails, energy barriers, tunnels and all instanced furniture: about ten draw
 * calls for the whole circuit.
 */
export function TrackScene() {
  const track = session.track;
  const parts = useMemo(() => {
    const furniture = buildTrackFurniture(track);
    // Tunnel ribs and portal outlines join the shared neon batch before it is built.
    const tunnels = buildTunnels(track, furniture.neon);
    const structureMaterial = new MeshStandardMaterial({
      color: new Color('#151a2a'),
      metalness: 0.75,
      roughness: 0.4,
    });
    const neonMaterial = new MeshBasicMaterial({ color: '#ffffff', toneMapped: false });
    return {
      road: buildRoadGeometry(track),
      deck: buildDeckGeometry(track),
      rails: buildRailGeometry(track),
      barriers: buildBarrierGeometry(track),
      roadMaterial: createRoadMaterial(track),
      deckMaterial: createDeckMaterial(),
      pulseMaterial: createPulseMaterial(),
      barrierMaterial: createBarrierMaterial(),
      tunnels,
      tunnelMaterial: new MeshStandardMaterial({
        color: new Color('#0e111b'),
        metalness: 0.7,
        roughness: 0.45,
        side: DoubleSide,
      }),
      structure: furniture.structure.build(structureMaterial),
      neon: furniture.neon.build(neonMaterial),
    };
  }, [track]);

  useEffect(
    () => () => {
      for (const mesh of [parts.structure, parts.neon]) {
        mesh.geometry.dispose();
        (mesh.material as MeshStandardMaterial).dispose();
        mesh.dispose();
      }
      parts.tunnels?.shell.dispose();
      parts.tunnels?.strips.dispose();
      parts.tunnelMaterial.dispose();
      parts.pulseMaterial.dispose();
    },
    [parts],
  );

  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    parts.roadMaterial.userData.uTime.value = t;
    parts.barrierMaterial.uniforms.uTime.value = t;
    parts.pulseMaterial.uniforms.uTime.value = t;
  });

  return (
    <group>
      <mesh geometry={parts.road} material={parts.roadMaterial} />
      <mesh geometry={parts.deck} material={parts.deckMaterial} />
      <mesh geometry={parts.rails} material={parts.pulseMaterial} />
      {parts.tunnels && (
        <>
          <mesh geometry={parts.tunnels.shell} material={parts.tunnelMaterial} />
          <mesh geometry={parts.tunnels.strips} material={parts.pulseMaterial} />
        </>
      )}
      <primitive object={parts.structure} />
      <primitive object={parts.neon} />
      <mesh geometry={parts.barriers} material={parts.barrierMaterial} renderOrder={2} />
    </group>
  );
}
