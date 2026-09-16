import { EMPTY, type BuildingGrid } from '../sdf/grid'
import { ROOF_TILE_M, WALL_TILE_M } from '../render/textures'
import type { ChunkMesh } from '../sdf/surfaceNets'
import { meshChunk } from '../sdf/surfaceNets'
import type { MeshJob, MeshResponse } from '../workers/mesh.worker'

/**
 * Chunk meshing scheduler.
 *
 * Main thread: extracts small (CS+2)^3 slabs from the canonical SDF grids and
 * dispatches them to one worker with a bounded number of jobs in flight. Results
 * come back as transferable buffers, so no copying and no main-thread stalls.
 *
 * A synchronous fallback runs if workers are unavailable (or if the caller wants
 * a deterministic single-threaded frame for profiling).
 */

export interface MeshResult {
  buildingId: number
  key: number
  mesh: ChunkMesh | null
}

export interface MeshResolve {
  grid: BuildingGrid
  tintR: number
  tintG: number
  tintB: number
}

export interface MeshQueueStats {
  queued: number
  inflight: number
  dispatched: number
  meshed: number
  workerMs: number
  mode: 'worker' | 'inline'
}

export function extractSlab(grid: BuildingGrid, cx: number, cy: number, cz: number, out: Int8Array): void {
  const cs = grid.chunkCells
  const dim = cs + 2
  const i0 = cx * cs - 1
  const j0 = cy * cs - 1
  const k0 = cz * cs - 1
  const d = grid.data
  const nx = grid.nx
  const ny = grid.ny
  const nz = grid.nz
  const plane = dim * dim
  for (let k = 0; k < dim; k++) {
    const gk = k0 + k
    if (gk < 0 || gk >= nz) {
      out.fill(EMPTY, k * plane, (k + 1) * plane)
      continue
    }
    for (let j = 0; j < dim; j++) {
      const gj = j0 + j
      const row = k * plane + j * dim
      if (gj < 0 || gj >= ny) {
        out.fill(EMPTY, row, row + dim)
        continue
      }
      const src = nx * (gj + ny * gk)
      for (let i = 0; i < dim; i++) {
        const gi = i0 + i
        out[row + i] = gi >= 0 && gi < nx ? d[gi + src] : EMPTY
      }
    }
  }
}

export class MeshQueue {
  readonly stats: MeshQueueStats = {
    queued: 0,
    inflight: 0,
    dispatched: 0,
    meshed: 0,
    workerMs: 0,
    mode: 'worker',
  }
  /** Jobs waiting for a free slot: [buildingId, key]. */
  private readonly queue: number[] = []
  private worker: Worker | null = null
  private inflight = 0
  private readonly slabPool: Int8Array[] = []
  private readonly outbox: MeshJob[] = []
  onResults: ((results: MeshResult[]) => void) | null = null
  maxInflight = 4
  batchSize = 4
  /** Budget for the inline fallback, in milliseconds per tick. */
  inlineBudgetMs = 3

  constructor(private readonly resolve: (buildingId: number) => MeshResolve | null) {
    try {
      this.worker = new Worker(new URL('../workers/mesh.worker.ts', import.meta.url), { type: 'module' })
      this.worker.onmessage = (ev: MessageEvent) => this.onWorkerMessage(ev)
      this.worker.onerror = () => {
        this.stats.mode = 'inline'
        this.worker = null
      }
      this.worker.postMessage({ type: 'ping' })
    } catch {
      this.stats.mode = 'inline'
    }
  }

  private onWorkerMessage(ev: MessageEvent): void {
    const msg = ev.data as MeshResponse
    if (msg.type !== 'meshed') return
    this.inflight -= msg.results.length
    this.stats.inflight = this.inflight
    this.stats.meshed += msg.results.length
    this.stats.workerMs += msg.ms
    this.onResults?.(msg.results)
  }

  enqueue(buildingId: number, key: number): void {
    this.queue.push(buildingId, key)
    this.stats.queued++
  }

  get pending(): number {
    return this.queue.length / 2 + this.inflight
  }

  private makeJob(buildingId: number, key: number): MeshJob | null {
    const res = this.resolve(buildingId)
    if (!res) return null
    const grid = res.grid
    const cs = grid.chunkCells
    const dim = cs + 2
    const cx = key % grid.ncx
    const cy = Math.floor(key / grid.ncx) % grid.ncy
    const cz = Math.floor(key / (grid.ncx * grid.ncy))
    const slab = this.slabPool.pop() ?? new Int8Array(dim * dim * dim)
    extractSlab(grid, cx, cy, cz, slab)
    const i0 = cx * cs - 1
    const j0 = cy * cs - 1
    const k0 = cz * cs - 1
    return {
      buildingId,
      key,
      input: {
        slab,
        dim,
        cs,
        voxel: grid.voxel,
        originX: grid.ox + i0 * grid.voxel,
        originY: grid.oy + j0 * grid.voxel,
        originZ: grid.oz + k0 * grid.voxel,
        wallTile: WALL_TILE_M,
        roofTile: ROOF_TILE_M,
        tintR: res.tintR,
        tintG: res.tintG,
        tintB: res.tintB,
      },
    }
  }

  /** Dispatch as much as the in-flight window allows; also drains the inline path. */
  tick(): void {
    if (this.worker && this.stats.mode === 'worker') {
      while (this.inflight < this.maxInflight && this.queue.length >= 2) {
        this.outbox.length = 0
        const n = Math.min(this.batchSize, this.queue.length / 2, this.maxInflight - this.inflight)
        for (let i = 0; i < n; i++) {
          const buildingId = this.queue.shift()!
          const key = this.queue.shift()!
          const job = this.makeJob(buildingId, key)
          if (job) this.outbox.push(job)
        }
        if (this.outbox.length === 0) break
        this.inflight += this.outbox.length
        this.stats.dispatched += this.outbox.length
        this.stats.inflight = this.inflight
        this.worker.postMessage({ type: 'mesh', jobs: this.outbox }, this.outbox.map((j) => j.input.slab.buffer))
        // Slabs were transferred: drop references so the pool refills lazily.
        for (const j of this.outbox) void j
        this.outbox.length = 0
      }
      return
    }

    // Inline fallback with a per-frame budget.
    const t0 = performance.now()
    while (this.queue.length >= 2 && performance.now() - t0 < this.inlineBudgetMs) {
      const buildingId = this.queue.shift()!
      const key = this.queue.shift()!
      const job = this.makeJob(buildingId, key)
      if (!job) continue
      const mesh = meshChunk(job.input)
      this.slabPool.push(job.input.slab)
      this.stats.meshed++
      this.onResults?.([{ buildingId, key, mesh }])
    }
  }

  dispose(): void {
    this.worker?.terminate()
    this.worker = null
  }
}
