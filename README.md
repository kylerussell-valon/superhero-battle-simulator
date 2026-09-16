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
| `Space` | Jump. In the air (flying archetypes): throttle — hold with `W` to fly where you look, or alone to rise straight up |
| `Space` while flung | Recover — cancel the tumble and take control back |
| Mouse | Look · wheel zoom. Vertical look is `lookUpOnMouseUp` in `cameraRig.ts`; toggle at runtime with `__SBS.setInvertY(true)` |
| `C` / middle mouse | Recentre the camera on the opponent |
| `LMB` / `J` | Light attack |
| `RMB` / `K` | Heavy attack (big launch) |
| `Q` / `E` | Ability 1 / Ability 2 |
| `X` | **Super** — spend a full super meter on your signature ultimate |
| `Tab` | Swap archetype |
| `M` | Pre-fight character select (also the FIGHTERS button) |
| `R` | Restart the round |
| `` ` `` | Toggle the telemetry panel |
| `F` | Toggle free camera |
| `O` | Overview camera |
| `G` | Detonate a nuke at the camera target (dev) |

## Character select

The game opens on a **SELECT FIGHTERS** screen: two columns pick the player and the
opponent independently, each card showing flight/ground, health, speeds, power and
signature abilities. `W`/`S` choose, `A`/`D` switch side, `Enter` starts, mouse
works throughout, and the sim is paused behind it. In-match, `M` (or the FIGHTERS
button) brings it back to pick a different matchup.

The capture tooling navigates with `?capture=1`, which suppresses the auto-open so
scripted scenarios are not blocked by the overlay.

## Supers, combos and impact feedback

Two systems turn a damage exchange into a fight. Both are cheap and both are
centred on making a hit *legible*.

**Combo.** Consecutive hits land harder: each hit in a streak adds 5% damage
(capped at +60%), and the streak lives for 2.4 s of game time. Getting hit clears
your streak, so pressing an advantage is rewarded and trading blow-for-blow is
not. The current streak shows top-centre with a draining timer bar.

**Super meter.** Every fighter carries a 0–100 meter that fills from damage dealt
(12% of the damage) *and* damage taken (7.5%), so a losing fighter is always
closing on a comeback. When it is full the meter pulses, the HUD offers
`SUPER READY · PRESS X`, and `X` cashes it in for the archetype's signature
ultimate:

| id | super | what it does |
| --- | --- | --- |
| `aegis` | SOLAR FLARE | white-hot core, a starburst of heat rays and a skyward column |
| `titan` | SEISMIC SLAM | a wide ground rupture that carves a disk out of the block |
| `volt` | OVERLOAD | repulsor fire in every direction at once |
| `amazon` | GODDESS WRATH | a closing lunge into expanding shock rings |

Activation drops the sim into slow-motion for half a second, flashes the screen
in the hero's colour and shakes the camera, then the blast goes through the same
carve/damage/collapse plumbing as any other hit — a `titan` super can bring a
building down, and every super launches whoever is in range.

**Impact feedback.** A landed hit spawns an additive spark burst tinted by the
attacker, a floating damage number projected from world space, and a hitstop
beat. Heavy and fling-tier blows (110+ damage) get a larger, amber "crit" number
with a pop. A KO adds a beat of slow-motion and a `K.O.` stamp on the loser.

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
                          (wall / roof / storefront groups + baked cavity AO)
    field.ts              global field queries (city-wide nearest distance)
  workers/
    mesh.worker.ts        surface-nets meshing off the main thread
  world/
    city.ts               streaming mesher, LOD impostors, roof tints, collapse logic
    destruction.ts        impact -> carve -> structural check -> debris/collapse
    fx.ts                 debris, dust, scorch decals
    fxBeams.ts            beams, shockwave rings, ability FX
    props.ts              instanced street furniture
    meshQueue.ts          worker job scheduler with LOD/priority
  render/
    pipeline.ts           low-res scene target + bloom + quantise/dither/scanline
    materials.ts          character/terrain/debris materials
    textures.ts           procedural facade/storefront/roof/ground + character atlas
    cameraRig.ts          third-person orbit + spring follow + SDF boom collision
  entities/
    archetypes.ts         gameplay tuning for the four heroes (+ their supers)
    character.ts          movement, flight, states, attacks, super meter, SDF collision
    rig.ts                procedural rigid-part animation
    models.ts             GLB cache + per-instance clone/material sharing
    ai.ts                 opponent state machine + stall breaker
  ui/
    hud.ts                health/energy/super bars, combos, announcements, touch controls
    floaters.ts           world-space floating damage numbers
    debug.ts              render-tuning panel
    api.ts                window.__SBS automation surface (used by captures)
tools/blender/
  build_assets.py         headless Blender -> glTF (characters + props)
scripts/
  shot.mjs                screenshot + telemetry capture for one scenario
  scenarios.mjs           named, scripted capture scenarios
  monitor.mjs             run every scenario, then rebuild the dashboard
  gallery.mjs             captures/* -> captures/index.html + PROGRESS.md
  contact.mjs             captures/* -> one small captures/contact.jpg (agent review)
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

Loose matter (rubble, street furniture) queries the *building* field, not
`PhysWorld.distance()` — that one is clamped by ground height, which made anything
within a metre or two of the street look like it was inside concrete, so debris and
cars bounced off the pavement as if it were a wall and hovered there instead of
settling. Rubble also spawns as fixed ~1.5-3.5 m pieces rather than a fraction of a
16 m chunk, so a collapse reads as a pile of debris at character scale instead of a
handful of giant blocks, and a chunk sleeps once it is supported by the street *or*
by other rubble.

Getting flung is not a cutscene. Steering ramps in as the tumble burns off, so
you can shape your own trajectory partway through; the tumble amplitude and
frequency decay with it; **jump cancels the fling** once the window opens (the HUD
prompts), keeping the momentum you arrived with; and jump also cancels a
knockdown. Surface impacts extend the tumble only a little and never past the
original duration, and there is exactly one ground bounce rather than a
restitution loop.

Melee is a **capsule swept along the aim** (chest → aim × reach, radius
`hitRadius`), not a sphere around the character: a punch lands where you look, at
whatever altitude you look, and cannot clip a target standing behind you. Light and
heavy swings also add a forward `lunge` impulse so a strike commits instead of
hanging in the air. The player's aim comes from the camera direction, so aiming,
punching and flight heading are all the same input.

### Flight

Flight follows the camera in full 3D. The horizontal share of the flight speed
scales with the aim's horizontal component, so pitching away from level moves
speed into climb or dive instead of sliding sideways while the vertical axis does
its own thing:

| aim | result |
| --- | --- |
| level | level flight at `airSpeed` |
| up | climbs — measured `vy` matches `sin(pitch) * airSpeed` exactly |
| down | dives |
| no direction, `Space` | straight up (take-off is still one key) |
| no input | holds station, so you can stop and aim |

### Street level

Surface Nets emits three index groups per building: **wall**, **roof**, and
**storefront** (facade faces whose centroid sits below `GROUND_FLOOR_Y_M`, i.e. the
first 4 m tile). The ground floor therefore samples a different atlas — plinth,
glazing with lit shop interiors, a sign fascia and a striped awning — which is what
makes a street read as a street rather than a wall of windows running into the
pavement. Only hero-LOD buildings request the storefront group, so the far city pays
no extra draw calls. Roofs get a per-building tar/gravel tint applied to their vertex
colours, so the skyline seen from the overview camera is not one flat sheet of grey.

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
internal resolution with 1.0–1.3M triangles and 200–360 draw calls, on an M4 Pro.

## Progress monitoring

The visual feedback loop is built in:

```
npm run shot -- <name> --scenario <scenario>   # one scripted checkpoint
npm run monitor                                # every scenario -> captures/ + PROGRESS.md
npm run contact                                # captures/* -> one small captures/contact.jpg
```

`monitor` drives each scenario through headless Chrome with hardware WebGL, writes
`captures/<name>.png` and `captures/<name>.json` (telemetry + console log), then
regenerates:

- `captures/contact.jpg` — **one** downscaled, self-labelled sheet of the whole set,
- `captures/index.html` — a self-contained contact sheet (images embedded as data
  URLs; open it directly, no server needed),
- `PROGRESS.md` — the same numbers as a table.

The full-size PNGs are ~3 MB each; attaching several at once is what blows a
request limit. Review from `captures/contact.jpg` (or
`node scripts/contact.mjs --only <name> --cols 1 --width 1400` for a single
scenario) — see [AGENTS.md](AGENTS.md) for the protocol.

Scenarios live in `scripts/scenarios.mjs`; each poses the world and can fire actions.
The scripted surface is `window.__SBS` (see `src/ui/api.ts`):

```js
window.__SBS.telemetry()          // profiler snapshot
window.__SBS.warpToBuilding(2)    // park both fighters in front of a tower
window.__SBS.action('ability1')   // queue a player action
window.__SBS.nuke(x, y, z, r)     // detonate destruction at a point
window.__SBS.autoBattle(true)     // attract mode: the AI drives the player too
window.__SBS.hud(false)           // hide the HUD for a clean capture
window.__SBS.swapHero('titan')    // switch archetype
window.__SBS.setSuper(100)        // fill the super meter (also 'foe')
window.__SBS.action('super')      // fire the signature ultimate
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

