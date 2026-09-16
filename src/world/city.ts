import * as THREE from 'three'
import type { Blueprint, BuildingSpec } from '../sdf/blueprint'
import { facadeTint } from '../sdf/blueprint'
import { BuildingGrid, EMPTY as EMPTY_VAL, type CarveResult } from '../sdf/grid'
import { buildingBounds } from '../sdf/field'
import type { ChunkMesh } from '../sdf/surfaceNets'
import { MeshQueue, type MeshResult } from './meshQueue'
import type { MaterialLibrary } from '../render/materials'
import type { TextureLibrary } from '../render/textures'
import { clamp } from '../core/util'
import type { Profiler } from '../core/profiler'

/**
 * Per-building rooftop tints (linear multipliers on the baked vertex colour).
 * Gravel, tar, weathered felt, pale sand and green-grey roofs each appear, so
 * the skyline seen from above is not a single sheet of grey. The tint is applied
 * only to the `roof` index group, leaving the facades untouched.
 */
const ROOF_TINTS: [number, number, number][] = [
  [0.98, 0.97, 0.93],
  [0.78, 0.72, 0.64],
  [0.84, 0.88, 0.8],
  [0.68, 0.68, 0.71],
  [1.0, 0.93, 0.79],
  [0.78, 0.85, 0.9],
  [0.9, 0.84, 0.72],
  [0.62, 0.64, 0.66],
]

/**
 * The destructible city.
 *
 * Responsibilities:
 *  - incrementally voxelise every building's SDF (never stalls a frame)
 *  - stream chunk meshes through the worker and assemble per-building meshes
 *  - answer distance/gradient queries used by character + debris physics
 *  - apply damage (SDF boolean subtraction) and structural collapse
 */

export interface BuildingRT {
  index: number
  spec: BuildingSpec
  grid: BuildingGrid | null
  chunks: (ChunkMesh | null)[]
  geo: THREE.BufferGeometry | null
  mesh: THREE.Mesh | null
  wallMat: THREE.MeshLambertMaterial
  /** Chunks still waiting on the mesher. */
  pending: number
  rebuildQueued: boolean
  state: 'pending' | 'intact' | 'damaged' | 'collapsing' | 'destroyed'
  verts: number
  tris: number
  collapsedRows: number
  /** Cached world bounds for broadphase. */
  x0: number
  x1: number
  y1: number
  z0: number
  z1: number
  /** Centre used for debris/impact bookkeeping. */
  cx: number
  cz: number
}

export interface CarveEvent {
  rt: BuildingRT
  res: CarveResult
}

export interface CollapseEvent {
  rt: BuildingRT
  /** World Y of the shear plane. */
  cutY: number
  /** Chunks that were structurally removed (for debris spawning). */
  removed: { x: number; y: number; z: number; size: number }[]
  /** Total destroyed chunk volume, m^3. */
  volume: number
}

export interface QueryHit {
  distance: number
  building: BuildingRT | null
}

export interface GenerationStatus {
  progress: number
  label: string
  done: boolean
}

export class City {
  readonly group = new THREE.Group()
  readonly buildings: BuildingRT[] = []
  /** Buildings with a real SDF grid (destructible + collidable). */
  readonly destructibles: BuildingRT[] = []
  impostors: THREE.InstancedMesh | null = null
  readonly meshQueue: MeshQueue
  onBuildingReady: ((rt: BuildingRT) => void) | null = null

  private readonly pendingRebuild = new Set<number>()
  private voxCursor = 0
  private kCursor = 0
  private meshDispatched = false
  private totalChunks = 1
  private meshedChunks = 0
  private voxLabel = 'voxelising sdf city'
  /** Scratch for gradient queries. */
  private readonly gradOut = new Float32Array(3)
  private readonly byId = new Map<number, BuildingRT>()

  constructor(
    readonly bp: Blueprint,
    private readonly mats: MaterialLibrary,
    private readonly tex: TextureLibrary,
    private readonly profiler: Profiler,
  ) {
    this.meshQueue = new MeshQueue((buildingId) => {
      const rt = this.byId.get(buildingId)
      if (!rt || !rt.grid) return null
      const [r, g, b] = facadeTint(rt.spec.style, rt.spec.tint)
      return { grid: rt.grid, tintR: r, tintG: g, tintB: b }
    })
    this.meshQueue.onResults = (results) => this.onMeshResults(results)
    this.indexBuildings()
    for (const rt of this.buildings) this.byId.set(rt.spec.id, rt)
  }

