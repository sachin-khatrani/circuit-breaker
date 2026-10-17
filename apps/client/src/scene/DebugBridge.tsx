import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import { audio } from '../game/audio';
import { inputManager } from '../game/input';
import { net } from '../net/connection';
import { session } from '../game/session';
import type { Scene } from 'three';
import { useGameStore, type GameState } from '../game/store';

declare global {
  interface Window {
    /** Development-only handle for inspecting and driving the game from the console. */
    __cb?: {
      session: typeof session;
      input: typeof inputManager;
      store: () => GameState;
      scene: () => Scene;
      /** Draw calls and triangles of the last whole frame (every pass), programs, geometries. */
      renderer: () => { calls: number; triangles: number; programs: number; geometries: number };
      camera: () => { x: number; y: number; z: number; fov: number };
      audio: () => typeof audio.debugState;
      /** Link and prediction health of the online race. */
      net: () => {
        status: string;
        rtt: number;
        jitter: number;
        lead: number | null;
        corrections: number;
        largestCorrection: number;
        remotes: number;
      };
      /** The changeable track (shortcut and gate) on the local timeline. */
      course: () => {
        tick: number;
        shortcutOpen: boolean;
        gateLane: number;
        state: Record<string, number>;
      };
    };
  }
}

/** Exposes the session and renderer stats on window.__cb in development builds. */
export function DebugBridge() {
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  const scene = useThree((s) => s.scene);
  // Count a whole frame (scene and post passes): reset by hand at the start of each frame.
  const frame = useRef({ calls: 0, triangles: 0 });
  useEffect(() => {
    gl.info.autoReset = false;
    return () => {
      gl.info.autoReset = true;
    };
  }, [gl]);
  useFrame(() => {
    frame.current.calls = gl.info.render.calls;
    frame.current.triangles = gl.info.render.triangles;
    gl.info.reset();
  }, -10);
  useEffect(() => {
    window.__cb = {
      session,
      input: inputManager,
      store: () => useGameStore.getState(),
      scene: () => scene,
      renderer: () => ({
        calls: frame.current.calls,
        triangles: frame.current.triangles,
        programs: gl.info.programs?.length ?? 0,
        geometries: gl.info.memory.geometries,
      }),
      camera: () => ({
        x: camera.position.x,
        y: camera.position.y,
        z: camera.position.z,
        fov: 'fov' in camera ? camera.fov : 0,
      }),
      audio: () => audio.debugState,
      net: () => ({
        status: net.status,
        rtt: net.clock.rtt,
        jitter: net.clock.jitter,
        lead: session.online?.lead.lead ?? null,
        corrections: session.online?.corrections ?? 0,
        largestCorrection: session.online?.largestCorrection ?? 0,
        remotes: session.remotes.filter((r) => r.visible).length,
      }),
      course: () => ({
        tick: session.sim.tick,
        shortcutOpen: session.sim.shortcutOpen,
        gateLane: session.sim.gateLane,
        state: { ...session.sim.course },
      }),
    };
    return () => {
      delete window.__cb;
    };
  }, [gl, camera, scene]);
  return null;
}