### Character detail atlas

Characters also carry `TEXCOORD_0`. Every face is UV-mapped inside one cell of a
4x4 **detail atlas** painted at runtime by `paintCharacterAtlas()` in
`src/render/textures.ts`; the character material multiplies that atlas by the flat
vertex colour. One texture therefore gives fabric weave to the suit, brushed metal
to the bracers, leather to the boots, strands to the hair, and paints a face across
the head's planar-mapped front — while the per-archetype palette stays in the vertex
colours.

The cell indices are duplicated on both sides of the boundary:

| | |
| --- | --- |
| Python | `UV_SKIN`, `UV_FACE`, `UV_HAIR`, `UV_SUIT`, ... in `tools/blender/build_assets.py` |
| TypeScript | the same order, cells drawn top-left to bottom-right in `paintCharacterAtlas()` |

If you add or move a cell, change both. The face projection is also shared: the head
parts pass a `front=(cell, cu, cv, su, sv)` projection so brow, eyes, nose and mouth
land at the geometry's coordinates rather than being stamped per polygon.

## Deployment notes

`npm run build` type-checks with `tsc --noEmit` and bundles with Vite. The output is
static, so it can be served from any CDN. Touch input and the responsive render
target make it usable on iPhone/iPad; the fixed internal resolution means retina
screens cost resolution, not frame rate.
