# Working on this repo (agent notes)

## Look at the contact sheet, not the captures

`captures/*.png` are 3200×1800 and ~3 MB each. Loading a dozen of them into a
conversation as image attachments is exactly what produced an HTTP 413 (request
too large) and killed a session. Do not do it.

Instead, review the whole set through **one** downscaled JPEG:

```
npm run contact                                   # -> captures/contact.jpg (~200 KB, all 12 tiles)
node scripts/contact.mjs --only street,cast        # subset
node scripts/contact.mjs --only street --cols 1 --width 1400   # one big tile
```

Every tile is labelled with name + fps/frame/draws/tris, so the sheet is
self-describing and the `.json` sidecars usually are not needed.

### Rules of thumb

- **One image per review pass.** Take the contact sheet, decide what to change,
  change it, regenerate, look once. Do not read tile-by-tile.
- **Never re-read an image already in context.** It costs the same bytes again.
- **Never read a full-size `captures/*.png`.** If you must inspect a single
  scenario up close, use `--only <name> --cols 1 --width 1400` which still lands
  around 150 KB.
- **Keep exploratory shots out of the dashboard.** Capture scratch work under a
  `look-*` name (`node scripts/shot.mjs look-thing --eval "…"`), then delete
  `captures/look-*.png` before running `npm run monitor`, otherwise they become
  permanent tiles.
- If a review pass genuinely needs several images, budget them: three or four
  small JPEGs per session is fine, thirty full-size PNGs is a 413.

## The visual loop

```
npm run dev                     # http://127.0.0.1:5177
node scripts/shot.mjs <name> --scenario <scenario> [--eval "js"] [--wait ms]
npm run monitor                 # every scenario + dashboard + contact sheet
npm run contact                 # just rebuild captures/contact.jpg
```

`shot.mjs` exposes `window.__SBS` (see `src/ui/api.ts`) for posing the camera,
firing abilities, warping next to a building and reading telemetry. Scenarios
live in `scripts/scenarios.mjs`.

`npm run monitor` writes `captures/index.html` (full-size dashboard for a human,
browser-only) and `PROGRESS.md`. Use `contact.jpg` when an agent is the reader.

## Assets

Characters and props are generated, not authored by hand:

```
npm run assets                  # headless Blender -> public/assets/**/*.glb
node scripts/glb-inspect.mjs    # part/triangle counts without a viewer
```

`src/entities/models.ts` is the runtime side: it loads the GLB, clones it per
instance and shares materials.

Characters export `TEXCOORD_0`, and those UVs point into the runtime-painted detail
atlas (`paintCharacterAtlas()` in `src/render/textures.ts`). The cell indices exist in
both `tools/blender/build_assets.py` (`UV_SKIN`, `UV_FACE`, ...) and that function —
if you add or move a cell, change both or the cast will wear the wrong material.
