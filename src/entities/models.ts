import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

/**
 * Single GLB cache. Models are cloned per instance (they are rigid-part rigs, not
 * skinned meshes, so a plain deep clone is correct and cheap) and every clone
 * shares one Lambert material so the whole cast costs a single draw call each.
 */

export interface LoadedModel {
  scene: THREE.Object3D
}

export class ModelCache {
  private readonly loader = new GLTFLoader()
  private readonly cache = new Map<string, THREE.Object3D>()
  private readonly pending = new Map<string, Promise<THREE.Object3D>>()

  load(path: string): Promise<THREE.Object3D> {
    const existing = this.cache.get(path)
    if (existing) return Promise.resolve(existing)
    const inflight = this.pending.get(path)
    if (inflight) return inflight
    const p = new Promise<THREE.Object3D>((resolve, reject) => {
      this.loader.load(
        path,
        (gltf) => {
          const root = gltf.scene
          root.traverse((o) => {
            const mesh = o as THREE.Mesh
            if ((mesh as THREE.Mesh).isMesh) {
              mesh.matrixAutoUpdate = true
            }
          })
          this.cache.set(path, root)
          this.pending.delete(path)
          resolve(root)
        },
        undefined,
        (err) => {
          this.pending.delete(path)
          reject(err)
        },
      )
    })
    this.pending.set(path, p)
    return p
  }

  /** Clone a model, swapping in a shared material. `castShadow` per mesh. */
  instantiate(path: string, material: THREE.Material, castShadow = true): THREE.Object3D {
    const src = this.cache.get(path)
    if (!src) throw new Error(`model not loaded: ${path}`)
    const clone = src.clone(true)
    clone.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (mesh.isMesh) {
        mesh.material = material
        mesh.castShadow = castShadow
        mesh.receiveShadow = false
        mesh.frustumCulled = true
      }
    })
    return clone
  }

  has(path: string): boolean {
    return this.cache.has(path)
  }
}

/**
 * Builds a name -> Object3D map for a character rig, so animation code can grab
 * joints once instead of walking the graph every frame.
 */
export function indexRig(root: THREE.Object3D, names: readonly string[]): Record<string, THREE.Object3D | undefined> {
  const out: Record<string, THREE.Object3D | undefined> = {}
  for (const n of names) out[n] = root.getObjectByName(n)
  return out
}

export const RIG_NAMES = [
  'hips',
  'torso',
  'head',
  'cape',
  'upperArmL',
  'lowerArmL',
  'handL',
  'upperArmR',
  'lowerArmR',
  'handR',
  'upperLegL',
  'lowerLegL',
  'footL',
  'upperLegR',
  'lowerLegR',
  'footR',
] as const
