import * as THREE from 'three'
import { createFxMaterial } from '../render/pipeline'

/**
 * Additive FX pools for abilities: energy beams, expanding shockwave rings and
 * impact flashes. Preallocated meshes, toggled by lifetime — no allocation in
 * the firing path.
 */

interface Beam {
  mesh: THREE.Mesh
  material: THREE.MeshBasicMaterial
  life: number
  max: number
}

interface Ring {
  mesh: THREE.Mesh
  material: THREE.MeshBasicMaterial
  life: number
  max: number
  radius: number
  y: number
}

interface Blast {
  mesh: THREE.Mesh
  material: THREE.MeshBasicMaterial
  life: number
  max: number
  radius: number
}

const UP = new THREE.Vector3(0, 1, 0)

export class AbilityFx {
  readonly group = new THREE.Group()
  private readonly beams: Beam[] = []
  private readonly rings: Ring[] = []
  private readonly blasts: Blast[] = []
  private readonly q = new THREE.Quaternion()
  private readonly dir = new THREE.Vector3()

  constructor(beamCap = 10, ringCap = 8) {
    const beamGeo = new THREE.CylinderGeometry(1, 1, 1, 8, 1, true)
    beamGeo.translate(0, 0.5, 0) // pivot at the base
    for (let i = 0; i < beamCap; i++) {
      const material = createFxMaterial(0x8ff6ff, 0.85)
      const mesh = new THREE.Mesh(beamGeo, material)
      mesh.visible = false
      mesh.frustumCulled = false
      this.group.add(mesh)
      this.beams.push({ mesh, material, life: 0, max: 1 })
    }
    const ringGeo = new THREE.RingGeometry(0.82, 1, 28)
    ringGeo.rotateX(-Math.PI / 2)
    for (let i = 0; i < ringCap; i++) {
      const material = createFxMaterial(0xfff2c4, 0.7)
      const mesh = new THREE.Mesh(ringGeo, material)
      mesh.visible = false
      mesh.frustumCulled = false
      this.group.add(mesh)
      this.rings.push({ mesh, material, life: 0, max: 1, radius: 1, y: 0 })
    }
    // Expanding additive spheres: the core of every explosion. A ring alone
    // reads as a decal on the floor; the blob is what sells "something went off".
    const blastGeo = new THREE.SphereGeometry(1, 16, 12)
    for (let i = 0; i < 6; i++) {
      const material = createFxMaterial(0xffffff, 0.85)
      const mesh = new THREE.Mesh(blastGeo, material)
      mesh.visible = false
      mesh.frustumCulled = false
      this.group.add(mesh)
      this.blasts.push({ mesh, material, life: 0, max: 1, radius: 1 })
    }
  }

  /** Straight energy beam from a point along a direction. */
  beam(
    x: number,
    y: number,
    z: number,
    dx: number,
    dy: number,
    dz: number,
    length: number,
    radius: number,
    color: number,
    life = 0.14,
  ): void {
    const slot = this.beams.find((b) => b.life <= 0) ?? this.beams[0]
    if (!slot) return
    this.dir.set(dx, dy, dz).normalize()
    this.q.setFromUnitVectors(UP, this.dir)
    slot.mesh.position.set(x, y, z)
    slot.mesh.quaternion.copy(this.q)
    slot.mesh.scale.set(radius, length, radius)
    slot.mesh.visible = true
    slot.material.color.setHex(color)
    slot.material.opacity = 0.9
    slot.life = life
    slot.max = life
  }

  /** Expanding ground ring (shockwaves, pounds, claps). */
  ring(x: number, y: number, z: number, radius: number, color: number, life = 0.45): void {
    const slot = this.rings.find((r) => r.life <= 0) ?? this.rings[0]
    if (!slot) return
    slot.mesh.position.set(x, Math.max(0.12, y), z)
    slot.mesh.scale.setScalar(Math.max(0.5, radius * 0.25))
    slot.mesh.visible = true
    slot.material.color.setHex(color)
    slot.material.opacity = 0.8
    slot.life = life
    slot.max = life
    slot.radius = radius
    slot.y = y
  }

  /** Cheap radial flash (no geometry churn). */
  flash(x: number, y: number, z: number, radius: number, color: number): void {
    this.ring(x, y, z, radius * 2, color, 0.18)
  }

  /** Expanding fireball. The core of an explosion, supers included. */
  blast(x: number, y: number, z: number, radius: number, color: number, life = 0.36): void {
    const slot = this.blasts.find((b) => b.life <= 0) ?? this.blasts[0]
    if (!slot) return
    slot.mesh.position.set(x, y, z)
    slot.mesh.scale.setScalar(Math.max(0.3, radius * 0.3))
    slot.mesh.visible = true
    slot.material.color.setHex(color)
    slot.material.opacity = 0.9
    slot.life = life
    slot.max = life
    slot.radius = radius
  }

  update(dt: number): void {
    for (const b of this.beams) {
      if (b.life <= 0) continue
      b.life -= dt
      const t = Math.max(0, b.life / b.max)
      if (b.life <= 0) {
        b.mesh.visible = false
        continue
      }
      b.material.opacity = t * 0.9
      const grow = 1 + (1 - t) * 0.25
      b.mesh.scale.x = b.mesh.scale.x * 0.7 + b.mesh.scale.x * 0.3 * grow
      b.mesh.scale.z = b.mesh.scale.x
    }
    for (const r of this.rings) {
      if (r.life <= 0) continue
      r.life -= dt
      if (r.life <= 0) {
        r.mesh.visible = false
        continue
      }
      const t = r.life / r.max
      const s = r.radius * (1.2 - t * 0.9)
      r.mesh.scale.set(s, 1, s)
      r.material.opacity = t * 0.8
    }
    for (const b of this.blasts) {
      if (b.life <= 0) continue
      b.life -= dt
      if (b.life <= 0) {
        b.mesh.visible = false
        continue
      }
      const t = b.life / b.max
      // Expand as it fades: the shell grows outward and thins out.
      b.mesh.scale.setScalar(b.radius * (0.34 + (1 - t) * 0.85))
      b.material.opacity = t * t * 0.95
    }
  }

  clear(): void {
    for (const b of this.beams) {
      b.life = 0
      b.mesh.visible = false
    }
    for (const r of this.rings) {
      r.life = 0
      r.mesh.visible = false
    }
    for (const b of this.blasts) {
      b.life = 0
      b.mesh.visible = false
    }
  }
}
