import * as THREE from 'three'
import type { PhysWorld } from '../physics/phys'
import type { MaterialLibrary } from '../render/materials'
import { clamp } from '../core/util'

/**
 * Debris + dust.
 *
 * Both are pooled instanced/point systems with fixed capacity and zero
 * per-frame allocation, driven by plain Float32Arrays. Debris falls asleep once
 * it settles so a fully demolished block costs almost nothing after the fact.
 */

const DEBRIS_CAP = 900
const DUST_CAP = 2400

export class DebrisSystem {
  readonly mesh: THREE.InstancedMesh
  private readonly px = new Float32Array(DEBRIS_CAP)
  private readonly py = new Float32Array(DEBRIS_CAP)
  private readonly pz = new Float32Array(DEBRIS_CAP)
  private readonly vx = new Float32Array(DEBRIS_CAP)
  private readonly vy = new Float32Array(DEBRIS_CAP)
  private readonly vz = new Float32Array(DEBRIS_CAP)
  private readonly sx = new Float32Array(DEBRIS_CAP)
  private readonly sy = new Float32Array(DEBRIS_CAP)
  private readonly sz = new Float32Array(DEBRIS_CAP)
  private readonly rot = new Float32Array(DEBRIS_CAP * 3)
  private readonly spin = new Float32Array(DEBRIS_CAP * 3)
  private readonly sleep = new Uint8Array(DEBRIS_CAP)
  /** Seconds spent at rest, so a settled chunk sleeps instead of burning a slot. */
  private readonly rest = new Float32Array(DEBRIS_CAP)
  private count = 0
  private readonly dummy = new THREE.Object3D()
  private readonly n = new Float32Array(3)
  private readonly color = new THREE.Color()
  private readonly geo: THREE.BoxGeometry

