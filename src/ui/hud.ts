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
  /** Open the pre-fight character select. */
  onFighters(): void
}

export class Hud {
  readonly root: HTMLElement
  private readonly leftBar: HTMLElement
  private readonly rightBar: HTMLElement
  private readonly leftEnergy: HTMLElement
  private readonly rightEnergy: HTMLElement
  private readonly leftSuper: HTMLElement
  private readonly rightSuper: HTMLElement
  private readonly leftSuperBox: HTMLElement
  private readonly rightSuperBox: HTMLElement
  private readonly leftPips: HTMLElement[] = []
  private readonly rightPips: HTMLElement[] = []
  private readonly leftName: HTMLElement
  private readonly rightName: HTMLElement
  private readonly banner: HTMLElement
  private readonly sub: HTMLElement
  private readonly damage: HTMLElement
  private readonly lockHint: HTMLElement
  private readonly recoverHint: HTMLElement
  private readonly superHint: HTMLElement
  private readonly superFlash: HTMLElement
  private readonly combo: HTMLElement
  private readonly comboCount: HTMLElement
  private readonly comboBar: HTMLElement
  private lastUpdate = 0
  private bannerTimer = 0
  private damageTimer = 0
  private superFlashTimer = 0
  private comboShown = false
  private comboPct = -1

  constructor(cb: HudCallbacks) {
    this.root = document.createElement('div')
    this.root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:10;font-family:ui-monospace,Menlo,monospace;'

    // Keyframes for the super-ready pulse, injected once.
    const style = document.createElement('style')
    style.textContent =
      '@keyframes sbs-super-pulse{0%,100%{box-shadow:0 0 5px rgba(255,224,102,0.4)}50%{box-shadow:0 0 20px rgba(255,224,102,0.95)}}' +
      '@keyframes sbs-combo-pop{0%{transform:scale(1.35)}100%{transform:scale(1)}}'
    document.head.appendChild(style)

    const card = (align: 'left' | 'right'): string =>
      `position:absolute;top:14px;${align}:16px;width:min(38vw,420px);display:flex;flex-direction:column;gap:5px;` +
      `align-items:${align === 'left' ? 'flex-start' : 'flex-end'};`

    const makeCard = (align: 'left' | 'right'): { box: HTMLElement; name: HTMLElement; bar: HTMLElement; energy: HTMLElement; superFill: HTMLElement; superBox: HTMLElement; pips: HTMLElement[] } => {
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
      // Super meter: a wider, segmented amber bar that announces itself when full.
      const superBox = document.createElement('div')
      superBox.style.cssText = 'width:78%;height:9px;background:rgba(10,14,26,0.78);border:1px solid rgba(255,224,102,0.55);'
      const sfill = document.createElement('i')
      sfill.style.cssText = 'display:block;height:100%;width:0%;background:linear-gradient(90deg,#f0932b,#ffcf4b,#fff6c0);'
      superBox.appendChild(sfill)
      const pips = document.createElement('div')
      pips.style.cssText = 'display:flex;gap:6px;'
      const pipEls: HTMLElement[] = []
      for (let i = 0; i < 2; i++) {
        const pip = document.createElement('div')
        pip.style.cssText = 'font-size:10px;letter-spacing:0.12em;padding:2px 6px;border:1px solid rgba(255,255,255,0.4);color:#cfe3ff;background:rgba(10,14,26,0.6);'
        pips.appendChild(pip)
        pipEls.push(pip)
      }
      box.append(name, bar, energy, superBox, pips)
      this.root.appendChild(box)
      return { box, name, bar: fill, energy: efill, superFill: sfill, superBox, pips: pipEls }
    }

    const l = makeCard('left')
    const r = makeCard('right')
    this.leftName = l.name
    this.rightName = r.name
    this.leftBar = l.bar
    this.rightBar = r.bar
    this.leftEnergy = l.energy
    this.rightEnergy = r.energy
    this.leftSuper = l.superFill
    this.rightSuper = r.superFill
    this.leftSuperBox = l.superBox
    this.rightSuperBox = r.superBox
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
      'WASD MOVE · SHIFT SPRINT · SPACE JUMP · IN AIR LOOK + W TO FLY · MOUSE LOOK · C RECENTRE · LMB/J LIGHT · RMB/K HEAVY · Q/E ABILITIES · X SUPER · R RESET · TAB SWAP · M FIGHTERS · ~ TELEMETRY'

    // Shown until the pointer is captured: otherwise a player can be moving and
    // attacking without ever realising the mouse is not driving the camera.
    this.lockHint = document.createElement('div')
    this.lockHint.style.cssText =
      'position:absolute;top:52%;left:0;right:0;text-align:center;font-size:12px;letter-spacing:0.24em;color:#ffe066;text-shadow:0 2px 0 #000,0 0 18px #ffb70355;'
    this.lockHint.textContent = 'CLICK TO CAPTURE MOUSE'

    // Appears once a fling has burned down enough to be cancelled: without it
    // there is no way to know the tumble is something you can escape.
    this.recoverHint = document.createElement('div')
    this.recoverHint.style.cssText =
      'position:absolute;bottom:64px;left:0;right:0;text-align:center;font-size:12px;letter-spacing:0.22em;color:#8ff6ff;text-shadow:0 2px 0 #000,0 0 16px #0af8ff44;display:none;'
    this.recoverHint.textContent = 'SPACE TO RECOVER'

    // Super-ready prompt, sitting just above the recover prompt.
    this.superHint = document.createElement('div')
    this.superHint.style.cssText =
      'position:absolute;bottom:88px;left:0;right:0;text-align:center;font-size:13px;letter-spacing:0.26em;color:#ffe066;' +
      'text-shadow:0 2px 0 #6a2a00,0 0 18px #ffb703aa;display:none;'
    this.superHint.textContent = 'SUPER READY · PRESS X'

    // Full-screen flash in the hero's colour on super activation.
    this.superFlash = document.createElement('div')
    this.superFlash.style.cssText = 'position:absolute;inset:0;opacity:0;transition:opacity 220ms;mix-blend-mode:screen;'

    // Combo readout: top-centre, under the fighter cards.
    this.combo = document.createElement('div')
    this.combo.style.cssText =
      'position:absolute;top:118px;left:0;right:0;text-align:center;opacity:0;transition:opacity 180ms;'
    this.comboCount = document.createElement('div')
    this.comboCount.style.cssText =
      'font-size:30px;font-weight:700;letter-spacing:0.06em;color:#fff;' +
      'text-shadow:0 3px 0 #7a2f00,0 0 18px rgba(255,180,60,0.85);'
    const comboLabel = document.createElement('div')
    comboLabel.style.cssText = 'font-size:11px;letter-spacing:0.42em;color:#ffd98a;margin-top:-2px;'
    comboLabel.textContent = 'COMBO'
    this.comboBar = document.createElement('div')
    this.comboBar.style.cssText = 'width:120px;height:3px;margin:6px auto 0;background:rgba(255,255,255,0.18);'
    const comboFill = document.createElement('i')
    comboFill.style.cssText = 'display:block;height:100%;width:100%;background:#ffcf4b;'
    this.comboBar.appendChild(comboFill)
    this.combo.append(this.comboCount, comboLabel, this.comboBar)

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
    buttons.append(mk('RESTART', cb.onRestart), mk('SWAP HERO', cb.onSwap), mk('FIGHTERS', cb.onFighters))

    this.root.append(this.damage, this.superFlash, this.banner, this.sub, this.combo, this.lockHint, this.recoverHint, this.superHint, hints, buttons)
  }

