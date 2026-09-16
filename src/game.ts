import * as THREE from 'three'
import { Profiler } from './core/profiler'
import { Input } from './core/input'
import { generateBlueprint, type Blueprint } from './sdf/blueprint'
import { buildTextures, type TextureLibrary } from './render/textures'
import { buildMaterials, type MaterialLibrary } from './render/materials'
import { Pipeline, createSky, DEFAULT_SETTINGS, type RenderSettings } from './render/pipeline'
import { City, type CarveEvent } from './world/city'
import { CameraRig } from './render/cameraRig'
import { createDebugPanel, type DebugPanel } from './ui/debug'
import { clamp } from './core/util'
import { PhysWorld } from './physics/phys'
import { DebrisSystem, DustSystem, ScorchSystem } from './world/fx'
import { PropSystem } from './world/props'
import { DestructionSystem } from './world/destruction'
import { AbilityFx } from './world/fxBeams'
import { ModelCache } from './entities/models'
import { Character, type CharInput, type CharWorld, type ImpactEvent } from './entities/character'
import { FighterAI } from './entities/ai'
import { ARCHETYPES, ARCHETYPE_LIST, type AbilitySpec } from './entities/archetypes'
import { Hud } from './ui/hud'

/**
 * Game shell: renderer, world, fighters, combat arbitration and the loop.
 *
 * Implements CharWorld, so characters ask the game for damage delivery, world
 * smashing and camera feedback rather than reaching into systems directly.
 */

const PLAYER_SPAWN: [number, number, number] = [-13, 0, 9]
const FOE_SPAWN: [number, number, number] = [13, 0, -9]

export class Game implements CharWorld {
  readonly profiler = new Profiler()
  readonly scene = new THREE.Scene()
  readonly camera: THREE.PerspectiveCamera
  readonly rig = new CameraRig()
  readonly input: Input
  readonly pipeline: Pipeline
  readonly bp: Blueprint
  readonly tex: TextureLibrary
  readonly mats: MaterialLibrary
  readonly city: City
  readonly settings: RenderSettings = { ...DEFAULT_SETTINGS }

  // --- world systems ---
  readonly phys: PhysWorld
  readonly models = new ModelCache()
  readonly debris: DebrisSystem
  readonly dust: DustSystem
  readonly scorch: ScorchSystem
  readonly abilityFx = new AbilityFx()
  readonly destruction: DestructionSystem
  props: PropSystem | null = null

  // --- actors ---
  player!: Character
  foe!: Character
  ai!: FighterAI
  /** Drives the player when auto-battle (attract/demo) mode is on. */
  playerAI!: FighterAI
  playerIndex = 0
  matchState: 'loading' | 'intro' | 'fight' | 'ko' = 'loading'
  private koTimer = 0
  private introTimer = 0
  /** Seconds left of an explicitly requested camera recentre (C / middle mouse). */
  private recenterTimer = 0
  /** Wide orbit that frames both fighters (the `F` camera). */
  private wideOrbit = false
  /** Attract-mode round clock; caps a round so a stuck fight can't stall the loop. */
  private fightTimer = 0
  readonly ui: Hud

  readonly sun: THREE.DirectionalLight
  private readonly hemi: THREE.HemisphereLight
  private readonly ambient: THREE.AmbientLight
  // Late-afternoon key light: low enough that vertical facades catch real
  // light (a high sun only lights roofs and then everything reads as a dark
  // silhouette), angled so both the +X and +Z faces get raked.
  private readonly sunDir = new THREE.Vector3(0.55, 0.52, 0.65).normalize()
  /** Cool bounce from the shaded side so silhouettes never go pure black. */
  private readonly fill: THREE.DirectionalLight
  private debug!: DebugPanel
  private bootEl: HTMLElement | null
  private bootBar: HTMLElement | null
  private bootMsg: HTMLElement | null
  private accumulator = 0
  private readonly fixedDt = 1 / 60
  private lastTime = 0
  private debugAccum = 0
  private firstFrame = true
  running = false
  /** Orbit anchor used by `__SBS.follow()`; ignored unless `followAnchor` is set. */
  readonly spectator = new THREE.Vector3(0, 6, 0)
  followAnchor = false

  // input scratch
  private readonly plInput: CharInput = {
    moveX: 0,
    moveZ: 0,
    jump: false,
    sprint: false,
    descend: false,
    light: false,
    heavy: false,
    ability1: false,
    ability2: false,
    aimX: 0,
    aimY: 0,
    aimZ: 0,
  }
  private readonly actionHold = new Map<string, number>()
  private readonly camDir = new THREE.Vector3()
  private readonly carveScratch: CarveEvent[] = []
  private readonly shadowFocus = new THREE.Vector3()
  private shadowExtent = 95

