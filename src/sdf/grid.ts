import type { BuildingSpec } from './blueprint'
import { buildingDistance } from './field'
import { clamp } from '../core/util'

/**
 * Rasterised signed distance field for one building.
 *
 * Stored as Int8 fixed point: 0.05 m per unit, clamped to ±6 m (we only care
 * about sign + local values near the surface). A 32 x 96 x 32 m building at
 * 0.75 m voxels costs ~230 KB, which keeps a full city in a few megabytes and
 * makes the whole thing iPhone-friendly.
 *
 * Destruction is applied directly to this field with exact boolean ops:
 *   subtractSphere(A, S) = max(A, -S)
 * and the mesh is regenerated from the changed chunks only.
 */

export const DIST_SCALE = 20 // units per metre
export const DIST_CLAMP = 120 // ±6 m
export const EMPTY = DIST_CLAMP // value used to erase voxels

export const quantise = (d: number): number => clamp(Math.round(d * DIST_SCALE), -DIST_CLAMP, DIST_CLAMP)

export interface CarveResult {
  changed: number
  /** World-space bounds of the voxels that changed. */
  minX: number
  minY: number
  minZ: number
  maxX: number
  maxY: number
  maxZ: number
}

const EMPTY_RESULT: CarveResult = { changed: 0, minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 }

export class BuildingGrid {
  readonly nx: number
  readonly ny: number
  readonly nz: number
  readonly data: Int8Array
  readonly voxel: number
  /** World position of sample (0,0,0). */
  readonly ox: number
  readonly oy: number
  readonly oz: number
  readonly chunkCells: number
  readonly ncx: number
  readonly ncy: number
  readonly ncz: number

  /** Per-roof-level solid sample counts: used for structural collapse checks. */
  readonly levelSolid: Int32Array
  readonly levelSolidInitial: Int32Array

  /** Chunks whose mesh is stale. */
  readonly dirty = new Set<number>()
  /** Chunks that have been structurally removed (collapsed away). */
  readonly removed: Set<number> = new Set()

  solidSamples = 0
  initialSolidSamples = 1
  destroyedSamples = 0

  // Cached bounds for quick culling / broadphase.
  readonly minX: number
  readonly maxX: number
  readonly minZ: number
  readonly maxZ: number
  readonly maxY: number

  constructor(spec: BuildingSpec, marginM = 1.5) {
    const voxel = spec.voxel
    const maxHW = Math.max(...spec.tiers.map((t) => t.hw), spec.hw) + 0.6
    const maxHD = Math.max(...spec.tiers.map((t) => t.hd), spec.hd) + 0.6
    const maxH = spec.h + Math.max(0, ...spec.roofBoxes.map((b) => b.h)) + 1.2

    const halfX = maxHW + marginM
    const halfZ = maxHD + marginM
    this.voxel = voxel
    this.nx = Math.ceil((halfX * 2) / voxel) + 2
    this.ny = Math.ceil((maxH + marginM) / voxel) + 2
    this.nz = Math.ceil((halfZ * 2) / voxel) + 2
    this.ox = spec.x - halfX - voxel
    this.oy = -voxel
    this.oz = spec.z - halfZ - voxel

    this.data = new Int8Array(this.nx * this.ny * this.nz)
    this.chunkCells = 16
    this.ncx = Math.ceil((this.nx - 1) / this.chunkCells)
    this.ncy = Math.ceil((this.ny - 1) / this.chunkCells)
    this.ncz = Math.ceil((this.nz - 1) / this.chunkCells)

    this.minX = spec.x - halfX
    this.maxX = spec.x + halfX
    this.minZ = spec.z - halfZ
    this.maxZ = spec.z + halfZ
    this.maxY = maxH + 1.2

    this.levelSolid = new Int32Array(this.ny)
    this.levelSolidInitial = new Int32Array(this.ny)
  }

