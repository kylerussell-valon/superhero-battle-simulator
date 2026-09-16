import type { Game } from '../game'
import type { RenderSettings } from '../render/pipeline'

/**
 * Automation surface used by scripts/shot.mjs and scripts/monitor.mjs.
 *
 * Everything the capture pipeline needs is reachable from `window.__SBS`, so a
 * CI/agent run can pose the camera, fire a scenario, read telemetry and pull a
 * PNG without any UI interaction.
 */
export interface SbsApi {
  version: string
  /** Escape hatch for scripted inspection (materials, scene, systems). */
  game: unknown
  /** True once city generation has finished and frames are being produced. */
  ready: boolean
  telemetry(): Record<string, number>
  camera(px: number, py: number, pz: number, tx: number, ty: number, tz: number): void
  overview(distance?: number, height?: number): void
  follow(x: number, y: number, z: number, yaw?: number, pitch?: number, dist?: number): void
  nuke(x: number, y: number, z: number, r: number): number
  nukeBuilding(index: number, atHeightRatio?: number): number
  collapseAll(): number
  set<K extends keyof RenderSettings>(key: K, value: RenderSettings[K]): void
  /** Open/close the pre-fight character select (used by the capture tooling). */
  select(show: boolean): void
  /** Start a match with explicit archetype indices. */
  fighters(playerIndex: number, foeIndex: number): void
  /** Camera control preferences (also settable at runtime from the console). */
  setInvertY(invert: boolean): void
  setSensitivity(radiansPerPixel: number): void
  ui(show: boolean): void
  /** Show/hide the fight HUD (health cards, banners, hints) for clean captures. */
  hud(show: boolean): void
  debug(show: boolean): void
  /** Latest rendered frame as a PNG data URL. */
  screenshot(): string
  /** Waits for `n` animation frames — handy for scripted scenarios. */
  frames(n: number): Promise<void>
  reset(): void
  /** Queue a player action ("light" | "heavy" | "ability1" | "ability2" | "jump" | "move_forward"). */
  action(name: string, hold?: number): void
  swapHero(id?: string): void
  playerInfo(): Record<string, unknown>
  /** Point the camera/player at the opponent (optionally offset in radians). */
  face(offset?: number): number
  teleport(x: number, y: number, z: number, yaw?: number): void
  /** Line up all archetypes for a model-inspection shot. */
  showcase(): void
  /** Freeze/unfreeze simulation (for clean capture poses). */
  freeze(v: boolean): void
  /** Park the fighters in front of destructible building `index`. */
  warpToBuilding(index: number, dist?: number, height?: number, lateral?: number, foeBeyond?: boolean): string
  /** Toggle the opponent AI (off for scripted demonstrations). */
  ai(enabled: boolean): void
  /** Attract mode: let the AI drive the player too, so the match plays itself. */
  autoBattle(enabled: boolean): void
  /** Set the camera rig yaw/pitch directly. */
  aim(yaw: number, pitch?: number): void
  hotkeys: Record<string, string>
}

declare global {
  interface Window {
    __SBS: SbsApi
  }
}