  constructor(readonly canvas: HTMLCanvasElement) {
    this.pipeline = new Pipeline(canvas, this.settings)
    this.camera = new THREE.PerspectiveCamera(this.settings.fov, 16 / 9, 0.35, 2600)
    this.camera.position.set(70, 44, 110)
    this.input = new Input(canvas)

    this.bp = generateBlueprint(1337)
    this.tex = buildTextures(this.bp)
    this.mats = buildMaterials(this.tex)

    const sky = createSky(this.sunDir)
    sky.mesh.matrixAutoUpdate = false
    sky.mesh.updateMatrix()
    this.scene.add(sky.mesh)
    this.scene.fog = new THREE.FogExp2(sky.fogColor, 0.00082)
    this.scene.background = sky.fogColor

    // Three-point rig: warm key + shadow, cool fill, and a hemisphere for
    // sky/ground bounce. Ambient is kept low so form and shadow actually read.
    this.hemi = new THREE.HemisphereLight(0xdcebff, 0xa89a78, 3.5)
    this.scene.add(this.hemi)
    this.ambient = new THREE.AmbientLight(0xccd8e8, 1.25)
    this.scene.add(this.ambient)
    this.sun = new THREE.DirectionalLight(0xfff4de, 2.5)
    this.fill = new THREE.DirectionalLight(0x9dc4f0, 0.75)
    this.fill.position.set(-this.sunDir.x, 0.35, -this.sunDir.z)
    this.scene.add(this.fill)
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(2048, 2048)
    this.sun.shadow.camera.near = 4
    this.sun.shadow.camera.far = 620
    const sc = this.sun.shadow.camera
    sc.left = -95
    sc.right = 95
    sc.top = 95
    sc.bottom = -95
    this.sun.shadow.bias = -0.0008
    this.sun.shadow.normalBias = 0.35
    this.sun.shadow.radius = 2.2
    // Changing the frustum extents requires an explicit projection update,
    // otherwise the map silently stays at the default 10 m box.
    this.sun.shadow.camera.updateProjectionMatrix()
    this.scene.add(this.sun)
    this.scene.add(this.sun.target)

    this.city = new City(this.bp, this.mats, this.tex, this.profiler)
    this.scene.add(this.city.group)
    this.phys = new PhysWorld(this.city)

    this.debris = new DebrisSystem(this.mats)
    this.dust = new DustSystem(this.mats)
    this.scorch = new ScorchSystem(this.tex.scorch)
    this.scene.add(this.debris.mesh, this.dust.points, this.scorch.mesh, this.abilityFx.group)
    this.destruction = new DestructionSystem(
      this.city,
      this.debris,
      this.dust,
      this.scorch,
      { launchNear: () => 0 } as unknown as PropSystem,
      this.phys,
      this.rig,
      this.profiler,
    )

    this.ui = new Hud({
      onRestart: () => this.restart(),
      onSwap: () => this.swapPlayer(),
    })
    document.body.appendChild(this.ui.root)

    this.bootEl = document.getElementById('boot')
    this.bootBar = document.getElementById('boot-bar')
    this.bootMsg = document.getElementById('boot-msg')
  }

  // ------------------------------------------------------------ boot -------
  async boot(): Promise<void> {
    this.debug = createDebugPanel(this.settings, () => {
      this.pipeline.setSize(this.canvas.clientWidth, this.canvas.clientHeight)
      this.updatePixelScale()
    })
    this.resize()
    await this.generateCity()
    await this.loadActors()
    this.matchState = 'intro'
    this.introTimer = 2.2
    this.ui.announce('ROUND 1', `${this.player.arch.name} vs ${this.foe.arch.name}`, 2.0)
    this.start()
  }

  private async generateCity(): Promise<void> {
    await new Promise<void>((resolve) => {
      const t0 = performance.now()
      const step = (): void => {
        const status = this.city.stepGeneration(10)
        if (this.bootBar) this.bootBar.style.width = `${Math.round(status.progress * 100)}%`
        if (this.bootMsg) {
          this.bootMsg.textContent = `${status.label}  ·  ${Math.round(status.progress * 100)}%`
        }
        this.rig.setTarget(0, 24, 0)
        this.rig.yaw = 0.7
        this.rig.pitch = -0.25
        this.rig.targetDistance = 150
        this.rig.freeFly = true
        this.camera.position.set(120, 90, 150)
        this.camera.lookAt(0, 30, 0)
        this.sun.position.copy(this.sunDir).multiplyScalar(240)
        this.pipeline.render(this.scene, this.camera)
        if (status.done || performance.now() - t0 > 30000) resolve()
        else requestAnimationFrame(step)
      }
      requestAnimationFrame(step)
    })
  }

  private async loadActors(): Promise<void> {
    if (this.bootMsg) this.bootMsg.textContent = 'loading characters'
    const [propsRoot] = await Promise.all([
      this.models.load('assets/props/props.glb'),
      ...ARCHETYPE_LIST.map((a) => this.models.load(a.model)),
    ])
    this.props = new PropSystem(this.bp, propsRoot, this.mats)
    // Rebuild the destruction system with the real prop system.
    this.destruction.setProps(this.props)
    this.scene.add(this.props.group)

    this.player = this.makeCharacter(ARCHETYPE_LIST[this.playerIndex], PLAYER_SPAWN, true)
    this.foe = this.makeCharacter(ARCHETYPES.titan, FOE_SPAWN, false)
    this.ai = new FighterAI(this.foe, 0.6)
    this.playerAI = new FighterAI(this.player, 0.7)
    this.rig.freeFly = false
    this.followAnchor = false
    this.rig.setTarget(this.player.pos.x, this.player.pos.y + 1.2, this.player.pos.z)
    this.rig.snap()
    if (this.bootEl) this.bootEl.classList.add('hidden')
    this.debug.setVisible(true)
  }

  private makeCharacter(arch: (typeof ARCHETYPE_LIST)[number], spawn: [number, number, number], isPlayer: boolean): Character {
    const c = new Character(arch, spawn[0], spawn[2], isPlayer)
    const model = this.models.instantiate(arch.model, this.mats.characters, true)
    model.scale.setScalar(arch.scale)
    c.attachModel(model)
    this.scene.add(c.model!)
    c.placeAt(spawn[0], arch.halfHeight + 0.05, spawn[2], isPlayer ? Math.PI : 0)
    return c
  }