  /**
   * Rasterise a slab of the field. Runs incrementally (row budget per call) so
   * city generation never stalls a frame.
   */
  voxelise(spec: BuildingSpec, kFrom: number, kTo: number): void {
    const { nx, ny, voxel, ox, oy, oz } = this
    const data = this.data
    for (let k = kFrom; k < kTo; k++) {
      const wz = oz + k * voxel
      for (let j = 0; j < ny; j++) {
        const wy = oy + j * voxel
        let levelCount = 0
        for (let i = 0; i < nx; i++) {
          const wx = ox + i * voxel
          const d = buildingDistance(spec, wx, wy, wz)
          data[i + nx * (j + ny * k)] = quantise(d)
          if (d < 0) levelCount++
        }
        this.levelSolidInitial[j] += levelCount
        this.levelSolid[j] += levelCount
        if (levelCount > 0) this.solidSamples += levelCount
      }
    }
    this.initialSolidSamples = Math.max(1, this.solidSamples)
    for (let c = 0; c < this.ncx * this.ncy * this.ncz; c++) this.dirty.add(c)
  }

  idx(i: number, j: number, k: number): number {
    return i + this.nx * (j + this.ny * k)
  }

  /** Nearest-neighbour raw value (metres). */
  sampleRaw(i: number, j: number, k: number): number {
    const nx = this.nx
    const ny = this.ny
    const ci = i < 0 ? 0 : i >= nx ? nx - 1 : i
    const cj = j < 0 ? 0 : j >= ny ? ny - 1 : j
    const ck = k < 0 ? 0 : k >= this.nz ? this.nz - 1 : k
    return this.data[ci + nx * (cj + ny * ck)] / DIST_SCALE
  }

  /** Trilinear distance query in world space. Returns a big positive outside. */
  sampleWorld(wx: number, wy: number, wz: number): number {
    const fx = (wx - this.ox) / this.voxel
    const fy = (wy - this.oy) / this.voxel
    const fz = (wz - this.oz) / this.voxel
    if (fx < -1 || fy < -1 || fz < -1 || fx > this.nx || fy > this.ny || fz > this.nz) return 99
    const i = clamp(Math.floor(fx), 0, this.nx - 2)
    const j = clamp(Math.floor(fy), 0, this.ny - 2)
    const k = clamp(Math.floor(fz), 0, this.nz - 2)
    const tx = clamp(fx - i, 0, 1)
    const ty = clamp(fy - j, 0, 1)
    const tz = clamp(fz - k, 0, 1)
    const nx = this.nx
    const ny = this.ny
    const d = this.data
    const base = i + nx * (j + ny * k)
    const c000 = d[base]
    const c100 = d[base + 1]
    const c010 = d[base + nx]
    const c110 = d[base + nx + 1]
    const c001 = d[base + nx * ny]
    const c101 = d[base + nx * ny + 1]
    const c011 = d[base + nx * ny + nx]
    const c111 = d[base + nx * ny + nx + 1]
    const x00 = c000 + (c100 - c000) * tx
    const x10 = c010 + (c110 - c010) * tx
    const x01 = c001 + (c101 - c001) * tx
    const x11 = c011 + (c111 - c011) * tx
    const y0 = x00 + (x10 - x00) * ty
    const y1 = x01 + (x11 - x01) * ty
    return (y0 + (y1 - y0) * tz) / DIST_SCALE
  }

  /** SDF gradient (points away from concrete). Writes into `out[0..2]`. */
  gradientWorld(wx: number, wy: number, wz: number, out: Float32Array): void {
    const h = this.voxel * 0.75
    const gx = this.sampleWorld(wx + h, wy, wz) - this.sampleWorld(wx - h, wy, wz)
    const gy = this.sampleWorld(wx, wy + h, wz) - this.sampleWorld(wx, wy - h, wz)
    const gz = this.sampleWorld(wx, wy, wz + h) - this.sampleWorld(wx, wy, wz - h)
    const len = Math.hypot(gx, gy, gz) || 1
    out[0] = gx / len
    out[1] = gy / len
    out[2] = gz / len
  }

