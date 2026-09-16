import type { BuildingSpec, Tier } from './blueprint'
import { bandDistance } from '../core/util'
import { opSubtract, opUnion, sdRoundBox } from './sdf'

/**
 * The authored signed-distance field of a single building.
 *
 * Everything the player can destroy is expressed here: stacked tiers with
 * chamfered corners, a repeating window-recess pattern on all four facades,
 * a parapet ring at roof level and rooftop plant boxes.
 */

/** Distance to the carved window pattern of one facade band (world-aligned). */
function facadeCavity(
  lx: number,
  lz: number,
  wx: number,
  wy: number,
  wz: number,
  t: Tier,
  spec: BuildingSpec,
): number {
  const halfW = spec.windowW * 0.5
  const halfH = spec.windowH * 0.5
  const recess = spec.recess

  // Vertical band: windows live in a repeating horizontal strip aligned to the
  // facade texture tiles (world Y), so painted and carved windows coincide.
  const dy = bandDistance(wy, spec.windowBaseY, spec.windowPitchY, halfH)
  // Horizontal pitch runs in world space along each facade.
  const alongZ = bandDistance(wz, spec.windowPitchX * 0.5, spec.windowPitchX, halfW)
  const alongX = bandDistance(wx, spec.windowPitchX * 0.5, spec.windowPitchX, halfW)

  // Slab terms select only the region just inside each of the four facades.
  const xp = t.hw - recess - lx
  const xn = t.hw - recess + lx
  const zp = t.hd - recess - lz
  const zn = t.hd - recess + lz

  const cx = Math.max(dy, alongZ)
  const cz = Math.max(dy, alongX)
  let d = Math.min(Math.max(cx, xp), Math.max(cx, xn))
  d = Math.min(d, Math.max(cz, zp), Math.max(cz, zn))
  return d
}

/** Union AABB of everything a building is made of (used for cheap distance pruning). */
export interface Bounds {
  x0: number
  x1: number
  y0: number
  y1: number
  z0: number
  z1: number
}

/** Cached per-spec bounds: computing them per sample would dominate voxelisation. */
const boundsCache = new WeakMap<BuildingSpec, Bounds>()

export function buildingBounds(spec: BuildingSpec): Bounds {
  const cached = boundsCache.get(spec)
  if (cached) return cached
  let x0 = Infinity
  let x1 = -Infinity
  let z0 = Infinity
  let z1 = -Infinity
  let y1 = 0
  let y0 = 0
  for (let i = 0; i < spec.tiers.length; i++) {
    const t = spec.tiers[i]
    const ex = t.hw + (i > 0 ? 0.6 : 0)
    const ez = t.hd + (i > 0 ? 0.6 : 0)
    x0 = Math.min(x0, spec.x - ex)
    x1 = Math.max(x1, spec.x + ex)
    z0 = Math.min(z0, spec.z - ez)
    z1 = Math.max(z1, spec.z + ez)
    y1 = Math.max(y1, spec.h + 1.2)
  }
  for (const b of spec.roofBoxes) {
    x0 = Math.min(x0, spec.x + b.x - b.w * 0.5)
    x1 = Math.max(x1, spec.x + b.x + b.w * 0.5)
    z0 = Math.min(z0, spec.z + b.z - b.d * 0.5)
    z1 = Math.max(z1, spec.z + b.z + b.d * 0.5)
    y0 = Math.min(y0, 0)
  }
  const b: Bounds = { x0, x1, y0: y0 - 1, y1, z0, z1 }
  boundsCache.set(spec, b)
  return b
}

const REJECT = 6.5

/** Signed distance to the whole building in world space (negative = concrete). */
export function buildingDistance(spec: BuildingSpec, wx: number, wy: number, wz: number): number {
  // Exact early-out: beyond the ±6 m storage clamp everything is "empty space".
  const b = buildingBounds(spec)
  if (
    wx < b.x0 - REJECT ||
    wx > b.x1 + REJECT ||
    wz < b.z0 - REJECT ||
    wz > b.z1 + REJECT ||
    wy < b.y0 - REJECT ||
    wy > b.y1 + REJECT
  ) {
    return 7
  }

  const lx = wx - spec.x
  const ly = wy
  const lz = wz - spec.z

  let d = 1e9
  let y0 = 0
  for (let i = 0; i < spec.tiers.length; i++) {
    const t = spec.tiers[i]
    const cy = y0 + t.h * 0.5
    // Per-tier prune: skip the expensive evaluation for far samples.
    const inTier =
      Math.abs(lx) < t.hw + REJECT && Math.abs(lz) < t.hd + REJECT && ly > y0 - REJECT && ly < y0 + t.h + REJECT

    if (inTier) {
      const bevel = Math.min(0.45, Math.min(t.hw, t.hd) * 0.3)
      let dt = sdRoundBox(lx, ly - cy, lz, t.hw, t.h * 0.5, t.hd, bevel)

      if (spec.recess > 0 && ly > y0 + 1.2 && ly < y0 + t.h - 0.9) {
        dt = opSubtract(dt, facadeCavity(lx, lz, wx, ly, wz, t, spec))
      }

      // Tier-to-tier cornice makes the setbacks read at a glance.
      if (i > 0) {
        const lipY = ly - y0
        if (lipY > -0.9 && lipY < 1.2) {
          dt = opUnion(dt, sdRoundBox(lx, lipY - 0.3, lz, t.hw + 0.5, 0.55, t.hd + 0.5, 0.15))
        }
      }
      d = opUnion(d, dt)
    }
    y0 += t.h
  }

  // Parapet ring at roof level.
  const top = spec.tiers[spec.tiers.length - 1]
  const roofY = spec.h
  const py = ly - (roofY + 0.5)
  if (
    Math.abs(py) < 2.2 &&
    Math.abs(lx) < top.hw + REJECT &&
    Math.abs(lz) < top.hd + REJECT
  ) {
    const outer = sdRoundBox(lx, py, lz, top.hw + 0.25, 0.6, top.hd + 0.25, 0.1)
    const inner = sdRoundBox(lx, py - 1.2, lz, top.hw - 0.55, 1.2, top.hd - 0.55, 0.05)
    d = opUnion(d, opSubtract(outer, inner))
  }

  // Rooftop clutter (AC units, stair houses).
  for (let i = 0; i < spec.roofBoxes.length; i++) {
    const rb = spec.roofBoxes[i]
    const dx = lx - rb.x
    const dy = ly - (roofY + rb.h * 0.5)
    const dz = lz - rb.z
    if (Math.abs(dx) > rb.w * 0.5 + REJECT || Math.abs(dz) > rb.d * 0.5 + REJECT || Math.abs(dy) > rb.h * 0.5 + REJECT) {
      continue
    }
    d = opUnion(d, sdRoundBox(dx, dy, dz, rb.w * 0.5, rb.h * 0.5, rb.d * 0.5, 0.12))
  }

  return d > 7 ? 7 : d
}
