import * as THREE from 'three'
import type { TextureLibrary } from './textures'

/**
 * Shared material set. Deliberately small: everything in the city is Lambert
 * (per-fragment but cheap), untextured props use vertex colours, and debris
 * reuses the concrete map. Fewer materials = fewer state changes = happier
 * Metal driver.
 */
export interface MaterialLibrary {
  walls: THREE.MeshLambertMaterial[]
  /** Distant skyline impostors: facade map + per-instance haze tint, no vertex colours. */
  impostor: THREE.MeshLambertMaterial
  /** Debris chunks: concrete map + per-instance colour, no vertex colours. */
  debris: THREE.MeshLambertMaterial
  roof: THREE.MeshLambertMaterial
  concrete: THREE.MeshLambertMaterial
  ground: THREE.MeshLambertMaterial
  props: THREE.MeshLambertMaterial
  characters: THREE.MeshLambertMaterial
  emissive: THREE.MeshBasicMaterial
  dust: THREE.ShaderMaterial
  decal: THREE.MeshBasicMaterial
  farGround: THREE.MeshLambertMaterial
}

export function buildMaterials(tex: TextureLibrary): MaterialLibrary {
  const walls = tex.walls.map(
    (map) =>
      new THREE.MeshLambertMaterial({
        map,
        vertexColors: true,
        side: THREE.FrontSide,
      }),
  )

  const roof = new THREE.MeshLambertMaterial({ map: tex.roof, vertexColors: true })

  const debris = new THREE.MeshLambertMaterial({ map: tex.concrete })

  return {
    walls,
    impostor: new THREE.MeshLambertMaterial({ map: tex.walls[2] }),
    debris,
    roof,
    concrete: new THREE.MeshLambertMaterial({ map: tex.concrete, vertexColors: true }),
    ground: new THREE.MeshLambertMaterial({ map: tex.ground }),
    props: new THREE.MeshLambertMaterial({ vertexColors: true }),
    characters: new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.FrontSide }),
    emissive: new THREE.MeshBasicMaterial({ color: 0x8ff6ff }),
    dust: makeDustMaterial(tex.dust),
    decal: new THREE.MeshBasicMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      color: 0xffffff,
    }),
    farGround: new THREE.MeshLambertMaterial({ color: 0x5f5f68 }),
  }
}

function makeDustMaterial(map: THREE.Texture): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: map },
      uTint: { value: new THREE.Color(0.86, 0.85, 0.82) },
      uPixelScale: { value: 700 },
    },
    vertexShader: /* glsl */ `
      uniform float uPixelScale;
      attribute float aSize;
      attribute float aAlpha;
      attribute vec3 aColor;
      varying float vAlpha;
      varying vec3 vColor;
      void main() {
        vAlpha = aAlpha;
        vColor = aColor;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        // aSize is metres; scale by the projection so puffs keep real-world size.
        gl_PointSize = aSize * (uPixelScale / max(0.5, -mv.z));
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      uniform vec3 uTint;
      varying float vAlpha;
      varying vec3 vColor;
      void main() {
        vec4 t = texture2D(uMap, gl_PointCoord);
        float a = t.a * vAlpha;
        if (a < 0.01) discard;
        gl_FragColor = vec4(uTint * vColor, a);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
  })
}
