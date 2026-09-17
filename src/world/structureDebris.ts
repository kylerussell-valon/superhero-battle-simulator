import * as THREE from 'three'
import type { BuildingRT } from './city'
import { roofTintFor } from './city'
import type { ChunkMesh } from '../sdf/surfaceNets'
import type { DustSystem } from './fx'
import type { MaterialLibrary } from '../render/materials'
import { WALL_TILE_M, ROOF_TILE_M } from '../render/textures'
import type { PhysWorld } from '../physics/phys'

/**
 * Falling pieces of buildings.
 *
 * A collapse does not invent grey cubes. It detaches the chunk mesh the city
 * was already drawing — facade, storefront or roof, UVs and all — and lets that
 * piece tumble. A punch that only opens a hole clips the triangles that sat
 * inside the carve, so the shard matches the hole it left.
 */

const CAP = 64

interface Piece {
  mesh: THREE.Mesh
  alive: boolean
  sleep: boolean
  px: number
  py: number
  pz: number
  vx: number
  vy: number
  vz: number
  rx: number
  ry: number
  rz: number
  sx: number
  sy: number
  sz: number
  rest: number
  /** Local-space AABB corners, 8 × xyz, relative to the piece centroid. */
  corners: Float32Array
  geo: THREE.BufferGeometry | null
}

const _corner = new THREE.Vector3()
const _normal = new THREE.Vector3()
const _base = new THREE.Quaternion()
const _Y = new THREE.Vector3(0, 1, 0)
const _Z = new THREE.Vector3(0, 0, 1)

export function clipChunk(src: ChunkMesh, x: number, y: number, z: number, radius: number): ChunkMesh | null {
  const r2 = radius * radius
  const pos = src.positions
  const groups = [src.wall, src.ground, src.roof]
  const kept: number[][] = [[], [], []]
  let tris = 0
  for (let g = 0; g < 3; g++) {
    const idx = groups[g]
    for (let i = 0; i + 2 < idx.length; i += 3) {
      const i0 = idx[i]
      const i1 = idx[i + 1]
      const i2 = idx[i + 2]
      const cx = (pos[i0 * 3] + pos[i1 * 3] + pos[i2 * 3]) / 3
      const cy = (pos[i0 * 3 + 1] + pos[i1 * 3 + 1] + pos[i2 * 3 + 1]) / 3
      const cz = (pos[i0 * 3 + 2] + pos[i1 * 3 + 2] + pos[i2 * 3 + 2]) / 3
      const dx = cx - x
      const dy = cy - y
      const dz = cz - z
      if (dx * dx + dy * dy + dz * dz > r2) continue
      kept[g].push(i0, i1, i2)
      tris++
    }
  }
  if (tris < 8) return null

  const map = new Int32Array(src.vertCount)
  map.fill(-1)
  const used: number[] = []
  for (const list of kept) {
    for (let i = 0; i < list.length; i++) {
      const vi = list[i]
      if (map[vi] < 0) {
        map[vi] = used.length
        used.push(vi)
      }
    }
  }
  const n = used.length
  const positions = new Float32Array(n * 3)
  const normals = new Int8Array(n * 3)
  const uvs = new Float32Array(n * 2)
  const colors = new Uint8Array(n * 4)
  for (let i = 0; i < n; i++) {
    const s = used[i]
    positions[i * 3] = pos[s * 3]
    positions[i * 3 + 1] = pos[s * 3 + 1]
    positions[i * 3 + 2] = pos[s * 3 + 2]
    normals[i * 3] = src.normals[s * 3]
    normals[i * 3 + 1] = src.normals[s * 3 + 1]
    normals[i * 3 + 2] = src.normals[s * 3 + 2]
    uvs[i * 2] = src.uvs[s * 2]
    uvs[i * 2 + 1] = src.uvs[s * 2 + 1]
    colors[i * 4] = src.colors[s * 4]
    colors[i * 4 + 1] = src.colors[s * 4 + 1]
    colors[i * 4 + 2] = src.colors[s * 4 + 2]
    colors[i * 4 + 3] = 255
  }
  const remap = (list: number[]): Uint32Array => {
    const out = new Uint32Array(list.length)
    for (let i = 0; i < list.length; i++) out[i] = map[list[i]]
    return out
  }
  return {
    positions,
    normals,
    uvs,
    colors,
    wall: remap(kept[0]),
    ground: remap(kept[1]),
    roof: remap(kept[2]),
    vertCount: n,
  }
}

