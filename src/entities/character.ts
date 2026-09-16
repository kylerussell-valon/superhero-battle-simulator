import * as THREE from 'three'
import type { AbilitySpec, Archetype } from './archetypes'
import { HEAVY_ATTACK, LIGHT_ATTACK, type MeleeSpec } from './archetypes'
import type { Hit, PhysWorld } from '../physics/phys'
import { makeHit } from '../physics/phys'
import { Rig, type PoseInput } from './rig'
import { clamp } from '../core/util'

/**
 * A fighting character.
 *
 * State machine: idle/run/air -> dash | attack | flung -> recover.
 * Movement is kinematic with SDF collision; heavy hits convert the character
 * into a projectile ('flung') that physically tears through the city, which is
 * where the destruction fantasy lives.
 */

export type CharState = 'idle' | 'air' | 'dash' | 'attack' | 'hurt' | 'flung' | 'down' | 'dead'

export interface CharInput {
  moveX: number
  moveZ: number
  jump: boolean
  sprint: boolean
  descend: boolean
  light: boolean
  heavy: boolean
  ability1: boolean
  ability2: boolean
  /** Unit aim direction (the player's camera forward). Zero when unset. */
  aimX: number
  aimY: number
  aimZ: number
}

export interface ImpactEvent {
  x: number
  y: number
  z: number
  radius: number
  speed: number
  kind: 'dash' | 'fling' | 'pound' | 'slam' | 'beam' | 'clap' | 'land' | 'prop'
  nx: number
  ny: number
  nz: number
  source: Character | null
}

export interface CharWorld {
  phys: PhysWorld
  other(self: Character): Character | null
  /** World reaction to a character smashing into it. */
  onImpact(ev: ImpactEvent): void
  /** Damage delivery, knockback and hit FX. */
  onHit(attacker: Character, target: Character, damage: number, dirX: number, dirY: number, dirZ: number, impulse: number, fling: boolean): void
  /** Archetype ability behaviour (beams, shockwaves, projectiles). */
  onAbility(self: Character, ability: AbilitySpec): void
  shake(amount: number): void
  hitstop(seconds: number): void
  /** Called when a character is knocked out. */
  onKnockout(loser: Character): void
}

export class Character {
  readonly pos = new THREE.Vector3()
  readonly vel = new THREE.Vector3()
  yaw = 0
  targetYaw = 0
  state: CharState = 'idle'
  grounded = false
  flying = false
  health: number
  energy: number
  readonly maxHealth: number
  model: THREE.Group | null = null
  rig: Rig | null = null

  // timers
  private attackTimer = 0
  private attackSpec: MeleeSpec = LIGHT_ATTACK
  private attackHeavy = false
  private attackHit = false
  /**
   * Unit aim direction. The player's comes from the camera, so punches, lunges
   * and flight heading all follow where you look; the AI's falls back to its
   * facing.
   */
  private readonly aim = new THREE.Vector3(0, 0, 1)
  private dashTimer = 0
  private dashCooldown = 0
  private abilityCooldowns: number[] = [0, 0]
  private hurtTimer = 0
  private flungTimer = 0
  /** Duration of the current fling, and how far into it we are. */
  private flungMax = 1
  private flingAge = 0
  /** Ground bounces used up this fling (one hard bounce, then stay down). */
  private flingBounces = 0
  /** 1 at impact, 0 when the tumble is spent; drives the visual decay. */
  private flingEnergy = 1
  private downTimer = 0
  private time = 0
  private phase = Math.random() * 10
  private bodyPitch = 0
  private spinAngle = 0
  private readonly resolveRes = { depth: 0, nx: 0, ny: 1, nz: 0, building: null, grounded: false }
  private readonly hit: Hit = makeHit()
  private lastImpact = 0
  private readonly prev = new THREE.Vector3()
  /** Stats for the HUD / post-fight summary. */
  damageDealt = 0
  damageTaken = 0
  hitsLanded = 0
  buildingsTorn = 0
  koBy = ''
  dbg = ''

  constructor(readonly arch: Archetype, x: number, z: number, readonly isPlayer: boolean) {
    this.health = arch.health
    this.maxHealth = arch.health
    this.energy = arch.energyMax
    this.pos.set(x, arch.halfHeight + 0.02, z)
  }

  attachModel(model: THREE.Object3D): void {
    const group = new THREE.Group()
    group.add(model)
    group.rotation.order = 'YXZ'
    this.model = group
    this.rig = new Rig(model)
  }