  /**
   * Boolean-subtract a sphere from the field. Returns what changed so the caller
   * can mark chunks dirty and spawn debris/dust.
   */
  carveSphere(cx: number, cy: number, cz: number, r: number): CarveResult {
    if (r <= 0) return EMPTY_RESULT
    const inv = 1 / this.voxel
    const pad = this.voxel * 1.5
    const i0 = Math.max(0, Math.floor((cx - r - pad - this.ox) * inv))
    const i1 = Math.min(this.nx - 1, Math.ceil((cx + r + pad - this.ox) * inv))
    const j0 = Math.max(0, Math.floor((cy - r - pad - this.oy) * inv))
    const j1 = Math.min(this.ny - 1, Math.ceil((cy + r + pad - this.oy) * inv))
    const k0 = Math.max(0, Math.floor((cz - r - pad - this.oz) * inv))
    const k1 = Math.min(this.nz - 1, Math.ceil((cz + r + pad - this.oz) * inv))
    if (i1 < i0 || j1 < j0 || k1 < k0) return EMPTY_RESULT

    let changed = 0
    let solidLost = 0
    const data = this.data
    const nx = this.nx
    const ny = this.ny
    for (let k = k0; k <= k1; k++) {
      const dz = this.oz + k * this.voxel - cz
      for (let j = j0; j <= j1; j++) {
        const dy = this.oy + j * this.voxel - cy
        let rowChanged = 0
        let rowSolidLost = 0
        const rowBase = nx * (j + ny * k)
        for (let i = i0; i <= i1; i++) {
          const dx = this.ox + i * this.voxel - cx
          const sd = Math.sqrt(dx * dx + dy * dy + dz * dz) - r
          // max(A, -S) : exact subtraction while inside the original solid.
          const neg = -sd * DIST_SCALE
          const cur = data[i + rowBase]
          if (neg > cur) {
            data[i + rowBase] = quantise(-sd)
            rowChanged++
            // Only concrete turning into air counts as structural damage.
            if (cur < 0) rowSolidLost++
          }
        }
        if (rowChanged > 0) {
          changed += rowChanged
          if (rowSolidLost > 0) {
            this.levelSolid[j] -= rowSolidLost
            solidLost += rowSolidLost
          }
        }
      }
    }
    this.solidSamples -= solidLost
    this.destroyedSamples += solidLost
    if (changed === 0) return EMPTY_RESULT
    const res = {
      changed,
      minX: this.ox + i0 * this.voxel,
      minY: this.oy + j0 * this.voxel,
      minZ: this.oz + k0 * this.voxel,
      maxX: this.ox + i1 * this.voxel,
      maxY: this.oy + j1 * this.voxel,
      maxZ: this.oz + k1 * this.voxel,
    }
    this.markDirtyRect(i0, j0, k0, i1, j1, k1)
    return res
  }

  /** Carve a swept capsule (beams, drills). */
  carveCapsule(
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    r: number,
  ): CarveResult {
    const dx = bx - ax
    const dy = by - ay
    const dz = bz - az
    const len2 = dx * dx + dy * dy + dz * dz
    const steps = Math.max(1, Math.ceil(Math.sqrt(len2) / (r * 0.5)))
    let total: CarveResult = EMPTY_RESULT
    let any = false
    for (let s = 0; s <= steps; s++) {
      const t = s / steps
      const cx = ax + dx * t
      const cy = ay + dy * t
      const cz = az + dz * t
      const res = this.carveSphere(cx, cy, cz, r)
      if (res.changed > 0) {
        if (!any) {
          total = { ...res }
          any = true
        } else {
          total.changed += res.changed
          total.minX = Math.min(total.minX, res.minX)
          total.minY = Math.min(total.minY, res.minY)
          total.minZ = Math.min(total.minZ, res.minZ)
          total.maxX = Math.max(total.maxX, res.maxX)
          total.maxY = Math.max(total.maxY, res.maxY)
          total.maxZ = Math.max(total.maxZ, res.maxZ)
        }
      }
    }
    return total
  }

