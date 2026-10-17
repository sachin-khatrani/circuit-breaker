import { clamp, type RaceEvent } from '@circuit-breaker/shared';
import { session } from './session';
import { useGameStore } from './store';

/** Parameter updates for the continuous layers run at this rate, not every rendered frame. */
const PARAM_RATE = 30;
const NOISE_SECONDS = 2;

interface EngineVoice {
  /** Motor body (sawtooth), its sub-octave (square) and an electric whine (triangle). */
  body: OscillatorNode;
  sub: OscillatorNode;
  whine: OscillatorNode;
  filter: BiquadFilterNode;
  gain: GainNode;
  whineGain: GainNode;
  /** One looping noise source feeds wind, boost hiss and tyre skid. */
  windFilter: BiquadFilterNode;
  windGain: GainNode;
  hissGain: GainNode;
  skidFilter: BiquadFilterNode;
  skidGain: GainNode;
}

interface ToneOptions {
  type?: OscillatorType;
  gain?: number;
  /** Glide to this frequency over the tone. */
  to?: number;
  /** Seconds from now. */
  delay?: number;
  attack?: number;
}

interface NoiseOptions {
  filter?: BiquadFilterType;
  from: number;
  to?: number;
  q?: number;
  gain?: number;
  delay?: number;
}

/**
 * All game sound, synthesised with WebAudio oscillators and filtered noise: the game ships no
 * audio files. These are placeholders for produced sounds later (listed in
 * docs/05-rendering.md).
 *
 * Browsers allow audio only after a user gesture, so nothing is created until `unlock()` runs
 * from a key press or click. Volume and mute come from the settings store.
 */