  get alive(): boolean {
    return this.state !== 'dead'
  }

  /** True while the player can bail out of a fling with jump. */
  get flingRecoverable(): boolean {
    if (this.state !== 'flung') return false
    const control = clamp((this.flingAge - 0.35) / 0.45, 0, 1)
    return control > 0.5 && this.flungTimer < this.flungMax * 0.75
  }

  /** True while a melee swing is in progress (used by the AI to read intent). */
  get attacking(): boolean {
    return this.attackTimer > 0
  }

  get dashing(): boolean {
    return this.state === 'dash'
  }

  get energy01(): number {
    return this.energy / this.arch.energyMax
  }

  abilityCooldown01(slot: number): number {
    const a = this.arch.abilities[slot]
    if (!a) return 0
    return 1 - this.abilityCooldowns[slot] / a.cooldown
  }

  get abilityReady(): number {
    let n = 0
    for (let i = 0; i < this.arch.abilities.length; i++) if (this.abilityCooldowns[i] <= 0) n++
    return n
  }

  get radius(): number {
    return this.arch.radius
  }

  /** World-space point the camera should look at. */
  eye(out: THREE.Vector3): THREE.Vector3 {
    return out.set(this.pos.x, this.pos.y + this.arch.eyeHeight - this.arch.halfHeight, this.pos.z)
  }

  forward(out: THREE.Vector3): THREE.Vector3 {
    return out.set(Math.sin(this.yaw), 0, Math.cos(this.yaw))
  }

  // ------------------------------------------------------------------ hit --
  takeHit(
    damage: number,
    dirX: number,
    dirY: number,
    dirZ: number,
    impulse: number,
    fling: boolean,
    sourceKind = 'hit',
  ): void {
    if (this.state === 'dead') return
    this.health -= damage
    this.damageTaken += damage
    const kick = impulse / this.arch.mass
    this.vel.x += dirX * kick
    this.vel.y += Math.max(dirY * kick * 0.8, 0) + kick * 0.25
    this.vel.z += dirZ * kick
    this.grounded = false
    this.flying = false
    this.koBy = sourceKind

    if (this.health <= 0) {
      this.health = 0
      this.state = 'dead'
      this.vel.multiplyScalar(0.5)
      this.downTimer = 999
      return
    }

    if (fling && kick > 16) {
      this.state = 'flung'
      this.flungTimer = 1.1 + Math.min(2.2, kick / 45)
      this.flungMax = this.flungTimer
      this.flingAge = 0
      this.flingBounces = 0
      this.flingEnergy = 1
      this.attackTimer = 0
      this.spinAngle = 0
    } else {
      this.hurtTimer = 0.28
      this.attackTimer = 0
      if (this.state !== 'flung') this.state = 'hurt'
    }
  }

  /** Radial push (shockwaves, ground pounds, claps). */
  push(dx: number, dy: number, dz: number, impulse: number): void {
    const kick = impulse / this.arch.mass
    this.vel.x += dx * kick
    this.vel.y += Math.max(dy * kick, 0) + kick * 0.3
    this.vel.z += dz * kick
    this.grounded = false
    this.flying = false
    if (kick > 18 && this.state !== 'dead' && this.state !== 'flung') {
      this.state = 'flung'
      this.flungTimer = 0.8 + Math.min(1.8, kick / 50)
      this.flungMax = this.flungTimer
      this.flingAge = 0
      this.flingBounces = 0
      this.flingEnergy = 1
      this.spinAngle = 0
    }
  }

  // --------------------------------------------------------------- update --
  update(dt: number, input: CharInput, ctx: CharWorld): void {
    this.time += dt
    if (this.attackTimer > 0) this.attackTimer = Math.max(0, this.attackTimer - dt)
    if (this.hurtTimer > 0) this.hurtTimer = Math.max(0, this.hurtTimer - dt)
    if (this.dashCooldown > 0) this.dashCooldown = Math.max(0, this.dashCooldown - dt)
    for (let i = 0; i < this.abilityCooldowns.length; i++) {
      if (this.abilityCooldowns[i] > 0) this.abilityCooldowns[i] = Math.max(0, this.abilityCooldowns[i] - dt)
    }
    this.energy = Math.min(this.arch.energyMax, this.energy + this.arch.energyRegen * dt)

    if (this.state === 'dead') {
      this.integrateDead(dt, ctx)
      this.syncModel(dt)
      return
    }

    this.prev.copy(this.pos)

    if (this.state === 'flung') {
      this.updateFlung(dt, input, ctx)
    } else if (this.state === 'dash') {
      this.updateDash(dt, input, ctx)
    } else {
      this.updateMobile(dt, input, ctx)
    }

    // Collision resolve + ground contact.
    this.resolve(dt, ctx)

    if (this.state === 'down') {
      this.downTimer -= dt
      // Getting up is a decision, not a wait: jump cancels the knockdown.
      if (this.downTimer <= 0 || (input.jump && this.isPlayer)) this.state = 'idle'
    } else if (this.state === 'hurt' && this.hurtTimer <= 0) {
      this.state = this.grounded ? 'idle' : 'air'
    }

    this.syncModel(dt)
  }

