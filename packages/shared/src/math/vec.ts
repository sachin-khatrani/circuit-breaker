/** Plain data vectors. Hot loops in the sim use scalars; these are for setup and results. */
export interface Vec2 {
  x: number;
  z: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export function vec3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}

export function distanceSq2(ax: number, az: number, bx: number, bz: number): number {
  const dx = ax - bx;
  const dz = az - bz;
  return dx * dx + dz * dz;
}

/** Heading angle of a direction in the XZ plane, matching three.js `rotation.y`. */
export function headingOf(dx: number, dz: number): number {
  return Math.atan2(dx, dz);
}