class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfx: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private engine: EngineVoice | null = null;
  private sinceParams = 0;
  private detach: (() => void) | null = null;

  /** Creates (or resumes) the audio context. Call from a user-gesture handler. */
  unlock(): void {
    if (typeof window === 'undefined' || !('AudioContext' in window)) return;
    if (this.ctx) {
      if (this.ctx.state === 'suspended' && !document.hidden) void this.ctx.resume();
      return;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -14;
    compressor.ratio.value = 4;
    compressor.connect(ctx.destination);
    this.master = ctx.createGain();
    this.master.connect(compressor);
    this.sfx = ctx.createGain();
    this.sfx.connect(this.master);
    this.noise = createNoise(ctx);
    this.engine = this.createEngine(ctx, this.master, this.noise);
    this.applyVolume();
  }

  /** For inspection (dev tools, tests): context state and the current master gain. */
  get debugState(): { context: AudioContextState | 'none'; masterGain: number } {
    return { context: this.ctx?.state ?? 'none', masterGain: this.master?.gain.value ?? 0 };
  }

  /** Subscribes to race events and settings; returns a function that undoes it. */
  attach(): () => void {
    this.detach?.();
    const offEvents = session.onEvent((event) => this.onEvent(event));
    const offFeed = session.onFeed((event) => this.onTrackChange(event));
    const offStore = useGameStore.subscribe((state, prev) => {
      if (state.volume !== prev.volume || state.muted !== prev.muted) this.applyVolume();
    });
    const onVisibility = () => {
      if (!this.ctx) return;
      if (document.hidden) void this.ctx.suspend();
      else void this.ctx.resume();
    };
    document.addEventListener('visibilitychange', onVisibility);
    this.detach = () => {
      offEvents();
      offFeed();
      offStore();
      document.removeEventListener('visibilitychange', onVisibility);
      this.detach = null;
    };
    return this.detach;
  }

  /** Per-frame update of the continuous layers from the local car. */
  update(dt: number): void {
    const ctx = this.ctx;
    const e = this.engine;
    if (!ctx || !e) return;
    this.sinceParams += dt;
    if (this.sinceParams < 1 / PARAM_RATE) return;
    this.sinceParams = 0;
    const now = ctx.currentTime;
    const car = session.render;
    // The engine plays in races only (the attract mode behind the menu stays quiet).
    const on = session.live && !session.paused && !car.frozen ? 1 : 0;
    const air = car.surface === 'air' ? 0.6 : 1;
    const speed = car.speed;
    const n = clamp(speed / 72, 0, 1.3);
    const boost = car.boosting || car.overdrive || car.padBoost ? 1 : 0;
    const f = 38 + speed * 1.55;
    e.body.frequency.setTargetAtTime(f, now, 0.05);
    e.sub.frequency.setTargetAtTime(f * 0.5, now, 0.05);
    e.whine.frequency.setTargetAtTime(f * 4 + boost * 160, now, 0.08);
    e.filter.frequency.setTargetAtTime(
      260 + car.throttle * 1100 + speed * 14 + boost * 900,
      now,
      0.06,
    );
    e.gain.gain.setTargetAtTime(on * air * (0.05 + car.throttle * 0.05 + n * 0.035), now, 0.08);
    e.whineGain.gain.setTargetAtTime(on * (0.006 + n * 0.018 + boost * 0.03), now, 0.1);
    e.windFilter.frequency.setTargetAtTime(450 + speed * 24, now, 0.15);
    e.windGain.gain.setTargetAtTime(on * n * n * 0.06, now, 0.15);
    e.hissGain.gain.setTargetAtTime(on * boost * 0.06, now, 0.05);
    const slide = car.speed > 1 ? clamp((Math.abs(car.lateralSpeed) / car.speed) * 2.4, 0, 1) : 0;
    const skid = car.drifting && car.surface === 'road' ? 0.03 + slide * 0.06 : 0;
    e.skidFilter.frequency.setTargetAtTime(1500 + slide * 900, now, 0.05);
    e.skidGain.gain.setTargetAtTime(on * skid, now, 0.04);
  }

  private applyVolume(): void {
    if (!this.ctx || !this.master) return;
    const { volume, muted } = useGameStore.getState();
    // Squared: the slider feels even across its range.
    this.master.gain.setTargetAtTime(muted ? 0 : volume * volume, this.ctx.currentTime, 0.02);
  }

  private get audible(): boolean {
    const { muted, volume } = useGameStore.getState();
    return this.ctx !== null && this.ctx.state === 'running' && !muted && volume > 0;
  }

  private onEvent(event: RaceEvent): void {
    if (!session.racing || !this.audible) return;
    if ('racerId' in event && event.racerId !== session.playerId) return;
    switch (event.type) {
      case 'countdown':
        this.tone(523, 0.16, { type: 'square', gain: 0.11 });
        break;
      case 'go':
        this.tone(1047, 0.55, { type: 'square', gain: 0.12 });
        this.tone(1568, 0.55, { type: 'triangle', gain: 0.08 });
        break;
      case 'launchBoost':
        this.whoosh(0.5, 300, 2600, 0.25);
        this.tone(660, 0.3, { type: 'triangle', to: 1320, gain: 0.08 });
        break;
      case 'boost':
        this.whoosh(0.6, 260, 3200, 0.32);
        this.tone(120, 0.32, { to: 48, gain: 0.32 });
        this.tone(220, 0.38, { type: 'sawtooth', to: 880, gain: 0.04 });
        break;
      case 'boostDenied':
        this.tone(196, 0.08, { type: 'square', gain: 0.07 });
        this.tone(147, 0.13, { type: 'square', gain: 0.07, delay: 0.09 });
        break;
      case 'boostPad':
        this.tone(330, 0.26, { type: 'sawtooth', to: 1400, gain: 0.06 });
        this.noiseBurst(0.4, { filter: 'highpass', from: 1500, to: 6000, gain: 0.18 });
        this.tone(1760, 0.1, { gain: 0.07, delay: 0.06 });
        break;
      case 'cell':
        this.tone(1319, 0.12, { gain: 0.1 });
        this.tone(1976, 0.2, { gain: 0.08, delay: 0.06 });
        break;
      case 'driftReward':
        this.tone(988, 0.1, { type: 'triangle', gain: 0.07 });
        this.tone(1319, 0.16, { type: 'triangle', gain: 0.06, delay: 0.06 });
        break;
      case 'driftEnd':
        if (event.tier > 0) {
          const top = event.tier === 2 ? 1320 : 880;
          this.tone(top / 2, 0.25, { type: 'square', to: top, gain: 0.05 });
          this.whoosh(0.3, 600, 3000, 0.14);
        }
        break;
      case 'checkpoint':
        this.tone(880, 0.09, { gain: 0.11 });
        this.tone(1320, 0.15, { gain: 0.11, delay: 0.08 });
        break;
      case 'lap': {
        const laps = session.sim.laps;
        if (event.lap >= laps) break;
        if (event.lap === laps - 1) {
          // Final lap: a distinct, longer rising call.
          [392, 523, 659, 784, 1047].forEach((freq, i) =>
            this.tone(freq, i === 4 ? 0.7 : 0.12, { type: 'square', gain: 0.07, delay: i * 0.07 }),
          );
        } else {
          [523, 659, 784].forEach((freq, i) =>
            this.tone(freq, 0.16, { type: 'triangle', gain: 0.1, delay: i * 0.07 }),
          );
        }
        break;
      }
      case 'finish':
        [523, 659, 784, 1047].forEach((freq, i) =>
          this.tone(freq, 0.14, { type: 'square', gain: 0.07, delay: i * 0.09 }),
        );
        for (const freq of [523, 659, 784, 1047]) {
          this.tone(freq, 1.3, { type: 'triangle', gain: 0.06, delay: 0.38, attack: 0.02 });
        }
        break;
      case 'wallHit': {
        const k = clamp(event.impact / 20, 0.15, 1);
        this.tone(90, 0.25, { to: 42, gain: 0.32 * k });
        this.noiseBurst(0.18, { filter: 'lowpass', from: 1400, to: 200, gain: 0.25 * k });
        break;
      }
      case 'respawn':
        this.tone(880, 0.32, { to: 220, gain: 0.08 });
        this.tone(220, 0.3, { to: 660, gain: 0.08, delay: 0.42 });
        break;
      case 'ability':
        if (event.ability === 'overdrive') {
          // A deeper, longer ignition than a boost burst.
          this.whoosh(0.9, 180, 3600, 0.4);
          this.tone(70, 0.6, { to: 40, gain: 0.34 });
          this.tone(330, 0.7, { type: 'sawtooth', to: 1320, gain: 0.05 });
        } else if (event.ability === 'shortcut') {
          [587, 784, 1175].forEach((freq, i) =>
            this.tone(freq, 0.14, { type: 'triangle', gain: 0.09, delay: i * 0.06 }),
          );
        } else {
          this.tone(392, 0.12, { type: 'square', gain: 0.07 });
          this.tone(523, 0.18, { type: 'square', gain: 0.07, delay: 0.1 });
        }
        break;
      case 'abilityDenied':
        this.tone(196, 0.08, { type: 'square', gain: 0.07 });
        this.tone(147, 0.13, { type: 'square', gain: 0.07, delay: 0.09 });
        break;
      case 'overdriveEnd':
        this.tone(660, 0.35, { type: 'triangle', to: 220, gain: 0.06 });
        break;
      case 'laneCharge':
        this.tone(1175, 0.1, { type: 'triangle', gain: 0.06 });
        this.tone(1568, 0.14, { type: 'triangle', gain: 0.05, delay: 0.05 });
        break;
      default:
        break;
    }
  }

  /** The track changing (anyone's ability): short cues so a change is heard as well as seen. */
  private onTrackChange(event: RaceEvent): void {
    if (!session.racing || !this.audible) return;
    if (event.type === 'gate' && event.phase === 'warning') {
      // Three warning pips over the gate's warning time.
      [0, 0.8, 1.6].forEach((delay) => this.tone(880, 0.12, { type: 'square', gain: 0.05, delay }));
    } else if (event.type === 'gate' && event.phase === 'switched') {
      this.noiseBurst(0.35, { filter: 'lowpass', from: 900, to: 200, gain: 0.12 });
    } else if (event.type === 'shortcut' && event.phase === 'closing') {
      [0, 0.5, 1.0, 1.5].forEach((delay) =>
        this.tone(740, 0.08, { type: 'square', gain: 0.04, delay }),
      );
    } else if (event.type === 'shortcut' && event.phase === 'closed') {
      this.noiseBurst(0.3, { filter: 'lowpass', from: 1200, to: 250, gain: 0.1 });
    }
  }

  private tone(freq: number, duration: number, options: ToneOptions = {}): void {
    const ctx = this.ctx;
    if (!ctx || !this.sfx) return;
    const t0 = ctx.currentTime + (options.delay ?? 0);
    const osc = ctx.createOscillator();
    osc.type = options.type ?? 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    if (options.to) osc.frequency.exponentialRampToValueAtTime(options.to, t0 + duration);
    const gain = ctx.createGain();
    envelope(gain.gain, t0, duration, options.gain ?? 0.15, options.attack ?? 0.005);
    osc.connect(gain).connect(this.sfx);
    osc.onended = () => gain.disconnect();
    osc.start(t0);
    osc.stop(t0 + duration + 0.03);
  }

  private noiseBurst(duration: number, options: NoiseOptions): void {
    const ctx = this.ctx;
    if (!ctx || !this.sfx || !this.noise) return;
    const t0 = ctx.currentTime + (options.delay ?? 0);
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = options.filter ?? 'bandpass';
    filter.Q.value = options.q ?? 1;
    filter.frequency.setValueAtTime(options.from, t0);
    if (options.to) filter.frequency.exponentialRampToValueAtTime(options.to, t0 + duration);
    const gain = ctx.createGain();
    envelope(gain.gain, t0, duration, options.gain ?? 0.2, 0.01);
    src.connect(filter).connect(gain).connect(this.sfx);
    src.onended = () => gain.disconnect();
    src.start(t0, Math.random() * (NOISE_SECONDS - duration - 0.1));
    src.stop(t0 + duration + 0.05);
  }

  private whoosh(duration: number, from: number, to: number, gain: number): void {
    this.noiseBurst(duration, { filter: 'bandpass', from, to, q: 1.4, gain });
  }

  private createEngine(ctx: AudioContext, out: GainNode, noise: AudioBuffer): EngineVoice {
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(out);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 3;
    filter.connect(gain);
    const osc = (type: OscillatorType, level: number, dest: AudioNode) => {
      const o = ctx.createOscillator();
      o.type = type;
      const g = ctx.createGain();
      g.gain.value = level;
      o.connect(g).connect(dest);
      o.start();
      return o;
    };
    const body = osc('sawtooth', 0.6, filter);
    const sub = osc('square', 0.35, filter);
    const whineGain = ctx.createGain();
    whineGain.gain.value = 0;
    whineGain.connect(out);
    const whine = osc('triangle', 1, whineGain);

    const source = ctx.createBufferSource();
    source.buffer = noise;
    source.loop = true;
    const layer = (type: BiquadFilterType, freq: number, q: number) => {
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = q;
      const g = ctx.createGain();
      g.gain.value = 0;
      source.connect(f).connect(g).connect(out);
      return { f, g };
    };
    const wind = layer('bandpass', 600, 0.7);
    const hiss = layer('highpass', 2200, 0.7);
    const skid = layer('bandpass', 1700, 7);
    source.start();
    return {
      body,
      sub,
      whine,
      filter,
      gain,
      whineGain,
      windFilter: wind.f,
      windGain: wind.g,
      hissGain: hiss.g,
      skidFilter: skid.f,
      skidGain: skid.g,
    };
  }
}

/** A short attack then an exponential fade: the shape of every one-shot. */
function envelope(param: AudioParam, t0: number, duration: number, peak: number, attack: number) {
  param.setValueAtTime(0.0001, t0);
  param.exponentialRampToValueAtTime(peak, t0 + attack);
  param.exponentialRampToValueAtTime(0.0001, t0 + duration);
}

function createNoise(ctx: AudioContext): AudioBuffer {
  const buffer = ctx.createBuffer(1, ctx.sampleRate * NOISE_SECONDS, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

export const audio = new AudioEngine();
