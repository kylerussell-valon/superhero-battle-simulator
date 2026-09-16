import * as THREE from 'three'
import type { Blueprint, PropKind } from '../sdf/blueprint'
import type { MaterialLibrary } from '../render/materials'
import type { PhysWorld } from '../physics/phys'
import { mulberry32 } from '../core/util'

/**
 * Street furniture: one InstancedMesh per prop kind for the static city, plus a
 * small pool of individually simulated props that can be launched by shockwaves,
 * ground pounds and dashes. Only launched props cost per-frame matrix work.
 */

interface Dynamic {
  mesh: THREE.Mesh
  kind: number
  active: boolean
  vx: number
  vy: number
  vz: number
  sx: number
  sy: number
  sz: number
  rest: number
}

const KIND_ORDER: PropKind[] = ['streetlight', 'trafficlight', 'hydrant', 'tree', 'car', 'bench', 'planter', 'rubble']
const LAUNCHABLE: PropKind[] = ['car', 'hydrant', 'bench', 'planter', 'rubble']
const POOL = 24

export class PropSystem {
  readonly group = new THREE.Group()
  private readonly kinds: { kind: PropKind; geo: THREE.BufferGeometry | null; count: number; mesh: THREE.InstancedMesh | null }[] =
    []
  private readonly dynamic: Dynamic[] = []
  private readonly dummy = new THREE.Object3D()
  launched = 0

  constructor(bp: Blueprint, propsRoot: THREE.Object3D, mats: MaterialLibrary) {    const geoFor = (name: PropKind): THREE.BufferGeometry | null => {
      const found = propsRoot.getObjectByName(name) as THREE.Mesh | undefined
      return found && found.geometry ? found.geometry : null
    }
    for (const kind of KIND_ORDER) {
      this.kinds.push({ kind, geo: geoFor(kind), count: 0, mesh: null })
    }

    // Bucket instances per kind.
    const buckets = new Map<PropKind, { x: number; z: number; rot: number; scale: number }[]>()
    for (const p of bp.props) {
      if (!buckets.has(p.kind)) buckets.set(p.kind, [])
      buckets.get(p.kind)!.push({ x: p.x, z: p.z, rot: p.rot, scale: p.scale })
    }

    for (const entry of this.kinds) {
      const list = buckets.get(entry.kind)
      if (!list || list.length === 0 || !entry.geo) continue
      const mesh = new THREE.InstancedMesh(entry.geo, mats.props, list.length)
      mesh.castShadow = true
      mesh.receiveShadow = false
      mesh.frustumCulled = false
      const rnd = mulberry32(0x1234 + entry.kind.length * 97)
      for (let i = 0; i < list.length; i++) {
        const it = list[i]
        this.dummy.position.set(it.x, 0, it.z)
        this.dummy.rotation.set(0, it.rot + (rnd() - 0.5) * 0.4, 0)
        this.dummy.scale.setScalar(it.scale)
        this.dummy.updateMatrix()
        mesh.setMatrixAt(i, this.dummy.matrix)
      }
      mesh.instanceMatrix.needsUpdate = true
      mesh.userData.instances = list
      entry.mesh = mesh
      entry.count = list.length
      this.group.add(mesh)
    }

    // Dynamic prop pool: meshes are reused, geometry assigned per launch.
    for (let i = 0; i < POOL; i++) {
      const mesh = new THREE.Mesh(undefined, mats.props)
      mesh.castShadow = true
      mesh.visible = false
      mesh.matrixAutoUpdate = true
      this.group.add(mesh)
      this.dynamic.push({ mesh, kind: -1, active: false, vx: 0, vy: 0, vz: 0, sx: 0, sy: 0, sz: 0, rest: 0 })
    }
  }

  private kindIndex(kind: PropKind): number {
    return KIND_ORDER.indexOf(kind)
  }

