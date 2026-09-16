import * as THREE from 'three'
import { RIG_NAMES, indexRig } from './models'

/**
 * Rigid-part procedural animation.
 *
 * Every joint is driven by maths from the character's motion state — no clips,
 * no skinning, no animation graph. Cost per character is a dozen setRotation
 * calls, which is why a full 1:1 fight plus debris fits comfortably in budget.
 *
 * Axis convention (after Blender's Z-up -> glTF Y-up export):
 *   +X = character's right, +Y = up, +Z = forward
 *   limbs hang along -Y, so a *negative* X rotation swings a limb forward.
 */

export interface PoseInput {
  /** 0..1 how fast the character is travelling relative to its run speed. */
  speed01: number
  grounded: boolean
  flying: boolean
  verticalSpeed: number
  /** attack timeline 0..1 while attacking, -1 otherwise. */
  attack: number
  attackHeavy: boolean
  /** 0..1 hurt recoil. */
  hurt: number
  flung: boolean
  /**
   * 0..1 tumble energy while flung. Drives both amplitude and frequency of the
   * flail so the character settles as the fling expires instead of oscillating
   * at full amplitude right up to the moment it snaps upright.
   */
  flail: number
  /** Down / KO. */
  down: boolean
  /** Where the head should look (world yaw offset from the body). */
  headLook: number
  time: number
  /** Idle phase offset so two characters never breathe in sync. */
  phase: number
}

export class Rig {
  readonly parts: Record<string, THREE.Object3D | undefined>
  readonly root: THREE.Object3D
  private capeSway = 0

  constructor(model: THREE.Object3D) {
    this.root = model
    this.parts = indexRig(model, RIG_NAMES)
  }

