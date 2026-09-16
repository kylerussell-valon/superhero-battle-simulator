/**
 * Screenshot / telemetry capture for the Superhero Battle Simulator.
 *
 *   node scripts/shot.mjs <name> [--scenario overview|smash|...] [--eval "js"] [--wait 1500]
 *
 * The ?capture=1 query suppresses the pre-fight character select, which would
 * otherwise be sitting over the scene when the scenario runs.
 *
 * Launches headless Chrome with hardware WebGL, waits for the world to finish
 * generating, runs the scenario, waits, then writes captures/<name>.png plus
 * captures/<name>.json telemetry. This is the visual feedback loop the agent
 * uses to check progress.
 */
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CAPTURES = path.join(ROOT, 'captures')

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
]

function parseArgs(argv) {
  const out = { name: null, scenario: null, evalCode: null, wait: 1200, url: 'http://127.0.0.1:5177/?capture=1', w: 1600, h: 900 }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (i === 2 && !a.startsWith('--')) out.name = a
    else if (a === '--scenario') out.scenario = argv[++i]
    else if (a === '--eval') out.evalCode = argv[++i]
    else if (a === '--wait') out.wait = Number(argv[++i])
    else if (a === '--url') out.url = argv[++i]
    else if (a === '--w') out.w = Number(argv[++i])
    else if (a === '--h') out.h = Number(argv[++i])
  }
  return out
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
  throw new Error('puppeteer-core not resolvable — run `npm i -D puppeteer-core` or symlink the browser-tools copy')
}

const scenarios = await import('./scenarios.mjs').then((m) => m.scenarios).catch(() => ({}))

async function main() {
  const args = parseArgs(process.argv)
  if (!args.name) {
    console.error('usage: node scripts/shot.mjs <name> [--scenario x] [--eval "code"] [--wait ms]')
    process.exit(1)
  }
  const scenario = args.scenario ? scenarios[args.scenario] : null
  if (args.scenario && !scenario) {
    console.error(`unknown scenario "${args.scenario}". available: ${Object.keys(scenarios).join(', ')}`)
    process.exit(1)
  }

  const executablePath = CHROME_CANDIDATES.find((p) => existsSync(p))
  if (!executablePath) throw new Error('no chrome found')
  const puppeteer = await loadPuppeteer()

  const browser = await puppeteer.launch({
    executablePath,
    headless: 'shell' === 'never' ? false : true,
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
      `--window-size=${args.w},${args.h}`,
    ],
    defaultViewport: { width: args.w, height: args.h, deviceScaleFactor: 2 },
    protocolTimeout: 180000,
  })

  try {
    const page = await browser.newPage()
    const logs = []
    page.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`))
    page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`))
    await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 60000 })

    // Wait for the world to finish generating.
    await page.waitForFunction('window.__SBS && window.__SBS.ready === true', { timeout: 180000, polling: 250 })

    if (scenario?.setup) await page.evaluate(scenario.setup)
    if (args.evalCode) {
      const r = await page.evaluate(args.evalCode)
      if (r !== undefined && r !== null) console.log('eval: ' + (typeof r === 'string' ? r : JSON.stringify(r)))
    }

    const wait = scenario?.wait ?? args.wait
    await new Promise((r) => setTimeout(r, wait))

    await mkdir(CAPTURES, { recursive: true })
    const file = path.join(CAPTURES, `${args.name}.png`)
    await page.screenshot({ path: file, type: 'png' })
    const telemetry = await page.evaluate('JSON.stringify(window.__SBS.telemetry())')
    await writeFile(path.join(CAPTURES, `${args.name}.json`), JSON.stringify({ telemetry: JSON.parse(telemetry), logs, at: new Date().toISOString() }, null, 2))
    console.log(`captured ${file}`)
    console.log(telemetry)
    if (logs.length) console.log('page log:\n' + logs.slice(-12).join('\n'))
    if (scenario?.after) console.log('after: ' + (await page.evaluate(scenario.after)))
  } finally {
    await browser.close()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
