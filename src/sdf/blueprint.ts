import { mulberry32 } from '../core/util'

export interface FacadeStyle {
  name: string
  base: string
  trim: string
  glass: [string, string]
  litChance: number
  bands: boolean
  winW: number
  winH: number
  cols: number
  rows: number
}

export const FACADE_STYLES: FacadeStyle[] = [
  {
    name: 'office-blue',
    base: '#9aa1ab',
    trim: '#6f7681',
    glass: ['#20304a', '#3d5a80'],
    litChance: 0.16,
    bands: false,
    winW: 0.6,
    winH: 0.5,
    cols: 1,
    rows: 1,
  },
  {
    name: 'brick-brown',
    base: '#8a5a44',
    trim: '#5d3b2c',
    glass: ['#171d24', '#2a3a44'],
    litChance: 0.1,
    bands: true,
    winW: 0.46,
    winH: 0.52,
    cols: 2,
    rows: 1,
  },
  {
    name: 'concrete-brutal',
    base: '#a8a49c',
    trim: '#7b776f',
    glass: ['#1b2126', '#334155'],
    litChance: 0.08,
    bands: true,
    winW: 0.74,
    winH: 0.4,
    cols: 1,
    rows: 1,
  },
  {
    name: 'glass-teal',
    base: '#4f6f74',
    trim: '#2f4a50',
    glass: ['#123236', '#2f6f77'],
    litChance: 0.14,
    bands: false,
    winW: 0.84,
    winH: 0.62,
    cols: 1,
    rows: 1,
  },
  {
    name: 'stone-sand',
    base: '#c2b49a',
    trim: '#8f816a',
    glass: ['#2a2620', '#4a4238'],
    litChance: 0.12,
    bands: true,
    winW: 0.5,
    winH: 0.46,
    cols: 2,
    rows: 1,
  },
  {
    name: 'glass-night',
    base: '#6a7686',
    trim: '#45505f',
    glass: ['#16283a', '#33506e'],
    litChance: 0.32,
    bands: false,
    winW: 0.86,
    winH: 0.66,
    cols: 1,
    rows: 1,
  },
]


/**
 * Deterministic city blueprint — pure data, no three.js, safe to run in a worker.
 *
 * The city is authored as signed-distance data: every destructible building is a
 * stack of rounded-box tiers with carved window recesses, ledges, parapets and
 * rooftop clutter. The same spec is used to voxelise the SDF, to carve damage
 * into it, and to drive collapse logic.
 */

export interface Tier {
  /** Tier height in metres. */
  h: number
  /** Half extents of the tier footprint. */
  hw: number
  hd: number
}

export interface BuildingSpec {
  id: number
  /** Centre of the footprint in world XZ. */
  x: number
  z: number
  /** Total height (metres). */
  h: number
  /** Footprint half extents of the ground tier. */
  hw: number
  hd: number
  tiers: Tier[]
  /** Rooftop clutter boxes (local XZ offsets, from the footprint centre). */
  roofBoxes: { x: number; z: number; w: number; d: number; h: number }[]
  /** Window pattern, in metres. recess = 0 disables geometric window carving. */
  windowPitchX: number
  windowPitchY: number
  windowW: number
  windowH: number
  windowBaseY: number
  recess: number
  /** Palette/texture style index (0..3). */
  style: number
  /** 0..1 deterministic colour variation. */
  tint: number
  /** Voxel size used to rasterise + mesh this building (LOD by distance). */
  voxel: number
  /** 0 = hero destructible, 1 = destructible lite, 2 = static impostor. */
  lod: 0 | 1 | 2
}

export interface PropSpec {
  kind: PropKind
  x: number
  z: number
  y: number
  rot: number
  scale: number
}

export type PropKind = 'streetlight' | 'car' | 'hydrant' | 'tree' | 'trafficlight' | 'bench' | 'planter' | 'rubble'

export interface Blueprint {
  seed: number
  /** Half extent of the built-up area (metres). */
  extent: number
  blockPitch: number
  streetWidth: number
  buildings: BuildingSpec[]
  props: PropSpec[]
  /** Plaza/park blocks get no building. */
  plazas: { x: number; z: number; r: number }[]
}

const BLOCK_PITCH = 72
const STREET_WIDTH = 17
const GRID_R = 3 // 7x7 blocks

