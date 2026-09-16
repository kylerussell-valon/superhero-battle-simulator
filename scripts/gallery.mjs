/**
 * Builds the visual progress dashboard from the capture set.
 *
 *   node scripts/gallery.mjs
 *
 * Reads captures/*.png + captures/*.json and writes:
 *   captures/index.html  — self-contained contact sheet with telemetry tables
 *   PROGRESS.md          — text summary with the same numbers, for the repo
 */
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CAPTURES = path.join(ROOT, 'captures')

const NOTES = {
  overview: 'City massing: 87 destructible SDF buildings streamed through the meshing worker, one instanced impostor draw for the 104-building skyline.',
  street: 'Street level look: box-projected facade atlas, carved window recesses, plaza with park block, ground painted from the blueprint.',
  select: 'Pre-fight character select: player and opponent picked independently, sim paused behind it.',
  cast: 'All four archetypes from the headless Blender rig, ~1400 tris each, vertex-coloured, posed by the rigid-part animator.',
  fight: 'Live 1:1 fight against the AI opponent: cinematic three-quarter camera, HUD, both fighters framed mid-exchange.',
  'dash-fling': 'Superspeed ram: the target is launched and carries through whatever is behind it.',
  'ram-building': 'Flying through a tower: the dash carves a tunnel in the SDF, the base loses support and the building shears off.',
  'heat-vision': 'Heat vision: a beam carve traced through the SDF, stopped at the first solid hit, with additive beam FX.',
  'titan-pound': 'Ground pound from the air: radial carve, dust ring, props launched off the street.',
  'shockwave-clap': 'Bracer shockwave: radial carve + launch + ring FX.',
  aftermath: 'Aftermath: a street of buildings brought down, debris pool settled, craters stamped.',
  'lowres-retro': 'The retro dial: 42% internal resolution, 20-step colour quantisation, ordered dither.',
  brawl: 'Attract mode: the AI drives both fighters and the match plays itself, auto-resetting on a KO so the loop never idles.',
}

const fmt = (n, digits = 0) => (typeof n === 'number' ? n.toFixed(digits) : '—')