  /**
   * Blow away any launchable prop within `radius`. Called by ground pounds,
   * shockwave claps, landings and dashes.
   */
  launchNear(x: number, y: number, z: number, radius: number, impulse: number, upBias = 0.5): number {
    let launched = 0
    for (const entry of this.kinds) {
      if (!LAUNCHABLE.includes(entry.kind) || !entry.mesh) continue
      const instances = entry.mesh.userData.instances as { x: number; z: number; rot: number; scale: number }[]
      for (let i = 0; i < instances.length; i++) {
        const it = instances[i]
        if ((it as unknown as { gone?: boolean }).gone) continue
        const dx = it.x - x
        const dz = it.z - z
        const dist = Math.hypot(dx, dz)
        if (dist > radius) continue
        const slot = this.dynamic.find((d) => !d.active)
        if (!slot) break
        ;(it as unknown as { gone?: boolean }).gone = true
        // Hide the static instance.
        this.dummy.position.set(it.x, -1000, it.z)
        this.dummy.scale.setScalar(0.001)
        this.dummy.updateMatrix()
        entry.mesh.setMatrixAt(i, this.dummy.matrix)
        entry.mesh.instanceMatrix.needsUpdate = true

        slot.active = true
        slot.kind = this.kindIndex(entry.kind)
        slot.mesh.geometry = entry.geo!
        slot.mesh.visible = true
        slot.mesh.position.set(it.x, 0.4, it.z)
        slot.mesh.rotation.set(0, it.rot, 0)
        slot.mesh.scale.setScalar(it.scale)
        const inv = 1 / Math.max(0.6, dist)
        const boost = impulse * (1 - dist / radius)
        slot.vx = dx * inv * boost
        slot.vz = dz * inv * boost
        slot.vy = boost * upBias + 2
        slot.sx = (Math.random() - 0.5) * 6
        slot.sy = (Math.random() - 0.5) * 6
        slot.sz = (Math.random() - 0.5) * 6
        slot.rest = 0
        launched++
      }
    }
    this.launched += launched
    return launched
  }

  update(dt: number, phys: PhysWorld): void {
    let active = 0
    for (const d of this.dynamic) {
      if (!d.active) continue
      active++
      d.vy -= 26 * dt
      const px = d.mesh.position.x
      const py = d.mesh.position.y
      const pz = d.mesh.position.z
      let nx = px + d.vx * dt
      let ny = py + d.vy * dt
      let nz = pz + d.vz * dt
      d.mesh.rotation.x += d.sx * dt
      d.mesh.rotation.y += d.sy * dt
      d.mesh.rotation.z += d.sz * dt

      if (ny < 0.3) {
        ny = 0.3
        if (Math.abs(d.vy) < 4) {
          d.vy = 0
          d.vx *= 0.55
          d.vz *= 0.55
          d.sx *= 0.6
          d.sy *= 0.6
          d.sz *= 0.6
        } else {
          d.vy = -d.vy * 0.3
          d.vx *= 0.7
          d.vz *= 0.7
        }
      } else if (phys.distance(nx, ny, nz) < 1.0) {
        // Bounced off a wall: drop it just outside and kill most of the momentum.
        const n = new Float32Array(3)
        phys.normal(nx, ny, nz, n)
        nx += n[0] * 0.6
        ny += n[1] * 0.6
        nz += n[2] * 0.6
        const vn = d.vx * n[0] + d.vy * n[1] + d.vz * n[2]
        d.vx -= vn * n[0] * 1.2
        d.vy -= vn * n[1] * 1.2
        d.vz -= vn * n[2] * 1.2
        d.vx *= 0.5
        d.vz *= 0.5
      }
      d.mesh.position.set(nx, ny, nz)
      const speed = Math.abs(d.vx) + Math.abs(d.vy) + Math.abs(d.vz)
      if (speed < 0.4 && ny <= 0.32) {
        d.rest += dt
        if (d.rest > 0.6) {
          d.active = false
          d.mesh.visible = false
        }
      }
    }
    this.active = active
  }

  active = 0

  get staticGroups(): number {
    return this.kinds.filter((k) => k.mesh).length
  }
}
