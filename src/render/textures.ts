import * as THREE from 'three'
import { mulberry32 } from '../core/util'
import type { Blueprint } from '../sdf/blueprint'

/**
 * All textures are generated procedurally on a canvas — no downloads, tiny
 * memory footprint, and a deliberately low-resolution chunky look that matches
 * the PS2/GameCube target. 256² facade tiles at 4 m per tile = 64 px/m.
 */

export const WALL_TILE_M = 4
export const ROOF_TILE_M = 8

function makeCanvas(size: number): { c: HTMLCanvasElement; g: CanvasRenderingContext2D } {
  const c = document.createElement('canvas')
  c.width = size
  c.height = size
  const g = c.getContext('2d')!
  return { c, g }
}

function finishTex(c: HTMLCanvasElement, repeat = false): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.wrapS = t.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping
  t.magFilter = THREE.LinearFilter
  t.minFilter = THREE.LinearMipmapLinearFilter
  t.generateMipmaps = true
  t.anisotropy = 4
  return t
}

function noise(g: CanvasRenderingContext2D, size: number, amount: number, seed: number): void {
  const rnd = mulberry32(seed)
  const img = g.getImageData(0, 0, size, size)
  const d = img.data
  for (let i = 0; i < d.length; i += 4) {
    const n = (rnd() - 0.5) * amount
    d[i] = Math.max(0, Math.min(255, d[i] + n))
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n))
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n))
  }
  g.putImageData(img, 0, 0)
}

import { FACADE_STYLES, type FacadeStyle } from '../sdf/blueprint'
export { FACADE_STYLES }

/**
 * One 4 m x 4 m facade tile: a single storey with a window band. The UV tiling
 * baked into the mesh (see surfaceNets) lines this up with floor heights.
 */
function paintFacade(style: FacadeStyle, size = 256, seed = 7): HTMLCanvasElement {
  const { c, g } = makeCanvas(size)
  const rnd = mulberry32(seed)

  g.fillStyle = style.base
  g.fillRect(0, 0, size, size)

  // Subtle vertical streaks (weathering).
  for (let i = 0; i < 60; i++) {
    g.fillStyle = `rgba(0,0,0,${0.02 + rnd() * 0.05})`
    g.fillRect(rnd() * size, 0, 1 + rnd() * 3, size)
  }

  // Floor line at the bottom of the tile.
  g.fillStyle = style.trim
  g.fillRect(0, size - Math.round(size * 0.06), size, Math.round(size * 0.06))
  g.fillStyle = 'rgba(0,0,0,0.16)'
  g.fillRect(0, size - Math.round(size * 0.075), size, 2)

  const cols = style.cols
  const rows = style.rows
  const cellW = size / cols
  const cellH = (size * 0.94) / rows
  for (let ry = 0; ry < rows; ry++) {
    for (let cx = 0; cx < cols; cx++) {
      const w = cellW * style.winW
      const h = cellH * style.winH
      const x = cx * cellW + (cellW - w) * 0.5
      const y = ry * cellH + (cellH - h) * 0.5
      // Window frame
      g.fillStyle = style.trim
      g.fillRect(x - 3, y - 3, w + 6, h + 6)
      // Glass with a vertical gradient
      const grad = g.createLinearGradient(x, y, x, y + h)
      const lit = rnd() < style.litChance
      if (lit) {
        grad.addColorStop(0, '#ffe6ad')
        grad.addColorStop(1, '#f6c069')
      } else {
        grad.addColorStop(0, style.glass[1])
        grad.addColorStop(1, style.glass[0])
      }
      g.fillStyle = grad
      g.fillRect(x, y, w, h)
      // Reflection slash + mullion
      g.fillStyle = 'rgba(255,255,255,0.10)'
      g.beginPath()
      g.moveTo(x, y + h)
      g.lineTo(x + w * 0.45, y)
      g.lineTo(x + w * 0.7, y)
      g.lineTo(x + w * 0.25, y + h)
      g.closePath()
      g.fill()
      if (cols === 1) {
        g.fillStyle = style.trim
        g.fillRect(x + w * 0.5 - 1, y, 2, h)
      }
      // Sill: a lit edge over a cast shadow, so windows sit in the wall.
      g.fillStyle = 'rgba(255,255,255,0.14)'
      g.fillRect(x - 4, y + h + 3, w + 8, 3)
      g.fillStyle = 'rgba(0,0,0,0.20)'
      g.fillRect(x - 4, y + h + 6, w + 8, 2)
    }
  }

  // Air-conditioning units with drip stains and their cast shadow.
  for (let i = 0; i < 4; i++) {
    const ax = 8 + rnd() * (size - 40)
    const ay = 10 + rnd() * (size - 50)
    const aw = 9 + rnd() * 8
    const ah = 6 + rnd() * 5
    g.fillStyle = 'rgba(0,0,0,0.22)'
    g.fillRect(ax + 2, ay + ah, aw, 3)
    g.fillStyle = '#6b6f75'
    g.fillRect(ax, ay, aw, ah)
    g.fillStyle = 'rgba(255,255,255,0.16)'
    g.fillRect(ax, ay, aw, 2)
    g.fillStyle = 'rgba(0,0,0,0.12)'
    g.fillRect(ax + aw * 0.3, ay + ah, 2, 22 + rnd() * 20)
  }

  if (style.bands) {
    g.fillStyle = 'rgba(255,255,255,0.07)'
    g.fillRect(0, 0, size, 3)
  }
  noise(g, size, 26, seed + 1)
  return c
}

