/**
 * Input: keyboard + pointer-lock mouse + touch. No allocations in the hot path;
 * edges (justPressed) are computed on a frame boundary.
 */

export class Input {
  private readonly down = new Set<string>()
  private readonly pressed = new Set<string>()
  mouseDX = 0
  mouseDY = 0
  wheel = 0
  /** Touch drag look + virtual buttons mirror the keyboard set. */
  readonly virtual = new Set<string>()
  private readonly buttons = new Set<number>()
  private readonly buttonsPressed = new Set<number>()
  private touchId: number | null = null
  private lastTouchX = 0
  private lastTouchY = 0

  /** True while the pointer is captured, so the HUD can prompt if it is not. */
  get pointerLocked(): boolean {
    return this.lockTarget !== null && document.pointerLockElement === this.lockTarget
  }
  private lockTarget: HTMLCanvasElement | null = null

  constructor(canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return
      this.down.add(e.code)
      this.pressed.add(e.code)
    })
    window.addEventListener('keyup', (e) => this.down.delete(e.code))
    window.addEventListener('blur', () => this.down.clear())

    canvas.addEventListener('mousedown', (e) => {
      this.buttons.add(e.button)
      this.buttonsPressed.add(e.button)
      this.lockTarget = canvas
      if (document.pointerLockElement !== canvas) void canvas.requestPointerLock()
    })
    window.addEventListener('mouseup', (e) => this.buttons.delete(e.button))
    canvas.addEventListener('contextmenu', (e) => e.preventDefault())
    document.addEventListener('mousemove', (e) => {
      // Pointer lock is the primary path, but fall back to drag-to-look so the
      // camera still responds if the lock is refused or the player never clicks.
      if (document.pointerLockElement === canvas || e.buttons !== 0) {
        this.mouseDX += e.movementX
        this.mouseDY += e.movementY
      }
    })
    window.addEventListener(
      'wheel',
      (e) => {
        this.wheel += e.deltaY
      },
      { passive: true },
    )

    canvas.addEventListener('touchstart', (e) => {
      const t = e.changedTouches[0]
      if (this.touchId === null) {
        this.touchId = t.identifier
        this.lastTouchX = t.clientX
        this.lastTouchY = t.clientY
      }
    })
    canvas.addEventListener(
      'touchmove',
      (e) => {
        for (const t of Array.from(e.changedTouches)) {
          if (t.identifier !== this.touchId) continue
          this.mouseDX += (t.clientX - this.lastTouchX) * 2.2
          this.mouseDY += (t.clientY - this.lastTouchY) * 2.2
          this.lastTouchX = t.clientX
          this.lastTouchY = t.clientY
        }
      },
      { passive: true },
    )
    canvas.addEventListener('touchend', (e) => {
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier === this.touchId) this.touchId = null
      }
    })
  }

  has(code: string): boolean {
    return this.down.has(code) || this.virtual.has(code)
  }
  justPressed(code: string): boolean {
    return this.pressed.has(code) || this.virtual.has(code)
  }
  mouseButton(button: number): boolean {
    return this.buttons.has(button)
  }
  buttonPressed(button: number): boolean {
    return this.buttonsPressed.has(button)
  }

  /** Call at the end of every frame. */
  endFrame(): void {
    this.buttonsPressed.clear()
    this.pressed.clear()
    this.virtual.clear()
    this.mouseDX = 0
    this.mouseDY = 0
    this.wheel = 0
  }
}