export class StructureDebris {
  readonly group = new THREE.Group()
  private readonly slots: Piece[] = []
  private readonly n = new Float32Array(3)
  private readonly doubles = new Map<THREE.Material, THREE.Material>()
  private activeCount = 0

  constructor(
    private readonly mats: MaterialLibrary,
    private readonly dust: DustSystem,
  ) {
    this.group.name = 'structure-debris'
  }

  get active(): number {
    return this.activeCount
  }

  /**
   * Detach a chunk (or a clipped shard of one) and fling it. Positions are in
   * world space; the piece is recentred so it spins around its own mass.
   */
  spawnChunk(
    src: ChunkMesh,
    wallMat: THREE.Material,
    storeMat: THREE.Material,
    roofTint: readonly [number, number, number],
    vx: number,
    vy: number,
    vz: number,
  ): void {
    if (src.vertCount < 4) return
    if (src.wall.length + src.ground.length + src.roof.length < 3) return
    const slot = this.takeSlot()
    if (!slot) return

    const positions = new Float32Array(src.positions)
    const colors = new Uint8Array(src.colors)
    applyRoofTint(colors, src.roof, roofTint)
    let cx = 0
    let cy = 0
    let cz = 0
    const n = src.vertCount
    for (let i = 0; i < n; i++) {
      cx += positions[i * 3]
      cy += positions[i * 3 + 1]
      cz += positions[i * 3 + 2]
    }
    cx /= n
    cy /= n
    cz /= n
    for (let i = 0; i < n; i++) {
      positions[i * 3] -= cx
      positions[i * 3 + 1] -= cy
      positions[i * 3 + 2] -= cz
    }

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geo.setAttribute('normal', new THREE.BufferAttribute(new Int8Array(src.normals), 3, true))
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(src.uvs), 2))
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 4, true))
    const index = new Uint32Array(src.wall.length + src.ground.length + src.roof.length)
    index.set(src.wall, 0)
    index.set(src.ground, src.wall.length)
    index.set(src.roof, src.wall.length + src.ground.length)
    geo.setIndex(new THREE.BufferAttribute(index, 1))
    let off = 0
    if (src.wall.length) {
      geo.addGroup(off, src.wall.length, 0)
      off += src.wall.length
    }
    if (src.ground.length) {
      geo.addGroup(off, src.ground.length, 1)
      off += src.ground.length
    }
    if (src.roof.length) geo.addGroup(off, src.roof.length, 2)
    geo.computeBoundingSphere()

    const mesh = slot.mesh
    mesh.geometry = geo
    mesh.material = [this.doubleSided(wallMat), this.doubleSided(storeMat), this.doubleSided(this.mats.roof)]
    mesh.visible = true
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.position.set(cx, cy, cz)
    mesh.quaternion.identity()
    mesh.scale.set(1, 1, 1)
    mesh.updateMatrix()

    slot.geo?.dispose()
    slot.geo = geo
    slot.alive = true
    slot.sleep = false
    slot.px = cx
    slot.py = cy
    slot.pz = cz
    slot.vx = vx
    slot.vy = vy
    slot.vz = vz
    slot.rx = Math.random() * 0.4
    slot.ry = Math.random() * 6
    slot.rz = Math.random() * 0.4
    slot.sx = (Math.random() - 0.5) * 2.4
    slot.sy = (Math.random() - 0.5) * 1.6
    slot.sz = (Math.random() - 0.5) * 2.4
    slot.rest = 0
    slot.corners = aabbCorners(positions)
    // Nudge clear of the surface it was cut from so the first frame isn't z-fighting.
    const face = averageNormal(src.normals, src.vertCount)
    slot.px += face[0] * 0.35
    slot.py += face[1] * 0.2
    slot.pz += face[2] * 0.35
  }

  /**
   * Fallback when the mesher hasn't produced a chunk yet: a thin wall (or roof)
   * slab textured with that building's atlas, not a cube.
   */
  spawnPanel(
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    wallMat: THREE.Material,
    roof: boolean,
    vx: number,
    vy: number,
    vz: number,
  ): void {
    const slot = this.takeSlot()
    if (!slot) return
    const built = roof ? buildRoofSlab() : buildWallSlab()
    orientAndStamp(built.positions, built.normals, built.uvs, x, y, z, nx, ny, nz, roof)
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(built.positions, 3))
    geo.setAttribute('normal', new THREE.BufferAttribute(built.normals, 3))
    geo.setAttribute('uv', new THREE.BufferAttribute(built.uvs, 2))
    geo.setAttribute('color', new THREE.BufferAttribute(built.colors, 4, true))
    geo.setIndex(new THREE.BufferAttribute(built.index, 1))
    geo.addGroup(0, built.faceCount, 0)
    geo.addGroup(built.faceCount, built.index.length - built.faceCount, 1)
    geo.computeBoundingSphere()

    const mesh = slot.mesh
    mesh.geometry = geo
    mesh.material = [this.doubleSided(roof ? this.mats.roof : wallMat), this.doubleSided(this.mats.concrete)]
    mesh.visible = true
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.quaternion.identity()
    mesh.position.set(x, y, z)
    mesh.scale.set(1, 1, 1)
    mesh.updateMatrix()

    slot.geo?.dispose()
    slot.geo = geo
    slot.alive = true
    slot.sleep = false
    slot.px = x + nx * 0.4
    slot.py = y + Math.max(0.2, ny * 0.2)
    slot.pz = z + nz * 0.4
    slot.vx = vx
    slot.vy = vy
    slot.vz = vz
    slot.rx = Math.random() * Math.PI
    slot.ry = Math.random() * Math.PI
    slot.rz = Math.random() * Math.PI
    slot.sx = (Math.random() - 0.5) * 3
    slot.sy = (Math.random() - 0.5) * 3
    slot.sz = (Math.random() - 0.5) * 3
    slot.rest = 0
    slot.corners = aabbCorners(built.positions)
  }

  /** Clip still-standing chunks around an impact and fling those shards. */
  ejectNear(rt: BuildingRT, x: number, y: number, z: number, radius: number, speed: number): number {
    const grid = rt.grid
    if (!grid) return 0
    const tint = roofTintFor(rt.spec.id)
    let spawned = 0
    const r = radius * 0.92 + 0.6
    for (let key = 0; key < rt.chunks.length && spawned < 4; key++) {
      const chunk = rt.chunks[key]
      if (!chunk || chunk.vertCount < 8) continue
      if (!chunkOverlaps(grid, key, x, y, z, r + 1)) continue
      const piece = clipChunk(chunk, x, y, z, r)
      if (!piece) continue
      const face = averageNormal(piece.normals, piece.vertCount)
      const sp = 3.5 + speed * 0.08
      this.spawnChunk(
        piece,
        rt.wallMat,
        rt.storeMat,
        tint,
        face[0] * sp + (Math.random() - 0.5) * 2,
        Math.abs(face[1]) * sp * 0.35 + 1.5 + Math.random() * 3,
        face[2] * sp + (Math.random() - 0.5) * 2,
      )
      spawned++
    }
    return spawned
  }

  update(dt: number, phys: PhysWorld): void {
    let active = 0
    for (const p of this.slots) {
      if (!p.alive || p.sleep) continue
      active++
      p.vy -= 24 * dt
      p.px += p.vx * dt
      p.py += p.vy * dt
      p.pz += p.vz * dt
      p.rx += p.sx * dt
      p.ry += p.sy * dt
      p.rz += p.sz * dt

      const mesh = p.mesh
      mesh.position.set(p.px, p.py, p.pz)
      mesh.rotation.set(p.rx, p.ry, p.rz)
      mesh.updateMatrix()

      let minY = Infinity
      const corners = p.corners
      for (let c = 0; c < 8; c++) {
        _corner.fromArray(corners, c * 3).applyMatrix4(mesh.matrix)
        if (_corner.y < minY) minY = _corner.y
      }
      let supported = false
      if (minY < 0.02) {
        const hit = minY
        p.py -= hit
        if (p.vy < -3.5) {
          this.dust.spawn(p.px, 0.4, p.pz, 6, 1.4, 2.2, 0.15)
          p.vy = -p.vy * 0.22
          p.vx *= 0.72
          p.vz *= 0.72
          p.sx *= 0.55
          p.sy *= 0.55
          p.sz *= 0.55
        } else {
          p.vy = 0
          p.vx *= 0.6
          p.vz *= 0.6
          p.sx *= 0.4
          p.sy *= 0.4
          p.sz *= 0.4
        }
        supported = true
        mesh.position.y = p.py
        mesh.updateMatrix()
      }

      const cd = phys.concreteDistance(p.px, p.py, p.pz)
      if (cd < 0.45 && phys.concreteNormal(p.px, p.py, p.pz, this.n)) {
        const push = 0.45 - cd
        p.px += this.n[0] * push
        p.py += this.n[1] * push
        p.pz += this.n[2] * push
        const vn = p.vx * this.n[0] + p.vy * this.n[1] + p.vz * this.n[2]
        if (vn < 0) {
          p.vx -= vn * this.n[0] * 1.15
          p.vy -= vn * this.n[1] * 1.15
          p.vz -= vn * this.n[2] * 1.15
        }
        p.vx *= 0.86
        p.vz *= 0.86
        supported = true
      }

      const speed = Math.abs(p.vx) + Math.abs(p.vy) + Math.abs(p.vz)
      if (speed < 0.4 && supported) {
        p.rest += dt
        if (p.rest > 0.45) p.sleep = true
      } else {
        p.rest = 0
      }
      mesh.position.set(p.px, p.py, p.pz)
      mesh.updateMatrix()
    }
    this.activeCount = active
  }

  clear(): void {
    for (const p of this.slots) {
      p.alive = false
      p.sleep = false
      p.mesh.visible = false
      p.geo?.dispose()
      p.geo = null
    }
    this.activeCount = 0
  }

  /** Shared building materials are front-sided; a tumbling slab has to show both faces. */
  private doubleSided(mat: THREE.Material): THREE.Material {
    let d = this.doubles.get(mat)
    if (!d) {
      d = (mat as THREE.MeshLambertMaterial).clone()
      d.side = THREE.DoubleSide
      this.doubles.set(mat, d)
    }
    return d
  }

  private takeSlot(): Piece | null {
    for (const p of this.slots) {
      if (!p.alive) return p
    }
    for (const p of this.slots) {
      if (p.sleep) {
        p.alive = false
        p.mesh.visible = false
        return p
      }
    }
    if (this.slots.length >= CAP) return null
    const mesh = new THREE.Mesh()
    mesh.frustumCulled = false
    mesh.matrixAutoUpdate = false
    mesh.visible = false
    this.group.add(mesh)
    const piece: Piece = {
      mesh,
      alive: false,
      sleep: false,
      px: 0,
      py: 0,
      pz: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      rx: 0,
      ry: 0,
      rz: 0,
      sx: 0,
      sy: 0,
      sz: 0,
      rest: 0,
      corners: new Float32Array(24),
      geo: null,
    }
    this.slots.push(piece)
    return piece
  }
}