  // ---------------------------------------------------------------- setup --
  private indexBuildings(): void {
    const bp = this.bp
    const impostorBoxes: { spec: BuildingSpec }[] = []
    for (const spec of bp.buildings) {
      const rt: BuildingRT = {
        index: this.buildings.length,
        spec,
        grid: spec.lod === 2 ? null : new BuildingGrid(spec),
        chunks: [],
        geo: null,
        mesh: null,
        wallMat: this.mats.walls[spec.style % this.mats.walls.length],
        pending: 0,
        rebuildQueued: false,
        state: spec.lod === 2 ? 'intact' : 'pending',
        verts: 0,
        tris: 0,
        collapsedRows: 0,
        x0: spec.x - spec.hw - 1,
        x1: spec.x + spec.hw + 1,
        y1: spec.h + 2,
        z0: spec.z - spec.hd - 1,
        z1: spec.z + spec.hd + 1,
        cx: spec.x,
        cz: spec.z,
      }
      const b = buildingBounds(spec)
      rt.x0 = b.x0
      rt.x1 = b.x1
      rt.z0 = b.z0
      rt.z1 = b.z1
      rt.y1 = b.y1
      this.buildings.push(rt)
      if (spec.lod === 2) impostorBoxes.push({ spec })
      else this.destructibles.push(rt)
    }
    this.totalChunks = 1

    // Distant skyline: a single instanced box mesh (1 draw call for ~90 towers).
    const n = impostorBoxes.length
    if (n > 0) {
      const geo = new THREE.BoxGeometry(2, 2, 2)
      const uv = geo.getAttribute('uv') as THREE.BufferAttribute
      for (let i = 0; i < uv.count; i++) {
        uv.setXY(i, uv.getX(i) * 1.5, uv.getY(i) * 1.5)
      }
      const mesh = new THREE.InstancedMesh(geo, this.mats.impostor, n)
      const m = new THREE.Matrix4()
      const col = new THREE.Color()
      // Bake aerial perspective into the skyline: distant blocks are pushed
      // towards the horizon haze so they read as receding silhouettes rather
      // than hard black cut-outs.
      const haze = new THREE.Color(0xc3c5c6)
      for (let i = 0; i < n; i++) {
        const s = impostorBoxes[i].spec
        m.makeScale(s.hw, s.h * 0.5, s.hd)
        m.setPosition(s.x, s.h * 0.5, s.z)
        mesh.setMatrixAt(i, m)
        const [r, g, b] = facadeTint(s.style, s.tint)
        col.setRGB(r * 0.8, g * 0.82, b * 0.9)
        const k = Math.min(1, Math.hypot(s.x, s.z) / 900) * 0.55
        col.lerp(haze, k)
        mesh.setColorAt(i, col)
      }
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
      mesh.frustumCulled = false
      this.impostors = mesh
      this.group.add(mesh)
    }

    this.buildGround()
  }