  private approach(cur: number, target: number, maxDelta: number): number {
    const d = target - cur
    return Math.abs(d) <= maxDelta ? target : cur + Math.sign(d) * maxDelta
  }

  private updateMobile(dt: number, input: CharInput, ctx: CharWorld): void {
    const a = this.arch
    // Resolve the aim first: everything downstream (strike direction, lunge,
    // flight heading) reads it. The AI leaves the aim channels at zero, so it
    // falls back to its facing — and tracks the opponent while striking, which is
    // what keeps its punches landing now that the hit volume is a directional
    // capsule rather than a big sphere.
    if (input.aimX !== 0 || input.aimY !== 0 || input.aimZ !== 0) {
      const l = Math.max(0.001, Math.hypot(input.aimX, input.aimY, input.aimZ))
      this.aim.set(input.aimX / l, input.aimY / l, input.aimZ / l)
    } else {
      const foe = this.attackTimer > 0 ? ctx.other(this) : null
      if (foe) {
        const fx = foe.pos.x - this.pos.x
        const fy = foe.pos.y - this.pos.y
        const fz = foe.pos.z - this.pos.z
        const l = Math.max(0.001, Math.hypot(fx, fy, fz))
        this.aim.set(fx / l, fy / l, fz / l)
      } else {
        this.aim.set(Math.sin(this.yaw), 0, Math.cos(this.yaw))
      }
    }

    // Desired horizontal velocity in world space.
    const len = Math.hypot(input.moveX, input.moveZ)
    let dx = 0
    let dz = 0
    if (len > 0.01) {
      dx = input.moveX / len
      dz = input.moveZ / len
    }
    const attacking = this.attackTimer > 0
    const speedCap = this.grounded ? a.runSpeed : a.airSpeed
    const control = attacking ? 0.25 : 1
    const accel = (this.grounded ? 46 : a.canFly ? 34 : 18) * control
    // In the air the aim is a 3D direction, so the horizontal share of the flight
    // speed falls off as you pitch away from level. That is what makes flying
    // work like flight: look up and hold forward and you climb, look down and you
    // dive, instead of sliding sideways at full speed while the vertical axis
    // does its own thing.
    const level = Math.hypot(this.aim.x, this.aim.z)
    const share = this.grounded || !a.canFly || len < 0.01 ? 1 : level
    const sprint = input.sprint && this.grounded ? 1.35 : 1
    const targetVX = dx * speedCap * sprint * control * share
    const targetVZ = dz * speedCap * sprint * control * share
    this.vel.x = this.approach(this.vel.x, targetVX, accel * dt)
    this.vel.z = this.approach(this.vel.z, targetVZ, accel * dt)

    if (len > 0.01 && !attacking) {
      this.targetYaw = Math.atan2(dx, dz)
    }
    // While attacking, or while flying, the character turns to face the aim so
    // the camera stays predictably behind the nose instead of drifting broadside.
    // Guarded on the horizontal component: looking straight down must not spin
    // the character.
    if (attacking || this.flying) {
      if (Math.hypot(this.aim.x, this.aim.z) > 0.15) this.targetYaw = Math.atan2(this.aim.x, this.aim.z)
    }
    this.yaw += shortestAngle(this.yaw, this.targetYaw) * Math.min(1, dt * 12)

    // --- vertical: jump, flight, gravity ---------------------------------
    const wantFly = a.canFly && !this.grounded
    this.flying = wantFly && !input.descend
    if (this.grounded) {
      if (input.jump) {
        this.vel.y = a.jumpSpeed
        this.grounded = false
      } else {
        this.vel.y = Math.min(this.vel.y, 0)
      }
    } else if (wantFly) {
      // Fly toward where you are looking. Vertical follows the camera pitch, so
      // climbing is "aim up and hold forward" rather than a separate ascend key.
      if (len > 0.01) {
        const vy = this.aim.y * a.airSpeed * (input.jump ? 1 : 0.62) * control
        this.vel.y = this.approach(this.vel.y, vy, 40 * dt)
      } else if (input.jump) {
        // No direction held: throttle straight up, so take-off is still one key.
        this.vel.y = this.approach(this.vel.y, a.airSpeed * 0.55, 60 * dt)
      } else if (input.descend) {
        this.vel.y = this.approach(this.vel.y, -a.airSpeed * 0.6, 60 * dt)
      } else {
        // Hold station. Hovering in place is what makes aiming — and therefore
        // flying at what you are aiming at — actually practical.
        this.vel.y = this.approach(this.vel.y, 0, 30 * dt)
      }
    } else {
      this.vel.y -= a.gravity * dt
    }

    // --- abilities --------------------------------------------------------
    if (input.ability1) this.tryAbility(0, ctx)
    else if (input.ability2) this.tryAbility(1, ctx)

    // --- attacks ----------------------------------------------------------
    if (this.attackTimer <= 0 && (input.light || input.heavy)) {
      this.startAttack(input.heavy ? HEAVY_ATTACK : LIGHT_ATTACK, input.heavy, ctx)
    }
    if (this.attackTimer > 0) this.updateAttack(dt, ctx)

    // Do not clobber a state that an ability just started this frame.
    if (this.state !== 'dash') {
      if (!this.grounded) this.state = 'air'
      else if (this.attackTimer <= 0 && this.hurtTimer <= 0) this.state = 'idle'
    }

    this.pos.addScaledVector(this.vel, dt)

    // Ground impacts for pounds / hard landings.
    if (this.lastImpact > 0.4 && this.grounded) {
      this.land(ctx, Math.min(1, this.lastImpact))
    }
    this.lastImpact = 0
  }