function paintRoof(size = 256, seed = 21): HTMLCanvasElement {
  const { c, g } = makeCanvas(size)
  const rnd = mulberry32(seed)
  g.fillStyle = '#9c978e'
  g.fillRect(0, 0, size, size)
  // Tar seams every 8 m (tile = 8 m)
  g.strokeStyle = 'rgba(0,0,0,0.35)'
  g.lineWidth = 3
  for (let i = 0; i <= 4; i++) {
    const p = (i / 4) * size
    g.beginPath()
    g.moveTo(p, 0)
    g.lineTo(p, size)
    g.moveTo(0, p)
    g.lineTo(size, p)
    g.stroke()
  }
  // Gravel speckle
  for (let i = 0; i < 2600; i++) {
    const s = 1 + rnd() * 2.2
    g.fillStyle = rnd() < 0.5 ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.16)'
    g.fillRect(rnd() * size, rnd() * size, s, s)
  }
  noise(g, size, 20, seed + 3)
  return c
}

function paintConcrete(size = 256, seed = 55): HTMLCanvasElement {
  const { c, g } = makeCanvas(size)
  const rnd = mulberry32(seed)
  g.fillStyle = '#d3cec2'
  g.fillRect(0, 0, size, size)
  for (let i = 0; i < 400; i++) {
    g.fillStyle = `rgba(0,0,0,${rnd() * 0.12})`
    g.beginPath()
    g.arc(rnd() * size, rnd() * size, rnd() * 9, 0, Math.PI * 2)
    g.fill()
  }
  // Cracks
  g.strokeStyle = 'rgba(0,0,0,0.3)'
  for (let i = 0; i < 14; i++) {
    g.lineWidth = 1 + rnd() * 2
    g.beginPath()
    let x = rnd() * size
    let y = rnd() * size
    g.moveTo(x, y)
    for (let s = 0; s < 6; s++) {
      x += (rnd() - 0.5) * 44
      y += (rnd() - 0.5) * 44
      g.lineTo(x, y)
    }
    g.stroke()
  }
  // Rebar hints
  g.strokeStyle = 'rgba(120,80,45,0.55)'
  g.lineWidth = 3
  for (let i = 0; i < 6; i++) {
    const y = rnd() * size
    g.beginPath()
    g.moveTo(0, y)
    g.lineTo(size, y + (rnd() - 0.5) * 20)
    g.stroke()
  }
  noise(g, size, 30, seed + 5)
  return c
}

function paintDust(size = 64): HTMLCanvasElement {
  const { c, g } = makeCanvas(size)
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  grad.addColorStop(0, 'rgba(255,255,255,0.95)')
  grad.addColorStop(0.4, 'rgba(230,230,230,0.45)')
  grad.addColorStop(1, 'rgba(200,200,200,0)')
  g.fillStyle = grad
  g.fillRect(0, 0, size, size)
  return c
}

/**
 * Ground texture painted from the blueprint: asphalt streets, sidewalks with
 * curbs, lot aprons, park blocks, road markings and crosswalks.
 */
