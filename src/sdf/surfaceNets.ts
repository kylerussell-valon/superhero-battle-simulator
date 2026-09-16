/**
 * Naive Surface Nets — table-free isosurface extraction tuned for destructible
 * SDF chunks.
 *
 * Why surface nets instead of marching cubes: no 4096-entry triangle table to
 * get wrong, one vertex per cell (which keeps vertex counts and memory low on
 * iOS), quads that read as chunky PS2-era geometry, and clean handling of the
 * 1-cell border needed for crack-free chunk seams.
 *
 * Input is an (CS+2)^3 slab of quantised distances covering one chunk plus a
 * one-cell border. Owned cells are [0..CS), border cells only supply vertices so
 * neighbouring chunks produce bit-identical seam vertices.
 *
 * All scratch buffers are module-level and growable, so a worker streaming
 * hundreds of chunk jobs per second allocates ~nothing (see docs/PERFORMANCE.md).
 */

export interface ChunkMesh {
  positions: Float32Array
  /** Unit normals, normalised int8 (three reads these with `normalized: true`). */
  normals: Int8Array
  uvs: Float32Array
  colors: Uint8Array
  wall: Uint32Array
  roof: Uint32Array
  /** Facade faces below the ground-floor line: storefronts instead of windows. */
  ground: Uint32Array
  vertCount: number
}

export interface MeshJobInput {
  slab: Int8Array
  /** Samples per axis = chunkCells + 2. */
  dim: number
  /** Owned cells per axis. */
  cs: number
  voxel: number
  originX: number
  originY: number
  originZ: number
  /** Metres per texture tile. */
  wallTile: number
  roofTile: number
  /** World Y below which facade faces take the storefront material. */
  groundY: number
  tintR: number
  tintG: number
  tintB: number
}

const CORNER: Int32Array = new Int32Array([
  0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1, 1, 1, 1,
])
const EDGE: Int32Array = new Int32Array([
  0, 1, 2, 3, 4, 5, 6, 7, // pairs sharing y,z at x=0 -> edges along x
  0, 2, 1, 3, 4, 6, 5, 7, // along y
  0, 4, 1, 5, 3, 7, 2, 6, // along z
])

// ---- Growable scratch (reused across jobs) --------------------------------
let sVertIndex: Int32Array<ArrayBuffer> = new Int32Array(0)
let sPos: Float32Array<ArrayBuffer> = new Float32Array(0)
let sCornerVal = new Float32Array(8)
let sCornerP = new Float32Array(24)
let sWall: Int32Array<ArrayBuffer> = new Int32Array(0)
let sRoof: Int32Array<ArrayBuffer> = new Int32Array(0)
let sGround: Int32Array<ArrayBuffer> = new Int32Array(0)

// Eight cube-corner directions, used for the hemisphere cavity-AO probe. The
// normalised 1/sqrt(3) is folded in so each component is ±0.5773.
const AO_DIRS_SCRATCH = new Float32Array([
  0.5773, 0.5773, 0.5773, -0.5773, 0.5773, 0.5773, 0.5773, -0.5773, 0.5773, -0.5773, -0.5773, 0.5773,
  0.5773, 0.5773, -0.5773, -0.5773, 0.5773, -0.5773, 0.5773, -0.5773, -0.5773, -0.5773, -0.5773, -0.5773,
])

function growI32(a: Int32Array<ArrayBuffer>, need: number): Int32Array<ArrayBuffer> {
  if (a.length >= need) return a
  let n = a.length || 4096
  while (n < need) n *= 2
  return new Int32Array(n)
}
function growF32(a: Float32Array<ArrayBuffer>, need: number): Float32Array<ArrayBuffer> {
  if (a.length >= need) return a
  let n = a.length || 1024
  while (n < need) n *= 2
  return new Float32Array(n)
}

/** Append one quad (two triangles) to an index buffer; returns the new length. */
function pushQuad(buf: Int32Array, n: number, v0: number, v1: number, v2: number, v3: number): number {
  buf[n] = v0
  buf[n + 1] = v1
  buf[n + 2] = v2
  buf[n + 3] = v0
  buf[n + 4] = v2
  buf[n + 5] = v3
  return n + 6
}

