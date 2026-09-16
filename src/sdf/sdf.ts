/**
 * Signed distance primitives & operators, all in metres, y-up, right-handed.
 *
 * Convention: **negative = inside solid**, positive = empty space, magnitude =
 * approximate distance to the surface. Buildings are ray-marched/voxelised from
 * these fields, and the *same* fields drive destruction (carving = subtracting a
 * sphere/cylinder from the field) and character collision (gradient = normal).
 */

/** Box centred on the origin. */
export function sdBox(px: number, py: number, pz: number, hx: number, hy: number, hz: number): number {
  const qx = Math.abs(px) - hx
  const qy = Math.abs(py) - hy
  const qz = Math.abs(pz) - hz
  const mx = Math.max(qx, 0)
  const my = Math.max(qy, 0)
  const mz = Math.max(qz, 0)
  const outside = Math.sqrt(mx * mx + my * my + mz * mz)
  const inside = Math.min(Math.max(qx, Math.max(qy, qz)), 0)
  return outside + inside
}

/** Rounded box (cheap "bevelled concrete" look, keeps surface nets tidy). */
export function sdRoundBox(
  px: number,
  py: number,
  pz: number,
  hx: number,
  hy: number,
  hz: number,
  r: number,
): number {
  const qx = Math.abs(px) - (hx - r)
  const qy = Math.abs(py) - (hy - r)
  const qz = Math.abs(pz) - (hz - r)
  const mx = Math.max(qx, 0)
  const my = Math.max(qy, 0)
  const mz = Math.max(qz, 0)
  return Math.sqrt(mx * mx + my * my + mz * mz) + Math.min(Math.max(qx, Math.max(qy, qz)), 0) - r
}

export function sdSphere(px: number, py: number, pz: number, r: number): number {
  return Math.sqrt(px * px + py * py + pz * pz) - r
}

export function sdPlane(px: number, py: number, pz: number, nx: number, ny: number, nz: number, h: number): number {
  return px * nx + py * ny + pz * nz + h
}

/** Vertical capsule, used for "drill" carves and character collision volumes. */
export function sdCapsuleY(px: number, py: number, pz: number, h: number, r: number): number {
  const dy = Math.abs(py) - h
  const cy = Math.max(dy, 0)
  const rr = Math.sqrt(px * px + pz * pz + cy * cy)
  return rr + Math.min(Math.max(dy, 0), 0) - r
}

/** Unlimited-length cylinder along an arbitrary axis, useful for beam weapons. */
export function sdCylinderAxis(
  px: number,
  py: number,
  pz: number,
  ax: number,
  ay: number,
  az: number,
  r: number,
): number {
  const d = px * ax + py * ay + pz * az
  const ox = px - ax * d
  const oy = py - ay * d
  const oz = pz - az * d
  return Math.sqrt(ox * ox + oy * oy + oz * oz) - r
}

export const opUnion = (a: number, b: number): number => (a < b ? a : b)
export const opIntersect = (a: number, b: number): number => (a > b ? a : b)
/** Subtract b from a (b becomes a hole). */
export const opSubtract = (a: number, b: number): number => (a > -b ? a : -b)

/** Polynomial smooth min (iq). k = blend radius in metres. */
export function smin(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k
  return Math.min(a, b) - h * h * k * 0.25
}

/** Smooth subtraction — molten, heat-vision style damage edges. */
export function ssubtract(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(-b - a), 0) / k
  return Math.max(a, -b) + h * h * k * 0.25
}