export function generateBlueprint(seed = 1337): Blueprint {
  const rnd = mulberry32(seed)
  const buildings: BuildingSpec[] = []
  const props: PropSpec[] = []
  const plazas: { x: number; z: number; r: number }[] = []
  let nextId = 0

  const pushBuilding = (spec: BuildingSpec): void => {
    buildings.push(spec)
  }

  for (let bz = -GRID_R; bz <= GRID_R; bz++) {
    for (let bx = -GRID_R; bx <= GRID_R; bx++) {
      const cx = bx * BLOCK_PITCH
      const cz = bz * BLOCK_PITCH
      const distFromCentre = Math.hypot(bx, bz)

      // The two innermost blocks are an open plaza — the natural arena.
      if (distFromCentre === 0 || (Math.abs(bx) === 1 && Math.abs(bz) <= 0 && rnd() < 0.5)) {
        plazas.push({ x: cx, z: cz, r: 26 })
        continue
      }

      // Lots inside the block footprint (block minus streets).
      const inner = (BLOCK_PITCH - STREET_WIDTH) * 0.5 // 27.5
      const pattern = rnd()
      const lots: { x: number; z: number; hw: number; hd: number }[] = []
      if (pattern < 0.3) {
        lots.push({ x: 0, z: 0, hw: inner - 1, hd: inner - 1 })
      } else if (pattern < 0.55) {
        lots.push({ x: 0, z: -inner * 0.5, hw: inner - 1, hd: inner * 0.5 - 1.5 })
        lots.push({ x: 0, z: inner * 0.5, hw: inner - 1, hd: inner * 0.5 - 1.5 })
      } else if (pattern < 0.8) {
        lots.push({ x: -inner * 0.5, z: 0, hw: inner * 0.5 - 1.5, hd: inner - 1 })
        lots.push({ x: inner * 0.5, z: 0, hw: inner * 0.5 - 1.5, hd: inner - 1 })
      } else {
        const h = inner * 0.5 - 1.5
        for (let i = 0; i < 4; i++) {
          lots.push({
            x: (i & 1 ? 1 : -1) * inner * 0.5,
            z: (i & 2 ? 1 : -1) * inner * 0.5,
            hw: h,
            hd: h,
          })
        }
      }

      for (const lot of lots) {
        const lx = cx + lot.x + (rnd() - 0.5) * 2
        const lz = cz + lot.z + (rnd() - 0.5) * 2
        const radius = Math.hypot(lx, lz)

        // Height falls off with distance from the core (downtown silhouette).
        const core = Math.max(0, 1 - radius / (BLOCK_PITCH * (GRID_R + 0.4)))
        const base = 14 + core * core * 96
        const h = Math.max(12, base * (0.55 + rnd() * 0.85))
        const style = (nextId * 7 + Math.floor(rnd() * FACADE_STYLES.length)) % FACADE_STYLES.length

        const lod: 0 | 1 | 2 = radius < 150 ? 0 : radius < 265 ? 1 : 2
        const voxel = lod === 0 ? 1.0 : lod === 1 ? 1.8 : 3.0

        const spec = makeBuilding(nextId++, lx, lz, lot.hw, lot.hd, h, style, rnd(), rnd, lod, voxel)
        pushBuilding(spec)
      }

      // Street furniture along the block edges.
      const half = BLOCK_PITCH * 0.5 - STREET_WIDTH * 0.5 + 3.2
      const perSide = 3
      for (let side = 0; side < 4; side++) {
        for (let i = 0; i < perSide; i++) {
          const t = (i + 0.5) / perSide - 0.5
          const along = t * (BLOCK_PITCH - STREET_WIDTH - 8)
          const k = rnd()
          const kind: PropKind =
            k < 0.22
              ? 'streetlight'
              : k < 0.42
                ? 'car'
                : k < 0.5
                  ? 'hydrant'
                  : k < 0.7
                    ? 'tree'
                    : k < 0.8
                      ? 'trafficlight'
                      : k < 0.9
                        ? 'bench'
                        : 'planter'
          const px = side === 0 ? cx + along : side === 1 ? cx + along : side === 2 ? cx - half : cx + half
          const pz = side === 0 ? cz - half : side === 1 ? cz + half : cz + along
          props.push({
            kind,
            x: px,
            z: pz,
            y: 0,
            rot: side < 2 ? (side === 0 ? 0 : Math.PI) : side === 2 ? Math.PI * 0.5 : -Math.PI * 0.5,
            scale: 0.85 + rnd() * 0.5,
          })
        }
      }
    }
  }

  // Distant skyline impostors (no collision, no destruction — silhouette only).
  const rnd2 = mulberry32(seed ^ 0x9e37)
  for (let i = 0; i < 90; i++) {
    const a = rnd2() * Math.PI * 2
    const r = 330 + rnd2() * 620
    const x = Math.cos(a) * r
    const z = Math.sin(a) * r
    const w = 18 + rnd2() * 34
    const d = 18 + rnd2() * 34
    const h = 40 + rnd2() * 190 * (1 - Math.min(1, r / 900))
    buildings.push({
      id: nextId++,
      x,
      z,
      h,
      hw: w * 0.5,
      hd: d * 0.5,
      tiers: [{ h, hw: w * 0.5, hd: d * 0.5 }],
      roofBoxes: [],
      windowPitchX: 3.4,
      windowPitchY: 3.8,
      windowW: 2.4,
      windowH: 2.1,
      windowBaseY: 1.6,
      recess: 0,
      style: nextId % FACADE_STYLES.length,
      tint: rnd2(),
      voxel: 3,
      lod: 2,
    })
  }

  const extent = BLOCK_PITCH * (GRID_R + 0.5)
  return { seed, extent, blockPitch: BLOCK_PITCH, streetWidth: STREET_WIDTH, buildings, props, plazas }
}

