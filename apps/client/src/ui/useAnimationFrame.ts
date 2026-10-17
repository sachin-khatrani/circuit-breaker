import { useEffect, useEffectEvent } from 'react';

/**
 * Runs a callback every animation frame for direct DOM updates (speed, timers, minimap).
 * High-frequency HUD values never go through React state.
 */
export function useAnimationFrame(callback: (time: number) => void): void {
  const onFrame = useEffectEvent(callback);
  useEffect(() => {
    let id = 0;
    const loop = (time: number) => {
      onFrame(time);
      id = requestAnimationFrame(loop);
    };
    id = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(id);
  }, []);
}
