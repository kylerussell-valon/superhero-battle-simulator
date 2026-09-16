/**
 * Character archetypes.
 *
 * These are *movement + power fantasies* rather than specific licensed heroes:
 *  - aegis  : flying brick. Super speed, ram-through-buildings, heat vision.
 *  - titan  : strength brawler. Huge leaps, ground pound, shockwave clap.
 *  - volt   : armoured energy projector. Hover, repulsor blasts, barrage.
 *  - amazon : agile warrior. Fast ground game, charge slam, shockwave brace.
 *
 * Every number here is gameplay-facing and tuned to feel "comic book heavy":
 * dashes are 60-110 m/s, a heavy hit launches at 40-70 m/s which is enough to
 * punch a hole through a reinforced concrete tower.
 */

export type AbilityId = 'dash' | 'pound' | 'beam' | 'barrage' | 'slam' | 'clap'

export interface AbilitySpec {
  id: AbilityId
  name: string
  /** Seconds. */
  cooldown: number
  /** Energy cost, out of 100. */
  cost: number
  /** Damage applied on a clean hit. */
  damage: number
  /** Knockback impulse in m/s applied to the target. */
  knockback: number
  /** Carve radius in metres when it interacts with the world. */
  carveRadius: number
  /** Requires flight/airborne. */
  airborne?: boolean
  /** Ability used instead when the airborne requirement is not met. */
  alt?: AbilitySpec
}

export interface Archetype {
  id: string
  name: string
  tagline: string
  /** GLB under assets/characters. */
  model: string
  /** Uniform model scale (models are authored at real proportions). */
  scale: number
  health: number
  /** Knockback resistance: impulse is divided by mass. */
  mass: number
  /** Melee power multiplier. */
  power: number
  runSpeed: number
  airSpeed: number
  canFly: boolean
  /** Flight is a boost: hold jump in the air. */
  hoverHold: boolean
  jumpSpeed: number
  gravity: number
  dashSpeed: number
  /** Dash duration (seconds) and recharge. */
  dashTime: number
  dashCooldown: number
  /** Energy regen per second and max energy. */
  energyRegen: number
  energyMax: number
  /** Capsule. */
  radius: number
  halfHeight: number
  /** Eye height for the camera target. */
  eyeHeight: number
  abilities: AbilitySpec[]
  /** UI colour. */
  color: number
  /** Melee reach. */
  reach: number
}