function applyRoofTint(colors: Uint8Array, roof: Uint32Array, tint: readonly [number, number, number]): void {
  if (roof.length === 0) return
  const seen = new Uint8Array(colors.length / 4)
  for (let i = 0; i < roof.length; i++) {
    const v = roof[i]
    if (seen[v]) continue
    seen[v] = 1
    colors[v * 4] = Math.min(255, (colors[v * 4] * tint[0]) | 0)
    colors[v * 4 + 1] = Math.min(255, (colors[v * 4 + 1] * tint[1]) | 0)
    colors[v * 4 + 2] = Math.min(255, (colors[v * 4 + 2] * tint[2]) | 0)
  }
}

function averageNormal(normals: Int8Array, vertCount: number): [number, number, number] {
  let x = 0
  let y = 0
  let z = 0
  const n = Math.min(vertCount, 80)
  for (let i = 0; i < n; i++) {
    x += normals[i * 3]
    y += normals[i * 3 + 1]
    z += normals[i * 3 + 2]
  }
  const len = Math.hypot(x, y, z) || 1
  return [x / len, y / len, z / len]
}

function aabbCorners(positions: Float32Array): Float32Array {
  let minX = Infinity
  let minY = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let maxZ = -Infinity
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]
    const y = positions[i + 1]
    const z = positions[i + 2]
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (z < minZ) minZ = z
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
    if (z > maxZ) maxZ = z
  }
  const c = new Float32Array(24)
  let k = 0
  for (const x of [minX, maxX]) {
    for (const y of [minY, maxY]) {
      for (const z of [minZ, maxZ]) {
        c[k++] = x
        c[k++] = y
        c[k++] = z
      }
    }
  }
  return c
}