  /** Erase a whole chunk (structural collapse removal) without remeshing it. */
  eraseChunk(cx: number, cy: number, cz: number): void {
    const cs = this.chunkCells
    const i0 = cx * cs
    const j0 = cy * cs
    const k0 = cz * cs
    const i1 = Math.min(this.nx - 1, i0 + cs)
    const j1 = Math.min(this.ny - 1, j0 + cs)
    const k1 = Math.min(this.nz - 1, k0 + cs)
    let removed = 0
    for (let k = k0; k <= k1; k++) {
      for (let j = j0; j <= j1; j++) {
        const rowBase = this.nx * (j + this.ny * k)
        for (let i = i0; i <= i1; i++) {
          const p = i + rowBase
          if (this.data[p] < 0) {
            this.data[p] = EMPTY
            removed++
            this.levelSolid[j]--
          }
        }
      }
    }
    this.solidSamples -= removed
    this.destroyedSamples += removed
    this.removed.add(cx + this.ncx * (cy + this.ncy * cz))
    // Neighbouring chunks may share border samples: re-mesh them.
    for (let dz = -1; dz <= 1; dz++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const ncx = cx + dx
          const ncy = cy + dy
          const ncz = cz + dz
          if (ncx < 0 || ncy < 0 || ncz < 0 || ncx >= this.ncx || ncy >= this.ncy || ncz >= this.ncz) continue
          const key = ncx + this.ncx * (ncy + this.ncy * ncz)
          if (!this.removed.has(key)) this.dirty.add(key)
        }
      }
    }
  }

  markDirtyRect(i0: number, j0: number, k0: number, i1: number, j1: number, k1: number): void {
    const cs = this.chunkCells
    // One extra cell of slack on each side: chunk meshes read a 1-cell border.
    const cx0 = Math.max(0, Math.floor(i0 / cs) - 1)
    const cx1 = Math.min(this.ncx - 1, Math.floor(i1 / cs) + 1)
    const cy0 = Math.max(0, Math.floor(j0 / cs) - 1)
    const cy1 = Math.min(this.ncy - 1, Math.floor(j1 / cs) + 1)
    const cz0 = Math.max(0, Math.floor(k0 / cs) - 1)
    const cz1 = Math.min(this.ncz - 1, Math.floor(k1 / cs) + 1)
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const key = cx + this.ncx * (cy + this.ncy * cz)
          if (!this.removed.has(key)) this.dirty.add(key)
        }
      }
    }
  }

  get damageFraction(): number {
    return clamp(this.destroyedSamples / this.initialSolidSamples, 0, 1)
  }

  /**
   * Structural evaluation: walk up the building and find the lowest level whose
   * remaining support is below `cutSupport`. Everything above is unsupported.
   * Also returns the mean remaining support above that plane.
   */
  evaluateStructure(cutSupport = 0.45, baseSupport = 0.72): { cutLevel: number; supportAbove: number } {
    const ny = this.ny
    let cutLevel = -1
    let sumNow = 0
    let sumInit = 0
    for (let j = 0; j < ny; j++) {
      const init = this.levelSolidInitial[j]
      if (init <= 2) continue
      const ratio = this.levelSolid[j] / init
      // Anything above a storey that lost too much of its cross-section comes
      // down; a weakened *base* brings the whole tower down regardless of what
      // the rest of the building looks like.
      const weakBase = j <= this.voxel * 8 / this.voxel && ratio < baseSupport
      if (ratio < cutSupport || weakBase) {
        cutLevel = j
        break
      }
    }
    const from = cutLevel >= 0 ? cutLevel : 0
    for (let j = from; j < ny; j++) {
      sumNow += this.levelSolid[j]
      sumInit += this.levelSolidInitial[j]
    }
    return { cutLevel, supportAbove: sumInit > 0 ? sumNow / sumInit : 1 }
  }
}