async function main() {
  if (!existsSync(CAPTURES)) {
    console.log('no captures yet — run `npm run monitor` first')
    return
  }
  const files = (await readdir(CAPTURES)).filter((f) => f.endsWith('.png')).sort()
  const entries = []
  for (const f of files) {
    const name = f.replace(/\.png$/, '')
    const jsonPath = path.join(CAPTURES, `${name}.json`)
    let meta = {}
    if (existsSync(jsonPath)) meta = JSON.parse(await readFile(jsonPath, 'utf8'))
    const png = await readFile(path.join(CAPTURES, f))
    entries.push({ name, data: `data:image/png;base64,${png.toString('base64')}`, meta, stat: meta?.at ?? '' })
  }

  // --- dashboard ---------------------------------------------------------
  const cards = entries
    .map((e) => {
      const t = e.meta.telemetry ?? {}
      const rows = [
        ['fps / frame p50 / p95', `${fmt(t.fps, 0)} / ${fmt(t.frameMsP50, 1)} ms / ${fmt(t.frameMsP95, 1)} ms`],
        ['draws / tris', `${fmt(t.drawCalls)} / ${fmt((t.triangles ?? 0) / 1000)}k`],
        ['sim / render ms', `${fmt(t.simMs, 1)} / ${fmt(t.renderMs, 1)}`],
        ['city tris', `${fmt((t.cityTris ?? 0) / 1000)}k`],
        ['carve ops / voxels', `${fmt(t.carveOps)} / ${fmt((t.carvedVoxels ?? 0) / 1000)}k`],
        ['buildings destroyed / chunks', `${fmt(t.destroyedBuildings)} / ${fmt(t.collapsedChunks)}`],
        ['debris / dust', `${fmt(t.debrisActive ?? t.activeDebris)} / ${fmt(t.dustParticles)}`],
        ['props flying', fmt(t.propsFlying ?? 0)],
      ]
        .map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`)
        .join('')
      const logs = (e.meta.logs ?? []).filter((l) => l.startsWith('error') || l.startsWith('pageerror'))
      return `<figure>
        <img src="${e.data}" alt="${e.name}" loading="lazy" />
        <figcaption>
          <h2>${e.name}</h2>
          <p class="note">${NOTES[e.name] ?? ''}</p>
          <table>${rows}</table>
          ${logs.length ? `<pre class="err">${logs.slice(0, 4).join('\n')}</pre>` : ''}
          <time>${e.stat}</time>
        </figcaption>
      </figure>`
    })
    .join('\n')

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<title>SBS — visual progress</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; background:#080b14; color:#dfe8ff; font:13px/1.5 ui-monospace,Menlo,monospace; }
  header { padding:22px 26px; border-bottom:1px solid #22345c; position:sticky; top:0; background:#0a0f1c; z-index:2; }
  h1 { margin:0; font-size:16px; letter-spacing:.24em; color:#ffe066; }
  header p { margin:6px 0 0; color:#8fb2d4; font-size:11px; }
  main { display:grid; grid-template-columns:repeat(auto-fill,minmax(560px,1fr)); gap:20px; padding:20px; }
  figure { margin:0; background:#0d1424; border:1px solid #22345c; }
  figure img { width:100%; display:block; background:#000; }
  figcaption { padding:12px 14px; }
  figcaption h2 { margin:0 0 6px; font-size:12px; letter-spacing:.2em; color:#8ff6ff; }
  .note { margin:0 0 10px; color:#a9c7ef; font-size:11px; }
  table { width:100%; border-collapse:collapse; font-size:11px; }
  th { text-align:left; color:#7d95bb; font-weight:400; padding:2px 0; }
  td { text-align:right; color:#dfe8ff; }
  .err { color:#ff9a8a; font-size:10px; white-space:pre-wrap; margin:8px 0 0; }
  time { color:#54688c; font-size:10px; }
  .summary { padding:0 26px 26px; color:#a9c7ef; font-size:12px; }
</style></head>
<body>
<header>
  <h1>SUPERHERO BATTLE SIMULATOR — visual progress</h1>
  <p>${entries.length} captures · generated ${new Date().toISOString()} · open this file directly, no server needed</p>
</header>
<div class="summary">
  Each tile is one scripted scenario (see <code>scripts/scenarios.mjs</code>), captured by
  <code>npm run monitor</code> from headless Chrome with hardware WebGL, together with the
  telemetry sampled at capture time.
</div>
<main>${cards}</main>
</body></html>`

  await writeFile(path.join(CAPTURES, 'index.html'), html)

  // --- PROGRESS.md -------------------------------------------------------
  const md = [
    '# Progress log',
    '',
    `Auto-generated from \`captures/\` by \`node scripts/gallery.mjs\` (${new Date().toISOString()}).`,
    '',
    'Open `captures/index.html` for the visual contact sheet.',
    '',
    '| scenario | fps | frame p50 | draws | tris | sim ms | render ms | destroyed | debris | note |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...entries.map((e) => {
      const t = e.meta.telemetry ?? {}
      return `| ${e.name} | ${fmt(t.fps, 0)} | ${fmt(t.frameMsP50, 1)} | ${fmt(t.drawCalls)} | ${fmt((t.triangles ?? 0) / 1000)}k | ${fmt(t.simMs, 1)} | ${fmt(t.renderMs, 1)} | ${fmt(t.destroyedBuildings)} | ${fmt(t.debrisActive ?? t.activeDebris)} | ${(NOTES[e.name] ?? '').slice(0, 80)} |`
    }),
    '',
  ].join('\n')
  await writeFile(path.join(ROOT, 'PROGRESS.md'), md)
  console.log(`wrote captures/index.html (${entries.length} captures) and PROGRESS.md`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
