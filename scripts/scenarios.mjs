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
    setup: `window.__SBS.debug(false); window.__SBS.follow(0, 2, 34, 3.05, -0.08, 12);`,
    wait: 900,
  },
  cast: {
    setup: `window.__SBS.debug(false); window.__SBS.set('renderScale', 0.8); window.__SBS.showcase();`,
    wait: 900,
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
        S.warpToBuilding(3, 15, 2.2, 0);
        await S.frames(14);
        S.action('ability2', 0.4);
        await S.frames(120);
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
