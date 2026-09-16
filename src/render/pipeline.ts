import * as THREE from 'three'

/**
 * Rendering pipeline with a fixed, low internal resolution — the single biggest
 * win for the PS2/GameCube look *and* for performance on Apple GPUs (fill rate
 * and tile memory traffic scale with area).
 *
 * Passes:
 *   1. scene -> rtScene        (renderScale * device pixels)
 *   2. bright pass -> 1/4       (threshold)
 *   3. two separable blurs
 *   4. composite: bloom + colour quantisation + ordered dither + vignette +
 *      scanlines + hit flash -> canvas
 *
 * Everything is one fullscreen triangle-strip quad per pass; no EffectComposer,
 * no extra render targets beyond what is listed, no per-frame allocations.
 */

export interface RenderSettings {
  renderScale: number
  quantization: number // 0 = off, else steps per channel (e.g. 32 -> 5 bits)
  dither: number
  vignette: number
  scanlines: number
  bloom: number
  saturation: number
  fov: number
  /** Chromatic aberration strength at the frame edge. */
  aberration: number
  /** Animated film grain amount. */
  grain: number
  /** Split-tone grade: cool shadows -> warm highlights, -1..1. */
  grade: number
}

export const DEFAULT_SETTINGS: RenderSettings = {
  renderScale: 0.66,
  quantization: 32,
  dither: 1.35,
  vignette: 0.26,
  scanlines: 0.05,
  bloom: 0.55,
  saturation: 1.07,
  fov: 62,
  aberration: 0.18,
  grain: 0.04,
  grade: 0.26,
}

const QUAD_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

const DITHER_GLSL = /* glsl */ `
  // Compact analytic 4x4 Bayer (no local array indexing, which is slow/UB on
  // some mobile GLSL compilers).
  float bayer2(vec2 a) { a = floor(a); return fract(a.x * 0.5 + a.y * a.y * 0.75); }
  float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }
`

export class Pipeline {
  readonly renderer: THREE.WebGLRenderer
  settings: RenderSettings
  private rtScene!: THREE.WebGLRenderTarget
  private rtBright!: THREE.WebGLRenderTarget
  private rtBlurA!: THREE.WebGLRenderTarget
  private rtBlurB!: THREE.WebGLRenderTarget
  private quadScene = new THREE.Scene()
  private quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private brightMat: THREE.ShaderMaterial
  private blurMat: THREE.ShaderMaterial
  private compositeMat: THREE.ShaderMaterial
  private quad: THREE.Mesh
  private width = 1
  private height = 1
  private rw = 1
  private rh = 1

