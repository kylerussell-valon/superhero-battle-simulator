import type { Character } from '../entities/character'

/**
 * Fight HUD. Plain DOM (no canvas text, no GPU passes) so it costs nothing on
 * the render side, updated at ~15 Hz.
 *
 * Layout: both fighter cards at the top (name, health, energy, ability pips), a
 * centre banner for round state, and a compact hint strip at the bottom.
 */
export interface HudCallbacks {
  onRestart(): void
  onSwap(): void
}

export class Hud {
  readonly root: HTMLElement
  private readonly leftBar: HTMLElement
  private readonly rightBar: HTMLElement
  private readonly leftEnergy: HTMLElement
  private readonly rightEnergy: HTMLElement
  private readonly leftPips: HTMLElement[] = []
  private readonly rightPips: HTMLElement[] = []
  private readonly leftName: HTMLElement
  private readonly rightName: HTMLElement
  private readonly banner: HTMLElement
  private readonly sub: HTMLElement
  private readonly damage: HTMLElement
  private readonly lockHint: HTMLElement
  private lastUpdate = 0
  private bannerTimer = 0
  private damageTimer = 0

  constructor(cb: HudCallbacks) {
    this.root = document.createElement('div')
    this.root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:10;font-family:ui-monospace,Menlo,monospace;'

    const card = (align: 'left' | 'right'): string =>
      `position:absolute;top:14px;${align}:16px;width:min(38vw,420px);display:flex;flex-direction:column;gap:5px;` +
      `align-items:${align === 'left' ? 'flex-start' : 'flex-end'};`

    const makeCard = (align: 'left' | 'right'): { box: HTMLElement; name: HTMLElement; bar: HTMLElement; energy: HTMLElement; pips: HTMLElement[] } => {
      const box = document.createElement('div')
      box.style.cssText = card(align)
      const name = document.createElement('div')
      name.style.cssText =
        'font-size:15px;letter-spacing:0.22em;color:#fff;text-shadow:0 2px 0 rgba(0,0,0,0.65),0 0 12px rgba(120,180,255,0.45);'
      const bar = document.createElement('div')
      bar.style.cssText = 'width:100%;height:16px;border:2px solid rgba(255,255,255,0.7);background:rgba(10,14,26,0.72);box-shadow:0 3px 0 rgba(0,0,0,0.5);'
      const fill = document.createElement('i')
      fill.style.cssText = 'display:block;height:100%;width:100%;background:linear-gradient(90deg,#5ce07a,#d8f36a);'
      bar.appendChild(fill)
      const energy = document.createElement('div')
      energy.style.cssText = 'width:60%;height:6px;background:rgba(10,14,26,0.72);border:1px solid rgba(255,255,255,0.35);'
      const efill = document.createElement('i')
      efill.style.cssText = 'display:block;height:100%;width:100%;background:#6fd6ff;'
      energy.appendChild(efill)
      const pips = document.createElement('div')
      pips.style.cssText = 'display:flex;gap:6px;'
      const pipEls: HTMLElement[] = []
      for (let i = 0; i < 2; i++) {
        const pip = document.createElement('div')
        pip.style.cssText = 'font-size:10px;letter-spacing:0.12em;padding:2px 6px;border:1px solid rgba(255,255,255,0.4);color:#cfe3ff;background:rgba(10,14,26,0.6);'
        pips.appendChild(pip)
        pipEls.push(pip)
      }
      box.append(name, bar, energy, pips)
      this.root.appendChild(box)
      return { box, name, bar: fill, energy: efill, pips: pipEls }
    }

    const l = makeCard('left')
    const r = makeCard('right')
    this.leftName = l.name
    this.rightName = r.name
    this.leftBar = l.bar
    this.rightBar = r.bar
    this.leftEnergy = l.energy
    this.rightEnergy = r.energy
    this.leftPips.push(...l.pips)
    this.rightPips.push(...r.pips)

    this.banner = document.createElement('div')
    this.banner.style.cssText =
      'position:absolute;top:38%;left:0;right:0;text-align:center;font-size:min(9vw,74px);letter-spacing:0.1em;color:#ffe066;' +
      'text-shadow:0 4px 0 #a15c00,0 0 30px rgba(255,190,60,0.55);opacity:0;transition:opacity 160ms;'
    this.sub = document.createElement('div')
    this.sub.style.cssText =
      'position:absolute;top:calc(38% + min(11vw,88px));left:0;right:0;text-align:center;font-size:13px;letter-spacing:0.3em;color:#dce9ff;opacity:0;transition:opacity 160ms;'
    this.damage = document.createElement('div')
    this.damage.style.cssText =
      'position:absolute;inset:0;background:radial-gradient(120% 90% at 50% 50%, rgba(255,0,0,0) 45%, rgba(255,40,40,0.75) 100%);opacity:0;transition:opacity 200ms;'

    const hints = document.createElement('div')
    hints.style.cssText =
      'position:absolute;bottom:10px;left:0;right:0;text-align:center;font-size:10.5px;letter-spacing:0.16em;color:#9fb6d6;text-shadow:0 2px 0 #000;'
    hints.innerHTML =
      'WASD MOVE · SHIFT SPRINT · SPACE JUMP/FLY · MOUSE LOOK · WHEEL ZOOM · C RECENTRE · LMB/J LIGHT · RMB/K HEAVY · Q ABILITY 1 · E ABILITY 2 · R RESET · TAB SWAP · ~ TELEMETRY'

    // Shown until the pointer is captured: otherwise a player can be moving and
    // attacking without ever realising the mouse is not driving the camera.
    this.lockHint = document.createElement('div')
    this.lockHint.style.cssText =
      'position:absolute;top:52%;left:0;right:0;text-align:center;font-size:12px;letter-spacing:0.24em;color:#ffe066;text-shadow:0 2px 0 #000,0 0 18px #ffb70355;'
    this.lockHint.textContent = 'CLICK TO CAPTURE MOUSE'

    const buttons = document.createElement('div')
    buttons.style.cssText = 'position:absolute;bottom:34px;left:50%;transform:translateX(-50%);display:flex;gap:10px;pointer-events:auto;'
    const mk = (label: string, fn: () => void): HTMLElement => {
      const b = document.createElement('button')
      b.textContent = label
      b.style.cssText =
        'font:inherit;font-size:11px;letter-spacing:0.14em;padding:6px 12px;color:#dfe8ff;background:rgba(12,20,38,0.82);border:1px solid #3a5a9a;cursor:pointer;'
      b.addEventListener('click', fn)
      return b
    }
    buttons.append(mk('RESTART', cb.onRestart), mk('SWAP HERO', cb.onSwap))

    this.root.append(this.damage, this.banner, this.sub, this.lockHint, hints, buttons)
  }

