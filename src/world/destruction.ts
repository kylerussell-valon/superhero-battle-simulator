import type { City, CollapseEvent } from './city'
import type { DebrisSystem, DustSystem, ScorchSystem } from './fx'
import type { PropSystem } from './props'
import type { PhysWorld } from '../physics/phys'
import type { CameraRig } from '../render/cameraRig'
import type { Profiler } from '../core/profiler'
import type { BuildingRT, CarveEvent } from './city'
import { clamp } from '../core/util'

/**
 * Destruction director: turns abstract impact events from characters into
 * world damage, debris, dust, structural collapse and camera feedback.
 *
 * The rule of thumb encoded here: *anything* fast enough and heavy enough carves
 * the SDF, and any building that loses enough support above a storey shears off
 * and comes down.
 */

export interface ImpactLike {
  x: number
  y: number
  z: number
  radius: number
  speed: number
  kind: string
  nx: number
  ny: number
  nz: number
  px?: number
  py?: number
  pz?: number
}

export class DestructionSystem {
  readonly carveOut: CarveEvent[] = []
  shakeAccum = 0
  hitstopTimer = 0
  hitstopScale = 0.22
  /** Timed slow-motion, used for super activations and the KO card. */
  private slowMoTimer = 0
  private slowMoScale = 0.35
  timeScale = 1
  buildingsTorn = 0
  collapseCount = 0
  carvedVoxels = 0
  private readonly touched = new Set<BuildingRT>()
  /** Rumble while a building is coming down. */
  private collapseRumble = 0

  constructor(
    private readonly city: City,
    private readonly debris: DebrisSystem,
    private readonly dust: DustSystem,
    private readonly scorch: ScorchSystem,
    private props: PropSystem,
    private readonly phys: PhysWorld,
    private readonly rig: CameraRig,
    private readonly profiler: Profiler,
  ) {}

  onImpact(ev: ImpactLike): void {
    const kind = ev.kind
    const radius = ev.radius
    const out = this.carveOut
    out.length = 0

    if (ev.px !== undefined && ev.py !== undefined && ev.pz !== undefined && (kind === 'dash' || kind === 'fling')) {
      this.city.carveSegment(ev.px, ev.py, ev.pz, ev.x, ev.y, ev.z, radius, out)
    } else {
      this.city.carveSphere(ev.x, ev.y, ev.z, radius, out)
    }

    let carved = 0
    let sumX = 0
    let sumY = 0
    let sumZ = 0
    this.touched.clear()
    for (const c of out) {
      carved += c.res.changed
      sumX += (c.res.minX + c.res.maxX) * 0.5
      sumY += (c.res.minY + c.res.maxY) * 0.5
      sumZ += (c.res.minZ + c.res.maxZ) * 0.5
      this.touched.add(c.rt)
    }
    this.carvedVoxels += carved

    if (carved > 40) {
      const n = out.length
      const cx = sumX / n
      const cy = sumY / n
      const cz = sumZ / n
      const volume = Math.min(240, carved * 0.02)
      const heavy = kind === 'fling' || kind === 'pound' || kind === 'slam' || kind === 'clap' || kind === 'dash'
      void heavy
      // Dust puffs from the actual carved surface, not just one point.
      this.dust.spawn(cx, cy, cz, Math.round(clamp(volume * 0.28, 3, 26)), radius * 1.5, 5 + radius * 1.6, 0)
      if (kind === 'fling' || kind === 'dash') {
        // A dust cone trailing the moving body.
        this.dust.spawn(ev.x, ev.y, ev.z, 4, radius * 0.8, 3, 0)
      }
      // A handful of concrete chunks fly out of the hole.
      const chunks = Math.round(clamp(carved * 0.0025, 1, 8))
      for (let i = 0; i < chunks; i++) {
        const a = Math.random() * Math.PI * 2
        const sp = 4 + ev.speed * 0.12
        this.debris.spawn(
          cx,
          cy,
          cz,
          clamp(radius * 0.35, 0.6, 3.4),
          Math.cos(a) * sp * 0.6,
          1 + Math.random() * 5,
          Math.sin(a) * sp * 0.6,
          Math.random(),
        )
      }
      // Ground scorch for low impacts.
      if (ev.y < 4 && radius > 1.5) this.scorch.stamp(ev.x, ev.z, radius * 2.4)

      // Props get blown away by big radial hits.
      if (kind === 'pound' || kind === 'clap' || kind === 'slam' || kind === 'land') {
        this.props.launchNear(ev.x, ev.y, ev.z, radius * 2.6, 8 + ev.speed * 0.25, 0.8)
      }

      this.rig.addShake(clamp(carved / 5200 + ev.speed / 700, 0.02, 0.5))
    }

    // Structural check: unique buildings only, once per impact.
    for (const rt of this.touched) {
      const minDamage = kind === 'fling' || kind === 'dash' ? 0.1 : 0.14
      const collapse = this.city.tryCollapse(rt, minDamage, 0.34)
      if (collapse) this.onCollapse(collapse)
    }
  }