export function installApi(game: Game): SbsApi {
  const api: SbsApi = {
    version: '0.1.0',
    game: game as unknown,
    ready: false,
    telemetry: () => game.frameStats(),
    camera(px, py, pz, tx, ty, tz) {
      game.rig.freeFly = true
      game.camera.position.set(px, py, pz)
      game.camera.lookAt(tx, ty, tz)
    },
    overview(distance = 320, height = 150) {
      game.overview(distance, height)
    },
    follow(x, y, z, yaw, pitch, dist) {
      game.rig.freeFly = false
      game.spectator.set(x, y, z)
      game.followAnchor = true
      if (yaw !== undefined) game.rig.yaw = yaw
      if (pitch !== undefined) game.rig.pitch = pitch
      if (dist !== undefined) {
        game.rig.targetDistance = dist
        game.rig.snap()
      }
    },
    nuke(x, y, z, r) {
      return game.nuke(x, y, z, r)
    },
    nukeBuilding(index, atHeightRatio = 0.35) {
      const rt = game.city.destructibles[index % game.city.destructibles.length]
      if (!rt) return 0
      return game.nuke(rt.spec.x, rt.spec.h * atHeightRatio, rt.spec.z, 14)
    },
    collapseAll() {
      let n = 0
      for (const rt of game.city.destructibles) {
        if (game.city.tryCollapse(rt, 0, 1.1)) n++
      }
      return n
    },
    set(key, value) {
      game.setSetting(key, value)
    },
    select(show) {
      if (show) game.select.open()
      else game.select.close()
    },
    fighters(playerIndex, foeIndex) {
      game.startMatch(playerIndex, foeIndex)
    },
    setInvertY(invert) {
      game.rig.lookUpOnMouseUp = !invert
    },
    setSensitivity(radiansPerPixel) {
      game.rig.sense = radiansPerPixel
    },
    ui(show) {
      const el = document.getElementById('boot')
      if (el) el.style.display = show ? '' : 'none'
    },
    hud(show) {
      game.ui.root.style.display = show ? '' : 'none'
    },
    debug(show) {
      game.setDebugVisible(show)
    },
    screenshot() {
      return game.canvas.toDataURL('image/png')
    },
    frames(n) {
      return new Promise<void>((resolve) => {
        let i = 0
        const tick = (): void => {
          if (++i >= n) resolve()
          else requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
    },
    reset() {
      game.restart()
    },
    action(name, hold = 0.14) {
      game.queueAction(name, hold)
    },
    swapHero(id) {
      game.swapPlayer(id)
    },
    playerInfo() {
      const p = game.player
      const f = game.foe
      return {
        player: {
          arch: p.arch.id,
          hp: +p.health.toFixed(0),
          state: p.state,
          x: +p.pos.x.toFixed(1),
          y: +p.pos.y.toFixed(1),
          z: +p.pos.z.toFixed(1),
          vx: +p.vel.x.toFixed(1),
          vy: +p.vel.y.toFixed(1),
          vz: +p.vel.z.toFixed(1),
          grounded: p.grounded,
          dbg: p.dbg,
        },
        foe: { arch: f.arch.id, hp: +f.health.toFixed(0), state: f.state, x: +f.pos.x.toFixed(1), y: +f.pos.y.toFixed(1), z: +f.pos.z.toFixed(1) },
        match: game.matchState,
        distance: +Math.hypot(f.pos.x - p.pos.x, f.pos.z - p.pos.z).toFixed(2),
      }
    },
    face(offset = 0) {
      const p = game.player
      const f = game.foe
      const a = Math.atan2(f.pos.x - p.pos.x, f.pos.z - p.pos.z) + offset
      game.rig.yaw = a + Math.PI
      return a
    },
    teleport(x, y, z, yaw) {
      game.player.placeAt(x, y, z, yaw ?? game.player.yaw)
    },
    showcase() {
      game.showcase()
    },
    warpToBuilding(index, dist = 26, height = -1, lateral = 0, foeBeyond = true) {
      return game.warpToBuilding(index, dist, height, lateral, foeBeyond)
    },
    ai(enabled) {
      game.setAiEnabled(enabled)
    },
    autoBattle(enabled) {
      game.setAutoBattle(enabled)
    },
    aim(yaw, pitch = 0) {
      game.rig.yaw = yaw
      game.rig.pitch = pitch
      game.rig.snap()
    },
    freeze(v) {
      game.setFrozen(v)
    },
    hotkeys: {
      debug: 'Backquote',
      freeCamera: 'KeyF',
      recentre: 'KeyC',
      fighters: 'KeyM',
      nuke: 'KeyG',
      overview: 'KeyO',
      reset: 'KeyR',
    },
  }
  window.__SBS = api

  window.addEventListener('keydown', (e) => {
    // The pre-fight select owns the keyboard while it is up.
    if (game.select.isOpen && e.code !== 'KeyM' && e.code !== 'Escape') return
    switch (e.code) {
      case 'KeyM':
        if (!e.repeat) game.select.toggle()
        break
      case 'Backquote':
        game.toggleDebug()
        break
      case 'KeyF':
        game.toggleFreeFly()
        break
      case 'KeyO':
        game.overview()
        break
      case 'KeyG': {
        const t = game.rig.target
        game.nuke(t.x, t.y + 4, t.z, 12)
        break
      }
      case 'KeyR':
        game.restart()
        break
      case 'Tab':
        game.swapPlayer()
        break
      default:
        break
    }
  })
  return api
}
