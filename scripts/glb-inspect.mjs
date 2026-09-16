import { readFileSync } from 'node:fs'
const file = process.argv[2]
const buf = readFileSync(file)
const jsonLen = buf.readUInt32LE(12)
const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'))
const nodes = json.nodes ?? []
console.log(`${file}: nodes=${nodes.length} meshes=${(json.meshes ?? []).length} materials=${(json.materials ?? []).length}`)
const childrenOf = new Map()
nodes.forEach((n, i) => (n.children ?? []).forEach((c) => childrenOf.set(c, i)))
const print = (i, depth) => {
  const n = nodes[i]
  const mesh = n.mesh !== undefined ? json.meshes[n.mesh] : null
  const attrs = mesh ? Object.keys(mesh.primitives[0].attributes).join(',') : ''
  const t = n.translation ? n.translation.map((v) => v.toFixed(2)).join(',') : ''
  console.log(`${'  '.repeat(depth)}- ${n.name ?? i}${attrs ? ' [' + attrs + ']' : ''}${t ? ' t=' + t : ''}`)
  ;(n.children ?? []).forEach((c) => print(c, depth + 1))
}
const roots = nodes.map((_, i) => i).filter((i) => !childrenOf.has(i))
roots.forEach((r) => print(r, 0))