export function makeBuilding(
  id: number,
  x: number,
  z: number,
  hw: number,
  hd: number,
  h: number,
  style: number,
  tint: number,
  rnd: () => number,
  lod: 0 | 1 | 2,
  voxel: number,
): BuildingSpec {
  const tiers: Tier[] = []
  const setbacks = h > 60 ? 3 : h > 34 ? 2 : 1
  let remaining = h
  let chw = hw
  let chd = hd
  for (let i = 0; i < setbacks; i++) {
    const frac = i === setbacks - 1 ? 1 : 0.45 + rnd() * 0.2
    const th = remaining * frac
    tiers.push({ h: th, hw: Math.max(5, chw), hd: Math.max(5, chd) })
    remaining -= th
    chw *= 0.62 + rnd() * 0.16
    chd *= 0.62 + rnd() * 0.16
  }

  const top = tiers[tiers.length - 1]
  const roofBoxes: { x: number; z: number; w: number; d: number; h: number }[] = []
  const roofCount = 1 + Math.floor(rnd() * 3)
  for (let i = 0; i < roofCount; i++) {
    const w = 2 + rnd() * 4
    const d = 2 + rnd() * 4
    roofBoxes.push({
      x: (rnd() - 0.5) * Math.max(0, top.hw - w) * 1.6,
      z: (rnd() - 0.5) * Math.max(0, top.hd - d) * 1.6,
      w,
      d,
      h: 1.6 + rnd() * 3.4,
    })
  }

  // Window pattern is derived from the facade texture so the carved SDF
  // recesses line up exactly with the painted windows (tile = 4 m).
  const fs = FACADE_STYLES[style % FACADE_STYLES.length]
  const pitchX = 4 / fs.cols
  const pitchY = 4
  const windowH = 4 * fs.winH * 0.94

  return {
    id,
    x,
    z,
    h,
    hw: tiers[0].hw,
    hd: tiers[0].hd,
    tiers,
    roofBoxes,
    windowPitchX: pitchX,
    windowPitchY: pitchY,
    windowW: pitchX * fs.winW,
    windowH,
    // Vertical phase: the painted window sits 2.125 m up the 4 m tile.
    windowBaseY: 2.125 - pitchY * 0.5,
    // Real carved recesses for the hero buildings in the play area. At a 1 m
    // voxel this reads as a punched-hole facade — the era look, and it means
    // window openings survive as real geometry once a wall is torn open.
    recess: lod === 0 ? 0.7 + rnd() * 0.2 : 0,
    style,
    tint,
    voxel,
    lod,
  }
}

/**
 * Deterministic per-building facade tint. Lives here (rather than in the render
 * layer) so the meshing worker can bake vertex colours without importing three.
 */
const TINT_BASE: [number, number, number][] = [
  [0.86, 0.88, 0.94],
  [1.0, 0.9, 0.82],
  [0.94, 0.94, 0.9],
  [0.82, 0.95, 0.97],
  [1.0, 0.94, 0.82],
  [0.86, 0.9, 1.0],
]

export function facadeTint(style: number, tint: number): [number, number, number] {
  const b = TINT_BASE[style % TINT_BASE.length]
  const k = 0.84 + tint * 0.16
  return [Math.min(1, b[0] * k), Math.min(1, b[1] * k), Math.min(1, b[2] * k)]
}