function chunkOverlaps(
  grid: NonNullable<BuildingRT['grid']>,
  key: number,
  x: number,
  y: number,
  z: number,
  r: number,
): boolean {
  const cs = grid.chunkCells
  const cx = key % grid.ncx
  const cy = Math.floor(key / grid.ncx) % grid.ncy
  const cz = Math.floor(key / (grid.ncx * grid.ncy))
  const v = grid.voxel
  const x0 = grid.ox + cx * cs * v
  const y0 = grid.oy + cy * cs * v
  const z0 = grid.oz + cz * cs * v
  const x1 = x0 + cs * v
  const y1 = y0 + cs * v
  const z1 = z0 + cs * v
  const dx = x < x0 ? x0 - x : x > x1 ? x - x1 : 0
  const dy = y < y0 ? y0 - y : y > y1 ? y - y1 : 0
  const dz = z < z0 ? z0 - z : z > z1 ? z - z1 : 0
  return dx * dx + dy * dy + dz * dz <= r * r
}

interface Slab {
  positions: Float32Array
  normals: Float32Array
  uvs: Float32Array
  colors: Uint8Array
  index: Uint32Array
  faceCount: number
}

/** Thin wall section, local +Z facing the street. Corners jittered so it isn't a box. */
function buildWallSlab(): Slab {
  const j = Math.random()
  const hw = 1.05 + j * 0.55
  const hh = 1.35 + Math.random() * 0.7
  const t = 0.16
  const bite = 0.35 + Math.random() * 0.35
  // 0-3 front, 4-7 back. Front corner 1 is pulled in so the silhouette is broken.
  const xy = [
    [-hw, -hh],
    [hw * (1 - bite), -hh * 0.72],
    [hw, hh],
    [-hw * 0.82, hh],
  ]
  const positions = new Float32Array(8 * 3)
  const normals = new Float32Array(8 * 3)
  for (let i = 0; i < 4; i++) {
    positions[i * 3] = xy[i][0]
    positions[i * 3 + 1] = xy[i][1]
    positions[i * 3 + 2] = t
    positions[(i + 4) * 3] = xy[i][0]
    positions[(i + 4) * 3 + 1] = xy[i][1]
    positions[(i + 4) * 3 + 2] = -t
    normals[i * 3 + 2] = 1
    normals[(i + 4) * 3 + 2] = -1
  }
  const index = new Uint32Array([
    0, 1, 2, 0, 2, 3, // front
    4, 6, 5, 4, 7, 6, // back
    0, 4, 5, 0, 5, 1,
    1, 5, 6, 1, 6, 2,
    2, 6, 7, 2, 7, 3,
    3, 7, 4, 3, 4, 0,
  ])
  return {
    positions,
    normals,
    uvs: new Float32Array(8 * 2),
    colors: solidColor(8, 228, 224, 214),
    index,
    faceCount: 6,
  }
}

