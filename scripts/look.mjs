/**
 * Visual review loop.
 *
 *   npm run look                         # curated set -> captures/review.jpg
 *   npm run look -- street,hero          # subset, same JPEG
 *   npm run look -- --all                # every named scenario
 *
 * One Chrome session, a short scenario list, one JPEG an agent can Read.
 * Full-size PNGs land in captures/review/ so they never become dashboard tiles.
 * Do not attach those PNGs. Read captures/review.jpg.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { scenarios } from './scenarios.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REVIEW = path.join(ROOT, 'captures', 'review')
const URL = 'http://127.0.0.1:5177/?capture=1'
const SERVER = 'http://127.0.0.1:5177/'

/** Enough to judge street, cast, camera, combat, and destruction. */
const DEFAULT = ['street', 'hero', 'cast', 'fight', 'melee', 'ram-building']

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
]

function parseArgs(argv) {
  const names = []
  let all = false
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--all') all = true
    else if (a === '--only') names.push(...argv[++i].split(','))
    else if (!a.startsWith('--')) names.push(...a.split(','))
  }
  const list = (all ? Object.keys(scenarios) : names.length ? names : DEFAULT).map((s) => s.trim()).filter(Boolean)
  return list
}

async function loadPuppeteer() {
  const candidates = [
    'puppeteer-core',
    path.resolve(ROOT, 'node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js'),
  ]
  for (const c of candidates) {
    try {
      const mod = await import(c)
      return mod.default ?? mod
    } catch {
      /* try next */
    }
  }
  throw new Error('puppeteer-core not installed — run `npm i -D puppeteer-core`')
}

function httpOk(url) {
  return new Promise((resolve) => {
    import('node:http').then(({ get }) => {
      const req = get(url, (res) => {
        res.resume()
        resolve(res.statusCode === 200)
      })
      req.on('error', () => resolve(false))
      req.setTimeout(1500, () => {
        req.destroy()
        resolve(false)
      })
    }).catch(() => resolve(false))
  })
}

async function ensureServer() {
  if (await httpOk(SERVER)) return null
  console.log('[look] starting vite…')
  const proc = spawn('npx', ['vite', '--port', '5177', '--strictPort'], {
    cwd: ROOT,
    stdio: 'ignore',
    detached: false,
  })
  for (let i = 0; i < 40; i++) {
    await sleep(250)
    if (await httpOk(SERVER)) return proc
  }
  proc.kill()
  throw new Error('vite did not come up on :5177')
}

async function shoot(page, name) {
  const scenario = scenarios[name]
  if (!scenario) throw new Error(`unknown scenario "${name}". available: ${Object.keys(scenarios).join(', ')}`)
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForFunction('window.__SBS && window.__SBS.ready === true', { timeout: 180000, polling: 250 })
  if (scenario.setup) await page.evaluate(scenario.setup)
  await sleep(scenario.wait ?? 900)
  const png = path.join(REVIEW, `${name}.png`)
  await page.screenshot({ path: png, type: 'png' })
  const telemetry = JSON.parse(await page.evaluate('JSON.stringify(window.__SBS.telemetry())'))
  await writeFile(
    path.join(REVIEW, `${name}.json`),
    JSON.stringify({ telemetry, at: new Date().toISOString() }, null, 2),
  )
  console.log(`[look] ${name}  ${telemetry.fps?.toFixed?.(0) ?? '?'} fps  ${png}`)
}

async function sheet(names) {
  const cols = names.length <= 1 ? 1 : names.length <= 4 ? 2 : 3
  const width = names.length <= 1 ? 1400 : 1600
  await new Promise((resolve, reject) => {
    const p = spawn(
      process.execPath,
      [
        path.join(ROOT, 'scripts/contact.mjs'),
        '--dir',
        'captures/review',
        '--only',
        names.join(','),
        '--cols',
        String(cols),
        '--width',
        String(width),
        '--out',
        'captures/review.jpg',
      ],
      { cwd: ROOT, stdio: 'inherit' },
    )
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`contact exited ${code}`))))
  })
}

async function main() {
  const names = parseArgs(process.argv)
  const unknown = names.filter((n) => !scenarios[n])
  if (unknown.length) {
    console.error(`unknown scenario(s): ${unknown.join(', ')}\navailable: ${Object.keys(scenarios).join(', ')}`)
    process.exit(1)
  }

  const server = await ensureServer()
  const executablePath = CHROME_CANDIDATES.find((p) => existsSync(p))
  if (!executablePath) throw new Error('no Chrome found')
  const puppeteer = await loadPuppeteer()
  await mkdir(REVIEW, { recursive: true })

  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: [
      '--headless=new',
      '--enable-gpu',
      '--use-angle=metal',
      '--ignore-gpu-blocklist',
      '--enable-unsafe-swiftshader',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--mute-audio',
      '--window-size=1600,900',
    ],
    defaultViewport: { width: 1600, height: 900, deviceScaleFactor: 2 },
    protocolTimeout: 180000,
  })

  const failed = []
  try {
    const page = await browser.newPage()
    page.on('pageerror', (e) => console.error(`[look] pageerror: ${e.message}`))
    for (const name of names) {
      try {
        await shoot(page, name)
      } catch (err) {
        failed.push(name)
        console.error(`[look] ${name} failed: ${err.message ?? err}`)
      }
    }
  } finally {
    await browser.close()
    if (server) server.kill()
  }

  const ok = names.filter((n) => !failed.includes(n))
  if (!ok.length) throw new Error('every scenario failed')
  await sheet(ok)
  console.log(`[look] read captures/review.jpg (${ok.length} tile${ok.length === 1 ? '' : 's'})`)
  if (failed.length) process.exitCode = 1
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