export function meshChunk(input: MeshJobInput): ChunkMesh | null {
  const { slab, dim, cs, voxel } = input
  const dim2 = dim * dim
  const cells = cs + 1
  const cells3 = cells * cells * cells

  // Interior and empty chunks carry no surface at all: bail out immediately.
  let minV = 127
  let maxV = -128
  for (let i = 0; i < slab.length; i++) {
    const v = slab[i]
    if (v < minV) minV = v
    if (v > maxV) maxV = v
  }
  if (minV >= 0 || maxV < 0) return null

  sVertIndex = growI32(sVertIndex, cells3)
  sPos = growF32(sPos, cells3 * 3)
  sWall = growI32(sWall, 18 * cs * cs * cs)
  sRoof = growI32(sRoof, 18 * cs * cs * cs)
  sGround = growI32(sGround, 18 * cs * cs * cs)
  const vertIndex = sVertIndex
  const vpos = sPos
  vertIndex.fill(-1, 0, cells3)
  let vertCount = 0

  const cornerVal = sCornerVal
  const cornerP = sCornerP

  // ---- Pass 1: one vertex per surface cell -------------------------------
  for (let ck = 0; ck < cells; ck++) {
    for (let cj = 0; cj < cells; cj++) {
      for (let ci = 0; ci < cells; ci++) {
        let mask = 0
        for (let c = 0; c < 8; c++) {
          const ox = CORNER[c * 3]
          const oy = CORNER[c * 3 + 1]
          const oz = CORNER[c * 3 + 2]
          cornerP[c * 3] = ox
          cornerP[c * 3 + 1] = oy
          cornerP[c * 3 + 2] = oz
          const v = slab[ci + ox + dim * (cj + oy) + dim2 * (ck + oz)]
          cornerVal[c] = v
          if (v < 0) mask |= 1 << c
        }
        if (mask === 0 || mask === 255) continue

        let ax = 0
        let ay = 0
        let az = 0
        let n = 0
        for (let e = 0; e < 12; e++) {
          const a = EDGE[e * 2]
          const b = EDGE[e * 2 + 1]
          const va = cornerVal[a]
          const vb = cornerVal[b]
          if (va < 0 === vb < 0) continue
          const t = va / (va - vb)
          const ac = a * 3
          const bc = b * 3
          ax += cornerP[ac] + (cornerP[bc] - cornerP[ac]) * t
          ay += cornerP[ac + 1] + (cornerP[bc + 1] - cornerP[ac + 1]) * t
          az += cornerP[ac + 2] + (cornerP[bc + 2] - cornerP[ac + 2]) * t
          n++
        }
        if (n === 0) continue
        const vi = vertCount++
        vertIndex[ci + cells * (cj + cells * ck)] = vi
        vpos[vi * 3] = ci + ax / n
        vpos[vi * 3 + 1] = cj + ay / n
        vpos[vi * 3 + 2] = ck + az / n
      }
    }
  }
  if (vertCount === 0) return null

  const positions = new Float32Array(vertCount * 3)
  const normals = new Int8Array(vertCount * 3)
  const uvs = new Float32Array(vertCount * 2)
  const colors = new Uint8Array(vertCount * 4)

  const { originX, originY, originZ, wallTile, roofTile } = input
  const tintR = input.tintR
  const tintG = input.tintG
  const tintB = input.tintB

  /** Trilinear sample of the slab at fractional slab coordinates. */
  const tri = (fx: number, fy: number, fz: number): number => {
    const i = fx < 0 ? 0 : fx > dim - 1.001 ? dim - 1.001 : fx
    const j = fy < 0 ? 0 : fy > dim - 1.001 ? dim - 1.001 : fy
    const k = fz < 0 ? 0 : fz > dim - 1.001 ? dim - 1.001 : fz
    const i0 = i | 0
    const j0 = j | 0
    const k0 = k | 0
    const tx = i - i0
    const ty = j - j0
    const tz = k - k0
    const b = i0 + dim * j0 + dim2 * k0
    const c000 = slab[b]
    const c100 = slab[b + 1]
    const c010 = slab[b + dim]
    const c110 = slab[b + dim + 1]
    const c001 = slab[b + dim2]
    const c101 = slab[b + dim2 + 1]
    const c011 = slab[b + dim2 + dim]
    const c111 = slab[b + dim2 + dim + 1]
    const x00 = c000 + (c100 - c000) * tx
    const x10 = c010 + (c110 - c010) * tx
    const x01 = c001 + (c101 - c001) * tx
    const x11 = c011 + (c111 - c011) * tx
    const y0 = x00 + (x10 - x00) * ty
    const y1 = x01 + (x11 - x01) * ty
    return y0 + (y1 - y0) * tz
  }

  // ---- Normals + UVs + vertex tint ---------------------------------------
  const hs = 0.7
  // Cavity AO: probe the SDF in a hemisphere about each vertex. Samples that
  // land inside solid mean the vertex sits in a concave pocket (window recess,
  // cornice underside, the corner between two blocks), so it darkens. This is
  // the era-correct substitute for SSAO and costs a handful of slab reads.
  const AO_DIRS = AO_DIRS_SCRATCH
  const aoR = Math.max(1.6, 2.6)
  for (let v = 0; v < vertCount; v++) {
    const sx = vpos[v * 3]
    const sy = vpos[v * 3 + 1]
    const sz = vpos[v * 3 + 2]
    const wx = originX + sx * voxel
    const wy = originY + sy * voxel
    const wz = originZ + sz * voxel
    positions[v * 3] = wx
    positions[v * 3 + 1] = wy
    positions[v * 3 + 2] = wz

    let nx = tri(sx + hs, sy, sz) - tri(sx - hs, sy, sz)
    let ny = tri(sx, sy + hs, sz) - tri(sx, sy - hs, sz)
    let nz = tri(sx, sy, sz + hs) - tri(sx, sy, sz - hs)
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz)
    if (len > 1e-6) {
      nx /= len
      ny /= len
      nz /= len
    } else {
      nx = 0
      ny = 1
      nz = 0
    }
    normals[v * 3] = (nx * 127) | 0
    normals[v * 3 + 1] = (ny * 127) | 0
    normals[v * 3 + 2] = (nz * 127) | 0

    // Box-projected UVs: pick the plane the face is most aligned with, then
    // tile by world position. Tiling scale is baked in, so one RepeatWrapping
    // texture covers any building size with no UV seams.
    const ax = Math.abs(nx)
    const ay = Math.abs(ny)
    const az = Math.abs(nz)
    if (ay > ax && ay > az) {
      uvs[v * 2] = wx / roofTile
      uvs[v * 2 + 1] = wz / roofTile
    } else if (ax >= az) {
      uvs[v * 2] = wz / wallTile
      uvs[v * 2 + 1] = wy / wallTile
    } else {
      uvs[v * 2] = wx / wallTile
      uvs[v * 2 + 1] = wy / wallTile
    }

    // Vertex tint: deterministic facade colour, grime towards the ground, and a
    // cheap top-down ambient-occlusion term.
    const grime = 0.86 + 0.14 * Math.min(1, Math.max(0, wy / 24))
    const noise = 0.97 + 0.03 * Math.sin(wx * 0.37 + wz * 0.53 + wy * 0.11)
    const shade = Math.min(1, 0.9 + 0.1 * ny)

    let occW = 1e-6
    let occIn = 0
    for (let d = 0; d < 8; d++) {
      const dx = AO_DIRS[d * 3]
      const dy = AO_DIRS[d * 3 + 1]
      const dz = AO_DIRS[d * 3 + 2]
      const w = dx * nx + dy * ny + dz * nz
      if (w <= 0.05) continue
      occW += w
      if (tri(sx + dx * aoR, sy + dy * aoR, sz + dz * aoR) < 0) occIn += w
    }
    const ao = 1 - 0.5 * (occIn / occW)

    const k = grime * noise * shade * ao
    colors[v * 4] = Math.min(255, (tintR * k * 255) | 0)
    colors[v * 4 + 1] = Math.min(255, (tintG * k * 255) | 0)
    colors[v * 4 + 2] = Math.min(255, (tintB * k * 255) | 0)
    colors[v * 4 + 3] = 255
  }

  // ---- Pass 2: one quad per grid edge, owned by exactly one chunk --------
  const wallBuf = sWall
  const roofBuf = sRoof
  const groundBuf = sGround
  let wallN = 0
  let roofN = 0
  let groundN = 0
  const groundY = input.groundY

  for (let lk = 1; lk <= cs; lk++) {
    for (let lj = 1; lj <= cs; lj++) {
      for (let li = 1; li <= cs; li++) {
        const base = li + dim * lj + dim2 * lk
        const b0 = slab[base]
        const s0 = b0 < 0
        for (let axis = 0; axis < 3; axis++) {
          const step = axis === 0 ? 1 : axis === 1 ? dim : dim2
          if ((slab[base + step] < 0) === s0) continue

          let a: number
          let b: number
          let c: number
          let d: number
          if (axis === 0) {
            a = li + cells * (lj - 1 + cells * (lk - 1))
            b = li + cells * (lj + cells * (lk - 1))
            c = li + cells * (lj + cells * lk)
            d = li + cells * (lj - 1 + cells * lk)
          } else if (axis === 1) {
            a = li - 1 + cells * (lj + cells * (lk - 1))
            b = li + cells * (lj + cells * (lk - 1))
            c = li + cells * (lj + cells * lk)
            d = li - 1 + cells * (lj + cells * lk)
          } else {
            a = li - 1 + cells * (lj - 1 + cells * lk)
            b = li + cells * (lj - 1 + cells * lk)
            c = li + cells * (lj + cells * lk)
            d = li - 1 + cells * (lj + cells * lk)
          }

          let v0 = vertIndex[a]
          let v1 = vertIndex[b]
          const v2 = vertIndex[c]
          let v3 = vertIndex[d]
          if (v0 < 0 || v1 < 0 || v2 < 0 || v3 < 0) continue

          // Winding check against the averaged vertex normal — robust without
          // reasoning about sign conventions per axis.
          const ux = positions[v1 * 3] - positions[v0 * 3]
          const uy = positions[v1 * 3 + 1] - positions[v0 * 3 + 1]
          const uz = positions[v1 * 3 + 2] - positions[v0 * 3 + 2]
          const wx = positions[v2 * 3] - positions[v0 * 3]
          const wy = positions[v2 * 3 + 1] - positions[v0 * 3 + 1]
          const wz = positions[v2 * 3 + 2] - positions[v0 * 3 + 2]
          const cxn = uy * wz - uz * wy
          const cyn = uz * wx - ux * wz
          const czn = ux * wy - uy * wx
          const nxs = normals[v0 * 3] + normals[v2 * 3]
          const nys = normals[v0 * 3 + 1] + normals[v2 * 3 + 1]
          const nzs = normals[v0 * 3 + 2] + normals[v2 * 3 + 2]
          const flip = cxn * nxs + cyn * nys + czn * nzs < 0

          const avgNy =
            (normals[v0 * 3 + 1] + normals[v1 * 3 + 1] + normals[v2 * 3 + 1] + normals[v3 * 3 + 1]) / 508
          const avgY = (positions[v0 * 3 + 1] + positions[v1 * 3 + 1] + positions[v2 * 3 + 1] + positions[v3 * 3 + 1]) * 0.25

          if (flip) {
            const t = v1
            v1 = v3
            v3 = t
          }

          // Three groups so the street level can use a storefront atlas while the
          // upper floors keep the repeating window facade. Roof wins over ground
          // (a low building's roof should not be a storefront).
          const target =
            avgNy > 0.55 ? roofBuf : avgY < groundY ? groundBuf : wallBuf
          if (target === roofBuf) roofN = pushQuad(target, roofN, v0, v1, v2, v3)
          else if (target === groundBuf) groundN = pushQuad(target, groundN, v0, v1, v2, v3)
          else wallN = pushQuad(target, wallN, v0, v1, v2, v3)
        }
      }
    }
  }

  return {
    positions,
    normals,
    uvs,
    colors,
    wall: new Uint32Array(wallBuf.subarray(0, wallN)),
    roof: new Uint32Array(roofBuf.subarray(0, roofN)),
    ground: new Uint32Array(groundBuf.subarray(0, groundN)),
    vertCount,
  }
}