  private land(ctx: CharWorld, strength: number): void {
    const speed = Math.abs(this.vel.y)
    void speed
    if (strength < 0.5) return
    ctx.onImpact({
      x: this.pos.x,
      y: Math.max(0.2, this.pos.y - this.arch.halfHeight),
      z: this.pos.z,
      radius: 2.2 + strength * 2.4,
      speed: 12 * strength,
      kind: 'land',
      nx: 0,
      ny: 1,
      nz: 0,
      source: this,
    })
    if (strength > 0.7) ctx.shake(0.25 * strength)
  }

  private updateFlung(dt: number, input: CharInput, ctx: CharWorld): void {
    const a = this.arch
    this.flingAge += dt

    // Steering ramps in as the tumble burns off. The impact still reads as an
    // impact, but the player stops being a passenger partway through instead of
    // riding the whole thing out with no agency at all.
    const control = clamp((this.flingAge - 0.35) / 0.45, 0, 1)
    const turn = Math.hypot(input.moveX, input.moveZ)
    if (control > 0 && turn > 0.01) {
      const steer = a.airSpeed * 0.6 * control
      const accel = 34 * control * dt
      this.vel.x = this.approach(this.vel.x, (input.moveX / turn) * steer, accel)
      this.vel.z = this.approach(this.vel.z, (input.moveZ / turn) * steer, accel)
    }

    // Recover: once the tumble is mostly spent, jump hands the stick back.
    if (control > 0.5 && this.flungTimer < this.flungMax * 0.75 && input.jump) {
      this.recoverFromFling()
      return
    }

    this.vel.y -= a.gravity * 0.72 * dt
    // Air drag keeps the tumble readable.
    this.vel.multiplyScalar(1 - Math.min(0.5, dt * 0.35))
    const nx = this.pos.x + this.vel.x * dt
    const ny = this.pos.y + this.vel.y * dt
    const nz = this.pos.z + this.vel.z * dt

    const radius = a.radius * 1.05
    if (ctx.phys.sweep(this.pos.x, this.pos.y, this.pos.z, nx, ny, nz, radius, this.hit) && this.hit.hit) {
      const speed = Math.hypot(this.vel.x, this.vel.y, this.vel.z)
      const h = this.hit
      // Smashing through: carve, bleed speed, but keep going if it is fast.
      ctx.onImpact({
        x: h.x - h.nx * radius * 0.5,
        y: h.y - h.ny * radius * 0.5,
        z: h.z - h.nz * radius * 0.5,
        radius: clamp(radius * 2.4, 1.4, 4.5),
        speed,
        kind: 'fling',
        nx: h.nx,
        ny: h.ny,
        nz: h.nz,
        source: this,
      })
      if (this.isPlayer) {
        this.damageTaken += speed * 0.35
        this.health -= speed * 0.35
        if (this.health <= 0) {
          this.health = 0
          this.state = 'dead'
          ctx.onKnockout(this)
          return
        }
      }
      // Bounce along the surface normal, losing energy.
      const vn = this.vel.x * h.nx + this.vel.y * h.ny + this.vel.z * h.nz
      if (h.ny > 0.6) {
        this.vel.y = -vn * 0.32
        const damp = speed > 22 ? 0.86 : 0.55
        this.vel.x *= damp
        this.vel.z *= damp
        this.pos.set(h.x + h.nx * radius, h.y + h.ny * radius, h.z + h.nz * radius)
      } else {
        this.vel.x -= vn * h.nx * 1.35
        this.vel.y -= vn * h.ny * 1.35
        this.vel.z -= vn * h.nz * 1.35
        this.pos.set(h.x - h.nx * 0.05, h.y - h.ny * 0.05, h.z - h.nz * 0.05)
      }
      // Each surface used to add a flat 0.25 s to the fling, so ploughing through
      // two buildings left the player tumbling with no say for seconds on end.
      // Extend a little, and never past the original duration.
      this.flungTimer = Math.min(this.flungMax, this.flungTimer + 0.12)
      ctx.shake(clamp(speed / 90, 0.08, 0.6))
      ctx.hitstop(clamp(speed / 500, 0.02, 0.09))
    } else {
      this.pos.set(nx, ny, nz)
    }

    if (this.pos.y < 0) {
      this.pos.y = 0
      // Land, don't pogo. One hard bounce if you arrive fast, then stay down:
      // the old flat 30% restitution re-bounced on every contact, which is what
      // read as a spring.
      if (this.vel.y < -16 && this.flingBounces === 0) {
        this.flingBounces = 1
        this.vel.y = -this.vel.y * 0.24
      } else {
        this.vel.y = 0
      }
      // Ground friction, so a slide settles in a moment rather than skating.
      const keep = Math.max(0, 1 - (this.vel.y === 0 ? 4.5 : 0.9) * dt)
      this.vel.x *= keep
      this.vel.z *= keep
      if (Math.hypot(this.vel.x, this.vel.z) < 1.5) {
        this.vel.x = 0
        this.vel.z = 0
      }
    }

    // The tumble decays with the fling instead of oscillating at constant
    // amplitude for its entire length.
    const decay = this.flungMax > 0 ? clamp(this.flungTimer / this.flungMax, 0, 1) : 0
    this.flingEnergy = decay
    this.spinAngle += dt * 7 * (0.3 + 0.7 * decay)
    this.flungTimer -= dt

    const flat = Math.hypot(this.vel.x, this.vel.z)
    const settled = this.pos.y <= 0.05 && flat < 6
    if (this.flungTimer <= 0 && (settled || flat < 2.5 || this.flingAge > this.flungMax + 0.9)) {
      this.spinAngle = 0
      this.flingEnergy = 0
      if (settled) {
        this.vel.set(0, 0, 0)
        this.state = 'down'
        this.downTimer = this.isPlayer ? 0.35 : 0.7
      } else {
        // Still moving when the tumble runs out: hand control back rather than
        // staying ragdolled until the character happens to stop.
        this.vel.x *= 0.6
        this.vel.z *= 0.6
        this.state = 'air'
      }
    }
  }

