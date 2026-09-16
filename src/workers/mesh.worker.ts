/// <reference lib="webworker" />
import { meshChunk } from '../sdf/surfaceNets'
import type { MeshJobInput } from '../sdf/surfaceNets'

/**
 * Meshing worker. Keeps the surface-nets scratch buffers hot and streams chunk
 * geometry back with zero-copy transfers, so the main thread never pays for
 * isosurface extraction (this is what keeps frame times flat while a building
 * is being drilled through).
 */

export interface MeshJob {
  buildingId: number
  key: number
  input: MeshJobInput
}

export interface MeshResponse {
  type: 'meshed'
  ms: number
  results: { buildingId: number; key: number; mesh: ReturnType<typeof meshChunk> }[]
}

const ctx = self as unknown as DedicatedWorkerGlobalScope

ctx.onmessage = (ev: MessageEvent): void => {
  const msg = ev.data as { type: string; jobs?: MeshJob[] }
  if (msg.type === 'ping') {
    ctx.postMessage({ type: 'ready' })
    return
  }
  if (msg.type !== 'mesh' || !msg.jobs) return

  const t0 = performance.now()
  const results: MeshResponse['results'] = []
  const transfer: Transferable[] = []
  for (let i = 0; i < msg.jobs.length; i++) {
    const job = msg.jobs[i]
    const mesh = meshChunk(job.input)
    results.push({ buildingId: job.buildingId, key: job.key, mesh })
    if (mesh) {
      transfer.push(
        mesh.positions.buffer,
        mesh.normals.buffer,
        mesh.uvs.buffer,
        mesh.colors.buffer,
        mesh.wall.buffer,
        mesh.roof.buffer,
      )
    }
  }
  const response: MeshResponse = { type: 'meshed', ms: performance.now() - t0, results }
  ctx.postMessage(response, transfer)
}