  private buildGround(): void {
    const span = this.tex.groundSpan
    // The painted ground covers exactly the city footprint; the mesh is larger
    // and lets the edge texels stretch outwards so there is no visible seam
    // where the painted streets stop.
    const meshSpan = span * 1.35
    const g = new THREE.PlaneGeometry(meshSpan, meshSpan)
    const uv = g.getAttribute('uv') as THREE.BufferAttribute
    const k = span / meshSpan
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, (uv.getX(i) - 0.5) * k + 0.5, (uv.getY(i) - 0.5) * k + 0.5)
    }
    const mesh = new THREE.Mesh(g, this.mats.ground)
    mesh.rotation.x = -Math.PI / 2
    mesh.receiveShadow = true
    mesh.matrixAutoUpdate = false
    mesh.updateMatrix()
    this.group.add(mesh)

    const far = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000), this.mats.farGround)
    far.rotation.x = -Math.PI / 2
    far.position.y = -0.6
    far.matrixAutoUpdate = false
    far.updateMatrix()
    this.group.add(far)
  }

  /** True while city construction work remains. */
  get generating(): boolean {
    return !this.meshDispatched || this.meshedChunks < this.totalChunks - 1
  }

  /** Wipe all damage and rebuild the city from its blueprint. */
  reset(): void {
    for (const rt of this.destructibles) {
      const g = rt.grid!
      g.data.fill(EMPTY_VAL)
      g.levelSolid.fill(0)
      g.levelSolidInitial.fill(0)
      g.removed.clear()
      g.dirty.clear()
      g.solidSamples = 0
      g.destroyedSamples = 0
      g.initialSolidSamples = 1
      rt.chunks = []
      rt.pending = 0
      rt.state = 'pending'
      rt.collapsedRows = 0
      rt.verts = 0
      rt.tris = 0
      if (rt.mesh) rt.mesh.visible = false
    }
    this.voxCursor = 0
    this.kCursor = 0
    this.meshDispatched = false
    this.meshedChunks = 0
    this.pendingRebuild.clear()
  }

  // ----------------------------------------------------------- generation --
  /** Advances city construction within a time budget. */
  stepGeneration(budgetMs: number): GenerationStatus {
    const t0 = performance.now()
    const destructibles = this.destructibles

    // Phase 1: rasterise SDF grids, slab of rows at a time.
    while (this.voxCursor < destructibles.length) {
      const rt = destructibles[this.voxCursor]
      const grid = rt.grid!
      const spec = rt.spec
      const slab = Math.max(1, Math.ceil((grid.nx * grid.ny) / 2400))
      const kTo = Math.min(grid.nz, this.kCursor + slab)
      grid.voxelise(spec, this.kCursor, kTo)
      this.kCursor = kTo
      if (this.kCursor >= grid.nz) {
        this.voxCursor++
        this.kCursor = 0
        this.voxLabel = `voxelising sdf city ${this.voxCursor}/${destructibles.length}`
      }
      if (performance.now() - t0 > budgetMs) break
    }

    const voxProgress = destructibles.length === 0 ? 1 : this.voxCursor / destructibles.length

    // Phase 2: enqueue every chunk once voxelisation is complete.
    if (this.voxCursor >= destructibles.length && !this.meshDispatched) {
      this.meshDispatched = true
      let total = 0
      for (const rt of destructibles) {
        const grid = rt.grid!
        rt.chunks = new Array(grid.ncx * grid.ncy * grid.ncz).fill(null)
        total += rt.chunks.length
        for (let key = 0; key < rt.chunks.length; key++) {
          if (grid.removed.has(key)) continue
          rt.pending++
          this.meshQueue.enqueue(rt.spec.id, key)
        }
      }
      this.totalChunks = Math.max(1, total)
    }

    // Phase 3: stream meshes; worker does the heavy lifting in parallel.
    this.meshQueue.tick()
    for (const idx of this.pendingRebuild) this.rebuildGeometry(this.buildings[idx])
    this.pendingRebuild.clear()

    const meshProgress = this.meshDispatched ? this.meshedChunks / this.totalChunks : 0
    const progress = this.meshDispatched ? 0.4 + 0.6 * meshProgress : 0.4 * voxProgress
    const label = !this.meshDispatched
      ? this.voxLabel
      : `meshing surface nets ${this.meshedChunks}/${this.totalChunks}`
    const done = this.meshDispatched && this.meshQueue.pending === 0 && this.meshedChunks >= this.totalChunks - 1
    return { progress: clamp(progress, 0, 1), label, done }
  }

  private onMeshResults(results: MeshResult[]): void {
    for (const r of results) {
      const rt = this.byId.get(r.buildingId)
      if (!rt) continue
      // A structure may have been removed (collapsed) while this job was
      // in flight: drop the stale chunk instead of resurrecting it.
      const removed = rt.grid ? rt.grid.removed.has(r.key) : false
      rt.chunks[r.key] = removed ? null : r.mesh
      rt.pending--
      this.meshedChunks++
      if (rt.pending <= 0) {
        rt.state = rt.state === 'pending' ? 'intact' : rt.state
        this.pendingRebuild.add(rt.index)
      }
    }
  }

  /** Rebuild a damaged building's geometry from its (cached) chunk meshes. */
  private rebuildGeometry(rt: BuildingRT): void {
    let vertCount = 0
    let wallIdx = 0
    let roofIdx = 0
    for (let i = 0; i < rt.chunks.length; i++) {
      const c = rt.chunks[i]
      if (!c) continue
      vertCount += c.vertCount
      wallIdx += c.wall.length
      roofIdx += c.roof.length
    }
    if (vertCount === 0) {
      if (rt.mesh) rt.mesh.visible = false
      return
    }
    const positions = new Float32Array(vertCount * 3)
    const normals = new Int8Array(vertCount * 3)
    const uvs = new Float32Array(vertCount * 2)
    const colors = new Uint8Array(vertCount * 4)
    const index = new Uint32Array(wallIdx + roofIdx)
    // Roofs share the vertex-colour channel with the walls, so instead of
    // needing a second material we multiply just the roof vertices by a
    // per-building tar/gravel tint — cheap, and it stops every rooftop in the
    // skyline from reading as the same flat grey.
    const rtint = ROOF_TINTS[rt.spec.id % ROOF_TINTS.length]
    const rr = rtint[0]
    const rg = rtint[1]
    const rb = rtint[2]
    let vOff = 0
    let iOff = 0
    let rOff = wallIdx
    for (let i = 0; i < rt.chunks.length; i++) {
      const c = rt.chunks[i]
      if (!c) continue
      positions.set(c.positions, vOff * 3)
      normals.set(c.normals, vOff * 3)
      uvs.set(c.uvs, vOff * 2)
      colors.set(c.colors, vOff * 4)
      for (let k = 0; k < c.wall.length; k++) index[iOff + k] = c.wall[k] + vOff
      for (let k = 0; k < c.roof.length; k++) {
        const vi = (c.roof[k] + vOff) * 4
        colors[vi] = Math.min(255, (colors[vi] * rr) | 0)
        colors[vi + 1] = Math.min(255, (colors[vi + 1] * rg) | 0)
        colors[vi + 2] = Math.min(255, (colors[vi + 2] * rb) | 0)
        index[rOff + k] = c.roof[k] + vOff
      }
      iOff += c.wall.length
      rOff += c.roof.length
      vOff += c.vertCount
    }

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3, true))
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 4, true))
    geo.setIndex(new THREE.BufferAttribute(index, 1))
    geo.addGroup(0, wallIdx, 0)
    if (roofIdx > 0) geo.addGroup(wallIdx, roofIdx, 1)
    const spec = rt.spec
    geo.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(spec.x, spec.h * 0.5, spec.z),
      Math.hypot(rt.x1 - rt.x0, rt.y1, rt.z1 - rt.z0) * 0.5 + 2,
    )

    if (rt.mesh) {
      rt.mesh.geometry.dispose()
      rt.mesh.geometry = geo
      rt.mesh.visible = true
      rt.geo = geo
    } else {
      const mesh = new THREE.Mesh(geo, [rt.wallMat, this.mats.roof])
      mesh.matrixAutoUpdate = false
      mesh.updateMatrix()
      const isHero = spec.lod === 0
      mesh.castShadow = isHero
      mesh.receiveShadow = true
      this.group.add(mesh)
      rt.mesh = mesh
      rt.geo = geo
      this.onBuildingReady?.(rt)
    }
    rt.verts = vertCount
    rt.tris = (wallIdx + roofIdx) / 3
  }

  // --------------------------------------------------------------- queries --
  /** Nearest SDF distance to any concrete (buildings only, not ground). */
  queryNearest(x: number, y: number, z: number): number {
    let best = 99
    for (let i = 0; i < this.destructibles.length; i++) {
      const rt = this.destructibles[i]
      if (x < rt.x0 || x > rt.x1 || z < rt.z0 || z > rt.z1 || y < -2 || y > rt.y1) continue
      const d = rt.grid!.sampleWorld(x, y, z)
      if (d < best) best = d
      if (best < -2) break
    }
    return best
  }

  /** Which building owns the nearest surface (for impact FX / decals). */
  buildingAt(x: number, y: number, z: number): BuildingRT | null {
    let best = 99
    let hit: BuildingRT | null = null
    for (let i = 0; i < this.destructibles.length; i++) {
      const rt = this.destructibles[i]
      if (x < rt.x0 || x > rt.x1 || z < rt.z0 || z > rt.z1 || y < -2 || y > rt.y1) continue
      const d = rt.grid!.sampleWorld(x, y, z)
      if (d < best) {
        best = d
        hit = rt
      }
    }
    return hit
  }

  /** Outward normal of the nearest surface (buildings only). */
  queryNormal(x: number, y: number, z: number, rt: BuildingRT): void {
    rt.grid!.gradientWorld(x, y, z, this.gradOut)
  }

  // -------------------------------------------------------------- damage ----
  /** Subtract a sphere from every overlapping building. */
  carveSphere(x: number, y: number, z: number, r: number, out: CarveEvent[]): void {
    for (let i = 0; i < this.destructibles.length; i++) {
      const rt = this.destructibles[i]
      if (x < rt.x0 - r || x > rt.x1 + r || z < rt.z0 - r || z > rt.z1 + r || y > rt.y1 + r || y < -r - 2) continue
      const res = rt.grid!.carveSphere(x, y, z, r)
      if (res.changed > 0) {
        this.profiler.carveOps++
        this.profiler.carvedVoxels += res.changed
        out.push({ rt, res })
        this.queueDirty(rt)
      }
    }
  }

  /** Swept carve along a segment: tunnelling, dashing, flung bodies. */
  carveSegment(
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    r: number,
    out: CarveEvent[],
  ): void {
    const dx = bx - ax
    const dy = by - ay
    const dz = bz - az
    const len = Math.hypot(dx, dy, dz)
    const steps = Math.max(1, Math.ceil(len / Math.max(0.4, r * 0.7)))
    for (let s = 0; s <= steps; s++) {
      const t = s / steps
      this.carveSphere(ax + dx * t, ay + dy * t, az + dz * t, r, out)
    }
  }

  private queueDirty(rt: BuildingRT): void {
    const grid = rt.grid!
    if (grid.dirty.size === 0) return
    rt.state = 'damaged'
    for (const key of grid.dirty) {
      if (rt.chunks[key] === null && grid.removed.has(key)) continue
      rt.pending++
      this.meshQueue.enqueue(rt.spec.id, key)
    }
    grid.dirty.clear()
  }

  /** Pump the mesh queue (call every frame during gameplay). */
  tick(): void {
    this.meshQueue.tick()
    this.profiler.chunkJobsQueued = this.meshQueue.stats.queued
    this.profiler.chunkJobsDone = this.meshQueue.stats.meshed
    if (this.pendingRebuild.size === 0) return
    let budget = 3
    for (const idx of this.pendingRebuild) {
      this.rebuildGeometry(this.buildings[idx])
      this.pendingRebuild.delete(idx)
      if (--budget <= 0) break
    }
  }

  // ------------------------------------------------------------ structure ---
  /**
   * Structural check after damage: if a whole storey has lost enough support,
   * every chunk above that plane shears off and becomes debris.
   */
  tryCollapse(rt: BuildingRT, minDamage = 0.18, cutSupport = 0.34): CollapseEvent | null {
    const grid = rt.grid
    if (!grid || rt.state === 'destroyed') return null
    if (grid.damageFraction < minDamage) return null
    const { cutLevel, supportAbove } = grid.evaluateStructure(cutSupport)
    if (cutLevel < 0 || supportAbove > 0.92) return null

    const cs = grid.chunkCells
    const cutChunkY = Math.floor(cutLevel / cs)
    if (cutChunkY < 0 || cutChunkY >= grid.ncy) return null

    const removed: CollapseEvent['removed'] = []
    let volume = 0
    const size = cs * grid.voxel
    for (let cz = 0; cz < grid.ncz; cz++) {
      for (let cy = cutChunkY; cy < grid.ncy; cy++) {
        for (let cx = 0; cx < grid.ncx; cx++) {
          const key = cx + grid.ncx * (cy + grid.ncy * cz)
          if (grid.removed.has(key)) continue
          grid.eraseChunk(cx, cy, cz)
          rt.chunks[key] = null
          removed.push({
            x: grid.ox + (cx * cs + cs * 0.5) * grid.voxel,
            y: grid.oy + (cy * cs + cs * 0.5) * grid.voxel,
            z: grid.oz + (cz * cs + cs * 0.5) * grid.voxel,
            size,
          })
          volume += size * size * size
        }
      }
    }
    if (removed.length === 0) return null
    rt.collapsedRows = Math.max(rt.collapsedRows, grid.ncy - cutChunkY)
    rt.state = 'collapsing'
    // Remaining chunks were not re-meshed (they just vanish): rebuild the mesh
    // from the surviving chunk data.
    this.pendingRebuild.add(rt.index)
    // Anything left below the shear plane stays, but its dirty set is now stale.
    grid.dirty.clear()

    // Nothing left standing? Mark it gone so it stops being simulated/carved.
    const totalLeft = grid.solidSamples / Math.max(1, grid.initialSolidSamples)
    if (totalLeft < 0.14 || grid.damageFraction > 0.86) {
      // Gone as a structure, but whatever geometry survives below the shear
      // plane stays in the world as rubble.
      rt.state = 'destroyed'
    }
    return { rt, cutY: grid.oy + cutChunkY * cs * grid.voxel, removed, volume }
  }

  get stats(): Record<string, number> {
    let verts = 0
    let tris = 0
    let destroyed = 0
    for (const rt of this.destructibles) {
      verts += rt.verts
      tris += rt.tris
      if (rt.state === 'destroyed') destroyed++
    }
    return {
      buildings: this.buildings.length,
      destructible: this.destructibles.length,
      cityVerts: verts,
      cityTris: tris,
      destroyedBuildings: destroyed,
    }
  }

  dispose(): void {
    this.meshQueue.dispose()
    for (const rt of this.buildings) {
      rt.geo?.dispose()
      rt.chunks = []
    }
  }
}