function paintGround(bp: Blueprint, size = 4096): HTMLCanvasElement {
  const { c, g } = makeCanvas(size)
  const rnd = mulberry32(bp.seed ^ 0x51ed)
  const span = bp.extent * 2
  const px = size / span
  const toPx = (w: number): number => (w + bp.extent) * px

  g.fillStyle = '#5b5b66'
  g.fillRect(0, 0, size, size)

  // Asphalt variation + cracks
  for (let i = 0; i < 900; i++) {
    g.fillStyle = `rgba(${rnd() < 0.5 ? '255,255,255' : '0,0,0'},${rnd() * 0.05})`
    const w = 30 + rnd() * 200
    g.fillRect(rnd() * size, rnd() * size, w, w * 0.6)
  }

  // Lane markings along every street centre.
  g.strokeStyle = 'rgba(226,214,150,0.75)'
  g.lineWidth = Math.max(1, 0.28 * px)
  g.setLineDash([2.2 * px * 1.4, 2.2 * px * 1.4])
  for (let b = -4; b <= 4; b++) {
    const p = toPx(b * bp.blockPitch)
    g.beginPath()
    g.moveTo(p, 0)
    g.lineTo(p, size)
    g.moveTo(0, p)
    g.lineTo(size, p)
    g.stroke()
  }
  g.setLineDash([])

  // Blocks: sidewalk slab, curb, apron, park.
  const r = 3
  for (let bz = -r; bz <= r; bz++) {
    for (let bx = -r; bx <= r; bx++) {
      const cx = bx * bp.blockPitch
      const cz = bz * bp.blockPitch
      const inner = (bp.blockPitch - bp.streetWidth) * 0.5
      const x0 = toPx(cx - inner)
      const z0 = toPx(cz - inner)
      const w = inner * 2 * px

      // Curb shadow then sidewalk
      g.fillStyle = '#82806f'
      g.fillRect(x0 - 0.4 * px, z0 - 0.4 * px, w + 0.8 * px, w + 0.8 * px)
      g.fillStyle = '#b3b1a4'
      g.fillRect(x0, z0, w, w)

      // Sidewalk slab joints
      g.strokeStyle = 'rgba(0,0,0,0.16)'
      g.lineWidth = 1
      for (let s = 0; s <= 8; s++) {
        const p = (s / 8) * w
        g.beginPath()
        g.moveTo(x0 + p, z0)
        g.lineTo(x0 + p, z0 + w)
        g.moveTo(x0, z0 + p)
        g.lineTo(x0 + w, z0 + p)
        g.stroke()
      }

      const isPlaza = bp.plazas.some((p) => Math.abs(p.x - cx) < 1 && Math.abs(p.z - cz) < 1)
      const inset = 6.5 * px
      if (isPlaza) {
        // Park block: mottled grass, crossing paths, planting beds.
        g.fillStyle = '#5e7b45'
        g.fillRect(x0 + inset, z0 + inset, w - inset * 2, w - inset * 2)
        // Broad light/dark patches so the lawn is not a flat field of green.
        for (let i = 0; i < 70; i++) {
          const v = rnd()
          g.fillStyle = v < 0.5 ? `rgba(30,52,22,${0.05 + rnd() * 0.12})` : `rgba(150,178,96,${0.04 + rnd() * 0.1})`
          const rw = (2 + rnd() * 9) * px
          g.beginPath()
          g.ellipse(
            x0 + inset + rnd() * (w - inset * 2),
            z0 + inset + rnd() * (w - inset * 2),
            rw,
            rw * (0.5 + rnd() * 0.5),
            rnd() * Math.PI,
            0,
            Math.PI * 2,
          )
          g.fill()
        }
        // Worn dirt paths.
        g.fillStyle = '#6b6152'
        g.fillRect(x0 + w * 0.5 - 2 * px, z0 + inset, 4 * px, w - inset * 2)
        g.fillRect(x0 + inset, z0 + w * 0.5 - 2 * px, w - inset * 2, 4 * px)
        // Planting beds with shrub clumps.
        for (let i = 0; i < 26; i++) {
          g.fillStyle = `rgba(${50 + rnd() * 40},${80 + rnd() * 50},${34 + rnd() * 40},0.85)`
          g.beginPath()
          g.arc(x0 + inset + rnd() * (w - inset * 2), z0 + inset + rnd() * (w - inset * 2), (1.2 + rnd() * 2.4) * px, 0, Math.PI * 2)
          g.fill()
        }
      } else {
        // Lot apron (concrete) where buildings sit
        g.fillStyle = '#918e83'
        g.fillRect(x0 + inset, z0 + inset, w - inset * 2, w - inset * 2)
        for (let i = 0; i < 90; i++) {
          g.fillStyle = `rgba(0,0,0,${rnd() * 0.09})`
          g.fillRect(x0 + inset + rnd() * (w - inset * 2), z0 + inset + rnd() * (w - inset * 2), rnd() * 26, rnd() * 26)
        }
      }

      // Crosswalks on each intersection side
      g.fillStyle = 'rgba(235,235,235,0.72)'
      for (let side = 0; side < 4; side++) {
        for (let s = 0; s < 6; s++) {
          const t = (s + 0.5) / 6
          const bw = 0.9 * px
          const bl = (bp.streetWidth * 0.7) * px
          const ox = side < 2 ? x0 + t * w : side === 2 ? x0 - (0.6 * px + 1.2 * px) : x0 + w + 0.6 * px
          const oz = side < 2 ? (side === 0 ? z0 - (0.6 * px + 1.2 * px) : z0 + w + 0.6 * px) : z0 + t * w
          if (side < 2) g.fillRect(ox - bw * 0.5, oz, bw, bl * 0.5)
          else g.fillRect(ox, oz - bw * 0.5, bl * 0.5, bw)
        }
      }
    }
  }

  // Grime, stains and manholes for texture interest.
  for (let i = 0; i < 220; i++) {
    g.fillStyle = `rgba(0,0,0,${0.03 + rnd() * 0.09})`
    g.beginPath()
    g.arc(rnd() * size, rnd() * size, (0.6 + rnd() * 3) * px, 0, Math.PI * 2)
    g.fill()
  }
  for (let i = 0; i < 60; i++) {
    const x = rnd() * size
    const y = rnd() * size
    g.fillStyle = '#2f2f34'
    g.beginPath()
    g.arc(x, y, 0.45 * px, 0, Math.PI * 2)
    g.fill()
    g.strokeStyle = 'rgba(255,255,255,0.09)'
    g.beginPath()
    g.arc(x, y, 0.45 * px, 0, Math.PI * 2)
    g.stroke()
  }
  noise(g, size, 14, bp.seed + 99)
  return c
}

