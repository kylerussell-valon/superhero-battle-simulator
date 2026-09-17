/**
 * Compose the capture set into a single small JPEG contact sheet.
 *
 *   node scripts/contact.mjs                       # every scenario -> captures/contact.jpg
 *   node scripts/contact.mjs --only street,cast    # just those scenarios
 *   node scripts/contact.mjs --only street --cols 1 --width 1500   # one big tile
 *
 * Why this exists
 * ---------------
 * `captures/*.png` are 3200x1800 (~3 MB each). Loading a dozen of them into an
 * agent's context as image attachments is what produced an HTTP 413 (request too
 * large). This renders the same set as ONE downscaled JPEG — typically 150-400 KB
 * — so a visual review costs a single small attachment instead of twelve huge
 * ones. Prefer this over reading individual captures.
 *
 * Telemetry numbers are baked into each tile so the sheet is self-describing and
 * a review pass does not need the .json sidecars.
 */
import { mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CAPTURES = path.join(ROOT, 'captures')

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
]

function parseArgs(argv) {
  const out = { only: null, cols: 4, width: 1600, quality: 82, out: null, dir: null }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--only') out.only = argv[++i].split(',').map((s) => s.trim()).filter(Boolean)
    else if (a === '--cols') out.cols = Math.max(1, Number(argv[++i]))
    else if (a === '--width') out.width = Math.max(320, Number(argv[++i]))
    else if (a === '--quality') out.quality = Math.min(100, Math.max(30, Number(argv[++i])))
    else if (a === '--out') out.out = argv[++i]
    else if (a === '--dir') out.dir = argv[++i]
    else if (!a.startsWith('--')) out.only = [a]
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
  throw new Error('puppeteer-core not resolvable — run `npm i -D puppeteer-core`')
}

const fmt = (n, d = 0) => (typeof n === 'number' ? n.toFixed(d) : '—')

async function main() {
  const args = parseArgs(process.argv)
  const dir = args.dir ? path.resolve(ROOT, args.dir) : CAPTURES
  if (!existsSync(dir)) throw new Error(`no ${path.relative(ROOT, dir) || dir} — run \`npm run look\` or \`npm run monitor\` first`)

  const onDisk = new Set(
    (await readdir(dir))
      .filter((f) => f.endsWith('.png') && !f.startsWith('contact'))
      .map((f) => f.replace(/\.png$/, '')),
  )
  // `--only` keeps the requested order so a review sheet reads as a sequence.
  let names = args.only ? args.only.filter((n) => onDisk.has(n)) : [...onDisk].sort()
  if (!names.length) throw new Error(`no captures matched ${args.only ? args.only.join(',') : '(any)'}`)

  // Per-tile telemetry line, kept short so it never wraps awkwardly.
  const tiles = []
  for (const name of names) {
    const jsonPath = path.join(dir, `${name}.json`)
    let line = ''
    if (existsSync(jsonPath)) {
      const t = JSON.parse(await readFile(jsonPath, 'utf8'))?.telemetry ?? {}
      line = `${fmt(t.fps)} fps · ${fmt(t.frameMsP50, 1)} ms · ${fmt(t.drawCalls)} draws · ${fmt(
        (t.triangles ?? 0) / 1000,
      )}k tris`
    }
    tiles.push({ name, line })
  }

  const cols = Math.min(args.cols, tiles.length)
  const gap = 10
  const tileW = Math.floor((args.width - gap * (cols + 1)) / cols)
  const tileH = Math.round((tileW * 9) / 16)

  const html = `<!doctype html><html><head><meta charset="utf-8" /><style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { background:#0a0d16; font:11px/1.3 ui-monospace,Menlo,monospace; color:#dfe8ff; }
    main { display:grid; grid-template-columns:repeat(${cols}, ${tileW}px); gap:${gap}px; padding:${gap}px; }
    figure { background:#121a2c; border:1px solid #24365c; overflow:hidden; }
    img { display:block; width:${tileW}px; height:${tileH}px; object-fit:cover; background:#000; }
    figcaption { padding:5px 7px 6px; }
    b { color:#8ff6ff; letter-spacing:.08em; }
    span { color:#8aa4c8; }
  </style></head><body><main>
    ${tiles
      .map(
        (t) =>
          `<figure><img src="${path.join(dir, `${t.name}.png`)}" /><figcaption><b>${t.name}</b><br /><span>${t.line}</span></figcaption></figure>`,
      )
      .join('\n')}
  </main></body></html>`

  const tmpDir = path.join(os.tmpdir(), 'sbs-contact')
  await mkdir(tmpDir, { recursive: true })
  const htmlPath = path.join(tmpDir, 'contact.html')
  await writeFile(htmlPath, html)

  const executablePath = CHROME_CANDIDATES.find((p) => existsSync(p))
  if (!executablePath) throw new Error('no Chrome found (set CHROME path in scripts/contact.mjs)')
  const puppeteer = await loadPuppeteer()
  const rows = Math.ceil(tiles.length / cols)
  const pageH = gap + rows * (tileH + 40 + gap)
  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ['--headless=new', '--hide-scrollbars', '--no-first-run', '--mute-audio'],
    defaultViewport: { width: args.width, height: pageH, deviceScaleFactor: 1 },
  })
  try {
    const page = await browser.newPage()
    await page.goto(`file://${htmlPath}`, { waitUntil: 'load', timeout: 60000 })
    // Wait for every capture to decode before shooting the sheet.
    await page.evaluate(
      () => Promise.all(Array.from(document.images).map((i) => (i.complete ? 0 : i.decode().catch(() => 0)))),
    )
    const out = args.out ? path.resolve(ROOT, args.out) : path.join(CAPTURES, 'contact.jpg')
    await mkdir(path.dirname(out), { recursive: true })
    await page.screenshot({ path: out, type: 'jpeg', quality: args.quality })
    console.log(`wrote ${out} (${tiles.length} tiles, ${args.width}px wide, cols=${cols})`)
  } finally {
    await browser.close()
    await rm(htmlPath, { force: true })
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
