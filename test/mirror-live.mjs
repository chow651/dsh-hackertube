/**
 * mirror.js 的真实链路验证：真网络 + 真缓存 + 真数据。
 * 这里只做抽查，不是回归测试——上游随时可能变。
 */

import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { createResolver } from '../mirror.js'

const home = os.homedir()
const listPath = path.join(home, '.dsh', '.dsh-hackertube', 'list.json')
const zhPath = path.join(home, '.dsh', '.dsh-hackertube', 'i18n', 'zh-titles.json')

const list = JSON.parse(await fs.readFile(listPath, 'utf8')).items
const zh = JSON.parse(await fs.readFile(zhPath, 'utf8')).entries || {}

const cacheFile = path.join(os.tmpdir(), 'ht-mirror-verify.json')
await fs.rm(cacheFile, { force: true })

const resolver = createResolver({
  fetchImpl: globalThis.fetch,
  hashFn: (s) => crypto.createHash('md5').update(s).digest('hex'),
  cacheFile,
  readFile: (p, enc) => fs.readFile(p, enc),
  writeFile: (p, v, enc) => fs.writeFile(p, v, enc),
  mkdir: (p, o) => fs.mkdir(p, o),
})

const usable = list.filter((x) => x.d && x.t && x.c).sort((a, b) => (b.w || 0) - (a.w || 0))
const seg = usable.slice(0, Math.floor(usable.length * 0.25)).sort((a, b) => (a.v < b.v ? -1 : 1))
const N = Number(process.argv[2] || 8)
const step = Math.max(1, Math.floor(seg.length / N))
const items = []
for (let i = 0; i < seg.length && items.length < N; i += step) items.push(seg[i])

const toLocal = (x) => ({
  id: x.v,
  title: String(x.t).replace(/<[^>]+>/g, ''),
  titleZh: zh[x.v] || '',
  channel: x.c,
  duration: x.d,
  published: x.p,
})

console.log(`真实链路验证 n=${N}\n`)
let hit = 0
const times = []

for (const [i, item] of items.entries()) {
  const local = toLocal(item)
  const t0 = Date.now()
  let r = null
  let err = null
  try {
    r = await resolver.resolve(local)
  } catch (e) {
    err = e
  }
  const ms = Date.now() - t0
  times.push(ms)
  if (r) hit += 1
  const tag = err ? 'ERR ' : r ? 'HIT ' : 'miss'
  console.log(`[${String(i + 1).padStart(2)}/${N}] ${tag} ${String(ms).padStart(5)}ms | ${item.c.slice(0, 14).padEnd(14)} | ${local.title.slice(0, 40)}`)
  if (r) {
    console.log(`       → [${r.label}] ${r.title.slice(0, 52)}`)
    console.log(`         ${r.up} · ${r.play} 播放 · ${r.url}`)
  }
  if (err) console.log(`        ${err.message}`)
  await new Promise((x) => setTimeout(x, 400 + Math.floor(Math.random() * 400)))
}

const sorted = [...times].sort((a, b) => a - b)
console.log(`\n命中 ${hit}/${N}，耗时 p50=${sorted[Math.floor(N / 2)]}ms max=${sorted[N - 1]}ms`)

/* 缓存验证：第二次应该立刻返回 */
if (hit > 0) {
  const target = items.find((_, idx) => idx < N)
  const local = toLocal(target)
  const t0 = Date.now()
  const again = await resolver.resolve(local)
  const ms = Date.now() - t0
  console.log(`缓存复读 ${ms}ms → ${again ? again.label + ' ' + again.bvid : 'null'}`)
}

/* 落盘验证 */
await new Promise((r) => setTimeout(r, 200))
const snap = await resolver.snapshot()
const found = Object.values(snap.entries).filter((e) => e.status === 'found').length
const none = Object.values(snap.entries).filter((e) => e.status === 'none').length
console.log(`缓存落盘：${found} 命中 / ${none} 未命中 / 共 ${Object.keys(snap.entries).length} 条`)
console.log(`文件：${cacheFile}`)
