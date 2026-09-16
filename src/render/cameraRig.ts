import * as THREE from 'three'
import type { City } from '../world/city'
import { clamp, lerp } from '../core/util'

/**
 * Third-person action camera rig: orbit + spring follow + collision pull-in.
 *
 * Owns its own vectors (no per-frame allocation) and samples the city SDF along
 * the boom to avoid clipping through buildings.
 */
export class CameraRig {
  yaw = 0
  pitch = -0.18
  distance = 9
  targetDistance = 9
  readonly target = new THREE.Vector3(0, 2, 0)
  private readonly desired = new THREE.Vector3()
  private readonly tmp = new THREE.Vector3()
  private shake = 0
  private shakeSeed = Math.random() * 1000
  /** Free-fly / cinematic override used by the capture tooling. */
  freeFly = false
  readonly freePos = new THREE.Vector3()
  sense = 0.0026

  setTarget(x: number, y: number, z: number): void {
    this.desired.set(x, y, z)
    if (this.freeFly) {
      this.target.copy(this.desired)
      return
    }
    this.target.copy(this.desired)
  }

  /** Snap instantly (used when teleporting or on the first frame). */
  snap(): void {
    this.target.copy(this.desired)
    this.distance = this.targetDistance
  }

  addShake(amount: number): void {
    this.shake = Math.min(1.6, this.shake + amount)
  }

  update(dt: number, camera: THREE.PerspectiveCamera, city: City | null): void {
    // In free-fly the caller owns the camera completely (capture tooling and the
    // interactive debug camera place it directly).
    if (this.freeFly) return
    const k = 1 - Math.pow(0.0001, dt)
    this.target.lerp(this.desired, k)
    this.distance = lerp(this.distance, this.targetDistance, 1 - Math.pow(0.002, dt))

    const cp = Math.cos(this.pitch)
    const dirX = Math.sin(this.yaw) * cp
    const dirY = Math.sin(this.pitch)
    const dirZ = Math.cos(this.yaw) * cp

    let dist = this.distance
    if (city) {
      // March the boom; stop short if a facade gets in the way.
      const steps = 6
      for (let s = 1; s <= steps; s++) {
        const t = (s / steps) * dist
        const sx = this.target.x + dirX * t
        const sy = this.target.y + dirY * t
        const sz = this.target.z + dirZ * t
        const d = Math.min(city.queryNearest(sx, sy, sz), sy)
        if (d < 0.7) {
          dist = Math.max(1.4, t - 0.8)
          break
        }
      }
    }

    this.tmp.set(this.target.x + dirX * dist, this.target.y + dirY * dist, this.target.z + dirZ * dist)

    let sx = 0
    let sy = 0
    if (this.shake > 0.0005) {
      this.shakeSeed += dt * 34
      const s = this.shake * this.shake * 0.35
      sx = Math.sin(this.shakeSeed * 1.7) * s
      sy = Math.sin(this.shakeSeed * 2.3 + 1.1) * s
      this.shake = Math.max(0, this.shake - dt * 1.9)
    }

    camera.position.copy(this.tmp)
    camera.position.x += sx
    camera.position.y += sy
    camera.position.z += sx * 0.5
    camera.lookAt(this.target.x + sx * 0.4, this.target.y + sy * 0.4, this.target.z)
    camera.rotation.z += sx * 0.35
  }

  /** Screen-space look input (already frame-rate scaled). */
  look(dx: number, dy: number): void {
    this.yaw -= dx * this.sense
    this.pitch = clamp(this.pitch - dy * this.sense, -1.35, 1.05)
  }

  zoom(delta: number): void {
    this.targetDistance = clamp(this.targetDistance * (1 + delta * 0.0016), 3.2, 34)
  }
}
