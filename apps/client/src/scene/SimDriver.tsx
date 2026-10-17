import { useFrame } from '@react-three/fiber';
import { audio } from '../game/audio';
import { session } from '../game/session';

/**
 * Runs before everything else each frame: input sampling, the fixed-step simulation, then the
 * engine sound from the new car state.
 */
export function SimDriver() {
  useFrame((_, delta) => {
    session.update(delta);
    audio.update(delta);
  }, -3);
  return null;
}