  /**
   * Bail out of a fling early. Keeps the momentum you arrived with — you earned
   * it — but dumps the tumble, so this reads as catching yourself rather than as
   * the game letting go of you.
   */
  private recoverFromFling(): void {
    this.flungTimer = 0
    this.spinAngle = 0
    this.flingEnergy = 0
    this.bodyPitch = 0
    this.vel.x *= 0.72
    this.vel.z *= 0.72
    this.vel.y = Math.min(this.vel.y, 8)
    if (this.grounded) {
      this.state = 'idle'
    } else {
      this.state = 'air'
      // A recovery burst so the save is something you can feel, and so flying
      // archetypes regain lift the moment you ask for it.
      this.vel.y = Math.max(this.vel.y, this.arch.canFly ? 7 : 4.5)
    }
  }

  private updateDash(dt: number, input: CharInput, ctx: CharWorld): void {
    const a = this.arch
    this.dashTimer -= dt
    this.vel.y *= 0.85
    const nx = this.pos.x + this.vel.x * dt
    const ny = this.pos.y + this.vel.y * dt
    const nz = this.pos.z + this.vel.z * dt
    const speed = Math.hypot(this.vel.x, this.vel.y, this.vel.z)

    // Everything in the dash path gets torn apart; the dash never stops for
    // buildings, which is the whole point of the ability.
    ctx.onImpact({
      x: this.pos.x,
      y: this.pos.y,
      z: this.pos.z,
      radius: a.abilities[0].carveRadius,
      speed,
      kind: 'dash',
      nx: 0,
      ny: 1,
      nz: 0,
      source: this,
    })
    ctx.onImpact({
      x: (this.pos.x + nx) * 0.5,
      y: (this.pos.y + ny) * 0.5,
      z: (this.pos.z + nz) * 0.5,
      radius: a.abilities[0].carveRadius * 0.75,
      speed,
      kind: 'dash',
      nx: 0,
      ny: 1,
      nz: 0,
      source: this,
    })

    // Dash into an opponent: massive hit + fling.
    const foe = ctx.other(this)
    if (foe && foe.state !== 'dead') {
      const dx = foe.pos.x - this.pos.x
      const dy = foe.pos.y - this.pos.y
      const dz = foe.pos.z - this.pos.z
      const dist = Math.hypot(dx, dy, dz)
      if (dist < a.radius + foe.arch.radius + 1.4) {
        const inv = 1 / Math.max(0.001, dist)
        const ab = a.abilities[0]
        ctx.onHit(
          this,
          foe,
          ab.damage * (0.6 + speed / a.dashSpeed),
          dx * inv,
          Math.max(0.12, dy * inv),
          dz * inv,
          ab.knockback * (0.7 + speed / a.dashSpeed),
          true,
        )
        ctx.hitstop(0.12)
        ctx.shake(0.85)
        this.dashTimer = Math.min(this.dashTimer, 0.08)
      }
    }

    this.pos.set(nx, ny, nz)
    this.vel.y -= a.gravity * 0.25 * dt

    if (this.dashTimer <= 0) {
      this.state = this.grounded ? 'idle' : 'air'
      this.vel.multiplyScalar(0.35)
      this.dashCooldown = a.dashCooldown
    }
    void input
  }

