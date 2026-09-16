import { Ring } from './util'

/**
 * Zero-allocation frame profiler. All counters are plain numbers on the
 * instance so the V8 JIT keeps them monomorphic / unboxed.
 */
export class Profiler {
  readonly frameMs = new Ring(120)
  readonly simMs = new Ring(120)
  readonly meshMs = new Ring(120)
  readonly renderMs = new Ring(120)
  readonly physicsMs = new Ring(120)

  frames = 0
  fps = 0
  lastFrameStart = 0
  /** Rolling one-second accumulator. */
  private fpsAccum = 0
  private fpsSamples = 0

  // Live counters (reset each frame by the systems that own them).
  drawCalls = 0
  triangles = 0
  chunkJobsQueued = 0
  chunkJobsDone = 0
  carveOps = 0
  carvedVoxels = 0
  activeDebris = 0
  sleepingDebris = 0
  dustParticles = 0
  sparkParticles = 0
  destroyedBuildings = 0
  collapsedChunks = 0
  entities = 0
  physicsSweeps = 0

  private t0 = 0

  begin(): void {
    this.t0 = performance.now()
    this.lastFrameStart = this.t0
  }
  end(wallDt = 0): void {
    const dt = performance.now() - this.t0
    this.frameMs.push(dt)
    this.fpsAccum += wallDt > 0 ? wallDt * 1000 : dt
    this.fpsSamples++
    if (this.fpsAccum >= 400) {
      this.fps = (this.fpsSamples * 1000) / this.fpsAccum
      this.fpsAccum = 0
      this.fpsSamples = 0
    }
    this.frames++
  }
  mark(target: Ring): void {
    target.push(performance.now() - this.t0)
  }
  /** Reset per-frame counters (destruction counters are cumulative). */
  resetFrameCounters(): void {
    this.physicsSweeps = 0
  }

  /** Zero the cumulative destruction counters (new round). */
  resetDestructionCounters(): void {
    this.carveOps = 0
    this.carvedVoxels = 0
    this.collapsedChunks = 0
    this.destroyedBuildings = 0
  }
  toJSON(): Record<string, number> {
    return {
      frames: this.frames,
      fps: +this.fps.toFixed(1),
      frameMsP50: +this.frameMs.percentile(0.5).toFixed(2),
      frameMsP95: +this.frameMs.percentile(0.95).toFixed(2),
      simMs: +this.simMs.last.toFixed(2),
      meshMs: +this.meshMs.last.toFixed(2),
      renderMs: +this.renderMs.last.toFixed(2),
      drawCalls: this.drawCalls,
      triangles: this.triangles,
      chunkJobsQueued: this.chunkJobsQueued,
      chunkJobsDone: this.chunkJobsDone,
      carveOps: this.carveOps,
      activeDebris: this.activeDebris,
      dustParticles: this.dustParticles,
      sparkParticles: this.sparkParticles,
      destroyedBuildings: this.destroyedBuildings,
      collapsedChunks: this.collapsedChunks,
      entities: this.entities,
    }
  }
}