function paintScorch(size = 128, seed = 31): HTMLCanvasElement {
  const { c, g } = makeCanvas(size)
  const rnd = mulberry32(seed)
  g.clearRect(0, 0, size, size)
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  grad.addColorStop(0, 'rgba(0,0,0,0.85)')
  grad.addColorStop(0.45, 'rgba(20,16,14,0.55)')
  grad.addColorStop(0.8, 'rgba(60,52,44,0.22)')
  grad.addColorStop(1, 'rgba(90,80,70,0)')
  g.fillStyle = grad
  g.beginPath()
  g.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2)
  g.fill()
  // Radial cracks and a few debris speckles
  g.strokeStyle = 'rgba(0,0,0,0.5)'
  for (let i = 0; i < 10; i++) {
    g.lineWidth = 1 + rnd() * 2.4
    const a = (i / 10) * Math.PI * 2 + rnd() * 0.4
    g.beginPath()
    g.moveTo(size / 2, size / 2)
    let r = size * 0.16
    let x = size / 2 + Math.cos(a) * r
    let y = size / 2 + Math.sin(a) * r
    g.lineTo(x, y)
    for (let s = 0; s < 3; s++) {
      r += size * (0.06 + rnd() * 0.07)
      x = size / 2 + Math.cos(a + (rnd() - 0.5) * 0.7) * r
      y = size / 2 + Math.sin(a + (rnd() - 0.5) * 0.7) * r
      g.lineTo(x, y)
    }
    g.stroke()
  }
  for (let i = 0; i < 90; i++) {
    const a = rnd() * Math.PI * 2
    const r = rnd() * size * 0.45
    g.fillStyle = `rgba(190,180,165,${0.05 + rnd() * 0.18})`
    g.fillRect(size / 2 + Math.cos(a) * r, size / 2 + Math.sin(a) * r, 1 + rnd() * 3, 1 + rnd() * 3)
  }
  return c
}

export interface TextureLibrary {
  walls: THREE.CanvasTexture[]
  roof: THREE.CanvasTexture
  concrete: THREE.CanvasTexture
  ground: THREE.CanvasTexture
  dust: THREE.CanvasTexture
  scorch: THREE.CanvasTexture
  groundSpan: number
}

export function buildTextures(bp: Blueprint): TextureLibrary {
  return {
    walls: FACADE_STYLES.map((s, i) => finishTex(paintFacade(s, 512, 7 + i * 13), true)),
    roof: finishTex(paintRoof(), true),
    concrete: finishTex(paintConcrete(), true),
    ground: finishTex(paintGround(bp), false),
    dust: finishTex(paintDust(), false),
    scorch: finishTex(paintScorch(), false),
    groundSpan: bp.extent * 2,
  }
}

export { facadeTint as tintFor } from '../sdf/blueprint'