  private onCollapse(ev: CollapseEvent): void {
    const chunk = ev.removed
    let sx = 0
    let sz = 0
    let sy = 0
    for (const c of chunk) {
      sx += c.x
      sy += c.y
      sz += c.z
      // Rubble, not boulders. A chunk is 16 m across at hero LOD, so sizing pieces
      // as a fraction of the chunk produced 3-9 m slabs — a handful of giant
      // blocks instead of a collapsed building. Fixed piece sizes around 1.5-3.5 m
      // read as debris at character scale (1.9 m) whatever the chunk size is.
      const per = 6
      for (let i = 0; i < per; i++) {
        const size = Math.min(3.5, c.size) * (0.11 + Math.random() * 0.14)
        const ox = (Math.random() - 0.5) * c.size * 0.9
        const oy = (Math.random() - 0.5) * c.size * 0.9
        const oz = (Math.random() - 0.5) * c.size * 0.9
        const dirX = c.x - ev.rt.cx
        const dirZ = c.z - ev.rt.cz
        const len = Math.max(1, Math.hypot(dirX, dirZ))
        this.debris.spawn(
          c.x + ox,
          c.y + oy,
          c.z + oz,
          size,
          (dirX / len) * (0.8 + Math.random() * 2.6),
          -1 - Math.random() * 3,
          (dirZ / len) * (0.8 + Math.random() * 2.6),
          Math.random(),
        )
      }
    }
    const n = Math.max(1, chunk.length)
    const cx = sx / n
    const cy = sy / n
    void cy
    const cz = sz / n
    const spread = ev.rt.x1 - ev.rt.x0
    this.dust.spawn(cx, ev.cutY + 4, cz, 60, spread * 0.6, 9, 0.5)
    this.dust.spawn(cx, ev.cutY * 0.4, cz, 40, spread * 0.8, 7, 0.3)
    this.rig.addShake(0.9 + Math.min(0.8, ev.volume / 40000))
    this.hitstopTimer = Math.max(this.hitstopTimer, 0.09)
    this.collapseRumble = 1.6
    this.buildingsTorn++
    this.collapseCount++
    this.profiler.collapsedChunks += chunk.length
    this.profiler.destroyedBuildings = this.buildingsTorn
    // Everything on the street around the tower gets thrown clear.
    this.props.launchNear(cx, 0, cz, spread * 2.4, 16, 1.1)
    this.scorch.stamp(cx, cz, spread * 1.6, 24)
  }

  setProps(props: PropSystem): void {
    this.props = props
  }

  /** Timed slow-motion for cinematics. Takes the stronger of any active request. */
  slowMo(seconds: number, scale = 0.35): void {
    if (seconds <= 0) return
    this.slowMoTimer = Math.max(this.slowMoTimer, seconds)
    this.slowMoScale = Math.min(this.slowMoScale, scale)
  }

  get slowMoActive(): boolean {
    return this.slowMoTimer > 0
  }

  update(dt: number): void {
    let scale = 1
    if (this.hitstopTimer > 0) {
      this.hitstopTimer = Math.max(0, this.hitstopTimer - dt)
      scale = Math.min(scale, this.hitstopScale)
    }
    if (this.slowMoTimer > 0) {
      this.slowMoTimer = Math.max(0, this.slowMoTimer - dt)
      scale = Math.min(scale, this.slowMoScale)
    }
    this.timeScale = scale
    if (this.collapseRumble > 0) {
      this.collapseRumble = Math.max(0, this.collapseRumble - dt)
      this.rig.addShake(dt * 0.55 * this.collapseRumble)
    }
    void this.phys
  }

  /** Called by the game each frame to sync profiler counters. */
  syncStats(): void {
    this.profiler.carvedVoxels += 0
  }

  reset(): void {
    this.touched.clear()
    this.carveOut.length = 0
    this.buildingsTorn = 0
    this.collapseCount = 0
    this.carvedVoxels = 0
    this.collapseRumble = 0
    this.hitstopTimer = 0
    this.slowMoTimer = 0
    this.timeScale = 1
  }

  get rumble(): number {
    return this.collapseRumble
  }
}
