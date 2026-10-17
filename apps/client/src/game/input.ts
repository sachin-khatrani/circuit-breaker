import {
  ABILITIES,
  clamp,
  createInput,
  moveTowards,
  type AbilityId,
  type PlayerInput,
} from '@circuit-breaker/shared';

const KEYS = {
  throttle: ['KeyW', 'ArrowUp'],
  brake: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  drift: ['Space'],
  boost: ['ShiftLeft', 'ShiftRight'],
  reset: ['KeyR'],
  pause: ['Escape', 'KeyP'],
  mute: ['KeyM'],
  // Abilities. R is taken by Reset, so Overdrive sits on F, next to it.
  shortcut: ['KeyQ'],
  gate: ['KeyE'],
  overdrive: ['KeyF'],
} as const;

/** Keyboard key shown for each ability (HUD and help). */
export const ABILITY_KEYS: Record<AbilityId, string> = { shortcut: 'Q', gate: 'E', overdrive: 'F' };
/**
 * Simulation ticks a quick ability press stays down (100 ms). Online, the server fills a tick
 * whose input arrived late with the previous one, so a one-tick press could be lost; held a
 * little longer it still lands. The press is edge-triggered, so it fires once all the same.
 */
const ABILITY_HOLD_TICKS = 6;

/** Keys whose browser default (scrolling, focus moves) must not fire while playing. */
const CAPTURED = new Set<string>([
  ...KEYS.throttle,
  ...KEYS.brake,
  ...KEYS.left,
  ...KEYS.right,
  ...KEYS.drift,
]);

/** Keys typed into a text field belong to the field: they neither drive nor get swallowed. */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target instanceof HTMLTextAreaElement) return true;
  return (
    target instanceof HTMLInputElement &&
    !['range', 'checkbox', 'radio', 'button', 'submit'].includes(target.type)
  );
}

// Standard Gamepad API mapping. The d-pad fires abilities: left Shortcut, up Gate, right Overdrive.
const PAD = {
  a: 0,
  x: 2,
  y: 3,
  lb: 4,
  rb: 5,
  lt: 6,
  rt: 7,
  start: 9,
  up: 12,
  left: 14,
  right: 15,
} as const;
const STICK_DEADZONE = 0.12;
/** Keyboard steering ramps instead of snapping, which keeps digital input controllable. */
const STEER_RAMP_IN = 5.5;
const STEER_RAMP_OUT = 9;

/** Edge-triggered UI actions. `start` is a throttle press, used to start from the menu. */
export type InputAction = 'pause' | 'confirm' | 'start' | 'mute';
/** `target` is the element that had focus when the key went down (null for gamepads). */
export type ActionListener = (action: InputAction, target: EventTarget | null) => void;

/**
 * Merges keyboard and gamepad into one PlayerInput. `update` runs every rendered frame
 * (gamepad polling, steering smoothing, edge actions); the simulation reads `current` once
 * per fixed tick.
 */
export class InputManager {
  private readonly held = new Set<string>();
  /**
   * Keys pressed since the simulation last read the input. A tap shorter than a frame (or
   * landing on a frame with no simulation tick) still reaches the simulation exactly once.
   */
  private readonly tapped = new Set<string>();
  /** Ticks each ability press has left to stay down (keys and HUD taps alike). */
  private readonly abilityHold: Record<AbilityId, number> = { shortcut: 0, gate: 0, overdrive: 0 };
  private readonly state = createInput();
  private keyboardSteer = 0;
  private padButtonsPrev: boolean[] = [];
  private actionListener: ActionListener | null = null;
  private lastDevice: 'keyboard' | 'gamepad' = 'keyboard';