  private startAttack(spec: MeleeSpec, heavy: boolean, ctx: CharWorld): void {
    this.attackSpec = spec
    this.attackHeavy = heavy
    this.attackTimer = spec.windup + spec.active + spec.recovery
    this.attackHit = false
    // Commit forward. Without this the character swings while hanging in the air
    // and the hit reads as having come from nowhere.
    this.vel.x += this.aim.x * spec.lunge
    this.vel.z += this.aim.z * spec.lunge
    if (!this.grounded) this.vel.y += this.aim.y * spec.lunge * 0.6
    void ctx
  }

  private updateAttack(dt: number, ctx: CharWorld): void {
    void dt
    const spec = this.attackSpec
    const total = spec.windup + spec.active + spec.recovery
    const elapsed = total - this.attackTimer
    if (this.attackHit || elapsed < spec.windup || elapsed > spec.windup + spec.active) return

    const a = this.arch
    const reach = spec.reach + a.halfHeight * 0.6

    // The swing travels along the aim as a capsule, so altitude is aimable and
    // the strike lands where the camera points. The old test was a ~4 m sphere
    // centred in front of the character, which hit anything nearby including
    // targets beside and behind the strike — that is what made a punch read as
    // an area-of-effect burst.
    const dx = this.aim.x
    const dy = this.aim.y
    const dz = this.aim.z
    const ox = this.pos.x + dx * a.radius
    const oy = this.pos.y + a.halfHeight * 0.25
    const oz = this.pos.z + dz * a.radius

    // Fist through concrete: only where the swing actually lands.
    const mx = ox + dx * reach * 0.75
    const my = oy + dy * reach * 0.75
    const mz = oz + dz * reach * 0.75
    if (ctx.phys.distance(mx, my, mz) < 0.9) {
      ctx.onImpact({ x: mx, y: my, z: mz, radius: spec.carveRadius, speed: 30, kind: this.attackHeavy ? 'slam' : 'dash', nx: 0, ny: 1, nz: 0, source: this })
    }

    const foe = ctx.other(this)
    if (foe && foe.state !== 'dead') {
      const fx = foe.pos.x - ox
      const fy = foe.pos.y - oy
      const fz = foe.pos.z - oz
      const along = fx * dx + fy * dy + fz * dz
      const t = clamp(along / reach, 0, 1)
      const cd = Math.hypot(foe.pos.x - (ox + dx * reach * t), foe.pos.y - (oy + dy * reach * t), foe.pos.z - (oz + dz * reach * t))
      // t > 0.05 keeps the strike in front of the character.
      if (t > 0.05 && cd < foe.arch.radius + spec.hitRadius) {
        const inv = 1 / Math.max(0.001, Math.hypot(fx, fy, fz))
        ctx.onHit(
          this,
          foe,
          spec.damage * a.power,
          fx * inv,
          Math.max(0.12, fy * inv),
          fz * inv,
          spec.knockback * a.power,
          spec.fling,
        )
      }
    }
    // A melee swing that connects with nothing still counts once.
    this.attackHit = true
  }