  // ------------------------------------------------------------ loop -------
  start(): void {
    if (this.running) return
    this.running = true
    this.lastTime = performance.now()
    requestAnimationFrame(this.frame)
  }

  resize(): void {
    const w = this.canvas.clientWidth || window.innerWidth
    const h = this.canvas.clientHeight || window.innerHeight
    this.canvas.width = w
    this.canvas.height = h
    this.pipeline.setSize(w, h)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.updatePixelScale()
  }

  /** Keep point-sprite sizes in world units across resolution/FOV changes. */
  private updatePixelScale(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const px = (this.canvas.clientHeight || 720) * dpr * this.settings.renderScale
    const scale = px / (2 * Math.tan((this.camera.fov * Math.PI) / 360))
    this.mats.dust.uniforms.uPixelScale.value = scale
  }

  /**
   * Park both fighters in front of a specific building, facing it — the setup
   * used by the capture scenarios that demonstrate ramming/collapsing.
   */
  warpToBuilding(index: number, dist = 26, height = -1, lateral = 0, foeBeyond = true): string {
    const list = this.city.destructibles
    const rt = list[((index % list.length) + list.length) % list.length]
    const half = Math.max(rt.x1 - rt.x0, rt.z1 - rt.z0) * 0.5
    const h = height >= 0 ? height : clamp(rt.spec.h * 0.42, 2.5, 46)
    // March out from the facade until the point is actually in open air, so
    // scripted runs always start on the street rather than inside a neighbour.
    let z = rt.z1 + dist
    for (let i = 0; i < 40 && this.phys.distance(rt.cx + lateral, h, z) < 1.2; i++) z += 2
    this.frozen = false
    this.rig.freeFly = false
    this.followAnchor = false
    this.aiEnabled = false
    this.player.placeAt(rt.cx + lateral, h, z, Math.PI)
    // Park the opponent on the far side so a dash has to go *through* the tower.
    let foeZ = foeBeyond ? rt.z0 - dist * 0.55 : z + 6
    for (let i = 0; i < 40 && this.phys.distance(rt.cx, Math.max(2.2, h), foeZ) < 1.2; i++) foeZ -= 2
    this.foe.placeAt(rt.cx - lateral * 0.5, Math.max(2.2, h), foeZ, 0)
    this.ai.reset()
    this.rig.yaw = Math.PI
    this.rig.pitch = -0.12
    this.rig.targetDistance = clamp(dist * 0.75, 12, 34)
    this.rig.snap()
    this.matchState = 'fight'
    return `${rt.spec.id}:${rt.spec.h.toFixed(0)}m half=${half.toFixed(1)}`
  }

  /** Line up every archetype for inspection (model review / captures). */
  showcase(): void {
    this.frozen = true
    this.rig.freeFly = false
    this.followAnchor = false
    const list = ARCHETYPE_LIST
    const spacing = 3.1
    while (this.extras.length < list.length - 2) {
      const arch = list[this.extras.length + 2]
      const c = this.makeCharacter(arch, [0, 0, 0], false)
      this.extras.push(c)
    }
    const cast = [this.player, this.foe, ...this.extras]
    for (let i = 0; i < cast.length; i++) {
      const c = cast[i]
      const x = (i - (cast.length - 1) / 2) * spacing
      c.placeAt(x, c.arch.halfHeight + 0.02, 4, 0)
      c.state = 'idle'
      c.model!.visible = true
    }
    this.rig.setTarget(0, 1.5, 4)
    this.rig.yaw = 0.22
    this.rig.pitch = -0.05
    this.rig.targetDistance = 12
    this.rig.snap()
  }

  setFrozen(v: boolean): void {
    this.frozen = v
  }

  setAiEnabled(v: boolean): void {
    this.aiEnabled = v
  }

  /** Attract mode: hand the player over to the AI so the fight plays itself. */
  setAutoBattle(v: boolean): void {
    this.autoBattle = v
    if (v && this.playerAI) this.playerAI.reset()
  }

