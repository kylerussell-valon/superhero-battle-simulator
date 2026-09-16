import * as THREE from 'three'

/**
 * Floating combat text.
 *
 * Damage numbers are the cheapest readability win in an action game: they say
 * *how hard* a hit landed and *which* hit landed, which health bars alone
 * cannot. Plain DOM, projected from world space each frame — no canvas text, no
 * GPU pass, and it costs nothing until a number exists.
 */

interface Floater {
  el: HTMLElement
  x: number
  y: number
  z: number
  vx: number
  vy: number
  life: number
  max: number
}

export interface FloaterOptions {
  color?: string
  /** Big-number treatment for supers, heavy blows and KOs. */
  crit?: boolean
  /** Extra scale multiplier. */
  scale?: number
}

export class Floaters {
  readonly root: HTMLElement
  private readonly pool: Floater[] = []
  private readonly active: Floater[] = []
  private readonly tmp = new THREE.Vector3()

  constructor(private readonly camera: THREE.Camera, cap = 32) {
    this.root = document.createElement('div')
    this.root.style.cssText =
      'position:fixed;inset:0;pointer-events:none;z-index:12;overflow:hidden;' +
      'font-family:ui-monospace,Menlo,monospace;'
    for (let i = 0; i < cap; i++) {
      const el = document.createElement('div')
      el.style.cssText =
        'position:absolute;left:0;top:0;font-weight:700;letter-spacing:0.04em;' +
        'white-space:nowrap;will-change:transform,opacity;opacity:0;'
      this.root.appendChild(el)
      this.pool.push({ el, x: 0, y: 0, z: 0, vx: 0, vy: 0, life: 0, max: 1 })
    }
  }

  /** World-space anchor; the number drifts up and fades. */
  spawn(x: number, y: number, z: number, text: string, opts: FloaterOptions = {}): void {
    const f = this.pool.pop() ?? this.active.shift()
    if (!f) return
    const crit = opts.crit ?? false
    const scale = opts.scale ?? 1
    f.x = x + (Math.random() - 0.5) * 0.5
    f.y = y
    f.z = z + (Math.random() - 0.5) * 0.5
    f.vx = (Math.random() - 0.5) * 2.2
    f.vy = crit ? 4.4 : 3.2
    f.life = crit ? 1.0 : 0.8
    f.max = f.life
    const el = f.el
    el.textContent = text
    el.style.color = opts.color ?? '#ffe9a8'
    el.style.fontSize = `${(crit ? 26 : 17) * scale}px`
    el.style.textShadow = crit
      ? '0 2px 0 #6a2a00, 0 0 14px rgba(255,180,60,0.9), 0 0 30px rgba(255,120,40,0.55)'
      : '0 2px 0 rgba(0,0,0,0.85), 0 0 8px rgba(0,0,0,0.6)'
    this.active.push(f)
  }

  update(dt: number): void {
    const w = this.root.clientWidth || window.innerWidth
    const h = this.root.clientHeight || window.innerHeight
    for (let i = this.active.length - 1; i >= 0; i--) {
      const f = this.active[i]
      f.life -= dt
      if (f.life <= 0) {
        f.el.style.opacity = '0'
        this.active.splice(i, 1)
        this.pool.push(f)
        continue
      }
      // Rise and slow to a halt, so the number settles where the eye can read it.
      f.y += f.vy * dt
      f.vy *= 1 - Math.min(0.9, dt * 3.2)
      f.x += f.vx * dt
      f.vx *= 1 - Math.min(0.9, dt * 3.0)

      this.tmp.set(f.x, f.y, f.z).project(this.camera)
      if (this.tmp.z > 1) {
        f.el.style.opacity = '0'
        continue
      }
      const sx = (this.tmp.x * 0.5 + 0.5) * w
      const sy = (-this.tmp.y * 0.5 + 0.5) * h
      const t = f.life / f.max
      // Pop in fast, hold, then fade and slightly sink.
      const intro = Math.min(1, (f.max - f.life) / 0.08)
      const alpha = t > 0.6 ? 1 : Math.max(0, t / 0.6)
      const pop = 0.6 + 0.4 * intro
      f.el.style.opacity = String(alpha)
      f.el.style.transform = `translate3d(${sx.toFixed(1)}px, ${sy.toFixed(1)}px, 0) translate(-50%,-50%) scale(${pop.toFixed(3)})`
    }
  }

  clear(): void {
    for (const f of this.active) f.el.style.opacity = '0'
    this.pool.push(...this.active)
    this.active.length = 0
  }
}
