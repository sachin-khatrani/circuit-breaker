import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { HalfFloatType, WebGLRenderTarget } from 'three';
import { useGameStore } from '../game/store';

/** Frames to wait after a change, so everything it mounts is in the scene. */
const SETTLE_FRAMES = 2;

/**
 * Compiles every material in the scene ahead of time, hidden and off-screen ones included, so
 * an effect seen for the first time (speed lines, the shortcut's barriers) does not stall a
 * frame mid-race while its shader compiles. Online that stall would also hold back the inputs,
 * an ability press among them. Runs once the world is up and again whenever a race starts.
 */
export function ShaderWarmup({ postFx }: { postFx: boolean }) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const phase = useGameStore((s) => s.phase);
  const screen = useGameStore((s) => s.screen);
  const quality = useGameStore((s) => s.quality);
  // With post-processing the scene is drawn into an off-screen buffer, and shaders are built
  // for the target they draw into: compile for the same kind of target.
  const target = useMemo(() => new WebGLRenderTarget(1, 1, { type: HalfFloatType }), []);
  const countdown = useRef(SETTLE_FRAMES);

  useEffect(() => () => target.dispose(), [target]);
  useEffect(() => {
    countdown.current = SETTLE_FRAMES;
  }, [phase, screen, quality]);

  useFrame(() => {
    if (countdown.current < 0) return;
    if (countdown.current-- > 0) return;
    const previous = gl.getRenderTarget();
    gl.setRenderTarget(postFx ? target : null);
    gl.compile(scene, camera);
    gl.setRenderTarget(previous);
    // Compiling is not the whole cost: the first time a program is drawn, three.js reads its
    // uniforms and checks its link log, and on Windows (ANGLE over Direct3D) that call waits
    // for the driver to finish building the shader. Measured in Step 9: 200-600 ms frames in
    // the countdown and at the first boost of every race. Done here, the wait happens now.
    for (const program of gl.info.programs ?? []) program.getUniforms();
  });
  return null;
}