  constructor(canvas: HTMLCanvasElement, settings: RenderSettings = DEFAULT_SETTINGS) {
    this.settings = settings
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      stencil: false,
      depth: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    })
    this.renderer.autoClear = true
    this.renderer.setClearColor(0x0a0d18, 1)
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFShadowMap
    this.renderer.outputColorSpace = THREE.SRGBColorSpace

    this.brightMat = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, uThreshold: { value: 0.9 }, uKnee: { value: 0.25 } },
      vertexShader: QUAD_VERT,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        uniform float uThreshold;
        uniform float uKnee;
        varying vec2 vUv;
        void main() {
          vec3 c = texture2D(tDiffuse, vUv).rgb;
          float l = max(c.r, max(c.g, c.b));
          float k = clamp((l - uThreshold) / max(0.001, uKnee), 0.0, 1.0);
          gl_FragColor = vec4(c * k, 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
    })

    this.blurMat = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, uDir: { value: new THREE.Vector2(1, 0) }, uTexel: { value: new THREE.Vector2() } },
      vertexShader: QUAD_VERT,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        uniform vec2 uDir;
        uniform vec2 uTexel;
        varying vec2 vUv;
        void main() {
          vec2 o = uDir * uTexel;
          vec3 sum = texture2D(tDiffuse, vUv).rgb * 0.227027;
          sum += texture2D(tDiffuse, vUv + o * 1.3846).rgb * 0.316216;
          sum += texture2D(tDiffuse, vUv - o * 1.3846).rgb * 0.316216;
          sum += texture2D(tDiffuse, vUv + o * 3.2308).rgb * 0.070270;
          sum += texture2D(tDiffuse, vUv - o * 3.2308).rgb * 0.070270;
          gl_FragColor = vec4(sum, 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
    })

    this.compositeMat = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        tBloom: { value: null },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uQuant: { value: settings.quantization },
        uDither: { value: settings.dither },
        uVignette: { value: settings.vignette },
        uScanlines: { value: settings.scanlines },
        uBloom: { value: settings.bloom },
        uSaturation: { value: settings.saturation },
        uFlash: { value: new THREE.Color(0, 0, 0) },
        uFade: { value: 0 },
        uTime: { value: 0 },
        uAberration: { value: settings.aberration },
        uGrain: { value: settings.grain },
        uGrade: { value: settings.grade },
      },
      vertexShader: QUAD_VERT,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        uniform sampler2D tBloom;
        uniform vec2 uResolution;
        uniform float uQuant;
        uniform float uDither;
        uniform float uVignette;
        uniform float uScanlines;
        uniform float uBloom;
        uniform float uSaturation;
        uniform vec3 uFlash;
        uniform float uFade;
        uniform float uTime;
        uniform float uAberration;
        uniform float uGrain;
        uniform float uGrade;
        varying vec2 vUv;
        ${DITHER_GLSL}
        void main() {
          vec2 d = vUv - 0.5;
          float r2 = dot(d, d);

          // Radial chromatic aberration — samples fan out towards the edges,
          // the classic composite-video fringe.
          vec2 ca = d * (uAberration * 0.02 * (r2 * 2.2));
          vec3 c;
          c.r = texture2D(tDiffuse, vUv + ca).r;
          c.g = texture2D(tDiffuse, vUv).g;
          c.b = texture2D(tDiffuse, vUv - ca).b;
          c += texture2D(tBloom, vUv).rgb * uBloom;

          // Saturation push (era-accurate punchy colour)
          float l = dot(c, vec3(0.299, 0.587, 0.114));
          c = mix(vec3(l), c, uSaturation);

          // Split-tone grade: lift shadows cool, highlights warm.
          vec3 cool = vec3(0.92, 0.97, 1.06);
          vec3 warm = vec3(1.08, 1.02, 0.92);
          float luma = clamp(l, 0.0, 1.0);
          vec3 tint = mix(cool, warm, smoothstep(0.18, 0.9, luma));
          c *= mix(vec3(1.0), tint, uGrade);

          // Hit flash / damage tint
          c += uFlash;

          // Ordered dither + quantisation to a 16/32-step palette
          if (uDither > 0.0) c += bayer4(gl_FragCoord.xy) * (uDither / 255.0);
          if (uQuant > 1.0) c = floor(c * uQuant + 0.5) / uQuant;

          // CRT-ish vignette + faint scanlines
          float v = 1.0 - uVignette * r2 * 2.6;
          c *= clamp(v, 0.0, 1.0);
          if (uScanlines > 0.0) {
            float s = 1.0 - uScanlines * (0.5 + 0.5 * sin(vUv.y * uResolution.y * 3.14159));
            c *= s;
          }

          // Animated grain (fine, luminance-weighted so dark areas stay clean)
          if (uGrain > 0.0) {
            float n = fract(sin(dot(gl_FragCoord.xy + uTime * 91.7, vec2(12.9898, 78.233))) * 43758.5453);
            c += (n - 0.5) * uGrain * (0.35 + 0.65 * (1.0 - luma));
          }

          c *= 1.0 - uFade;
          gl_FragColor = vec4(c, 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
    })

    const geo = new THREE.PlaneGeometry(2, 2)
    this.quad = new THREE.Mesh(geo, this.compositeMat)
    this.quad.frustumCulled = false
    this.quadScene.add(this.quad)
  }

  setSize(width: number, height: number): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    this.width = Math.max(1, Math.floor(width * dpr))
    this.height = Math.max(1, Math.floor(height * dpr))
    this.renderer.setPixelRatio(1)
    this.renderer.setSize(width, height, false)
    this.rebuildTargets()
  }

  private rebuildTargets(): void {
    const s = this.settings.renderScale
    this.rw = Math.max(64, Math.floor(this.width * s))
    this.rh = Math.max(64, Math.floor(this.height * s))
    const opts: THREE.RenderTargetOptions = {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      depthBuffer: true,
      stencilBuffer: false,
    }
    this.rtScene?.dispose()
    this.rtBright?.dispose()
    this.rtBlurA?.dispose()
    this.rtBlurB?.dispose()
    this.rtScene = new THREE.WebGLRenderTarget(this.rw, this.rh, opts)
    this.rtScene.texture.colorSpace = THREE.SRGBColorSpace
    const bw = Math.max(32, this.rw >> 2)
    const bh = Math.max(32, this.rh >> 2)
    this.rtBright = new THREE.WebGLRenderTarget(bw, bh, { ...opts, depthBuffer: false })
    this.rtBlurA = new THREE.WebGLRenderTarget(bw, bh, { ...opts, depthBuffer: false })
    this.rtBlurB = new THREE.WebGLRenderTarget(bw, bh, { ...opts, depthBuffer: false })
    this.compositeMat.uniforms.uResolution.value.set(this.rw, this.rh)
    this.blurMat.uniforms.uTexel.value.set(1 / bw, 1 / bh)
  }

  applySettings(): void {
    const s = this.settings
    this.compositeMat.uniforms.uQuant.value = s.quantization
    this.compositeMat.uniforms.uDither.value = s.dither
    this.compositeMat.uniforms.uVignette.value = s.vignette
    this.compositeMat.uniforms.uScanlines.value = s.scanlines
    this.compositeMat.uniforms.uBloom.value = s.bloom
    this.compositeMat.uniforms.uSaturation.value = s.saturation
    this.compositeMat.uniforms.uAberration.value = s.aberration
    this.compositeMat.uniforms.uGrain.value = s.grain
    this.compositeMat.uniforms.uGrade.value = s.grade
  }

  /** Advance animated post effects (film grain). */
  tick(time: number): void {
    this.compositeMat.uniforms.uTime.value = time
  }

  setFlash(r: number, g: number, b: number): void {
    ;(this.compositeMat.uniforms.uFlash.value as THREE.Color).setRGB(r, g, b)
  }
  setFade(v: number): void {
    this.compositeMat.uniforms.uFade.value = v
  }

  /** Draw calls / triangles for the scene pass only (info resets per render()). */
  sceneCalls = 0
  sceneTriangles = 0

  render(scene: THREE.Scene, camera: THREE.Camera): void {
    const r = this.renderer
    r.setRenderTarget(this.rtScene)
    r.clear()
    r.render(scene, camera)
    this.sceneCalls = r.info.render.calls
    this.sceneTriangles = r.info.render.triangles

    const bloom = this.settings.bloom > 0.001
    if (bloom) {
      this.quad.material = this.brightMat
      this.brightMat.uniforms.tDiffuse.value = this.rtScene.texture
      r.setRenderTarget(this.rtBright)
      r.render(this.quadScene, this.quadCam)

      this.quad.material = this.blurMat
      this.blurMat.uniforms.tDiffuse.value = this.rtBright.texture
      this.blurMat.uniforms.uDir.value.set(1, 0)
      r.setRenderTarget(this.rtBlurA)
      r.render(this.quadScene, this.quadCam)

      this.blurMat.uniforms.tDiffuse.value = this.rtBlurA.texture
      this.blurMat.uniforms.uDir.value.set(0, 1)
      r.setRenderTarget(this.rtBlurB)
      r.render(this.quadScene, this.quadCam)
    }

    this.quad.material = this.compositeMat
    this.compositeMat.uniforms.tDiffuse.value = this.rtScene.texture
    this.compositeMat.uniforms.tBloom.value = bloom ? this.rtBlurB.texture : this.rtBright?.texture ?? null
    this.compositeMat.uniforms.uBloom.value = bloom ? this.settings.bloom : 0
    r.setRenderTarget(null)
    r.render(this.quadScene, this.quadCam)
  }

  get internalWidth(): number {
    return this.rw
  }
  get internalHeight(): number {
    return this.rh
  }
}