  private frame = (now: number): void => {
    if (!this.running) return
    this.profiler.begin()
    this.profiler.resetFrameCounters()
    const rawDt = Math.min(0.08, (now - this.lastTime) / 1000)
    this.lastTime = now

    const tSim = performance.now()
    this.accumulator += rawDt * this.destruction.timeScale
    let steps = 0
    while (this.accumulator >= this.fixedDt && steps < 3) {
      this.simStep(this.fixedDt)
      this.accumulator -= this.fixedDt
      steps++
    }
    if (steps === 3) this.accumulator = 0
    this.profiler.simMs.push(performance.now() - tSim)

    const tMesh = performance.now()
    if (this.city.generating) this.city.stepGeneration(6)
    else this.city.tick()
    this.profiler.meshMs.push(performance.now() - tMesh)

    this.destruction.update(rawDt)
    this.updateSchedules(rawDt)
    this.abilityFx.update(rawDt)
    this.props?.update(rawDt, this.phys)
    this.updateCamera(rawDt)
    // Freeze/attract-mode frames are captures, not play: don't stamp the prompt
    // over them.
    this.ui.setPointerCaptured(this.input.pointerLocked || this.frozen || this.autoBattle)
    this.ui.setRecoverPrompt(!this.frozen && !this.autoBattle && this.player.flingRecoverable)
    this.ui.update(rawDt, this.player, this.foe)
    this.updateMatch(rawDt)

    // Keep the shadow frustum on the fighters, not the camera: the camera can be
    // 25 m behind, and the player always cares about what is around them.
    this.shadowFocus.set(
      (this.player.pos.x + this.camera.position.x * 0.35) / 1.35,
      (this.player.pos.y + this.camera.position.y * 0.35) / 1.35,
      (this.player.pos.z + this.camera.position.z * 0.35) / 1.35,
    )
    this.sun.position.copy(this.shadowFocus).addScaledVector(this.sunDir, 260)
    this.sun.target.position.copy(this.shadowFocus)
    this.sun.target.updateMatrixWorld()

    // Widen the shadow frustum as the camera pulls back, so an out-of-frustum
    // edge never cuts a hard shadow line across the ground (visible from the
    // overview camera). Tight when close, coarse but complete when far.
    const camDist = this.camera.position.distanceTo(this.shadowFocus)
    const ext = clamp(70 + camDist * 0.75, 95, 300)
    if (Math.abs(ext - this.shadowExtent) > 6) {
      this.shadowExtent = ext
      const sc = this.sun.shadow.camera
      sc.left = -ext
      sc.right = ext
      sc.top = ext
      sc.bottom = -ext
      sc.updateProjectionMatrix()
    }

    const tRender = performance.now()
    this.pipeline.tick(now * 0.001)
    this.pipeline.render(this.scene, this.camera)
    this.profiler.renderMs.push(performance.now() - tRender)
    this.profiler.drawCalls = this.pipeline.sceneCalls
    this.profiler.triangles = this.pipeline.sceneTriangles
    this.profiler.activeDebris = this.debris.activeCount
    this.profiler.sleepingDebris = this.debris.sleeping
    this.profiler.dustParticles = this.dust.alive
    this.profiler.entities = 2 + (this.props?.active ?? 0) + (this.props?.staticGroups ?? 0)
    this.profiler.destroyedBuildings = this.destruction.buildingsTorn

    this.input.endFrame()
    this.profiler.end(rawDt)

    this.debugAccum += rawDt
    if (this.debugAccum > 0.2) {
      this.debugAccum = 0
      this.debug.update(this.debugLines())
    }
    if (this.firstFrame) {
      this.firstFrame = false
      this.rig.snap()
    }
    requestAnimationFrame(this.frame)
  }

  // ------------------------------------------------------------ sim --------
  private simStep(dt: number): void {
    const destruction = this.destruction
    // Debris/dust run on the sim clock so hitstop reads on them too.
    this.debris.update(dt, this.phys)
    this.dust.update(dt)
    this.scorch.update(dt)

    if (this.frozen) {
      this.debris.update(dt, this.phys)
      this.dust.update(dt)
      return
    }
    const pin = this.autoBattle && this.player.state !== 'dead'
      ? this.playerAI.update(dt, this.foe, this)
      : this.readPlayerInput(dt)
    this.player.update(dt, pin, this)
    if (this.player.state !== 'dead' && this.aiEnabled) {
      const ain = this.ai.update(dt, this.player, this)
      this.foe.update(dt, ain, this)
    } else {
      const idle = { ...ain0 }
      this.foe.update(dt, idle, this)
    }

    // Head-to-head body collision so fighters do not occupy the same space.
    this.separateBodies()

    if (this.player.state === 'dead' || this.foe.state === 'dead') {
      if (this.matchState !== 'ko') {
        this.matchState = 'ko'
        this.koTimer = 0
        const loser = this.player.state === 'dead' ? this.player : this.foe
        const winner = loser === this.player ? this.foe : this.player
        this.ui.announce(`${loser.arch.name} DOWN`, `${winner.arch.name} WINS · PRESS R TO RESTART`, 5)
        this.destruction.hitstopTimer = Math.max(this.destruction.hitstopTimer, 0.25)
      }
    }
    destruction.syncStats()
  }

  private separateBodies(): void {
    const a = this.player
    const b = this.foe
    if (a.state === 'dead' || b.state === 'dead') return
    const dx = b.pos.x - a.pos.x
    const dy = b.pos.y - a.pos.y
    const dz = b.pos.z - a.pos.z
    const minDist = a.arch.radius + b.arch.radius
    const dist = Math.hypot(dx, dy, dz)
    if (dist > minDist || dist < 1e-4) return
    const push = (minDist - dist) * 0.5
    const nx = dx / dist
    const ny = dy / dist
    const nz = dz / dist
    const ma = a.arch.mass
    const mb = b.arch.mass
    const total = ma + mb
    a.pos.x -= nx * push * ((2 * mb) / total)
    a.pos.z -= nz * push * ((2 * mb) / total)
    b.pos.x += nx * push * ((2 * ma) / total)
    b.pos.z += nz * push * ((2 * ma) / total)
    if (Math.abs(dy) > minDist * 0.7) {
      a.pos.y -= ny * push * 0.4
      b.pos.y += ny * push * 0.4
    }
  }

