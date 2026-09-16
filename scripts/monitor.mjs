/**
 * The full progress loop:
 *
 *   npm run monitor                 # every scenario
 *   npm run monitor -- ram-building # just one
 *
 * 1. makes sure the dev server is up (starts it if needed)
 * 2. drives each scenario through headless Chrome and writes captures/
 * 3. regenerates the dashboard (captures/index.html) and PROGRESS.md
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const URL = 'http://127.0.0.1:5177/'

const ALL = [
  'overview',
  'street',
  'storefront',
  'select',
  'cast',
  'fight',
  'ram-building',
  'dash-fling',
  'heat-vision',
  'titan-pound',
  'shockwave-clap',
  'aftermath',
  'lowres-retro',
  'brawl',
  'melee',
  'super-flare',
  'super-seismic',
]

const run = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts })
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))))
  })

const http = (url) =>
  new Promise((resolve) => {
    import('node:http')
      .then(({ get }) => {
        const req = get(url, (res) => {
          res.resume()
          resolve(res.statusCode === 200)
        })
        req.on('error', () => resolve(false))
        req.setTimeout(1500, () => {
          req.destroy()
          resolve(false)
        })
      })
      .catch(() => resolve(false))
  })

async function ensureServer() {
  if (await http(URL)) return null
  console.log('[monitor] starting vite…')
  const proc = spawn('npx', ['vite', '--port', '5177', '--strictPort'], { cwd: ROOT, stdio: 'ignore', detached: false })
  for (let i = 0; i < 40; i++) {
    await sleep(250)
    if (await http(URL)) return proc
  }
  throw new Error('vite did not come up')
}

async function main() {
  const requested = process.argv.slice(2).filter((a) => !a.startsWith('-'))
  const list = requested.length ? requested : ALL
  const server = await ensureServer()
  let failures = 0
  for (const name of list) {
    process.stdout.write(`[monitor] ${name} … `)
    try {
      await run('node', ['scripts/shot.mjs', name, '--scenario', name])
      process.stdout.write('ok\n')
    } catch (e) {
      failures++
      process.stdout.write(`FAILED (${e.message})\n`)
    }
  }
  await run('node', ['scripts/gallery.mjs'])
  // One small JPEG of the whole set: what an agent (or a human) should actually
  // look at. Full-size captures are ~3 MB each and blow the request limit when
  // several are attached at once.
  try {
    await run('node', ['scripts/contact.mjs'])
  } catch (e) {
    console.log(`[monitor] contact sheet skipped (${e.message})`)
  }
  console.log(`[monitor] done${failures ? ` with ${failures} failure(s)` : ''}`)
  if (server) {
    console.log('[monitor] leaving vite running; ctrl-c to stop')
  } else {
    process.exit(0)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
