import { Game } from './game'
import { installApi } from './ui/api'

/**
 * Entry point: create the canvas, boot the world, run.
 */

const canvas = document.createElement('canvas')
canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;touch-action:none;'
document.body.appendChild(canvas)

const game = new Game(canvas)
installApi(game)

window.addEventListener('resize', () => game.resize())
window.addEventListener('orientationchange', () => setTimeout(() => game.resize(), 120))
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) game.resize()
})

await game.boot()
game.start()

// Signal readiness to the capture tooling once the city has fully generated.
const markReady = (): void => {
  if (game.city.generating) {
    requestAnimationFrame(markReady)
  } else {
    window.__SBS.ready = true
  }
}
requestAnimationFrame(markReady)

// Handy for the agent tooling: log a one-line summary when the world is live.
console.log('[sbs] world ready', JSON.stringify(game.frameStats()))
