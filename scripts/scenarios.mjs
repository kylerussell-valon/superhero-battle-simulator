/**
 * Named capture scenarios. Each entry poses the world and optionally fires an
 * action, so `npm run shot <name> --scenario <scenario>` gives a repeatable
 * visual checkpoint while iterating.
 */
export const scenarios = {
  overview: {
    setup: `window.__SBS.debug(false); window.__SBS.overview(430, 210);`,
    wait: 900,
  },
  street: {
    // Explicit placement rather than an orbit anchor: the anchor landed the camera
    // inside a facade depending on which building happened to sit behind it.
    setup: `(() => {
        const S = window.__SBS;
        S.debug(false);
        S.warpToBuilding(6, 24, 3.2, 0, false);
        const p = S.playerInfo().player;
        // Three-quarter elevated view down the street: facade, storefronts and
        // roadway all read at once.
        S.camera(p.x + 7, p.y + 9.5, p.z + 17, p.x - 1, p.y + 1.5, p.z - 22);
        S.freeze(true);
        return 'ok';
      })()`,
    wait: 1100,
  },
  storefront: {
    // Eye height in front of a ground-floor block: plinth, glazing, sign fascia
    // and awning in one frame, on the sunlit facade.
    setup: `(() => {
        const S = window.__SBS;
        S.debug(false);
        S.set('renderScale', 0.8);
        const idx = S.game.city.destructibles.findIndex((r) => r.spec.lod === 0 && r.spec.hw > 20);
        const b = S.game.city.destructibles[idx].spec;
        S.camera(b.x - b.hw * 0.4, 3.2, b.z + b.hd + 14, b.x + b.hw * 0.35, 2.3, b.z + b.hd - 1);
        S.freeze(true);
        return idx;
      })()`,
    wait: 1000,
  },
  cast: {
    setup: `window.__SBS.debug(false); window.__SBS.set('renderScale', 0.8); window.__SBS.showcase();`,
    wait: 900,
  },
  hero: {
    // Close portrait of one archetype (default aegis) for face/suit review.
    setup: `(() => {
        const S = window.__SBS;
        S.debug(false);
        S.hud(false);
        S.set('renderScale', 1);
        S.ai(false);
        S.freeze(true);
        S.game.player.placeAt(0, S.game.player.arch.halfHeight + 0.02, 0, 0);
        S.camera(0.42, 1.5, 1.75, 0, 1.4, 0);
        return 'ok';
      })()`,
    wait: 1000,
  },
  fight: {
    // Let the AI close the gap, then park a free camera in a three-quarter view
    // of the pair so the money shot actually contains both fighters.
    setup: `(async () => {
        const S = window.__SBS;
        S.debug(true);
        S.ai(true);
        for (let i = 0; i < 900; i++) {
          await S.frames(1);
          if (S.playerInfo().distance < 5) break;
        }
        const info = S.playerInfo();
        const a = Math.atan2(info.foe.x - info.player.x, info.foe.z - info.player.z);
        const mx = (info.player.x + info.foe.x) / 2;
        const mz = (info.player.z + info.foe.z) / 2;
        const my = (info.player.y + info.foe.y) / 2 + 1.3;
        const back = 8.5;
        const side = 5.5;
        S.camera(
          mx - Math.sin(a) * back + Math.cos(a) * side,
          my + 2.6,
          mz - Math.cos(a) * back - Math.sin(a) * side,
          mx, my, mz,
        );
        await S.frames(2);
        S.freeze(true);
      })();`,
    wait: 500,
    after: 'JSON.stringify(window.__SBS.playerInfo())',
  },
  brawl: {
    // Attract mode: the AI drives both fighters, so destruction accumulates on
    // its own while the camera sits back and watches.
    setup: `(async () => {
        const S = window.__SBS;
        S.debug(true);
        S.ai(true);
        S.autoBattle(true);
        S.aim(3.0, -0.24);
        await S.frames(30);
      })();`,
    wait: 16000,
    after: 'JSON.stringify(window.__SBS.playerInfo())',
  },
  'dash-fling': {
    // Ram the opponent with superspeed: the target gets launched and carries on
    // through whatever is behind it.
    setup: `(async () => {
        const S = window.__SBS;
        S.debug(true);
        S.warpToBuilding(6, 26, 2.2, 0);
        await S.frames(14);
        S.action('ability1', 0.7);
        await S.frames(150);
      })();`,
    wait: 3200,
    after: 'JSON.stringify(window.__SBS.playerInfo())',
  },
  'ram-building': {
    // Fly straight through a tower: it gets drilled, the base is compromised and
    // the building comes down.
    setup: `(async () => {
        const S = window.__SBS;
        S.debug(true);
        S.warpToBuilding(2, 34, -1, 0);
        await S.frames(14);
        S.action('ability1', 0.9);
        await S.frames(150);
        // Fixed offset framing so the tile cannot end up nose-first in a wall.
        const p = S.playerInfo().player;
        S.camera(p.x + 10, p.y + 6, p.z + 12, p.x, p.y + 1.2, p.z - 3);
        S.freeze(true);
      })();`,
    wait: 4200,
    after: 'JSON.stringify(window.__SBS.telemetry())',
  },
  'heat-vision': {
    setup: `(async () => {
        const S = window.__SBS;
        S.debug(true);
        S.warpToBuilding(5, 40, 14, 0);
        await S.frames(14);
        S.action('ability2', 0.4);
        await S.frames(90);
      })();`,
    wait: 3200,
  },
  'titan-pound': {
    setup: `(async () => {
        const S = window.__SBS;
        S.debug(true);
        S.swapHero('titan');
        S.warpToBuilding(9, 22, 2.2, 0);
        await S.frames(14);
        S.action('jump', 0.65);
        await S.frames(70);
        S.action('ability2', 0.6);
        await S.frames(150);
      })();`,
    wait: 3200,
  },
  'shockwave-clap': {
    setup: `(async () => {
        const S = window.__SBS;
        S.debug(true);
        S.swapHero('amazon');
        S.warpToBuilding(3, 15, 2.2, 0, false);
        await S.frames(14);
        S.action('ability2', 0.4);
        await S.frames(120);
        // Frame the wreckage from a fixed offset rather than trusting the rig.
        const p = S.playerInfo().player;
        S.camera(p.x + 8, p.y + 4.5, p.z + 11, p.x, p.y + 0.8, p.z);
        S.freeze(true);
      })();`,
    wait: 2600,
  },
  aftermath: {
    setup: `(async () => {
        const S = window.__SBS;
        S.debug(true);
        S.warpToBuilding(1, 30, 3, 0);
        const list = [0, 4, 12, 18, 25, 30];
        for (const i of list) {
          const rt = S.game.city.destructibles[i];
          S.nuke(rt.spec.x, rt.spec.h * 0.25, rt.spec.z, Math.max(10, Math.min(22, rt.spec.h * 0.4)));
          await S.frames(30);
        }
        await S.frames(60);
        S.overview(330, 150);
      })();`,
    wait: 5200,
  },
  'lowres-retro': {
    setup: `window.__SBS.debug(false); window.__SBS.overview(300, 150); window.__SBS.set('renderScale', 0.42); window.__SBS.set('quantization', 20);`,
    wait: 900,
  },
}