  pose(p: PoseInput): void {
    const parts = this.parts
    const t = p.time * 6.0 + p.phase
    const w = Math.min(1, p.speed01)
    const stride = 0.55 + 1.05 * w
    const phase = p.time * (4.2 + 8.4 * w) + p.phase
    const swing = Math.sin(phase) * stride
    const swing2 = Math.sin(phase + Math.PI) * stride
    const knee = Math.max(0, -Math.sin(phase)) * (0.55 + 0.75 * w)
    const knee2 = Math.max(0, -Math.sin(phase + Math.PI)) * (0.55 + 0.75 * w)

    const setRot = (name: string, x: number, y = 0, z = 0): void => {
      const o = parts[name]
      if (o) o.rotation.set(x, y, z)
    }
    const setPos = (name: string, x: number, y: number, z: number): void => {
      const o = parts[name]
      if (o) o.position.set(x, y, z)
    }

    // --- base (breathing / idle) ---------------------------------------
    const breathe = Math.sin(t) * 0.02
    setRot('hips', 0, 0, 0)
    setRot('torso', breathe * 0.5, 0, Math.sin(t * 1.3) * 0.012)
    setRot('head', Math.sin(t * 0.9) * 0.03, p.headLook, 0)
    setRot('upperArmL', 0, 0, 0.1 + breathe)
    setRot('upperArmR', 0, 0, -0.1 - breathe)
    setRot('lowerArmL', -0.12, 0, 0)
    setRot('lowerArmR', -0.12, 0, 0)
    setRot('handL', 0, 0, 0)
    setRot('handR', 0, 0, 0)
    setRot('upperLegL', 0, 0, 0)
    setRot('upperLegR', 0, 0, 0)
    setRot('lowerLegL', 0, 0, 0)
    setRot('lowerLegR', 0, 0, 0)
    setRot('footL', 0, 0, 0)
    setRot('footR', 0, 0, 0)
    setPos('hips', 0, 0, 0)

    if (p.grounded && !p.flung && !p.down) {
      // --- locomotion ---------------------------------------------------
      setRot('upperLegL', -swing, 0, 0)
      setRot('upperLegR', -swing2, 0, 0)
      setRot('lowerLegL', knee, 0, 0)
      setRot('lowerLegR', knee2, 0, 0)
      setRot('footL', -knee * 0.4 + swing * 0.2, 0, 0)
      setRot('footR', -knee2 * 0.4 + swing2 * 0.2, 0, 0)
      setRot('upperArmL', swing2 * 0.85, 0, 0.12 + breathe)
      setRot('upperArmR', swing * 0.85, 0, -0.12 - breathe)
      setRot('lowerArmL', -0.35 - Math.max(0, swing2) * 0.5, 0, 0)
      setRot('lowerArmR', -0.35 - Math.max(0, swing) * 0.5, 0, 0)
      setRot('torso', -0.05 - 0.24 * w + breathe * 0.5, 0, 0)
      setRot('hips', -0.04 - 0.16 * w, 0, 0)
      setPos('hips', 0, Math.abs(Math.sin(phase)) * 0.045 * w, 0)
    }

    if (!p.grounded && !p.down) {
      // --- airborne: tucked legs, arms out -----------------------------
      const climb = Math.max(-1, Math.min(1, p.verticalSpeed / 18))
      setRot('upperLegL', -0.5 - climb * 0.25, 0, 0.08)
      setRot('upperLegR', -0.32 + climb * 0.2, 0, -0.08)
      setRot('lowerLegL', 0.9, 0, 0)
      setRot('lowerLegR', 0.62, 0, 0)
      setRot('footL', -0.25, 0, 0)
      setRot('footR', -0.2, 0, 0)
      if (w > 0.55) {
        // streaking forward: arms swept back, body pitched (body pitch is
        // applied to the whole model by the character controller)
        setRot('upperArmL', 0.85, 0, 0.5)
        setRot('upperArmR', 0.85, 0, -0.5)
        setRot('lowerArmL', -0.5, 0, 0)
        setRot('lowerArmR', -0.5, 0, 0)
        setRot('torso', 0.08, 0, 0)
      } else {
        setRot('upperArmL', -0.7, 0, 0.9)
        setRot('upperArmR', -0.7, 0, -0.9)
        setRot('lowerArmL', -0.5, 0, 0)
        setRot('lowerArmR', -0.5, 0, 0)
      }
    }

    if (p.down || p.flung) {
      // --- helpless ------------------------------------------------------
      // Flail amplitude AND frequency decay with the tumble energy, so the body
      // winds down rather than vibrating like a spring until the state ends.
      const e = p.flung ? p.flail : 0.35
      const flail = Math.sin(p.time * (18 * (0.35 + 0.65 * e))) * 1.1 * e
      setRot('upperArmL', flail, 0, 1.1)
      setRot('upperArmR', -flail, 0, -1.1)
      setRot('lowerArmL', -0.6 - flail * 0.4, 0, 0)
      setRot('lowerArmR', -0.6 + flail * 0.4, 0, 0)
      setRot('upperLegL', -0.5 + flail * 0.5, 0, 0.25)
      setRot('upperLegR', -0.5 - flail * 0.5, 0, -0.25)
      setRot('lowerLegL', 0.7, 0, 0)
      setRot('lowerLegR', 0.7, 0, 0)
      setRot('torso', 0.2, flail * 0.2, 0)
    }

    if (p.attack >= 0) {
      // --- attack: 0..0.35 windup, 0.35..0.6 strike, rest recovery -------
      const a = p.attack
      const strike = a < 0.35 ? a / 0.35 : a < 0.6 ? 1 : 1 - (a - 0.6) / 0.4
      if (p.attackHeavy) {
        setRot('upperArmR', -0.4 - strike * 2.2, 0, -0.3 - strike * 0.4)
        setRot('upperArmL', -0.4 - strike * 2.2, 0, 0.3 + strike * 0.4)
        setRot('lowerArmR', -0.6 + strike * 0.5, 0, 0)
        setRot('lowerArmL', -0.6 + strike * 0.5, 0, 0)
        setRot('torso', -0.3 + strike * 0.55, 0, 0)
        setRot('hips', -0.1 + strike * 0.2, 0, 0)
      } else {
        setRot('upperArmR', -0.5 - strike * 1.25, 0, -0.25)
        setRot('lowerArmR', -1.1 + strike * 1.15, 0, 0)
        setRot('upperArmL', 0.35 + strike * 0.5, 0, 0.35)
        setRot('lowerArmL', -0.9, 0, 0)
        setRot('torso', -0.12 + strike * 0.2, -strike * 0.35, 0)
        setRot('hips', 0, -strike * 0.2, 0)
      }
    }

    if (p.hurt > 0.01) {
      const h = p.hurt
      setRot('torso', 0.45 * h, 0, 0)
      setRot('head', -0.35 * h, p.headLook, 0)
      setRot('upperArmL', 0.9 * h, 0, 0.7 * h)
      setRot('upperArmR', 0.9 * h, 0, -0.7 * h)
    }

    // --- cape: lags behind the motion -----------------------------------
    const cape = parts['cape']
    if (cape) {
      const target = -(0.25 + w * 0.9 + Math.max(0, p.verticalSpeed) * 0.03)
      this.capeSway += (target - this.capeSway) * 0.16
      cape.rotation.x = this.capeSway + Math.sin(p.time * 3.1 + p.phase) * 0.06
      cape.rotation.z = Math.sin(p.time * 2.3 + p.phase) * 0.05
    }
  }
}