function buildRoofSlab(): Slab {
  const hw = 1.2 + Math.random() * 0.8
  const hd = 1.1 + Math.random() * 0.7
  const t = 0.14
  const positions = new Float32Array([
    -hw, t, -hd, hw, t, -hd, hw * 0.7, t, hd, -hw, t, hd * 0.8,
    -hw, -t, -hd, hw, -t, -hd, hw * 0.7, -t, hd, -hw, -t, hd * 0.8,
  ])
  const normals = new Float32Array(8 * 3)
  for (let i = 0; i < 4; i++) normals[i * 3 + 1] = 1
  for (let i = 4; i < 8; i++) normals[i * 3 + 1] = -1
  const index = new Uint32Array([
    0, 1, 2, 0, 2, 3,
    4, 6, 5, 4, 7, 6,
    0, 4, 5, 0, 5, 1,
    1, 5, 6, 1, 6, 2,
    2, 6, 7, 2, 7, 3,
    3, 7, 4, 3, 4, 0,
  ])
  return {
    positions,
    normals,
    uvs: new Float32Array(8 * 2),
    colors: solidColor(8, 210, 204, 190),
    index,
    faceCount: 6,
  }
}

function solidColor(n: number, r: number, g: number, b: number): Uint8Array {
  const c = new Uint8Array(n * 4)
  for (let i = 0; i < n; i++) {
    c[i * 4] = r
    c[i * 4 + 1] = g
    c[i * 4 + 2] = b
    c[i * 4 + 3] = 255
  }
  return c
}