  private readPlayerInput(dt: number): CharInput {
    const inp = this.plInput
    // Camera-relative movement.
    const f = this.rig.yaw
    const fx = -Math.sin(f)
    const fz = -Math.cos(f)
    const rx = -fz
    const rz = fx
    let ax = 0
    let az = 0
    if (this.input.has('KeyW') || this.input.has('ArrowUp')) az += 1
    if (this.input.has('KeyS') || this.input.has('ArrowDown')) az -= 1
    if (this.input.has('KeyD') || this.input.has('ArrowRight')) ax += 1
    if (this.input.has('KeyA') || this.input.has('ArrowLeft')) ax -= 1
    inp.moveX = fx * az + rx * ax
    inp.moveZ = fz * az + rz * ax
    inp.jump = this.input.has('Space')
    inp.sprint = this.input.has('ShiftLeft') || this.input.has('ShiftRight')
    inp.descend = this.input.has('ControlLeft') || this.input.has('KeyC')
    inp.light = this.input.buttonPressed(0) || this.input.justPressed('KeyJ')
    inp.heavy = this.input.buttonPressed(2) || this.input.justPressed('KeyK')
    inp.ability1 = this.input.justPressed('KeyQ')
    inp.ability2 = this.input.justPressed('KeyE')
    // Punches, lunges and flight heading all follow the camera, so aiming is
    // literally where you look.
    this.camera.getWorldDirection(this.camDir)
    inp.aimX = this.camDir.x
    inp.aimY = this.camDir.y
    inp.aimZ = this.camDir.z

    // Scripted actions (capture tooling) hold for a short window.
    for (const [name, t] of this.actionHold) {
      const next = t - dt
      if (next <= 0) this.actionHold.delete(name)
      else this.actionHold.set(name, next)
      switch (name) {
        case 'move_forward':
          inp.moveX = fx
          inp.moveZ = fz
          break
        case 'jump':
          inp.jump = true
          break
        case 'light':
          inp.light = true
          break
        case 'heavy':
          inp.heavy = true
          break
        case 'ability1':
          inp.ability1 = true
          break
        case 'ability2':
          inp.ability2 = true
          break
        default:
          break
      }
    }
    return inp
  }

  /** Queue a one-shot player action for `hold` seconds (used by scenarios). */
  queueAction(name: string, hold = 0.12): void {
    this.actionHold.set(name, hold)
  }

  // ------------------------------------------------------------ camera -----
  private updateCamera(dt: number): void {
    if (this.rig.freeFly) {
      this.rig.update(dt, this.camera, this.city)
      return
    }
    const p = this.player
    const f = this.foe

    // Mouse look + zoom. The rig owned yaw/pitch from the start but nothing ever
    // fed it pointer deltas, so the camera was fixed and the game read as if the
    // player had no control.
    this.rig.look(this.input.mouseDX, this.input.mouseDY)
    if (this.input.wheel !== 0) this.rig.zoom(this.input.wheel)
    // Explicit recentre: the player asks for the opponent to be brought into
    // view rather than the camera doing it behind their back.
    if (this.input.justPressed('KeyC') || this.input.buttonPressed(1)) this.recenterTimer = 0.5
    if (Math.abs(this.input.mouseDX) + Math.abs(this.input.mouseDY) > 0.5) this.recenterTimer = 0

    // Capture tooling can anchor the orbit to a fixed world point (used by the
    // `street` and `storefront` scenarios) instead of chasing the player.
    if (this.followAnchor) {
      this.rig.setTarget(this.spectator.x, this.spectator.y, this.spectator.z)
      this.rig.update(dt, this.camera, this.city)
      return
    }

    // On foot a small bias toward the opponent keeps the fight framed. In the air
    // that bias is what made the camera feel unpredictable: you are moving fast
    // and the foe keeps dragging the focus sideways. Flight nearly drops it, and
    // the offset is capped in *metres* — as a pure fraction it grew with
    // separation, so a distant opponent shifted the player right off centre.
    const dx = f.pos.x - p.pos.x
    const dy = f.pos.y - p.pos.y
    const dz = f.pos.z - p.pos.z
    const flight = p.flying
    const bias = this.wideOrbit ? 0.42 : flight ? 0.04 : 0.16
    const lift = this.wideOrbit ? 2.6 : flight ? 1.9 : 1.4
    let ox = dx * bias
    let oy = dy * bias * 0.5
    let oz = dz * bias
    const cap = this.wideOrbit ? Infinity : flight ? 1 : 3
    const oLen = Math.hypot(ox, oy, oz)
    if (oLen > cap) {
      const k = cap / oLen
      ox *= k
      oy *= k
      oz *= k
    }
    this.rig.setTarget(p.pos.x + ox, p.pos.y + lift + oy, p.pos.z + oz)

    // Camera yaw is the player's, full stop. The only automatic motion is the
    // explicit recentre below — anything else fights camera-relative movement,
    // and an assist that swings the view is exactly what makes a camera feel
    // unpredictable.
    if (this.recenterTimer > 0) {
      this.recenterTimer -= dt
      const want = Math.atan2(-dx, -dz)
      let off = want - this.rig.yaw
      off = Math.atan2(Math.sin(off), Math.cos(off))
      this.rig.yaw += off * Math.min(1, dt * 9)
      if (Math.abs(off) < 0.02) this.recenterTimer = 0
    }

    // Keep the boom stable: the old rig scaled distance all the way to 26 m as
    // the fighters separated, which pulled the camera off the player. In flight
    // it stretches a little with speed so you can see where you are going.
    const apart = Math.hypot(dx, dy, dz)
    this.rig.targetDistance = this.wideOrbit
      ? clamp(20 + apart * 0.2, 20, 30)
      : flight
        ? clamp(10 + p.vel.length() * 0.055, 10, 15)
        : clamp(8.5 + apart * 0.08, 8.5, 13)
    this.rig.update(dt, this.camera, this.city)
  }