/**
 * PS2-era sky: a vertical gradient, a sun disc with glow, a procedural cloud
 * deck and a horizon haze band, drawn on a single inverted sphere. Also returns
 * a fog colour so distance haze matches the horizon.
 */
export function createSky(sunDir: THREE.Vector3): { mesh: THREE.Mesh; fogColor: THREE.Color } {
  const fog = new THREE.Color(0xc3c5c6)
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTop: { value: new THREE.Color(0x3a78c4) },
      uMid: { value: new THREE.Color(0x9cc4ea) },
      uBottom: { value: new THREE.Color(0xe6dfcd) },
      uSun: { value: sunDir.clone().normalize() },
      uSunColor: { value: new THREE.Color(0xfff0c4) },
      uCloud: { value: new THREE.Color(0xffffff) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uTop;
      uniform vec3 uMid;
      uniform vec3 uBottom;
      uniform vec3 uSun;
      uniform vec3 uSunColor;
      uniform vec3 uCloud;
      varying vec3 vDir;

      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
      float vnoise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        float a = hash(i), b = hash(i + vec2(1.0, 0.0));
        float c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
        return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
      }
      float fbm(vec2 p) {
        float v = 0.0, a = 0.5;
        for (int i = 0; i < 4; i++) { v += a * vnoise(p); p = p * 2.03 + 7.1; a *= 0.5; }
        return v;
      }

      void main() {
        vec3 d = normalize(vDir);
        float h = clamp(d.y * 0.5 + 0.5, 0.0, 1.0);
        vec3 c = mix(uBottom, uMid, smoothstep(0.44, 0.60, h));
        c = mix(c, uTop, smoothstep(0.58, 1.0, h));

        float s = max(dot(d, normalize(uSun)), 0.0);
        c += uSunColor * pow(s, 220.0) * 1.6;
        c += uSunColor * pow(s, 14.0) * 0.12;

        // Two procedural cloud decks: a big soft cumulus layer with fine
        // detail, plus a higher, slower deck for parallax. Both are projected
        // onto planes above the camera; the +const in the divisor keeps the
        // projection from blowing up (and aliasing) at the horizon.
        float cover = smoothstep(0.0, 0.18, d.y);
        if (cover > 0.002 && d.y > 0.0) {
          vec2 uv = d.xz / (d.y + 0.14) * 1.15;
          float big = fbm(uv * 0.6 + 3.1);
          float det = fbm(uv * 2.3 - 6.4);
          // fbm output clusters tightly around ~0.46, so thresholding it raw
          // gives either no clouds or a solid overcast deck. Adding a broad
          // "weather" term breaks it into distinct masses with clear blue
          // between them.
          float weather = fbm(uv * 0.18 + 40.0);
          float shape = big + (det - 0.46) * 0.45 + (weather - 0.46) * 0.35;
          float cl = smoothstep(0.43, 0.63, shape);

          // A higher, slower deck drifts behind the first for parallax.
          vec2 uv2 = d.xz / (d.y + 0.34) * 0.55;
          float cl2 = smoothstep(0.45, 0.68, fbm(uv2 + 21.7) + (fbm(uv2 * 0.22 + 7.0) - 0.46) * 0.4) * 0.6;
          cl = max(cl, cl2);
          cl *= cover;

          // Sun-kissed tops, shaded bases, and a silver lining towards the sun.
          float lit = 0.3 + 0.6 * pow(s, 1.6);
          vec3 cloudCol = mix(vec3(0.52, 0.58, 0.68), uCloud, lit);
          cloudCol += uSunColor * pow(s, 9.0) * 0.4;
          c = mix(c, cloudCol, cl);
        }

        // Horizon haze deepens towards the fog colour.
        c = mix(c, uBottom, pow(1.0 - clamp(d.y, 0.0, 1.0), 9.0) * 0.55);
        gl_FragColor = vec4(c, 1.0);
      }
    `,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  })
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1600, 32, 20), mat)
  mesh.frustumCulled = false
  return { mesh, fogColor: fog }
}

/** Additive unlit material for beams, shockwave rings and impact flashes. */
export function createFxMaterial(color: number, opacity = 0.75): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
  })
}