/**
 * Move a local slab onto the impact, facing `n`, and box-project UVs the same
 * way the standing facade does so the texture lines up with the hole.
 */
function orientAndStamp(
  positions: Float32Array,
  normals: Float32Array,
  uvs: Float32Array,
  x: number,
  y: number,
  z: number,
  nx: number,
  ny: number,
  nz: number,
  roof: boolean,
): void {
  const len = Math.hypot(nx, ny, nz) || 1
  _normal.set(nx / len, ny / len, nz / len)
  _base.setFromUnitVectors(roof ? _Y : _Z, _normal)
  for (let i = 0; i < normals.length; i += 3) {
    _corner.set(normals[i], normals[i + 1], normals[i + 2]).applyQuaternion(_base)
    normals[i] = _corner.x
    normals[i + 1] = _corner.y
    normals[i + 2] = _corner.z
  }
  for (let i = 0; i < positions.length; i += 3) {
    _corner.set(positions[i], positions[i + 1], positions[i + 2]).applyQuaternion(_base)
    const wx = x + _corner.x
    const wy = y + _corner.y
    const wz = z + _corner.z
    positions[i] = _corner.x
    positions[i + 1] = _corner.y
    positions[i + 2] = _corner.z
    const ax = Math.abs(_normal.x)
    const ay = Math.abs(_normal.y)
    const az = Math.abs(_normal.z)
    const ui = (i / 3) * 2
    if (ay > ax && ay > az) {
      uvs[ui] = wx / ROOF_TILE_M
      uvs[ui + 1] = wz / ROOF_TILE_M
    } else if (ax >= az) {
      uvs[ui] = wz / WALL_TILE_M
      uvs[ui + 1] = wy / WALL_TILE_M
    } else {
      uvs[ui] = wx / WALL_TILE_M
      uvs[ui + 1] = wy / WALL_TILE_M
    }
  }
}
