import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo } from 'react';
import {
  BufferAttribute,
  Color,
  FrontSide,
  Group,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
} from 'three';
import { session } from '../../game/session';
import { createHologramMaterial } from '../environment/hologram';
import { getSignAtlas, panelUv } from '../textures';
import { BoxBatch, SHOULDER } from './trackGeometry';
import { tunnelRanges } from './tunnelGeometry';

const TUNNEL_PANEL = 8;
const SKYWAY_PANEL = 9;

function panelGeometry(panel: number, width: number, height: number): PlaneGeometry {
  const geometry = new PlaneGeometry(width, height);
  const rect = panelUv(panel);
  const data = new Float32Array(16);
  for (let i = 0; i < 4; i++) data.set(rect, i * 4);
  geometry.setAttribute('aRect', new BufferAttribute(data, 4));
  return geometry;
}

/**
 * Holographic signs that announce the track's set pieces: "ION TUNNEL" above each tunnel
 * portal and a "SKYWAY // NO BARRIERS" gantry before every open stretch.
 */
export function TrackSigns() {
  const track = session.track;
  const parts = useMemo(() => {
    const group = new Group();
    const material = createHologramMaterial(getSignAtlas(), 2.3);
    material.side = FrontSide;
    const geometries: PlaneGeometry[] = [];
    const posts = new BoxBatch();

    const place = (s: number, panel: number, width: number, height: number, lift: number) => {
      const f = track.frameAt(s);
      const geometry = panelGeometry(panel, width, height);
      geometries.push(geometry);
      const mesh = new Mesh(geometry, material);
      // Face the oncoming cars.
      mesh.position.set(f.x, f.y + lift, f.z);
      mesh.rotation.y = f.heading + Math.PI;
      mesh.renderOrder = 3;
      group.add(mesh);
      return f;
    };

    for (const [first] of tunnelRanges(track)) {
      const s = first * track.spacing - 0.6;
      const f = track.frameAt(s);
      place(s, TUNNEL_PANEL, f.halfWidth * 1.6, f.halfWidth * 0.4, track.roof[first] + 3.2);
    }

    for (const edge of track.def.openEdges ?? []) {
      const s = track.paramToS(edge.from) - 35;
      const f = place(s, SKYWAY_PANEL, 18, 4.5, 9.5);
      // A two-post gantry holding the sign, standing on the deck shoulders.
      for (const sign of [-1, 1]) {
        const lat = sign * (f.halfWidth + SHOULDER * 0.6);
        const x = f.x + f.rx * lat;
        const z = f.z + f.rz * lat;
        const base = f.y - lat * Math.tan(f.bank);
        posts.add(x, base, z, x, f.y + 12, z, 0.7, 0.7, f.fx, f.fz);
      }
      const lx = f.x - f.rx * (f.halfWidth + SHOULDER * 0.6);
      const lz = f.z - f.rz * (f.halfWidth + SHOULDER * 0.6);
      const rx = f.x + f.rx * (f.halfWidth + SHOULDER * 0.6);
      const rz = f.z + f.rz * (f.halfWidth + SHOULDER * 0.6);
      posts.add(lx, f.y + 12, lz, rx, f.y + 12, rz, 0.6, 0.9, f.fx, f.fz);
    }

    const postMesh = posts.count
      ? posts.build(
          new MeshStandardMaterial({
            color: new Color('#141826'),
            metalness: 0.75,
            roughness: 0.4,
          }),
        )
      : null;
    if (postMesh) group.add(postMesh);
    return { group, material, geometries, postMesh };
  }, [track]);

  useEffect(
    () => () => {
      for (const g of parts.geometries) g.dispose();
      parts.material.dispose();
      if (parts.postMesh) {
        parts.postMesh.geometry.dispose();
        (parts.postMesh.material as MeshStandardMaterial).dispose();
        parts.postMesh.dispose();
      }
    },
    [parts],
  );

  useFrame(({ clock }) => {
    parts.material.uniforms.uTime.value = clock.elapsedTime;
  });

  return <primitive object={parts.group} />;
}
