# Superhero Battle Simulator

A third-person action game about **epic destruction**: a flying brick rams straight
through a skyscraper and the tower shears off and collapses; a super-strong brawler
launches his opponent through the air and through whatever is behind them. The city
is modelled as a signed distance field, meshed on a worker pool, and rendered with a
fixed low internal resolution for a PS2/GameCube-era look that stays fast on Apple
Silicon.

```
npm install
npm run dev          # http://127.0.0.1:5177
```

The environment, characters and props are all generated — no external art is needed
to run. To regenerate the Blender-authored characters/props from source, see
[Asset pipeline](#asset-pipeline).

## Controls

| Input | Action |
| --- | --- |
| `WASD` | Move (camera-relative) |
| `Shift` | Sprint |
| `Space` | Jump / hold in the air to fly (flying archetypes) |
| `LMB` / `J` | Light attack |
| `RMB` / `K` | Heavy attack (big launch) |
| `Q` / `E` | Ability 1 / Ability 2 |
| `Tab` | Swap archetype |
| `R` | Restart the round |
| `` ` `` | Toggle the telemetry panel |
| `F` | Toggle free camera |
| `O` | Overview camera |
| `G` | Detonate a nuke at the camera target (dev) |

## The cast

Four "movement + power fantasies" rather than licensed heroes:

| id | fantasy | signature |
| --- | --- | --- |
| `aegis` | flying brick | superspeed dash that bores through buildings, heat vision |
| `titan` | strength brawler | huge leaps, ground pound, shockwave clap |
| `volt` | armoured projector | hover, repulsor blasts, barrage |
| `amazon` | agile warrior | fast ground game, charge slam, shockwave brace |

All four share one rigid-part rig built in headless Blender (~1,400 triangles each,
15–16 parts, vertex-coloured with a baked ambient term, no skinning). Animation is
procedural: ~a dozen joint rotations per
character, driven by motion state instead of clips — which is precisely how PS2-era
games animated, and why a full 1:1 fight plus debris stays in budget.

## Architecture

```
src/
  main.ts                 entry: canvas, boot, ready signal
  game.ts                 game shell — loop, combat arbitration, CharWorld impl
  core/
    profiler.ts           frame timings + rolling telemetry (feeds the HUD/captures)
    input.ts              keyboard/mouse, camera-relative intent
    util.ts               clamp/lerp math
  sdf/
    sdf.ts                primitive distance functions
    blueprint.ts          deterministic city layout (streets, blocks, buildings, props)
    grid.ts               per-building voxel SDF grid + damage state
    surfaceNets.ts        table-free Surface Nets: SDF grid -> indexed triangles
    field.ts              global field queries (city-wide nearest distance)
  workers/
    mesh.worker.ts        surface-nets meshing off the main thread
  world/
    city.ts               streaming mesher, LOD impostors, collapse logic
    destruction.ts        impact -> carve -> structural check -> debris/collapse
    fx.ts                 debris, dust, scorch decals
    fxBeams.ts            beams, shockwave rings, ability FX
    props.ts              instanced street furniture
    meshQueue.ts          worker job scheduler with LOD/priority
  render/
    pipeline.ts           low-res scene target + bloom + quantise/dither/scanline
    materials.ts          character/terrain/debris materials
    textures.ts           procedural facade atlas, ground, decals (canvas)
    cameraRig.ts          third-person orbit + spring follow + SDF boom collision
  entities/
    archetypes.ts         gameplay tuning for the four heroes
    character.ts          movement, flight, states, attacks, SDF collision
    rig.ts                procedural rigid-part animation
    models.ts             GLB cache + per-instance clone/material sharing
    ai.ts                 opponent state machine + stall breaker
  ui/
    hud.ts                health bars, announcements, touch controls
    debug.ts              render-tuning panel
    api.ts                window.__SBS automation surface (used by captures)
tools/blender/
  build_assets.py         headless Blender -> glTF (characters + props)
scripts/
  shot.mjs                screenshot + telemetry capture for one scenario
  scenarios.mjs           named, scripted capture scenarios
  monitor.mjs             run every scenario, then rebuild the dashboard
  gallery.mjs             captures/* -> captures/index.html + PROGRESS.md
```

### Destruction

Each destructible building owns a voxel SDF grid. A fast impact carves the field
along its path (`grid.carve`), which:

1. damages the grid's structural "support" fraction,
2. marks affected chunks dirty so the mesher re-tessellates them,
3. spawns debris, dust and scorch decals, and
4. when support drops far enough, **collapses** the building — the upper mass
   shears off and becomes debris.

Characters collide against the same field, so a dash or a flung body passes through
the hole it just made; a heavy hit launches at 40–70 m/s, enough to punch through a
reinforced concrete tower.

### Rendering & performance

The pipeline renders the scene to a `renderScale` internal target (default **0.62**),
then composites bloom, colour quantisation, ordered dither, vignette and scanlines.
Everything is one fullscreen quad per pass — no `EffectComposer`, no per-frame
allocations. Fixed low resolution is the single biggest win for Apple GPUs because
fill rate and tile-memory traffic scale with area.

Optimisation choices aligned with Apple's silicon guidance:

- worker-pool meshing keeps the main thread free for the render loop,
- one instanced draw for the distant skyline impostors,
- shared materials so each character is a single draw,
- typed arrays and object/vector reuse throughout the hot paths (no GC churn),
- capped debris/dust pools instead of unbounded spawning,
- `requestAnimationFrame` loop with a fixed 1/60 sim step.

Typical numbers from the capture set (`PROGRESS.md`): **~50–60 fps** at 1984×1116
internal resolution with 1.0–1.3M triangles and 200–320 draw calls, on an M4 Pro.

## Progress monitoring

The visual feedback loop is built in:

```
npm run shot -- <name> --scenario <scenario>   # one scripted checkpoint
npm run monitor                                # every scenario -> captures/ + PROGRESS.md
```

`monitor` drives each scenario through headless Chrome with hardware WebGL, writes
`captures/<name>.png` and `captures/<name>.json` (telemetry + console log), then
regenerates:

- `captures/index.html` — a self-contained contact sheet (images embedded as data
  URLs; open it directly, no server needed),
- `PROGRESS.md` — the same numbers as a table.

Scenarios live in `scripts/scenarios.mjs`; each poses the world and can fire actions.
The scripted surface is `window.__SBS` (see `src/ui/api.ts`):

```js
window.__SBS.telemetry()          // profiler snapshot
window.__SBS.warpToBuilding(2)    // park both fighters in front of a tower
window.__SBS.action('ability1')   // queue a player action
window.__SBS.nuke(x, y, z, r)     // detonate destruction at a point
window.__SBS.autoBattle(true)     // attract mode: the AI drives the player too
```

`autoBattle` makes the match play itself (with a KO auto-reset and a round cap), which
is what the `brawl` capture uses.

## Asset pipeline

Requires Blender on `PATH`:

```
npm run assets      # blender --background --python tools/blender/build_assets.py
```

Writes `public/assets/characters/{aegis,titan,volt,amazon}.glb` and
`public/assets/props/props.glb`. Models are metres, Blender Z-up (exported to glTF
Y-up), face `-Y`, use flat per-face vertex colours in `COLOR_0`, and have each joint's
origin on the joint so rigid-part rotation pivots correctly.

## Deployment notes

`npm run build` type-checks with `tsc --noEmit` and bundles with Vite. The output is
static, so it can be served from any CDN. Touch input and the responsive render
target make it usable on iPhone/iPad; the fixed internal resolution means retina
screens cost resolution, not frame rate.