  constructor(mats: MaterialLibrary) {
    this.geo = new THREE.BoxGeometry(1, 1, 1)
    // Per-instance UV scaling: debris is scaled boxes, so the concrete texture
    // would otherwise stretch. Bake a moderate tiling in the geometry.
    const uv = this.geo.getAttribute('uv') as THREE.BufferAttribute
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 0.6, uv.getY(i) * 0.6)
    this.mesh = new THREE.InstancedMesh(this.geo, mats.debris, DEBRIS_CAP)
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.mesh.castShadow = true
    this.mesh.receiveShadow = false
    this.mesh.frustumCulled = false
    this.mesh.count = 0
    this.mesh.setColorAt(0, this.color.setRGB(1, 1, 1))
    // Hide unused instances far away instead of paying for culling.
    for (let i = 0; i < DEBRIS_CAP; i++) {
      this.dummy.position.set(0, -1000, 0)
      this.dummy.scale.setScalar(0.001)
      this.dummy.updateMatrix()
      this.mesh.setMatrixAt(i, this.dummy.matrix)
    }
    this.mesh.instanceMatrix.needsUpdate = true
  }

  get active(): number {
    let n = 0
    for (let i = 0; i < this.count; i++) if (!this.sleep[i]) n++
    return n
  }

  get total(): number {
    return this.count
  }

  spawn(
    x: number,
    y: number,
    z: number,
    size: number,
    vx: number,
    vy: number,
    vz: number,
    tint: number,
  ): void {
    let i = this.count
    if (i >= DEBRIS_CAP) {
      // Recycle the oldest settled chunk to keep the pool bounded.
      let found = -1
      for (let k = 0; k < DEBRIS_CAP; k++) {
        if (this.sleep[k]) {
          found = k
          break
        }
      }
      if (found < 0) return
      i = found
    } else {
      this.count++
    }
    const jitter = 0.78 + Math.random() * 0.5
    this.px[i] = x + (Math.random() - 0.5) * size * 0.5
    this.py[i] = y + (Math.random() - 0.5) * size * 0.5
    this.pz[i] = z + (Math.random() - 0.5) * size * 0.5
    this.vx[i] = vx + (Math.random() - 0.5) * 6
    this.vy[i] = vy + Math.random() * 5
    this.vz[i] = vz + (Math.random() - 0.5) * 6
    this.sx[i] = size * jitter
    this.sy[i] = size * (0.6 + Math.random() * 0.5)
    this.sz[i] = size * jitter
    this.rot[i * 3] = Math.random() * 3
    this.rot[i * 3 + 1] = Math.random() * 3
    this.rot[i * 3 + 2] = Math.random() * 3
    this.spin[i * 3] = (Math.random() - 0.5) * 4
    this.spin[i * 3 + 1] = (Math.random() - 0.5) * 4
    this.spin[i * 3 + 2] = (Math.random() - 0.5) * 4
    this.sleep[i] = 0
    this.rest[i] = 0
    const c = 0.72 + tint * 0.28
    this.mesh.setColorAt(i, this.color.setRGB(c, c * 0.99, c * 0.96))
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true
  }

  update(dt: number, phys: PhysWorld): void {
    const dummy = this.dummy
    let activeCount = 0
    for (let i = 0; i < this.count; i++) {
      if (!this.sleep[i]) {
        activeCount++
        let supported = false
        this.vy[i] -= 24 * dt
        const nx = this.px[i] + this.vx[i] * dt
        const ny = this.py[i] + this.vy[i] * dt
        const nz = this.pz[i] + this.vz[i] * dt
        const half = Math.max(this.sx[i], this.sy[i], this.sz[i]) * 0.5
        // Ground plane.
        if (ny <= half) {
          this.py[i] = half
          if (Math.abs(this.vy[i]) < 3.2) {
            this.vy[i] = 0
            this.vx[i] *= 0.6
            this.vz[i] *= 0.6
            this.spin[i * 3] *= 0.5
            this.spin[i * 3 + 1] *= 0.5
            this.spin[i * 3 + 2] *= 0.5
          } else {
            this.vy[i] = -this.vy[i] * 0.28
            this.vx[i] *= 0.7
            this.vz[i] *= 0.7
          }
          supported = true
        } else {
          this.px[i] = nx
          this.py[i] = ny
          this.pz[i] = nz
          // Building contact. This used to call distance(), which clamps with the
          // ground height, so it never actually saw a building — rubble passed
          // straight through them — while a slab low over the street registered as
          // "inside concrete" and got an upward nudge every frame, which is what
          // left blocks hovering in mid-air instead of landing.
          const cd = phys.concreteDistance(this.px[i], this.py[i], this.pz[i])
          if (cd < half * 0.9 && phys.concreteNormal(this.px[i], this.py[i], this.pz[i], this.n)) {
            // Slide out along the surface normal so it rolls off and keeps falling.
            const push = half * 0.9 - cd
            this.px[i] += this.n[0] * push
            this.py[i] += this.n[1] * push
            this.pz[i] += this.n[2] * push
            const vn = this.vx[i] * this.n[0] + this.vy[i] * this.n[1] + this.vz[i] * this.n[2]
            if (vn < 0) {
              this.vx[i] -= vn * this.n[0]
              this.vy[i] -= vn * this.n[1]
              this.vz[i] -= vn * this.n[2]
            }
            this.vx[i] *= 0.88
            this.vz[i] *= 0.88
            supported = true
          }
        }
        this.rot[i * 3] += this.spin[i * 3] * dt
        this.rot[i * 3 + 1] += this.spin[i * 3 + 1] * dt
        this.rot[i * 3 + 2] += this.spin[i * 3 + 2] * dt
        const speed = Math.abs(this.vx[i]) + Math.abs(this.vy[i]) + Math.abs(this.vz[i])
        // Settled means "supported by the street or by rubble/a rooftop", not
        // strictly "on the ground plane" — otherwise debris resting on the
        // surviving lower floors never sleeps and burns an active slot for ever.
        if (speed < 0.35 && supported) {
          this.rest[i] += dt
          if (this.rest[i] > 0.4) this.sleep[i] = 1
        } else {
          this.rest[i] = 0
        }
      }
      dummy.position.set(this.px[i], this.py[i], this.pz[i])
      dummy.rotation.set(this.rot[i * 3], this.rot[i * 3 + 1], this.rot[i * 3 + 2])
      dummy.scale.set(this.sx[i], this.sy[i], this.sz[i])
      dummy.updateMatrix()
      this.mesh.setMatrixAt(i, dummy.matrix)
    }
    this.mesh.count = this.count
    if (this.count > 0) this.mesh.instanceMatrix.needsUpdate = true
    this.activeCount = activeCount
  }

  activeCount = 0

  get sleeping(): number {
    return this.count - this.activeCount
  }

  clear(): void {
    this.count = 0
    this.mesh.count = 0
  }
}