  /** Prompt for pointer capture until the mouse actually drives the camera. */
  setPointerCaptured(captured: boolean): void {
    this.lockHint.style.display = captured ? 'none' : ''
  }

  /** Show a centre banner for `seconds`. */
  announce(text: string, sub = '', seconds = 1.6): void {
    this.banner.textContent = text
    this.sub.textContent = sub
    this.banner.style.opacity = '1'
    this.sub.style.opacity = '1'
    this.bannerTimer = seconds
  }

  flashDamage(amount: number): void {
    this.damage.style.opacity = String(Math.min(0.85, 0.25 + amount))
    this.damageTimer = 0.35
  }

  update(dt: number, player: Character, foe: Character): void {
    this.bannerTimer -= dt
    if (this.bannerTimer <= 0 && this.banner.style.opacity !== '0') {
      this.banner.style.opacity = '0'
      this.sub.style.opacity = '0'
    }
    if (this.damageTimer > 0) {
      this.damageTimer -= dt
      if (this.damageTimer <= 0) this.damage.style.opacity = '0'
    }
    this.lastUpdate += dt
    if (this.lastUpdate < 0.066) return
    this.lastUpdate = 0

    this.leftName.textContent = `${player.arch.name}${player.state === 'dead' ? ' — KO' : ''}`
    this.rightName.textContent = `${foe.arch.name}${foe.state === 'dead' ? ' — KO' : ''}`
    this.leftBar.style.width = `${Math.max(0, (player.health / player.maxHealth) * 100).toFixed(0)}%`
    this.rightBar.style.width = `${Math.max(0, (foe.health / foe.maxHealth) * 100).toFixed(0)}%`
    this.leftBar.style.background = healthColor(player.health / player.maxHealth)
    this.rightBar.style.background = healthColor(foe.health / foe.maxHealth)
    this.leftEnergy.style.width = `${(player.energy01 * 100).toFixed(0)}%`
    this.rightEnergy.style.width = `${(foe.energy01 * 100).toFixed(0)}%`
    this.leftPips.forEach((pip, i) => {
      const ready = player.abilityCooldown01(i) >= 1
      const ability = player.arch.abilities[i]
      pip.textContent = ability ? ability.name : ''
      pip.style.opacity = ready ? '1' : '0.4'
      pip.style.borderColor = ready ? '#8ff6ff' : 'rgba(255,255,255,0.3)'
      pip.style.background = ready ? 'rgba(20,60,90,0.7)' : 'rgba(10,14,26,0.6)'
    })
    this.rightPips.forEach((pip, i) => {
      const ready = foe.abilityCooldown01(i) >= 1
      const ability = foe.arch.abilities[i]
      pip.textContent = ability ? ability.name : ''
      pip.style.opacity = ready ? '1' : '0.4'
    })
  }

  setVisible(v: boolean): void {
    this.root.style.display = v ? 'block' : 'none'
  }
}

function healthColor(t: number): string {
  if (t > 0.5) return 'linear-gradient(90deg,#5ce07a,#d8f36a)'
  if (t > 0.25) return 'linear-gradient(90deg,#f6c069,#ffe066)'
  return 'linear-gradient(90deg,#e0483c,#f6913c)'
}
