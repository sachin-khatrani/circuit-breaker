import { PerformanceMonitor } from '@react-three/drei';
import { Canvas } from '@react-three/fiber';
import { useRef, useState } from 'react';
import { PALETTE } from '../game/palette';
import { QUALITY_PRESETS } from '../game/settings';
import { useGameStore } from '../game/store';
import { CameraRig } from './CameraRig';
import { DebugBridge } from './DebugBridge';
import { PostFx } from './PostFx';
import { ShaderWarmup } from './ShaderWarmup';
import { SimDriver } from './SimDriver';
import { World } from './World';

/**
 * Real resolution changes allowed before adaptive resolution stops and stays on the lower one.
 * Odd, so the last allowed change is always a drop.
 */
const DPR_CHANGE_LIMIT = 3;

/**
 * The one WebGL canvas. It stays mounted for the whole session: menus, races and results
 * reuse the same GPU resources; only the session state changes.
 */
export function GameCanvas() {
  const quality = useGameStore((s) => s.quality);
  const maxDpr = QUALITY_PRESETS[quality].maxDpr;
  const [degraded, setDegraded] = useState(false);
  // drei's own flip-flop limit also counts every "still fast" check, so a machine holding its
  // refresh rate would hit it after ~10 s and drop to DPR 1 for good. Count real changes only.
  const adaptive = useRef({ degraded: false, changes: 0 });
  const adapt = (next: boolean) => {
    const a = adaptive.current;
    if (a.degraded === next || a.changes >= DPR_CHANGE_LIMIT) return;
    a.degraded = next;
    a.changes += 1;
    setDegraded(next);
  };
  const dpr = degraded ? 1 : Math.min(window.devicePixelRatio || 1, maxDpr);
  // `?fx=0` renders without post-processing (debugging, very weak GPUs).
  const postFx = new URLSearchParams(window.location.search).get('fx') !== '0';

  return (
    <Canvas
      className="game-canvas"
      dpr={dpr}
      flat
      gl={{ antialias: false, powerPreference: 'high-performance', stencil: false, alpha: false }}
      camera={{ fov: 64, near: 0.8, far: 6000, position: [0, 12, -30] }}
      onCreated={({ gl }) => gl.setClearColor(PALETTE.fog)}
      fallback={
        <div className="webgl-fallback">This game needs WebGL 2. Try a recent desktop browser.</div>
      }
    >
      <PerformanceMonitor onDecline={() => adapt(true)} onIncline={() => adapt(false)} />
      <SimDriver />
      <World />
      <CameraRig />
      {postFx && <PostFx />}
      <ShaderWarmup postFx={postFx} />
      {import.meta.env.DEV && <DebugBridge />}
    </Canvas>
  );
}