  /** Ability slot 0/1 (dash is always slot 0 for the flying archetypes). */
  tryAbility(slot: number, ctx: CharWorld): void {
    const a = this.arch
    let ability = a.abilities[slot]
    // Some signatures need to be airborne — fall back to the grounded variant.
    if (ability?.alt && this.grounded) ability = ability.alt
    if (!ability) return
    if (this.abilityCooldowns[slot] > 0) return
    if (this.energy < ability.cost) return
    if (this.state === 'flung' || this.state === 'dead') return
    if (ability.airborne && this.grounded) return

    this.energy -= ability.cost
    this.abilityCooldowns[slot] = ability.cooldown

    if (ability.id === 'dash') {
      const len = Math.hypot(this.vel.x, this.vel.z)
      let dx = Math.sin(this.yaw)
      let dz = Math.cos(this.yaw)
      if (len > 1) {
        dx = this.vel.x / len
        dz = this.vel.z / len
      }
      this.dbg = `dash dx=${dx.toFixed(3)} dz=${dz.toFixed(3)} yaw=${this.yaw.toFixed(3)} len=${len.toFixed(3)} spd=${a.dashSpeed}`
      this.vel.set(dx * a.dashSpeed, Math.max(this.vel.y * 0.2, 0), dz * a.dashSpeed)
      this.dashTimer = a.dashTime
      this.state = 'dash'
      this.flying = true
      ctx.shake(0.2)
      ctx.onAbility(this, ability)
      return
    }
    if (ability.id === 'pound' || ability.id === 'slam') {
      this.vel.y = -Math.min(90, 40 + a.power * 30)
      this.vel.x *= 0.4
      this.vel.z *= 0.4
      this.state = 'dash'
      this.dashTimer = 0.6
      this.attackSpec = HEAVY_ATTACK
      this.attackHeavy = true
      this.attackTimer = 0.5
      return
    }
    // Beams, claps and barrages are handled by the world (FX + carve + damage).
    this.attackSpec = this.attackHeavy ? HEAVY_ATTACK : LIGHT_ATTACK
    this.attackTimer = 0.45
    ctx.onAbility(this, ability)
  }

  private resolve(dt: number, ctx: CharWorld): void {
    const a = this.arch
    const before = this.pos.y
    const res = ctx.phys.resolve(this.pos.x, this.pos.y, this.pos.z, a.radius, a.halfHeight, this.resolveRes)
    if (res.depth > 0) {

      this.pos.x += res.nx * res.depth
      this.pos.y += res.ny * res.depth
      this.pos.z += res.nz * res.depth
      // A dash or a flung body ploughs straight through: only resolve the
      // position, never cancel the momentum (the carve happens in the impact
      // handler, so the character keeps flying through the hole it made).
      const through = this.state === 'dash' || this.state === 'flung'
      const vn = this.vel.x * res.nx + this.vel.y * res.ny + this.vel.z * res.nz
      if (vn < 0 && !through) {
        const rest = 0.15
        this.vel.x -= res.nx * vn * (1 + rest)
        this.vel.y -= res.ny * vn * (1 + rest)
        this.vel.z -= res.nz * vn * (1 + rest)
      }
      if (res.ny > 0.5) {
        this.grounded = true
        if (this.state === 'flung' && Math.abs(vn) > 18) ctx.shake(clamp(Math.abs(vn) / 120, 0.05, 0.4))
      }
    }
    if (this.pos.y < 0) {
      this.pos.y = 0
      this.vel.y = Math.max(0, this.vel.y)
      this.grounded = true
    }
    const drop = before - this.pos.y
    if (!this.grounded && drop > 0.001 && Math.abs(this.vel.y) > 8) {
      this.lastImpact = Math.max(this.lastImpact, Math.abs(this.vel.y) / 34)
    }
    // Leaving the ground.
    if (this.grounded && this.vel.y > 0.5) this.grounded = false
    if (!this.grounded && this.vel.y <= 0 && this.pos.y > 0) {
      const d = ctx.phys.distance(this.pos.x, this.pos.y - a.halfHeight + a.radius, this.pos.z)
      if (d < 0.12) this.grounded = true
    }
    void dt
  }

