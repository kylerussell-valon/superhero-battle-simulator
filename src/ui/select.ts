import type { Archetype } from '../entities/archetypes'

/**
 * Pre-fight character select.
 *
 * Plain DOM like the rest of the UI — no GPU passes, no canvas text, and it
 * pauses the sim while it is up. Two columns pick the player and the opponent
 * independently; keyboard and mouse both work, because the game itself is
 * keyboard-first and a mouse-only menu would be a step backwards.
 */

export interface SelectOptions {
  archetypes: Archetype[]
  playerIndex: number
  foeIndex: number
  onStart(playerIndex: number, foeIndex: number): void
  onClose?(): void
}

export interface CharacterSelect {
  readonly root: HTMLElement
  open(): void
  close(): void
  toggle(): void
  readonly isOpen: boolean
  /** Returns true when the key was consumed by the menu. */
  handleKey(code: string): boolean
}

const CARD_CSS =
  'display:flex;flex-direction:column;gap:3px;text-align:left;font:inherit;cursor:pointer;' +
  'padding:8px 10px;background:rgba(10,16,32,0.72);border:1px solid #2c4270;color:#cfe3ff;'

function statRow(label: string, value: string): string {
  return `<tr><th>${label}</th><td>${value}</td></tr>`
}

export function createCharacterSelect(opts: SelectOptions): CharacterSelect {
  const { archetypes } = opts
  let playerIndex = opts.playerIndex
  let foeIndex = opts.foeIndex
  let focus: 'player' | 'foe' = 'player'
  let open = false

  const root = document.createElement('div')
  root.style.cssText =
    'position:fixed;inset:0;z-index:35;display:none;flex-direction:column;align-items:center;' +
    'justify-content:center;gap:18px;padding:24px;box-sizing:border-box;' +
    'background:radial-gradient(120% 90% at 50% 0%, #17224a 0%, #070a16 62%, #04050b 100%);' +
    'font:12px/1.45 ui-monospace,Menlo,monospace;color:#dfe8ff;'

  const title = document.createElement('div')
  title.innerHTML =
    '<div style="font-size:clamp(16px,2.6vw,28px);letter-spacing:0.3em;color:#ffe066;' +
    'text-shadow:0 2px 0 #a15c00,0 0 24px #ffb70355;text-align:center;">SELECT FIGHTERS</div>' +
    '<div style="font-size:10px;letter-spacing:0.28em;opacity:0.6;text-align:center;margin-top:6px;">' +
    'W/S CHOOSE · A/D SWITCH SIDE · ENTER TO FIGHT · MOUSE WORKS TOO</div>'

  const panels = document.createElement('div')
  panels.style.cssText = 'display:flex;gap:16px;flex-wrap:wrap;justify-content:center;'

  const buildPanel = (side: 'player' | 'foe'): { box: HTMLElement; cards: HTMLElement[]; head: HTMLElement } => {
    const box = document.createElement('div')
    box.style.cssText = 'min-width:min(360px,42vw);display:flex;flex-direction:column;gap:8px;'
    const head = document.createElement('div')
    head.style.cssText =
      'letter-spacing:0.24em;font-size:11px;color:#8ff6ff;border-bottom:1px solid #24406f;padding-bottom:6px;'
    head.textContent = side === 'player' ? 'PLAYER' : 'OPPONENT'
    const cards: HTMLElement[] = []
    box.append(head)
    for (let i = 0; i < archetypes.length; i++) {
      const a = archetypes[i]
      const card = document.createElement('button')
      card.style.cssText = CARD_CSS
      card.innerHTML =
        `<div style="display:flex;justify-content:space-between;align-items:baseline;">` +
        `<b style="letter-spacing:0.18em;font-weight:600;">${a.name}</b>` +
        `<span style="font-size:10px;opacity:0.65;">${a.canFly ? 'FLIGHT' : 'GROUND'} · ${a.health} HP</span></div>` +
        `<span style="font-size:10px;opacity:0.72;">${a.tagline}</span>` +
        `<table style="width:100%;border-collapse:collapse;font-size:10px;opacity:0.8;margin-top:2px;">` +
        statRow('speed / air', `${a.runSpeed} / ${a.airSpeed}`) +
        statRow('power / mass', `${a.power.toFixed(2)} / ${a.mass.toFixed(2)}`) +
        statRow('signature', a.abilities.map((b) => b.name).join(' + ')) +
        `</table>`
      card.addEventListener('click', () => {
        if (side === 'player') playerIndex = i
        else foeIndex = i
        focus = side
        paint()
      })
      cards.push(card)
      box.append(card)
    }
    return { box, cards, head }
  }

  const playerPanel = buildPanel('player')
  const foePanel = buildPanel('foe')
  panels.append(playerPanel.box, foePanel.box)

  const footer = document.createElement('div')
  footer.style.cssText = 'display:flex;gap:12px;align-items:center;'
  const fight = document.createElement('button')
  fight.textContent = 'FIGHT'
  fight.style.cssText =
    'font:inherit;font-size:13px;letter-spacing:0.24em;padding:10px 28px;cursor:pointer;color:#05070f;' +
    'background:linear-gradient(180deg,#ffe066,#f0a92b);border:1px solid #ffe066;font-weight:700;'
  const launch = (): void => {
    if (!open) return
    close(true)
    opts.onStart(playerIndex, foeIndex)
  }
  fight.addEventListener('click', launch)

  const hint = document.createElement('div')
  hint.style.cssText = 'font-size:10px;letter-spacing:0.2em;opacity:0.55;'
  hint.textContent = 'PRESS M IN MATCH TO RETURN'
  footer.append(fight, hint)

  root.append(title, panels, footer)

  function paint(): void {
    const apply = (cards: HTMLElement[], sel: number, active: boolean): void => {
      cards.forEach((c, i) => {
        const chosen = i === sel
        c.style.borderColor = chosen ? (active ? '#ffe066' : '#8ff6ff') : '#2c4270'
        c.style.background = chosen
          ? active
            ? 'rgba(60,48,12,0.85)'
            : 'rgba(14,30,52,0.85)'
          : 'rgba(10,16,32,0.72)'
        c.style.color = chosen ? '#fff' : '#cfe3ff'
      })
    }
    apply(playerPanel.cards, playerIndex, focus === 'player')
    apply(foePanel.cards, foeIndex, focus === 'foe')
  }

  function close(started = false): void {
    if (!open) return
    open = false
    root.style.display = 'none'
    if (!started) opts.onClose?.()
  }

  function openMenu(): void {
    open = true
    paint()
    root.style.display = 'flex'
  }

  // Keyboard capture: the game listens on window, so the menu claims keys first
  // and stops them reaching gameplay.
  const onKeyDown = (e: KeyboardEvent): void => {
    if (!open) return
    if (handleKey(e.code)) {
      e.preventDefault()
      e.stopPropagation()
    }
  }
  window.addEventListener('keydown', onKeyDown, true)

  function handleKey(code: string): boolean {
    if (!open) return false
    const up = code === 'KeyW' || code === 'ArrowUp'
    const down = code === 'KeyS' || code === 'ArrowDown'
    const left = code === 'KeyA' || code === 'ArrowLeft'
    const right = code === 'KeyD' || code === 'ArrowRight'
    if (code === 'Enter' || code === 'Space' || code === 'NumpadEnter') {
      launch()
      return true
    }
    if (code === 'Escape') {
      close()
      return true
    }
    if (left || right) {
      focus = focus === 'player' ? 'foe' : 'player'
      paint()
      return true
    }
    if (up || down) {
      const delta = up ? -1 : 1
      const n = archetypes.length
      if (focus === 'player') playerIndex = (playerIndex + delta + n) % n
      else foeIndex = (foeIndex + delta + n) % n
      paint()
      return true
    }
    // Swallow everything else so the fight does not read inputs through the menu.
    return true
  }

  paint()

  return {
    root,
    open: openMenu,
    close: () => close(),
    toggle: () => (open ? close() : openMenu()),
    get isOpen() {
      return open
    },
    handleKey,
  }
}
