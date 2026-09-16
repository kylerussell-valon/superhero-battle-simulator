/**
 * Small, allocation-free math helpers + deterministic RNG.
 *
 * Perf note (Apple Silicon): hot paths in this project avoid object allocation
 * entirely — see docs/PERFORMANCE.md. Everything here is inlined-friendly
 * scalar math on numbers, not vectors.
 */

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t
export const invLerp = (a: number, b: number, v: number): number => (b === a ? 0 : (v - a) / (b - a))

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp(invLerp(edge0, edge1, x), 0, 1)
  return t * t * (3 - 2 * t)
}

/** GLSL-style mod (always positive for positive modulus). */
export function mod(x: number, m: number): number {
  return x - m * Math.floor(x / m)
}

/** Distance to a repeating band of half-width `half`, period `p`, origin `o`. */
export function bandDistance(v: number, o: number, p: number, half: number): number {
  return Math.abs(mod(v - o, p) - p * 0.5) - half
}

export function hypot3(x: number, y: number, z: number): number {
  return Math.sqrt(x * x + y * y + z * z)
}

/** Deterministic PRNG (mulberry32) — same city on every machine/session. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function rand(): number {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Fixed-array ring buffer for frame timing samples (no GC churn). */
export class Ring {
  readonly data: Float32Array
  private cursor = 0
  private filled = 0
  constructor(public readonly capacity: number) {
    this.data = new Float32Array(capacity)
  }
  push(v: number): void {
    this.data[this.cursor] = v
    this.cursor = (this.cursor + 1) % this.capacity
    if (this.filled < this.capacity) this.filled++
  }
  get count(): number {
    return this.filled
  }
  get last(): number {
    return this.data[(this.cursor - 1 + this.capacity) % this.capacity]
  }
  /** Percentile in [0,1]. 1 = max. Cheap copy-free approach for debug HUD only. */
  percentile(p: number): number {
    if (this.filled === 0) return 0
    const n = this.filled
    let max = 0
    for (let i = 0; i < n; i++) max = Math.max(max, this.data[i])
    // 32-bucket histogram over [0, max] — plenty accurate for a HUD.
    const buckets = new Uint16Array(32)
    const scale = max > 0 ? 31 / max : 0
    for (let i = 0; i < n; i++) buckets[Math.round(this.data[i] * scale)]++
    const target = Math.max(1, Math.round(p * n))
    let acc = 0
    for (let b = 0; b < 32; b++) {
      acc += buckets[b]
      if (acc >= target) return (b / 31) * max
    }
    return max
  }
}