export const ARCHETYPES: Record<string, Archetype> = {
  aegis: {
    id: 'aegis',
    name: 'AEGIS',
    tagline: 'flying brick · superspeed ram · heat vision',
    model: 'assets/characters/aegis.glb',
    scale: 1,
    health: 1000,
    mass: 1.15,
    power: 1.0,
    runSpeed: 15,
    airSpeed: 52,
    canFly: true,
    hoverHold: true,
    jumpSpeed: 16,
    gravity: 26,
    dashSpeed: 104,
    dashTime: 0.55,
    dashCooldown: 1.5,
    energyRegen: 16,
    energyMax: 100,
    radius: 0.52,
    halfHeight: 0.98,
    eyeHeight: 1.62,
    reach: 2.4,
    color: 0x3f6bd8,
    abilities: [
      { id: 'dash', name: 'SUPERSPEED', cooldown: 1.5, cost: 22, damage: 190, knockback: 62, carveRadius: 3.6 },
      { id: 'beam', name: 'HEAT VISION', cooldown: 4.5, cost: 34, damage: 120, knockback: 16, carveRadius: 1.5 },
    ],
  },
  titan: {
    id: 'titan',
    name: 'TITAN',
    tagline: 'brick brawler · ground pound · shockwave clap',
    model: 'assets/characters/titan.glb',
    scale: 1,
    health: 1450,
    mass: 2.6,
    power: 1.75,
    runSpeed: 11,
    airSpeed: 22,
    canFly: false,
    hoverHold: false,
    jumpSpeed: 22,
    gravity: 30,
    dashSpeed: 46,
    dashTime: 0.4,
    dashCooldown: 2.4,
    energyRegen: 13,
    energyMax: 100,
    radius: 0.78,
    halfHeight: 1.4,
    eyeHeight: 2.3,
    reach: 3.1,
    color: 0x5cae4a,
    abilities: [
      { id: 'dash', name: 'TITAN CHARGE', cooldown: 2.6, cost: 20, damage: 170, knockback: 58, carveRadius: 3.2 },
      {
        id: 'pound',
        name: 'GROUND POUND',
        cooldown: 3.6,
        cost: 26,
        damage: 230,
        knockback: 34,
        carveRadius: 5.2,
        airborne: true,
        alt: { id: 'clap', name: 'SHOCKWAVE CLAP', cooldown: 4.2, cost: 26, damage: 150, knockback: 68, carveRadius: 4.4 },
      },
    ],
  },
  volt: {
    id: 'volt',
    name: 'VOLT',
    tagline: 'armour · repulsor blasts · barrage',
    model: 'assets/characters/volt.glb',
    scale: 1,
    health: 900,
    mass: 1.0,
    power: 0.85,
    runSpeed: 13,
    airSpeed: 40,
    canFly: true,
    hoverHold: true,
    jumpSpeed: 14,
    gravity: 24,
    dashSpeed: 72,
    dashTime: 0.45,
    dashCooldown: 1.8,
    energyRegen: 22,
    energyMax: 120,
    radius: 0.5,
    halfHeight: 0.96,
    eyeHeight: 1.58,
    reach: 2.3,
    color: 0xd8562a,
    abilities: [
      { id: 'beam', name: 'REPULSOR BEAM', cooldown: 2.2, cost: 12, damage: 95, knockback: 26, carveRadius: 1.3 },
      { id: 'barrage', name: 'MISSILE BARRAGE', cooldown: 7, cost: 45, damage: 300, knockback: 40, carveRadius: 2.6 },
    ],
  },
  amazon: {
    id: 'amazon',
    name: 'AMAZON',
    tagline: 'warrior · charge slam · bracer deflect',
    model: 'assets/characters/amazon.glb',
    scale: 1,
    health: 1050,
    mass: 0.95,
    power: 1.15,
    runSpeed: 17,
    airSpeed: 26,
    canFly: false,
    hoverHold: false,
    jumpSpeed: 18,
    gravity: 28,
    dashSpeed: 58,
    dashTime: 0.35,
    dashCooldown: 1.1,
    energyRegen: 20,
    energyMax: 100,
    radius: 0.48,
    halfHeight: 0.94,
    eyeHeight: 1.55,
    reach: 2.6,
    color: 0xd8b23c,
    abilities: [
      { id: 'dash', name: 'AMAZON LUNGE', cooldown: 1.2, cost: 16, damage: 150, knockback: 48, carveRadius: 2.6 },
      { id: 'clap', name: 'BRACER SHOCKWAVE', cooldown: 5.5, cost: 38, damage: 130, knockback: 62, carveRadius: 3.4 },
    ],
  },
}

export const ARCHETYPE_LIST = Object.values(ARCHETYPES)

export interface MeleeSpec {
  damage: number
  knockback: number
  carveRadius: number
  /** Wind-up, active, recovery in seconds. */
  windup: number
  active: number
  recovery: number
  reach: number
  /** Radius of the capsule swept along the aim; this is the hit volume. */
  hitRadius: number
  /** Forward impulse added at the start of the swing, in m/s. */
  lunge: number
  /** Whether this hit can fling the target through buildings. */
  fling: boolean
}

export const LIGHT_ATTACK: MeleeSpec = {
  damage: 55,
  knockback: 18,
  carveRadius: 1.0,
  windup: 0.1,
  active: 0.09,
  recovery: 0.16,
  reach: 2.6,
  hitRadius: 0.85,
  lunge: 5.5,
  fling: false,
}

export const HEAVY_ATTACK: MeleeSpec = {
  damage: 130,
  knockback: 46,
  carveRadius: 2.0,
  windup: 0.26,
  active: 0.12,
  recovery: 0.34,
  reach: 3.1,
  hitRadius: 1.05,
  lunge: 8.5,
  fling: true,
}