  attach(target: Window = window): () => void {
    const down = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      if (CAPTURED.has(e.code)) e.preventDefault();
      if (e.repeat) return;
      this.held.add(e.code);
      this.tapped.add(e.code);
      for (const id of ABILITIES) {
        if ((KEYS[id] as readonly string[]).includes(e.code))
          this.abilityHold[id] = ABILITY_HOLD_TICKS;
      }
      this.lastDevice = 'keyboard';
      if ((KEYS.pause as readonly string[]).includes(e.code)) this.emit('pause', e.target);
      // A focused button already handles Enter itself; do not fire the action twice.
      if (e.code === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
        this.emit('confirm', e.target);
      }
      if ((KEYS.throttle as readonly string[]).includes(e.code)) this.emit('start', e.target);
      if ((KEYS.mute as readonly string[]).includes(e.code)) this.emit('mute', e.target);
    };
    const up = (e: KeyboardEvent) => {
      this.held.delete(e.code);
    };
    // Releasing keys while the window is unfocused never fires keyup; forget everything.
    const blur = () => {
      this.held.clear();
      this.tapped.clear();
      this.dropAbilityPresses();
    };
    target.addEventListener('keydown', down);
    target.addEventListener('keyup', up);
    target.addEventListener('blur', blur);
    return () => {
      target.removeEventListener('keydown', down);
      target.removeEventListener('keyup', up);
      target.removeEventListener('blur', blur);
    };
  }

  onAction(listener: ActionListener | null): void {
    this.actionListener = listener;
  }

  get device(): 'keyboard' | 'gamepad' {
    return this.lastDevice;
  }

  /** A press of an ability from the HUD (mouse or touch). */
  tapAbility(ability: AbilityId): void {
    this.abilityHold[ability] = ABILITY_HOLD_TICKS;
  }

  /** The merged input as of the last `update`. */
  get current(): Readonly<PlayerInput> {
    return this.state;
  }

  update(dt: number): void {
    const any = (codes: readonly string[]) =>
      codes.some((c) => this.held.has(c) || this.tapped.has(c));
    const left = any(KEYS.left);
    const right = any(KEYS.right);
    const target = (right ? 1 : 0) - (left ? 1 : 0);
    const reversing = target !== 0 && Math.sign(target) !== Math.sign(this.keyboardSteer);
    const rate = target === 0 || reversing ? STEER_RAMP_OUT : STEER_RAMP_IN;
    this.keyboardSteer = moveTowards(this.keyboardSteer, target, rate * dt);

    let throttle = any(KEYS.throttle) ? 1 : 0;
    let brake = any(KEYS.brake) ? 1 : 0;
    let steer = this.keyboardSteer;
    let boost = any(KEYS.boost);
    let drift = any(KEYS.drift);
    let reset = any(KEYS.reset);
    let shortcut = any(KEYS.shortcut) || this.abilityHold.shortcut > 0;
    let gate = any(KEYS.gate) || this.abilityHold.gate > 0;
    let overdrive = any(KEYS.overdrive) || this.abilityHold.overdrive > 0;

    const pad = this.readGamepad();
    if (pad) {
      const pressed = (i: number) => pad.buttons[i]?.pressed ?? false;
      const value = (i: number) => pad.buttons[i]?.value ?? 0;
      const raw = pad.axes[0] ?? 0;
      const magnitude = Math.max(0, (Math.abs(raw) - STICK_DEADZONE) / (1 - STICK_DEADZONE));
      const stick = Math.sign(raw) * Math.pow(magnitude, 1.5);
      const padUsed =
        magnitude > 0 ||
        value(PAD.rt) > 0.05 ||
        value(PAD.lt) > 0.05 ||
        pad.buttons.some((b) => b.pressed);
      if (padUsed) this.lastDevice = 'gamepad';
      if (Math.abs(stick) > 0.02) steer = stick;
      throttle = Math.max(throttle, value(PAD.rt));
      brake = Math.max(brake, value(PAD.lt));
      boost ||= pressed(PAD.x) || pressed(PAD.lb);
      drift ||= pressed(PAD.a) || pressed(PAD.rb);
      reset ||= pressed(PAD.y);
      shortcut ||= pressed(PAD.left);
      gate ||= pressed(PAD.up);
      overdrive ||= pressed(PAD.right);

      const now = pad.buttons.map((b) => b.pressed);
      if (now[PAD.start] && !this.padButtonsPrev[PAD.start]) this.emit('pause', null);
      if (now[PAD.a] && !this.padButtonsPrev[PAD.a]) this.emit('confirm', null);
      this.padButtonsPrev = now;
    }

    this.state.throttle = clamp(throttle, 0, 1);
    this.state.brake = clamp(brake, 0, 1);
    this.state.steer = clamp(steer, -1, 1);
    this.state.boost = boost;
    this.state.drift = drift;
    this.state.reset = reset;
    this.state.shortcut = shortcut;
    this.state.gate = gate;
    this.state.overdrive = overdrive;
  }

  /** Called after a simulation tick has read `current`: taps it has seen are spent. */
  consumeTaps(): void {
    this.tapped.clear();
    for (const id of ABILITIES) this.abilityHold[id] = Math.max(0, this.abilityHold[id] - 1);
  }

  /** Ability presses the race could not take (made while a menu was open) are dropped. */
  dropAbilityPresses(): void {
    for (const id of ABILITIES) this.abilityHold[id] = 0;
  }

  private readGamepad(): Gamepad | null {
    if (typeof navigator === 'undefined' || !('getGamepads' in navigator)) return null;
    for (const pad of navigator.getGamepads()) if (pad?.connected) return pad;
    return null;
  }

  private emit(action: InputAction, target: EventTarget | null): void {
    this.actionListener?.(action, target);
  }
}

export const inputManager = new InputManager();