  private updateMatch(dt: number): void {
    if (this.matchState === 'intro') {
      this.introTimer -= dt
      if (this.introTimer <= 0) {
        this.matchState = 'fight'
        this.fightTimer = 0
        this.ui.announce('FIGHT', '', 1.0)
      }
    } else if (this.matchState === 'fight') {
      this.fightTimer += dt
      // Attract mode: if neither fighter can finish it, reset rather than idle.
      if (this.autoBattle && this.fightTimer > 32) this.restart()
    } else if (this.matchState === 'ko') {
      this.koTimer += dt
      // Attract mode keeps rolling: after the KO card has been up a moment,
      // reset so the brawl never idles on a finished match.
      if (this.autoBattle && this.koTimer > 3.5) this.restart()
    }
  }

  // ------------------------------------------------------- CharWorld -------
  other(self: Character): Character | null {
    if (self === this.player) return this.foe
    if (self === this.foe) return this.player
    return null
  }

  onImpact(ev: ImpactEvent): void {
    this.destruction.onImpact({
      x: ev.x,
      y: ev.y,
      z: ev.z,
      radius: ev.radius,
      speed: ev.speed,
      kind: ev.kind,
      nx: ev.nx,
      ny: ev.ny,
      nz: ev.nz,
      px: ev.source?.pos.x,
      py: ev.source?.pos.y,
      pz: ev.source?.pos.z,
    })
  }

  onHit(
    attacker: Character,
    target: Character,
    damage: number,
    dx: number,
    dy: number,
    dz: number,
    impulse: number,
    fling: boolean,
  ): void {
    target.takeHit(damage, dx, dy, dz, impulse, fling, attacker.arch.id)
    attacker.damageDealt += damage
    attacker.hitsLanded++
    const hx = (attacker.pos.x + target.pos.x) * 0.5
    const hy = (attacker.pos.y + target.pos.y) * 0.5
    const hz = (attacker.pos.z + target.pos.z) * 0.5
    this.dust.spawn(hx, hy, hz, fling ? 14 : 6, 1.5, fling ? 9 : 4, 0.3)
    this.abilityFx.flash(hx, hy, hz, fling ? 4 : 2, 0xfff0c0)
    this.rig.addShake(fling ? 0.5 : 0.2)
    this.destruction.hitstopTimer = Math.max(this.destruction.hitstopTimer, fling ? 0.09 : 0.045)
    if (target.isPlayer) this.ui.flashDamage(clamp(damage / target.maxHealth, 0, 1))
  }

  onAbility(self: Character, ability: AbilitySpec): void {
    const a = self.arch
    switch (ability.id) {
      case 'beam':
        this.fireBeam(self, ability)
        break
      case 'barrage': {
        for (let i = 0; i < 6; i++) {
          this.schedule(i * 0.09, () => {
            if (self.state !== 'dead') this.fireBeam(self, { ...ability, carveRadius: 1.1, damage: ability.damage / 4 })
          })
        }
        break
      }
      case 'clap':
        this.shockwave(self, ability)
        break
      case 'pound':
        this.abilityFx.ring(self.pos.x, self.pos.y, self.pos.z, 6, a.color, 0.3)
        break
      default:
        // dash / slam: the motion itself does the work
        this.abilityFx.ring(self.pos.x, Math.max(0.2, self.pos.y - a.halfHeight), self.pos.z, 3, a.color, 0.28)
        break
    }
  }

  private readonly schedules: { t: number; fn: () => void }[] = []

  private schedule(delay: number, fn: () => void): void {
    this.schedules.push({ t: delay, fn })
  }

  private updateSchedules(dt: number): void {
    if (this.schedules.length === 0) return
    for (let i = this.schedules.length - 1; i >= 0; i--) {
      const s = this.schedules[i]
      s.t -= dt
      if (s.t <= 0) {
        this.schedules.splice(i, 1)
        s.fn()
      }
    }
  }

  private fireBeam(self: Character, ability: AbilitySpec): void {
    const a = self.arch
    const eye = self.pos.y + a.eyeHeight - a.halfHeight
    const originX = self.pos.x + Math.sin(self.yaw) * a.radius
    const originZ = self.pos.z + Math.cos(self.yaw) * a.radius
    let dx = Math.sin(self.yaw)
    let dy = 0
    let dz = Math.cos(self.yaw)
    if (self.isPlayer) {
      this.camera.getWorldDirection(this.camDir)
      dx = this.camDir.x
      dy = this.camDir.y
      dz = this.camDir.z
    } else {
      const foe = this.other(self)
      if (foe) {
        const fx = foe.pos.x - originX
        const fy = foe.pos.y - eye
        const fz = foe.pos.z - originZ
        const len = Math.max(0.001, Math.hypot(fx, fy, fz))
        dx = fx / len
        dy = fy / len
        dz = fz / len
      }
    }
    const len = Math.max(0.001, Math.hypot(dx, dy, dz))
    dx /= len
    dy /= len
    dz /= len

    // Find where the beam stops (first building hit) — mirrors the carve.
    let maxDist = 120
    const step = 1.6
    for (let d = 2; d < maxDist; d += step) {
      const px = originX + dx * d
      const py = eye + dy * d
      const pz = originZ + dz * d
      if (this.phys.distance(px, py, pz) < ability.carveRadius) {
        maxDist = d
        break
      }
    }
    const endX = originX + dx * maxDist
    const endY = eye + dy * maxDist
    const endZ = originZ + dz * maxDist
    const out: CarveEvent[] = this.carveScratch
    out.length = 0
    this.city.carveSegment(originX, eye, originZ, endX, endY, endZ, ability.carveRadius, out)
    this.abilityFx.beam(originX, eye, originZ, dx, dy, dz, maxDist, ability.carveRadius * 0.55, a.color)
    this.dust.spawn(endX, endY, endZ, 12, ability.carveRadius * 1.4, 7, 0.3)
    this.dust.spawn(originX + dx * 6, eye + dy * 6, originZ + dz * 6, 4, 1.2, 3, 0)
    for (const c of out) {
      if (c.res.changed > 40) {
        const collapse = this.city.tryCollapse(c.rt, 0.12, 0.36)
        if (collapse) this.destruction.onImpact({ x: endX, y: endY, z: endZ, radius: 0.1, speed: 10, kind: 'beam', nx: 0, ny: 1, nz: 0 })
      }
    }
    this.rig.addShake(0.1)

    // Damage anyone standing in the beam.
    const foe = this.other(self)
    if (foe && foe.state !== 'dead') {
      const t = (foe.pos.x - originX) * dx + (foe.pos.y - eye) * dy + (foe.pos.z - originZ) * dz
      if (t > 0 && t < maxDist) {
        const px = originX + dx * t
        const py = eye + dy * t
        const pz = originZ + dz * t
        const dist = Math.hypot(foe.pos.x - px, foe.pos.y - py, foe.pos.z - pz)
        if (dist < ability.carveRadius + foe.arch.radius) {
          this.onHit(self, foe, ability.damage, dx, 0.35, dz, ability.knockback, false)
        }
      }
    }
  }