  private integrateDead(dt: number, ctx: CharWorld): void {
    this.vel.y -= this.arch.gravity * dt
    this.pos.addScaledVector(this.vel, dt)
    if (this.pos.y < 0) {
      this.pos.y = 0
      this.vel.y = 0
      this.vel.x *= 0.8
      this.vel.z *= 0.8
    }
    this.vel.x *= 1 - Math.min(0.9, dt * 2.4)
    this.vel.z *= 1 - Math.min(0.9, dt * 2.4)
    ctx.shake(0)
  }

  // ---------------------------------------------------------------- model --
  private syncModel(dt: number): void {
    const model = this.model
    const rig = this.rig
    if (!model || !rig) return
    model.position.set(this.pos.x, this.pos.y - this.arch.halfHeight, this.pos.z)
    model.rotation.y = this.yaw

    // Body pitch: lean into flight, tumble when flung, face-plant when down.
    // The tumble amplitude decays with the fling: a constant-amplitude sine for
    // the whole duration is what made the character read as a thing on a spring.
    const tumble = this.state === 'flung' ? this.flingEnergy : 0
    const targetPitch =
      this.state === 'flung'
        ? Math.sin(this.spinAngle) * 1.4 * tumble
        : this.state === 'down' || this.state === 'dead'
          ? -1.35
          : this.flying && !this.grounded
            ? -0.18 - clamp(Math.hypot(this.vel.x, this.vel.z) / (this.arch.airSpeed || 1), 0, 1) * 0.95
            : 0
    this.bodyPitch += (targetPitch - this.bodyPitch) * Math.min(1, dt * 8)
    model.rotation.x = this.bodyPitch
    model.rotation.z = Math.cos(this.spinAngle * 0.7) * 0.6 * tumble

    const planar = Math.hypot(this.vel.x, this.vel.z)
    const pose: PoseInput = {
      speed01: clamp(planar / Math.max(1, this.arch.runSpeed), 0, 1.6),
      grounded: this.grounded,
      flying: this.flying,
      verticalSpeed: this.vel.y,
      attack: this.attackTimer > 0 ? 1 - this.attackTimer / (this.attackSpec.windup + this.attackSpec.active + this.attackSpec.recovery) : -1,
      attackHeavy: this.attackHeavy,
      hurt: this.hurtTimer / 0.28,
      flung: this.state === 'flung',
      flail: this.state === 'flung' ? this.flingEnergy : 0,
      down: this.state === 'down' || this.state === 'dead',
      headLook: 0,
      time: this.time,
      phase: this.phase,
    }
    rig.pose(pose)
  }

  /** Teleport helper used by scenario scripts and the arena reset. */
  placeAt(x: number, y: number, z: number, yaw = 0): void {
    this.pos.set(x, y, z)
    this.vel.set(0, 0, 0)
    this.yaw = yaw
    this.targetYaw = yaw
    this.state = 'idle'
    this.grounded = false
    this.health = this.maxHealth
    this.energy = this.arch.energyMax
    this.bodyPitch = 0
    this.syncModel(0.016)
  }

  resetStats(): void {
    this.damageDealt = 0
    this.damageTaken = 0
    this.hitsLanded = 0
    this.buildingsTorn = 0
  }
}

/** Shortest signed angle from a to b. */
function shortestAngle(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2)
  if (d > Math.PI) d -= Math.PI * 2
  if (d < -Math.PI) d += Math.PI * 2
  return d
}
