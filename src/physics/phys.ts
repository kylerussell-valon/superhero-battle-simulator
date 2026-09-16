import type { City, BuildingRT } from '../world/city'

/**
 * Physics queries against the destructible city.
 *
 * Everything is driven by the SDF itself: `distance()` gives penetration depth,
 * the field gradient gives the contact normal, and a marched sweep gives impact
 * points. That means collision stays perfectly in sync with destruction — as
 * soon as a wall is carved away you can fly through the hole, with no separate
 * collision mesh to rebuild.
 */

export interface Hit {
  hit: boolean
  x: number
  y: number
  z: number
  nx: number
  ny: number
  nz: number
  building: BuildingRT | null
  /** Total distance travelled before the impact. */
  travelled: number
}

export function makeHit(): Hit {
  return { hit: false, x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0, building: null, travelled: 0 }
}

export interface ResolveResult {
  /** Penetration depth of the deepest contact (0 = free). */
  depth: number
  nx: number
  ny: number
  nz: number
  building: BuildingRT | null
  grounded: boolean
}

const MAX_ITER = 3

export class PhysWorld {
  private readonly grad = new Float32Array(3)
  constructor(readonly city: City) {}

  /** Signed distance to the nearest solid (buildings and the ground plane). */
  distance(x: number, y: number, z: number): number {
    const d = this.city.queryNearest(x, y, z)
    return d < y ? d : y
  }

  /**
   * Signed distance to the nearest *building*, ignoring the ground plane.
   *
   * `distance()` clamps with the ground height, which is right for a character
   * capsule but wrong for loose debris and street props: it makes anything within
   * a metre or two of the street look like it is inside concrete, so rubble and
   * cars end up bouncing off the pavement as though it were a wall and hover
   * there instead of settling.
   */
  concreteDistance(x: number, y: number, z: number): number {
    return this.city.queryNearest(x, y, z)
  }

  /**
   * Outward normal of the nearest building surface (ground ignored). Returns
   * false when no building is near enough to have a gradient.
   */
  concreteNormal(x: number, y: number, z: number, out: Float32Array): boolean {
    const rt = this.city.buildingAt(x, y, z)
    if (!rt || !rt.grid) return false
    rt.grid.gradientWorld(x, y, z, this.grad)
    out[0] = this.grad[0]
    out[1] = this.grad[1]
    out[2] = this.grad[2]
    return true
  }

  buildingAt(x: number, y: number, z: number): BuildingRT | null {
    const d = this.city.queryNearest(x, y, z)
    if (d > y) return null
    return this.city.buildingAt(x, y, z)
  }

  /** Outward normal of the nearest surface. */
  normal(x: number, y: number, z: number, out: Float32Array): void {
    const d = this.city.queryNearest(x, y, z)
    if (d >= y) {
      out[0] = 0
      out[1] = 1
      out[2] = 0
      return
    }
    const rt = this.city.buildingAt(x, y, z)
    if (!rt) {
      out[0] = 0
      out[1] = 1
      out[2] = 0
      return
    }
    rt.grid!.gradientWorld(x, y, z, this.grad)
    out[0] = this.grad[0]
    out[1] = this.grad[1]
    out[2] = this.grad[2]
  }

  /**
   * Push a vertical capsule (radius, halfHeight about the centre) out of solids.
   * Samples three spheres along the axis — plenty for a 0.5 m radius body and
   * far cheaper than a real capsule-vs-SDF iteration.
   */
  resolve(x: number, y: number, z: number, radius: number, halfHeight: number, out: ResolveResult): ResolveResult {
    out.depth = 0
    out.nx = 0
    out.ny = 1
    out.nz = 0
    out.building = null
    out.grounded = false

    const hh = Math.max(0, halfHeight - radius)
    for (let iter = 0; iter < MAX_ITER; iter++) {
      let best = Infinity
      let bi = 0
      let bx = x
      let by = y
      let bz = z
      for (let i = 0; i < 3; i++) {
        const sy = y + (i - 1) * hh
        const d = this.distance(x, sy, z)
        if (d < best) {
          best = d
          bi = i
          bx = x
          by = sy
          bz = z
        }
      }
      if (best >= radius) break
      const pen = radius - best
      this.normal(bx, by, bz, this.grad)
      out.depth += pen
      out.nx = this.grad[0]
      out.ny = this.grad[1]
      out.nz = this.grad[2]
      out.building = this.buildingAt(bx, by, bz)
      if (bi === 0 && out.ny > 0.5) out.grounded = true
      if (iter === MAX_ITER - 1) break
    }
    return out
  }

  grounded(x: number, y: number, z: number, radius: number): boolean {
    return this.distance(x, y - radius, z) < 0.35 || y <= radius + 0.05
  }

  /**
   * March a segment looking for the first solid the sphere would touch. Used for
   * dash impacts, flung bodies and projectiles. Stops at the first contact.
   */
  sweep(
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    radius: number,
    hit: Hit,
  ): boolean {
    const dx = bx - ax
    const dy = by - ay
    const dz = bz - az
    const len = Math.hypot(dx, dy, dz)
    hit.hit = false
    hit.building = null
    hit.travelled = 0
    if (len < 1e-5) return false
    const step = Math.max(0.25, radius * 0.6)
    const steps = Math.max(1, Math.ceil(len / step))
    for (let s = 1; s <= steps; s++) {
      const t = s / steps
      const px = ax + dx * t
      const py = ay + dy * t
      const pz = az + dz * t
      if (this.distance(px, py, pz) < radius) {
        hit.hit = true
        hit.x = px
        hit.y = py
        hit.z = pz
        hit.travelled = len * t
        this.normal(px, py, pz, this.grad)
        hit.nx = this.grad[0]
        hit.ny = this.grad[1]
        hit.nz = this.grad[2]
        hit.building = this.buildingAt(px, py, pz)
        return true
      }
    }
    return false
  }

  /** Distance-only sweep (cheaper: no normal/building lookup until a hit). */
  sweepDistance(
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    radius: number,
  ): number {
    const dx = bx - ax
    const dy = by - ay
    const dz = bz - az
    const len = Math.hypot(dx, dy, dz)
    if (len < 1e-5) return -1
    const step = Math.max(0.3, radius * 0.7)
    const steps = Math.max(1, Math.ceil(len / step))
    for (let s = 1; s <= steps; s++) {
      const t = s / steps
      if (this.distance(ax + dx * t, ay + dy * t, az + dz * t) < radius) return len * t
    }
    return -1
  }
}