  private shockwave(self: Character, ability: AbilitySpec): void {
    const a = self.arch
    const y = Math.max(0.4, self.pos.y - a.halfHeight * 0.6)
    const out: CarveEvent[] = this.carveScratch
    out.length = 0
    const radius = ability.carveRadius * 1.5
    for (let i = 0; i < 6; i++) {
      const ang = (i / 6) * Math.PI * 2
      this.city.carveSphere(self.pos.x + Math.cos(ang) * radius * 0.6, y, self.pos.z + Math.sin(ang) * radius * 0.6, radius * 0.7, out)
    }
    this.abilityFx.ring(self.pos.x, self.pos.y - a.halfHeight + 0.3, self.pos.z, radius * 2.2, a.color, 0.5)
    this.abilityFx.flash(self.pos.x, y, self.pos.z, radius, 0xffffff)
    this.dust.spawn(self.pos.x, y + 0.5, self.pos.z, 40, radius * 1.3, 16, 0.35)
    this.props?.launchNear(self.pos.x, y, self.pos.z, radius * 3, ability.knockback * 0.5, 1.0)
    this.rig.addShake(0.55)
    this.destruction.hitstopTimer = Math.max(this.destruction.hitstopTimer, 0.05)

    // Radial damage + launch.
    const foe = this.other(self)
    if (foe && foe.state !== 'dead') {
      const dx = foe.pos.x - self.pos.x
      const dy = foe.pos.y - self.pos.y
      const dz = foe.pos.z - self.pos.z
      const dist = Math.hypot(dx, dy, dz)
      const falloff = clamp(1 - dist / (radius * 3), 0, 1)
      if (falloff > 0.05) {
        const inv = 1 / Math.max(0.001, dist)
        this.onHit(self, foe, ability.damage * falloff, dx * inv, Math.abs(dy * inv) + 0.4, dz * inv, ability.knockback * falloff, true)
      }
    }
    for (const c of out) {
      const collapse = this.city.tryCollapse(c.rt, 0.12, 0.36)
      if (collapse) this.dust.spawn(self.pos.x, self.pos.y, self.pos.z, 10, radius, 6, 0.4)
    }
  }

  shake(amount: number): void {
    this.rig.addShake(amount)
  }

  hitstop(seconds: number): void {
    this.destruction.hitstopTimer = Math.max(this.destruction.hitstopTimer, seconds)
  }

  onKnockout(loser: Character): void {
    void loser
  }

  // ------------------------------------------------------------ helpers ----
  private debugLines(): string[] {
    const p = this.profiler
    const s = this.city.stats
    const d = this.destruction
    const pl = this.player
    const foe = this.foe
    const lines = [
      `fps ${p.fps.toFixed(0)}  frame p50 ${p.frameMs.percentile(0.5).toFixed(1)} p95 ${p.frameMs.percentile(0.95).toFixed(1)} ms`,
      `sim ${p.simMs.last.toFixed(1)}  mesh ${p.meshMs.last.toFixed(1)}  render ${p.renderMs.last.toFixed(1)} ms  scale ${d.timeScale.toFixed(2)}`,
      `draws ${p.drawCalls}  tris ${(p.triangles / 1000).toFixed(0)}k  res ${this.pipeline.internalWidth}x${this.pipeline.internalHeight}`,
      `city ${s.destructible} destructible / ${s.buildings} total  ${(s.cityTris / 1000).toFixed(0)}k tris`,
      `destroyed ${d.buildingsTorn}  chunks lost ${p.collapsedChunks}  carved ${(d.carvedVoxels / 1000).toFixed(0)}k vox`,
      `debris ${p.activeDebris} active / ${this.debris.total}  dust ${p.dustParticles}  props flying ${this.props?.active ?? 0}`,
      `chunk queue ${p.chunkJobsQueued}  meshed ${p.chunkJobsDone}  ${this.city.meshQueue.stats.mode}`,
      '',
      `${pl.arch.name}  hp ${pl.health.toFixed(0)}/${pl.maxHealth}  en ${pl.energy.toFixed(0)}  ${pl.state}  hits ${pl.hitsLanded}`,
      `${foe.arch.name}  hp ${foe.health.toFixed(0)}/${foe.maxHealth}  ${foe.state}  ai ${this.ai.state}`,
      `match ${this.matchState}  dist ${Math.hypot(foe.pos.x - pl.pos.x, foe.pos.z - pl.pos.z).toFixed(1)}m  alt ${(pl.pos.y).toFixed(1)}m`,
      '',
      '[~] panel  [F] free cam  [O] overview  [R] restart  [TAB] swap hero',
      '[LMB/J] light  [RMB/K] heavy  [Q] ability 1  [E] ability 2  [SPACE] fly',
    ]
    return lines
  }