  /** Prompt for pointer capture until the mouse actually drives the camera. */
  setPointerCaptured(captured: boolean): void {
    this.lockHint.style.display = captured ? 'none' : ''
  }

  /** Offer the fling-cancel while the window is open. */
  setRecoverPrompt(show: boolean): void {
    this.recoverHint.style.display = show ? '' : 'none'
  }

  /** Offer the super while the meter is full and the character can fire it. */
  setSuperPrompt(show: boolean): void {
    this.superHint.style.display = show ? '' : 'none'
  }

  /**
   * Combo readout. `count` of 0 or 1 hides it; `frac` is the remaining window
   * (1 = just landed, 0 = about to expire).
   */
  setCombo(count: number, frac: number): void {
    const show = count >= 2
    if (show) {
      if (this.comboCount.dataset.count !== String(count)) {
        this.comboCount.dataset.count = String(count)
        this.comboCount.textContent = `x${count}`
        // Re-trigger the pop only when the count changes, not every frame.
        this.comboCount.style.animation = 'none'
        void this.comboCount.offsetWidth
        this.comboCount.style.animation = 'sbs-combo-pop 140ms ease-out'
      }
      const fill = this.comboBar.firstElementChild as HTMLElement
      if (fill) {
        const pct = Math.round(Math.max(0, Math.min(1, frac)) * 100)
        if (this.comboPct !== pct) {
          this.comboPct = pct
          fill.style.width = `${pct}%`
        }
      }
    } else {
      this.comboCount.dataset.count = ''
    }
    if (show !== this.comboShown) {
      this.comboShown = show
      this.combo.style.opacity = show ? '1' : '0'
    }
  }

  /** Full-screen colour flash for a super activation. */
  flashSuper(color: number): void {
    const r = (color >> 16) & 0xff
    const g = (color >> 8) & 0xff
    const b = color & 0xff
    this.superFlash.style.background = `radial-gradient(120% 90% at 50% 50%, rgba(${r},${g},${b},0) 20%, rgba(${r},${g},${b},0.5) 70%, rgba(255,255,255,0.75) 100%)`
    this.superFlash.style.opacity = '1'
    this.superFlashTimer = 0.4
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
    if (this.superFlashTimer > 0) {
      this.superFlashTimer -= dt
      if (this.superFlashTimer <= 0) this.superFlash.style.opacity = '0'
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
    this.leftSuper.style.width = `${(player.super01 * 100).toFixed(0)}%`
    this.rightSuper.style.width = `${(foe.super01 * 100).toFixed(0)}%`
    this.setSuperReadyStyle(this.leftSuperBox, player.superReady)
    this.setSuperReadyStyle(this.rightSuperBox, foe.superReady)
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

  private setSuperReadyStyle(box: HTMLElement, ready: boolean): void {
    const want = ready ? 'sbs-super-pulse 0.7s ease-in-out infinite' : ''
    if (box.style.animation !== want) box.style.animation = want
    box.style.borderColor = ready ? '#ffe066' : 'rgba(255,224,102,0.55)'
  }
}

function healthColor(t: number): string {
  if (t > 0.5) return 'linear-gradient(90deg,#5ce07a,#d8f36a)'
  if (t > 0.25) return 'linear-gradient(90deg,#f6c069,#ffe066)'
  return 'linear-gradient(90deg,#e0483c,#f6913c)'
}
