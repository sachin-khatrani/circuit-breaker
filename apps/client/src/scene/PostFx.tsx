import { clamp, damp } from '@circuit-breaker/shared';
import { useFrame } from '@react-three/fiber';
import {
  Bloom,
  ChromaticAberration,
  EffectComposer,
  SMAA,
  ToneMapping,
  Vignette,
} from '@react-three/postprocessing';
import { ToneMappingMode, type ChromaticAberrationEffect } from 'postprocessing';
import { useMemo, useRef } from 'react';
import { Vector2 } from 'three';
import { session } from '../game/session';
import { QUALITY_PRESETS } from '../game/settings';
import { useGameStore } from '../game/store';

/**
 * HDR post chain: mipmap bloom makes the neon read, chromatic aberration kicks in with boost,
 * vignette frames the action. Khronos PBR Neutral tone mapping runs last: unlike AgX or ACES it
 * keeps saturated neon hues intact.
 */
export function PostFx() {
  const quality = useGameStore((s) => s.quality);
  const preset = QUALITY_PRESETS[quality];
  const reducedMotion = useGameStore((s) => s.reducedMotion);
  const aberration = useRef<ChromaticAberrationEffect>(null);
  const amount = useRef(0);
  const offset = useMemo(() => new Vector2(0.0005, 0.0003), []);

  useFrame((_, delta) => {
    const effect = aberration.current;
    if (!effect) return;
    const car = session.render;
    const target =
      car.boosting || car.overdrive || car.padBoost
        ? 1
        : car.impulse
          ? 0.55
          : clamp((car.speed - 60) / 40, 0, 0.3);
    amount.current = damp(amount.current, target, 6, delta);
    const k = 0.0004 + amount.current * 0.0026;
    effect.offset.set(k, k * 0.6);
  });

  return (
    <EffectComposer key={`${quality}-${reducedMotion}`} multisampling={0}>
      <Bloom
        mipmapBlur
        intensity={1.15}
        luminanceThreshold={0.95}
        luminanceSmoothing={0.3}
        levels={preset.bloomLevels}
        resolutionScale={preset.bloomScale}
      />
      {preset.chromaticAberration && !reducedMotion && (
        <ChromaticAberration
          ref={aberration}
          offset={offset}
          radialModulation
          modulationOffset={0.3}
        />
      )}
      <Vignette offset={0.3} darkness={0.7} />
      <ToneMapping mode={ToneMappingMode.NEUTRAL} />
      {preset.smaa && <SMAA />}
    </EffectComposer>
  );
}
