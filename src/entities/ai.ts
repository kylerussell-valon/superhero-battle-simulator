import type { Character, CharInput, CharWorld } from './character'
import { clamp } from '../core/util'

/**
 * Opponent AI.
 *
 * Deliberately small: a range-keeping state machine plus reactive dodges. It
 * exists to make the destruction systems legible (someone to ram into, someone
 * who rams back), not to win tournaments.
 */

export type AiState = 'approach' | 'strike' | 'recover' | 'reposition' | 'aerial' | 'finish'

export class FighterAI {
  state: AiState = 'approach'
  private timer = 0.4
  private readonly input: CharInput = {
    moveX: 0,
    moveZ: 0,
    jump: false,
    sprint: false,
    descend: false,
    light: false,
    heavy: false,
    ability1: false,
    ability2: false,
  }
  private aggression = 0.65
  private reactionTimer = 0
  private abilityTimer = 3
  private stallTimer = 0
  private stuckTimer = 0
  private strafeBias = Math.random() < 0.5 ? -1 : 1
  private readonly lastPos = { x: 0, z: 0 }

  constructor(readonly self: Character, difficulty = 0.5) {
    this.aggression = clamp(0.4 + difficulty * 0.6, 0, 1)
  }

  reset(): void {
    this.state = 'approach'
    this.timer = 0.4
    this.abilityTimer = 2.5
  }

  update(dt: number, foe: Character, ctx: CharWorld): CharInput {
    const inp = this.input
    inp.moveX = 0
    inp.moveZ = 0
    inp.jump = false
    inp.sprint = false
    inp.descend = false
    inp.light = false
    inp.heavy = false
    inp.ability1 = false
    inp.ability2 = false

    const a = this.self
    if (a.state === 'dead' || foe.state === 'dead') return inp

    this.timer -= dt
    this.reactionTimer -= dt
    this.abilityTimer -= dt

    const dx = foe.pos.x - a.pos.x
    const dz = foe.pos.z - a.pos.z
    const distXZ = Math.hypot(dx, dz)
    const dy = foe.pos.y - a.pos.y
    const nx = distXZ > 0.001 ? dx / distXZ : 0
    const nz = distXZ > 0.001 ? dz / distXZ : 1
    const reach = a.arch.reach + foe.arch.radius + 0.6
    const health01 = a.health / a.maxHealth

    // React to incoming attacks: dodge or fly away.
    const foeAttacking = foe.state === 'dash' || foe.attacking
    if (foeAttacking && this.reactionTimer <= 0 && distXZ < reach * 1.7) {
      this.reactionTimer = 0.9
      if (Math.random() < 0.55 * this.aggression) {
        this.state = 'reposition'
        this.timer = 0.32
      }
    }

    if (dy > 2.5 && a.arch.canFly) {
      this.state = 'aerial'
    }

    switch (this.state) {
      case 'aerial': {
        inp.moveX = nx
        inp.moveZ = nz
        inp.jump = dy > 1
        inp.descend = dy < -1.5
        if (distXZ < reach * 1.4 && Math.abs(dy) < 2.2) {
          this.state = 'strike'
          this.timer = 0.15
        } else if (Math.abs(dy) < 1.5 && distXZ < reach * 1.2) {
          this.state = 'strike'
        } else if (this.timer <= 0 && a.arch.canFly && this.abilityTimer <= 0) {
          // Dash from range: the flying archetypes close like a missile.
          inp.ability1 = true
          this.abilityTimer = 2.4 + Math.random() * 2
          this.state = 'strike'
          this.timer = 0.9
        }
        break
      }
      case 'approach': {
        inp.moveX = nx
        inp.moveZ = nz
        inp.sprint = distXZ > reach * 1.6
        if (distXZ < reach && Math.abs(dy) < 2.4) {
          this.state = 'strike'
          this.timer = 0.1 + Math.random() * 0.14
        } else if (this.timer <= 0 && this.abilityTimer <= 0 && distXZ < 30 && distXZ > 8) {
          // Close the gap with a signature ability.
          inp.ability1 = true
          this.abilityTimer = 3 + Math.random() * 2.5
          this.timer = 0.7
        }
        break
      }
      case 'strike': {
        inp.moveX = nx * 0.6
        inp.moveZ = nz * 0.6
        if (this.timer <= 0 || distXZ > reach * 1.5) {
          // Committed attack.
          if (Math.random() < 0.35 + this.aggression * 0.2) inp.heavy = true
          else inp.light = true
          this.state = 'recover'
          this.timer = 0.28 + Math.random() * 0.25 - this.aggression * 0.1
        }
        break
      }
      case 'recover': {
        if (this.timer <= 0) {
          this.state = health01 < 0.35 && Math.random() < 0.35 ? 'reposition' : 'approach'
          if (this.abilityTimer <= 0 && distXZ < 22 && Math.random() < 0.5) inp.ability2 = true
          this.abilityTimer = Math.max(this.abilityTimer, 1.6)
        }
        break
      }
      case 'reposition': {
        inp.moveX = -nx
        inp.moveZ = -nz
        inp.sprint = true
        if (this.timer <= 0) this.state = 'approach'
        break
      }
      case 'finish': {
        inp.moveX = nx
        inp.moveZ = nz
        inp.light = this.timer <= 0
        if (this.timer <= 0) this.timer = 0.25
        break
      }
    }

    // Never fly out of the arena.
    if (a.pos.y > 260) inp.descend = true
    if (Math.abs(a.pos.x) > 420 || Math.abs(a.pos.z) > 420) {
      inp.moveX = -Math.sign(a.pos.x)
      inp.moveZ = -Math.sign(a.pos.z)
    }

    // Stall breaker: direct steering has no pathfinding, so a fighter can wedge
    // itself against a facade while trying to close. If it asks to move but
    // barely advances, strafe + hop to slide off the obstacle; if that fails for
    // long enough, hop the fighter upward so flying archetypes clear the roof.
    const moved = Math.hypot(a.pos.x - this.lastPos.x, a.pos.z - this.lastPos.z)
    this.lastPos.x = a.pos.x
    this.lastPos.z = a.pos.z
    const wantsMove = inp.moveX !== 0 || inp.moveZ !== 0
    if (wantsMove && moved < 0.02) this.stallTimer += dt
    else this.stallTimer = Math.max(0, this.stallTimer - dt * 2)
    if (this.stallTimer > 0.9 && this.state !== 'strike') {
      inp.moveX = -nz * this.strafeBias
      inp.moveZ = nx * this.strafeBias
      inp.sprint = true
      inp.jump = true
      this.stuckTimer += dt
      if (this.stuckTimer > 2.4 || (a.arch.canFly && this.stuckTimer > 1.2)) {
        // Give up on this side and try the other way, or climb over.
        this.strafeBias = -this.strafeBias
        this.stuckTimer = 0
        this.stallTimer = 0
      }
    } else {
      this.stuckTimer = 0
    }
    void ctx
    return inp
  }
}