  // ------------------------------------------------------------ actions ----
  restart(): void {
    this.city.reset()
    this.destruction.reset()
    this.profiler.resetDestructionCounters()
    this.debris.clear()
    this.dust.clear()
    this.abilityFx.clear()
    this.schedules.length = 0
    this.player.placeAt(PLAYER_SPAWN[0], this.player.arch.halfHeight + 0.05, PLAYER_SPAWN[2], Math.PI)
    this.foe.placeAt(FOE_SPAWN[0], this.foe.arch.halfHeight + 0.05, FOE_SPAWN[2], 0)
    this.player.resetStats()
    this.foe.resetStats()
    this.ai.reset()
    this.playerAI.reset()
    this.matchState = 'intro'
    this.introTimer = 1.6
    this.rig.freeFly = false
    this.followAnchor = false
    this.ui.announce('ROUND 1', 'FIGHT', 1.4)
    // The attract-mode loop restarts on every KO; don't flash the boot screen
    // for those, only for a deliberate player restart.
    if (this.bootEl && !this.autoBattle) {
      const el = this.bootEl
      el.classList.remove('hidden')
      window.setTimeout(() => el.classList.add('hidden'), 40)
    }
  }

  swapPlayer(archetypeId?: string): void {
    const list = ARCHETYPE_LIST
    const next = archetypeId ? list.findIndex((a) => a.id === archetypeId) : (this.playerIndex + 1) % list.length
    this.playerIndex = next < 0 ? 0 : next
    const arch = list[this.playerIndex]
    const old = this.player
    if (old.model) this.scene.remove(old.model)
    this.player = this.makeCharacter(arch, [old.pos.x, 0, old.pos.z], true)
    // The battle AI holds a reference to the character it drives, so rebuild it
    // against the freshly spawned player.
    this.playerAI = new FighterAI(this.player, 0.7)
    this.ui.announce(arch.name, arch.tagline, 1.6)
    this.rig.snap()
  }

  /** Extra characters spawned for model inspection. */
  readonly extras: Character[] = []
  /** Scenario switch: leave the opponent standing still. */
  aiEnabled = true
  /** Attract mode: the AI drives the player too, so the match plays itself. */
  autoBattle = false
  frozen = false

  /**
   * Dev helper: detonate destruction at a point. Routed through the destruction
   * system so it carves, checks structure, spawns debris/dust and shakes the
   * camera exactly like a real impact.
   */
  nuke(x: number, y: number, z: number, r: number): number {
    const before = this.profiler.carvedVoxels
    this.destruction.onImpact({ x, y: y - r * 0.25, z, radius: r, speed: 60, kind: 'pound', nx: 0, ny: 1, nz: 0 })
    this.destruction.onImpact({ x, y: y + r * 0.35, z, radius: r * 0.8, speed: 50, kind: 'slam', nx: 0, ny: 1, nz: 0 })
    return this.profiler.carvedVoxels - before
  }

  overview(distance = 300, height = 140, tilt = 1): void {
    this.rig.freeFly = true
    const r = distance * 0.62
    this.camera.position.set(r, height, r * tilt)
    this.camera.lookAt(0, 46, 0)
  }

  /**
   * Toggle the wide spectator orbit. Previously this flipped the rig into
   * `freeFly`, which places the camera and then never updates it again — the
   * view froze in place. Tooling that needs to own the camera outright still
   * sets `rig.freeFly` directly (see `camera()` / `overview()`).
   */
  toggleFreeFly(): void {
    this.wideOrbit = !this.wideOrbit
  }

  setDebugVisible(v: boolean): void {
    this.debug.setVisible(v)
  }

  toggleDebug(): void {
    this.debug.toggle()
  }

  get frameCount(): number {
    return this.profiler.frames
  }

  setSetting<K extends keyof RenderSettings>(k: K, v: RenderSettings[K]): void {
    this.settings[k] = v
    if (k === 'fov') {
      this.camera.fov = v as number
      this.camera.updateProjectionMatrix()
    }
    if (k === 'renderScale' || k === 'fov') {
      this.pipeline.setSize(this.canvas.clientWidth, this.canvas.clientHeight)
      this.updatePixelScale()
    }
    this.pipeline.applySettings()
  }

  frameStats(): Record<string, number> {
    return {
      ...this.profiler.toJSON(),
      ...this.city.stats,
      debrisActive: this.debris.activeCount,
      debrisTotal: this.debris.total,
      propsFlying: this.props?.active ?? 0,
      playerHealth: +this.player.health.toFixed(0),
      foeHealth: +this.foe.health.toFixed(0),
      playerState: 0,
      distance: +Math.hypot(this.foe.pos.x - this.player.pos.x, this.foe.pos.z - this.player.pos.z).toFixed(1),
      renderScale: this.settings.renderScale,
      timeScale: this.destruction.timeScale,
    }
  }
}

const ain0: CharInput = {
  moveX: 0,
  moveZ: 0,
  jump: false,
  sprint: false,
  descend: false,
  light: false,
  heavy: false,
  ability1: false,
  ability2: false,
  aimX: 0,
  aimY: 0,
  aimZ: 0,
}
