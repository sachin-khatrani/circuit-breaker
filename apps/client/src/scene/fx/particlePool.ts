import { Color } from 'three';

export const PARTICLE_CAPACITY = 512;

/**
 * Fixed-size CPU particle pool rendered as one additive Points draw call. Emitters write into
 * a ring buffer, so a burst never allocates and old sparks are recycled first.
 */
export class ParticlePool {
  readonly positions = new Float32Array(PARTICLE_CAPACITY * 3);
  readonly colors = new Float32Array(PARTICLE_CAPACITY * 3);
  readonly sizes = new Float32Array(PARTICLE_CAPACITY);
  readonly alphas = new Float32Array(PARTICLE_CAPACITY);
  private readonly velocities = new Float32Array(PARTICLE_CAPACITY * 3);
  private readonly life = new Float32Array(PARTICLE_CAPACITY);
  private readonly maxLife = new Float32Array(PARTICLE_CAPACITY);
  private readonly baseSize = new Float32Array(PARTICLE_CAPACITY);
  private readonly drag = new Float32Array(PARTICLE_CAPACITY);
  private readonly gravity = new Float32Array(PARTICLE_CAPACITY);
  private cursor = 0;
  /** Active budget from the quality preset. */
  limit = 384;

  emit(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    life: number,
    color: Color,
    size: number,
    drag = 1.5,
    gravity = -9,
  ): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % Math.max(1, Math.min(this.limit, PARTICLE_CAPACITY));
    this.positions[i * 3] = x;
    this.positions[i * 3 + 1] = y;
    this.positions[i * 3 + 2] = z;
    this.velocities[i * 3] = vx;
    this.velocities[i * 3 + 1] = vy;
    this.velocities[i * 3 + 2] = vz;
    this.colors[i * 3] = color.r;
    this.colors[i * 3 + 1] = color.g;
    this.colors[i * 3 + 2] = color.b;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.baseSize[i] = size;
    this.drag[i] = drag;
    this.gravity[i] = gravity;
  }

  /** Radial burst around a point. */
  burst(
    x: number,
    y: number,
    z: number,
    count: number,
    speed: number,
    color: Color,
    size: number,
    life = 0.6,
  ): void {
    for (let k = 0; k < count; k++) {
      const a = Math.random() * Math.PI * 2;
      const e = (Math.random() - 0.3) * Math.PI * 0.5;
      const v = speed * (0.4 + Math.random() * 0.6);
      this.emit(
        x,
        y,
        z,
        Math.cos(a) * Math.cos(e) * v,
        Math.sin(e) * v + speed * 0.2,
        Math.sin(a) * Math.cos(e) * v,
        life * (0.6 + Math.random() * 0.4),
        color,
        size * (0.7 + Math.random() * 0.6),
      );
    }
  }

  update(dt: number): void {
    for (let i = 0; i < PARTICLE_CAPACITY; i++) {
      if (this.life[i] <= 0) {
        this.alphas[i] = 0;
        this.sizes[i] = 0;
        continue;
      }
      this.life[i] -= dt;
      const k = Math.exp(-this.drag[i] * dt);
      const j = i * 3;
      this.velocities[j] *= k;
      this.velocities[j + 1] = this.velocities[j + 1] * k + this.gravity[i] * dt;
      this.velocities[j + 2] *= k;
      this.positions[j] += this.velocities[j] * dt;
      this.positions[j + 1] += this.velocities[j + 1] * dt;
      this.positions[j + 2] += this.velocities[j + 2] * dt;
      const t = Math.max(0, this.life[i] / this.maxLife[i]);
      this.alphas[i] = t * t;
      this.sizes[i] = this.baseSize[i] * (0.4 + 0.6 * t);
    }
  }

  clear(): void {
    this.life.fill(0);
  }
}

export const particles = new ParticlePool();
