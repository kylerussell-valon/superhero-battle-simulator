import * as THREE from 'three'
import type { City } from '../world/city'
import { clamp, lerp } from '../core/util'

/**
 * Peak camera trauma. 1.0 maps to SHAKE_OFFSET_M metres of jitter, which is
 * already a lot — the old cap of 1.6 put nearly a metre of translation and 18
 * degrees of roll on the frame.
 */
const SHAKE_MAX = 1.0
/** Metres of camera translation at trauma 1.0 (scaled by trauma squared). */
const SHAKE_OFFSET_M = 0.22
/** Camera roll per metre of horizontal jitter. */
const SHAKE_ROLL = 0.12

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

  /**
   * Vertical look direction. `true` pushes the view *up* when the mouse moves up,
   * which is the usual convention; flip it for flight-sim style.
   */
  lookUpOnMouseUp = true
  /** Radians of look per pixel of mouse movement. */
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
    // Take the stronger of the two rather than summing. A sustained source — heat
    // vision firing, a building coming down — calls this every frame, and summing
    // pinned the camera at maximum shake for as long as it lasted.
    this.shake = Math.min(SHAKE_MAX, Math.max(this.shake, amount) + amount * 0.15)
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
      // March the boom; stop short if a facade gets in the way. If the boom is
      // badly blocked, try again from a raised pivot so the camera can look over
      // the obstruction instead of being jammed into the player's back. Keep the
      // attempt that gets furthest out — if every option is blocked, the least
      // crushed one still beats a 1.4 m clamp.
      const steps = 6
      let bestDist = -1
      let bestPivot = this.target.y
      for (let attempt = 0; attempt < 3; attempt++) {
        const pivotY = this.target.y + attempt * 2.6
        let d = this.distance
        let blocked = false
        for (let s = 1; s <= steps; s++) {
          const t = (s / steps) * this.distance
          const sx = this.target.x + dirX * t
          const sy = pivotY + dirY * t
          const sz = this.target.z + dirZ * t
          const near = Math.min(city.queryNearest(sx, sy, sz), sy)
          if (near < 0.7) {
            d = Math.max(1.4, t - 0.8)
            blocked = true
            break
          }
        }
        if (d > bestDist) {
          bestDist = d
          bestPivot = pivotY
        }
        if (!blocked) break
      }
      dist = bestDist
      this.tmp.set(this.target.x + dirX * dist, bestPivot + dirY * dist, this.target.z + dirZ * dist)
    } else {
      this.tmp.set(this.target.x + dirX * dist, this.target.y + dirY * dist, this.target.z + dirZ * dist)
    }

    let sx = 0
    let sy = 0
    if (this.shake > 0.0005) {
      this.shakeSeed += dt * 34
      // Trauma-squared falloff: small hits barely register, big ones thump once.
      const s = this.shake * this.shake * SHAKE_OFFSET_M
      sx = Math.sin(this.shakeSeed * 1.7) * s
      sy = Math.sin(this.shakeSeed * 2.3 + 1.1) * s
      this.shake = Math.max(0, this.shake - dt * 1.7)
    }

    camera.position.copy(this.tmp)
    camera.position.x += sx
    camera.position.y += sy
    camera.position.z += sx * 0.5
    camera.lookAt(this.target.x + sx * 0.4, this.target.y + sy * 0.4, this.target.z)
    // A touch of roll sells the impact; a lot of it is nauseating.
    camera.rotation.z += sx * SHAKE_ROLL
  }

  /** Screen-space look input (already frame-rate scaled). */
  look(dx: number, dy: number): void {
    this.yaw -= dx * this.sense
    // +pitch puts the camera above the target, i.e. looking down. So "mouse up
    // looks up" means pitch must *decrease* as dy goes negative.
    const dp = this.lookUpOnMouseUp ? dy : -dy
    this.pitch = clamp(this.pitch + dp * this.sense, -1.35, 1.05)
  }

  zoom(delta: number): void {
    this.targetDistance = clamp(this.targetDistance * (1 + delta * 0.0016), 3.2, 34)
  }
}