export class DustSystem {
  readonly points: THREE.Points
  private readonly pos: Float32Array
  private readonly vel: Float32Array
  private readonly size: Float32Array
  private readonly alpha: Float32Array
  private readonly life: Float32Array
  private readonly maxLife: Float32Array
  private readonly col: Float32Array
  private cursor = 0
  private readonly geo: THREE.BufferGeometry

  constructor(mats: MaterialLibrary) {
    this.pos = new Float32Array(DUST_CAP * 3)
    this.vel = new Float32Array(DUST_CAP * 3)
    this.size = new Float32Array(DUST_CAP)
    this.alpha = new Float32Array(DUST_CAP)
    this.life = new Float32Array(DUST_CAP)
    this.maxLife = new Float32Array(DUST_CAP)
    this.col = new Float32Array(DUST_CAP * 3)
    this.geo = new THREE.BufferGeometry()
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3))
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1))
    this.geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1))
    this.geo.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3))
    this.points = new THREE.Points(this.geo, mats.dust)
    this.points.frustumCulled = false
    this.geo.setDrawRange(0, DUST_CAP)
  }

  spawn(x: number, y: number, z: number, count: number, radius: number, speed: number, warm: number): void {
    for (let i = 0; i < count; i++) {
      const idx = this.cursor
      this.cursor = (this.cursor + 1) % DUST_CAP
      const a = Math.random() * Math.PI * 2
      const p = Math.random()
      const r = radius * Math.sqrt(p)
      this.pos[idx * 3] = x + Math.cos(a) * r
      this.pos[idx * 3 + 1] = y + (Math.random() - 0.2) * radius * 0.8
      this.pos[idx * 3 + 2] = z + Math.sin(a) * r
      this.vel[idx * 3] = Math.cos(a) * speed * (0.4 + Math.random() * 0.8)
      this.vel[idx * 3 + 1] = speed * (0.25 + Math.random() * 0.75)
      this.vel[idx * 3 + 2] = Math.sin(a) * speed * (0.4 + Math.random() * 0.8)
      const s = 0.9 + Math.random() * 2.1
      this.size[idx] = s
      const life = 1.4 + Math.random() * 2.6
      this.life[idx] = life
      this.maxLife[idx] = life
      this.alpha[idx] = 0.42
      // Concrete-grey dust, slightly warmer for scorched impacts.
      const k = 0.62 + Math.random() * 0.3
      this.col[idx * 3] = k * (1 - warm * 0.08)
      this.col[idx * 3 + 1] = k * (1 - warm * 0.14)
      this.col[idx * 3 + 2] = k * (1 - warm * 0.24)
    }
    ;(this.geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true
    ;(this.geo.getAttribute('aSize') as THREE.BufferAttribute).needsUpdate = true
    ;(this.geo.getAttribute('aColor') as THREE.BufferAttribute).needsUpdate = true
  }

  update(dt: number): void {
    let alive = 0
    for (let i = 0; i < DUST_CAP; i++) {
      if (this.life[i] <= 0) {
        this.alpha[i] = 0
        continue
      }
      alive++
      this.life[i] -= dt
      const t = clamp(this.life[i] / Math.max(0.001, this.maxLife[i]), 0, 1)
      this.alpha[i] = t * 0.45
      this.size[i] += dt * 1.5
      this.vel[i * 3] *= 1 - Math.min(0.6, dt * 1.1)
      this.vel[i * 3 + 2] *= 1 - Math.min(0.6, dt * 1.1)
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * (1 - Math.min(0.7, dt * 0.9)) + dt * 1.4
      this.pos[i * 3] += this.vel[i * 3] * dt
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt
    }
    this.alive = alive
    ;(this.geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true
    ;(this.geo.getAttribute('aAlpha') as THREE.BufferAttribute).needsUpdate = true
  }

  alive = 0

  clear(): void {
    this.life.fill(0)
    this.alpha.fill(0)
  }
}

/**
 * Hit sparks. Additive points that fly from the point of contact, fall under
 * gravity and fade fast. This is the single cheapest way to make a landed hit
 * *read* — a punch that connects should look like it connected.
 *
 * Separate from DustSystem because sparks are additive and short-lived while
 * dust is soft, opaque and slow.
 */
export class SparkSystem {
  readonly points: THREE.Points
  private readonly pos: Float32Array
  private readonly vel: Float32Array
  private readonly size: Float32Array
  private readonly alpha: Float32Array
  private readonly life: Float32Array
  private readonly maxLife: Float32Array
  private readonly col: Float32Array
  private readonly drag: Float32Array
  private cursor = 0
  private readonly geo: THREE.BufferGeometry
  alive = 0

  constructor(map: THREE.Texture, cap = 1400) {
    this.pos = new Float32Array(cap * 3)
    this.vel = new Float32Array(cap * 3)
    this.size = new Float32Array(cap)
    this.alpha = new Float32Array(cap)
    this.life = new Float32Array(cap)
    this.maxLife = new Float32Array(cap)
    this.col = new Float32Array(cap * 3)
    this.drag = new Float32Array(cap)
    this.geo = new THREE.BufferGeometry()
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3))
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1))
    this.geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1))
    this.geo.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3))
    const mat = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: map }, uPixelScale: { value: 700 } },
      vertexShader: /* glsl */ `
        uniform float uPixelScale;
        attribute float aSize;
        attribute float aAlpha;
        attribute vec3 aColor;
        varying float vAlpha;
        varying vec3 vColor;
        void main() {
          vAlpha = aAlpha;
          vColor = aColor;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = aSize * (uPixelScale / max(0.5, -mv.z));
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMap;
        varying float vAlpha;
        varying vec3 vColor;
        void main() {
          vec4 t = texture2D(uMap, gl_PointCoord);
          float a = t.a * vAlpha;
          if (a < 0.01) discard;
          gl_FragColor = vec4(vColor * a * 1.6, a);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    this.points = new THREE.Points(this.geo, mat)
    this.points.frustumCulled = false
    this.geo.setDrawRange(0, cap)
  }

  get material(): THREE.ShaderMaterial {
    return this.points.material as THREE.ShaderMaterial
  }

  /**
   * Burst of sparks at a contact point along a bias direction (the hit normal).
   * `heat` blends the colour from hero-tinted (0) to white-hot (1).
   */
  burst(
    x: number,
    y: number,
    z: number,
    count: number,
    speed: number,
    color: number,
    heat = 0,
    spread = 1,
  ): void {
    const cap = this.size.length
    const r = ((color >> 16) & 0xff) / 255
    const g = ((color >> 8) & 0xff) / 255
    const b = (color & 0xff) / 255
    for (let i = 0; i < count; i++) {
      const idx = this.cursor
      this.cursor = (this.cursor + 1) % cap
      this.pos[idx * 3] = x
      this.pos[idx * 3 + 1] = y
      this.pos[idx * 3 + 2] = z
      // Bias upward and outward so a burst always silhouettes against the hit.
      const a = Math.random() * Math.PI * 2
      const el = Math.random() * 0.9 + 0.05
      const sp = speed * (0.35 + Math.random() * 0.9)
      this.vel[idx * 3] = Math.cos(a) * sp * spread
      this.vel[idx * 3 + 1] = el * sp
      this.vel[idx * 3 + 2] = Math.sin(a) * sp * spread
      const life = 0.22 + Math.random() * 0.36
      this.life[idx] = life
      this.maxLife[idx] = life
      this.alpha[idx] = 0.9
      this.size[idx] = 0.10 + Math.random() * 0.18
      this.drag[idx] = 2.2 + Math.random() * 2.5
      const k = heat * 0.7
      this.col[idx * 3] = r + (1 - r) * k
      this.col[idx * 3 + 1] = g + (1 - g) * k * 0.7
      this.col[idx * 3 + 2] = b + (1 - b) * k * 0.5
    }
    this.dirty()
  }

  private dirty(): void {
    ;(this.geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true
    ;(this.geo.getAttribute('aSize') as THREE.BufferAttribute).needsUpdate = true
    ;(this.geo.getAttribute('aColor') as THREE.BufferAttribute).needsUpdate = true
  }

  update(dt: number): void {
    let alive = 0
    const cap = this.size.length
    for (let i = 0; i < cap; i++) {
      if (this.life[i] <= 0) {
        this.alpha[i] = 0
        continue
      }
      alive++
      this.life[i] -= dt
      const t = clamp(this.life[i] / Math.max(0.001, this.maxLife[i]), 0, 1)
      this.alpha[i] = t * t * 0.95
      const damp = 1 - Math.min(0.9, this.drag[i] * dt)
      this.vel[i * 3] *= damp
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * damp - 16 * dt
      this.vel[i * 3 + 2] *= damp
      this.pos[i * 3] += this.vel[i * 3] * dt
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt
      if (this.pos[i * 3 + 1] < 0.05) this.pos[i * 3 + 1] = 0.05
    }
    this.alive = alive
    ;(this.geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true
    ;(this.geo.getAttribute('aAlpha') as THREE.BufferAttribute).needsUpdate = true
  }

  clear(): void {
    this.life.fill(0)
    this.alpha.fill(0)
    this.alive = 0
  }
}

/**
 * Scorch/crater decals. A single instanced quad pool lying flat on the street,
 * stamped whenever something big hits the ground. Cheap aftermath storytelling.
 */
export class ScorchSystem {
  readonly mesh: THREE.InstancedMesh
  private cursor = 0
  private readonly dummy = new THREE.Object3D()
  private readonly life = new Float32Array(96)
  private readonly maxLife = new Float32Array(96)
  private readonly fade = new Float32Array(96)
  private readonly baseY = new Float32Array(96)

  constructor(map: THREE.Texture, cap = 96) {
    const geo = new THREE.PlaneGeometry(1, 1)
    const mat = new THREE.MeshBasicMaterial({
      map,
      transparent: true,
      depthWrite: false,
      opacity: 1,
      color: 0x2a2622,
      polygonOffset: true,
      polygonOffsetFactor: -2,
    })
    this.mesh = new THREE.InstancedMesh(geo, mat, cap)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 1
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.mesh.count = 0
    this.dummy.rotation.x = -Math.PI / 2
    for (let i = 0; i < cap; i++) {
      this.dummy.position.set(0, -1000, 0)
      this.dummy.scale.setScalar(0.001)
      this.dummy.updateMatrix()
      this.mesh.setMatrixAt(i, this.dummy.matrix)
      this.life[i] = 0
    }
    this.mesh.instanceMatrix.needsUpdate = true
  }

  stamp(x: number, z: number, size: number, lifeSeconds = 14): void {
    const i = this.cursor
    this.cursor = (this.cursor + 1) % (this.life.length || 96)
    this.baseY[i] = 0.035 + (i % 7) * 0.004
    this.dummy.position.set(x, this.baseY[i], z)
    this.dummy.rotation.set(-Math.PI / 2, 0, Math.random() * Math.PI * 2)
    this.dummy.scale.set(size, size, 1)
    this.dummy.updateMatrix()
    this.mesh.setMatrixAt(i, this.dummy.matrix)
    this.mesh.instanceMatrix.needsUpdate = true
    this.life[i] = lifeSeconds
    this.maxLife[i] = lifeSeconds
    this.mesh.count = Math.max(this.mesh.count, i + 1)
  }

  update(dt: number): void {
    const n = this.mesh.count
    let changed = false
    for (let i = 0; i < n; i++) {
      if (this.life[i] <= 0) continue
      this.life[i] -= dt
      this.fade[i] = Math.min(1, this.life[i] / Math.max(0.001, this.maxLife[i] * 0.5))
      changed = true
    }
    void changed
  }
}
