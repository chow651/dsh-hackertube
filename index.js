/**
 * HackerTube Host 半。
 *
 * 浏览器端不能直接取上游数据：hackertube.org 的 /api/* 不带 CORS 头，
 * 而数据主体是 8.2MB 的 videos.jsonl。这里负责拉取、瘦身、落盘缓存，
 * 再通过 /hackertube/api/* 交给面板。
 *
 * webServer 是可选服务：headless 场景没有它，写进 inject 会让插件永远 park，
 * 所以只在运行时用 ctx.get 探测，并给两次延迟重试。
 */

import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { createServer } from 'node:http'
import { mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateRawSync } from 'node:zlib'
import { normalizeIds, recommend } from './recommend.js'

/* 仓库里预生成的译文，首次安装时直接铺到缓存目录 */
const HERE = dirname(fileURLToPath(import.meta.url))
const SEED_DIR = join(HERE, 'data')

const SOURCE = 'https://hackertube.org'
const PREFIX = '/hackertube/api'
const TTL_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 45_000
/* 机翻接口是第三方免鉴权端点，超时要短，失败就留原文 */
const MT_TIMEOUT_MS = 12_000
/* 导出包 17.8 MB，给足下载预算 */
const EXPORT_DOWNLOAD_MS = 120_000
const DETAIL_CACHE_MAX = 60
/* 单次媒体下载预算；yt-dlp 在本机实测 10 分钟片长约 17 秒 */
const MEDIA_TIMEOUT_MS = 180_000
const MEDIA_MAX_HEIGHT = 480
/* 本地媒体缓存总上限，超了按最近最少使用淘汰 */
const MEDIA_CAP_BYTES = 512 * 1024 * 1024

/* /api/list 用 offset + n 分页；n 的上限是 100，更大的值被静默截到 100 */
const PAGE_SIZE = 100
const PAGE_CONCURRENCY = 8
const PAGE_RETRIES = 3
const FALLBACK_TOTAL = 6454
/* 整轮抓取的总预算，网络异常时不至于无限拖住预热 */
const TOTAL_BUDGET_MS = 120_000
/* 缓存结构变更时递增，旧缓存直接作废 */
const CACHE_VERSION = 2
/* 列表刷新失败后的重试间隔：旧缓存可以先一直用，别每次打开都打满上游 */
const LIST_RETRY_MS = 60_000

const state = {
  ctx: null,
  origin: null,
  authUrl: null,
  mediaOrigin: null,
  list: null,
  listAt: 0,
  listJson: null,
  listP: null,
  listMeta: {
    stage: 'idle',
    source: null,
    stale: false,
    revalidating: false,
    enriched: 0,
    total: 0,
    error: null,
    startedAt: 0,
    updatedAt: 0,
    nextTryAt: 0,
  },
  browse: null,
  playlists: null,
  playlistsAt: 0,
  playlistDetail: new Map(),
  comments: new Map(),
  related: new Map(),
  browseAt: 0,
  browseJson: null,
  inflight: new Map(),
  detail: new Map(),
  searchIndex: null,
}

/* ---------------- 缓存位置 ---------------- */

function cacheRoot() {
  const base = process.env.DSH_PROFILE_DIR || join(homedir(), '.dsh')
  return join(base, '.dsh-hackertube')
}

async function readCache(name) {
  try {
    return JSON.parse(await readFile(join(cacheRoot(), name), 'utf8'))
  } catch {
    return null
  }
}

async function writeCache(name, value) {
  try {
    await mkdir(cacheRoot(), { recursive: true })
    await writeFile(join(cacheRoot(), name), JSON.stringify(value), 'utf8')
  } catch {
    /* 缓存写失败不影响本次返回 */
  }
}

/* ---------------- 上游取数 ---------------- */

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`上游 ${res.status}: ${url}`)
  return res.json()
}

/** 同一个 key 的并发请求合并成一次。 */
function once(key, task) {
  const running = state.inflight.get(key)
  if (running) return running
  const p = task().finally(() => state.inflight.delete(key))
  state.inflight.set(key, p)
  return p
}

/* ---------------- 数据整形 ---------------- */

/**
 * 列表页只需要这些字段。summary / why_hn / quote / hn 占单条的六成以上，
 * 只在详情页取，所以不进入列表缓存。
 */
function toSlim(o) {
  const published = o.published ?? null
  return {
    v: o.vid,
    t: o.title ?? '',
    c: o.channel ?? '',
    d: o.duration_s ?? 0,
    th: o.thumbnail ?? (o.vid ? 'https://i.ytimg.com/vi/' + o.vid + '/hq2.jpg' : ''),
    p: published,
    w: o.views ?? 0,
    ct: o.content_type ?? '',
    lv: o.level ?? '',
    y: published ? Number(String(published).slice(0, 4)) || null : null,
    cats: Array.isArray(o.categories) ? o.categories.map((c) => c.id) : [],
    tags: Array.isArray(o.tags) ? o.tags : [],
    s: typeof o.score === 'number' ? o.score : 0,
    r: o.hn && typeof o.hn.recommenders === 'number' ? o.hn.recommenders : 0,
  }
}

function setList(items, at, source) {
  state.list = items
  state.listAt = at
  state.listJson = null
  if (source) state.listMeta.source = source
  state.listMeta.total = items.length
  if (source === 'upstream') state.listMeta.enriched = items.length
  state.listMeta.updatedAt = Date.now()
}

/** 前端轮询的首屏状态：阶段、来源、是否旧缓存、已补齐多少条。 */
function listStatusPayload() {
  const meta = state.listMeta
  return {
    stage: meta.stage,
    source: meta.source,
    stale: !!meta.stale,
    revalidating: !!meta.revalidating,
    total: meta.total || (state.list ? state.list.length : 0),
    enriched: meta.enriched || 0,
    error: meta.error || null,
    startedAt: meta.startedAt || 0,
    updatedAt: meta.updatedAt || 0,
  }
}

/**
 * 后台补齐 YouTube 元信息。先让导出/旧缓存返回给前端，65 页 /api/list
 * 在后台翻完后再 merge 回同一份列表，并把完整快照写进 list.json。
 */
function startRevalidate(reason, stageOverride) {
  if (state.listP) return state.listP
  if (Date.now() < (state.listMeta.nextTryAt || 0)) return null
  state.listP = (async () => {
    const meta = state.listMeta
    meta.revalidating = true
    meta.error = null
    meta.startedAt = Date.now()
    meta.stage = stageOverride || (state.list ? 'metadata' : 'export')
    meta.updatedAt = Date.now()
    try {
      const items = await fetchAllSlim((done, total) => {
        meta.enriched = done
        meta.total = total
        meta.updatedAt = Date.now()
      })
      const base = state.list || []
      const merged = base.length ? mergeMeta(base, items) : items
      setList(merged, Date.now(), 'upstream')
      meta.stale = false
      meta.enriched = merged.length
      meta.total = merged.length
      await writeCache('list.json', { v: CACHE_VERSION, at: Date.now(), items: merged })
      meta.stage = 'comments'
      meta.updatedAt = Date.now()
      try {
        await loadMentions()
      } catch {
        /* 评论解析失败不影响列表可用 */
      }
      meta.stage = 'ready'
      meta.nextTryAt = 0
    } catch (err) {
      meta.error = String((err && err.message) || err).slice(0, 200)
      meta.nextTryAt = Date.now() + LIST_RETRY_MS
      /* 已有本地列表就继续可浏览；没有列表时 /list 会返回 502 */
      meta.stage = state.list ? 'ready' : 'error'
    } finally {
      meta.revalidating = false
      meta.updatedAt = Date.now()
      state.listP = null
    }
  })()
  return state.listP
}

/* ---------------- 官方数据导出 ---------------- */

/**
 * hackertube.org 把整套数据以 zip 形式挂在 /download 上，作者的原话是
 * “Export of the site's data available to give to your agent to easily create
 * your own version”。这里直接吃这份导出：一次 17.8 MB 的下载，换来列表、详情、
 * HN 评论和相关推荐全部本地可得，不必再翻 65 页 /api/list。
 */

const EXPORT_ZIP_URL = `${SOURCE}/download/hackertube-data.zip`
const EXPORT_FILES = [
  'videos.jsonl',
  'mentions.jsonl',
  'related.jsonl',
  'embeddings.npy',
  'embedding_ids.json',
]
const EXPORT_TTL_MS = 7 * 24 * 60 * 60 * 1000
const EXPORT_VERSION = 1
const EXPORT_MAX_BYTES = 64 * 1024 * 1024

function exportDir() {
  return join(cacheRoot(), 'export')
}

/** 最小 zip 解析：只认 store 与 deflate，够解这一个包。 */
function unzipEntries(buf, wanted) {
  let eocd = -1
  const floor = Math.max(0, buf.length - 66 * 1024)
  for (let i = buf.length - 22; i >= floor; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('zip: 找不到中央目录')
  const count = buf.readUInt16LE(eocd + 10)
  let off = buf.readUInt32LE(eocd + 16)
  const out = {}
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('zip: 中央目录损坏')
    const method = buf.readUInt16LE(off + 10)
    const compSize = buf.readUInt32LE(off + 20)
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const commentLen = buf.readUInt16LE(off + 32)
    const localOff = buf.readUInt32LE(off + 42)
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen)
    off += 46 + nameLen + extraLen + commentLen
    const base = name.split('/').pop()
    if (wanted.indexOf(base) < 0) continue
    if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error('zip: 本地头损坏')
    const lNameLen = buf.readUInt16LE(localOff + 26)
    const lExtraLen = buf.readUInt16LE(localOff + 28)
    const start = localOff + 30 + lNameLen + lExtraLen
    const raw = buf.subarray(start, start + compSize)
    out[base] = method === 0 ? raw : inflateRawSync(raw)
  }
  return out
}

async function fetchExportZip() {
  const res = await fetch(EXPORT_ZIP_URL, { signal: AbortSignal.timeout(EXPORT_DOWNLOAD_MS) })
  if (!res.ok) throw new Error('export zip ' + res.status)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > EXPORT_MAX_BYTES) throw new Error('export zip 异常大：' + buf.length)
  if (buf.length < 1024) throw new Error('export zip 异常小：' + buf.length)
  return buf
}

/**
 * 整包一次下载、一次解包，之后各取所需。
 * 分次请求会各触发一次 17.8 MB 下载，所以这里只允许一个在飞的任务。
 */
let exportReadyP = null

async function exportFilesPresent() {
  const dir = exportDir()
  const sizes = await Promise.all(
    EXPORT_FILES.map(async (n) => {
      try {
        return (await stat(join(dir, n))).size > 0
      } catch {
        return false
      }
    }),
  )
  return sizes.every(Boolean)
}

async function ensureExportReady() {
  if (exportReadyP) return exportReadyP
  exportReadyP = (async () => {
    const dir = exportDir()
    const manifest = await readCache('export/manifest.json')
    const versioned = !!(manifest && Number(manifest.v) === EXPORT_VERSION)
    if (versioned) {
      const fresh = Date.now() - Number(manifest.at || 0) < EXPORT_TTL_MS
      if (fresh && (await exportFilesPresent())) return
    }
    try {
      await mkdir(dir, { recursive: true })
      const zip = await fetchExportZip()
      const entries = unzipEntries(zip, EXPORT_FILES)
      for (const n of EXPORT_FILES) {
        if (!entries[n]) throw new Error('导出缺少文件：' + n)
        await writeFile(join(dir, n), entries[n])
      }
      await writeCache('export/manifest.json', { v: EXPORT_VERSION, at: Date.now(), bytes: zip.length })
    } catch (err) {
      /* 刷新失败但旧导出文件还在：离线时继续用旧快照，不把首屏拖进错误态 */
      if (versioned && (await exportFilesPresent())) return
      throw err
    }
  })().finally(() => {
    exportReadyP = null
  })
  return exportReadyP
}

/** 读若干导出文件，必要时先补齐整包 */
async function readExport(names) {
  await ensureExportReady()
  const out = {}
  for (const n of names) out[n] = await readFile(join(exportDir(), n))
  return out
}

/**
 * 把导出解析成内存结构。videos 用与列表一致的瘦身形状，detail 保留原始记录
 * 供详情页使用（summary / why_hn / quote / tags / categories 都在里面）。
 */
async function loadDataset() {
  if (state.dataset) return state.dataset
  if (state.datasetP) return state.datasetP
  state.datasetP = (async () => {
    const files = await readExport(['videos.jsonl', 'related.jsonl'])
    const videos = []
    const detail = new Map()
    for (const line of files['videos.jsonl'].toString('utf8').split('\n')) {
      if (!line || line.charCodeAt(0) !== 123) continue
      let o
      try {
        o = JSON.parse(line)
      } catch {
        continue
      }
      if (!o || !o.vid) continue
      detail.set(o.vid, o)
      videos.push(toSlim(o))
    }
    if (!videos.length) throw new Error('导出里没有视频')

    const related = new Map()
    for (const line of files['related.jsonl'].toString('utf8').split('\n')) {
      if (!line || line.charCodeAt(0) !== 123) continue
      let o
      try {
        o = JSON.parse(line)
      } catch {
        continue
      }
      if (!o || !o.vid || !Array.isArray(o.related)) continue
      related.set(
        o.vid,
        o.related.map((r) => r.vid).filter(Boolean),
      )
    }

    state.dataset = { videos, detail, related, at: Date.now() }
    void writeCache('export/stats.json', { at: Date.now(), videos: videos.length, related: related.size })
    return state.dataset
  })()
  try {
    return await state.datasetP
  } finally {
    state.datasetP = null
  }
}

/** HN 评论按 vid 归组，按推荐力度排序后截取前 12 条 */
const STANCE_RANK = { strong_rec: 0, rec: 1, reference: 2, joke: 3, critical: 4 }

async function loadMentions() {
  if (state.mentions) return state.mentions
  if (state.mentionsP) return state.mentionsP
  state.mentionsP = (async () => {
    const files = await readExport(['mentions.jsonl'])
    const map = new Map()
    for (const line of files['mentions.jsonl'].toString('utf8').split('\n')) {
      if (!line || line.charCodeAt(0) !== 123) continue
      let m
      try {
        m = JSON.parse(line)
      } catch {
        continue
      }
      if (!m || !m.vid) continue
      const bucket = map.get(m.vid)
      if (bucket) bucket.push(m)
      else map.set(m.vid, [m])
    }
    state.mentions = map
    return map
  })()
  try {
    return await state.mentionsP
  } finally {
    state.mentionsP = null
  }
}

function commentsFromMentions(list) {
  return (list || [])
    .slice()
    .sort((a, b) => {
      const ra = STANCE_RANK[a.stance] ?? 9
      const rb = STANCE_RANK[b.stance] ?? 9
      if (ra !== rb) return ra - rb
      return String(b.month || '').localeCompare(String(a.month || ''))
    })
    .slice(0, 12)
    .map((m) => ({
      id: m.hn_comment_id,
      author: m.author || '',
      ym: m.month || '',
      stance: m.stance || '',
      why: m.why || '',
      text: String(m.text || '').replace(/\s+/g, ' ').slice(0, 400),
      quote: m.quote ? String(m.quote).replace(/\s+/g, ' ').slice(0, 240) : '',
    }))
}

/* 语义近邻：导出里的 384 维 float16 向量，用于 related.jsonl 没覆盖的视频 */
const npyState = { ids: null, index: null, vec: null, rows: 0, dim: 0 }

/* float16 → float32 查表，比逐元素 2**exp 快两个数量级 */
const F16 = (() => {
  const t = new Float32Array(65536)
  for (let h = 0; h < 65536; h += 1) {
    const sign = h & 0x8000 ? -1 : 1
    const exp = (h >> 10) & 0x1f
    const frac = h & 0x3ff
    let v
    if (exp === 0) v = frac * 2 ** -24
    else if (exp === 31) v = 0
    else v = (1 + frac / 1024) * 2 ** (exp - 15)
    t[h] = sign * v
  }
  return t
})()

async function loadVectors() {
  if (npyState.vec) return npyState
  const files = await readExport(['embeddings.npy', 'embedding_ids.json'])
  const npy = files['embeddings.npy']
  if (npy.toString('latin1', 1, 6) !== 'NUMPY') throw new Error('embeddings.npy 头不对')
  const major = npy[6]
  const headerLen = major === 1 ? npy.readUInt16LE(8) : npy.readUInt32LE(8)
  const headerStart = major === 1 ? 10 : 12
  const header = npy.toString('latin1', headerStart, headerStart + headerLen)
  const m = header.match(/shape'\s*:\s*\((\d+)\s*,\s*(\d+)\)/)
  if (!m) throw new Error('embeddings.npy 缺少 shape')
  const rows = Number(m[1])
  const dim = Number(m[2])
  const dataStart = headerStart + headerLen
  const vec = new Float32Array(rows * dim)
  /* Uint16 视图比逐字节 readUInt16LE 快一个数量级；x86 上小端直接可用 */
  const aligned = (npy.byteOffset + dataStart) % 2 === 0
  if (aligned) {
    const u16 = new Uint16Array(npy.buffer, npy.byteOffset + dataStart, rows * dim)
    for (let i = 0; i < rows * dim; i += 1) vec[i] = F16[u16[i]]
  } else {
    for (let i = 0; i < rows * dim; i += 1) {
      vec[i] = F16[npy.readUInt16LE(dataStart + i * 2)]
    }
  }
  const ids = JSON.parse(files['embedding_ids.json'].toString('utf8'))
  /* 向量是 L2 归一化的，模长预先算好，检索时只做点积 */
  const norms = new Float32Array(rows)
  for (let i = 0; i < rows; i += 1) {
    let n = 0
    const base = i * dim
    for (let d = 0; d < dim; d += 1) n += vec[base + d] * vec[base + d]
    norms[i] = Math.sqrt(n) || 1
  }
  npyState.ids = ids
  npyState.norms = norms
  npyState.index = new Map(ids.map((vid, i) => [vid, i]))
  npyState.vec = vec
  npyState.rows = rows
  npyState.dim = dim
  return npyState
}

async function relatedFromVectors(vid, n) {
  const s = await loadVectors()
  const at = s.index.get(vid)
  if (at === undefined) return []
  const { vec, dim, rows, norms } = s
  const off = at * dim
  const an = norms[at] || 1
  const scores = new Float32Array(rows)
  for (let i = 0; i < rows; i += 1) {
    if (i === at) {
      scores[i] = -1
      continue
    }
    const base = i * dim
    let dot = 0
    for (let d = 0; d < dim; d += 1) dot += vec[off + d] * vec[base + d]
    scores[i] = dot / (an * (norms[i] || 1))
  }
  const order = Array.from({ length: rows }, (_, i) => i).sort((a, b) => scores[b] - scores[a])
  const out = []
  for (const i of order.slice(0, n)) {
    const id = s.ids[i]
    if (id && id !== vid) out.push(id)
  }
  return out
}

/* ---------------- 三个数据方法 ---------------- */

/** 单页抓取，带重试；offset 定位，n 是每页条数（上限 100）。 */
async function fetchPage(page) {
  let lastError
  const offset = page * PAGE_SIZE
  for (let attempt = 0; attempt < PAGE_RETRIES; attempt += 1) {
    try {
      return await fetchJson(`${SOURCE}/api/list?offset=${offset}&n=${PAGE_SIZE}`)
    } catch (err) {
      lastError = err
      if (attempt + 1 < PAGE_RETRIES) {
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1)))
      }
    }
  }
  throw lastError
}

/**
 * 全量列表。videos.jsonl 虽然一次给 6454 条，但没有 thumbnail / published /
 * duration_s / views，卡片会缺封面和时长；只有 /api/list 带齐这些字段，
 * 代价是按 offset + n 翻完 65 页。gzip 后每页约 28KB。
 */
async function fetchAllSlim(onProgress) {
  let total = FALLBACK_TOTAL
  try {
    const stats = await fetchJson(`${SOURCE}/api/stats`)
    if (stats && typeof stats.videos === 'number' && stats.videos > 0) total = stats.videos
  } catch {
    /* 拿不到统计就用已知总数 */
  }

  const pages = Math.ceil(total / PAGE_SIZE)
  const deadline = Date.now() + TOTAL_BUDGET_MS
  const out = []
  const failed = []
  let cursor = 0
  const report = () => {
    if (typeof onProgress !== 'function') return
    try {
      onProgress(out.length, total)
    } catch {
      /* 进度回调不影响抓取 */
    }
  }
  report()

  const absorb = (page, value) => {
    if (!Array.isArray(value)) {
      failed.push(page)
      return
    }
    for (const o of value) out.push(toSlim(o))
  }

  while (cursor < pages) {
    if (Date.now() > deadline) throw new Error(`抓取超时：${out.length} / ${total}`)
    const batch = []
    for (let i = 0; i < PAGE_CONCURRENCY && cursor + i < pages; i += 1) {
      batch.push(cursor + i)
    }
    const settled = await Promise.allSettled(batch.map((p) => fetchPage(p)))
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') absorb(batch[i], r.value)
      else failed.push(batch[i])
    })
    cursor += PAGE_CONCURRENCY
    report()
  }

  /* 并发批里偶发失败的页单独补一次，别因为一页丢一百条 */
  if (failed.length) {
    for (const page of failed.slice()) {
      try {
        absorb(page, await fetchPage(page))
        const at = failed.indexOf(page)
        if (at >= 0) failed.splice(at, 1)
      } catch {
        /* 仍失败则记在 failed 里 */
      }
    }
    report()
  }

  const coverage = total ? out.length / total : 0
  if (coverage < 0.95) {
    const err = new Error(
      `列表不完整：拿到 ${out.length} / ${total}，${failed.length} 页始终失败`,
    )
    err.partialCount = out.length
    throw err
  }
  return out
}

/** 把 YouTube 元信息（时长/播放量/发布时间/封面）并进导出数据，导出本身没有这几个字段 */
function mergeMeta(items, metaItems) {
  if (!Array.isArray(metaItems) || !metaItems.length) return items
  const byVid = new Map()
  for (const m of metaItems) if (m && m.v) byVid.set(m.v, m)
  let changed = false
  const out = items.map((it) => {
    const m = byVid.get(it.v)
    if (!m) return it
    if (!(m.d || m.w || m.p || m.th)) return it
    changed = true
    return {
      ...it,
      d: m.d || it.d,
      th: it.th || m.th,
      p: m.p || it.p,
      w: m.w || it.w,
      y: it.y || m.y,
    }
  })
  return changed ? out : items
}

async function loadList() {
  /* 内存里已有列表：立即返回。超过 TTL 就标旧数据，后台刷新。 */
  if (state.list) {
    const fresh =
      state.listAt > 0 &&
      Date.now() - state.listAt < TTL_MS &&
      state.listMeta.source !== 'export'
    if (!fresh) {
      if (state.listMeta.source !== 'export') state.listMeta.stale = true
      const started = startRevalidate('memory-stale')
      if (!started && state.list) state.listMeta.stage = 'ready'
    }
    return state.list
  }

  /* 磁盘旧缓存：先给用户看，过期就带 stale 标记并后台重新验证。 */
  const cached = await readCache('list.json')
  if (
    cached &&
    cached.v === CACHE_VERSION &&
    Array.isArray(cached.items) &&
    cached.items.length
  ) {
    const at = Number(cached.at) || 0
    setList(cached.items, at, 'cache')
    state.listMeta.stale = !(Date.now() - at < TTL_MS)
    state.listMeta.enriched = cached.items.length
    if (state.listMeta.stale) {
      state.listMeta.stage = 'metadata'
      const started = startRevalidate('stale-cache')
      if (!started) state.listMeta.stage = 'ready'
    } else {
      state.listMeta.stage = 'ready'
      /* 命中新鲜缓存时也把导出与评论解析放到后台，打开第一个视频就不用等 */
      void loadDataset()
        .then(() => loadMentions())
        .catch(() => {})
    }
    return state.list
  }

  /* 首次安装：本地还没有列表时只能先等官方导出。阶段文案让用户知道在干什么。 */
  state.listMeta.stage = 'export'
  state.listMeta.source = null
  state.listMeta.stale = false
  state.listMeta.error = null
  state.listMeta.startedAt = Date.now()
  state.listMeta.updatedAt = Date.now()
  try {
    const ds = await loadDataset()
    setList(ds.videos, 0, 'export')
    state.listMeta.stage = 'metadata'
    state.listMeta.total = ds.videos.length
    state.listMeta.enriched = 0
    state.listMeta.updatedAt = Date.now()
    const started = startRevalidate('export-first')
    if (!started) state.listMeta.stage = 'ready'
    return state.list
  } catch (err) {
    void writeCache('diag.json', {
      at: Date.now(),
      stage: 'export',
      error: String((err && err.message) || err),
    })
    /* 导出拿不到时退回上游列表：慢一点，但总比整个面板打不开好 */
    state.listMeta.stage = 'metadata'
    state.listMeta.error = String((err && err.message) || err).slice(0, 200)
    state.listMeta.updatedAt = Date.now()
    await startRevalidate('export-fallback', 'metadata')
    if (state.list) return state.list
    state.listMeta.stage = 'error'
    throw new Error('列表不可用：导出与上游都失败')
  }
}

/* ---------------- 统一检索 ---------------- */

/**
 * 面板与 hackertube_search 共用这一份检索：词边界、中文查询扩展、字段权重、
 * 摘要片段、筛选与排序都只在这里实现，客户端不再维护第二套评分。
 */
const SEARCH_LIMIT_DEFAULT = 200
const SEARCH_LIMIT_MAX = 2000
const SEARCH_SORT_KEYS = ['relevance', 'score', 'year', 'views']
const SEARCH_FIELD_WEIGHT = {
  title: 12,
  title_zh: 12,
  channel: 4,
  tags: 8,
  categories: 5,
  topic: 8,
  summary: 3,
  why_hn: 3,
}
/* 字段展示顺序也是匹配字段的输出顺序：标题优先，正文类字段靠后 */
const SEARCH_FIELD_ORDER = ['title', 'title_zh', 'channel', 'tags', 'categories', 'topic', 'summary', 'why_hn']
const SEARCH_SNIPPET_ORDER = ['summary', 'why_hn', 'tags', 'categories', 'topic', 'title', 'title_zh', 'channel']

function searchHasHan(text) {
  return /[\u3400-\u9fff]/.test(String(text || ''))
}

function searchTokens(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[\s,，、;；|/]+/)
    .map((t) => t.replace(/^[“”"'‘’()（）\[\]【】]+|[“”"'‘’()（）\[\]【】]+$/g, ''))
    .filter(Boolean)
}

function searchTermRegExp(term) {
  const escapeRe = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp('(^|[^a-z0-9])' + escapeRe(term) + '([^a-z0-9]|$)', 'i')
}

/** 拉丁词按词边界匹配（raft 不命中 craft / Minecraft），中文按子串匹配 */
function searchTermMatches(hay, term) {
  if (!hay) return false
  if (searchHasHan(term)) return hay.indexOf(term) >= 0
  return searchTermRegExp(term).test(hay)
}

function buildSearchIndex(items, detailMap, zhTitles, browse, zhTax) {
  const catById = new Map()
  for (const area of (browse && browse.areas) || []) {
    for (const c of area.categories || []) {
      catById.set(c.id, { name: c.name, areaId: area.id, areaName: area.name })
    }
  }
  return items.map((item, index) => {
    const detail = detailMap ? detailMap.get(item.v) : null
    const zhTitle = (zhTitles && zhTitles[item.v]) || ''
    const catEn = []
    const catZh = []
    const areaIds = []
    const detailCats = detail && Array.isArray(detail.categories) ? detail.categories : []
    for (const c of detailCats) {
      if (!c) continue
      if (c.name) catEn.push(c.name)
      if (c.area) areaIds.push(c.area)
      const z = zhTax && zhTax['c:' + c.id]
      if (z) catZh.push(z)
    }
    for (const id of item.cats || []) {
      const hit = catById.get(id)
      if (hit && hit.name && catEn.indexOf(hit.name) < 0) catEn.push(hit.name)
      if (hit && hit.areaId && areaIds.indexOf(hit.areaId) < 0) areaIds.push(hit.areaId)
      const z = zhTax && zhTax['c:' + id]
      if (z && catZh.indexOf(z) < 0) catZh.push(z)
    }
    const areaNames = []
    for (const areaId of areaIds) {
      const tax = ((browse && browse.areas) || []).find((a) => a.id === areaId)
      if (tax && tax.name) areaNames.push(tax.name)
      const z = zhTax && zhTax['a:' + areaId]
      if (z) areaNames.push(z)
    }
    const display = {
      title: item.t || '',
      title_zh: zhTitle,
      channel: item.c || '',
      tags: Array.isArray(item.tags) ? item.tags.join(' ') : '',
      categories: catEn.concat(catZh, areaNames).join(' '),
      topic: (detail && detail.primary_topic) || '',
      summary: (detail && detail.summary) || '',
      why_hn: (detail && detail.why_hn) || '',
    }
    const hay = {}
    for (const field of SEARCH_FIELD_ORDER) hay[field] = display[field].toLowerCase()
    return {
      index,
      item,
      detail,
      display,
      hay,
      areaIds,
      year: item.y || (detail && detail.published ? Number(String(detail.published).slice(0, 4)) : null),
      type: item.ct || (detail && detail.content_type) || '',
      level: item.lv || (detail && detail.level) || '',
    }
  })
}

function searchRecordPasses(rec, filters) {
  /* 分类树拿不到时 areaIds 为空，硬过滤会把整库筛空；此时退回不过滤，由调用方标注降级 */
  if (filters.area && rec.areaIds.length && rec.areaIds.indexOf(filters.area) < 0) return false
  if (filters.year != null && Number(rec.year) !== Number(filters.year)) return false
  if (filters.type && String(rec.type) !== filters.type) return false
  if (filters.level && String(rec.level) !== filters.level) return false
  return true
}

function searchSnippet(rec, field, term) {
  const text = String(rec.display[field] || '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return ''
  let at = -1
  if (searchHasHan(term)) {
    at = text.toLowerCase().indexOf(term)
  } else {
    const m = searchTermRegExp(term).exec(text)
    if (m) at = m.index + String(m[1] || '').length
  }
  if (at < 0) at = 0
  const start = Math.max(0, at - 48)
  const end = Math.min(text.length, at + 96)
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '')
}

/**
 * 一条记录对一组检索词的匹配结果。要求每个词至少命中一个字段；
 * 命中字段按权重累加，整串短语命中标题再加分。
 */
function searchMatchRecord(rec, terms, phrase) {
  const fields = []
  let score = 0
  for (const term of terms) {
    let hit = false
    for (const field of SEARCH_FIELD_ORDER) {
      if (!searchTermMatches(rec.hay[field], term)) continue
      hit = true
      if (fields.indexOf(field) < 0) fields.push(field)
      score += SEARCH_FIELD_WEIGHT[field] || 1
    }
    if (!hit) return null
  }
  if (phrase) {
    const p = phrase.toLowerCase()
    if (rec.hay.title.indexOf(p) >= 0 || rec.hay.title_zh.indexOf(p) >= 0) score += 15
    else if (
      rec.hay.tags.indexOf(p) >= 0 ||
      rec.hay.summary.indexOf(p) >= 0 ||
      rec.hay.why_hn.indexOf(p) >= 0
    ) {
      score += 6
    }
  }
  score += Math.min(Number(rec.item.s) || 0, 50) * 0.2

  let snippet = ''
  let snippetField = ''
  for (const field of SEARCH_SNIPPET_ORDER) {
    if (fields.indexOf(field) < 0) continue
    for (const term of terms) {
      if (!searchTermMatches(rec.hay[field], term)) continue
      snippet = searchSnippet(rec, field, term)
      snippetField = field
      break
    }
    if (snippet) break
  }
  return {
    score,
    fields: SEARCH_FIELD_ORDER.filter((f) => fields.indexOf(f) >= 0),
    snippet,
    snippetField,
  }
}

function searchSortRank(a, b, sort, hasQuery) {
  const sa = Number(a.rec.item.s) || 0
  const sb = Number(b.rec.item.s) || 0
  /* 没有查询时「相关度」就等于列表原序：筛选不该打乱浏览顺序 */
  if (sort === 'relevance' && !hasQuery) return a.rec.index - b.rec.index
  if (sort === 'score') return sb - sa
  if (sort === 'year') return (Number(b.rec.year) || 0) - (Number(a.rec.year) || 0) || sb - sa
  if (sort === 'views') return (Number(b.rec.item.w) || 0) - (Number(a.rec.item.w) || 0) || sb - sa
  return (b.match ? b.match.score : 0) - (a.match ? a.match.score : 0) || sb - sa
}

/**
 * 单一 Host 检索入口：query + filters + sort + limit/offset。
 * 面板走 /search 路由，Agent 工具直接调用，两边拿到同一条排序。
 */
async function searchLibrary(params = {}) {
  const query = String(params.query ?? '').trim()
  const limit = Math.max(1, Math.min(Number(params.limit) || SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX))
  const offset = Math.max(0, Number(params.offset) || 0)
  const sort = SEARCH_SORT_KEYS.indexOf(String(params.sort || '')) >= 0 ? String(params.sort) : 'relevance'
  const yearRaw = params.year
  const filters = {
    area: String(params.area || ''),
    year: yearRaw !== '' && yearRaw != null && Number.isFinite(Number(yearRaw)) ? Number(yearRaw) : null,
    type: String(params.type || ''),
    level: String(params.level || ''),
  }

  const items = await loadList()
  let detailMap = null
  try {
    detailMap = (await loadDataset()).detail
  } catch {
    /* 导出不可用时退回只按列表字段检索 */
  }
  const zhTitles = await loadI18n('zh-titles').catch(() => ({}))
  let browse = null
  try {
    browse = await loadBrowse()
  } catch {
    /* 分类树不可用时仍有列表里的分类 id，筛选会退化为不命中 */
  }
  const zhTax = await loadI18n('zh-taxonomy').catch(() => ({}))
  /* 译文表是原地增长的：用条目数当版本号，否则后到的译文不会进索引 */
  const zhTitlesSize = Object.keys(zhTitles).length
  const zhTaxSize = Object.keys(zhTax).length

  const cached = state.searchIndex
  let records
  if (
    cached &&
    cached.items === items &&
    cached.detailMap === detailMap &&
    cached.zhTitles === zhTitles &&
    cached.zhTitlesSize === zhTitlesSize &&
    cached.browse === browse &&
    cached.zhTax === zhTax &&
    cached.zhTaxSize === zhTaxSize
  ) {
    records = cached.records
  } else {
    records = buildSearchIndex(items, detailMap, zhTitles, browse, zhTax)
    state.searchIndex = { items, detailMap, zhTitles, zhTitlesSize, browse, zhTax, zhTaxSize, records }
  }

  const terms = searchTokens(query)
  let expanded = []
  if (terms.length && searchHasHan(query)) {
    const translated = await mtQuery(query, 'en').catch(() => '')
    expanded = searchTokens(translated)
  }

  const picked = []
  for (const rec of records) {
    if (!searchRecordPasses(rec, filters)) continue
    let match = null
    if (terms.length) {
      const candidates = []
      if (expanded.length) candidates.push(searchMatchRecord(rec, expanded, expanded.join(' ')))
      candidates.push(searchMatchRecord(rec, terms, query.toLowerCase()))
      match = candidates.filter(Boolean).sort((a, b) => b.score - a.score)[0] || null
      if (!match) continue
    }
    picked.push({ rec, match })
  }
  picked.sort((a, b) => searchSortRank(a, b, sort, terms.length > 0) || a.rec.index - b.rec.index)

  return {
    query,
    total: picked.length,
    limit,
    offset,
    sort,
    /* 分类树不可用时领域筛选没有真正生效，界面要说明，而不是显示成「没有结果」 */
    areaFiltered: filters.area ? !!browse : false,
    items: picked.slice(offset, offset + limit).map(({ rec, match }) => {
      const item = Object.assign({}, rec.item)
      if (match) {
        item.match = {
          fields: match.fields,
          snippet: match.snippet,
          snippetField: match.snippetField,
        }
        /* 工具输出要用中文标题与推荐理由；面板只读 fields/snippet，别把这两串塞进两千条结果 */
        if (params.verbose) {
          item.match.titleZh = rec.display.title_zh || ''
          item.match.why = rec.display.why_hn || rec.display.summary || ''
        }
      }
      return item
    }),
  }
}

/**
 * 27 个播放列表的中文标题与简介。上游只给英文，这里内置一份人工译文，
 * 比让模型临时翻更稳，也不会因为一次调用失败而在界面上露出英文。
 */
const PLAYLIST_ZH = {
  "hn-canon": [
    "HN 必看清单",
    "Hacker News 最常被推荐给彼此的十个视频，一个帖子接一个帖子，年复一年。数学、金钱、编程、芯片、生物，还有怎么活。"
  ],
  "talks-every-programmer-should-watch": [
    "每个程序员都该看的演讲",
    "HN 反复推荐给开发者看的编程演讲，不论你写什么语言。关于简洁、设计、手艺，以及如何思考软件。"
  ],
  "computers-from-the-transistor-up": [
    "从晶体管讲起的计算机",
    "一层一层讲清计算机怎么工作：晶体管与逻辑门、芯片怎么造、CPU 与内存、操作系统，最后是编译器与语言。"
  ],
  "learn-deep-learning-from-zero": [
    "从零学深度学习",
    "从「什么是神经元」到亲手用代码搭一个 GPT 的学习路径，每一步都用 HN 最推荐的那个讲解。"
  ],
  "programming-history-in-12-talks": [
    "十二场演讲里的编程史",
    "用 HN 推荐的演讲与影像讲编程的故事：从战时的密码破译机器，到 Unix、PARC、家用电脑热潮、自由软件与万维网。"
  ],
  "lectures-worth-a-weekend": [
    "值得一个周末的讲座",
    "HN 一直劝人去看的课堂录像：Feynman、SICP、Strang、Sapolsky、Sandel 等好老师，每人一场开篇讲座。"
  ],
  "documentaries-hn-loves": [
    "HN 爱看的纪录片",
    "适合慢悠悠一个晚上的长篇纪录片：AlphaGo、Connections、Aaron Swartz、Adam Curtis 等等，横跨技术、科学、历史与人。"
  ],
  "how-things-are-made": [
    "东西是怎么造出来的",
    "工厂参观与制造讲解，专治「这玩意儿到底怎么做出来的」：从易拉罐到 EUV 光刻机，再到火箭工厂。"
  ],
  "security-war-stories": [
    "安全圈的血泪史",
    "真实的入侵、骗局与数据泄露，由干过的人或追查过的人亲口讲。从 1986 年追捕克格勃间谍，到几乎波及每台 Linux 服务器的 xz 后门。"
  ],
  "systems-and-databases": [
    "系统与数据库",
    "HN 推荐来理解真实系统怎么运转的硬核技术演讲：数据库、共识、分布式代码测试、性能，以及怎么让生产环境不倒。"
  ],
  "hidden-gems": [
    "被埋没的好东西",
    "HN 很喜欢、YouTube 几乎没注意到的东西，多数远不到五万播放。物理、音乐、航天器、遗传学、能源，还有软件史。"
  ],
  "comedy-break-for-programmers": [
    "程序员的喜剧时间",
    "HN 帖子里用来逗乐的短剧、恶搞与荒诞演讲：从需求根本不可能实现的会议，到用 PowerPoint 搭出来的图灵机。"
  ],
  "indistinguishable-from-magic": [
    "与魔法无异",
    "从厨房桌上的一只晶体管，到 ASML 机器里的锡滴激光，再讲到为这套东西争抢的人与国家。"
  ],
  "mechanical-sympathy": [
    "机械同理心",
    "为什么你的快电脑跑着慢代码，以及写快代码的人对缓存、数据布局和测量知道些什么。"
  ],
  "things-you-never-look-at": [
    "你从没细看过东西",
    "门、插头、易拉罐、烤面包机和转向灯，由显然很爱这些东西的人来讲。关于日常物品的短片设计随笔。"
  ],
  "debugging-at-a-distance": [
    "远程调试",
    "从阿波罗导航计算机的 1202 警报，到隔着 150 亿英里给旅行者一号打补丁：史上最难的远程调试，由干过的人或重建过那套硬件的人讲述。"
  ],
  "brass-brains": [
    "黄铜大脑：用齿轮计算",
    "晶体管之前，人们用齿轮、凸轮和水做微积分。从一枚差速齿轮，一路讲到为战列舰瞄准、预测潮汐、跑经济模型的机器。"
  ],
  "objects-on-trial": [
    "面向对象受审记",
    "HN 吵了十五年的 OOP 之争，这次排成一场庭审：辩方、控方、创始人的证词，还有两小时的结案陈词。"
  ],
  "before-it-worked": [
    "在它成真之前",
    "用领域起飞之前录下的演讲讲 AI 史：从 1973 年那场促成了第一次 AI 寒冬的辩论，到 2017 年把这场热潮称作炼金术的演讲。"
  ],
  "how-to-count-a-vote": [
    "怎么数一张选票",
    "投票是一种算法，HN 就按算法在吵。从为什么简单多数养出两党制，到 Arrow 定理与评分投票，再到杰利蝾螈，以及为什么纸质选票仍然胜过计算机。"
  ],
  "speedrunners-are-reverse-engineers": [
    "速通玩家都是逆向工程师",
    "从马里奥赛车里的一条捷径，到只用一只手柄在《超级马里奥世界》里跑《Flappy Bird》：玩家是怎么把自己的游戏拆开的。"
  ],
  "cheating-the-hardware": [
    "骗过硬件",
    "游戏开发者怎么绕开可怜的内存、稀少的颜色和慢慢转的磁盘，从《爆破彗星》讲到《古惑狼》，大致按时间顺序。"
  ],
  "everything-is-circles": [
    "万物皆圆",
    "一个想法——傅里叶变换——从用本轮画出荷马·辛普森，一路跟到 JPEG、数字音频、无线电、镜头和测不准原理。"
  ],
  "biology-for-programmers": [
    "给程序员看的生物学",
    "细胞是纳米级机加工车间，生物电网络存着身体蓝图，遗传病被当成漏洞利用，还有一门用来设计分子的 Lisp 编译器。用 HN 的眼光看生物学：这是世界上最奇怪的代码库。"
  ],
  "who-watches-the-silicon": [
    "硅片由谁看守",
    "你的威胁模型大概止步于操作系统。这些演讲往下再挖一层：没有文档的 CPU 指令、隐藏的协处理器、恶意 USB 固件，以及主板上的植入物。"
  ],
  "how-things-fall-over": [
    "东西是怎么塌的",
    "被删掉的数据库、一次核事故、因为一个笔误被重启的数据中心，以及安全科学里那些解释「这一切都很正常」的概念。"
  ],
  "small-profitable-nobodys-unicorn": [
    "小而赚钱，不当独角兽",
    "HN 发给每个想做生意而不是造火箭的人：DHH 2008 年那篇异端，Jason Cohen 的白手起家手册，Maciej 谈勉强成功，还有一家从 1994 年活到今天的游戏工作室。"
  ]
}

function withChinese(p) {
  if (!p || !p.slug) return p
  const z = PLAYLIST_ZH[p.slug]
  if (!z) return p
  return Object.assign({}, p, { titleZh: z[0], pitchZh: z[1] })
}

/**
 * 站点策划的播放列表。上游一次给全部 27 个（标题、简介、封面、时长），
 * 详情按 slug 单独取，缓存 30 分钟。
 */
async function loadPlaylists(force = false) {
  const fresh = state.playlists && Date.now() - state.playlistsAt < TTL_MS
  if (fresh && !force) return state.playlists
  return once('playlists', async () => {
    const list = await fetchJson(`${SOURCE}/api/playlists`)
    state.playlists = Array.isArray(list) ? list : []
    state.playlistsAt = Date.now()
    return state.playlists
  })
}

async function loadPlaylist(slug) {
  const hit = state.playlistDetail.get(slug)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value
  const value = await fetchJson(`${SOURCE}/api/playlist?slug=${encodeURIComponent(slug)}`)
  state.playlistDetail.set(slug, { at: Date.now(), value })
  return value
}

async function loadBrowse() {
  const fresh = state.browse && Date.now() - state.browseAt < TTL_MS
  if (fresh) return state.browse

  if (!state.browse) {
    const cached = await readCache('browse.json')
    if (cached && cached.taxonomy) {
      state.browse = cached.taxonomy
      state.browseAt = Number(cached.at) || 0
      if (Date.now() - state.browseAt < TTL_MS) return state.browse
    }
  }

  return once('browse', async () => {
    try {
      const data = await fetchJson(`${SOURCE}/download/taxonomy.json`)
      state.browse = data
      state.browseAt = Date.now()
      state.browseJson = null
      void writeCache('browse.json', { at: state.browseAt, taxonomy: data })
      return data
    } catch (err) {
      /* /download 走独立限流；/api/browse 是同一份领域树的可用镜像 */
      try {
        const areas = await fetchJson(`${SOURCE}/api/browse`)
        if (Array.isArray(areas) && areas.length) {
          const data = { version: 'api-browse', areas }
          state.browse = data
          state.browseAt = Date.now()
          state.browseJson = null
          void writeCache('browse.json', { at: state.browseAt, taxonomy: data })
          return data
        }
      } catch {
        /* 两个来源都不可用时再报错 */
      }
      if (state.browse) return state.browse
      throw err
    }
  })
}

/**
 * 详情页只展示 12 条：每条带作者、年月、立场、一句为什么。
 * 正文和引用可能很长，截到 400 字，避免一次响应过大。
 */
function pickComments(vid) {
  const list = state.comments.get(vid) || []
  return list.slice(0, 12).map((c) => ({
    id: c.id,
    author: c.author || '',
    ym: c.ym || '',
    stance: c.stance || '',
    why: c.why || '',
    text: String(c.text || '').replace(/\s+/g, ' ').slice(0, 400),
    quote: c.quote ? String(c.quote).replace(/\s+/g, ' ').slice(0, 240) : '',
  }))
}

/**
 * 相关视频：上游按 HN 共同推荐度排序。详情页右栏用，最多 12 条。
 */
async function loadRelated(vid) {
  const hit = state.related.get(vid)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value
  /* 先查导出里的共推荐图，没有再退到向量近邻，最后才问上游 */
  try {
    const ds = await loadDataset()
    let ids = ds.related.get(vid) || []
    if (!ids.length) ids = await relatedFromVectors(vid, 14).catch(() => [])
    if (ids.length) {
      const source = state.list && state.list.length ? state.list : ds.videos
      const byId = new Map(source.map((it) => [it.v, it]))
      const value = []
      for (const id of ids) {
        const it = byId.get(id)
        if (it && value.length < 12) value.push(it)
      }
      if (value.length) {
        state.related.set(vid, { at: Date.now(), value })
        return value
      }
    }
  } catch {
    /* 导出不可用时退回上游 */
  }
  const list = await fetchJson(`${SOURCE}/api/related?vid=${encodeURIComponent(vid)}&n=12`)
  const value = (Array.isArray(list) ? list : []).slice(0, 12).map(toSlim)
  state.related.set(vid, { at: Date.now(), value })
  return value
}

async function loadVideo(vid) {
  const hit = state.detail.get(vid)
  if (hit) return hit
  /* 导出里带着 summary / why_hn / quote / tags / categories，详情页不用再联网 */
  try {
    const ds = await loadDataset()
    const rec = ds.detail.get(vid)
    if (rec) {
      /* 导出里的引文用 hn_comment_id，前端要的是 id，这里统一 */
      if (rec.quote && typeof rec.quote === 'object' && rec.quote.hn_comment_id && !rec.quote.id) {
        rec.quote = { ...rec.quote, id: rec.quote.hn_comment_id }
      }
      const mentions = await loadMentions().catch(() => null)
      state.comments.set(vid, commentsFromMentions(mentions ? mentions.get(vid) : null))
      rememberDetail(vid, rec)
      return rec
    }
  } catch {
    /* 导出不可用时退回上游接口 */
  }
  const data = await fetchJson(`${SOURCE}/api/video?vid=${encodeURIComponent(vid)}`)
  const payload = data && data.video ? data.video : data
  const comments = data && Array.isArray(data.comments) ? data.comments : []
  state.comments.set(vid, comments)
  rememberDetail(vid, payload)
  return payload
}

function rememberDetail(vid, payload) {
  if (state.detail.size >= DETAIL_CACHE_MAX) {
    const oldest = state.detail.keys().next().value
    if (oldest !== undefined) state.detail.delete(oldest)
  }
  state.detail.set(vid, payload)
}

/* ---------------- 本地媒体 ---------------- */

function mediaDir() {
  return join(cacheRoot(), 'media')
}

/** 调 yt-dlp 落盘：480p 合并 mp4，音视频轨由 yt-dlp 自行调 ffmpeg 合并。 */
function downloadMedia(vid, dest) {
  return new Promise((resolve, reject) => {
    const args = [
      '-f',
      `bv*[height<=${MEDIA_MAX_HEIGHT}]+ba/b[height<=${MEDIA_MAX_HEIGHT}]`,
      '--merge-output-format',
      'mp4',
      '--no-warnings',
      '--no-playlist',
      '-o',
      dest,
      `https://www.youtube.com/watch?v=${vid}`,
    ]
    const child = spawn('yt-dlp', args, { windowsHide: true })
    let stderr = ''
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 已退出 */
      }
      reject(new Error('媒体下载超时'))
    }, MEDIA_TIMEOUT_MS)
    child.stderr.on('data', (d) => {
      stderr = (stderr + d.toString()).slice(-400)
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`yt-dlp 退出码 ${code}：${stderr}`))
    })
  })
}

/**
 * 中转页：宿主页面不发 Referer，YouTube 因此报 153。
 * 这里返回一个自己声明 Referrer-Policy 的文档，让内层 embed 请求带上来源。
 */
function serveEmbed(req, res, vid, lang, auto) {
  /* 播放器界面语言跟随面板：英文界面下 YouTube 不该弹中文的『前往平台观看』 */
  const hl = lang === 'zh' ? 'zh-CN' : 'en'
  const host = String(req.headers?.host || '')
  const relayOrigin = /^[\w.:-]+$/.test(host) ? 'http://' + host : 'http://127.0.0.1:18090'
  /* 用 YouTube IFrame API 托管播放器，才能读到播放位置；每秒把时间戳递回父页面，
     面板据此把「当前在讲什么」作为上下文交给模型 */
  const html =
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}#yt{width:100%;height:100%}' +
    '#yt iframe{width:100%;height:100%;border:0;display:block}</style>' +
    '</head><body><div id="yt"></div><script>' +
    'var player=null,lastT=-1,timer=null;var V=' + JSON.stringify(vid) + ';' +
    'function tell(m){m.vid=m.vid||V;try{parent.postMessage(m,"*")}catch(e){}}' +
    'function tick(){if(player&&typeof player.getCurrentTime==="function"){try{' +
    'var t=player.getCurrentTime(),d=player.getDuration();' +
    'if(Math.abs(t-lastT)>=1){lastT=t;tell({__ht:"time",t:t,d:d})}' +
    '}catch(e){}}timer=setTimeout(tick,800)}' +
    'function ready(){player=new YT.Player("yt",{videoId:' +
    JSON.stringify(vid) +
    ',playerVars:{rel:0,playsinline:1,' + (auto ? 'autoplay:1,' : '') + 'hl:' + JSON.stringify(hl) + ',origin:' +
    JSON.stringify(relayOrigin) +
    '},events:{' +
    'onReady:function(){tell({__ht:"relay-loaded",secure:!!window.isSecureContext});tick()},' +
    'onStateChange:function(e){tell({__ht:"state",s:e.data})},' +
    'onError:function(e){tell({__ht:"yt-error",code:e.data})}}});}' +
    'window.onYouTubeIframeAPIReady=ready;' +
    'var s=document.createElement("script");s.src="https://www.youtube.com/iframe_api";' +
    's.onerror=function(){tell({__ht:"api-error"})};document.head.appendChild(s);' +
    '</script></body></html>'
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    /* 不能设 X-Frame-Options：父页面是 dsh-app://，与本服务器不同源，
       SAMEORIGIN 会让浏览器直接拒绝渲染这个 iframe */
    'Cache-Control': 'no-store',
    ...(state.origin ? { 'X-Hackertube-Origin': state.origin } : {}),
  })
  res.end(html)
}

/**
 * 流式播放：yt-dlp 输出 MPEG-TS，ffmpeg 转封装成 fragmented MP4 直接透传。
 * 不落磁盘、不依赖 YouTube 的嵌入策略；代价是流式不可 seek。
 */
function serveStream(req, res, vid) {
  res.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Cache-Control': 'no-store',
    'Accept-Ranges': 'none',
  })

  const ytdlp = spawn(
    'yt-dlp',
    [
      '-f',
      `bv*[height<=${MEDIA_MAX_HEIGHT}]+ba/b[height<=${MEDIA_MAX_HEIGHT}]`,
      '--merge-output-format',
      'mp4',
      '-o',
      '-',
      '--no-warnings',
      '--no-playlist',
      `https://www.youtube.com/watch?v=${vid}`,
    ],
    { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
  )

  const ff = spawn(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      'pipe:0',
      '-c',
      'copy',
      '-movflags',
      'frag_keyframe+empty_moov+default_base_moof',
      '-f',
      'mp4',
      'pipe:1',
    ],
    { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true },
  )

  let closed = false
  const cleanup = () => {
    if (closed) return
    closed = true
    for (const child of [ytdlp, ff]) {
      try {
        child.kill()
      } catch {
        /* 已退出 */
      }
    }
  }

  ytdlp.stdout.pipe(ff.stdin)
  ff.stdout.pipe(res)

  req.on('close', cleanup)
  res.on('close', cleanup)
  ytdlp.on('error', cleanup)
  ff.on('error', cleanup)
  ff.on('close', () => {
    try {
      res.end()
    } catch {
      /* 已断开 */
    }
    cleanup()
  })
}

/** 支持 Range 的静态投递，<video> 拖动进度条必须靠它。 */
function streamMedia(req, res, file, size) {
  const range = req.headers.range
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range)
    let start = m && m[1] ? Number(m[1]) : 0
    let end = m && m[2] ? Number(m[2]) : size - 1
    if (!Number.isFinite(start) || start < 0) start = 0
    if (!Number.isFinite(end) || end >= size) end = size - 1
    if (start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` })
      res.end()
      return
    }
    res.writeHead(206, {
      'Content-Type': 'video/mp4',
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    })
    createReadStream(file, { start, end }).pipe(res)
    return
  }
  res.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Content-Length': size,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  })
  createReadStream(file).pipe(res)
}

/** 超过总配额就按最近访问时间从旧到新删除，避免无限占盘。 */
async function trimMedia(keepName) {
  const dir = mediaDir()
  let names
  try {
    names = await readdir(dir)
  } catch {
    return
  }
  const files = []
  let total = 0
  for (const name of names) {
    if (!name.endsWith('.mp4')) continue
    const full = join(dir, name)
    try {
      const st = await stat(full)
      files.push({ full, size: st.size, at: st.atimeMs || st.mtimeMs, name })
      total += st.size
    } catch {
      /* 并发删除，忽略 */
    }
  }
  if (total <= MEDIA_CAP_BYTES) return
  files.sort((a, b) => a.at - b.at)
  for (const f of files) {
    if (total <= MEDIA_CAP_BYTES) break
    if (f.name === keepName) continue
    try {
      await unlink(f.full)
      total -= f.size
    } catch {
      /* 删不掉不影响播放 */
    }
  }
}

/** 首次请求触发下载并缓存，之后直接读盘；同一视频的并发请求合并成一次。 */
async function serveMedia(req, res, vid) {
  const dir = mediaDir()
  const file = join(dir, `${vid}.mp4`)

  try {
    const st = await stat(file)
    if (st.size > 1024) return streamMedia(req, res, file, st.size)
  } catch {
    /* 尚未缓存 */
  }

  try {
    await once(`media:${vid}`, async () => {
      await mkdir(dir, { recursive: true })
      const part = `${file}.part`
      try {
        await downloadMedia(vid, part)
        await rename(part, file)
        void trimMedia(`${vid}.mp4`)
      } catch (err) {
        try {
          await unlink(part)
        } catch {
          /* 清理失败忽略 */
        }
        throw err
      }
    })
    const st = await stat(file)
    return streamMedia(req, res, file, st.size)
  } catch (err) {
    return json(res, 502, { error: String(err?.message ?? err) })
  }
}

/* ---------------- 路由 ---------------- */

function trusted(req) {
  const host = String(req.headers?.host ?? '')
  const origin = String(req.headers?.origin ?? '')
  if (origin && host) {
    try {
      return new URL(origin).host === host
    } catch {
      return false
    }
  }
  if (!origin) return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host)
  return false
}

/* ---------------- LLM ---------------- */

/** 插件自己的模型通道：复用当前 profile 已配置的 provider，不需要额外 key。 */
const llmState = { candidates: null, error: null, working: null }

/** 列出所有可用的文本模型路由，按 provider 顺序排好，供失败时逐个回退。 */
async function listCandidates(ctx) {
  if (llmState.candidates) return llmState.candidates
  const out = []
  try {
    const llm = ctx?.get?.('llm')
    if (!llm) {
      llmState.error = 'no llm service'
      llmState.candidates = []
      return llmState.candidates
    }
    const providers = (await llm.listProviders?.()) || []
    for (const p of providers) {
      let models = []
      try {
        models = (await llm.listModels(p.id)) || []
      } catch {
        continue
      }
      for (const m of models) {
        if (m.inputModalities && !m.inputModalities.includes('text')) continue
        out.push({ provider: p.id, model: m.id })
      }
    }
  } catch (err) {
    llmState.error = String(err?.message ?? err).slice(0, 150)
  }
  llmState.candidates = out
  return out
}

async function streamOnce(ctx, route, prompt, opts) {
  /* 单个路由挂死会拖住整批，加硬超时把它变成可重试的失败 */
  return Promise.race([
    streamOnceInner(ctx, route, prompt, opts),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('llm timeout')), 90_000),
    ),
  ])
}

async function streamOnceInner(ctx, route, prompt, opts) {
  const llm = ctx.get('llm')
  const messages =
    Array.isArray(opts.messages) && opts.messages.length
      ? opts.messages
      : [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
  const stream = llm.stream({
    provider: route.provider,
    model: route.model,
    messages,
    ...(opts.maxTokens ? { maxOutputTokens: opts.maxTokens } : {}),
  })
  let out = ''
  const seen = new Set()
  /* 流里只有 block-start 带 blockType，后续增量靠当前块类型判断归属 */
  let currentBlock = null
  for await (const chunk of stream) {
    if (!chunk) continue
    if (typeof chunk === 'string') {
      if (currentBlock !== 'reasoning') {
        out += chunk
        if (opts.onDelta) opts.onDelta(chunk)
      }
      continue
    }
    if (typeof chunk !== 'object') continue
    if (chunk.type) seen.add(String(chunk.type))
    if (chunk.type === 'finish') {
      if (chunk.reason && chunk.reason.kind === 'error') {
        throw new Error(chunk.reason.failure?.message || 'llm error')
      }
      break
    }
    if (chunk.type === 'block-start') {
      currentBlock = chunk.blockType || null
      continue
    }
    if (chunk.type === 'block-stop' || chunk.type === 'block-end' || chunk.type === 'block-finish') {
      currentBlock = null
      continue
    }
    if (currentBlock === 'reasoning') continue
    if (typeof chunk.text === 'string') {
      out += chunk.text
      if (opts.onDelta) opts.onDelta(chunk.text)
    } else if (typeof chunk.delta === 'string') {
      out += chunk.delta
      if (opts.onDelta) opts.onDelta(chunk.delta)
    } else if (chunk.delta && typeof chunk.delta.text === 'string') {
      out += chunk.delta.text
      if (opts.onDelta) opts.onDelta(chunk.delta.text)
    }
  }
  if (!out.trim()) {
    throw new Error('empty response, chunk types: ' + Array.from(seen).join('|'))
  }
  return out.trim()
}

/** 一次性问模型，返回完整文本；某个 provider 余额不足或不可用时自动换下一个。 */
async function askLlm(ctx, prompt, opts = {}) {
  if (llmState.working) {
    try {
      return await streamOnce(ctx, llmState.working, prompt, opts)
    } catch (err) {
      if (!/balance|quota|unavailable|not found|no adapter/i.test(String(err?.message))) throw err
      llmState.working = null
    }
  }
  const candidates = await listCandidates(ctx)
  if (!candidates.length) throw new Error(llmState.error || 'no model available')
  let lastErr = null
  for (const route of candidates) {
    try {
      const text = await streamOnce(ctx, route, prompt, opts)
      llmState.working = route
      return text
    } catch (err) {
      lastErr = err
      const msg = String(err?.message ?? err)
      if (/balance|quota|unavailable|not found|no adapter|unauthorized/i.test(msg)) continue
      throw err
    }
  }
  throw lastErr || new Error('all providers failed')
}

/* ---------------- 翻译 ---------------- */

const I18N_VERSION = 1

function i18nDir() {
  return join(cacheRoot(), 'i18n')
}

function i18nFile(lang) {
  return join(i18nDir(), `${lang}.json`)
}

const i18nState = { zh: null, dirty: false, timer: null }

async function loadI18n(lang) {
  if (i18nState[lang]) return i18nState[lang]
  try {
    const raw = await readFile(i18nFile(lang), 'utf8')
    const parsed = JSON.parse(raw)
    i18nState[lang] = parsed.entries || {}
  } catch {
    /* 缓存里没有时用仓库自带的译文打底，省掉几小时的模型翻译 */
    const seeded = await readSeed(lang)
    i18nState[lang] = seeded
    if (Object.keys(seeded).length) {
      void mkdir(i18nDir(), { recursive: true })
        .then(() => writeFile(i18nFile(lang), JSON.stringify({ v: I18N_VERSION, entries: seeded })))
        .catch(() => {})
    }
  }
  return i18nState[lang]
}

async function readSeed(name) {
  try {
    const parsed = JSON.parse(await readFile(join(SEED_DIR, name + '.json'), 'utf8'))
    return parsed.entries || {}
  } catch {
    return {}
  }
}

/** 只回写本轮改动过的译文表；共用同一个定时器，避免互相顶掉 */
function scheduleI18nSave(lang) {
  if (!(i18nState.dirty instanceof Set)) i18nState.dirty = new Set()
  if (lang) i18nState.dirty.add(lang)
  if (i18nState.timer) return
  i18nState.timer = setTimeout(() => {
    i18nState.timer = null
    const names = i18nState.dirty instanceof Set ? [...i18nState.dirty] : []
    if (i18nState.dirty instanceof Set) i18nState.dirty.clear()
    if (!names.length) return
    void mkdir(i18nDir(), { recursive: true })
      .then(async () => {
        for (const name of names) {
          const entries = i18nState[name]
          if (!entries || typeof entries !== 'object') continue
          await writeFile(i18nFile(name), JSON.stringify({ v: I18N_VERSION, entries }))
        }
      })
      .catch(() => {})
  }, 2000)
  if (typeof i18nState.timer.unref === 'function') i18nState.timer.unref()
}

const TERMS = [
  ['transformer', 'Transformer'],
  ['kernel', '内核'],
  ['gradient', '梯度'],
  ['backpropagation', '反向传播'],
  ['compiler', '编译器'],
  ['garbage collection', '垃圾回收'],
  ['lock-free', '无锁'],
  ['type inference', '类型推断'],
]

/**
 * 把一批英文推荐理由翻成中文。
 * 只翻没有缓存的条目；返回 vid → 译文 的映射。
 */
async function translateEntries(ctx, items, lang = 'zh') {
  const cache = await loadI18n(lang)
  const todo = items.filter((it) => it.r && !cache[it.v])
  if (!todo.length) return cache

  const glossary = TERMS.map(([en, zh]) => `${en}=${zh}`).join('; ')
  for (let i = 0; i < todo.length; i += 12) {
    const batch = todo.slice(i, i + 12)
    const numbered = batch
      .map((it, idx) => `${idx + 1}. ${String(it.r).replace(/\s+/g, ' ').slice(0, 600)}`)
      .join('\n')
    const prompt =
      '把这些 Hacker News 上推荐技术视频的理由翻译成简体中文。' +
      '保持技术准确性，语气自然，不要添加解释。\n' +
      `术语对照：${glossary}\n` +
      '严格输出 JSON 数组，只包含译文，顺序与输入一致，例如 ["译文一","译文二"]。\n\n' +
      numbered
    let text
    try {
      text = await askLlm(ctx, prompt)
    } catch {
      break
    }
    const m = text.match(/\[[\s\S]*\]/)
    if (!m) continue
    let arr
    try {
      arr = JSON.parse(m[0])
    } catch {
      continue
    }
    if (!Array.isArray(arr)) continue
    batch.forEach((it, idx) => {
      if (typeof arr[idx] === 'string' && arr[idx].trim()) cache[it.v] = arr[idx].trim()
    })
    scheduleI18nSave(lang)
  }
  return cache
}

/* 查询扩展用的通用机翻：中文查询先翻成英文，才能命中英文标签 */
const mtQueryState = { map: new Map() }
const MT_QUERY_MAX = 400

async function mtQuery(text, to) {
  const key = to + ':' + text
  if (mtQueryState.map.has(key)) return mtQueryState.map.get(key)
  const [from, target] = to === 'en' ? ['zh-CN', 'en'] : ['en', 'zh-CN']
  let out = ''
  try {
    out = (await mtBatch([text], from, target))[0] || ''
  } catch {
    try {
      out = await mtSingle(text, from, target)
    } catch {
      out = ''
    }
  }
  if (mtQueryState.map.size > MT_QUERY_MAX) mtQueryState.map.clear()
  mtQueryState.map.set(key, out)
  return out
}


/* ---------------- HN 评论机翻 ---------------- */

const commentTrState = { map: null, timer: null }

/* Chrome 内置翻译的批量端点：一次可交多条，质量明显好于 translate_a 系列 */
const MT_ENDPOINT = 'https://translate-pa.googleapis.com/v1/translateHtml'
/* 这是 Chrome 浏览器自带翻译随包发布的公开网页 key，不是账号凭证，也不计费 */
const MT_KEY = 'AIzaSyATBXajvzQLTDHEQbcpq0Ihe0vWDHmO520'
const MT_BATCH = 10
/* 缓存键带引擎标记，换引擎后旧条目自然失效，不必手动清文件 */
const MT_TAG = 'g'

function commentTrFile() {
  return join(i18nDir(), 'zh-comments.json')
}

async function loadCommentTr() {
  if (commentTrState.map) return commentTrState.map
  try {
    const parsed = JSON.parse(await readFile(commentTrFile(), 'utf8'))
    commentTrState.map = parsed.entries || {}
  } catch {
    commentTrState.map = {}
  }
  return commentTrState.map
}

function scheduleCommentTrSave() {
  if (commentTrState.timer) return
  commentTrState.timer = setTimeout(() => {
    commentTrState.timer = null
    const entries = commentTrState.map || {}
    void mkdir(i18nDir(), { recursive: true })
      .then(() => writeFile(commentTrFile(), JSON.stringify({ v: I18N_VERSION, entries })))
      .catch(() => {})
  }, 2000)
  if (typeof commentTrState.timer.unref === 'function') commentTrState.timer.unref()
}

function mtFetch(url, init) {
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null
  const timer = ctrl ? setTimeout(() => ctrl.abort(), MT_TIMEOUT_MS) : null
  const opts = Object.assign({}, init, ctrl ? { signal: ctrl.signal } : {})
  return fetch(url, opts).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

/** 主通道：批量提交，返回与输入等长的数组 */
async function mtBatch(texts, from = 'en', to = 'zh-CN') {
  const res = await mtFetch(MT_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json+protobuf',
      'X-Goog-API-Key': MT_KEY,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
    },
    body: JSON.stringify([[texts, from, to], 'wt_lib']),
  })
  if (!res.ok) throw new Error('mt http ' + res.status)
  const data = await res.json()
  const arr = Array.isArray(data) && Array.isArray(data[0]) ? data[0] : null
  if (!arr) throw new Error('mt bad payload')
  return texts.map((_, i) => (typeof arr[i] === 'string' ? arr[i].trim() : ''))
}

/** 备用通道：translate_a 单条接口，主通道被拒时逐条补 */
async function mtSingle(text, from = 'en', to = 'zh-CN') {
  const url =
    'https://translate.googleapis.com/translate_a/single?client=at&sl=' +
    from +
    '&tl=' +
    to +
    '&dt=t&q=' +
    encodeURIComponent(text)
  const res = await mtFetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
      Accept: '*/*',
    },
  })
  if (!res.ok) throw new Error('mt http ' + res.status)
  const data = await res.json()
  if (!Array.isArray(data) || !Array.isArray(data[0])) return ''
  return data[0]
    .map((seg) => (Array.isArray(seg) && typeof seg[0] === 'string' ? seg[0] : ''))
    .join('')
    .trim()
}

async function mtTranslateAll(texts) {
  try {
    return await mtBatch(texts)
  } catch {
    /* 主通道失败时逐条走备用，单条失败留空由调用方保留原文 */
    const out = []
    for (const t of texts) {
      try {
        out.push(await mtSingle(t))
      } catch {
        out.push('')
      }
    }
    return out
  }
}

/**
 * 逐条机翻 HN 评论，按评论 id 缓存，同一条只翻一次。
 * 十条一批提交，失败的条目不写入缓存，下次点击会重试。
 */
async function translateComments(comments) {
  const cache = await loadCommentTr()
  const keyOf = (c) => MT_TAG + ':' + c.id
  const todo = comments.filter((c) => c.text && c.text.trim().length >= 4 && !cache[keyOf(c)])
  if (!todo.length) return cache
  for (let i = 0; i < todo.length; i += MT_BATCH) {
    const batch = todo.slice(i, i + MT_BATCH)
    const texts = batch.map((c) => String(c.text).slice(0, 900))
    const out = await mtTranslateAll(texts)
    batch.forEach((c, idx) => {
      if (out[idx]) cache[keyOf(c)] = out[idx]
    })
  }
  scheduleCommentTrSave()
  return cache
}

/** 从可能夹带推理过程的文本里，抠出第一个完整 JSON 数组。 */
function extractJsonArray(text) {
  const start = text.indexOf('[')
  if (start < 0) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '[') depth += 1
    else if (ch === ']') {
      depth -= 1
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1))
        } catch {
          return null
        }
      }
    }
  }
  return null
}

/**
 * 翻译单条视频的详情文本。
 * 列表里没有推荐理由，只有详情带 quote / summary / why_hn，所以翻译按详情触发。
 */
async function translateDetail(ctx, detail, lang = 'zh') {
  const cache = await loadI18n(lang)
  const jobs = []
  const push = (field, text) => {
    if (typeof text !== 'string' || text.trim().length < 8) return
    const key = `${detail.vid}:${field}`
    if (cache[key]) return
    jobs.push({ key, text: text.replace(/\s+/g, ' ').slice(0, 700) })
  }
  push('summary', detail.summary)
  push('why_hn', detail.why_hn)
  if (detail.quote) push('quote', detail.quote.text)

  if (!jobs.length) return cache

  const glossary = TERMS.map(([en, zh]) => `${en}=${zh}`).join('; ')
  const numbered = jobs.map((j, i) => `${i + 1}. ${j.text}`).join('\n')
  const prompt =
    '把下面这些 Hacker News 上推荐技术视频的英文说明翻成简体中文。' +
    '保持技术准确、语气自然，不要添加任何解释或前言。\n' +
    `术语对照：${glossary}\n` +
    '严格输出 JSON 数组，只含译文，顺序与输入一致，例如 ["译文一","译文二"]。\n\n' +
    numbered

  try {
    const text = await askLlm(ctx, prompt)
    void writeCache('translate-last.json', { ok: true, at: Date.now(), raw: String(text).slice(0, 400) })
    const arr = extractJsonArray(text)
    if (Array.isArray(arr)) {
      jobs.forEach((j, i) => {
        if (typeof arr[i] === 'string' && arr[i].trim()) cache[j.key] = arr[i].trim()
      })
      scheduleI18nSave(lang)
    }
  } catch (err) {
    void writeCache('translate-last.json', {
      ok: false,
      at: Date.now(),
      message: String(err?.message ?? err).slice(0, 300),
    })
  }
  return cache
}

/**
 * 模型不可用时的详情机翻：摘要、推荐理由、引用一次批量翻完。
 * 单独存 zh-mt.json，和模型译文分开，日后配了模型还能覆盖升级。
 */
async function translateDetailMT(detail) {
  const cache = await loadI18n('zh-mt')
  const jobs = []
  const push = (field, text) => {
    if (typeof text !== 'string' || text.trim().length < 6) return
    const key = `${detail.vid}:${field}`
    if (cache[key]) return
    jobs.push({ key, text: text.replace(/\s+/g, ' ').slice(0, 900) })
  }
  push('summary', detail.summary)
  push('why_hn', detail.why_hn)
  if (detail.quote) push('quote', detail.quote.text)
  if (!jobs.length) return cache

  const out = await mtTranslateAll(jobs.map((j) => j.text))
  jobs.forEach((j, i) => {
    if (out[i]) cache[j.key] = out[i]
  })
  scheduleI18nSave('zh-mt')
  return cache
}

/** 详情里需要翻译的字段；没有 quote 正文时不翻 quote。 */
function detailTranslationFields(detail) {
  const fields = ['summary', 'why_hn']
  if (detail && detail.quote && typeof detail.quote.text === 'string' && detail.quote.text.trim()) fields.push('quote')
  return fields
}

/** 汇总两个译文缓存，并给每个字段标上 model（模型译）或 machine（机翻）来源。 */
function buildDetailI18n(vid, detail, llmCache, mtCache) {
  const i18n = {}
  const i18nSource = {}
  for (const field of detailTranslationFields(detail)) {
    const key = `${vid}:${field}`
    const model = llmCache && llmCache[key]
    const machine = mtCache && mtCache[key]
    i18n[field] = model || machine || null
    i18nSource[field] = model ? 'model' : machine ? 'machine' : null
  }
  return { i18n, i18nSource }
}

/** 只读缓存：详情首屏用，不触发模型或机翻请求。 */
async function cachedDetailI18n(vid, detail) {
  const [llmCache, mtCache] = await Promise.all([loadI18n('zh'), loadI18n('zh-mt')])
  return buildDetailI18n(vid, detail, llmCache, mtCache)
}

/** 异步补齐详情译文：模型优先，缺失字段走机翻；返回来源标识。 */
async function ensureDetailI18n(ctx, vid, detail) {
  let llmCache = {}
  if (ctx) {
    try {
      llmCache = await translateDetail(ctx, detail, 'zh')
    } catch {
      llmCache = {}
    }
  }
  const missing = detailTranslationFields(detail).filter((field) => !llmCache[`${vid}:${field}`])
  let mtCache = {}
  if (missing.length) {
    try {
      mtCache = await translateDetailMT(detail)
    } catch {
      mtCache = {}
    }
  }
  return buildDetailI18n(vid, detail, llmCache, mtCache)
}

/** 模型偶尔把批内编号带进译文，剥掉行首的 "N. " / "N、" / "N)" */
function stripLeadingIndex(text) {  return String(text)
    .replace(/^\s*\d+\s*[.、)．]\s*/, '')
    .trim()
}

/* ---------------- 译文出口校验 ---------------- */

/**
 * 只认真正的指令泄漏。早先的正则把「要求」「prompt」当特征词，
 * 误伤了「有人要求我对此保密」「[un]prompted 2026」这类正常译文。
 */
const TITLE_LEAK = /(只含译文|只输出|输出译文|请翻译以下|以下是译文|翻译成中文[:：]|不要解释|格式要求|译文如下)/
const TITLE_MAX = 120

/**
 * 中文标题不用竖线分层。原站标题是 "A | B | C" 的结构，
 * 译文照搬竖线会读成机器翻的，这里改写成冒号 / 括号 / 逗号。
 */
function normalizeTitle(input) {
  let s = String(input ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/｜/g, '|')
  const parts = s
    .split('|')
    .map((x) => x.trim())
    .filter(Boolean)
  if (parts.length < 2) return s
  let out = parts[0]
  for (let i = 1; i < parts.length; i += 1) {
    const p = parts[i]
    const endsWithQuestion = /[？！?!]$/.test(out)
    /* 这一段自己已经带冒号（"第1章：线性代数的本质"），再用冒号接就是双冒号 */
    const partHasColon = /[：:]/.test(p)
    if (i === 1 && endsWithQuestion) out += `（${p}）`
    else if (partHasColon) out += `，${p}`
    else if (!/[：:]/.test(out)) out += `：${p}`
    else out += `，${p}`
  }
  return out
    .replace(/：\s+/g, '：')
    .replace(/\s+，/g, '，')
    /* 历史数据里已经写成「A：第1章：B」的，把中间那段降级成逗号 */
    .replace(/：([^：，。；！？（）]{1,10})：/g, '，$1：')
}

/**
 * 结构可疑度：中文标题里出现堆叠分层、过长、并列逗号过多，都说明模型
 * 是照着英文语序搬的。0 分不动，>=2 分优先重排。
 */
function titleStructureScore(text) {
  const t = String(text || '')
  let n = 0
  if ((t.match(/：/g) || []).length >= 2) n += 1
  if (t.length > 30) n += 1
  if (/，[^，]{0,8}：/.test(t)) n += 1
  if ((t.match(/（/g) || []).length >= 2) n += 1
  if (t.length > 18 && !t.includes('：') && (t.match(/，/g) || []).length >= 2) n += 1
  return n
}

/** 译文能不能进缓存：ok / empty / leak / separator / too-long */
function titleVerdict(text) {
  const s = String(text ?? '').trim()
  if (!s) return 'empty'
  if (TITLE_LEAK.test(s)) return 'leak'
  if (/[｜|]/.test(s)) return 'separator'
  if (s.length > TITLE_MAX) return 'too-long'
  return 'ok'
}

/**
 * 批量翻译视频标题。
 * 标题短、量大，单独一个缓存文件，避免和详情译文混在一起。
 */
let titleRun = null

/**
 * 单飞：标题翻译同一时刻只跑一轮。前端打开面板会带一次 translate=1，
 * 和后台补翻撞上就会互相抢并发，把两边都拖成超时。
 */
function translateTitles(ctx, items, lang = 'zh') {
  if (titleRun) return titleRun
  titleRun = runTitleTranslation(ctx, items, lang).finally(() => {
    titleRun = null
  })
  return titleRun
}

async function runTitleTranslation(ctx, items, lang = 'zh') {
  const store = lang + '-titles'
  const cache = await loadI18n(store)
  const todo = items.filter((it) => it.t && !cache[it.v])
  if (!todo.length) return cache

  /* 实测：16 条一批时输出变长、超时增多，自适应把并发压到 4-8，净吞吐反而低于 12 */
  const BATCH = 12
  const CONCURRENCY = 6
  const batches = []
  for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH))

  const buildPrompt = (batch) => {
    const lines = batch
      .map((it, idx) => {
        const hint = []
        if (Array.isArray(it.tags) && it.tags.length) hint.push('标签：' + it.tags.slice(0, 5).join(', '))
        if (it.c) hint.push('频道：' + it.c)
        if (it.y) hint.push('年份：' + it.y)
        const meta = hint.length ? `（${hint.join('；')}）` : ''
        return `${idx + 1}. ${String(it.t).slice(0, 220)}${meta}`
      })
      .join('\n')
    return (
      '你是一位极其挑剔的中文作家，痛恨从英文直译而来的不自然表达。\n' +
      '下面是一批英文技术视频标题。请用中文重写它们——不是逐词翻译，是重写：\n' +
      '先想清楚这个视频讲什么，再用一个中国人会写出来的标题表达。\n\n' +
      '【必须遵守】\n' +
      '1. 拒绝英文语序。英文的连词、冠词、介词在中文里常常不该出现。\n' +
      '   一句话读不通就是错的，宁可换说法也不要逐词对应。\n' +
      '2. 拆解英文复合名词，用中文的名词修饰语法重建。\n' +
      '   例：mom creators 不是「母亲创作者」，是「宝妈博主」\n' +
      '3. 专有名词、产品名、人名、项目名、缩写保留原文：Transformer、Rust、Karpathy、TCP、micrograd\n' +
      '4. 副标题用冒号「：」或括号承接，绝对不要用竖线「|」或「｜」分层；原标题的编号要保留\n' +
      '5. 原标题是问句就译成问句；有比喻就保留比喻，不要压平成说明文\n' +
      '6. 中英文之间加空格：API 密钥 而不是 API密钥\n' +
      '7. 中文标点用全角：。，：；！？（）——……；引用一律用「」，不用弯引号\n' +
      '8. 括号里的标签和频道只用于理解，不要译进标题\n\n' +
      '【中文标题的层级：先分层，再落笔】\n' +
      '英文标题把信息平铺成一串（主题 - 副标题 - 讲者 - 活动），几段是平级的；\n' +
      '中文标题必须有主从：主标题只说「这是什么」，其余降级或删掉。\n' +
      '1. 主标题一句话，20 字内，不塞年份、活动名、讲者。\n' +
      '2. 从属信息最多留一层：系列与集数写「第 N 章 / 第 N 讲」，讲者写「人名：」前置或「（人名）」后置。\n' +
      '3. 三段以上砍到两段，砍的顺序：活动名 → 年份 → 讲者。\n' +
      '4. 分层靠语序和冒号，不靠竖线，也不要把四段用逗号串起来。\n' +
      '5. 四种结构按内容选一种，不混用：\n' +
      '   A 系列在前：线性代数的本质 第 1 章：向量\n' +
      '   B 讲者在前：Derek Sivers：怎样发起一场运动\n' +
      '   C 机构在前：GOTO 2019：Erlang 与 Elixir 的灵魂\n' +
      '   D 主题在前：分布式系统 1.1：导论\n' +
      '【这些是错的，照着避开】\n' +
      '- "But what is the Fourier Transform?" → 错：「但傅里叶变换是什么？」（中文不用"但"起句）\n' +
      '  对：「傅里叶变换究竟是什么？」\n' +
      '- "Simple Made Easy" → 错：「让简单变容易」（原意是简单不等于容易，译反了）\n' +
      '  对：「简单并不容易」\n' +
      '- "Around The Corner - How Differential Steering Works" → 错：「拐角处——差速转向如何工作」\n' +
      '  对：「过弯时发生了什么——差速转向原理」\n' +
      '- "How to Speak" → 错：「如何演讲」（干瘪，丢掉这是 MIT 经典讲座的分量）\n' +
      '  对：「怎样做一场好演讲」\n' +
      '- "makes sense" 类直译 → 错：「这说得通」，对：「这有道理」\n' +
      '- "at the end of the day" 类直译 → 错：「在一天结束时」，对：「归根结底」\n\n' +
      '严格输出 JSON 数组，只含译文，顺序与输入一致，不要任何解释。\n\n' +
      lines
    )
  }

  /* 自适应并发：一次 10 条一批，同时在飞的请求数在 MIN..MAX 之间爬。
     成功连击就加速，失败或超时立刻降速，避免把 provider 打到 429。 */
  const MIN_INFLIGHT = 4
  const MAX_INFLIGHT = 24
  let inflight = 10
  let streak = 0
  let consecutiveFails = 0
  let shortCount = 0
  const refilled = new Set()
  const errors = []
  let cursor = 0
  let done = 0
  let failed = 0
  let active = 0
  const startedAt = Date.now()

  const report = () => {
    const elapsed = Math.max(1, (Date.now() - startedAt) / 1000)
    const rate = done / elapsed
    void writeCache('titles-progress.json', {
      at: Date.now(),
      total: batches.length,
      done,
      failed,
      inflight,
      ratePerSec: Number(rate.toFixed(2)),
      refilled: shortCount,
      etaSec: rate > 0 ? Math.round((batches.length - done - failed) / rate) : null,
    })
  }

  const runBatch = async (batch) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const text = await askLlm(ctx, buildPrompt(batch))
        const arr = extractJsonArray(text)
        if (!Array.isArray(arr)) throw new Error('bad json')
        const rejected = []
        batch.forEach((it, i2) => {
          if (typeof arr[i2] !== 'string' || !arr[i2].trim()) return
          const clean = normalizeTitle(stripLeadingIndex(arr[i2]))
          const verdict = titleVerdict(clean)
          /* 指令泄漏和空串不进缓存，下次还会重翻；其余规范化后收下 */
          if (verdict === 'leak' || verdict === 'empty') {
            rejected.push({ v: it.v, verdict, text: clean.slice(0, 90) })
            return
          }
          cache[it.v] = clean
        })
        /* 批次变大以后模型偶尔少给几条：把没拿到的重新排队，只回填一次 */
        if (arr.length < batch.length) {
          const missing = batch.slice(arr.length).filter((it) => !refilled.has(it.v))
          if (missing.length) {
            for (const it of missing) refilled.add(it.v)
            for (let i = 0; i < missing.length; i += BATCH) batches.push(missing.slice(i, i + BATCH))
            shortCount += missing.length
          }
        }
        if (rejected.length) {
          void writeCache('titles-reject.json', { at: Date.now(), count: rejected.length, samples: rejected.slice(0, 20) })
        }
        scheduleI18nSave(store)
        streak += 1
        consecutiveFails = 0
        if (streak >= 6 && inflight < MAX_INFLIGHT) {
          inflight += 1
          streak = 0
        }
        return true
      } catch (err) {
        streak = 0
        consecutiveFails += 1
        if (errors.length < 12) errors.push(String(err?.message ?? err).slice(0, 160))
        /* 单批失败很常见（超时、JSON 截断），连续两次才降速，且一次只降一档 */
        if (consecutiveFails >= 2) {
          inflight = Math.max(MIN_INFLIGHT, inflight - 2)
          consecutiveFails = 0
        }
        if (attempt < 2) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)))
      }
    }
    return false
  }

  const lane = async () => {
    while (cursor < batches.length) {
      if (active >= inflight) {
        await new Promise((r) => setTimeout(r, 40))
        continue
      }
      const idx = cursor
      cursor += 1
      active += 1
      const ok = await runBatch(batches[idx])
      active -= 1
      if (ok) done += 1
      else failed += 1
      if ((done + failed) % 10 === 0) report()
    }
  }

  await Promise.all(Array.from({ length: MAX_INFLIGHT }, lane))
  report()
  if (errors.length) {
    void writeCache('titles-llm-errors.json', { at: Date.now(), inflight, errors })
  }
  return cache
}

/** 翻译领域名和分类名，一共 166 条，一次跑完 */
async function translateTaxonomy(ctx, jobs, lang = 'zh') {
  const store = lang + '-taxonomy'
  const cache = await loadI18n(store)
  const todo = jobs.filter((j) => !cache[j.key])
  if (!todo.length) return cache

  const BATCH = 30
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH)
    const numbered = batch.map((j, idx) => `${idx + 1}. ${j.text}`).join('\n')
    const prompt =
      '把这些技术视频平台的领域名和分类名翻成简体中文。\n' +
      '要求：\n' +
      '- 简洁准确，符合中文技术社区习惯\n' +
      '- 保留专有名词与缩写：AI、GPU、Rust、TCP、VR\n' +
      '- 并列结构保留并列，例如 "Business, Startups & Economics" → "商业、创业与经济"\n' +
      '- 分类名用名词短语，不加句号\n\n' +
      '严格输出 JSON 数组，只含译文，顺序与输入一致。\n\n' +
      numbered
    try {
      const text = await askLlm(ctx, prompt)
      const arr = extractJsonArray(text)
      if (Array.isArray(arr)) {
        batch.forEach((j, idx) => {
          if (typeof arr[idx] === 'string' && arr[idx].trim()) cache[j.key] = arr[idx].trim()
        })
        scheduleI18nSave(store)
      }
    } catch {
      break
    }
  }
  return cache
}

/* ---------------- 依赖探测 ---------------- */

/** 跑一条命令拿输出；命令不存在、超时、非零退出都收敛成同一个形状。 */
function runCmd(cmd, args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    let settled = false
    const finish = (r) => {
      if (settled) return
      settled = true
      resolve(r)
    }
    let child
    try {
      child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      return finish({ ok: false, out: '', err: String(e?.message ?? e) })
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 已退出 */
      }
      finish({ ok: false, out, err: 'timeout' })
    }, timeoutMs)
    child.stdout.on('data', (d) => {
      out = (out + d).slice(0, 8000)
    })
    child.stderr.on('data', (d) => {
      err = (err + d).slice(0, 8000)
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      finish({ ok: false, out, err: String(e?.message ?? e) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      finish({ ok: code === 0, out, err })
    })
  })
}

const depsState = { at: 0, value: null }

/** 探测字幕管线依赖。缺失时给安装提示，不替用户装。 */
async function probeDeps(force) {
  if (!force && depsState.value && Date.now() - depsState.at < 60_000) return depsState.value
  const [ytdlp, ffmpeg, py] = await Promise.all([
    runCmd('yt-dlp', ['--version'], 10_000),
    runCmd('ffmpeg', ['-version'], 10_000),
    runCmd('python', ['-c', 'import faster_whisper;print(faster_whisper.__version__)'], 15_000),
  ])
  const value = {
    ytdlp: ytdlp.ok
      ? { ok: true, version: ytdlp.out.trim().split('\n')[0] }
      : { ok: false, hint: 'pip install -U yt-dlp' },
    ffmpeg: ffmpeg.ok
      ? {
          ok: true,
          version: (/ffmpeg version (\S+)/.exec(ffmpeg.out) || [])[1] || 'ok',
        }
      : { ok: false, hint: '安装 ffmpeg 并加入 PATH' },
    whisper: py.ok
      ? { ok: true, version: py.out.trim() }
      : { ok: false, hint: 'pip install faster-whisper' },
  }
  depsState.at = Date.now()
  depsState.value = value
  return value
}

/* ---------------- 字幕 ---------------- */

function subsDir() {
  return join(cacheRoot(), 'subs')
}

function vttSeconds(s) {
  const m = /(\d+):(\d+):(\d+)\.(\d+)/.exec(s)
  if (!m) return 0
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000
}

function parseVtt(text) {
  const cues = []
  let cur = null
  for (const line of String(text).replace(/\r/g, '').split('\n')) {
    if (/^\d{2}:\d{2}:\d{2}\.\d{3}\s*-->/.test(line)) {
      const [a, b] = line.split('-->')
      cur = {
        start: vttSeconds(a.trim()),
        end: vttSeconds((b || '').trim().split(/\s+/)[0] || ''),
        text: '',
      }
      cues.push(cur)
    } else if (cur && line.trim() && !/^(WEBVTT|NOTE|Kind:|Language:|STYLE)/.test(line)) {
      const clean = line.replace(/<[^>]+>/g, '').trim()
      if (clean) cur.text = cur.text ? cur.text + ' ' + clean : clean
    }
  }
  return cues.filter((c) => c.text)
}

/* 中文优先，回退到英文 */
const SUBS_ZH = ['zh-Hans', 'zh-CN', 'zh', 'zh-Hant', 'zh-TW']
const SUBS_EN = ['en', 'en-US', 'en-GB']

/** 字幕失败短缓存：同一条视频反复提问时不重复跑 yt-dlp。 */
const SUBS_FAIL_TTL_MS = 60_000
/* 问答里的字幕只是上下文之一，给它一个明确的预算，不让面板看起来卡死 */
const CHAT_SUBS_BUDGET_MS = 20_000

function subsFile(vid, wantZh, kind) {
  return join(subsDir(), `${vid}.${wantZh ? 'zh' : 'en'}.${kind}`)
}

function subsFailureStatus(reason) {
  if (reason === 'missing-dependency') return 424
  if (reason === 'timeout') return 504
  return reason === 'error' ? 502 : 409
}

function subsFailureResult(payload) {
  return { status: subsFailureStatus(payload.reason), body: payload }
}

async function readSubsFailure(vid, wantZh) {
  try {
    const parsed = JSON.parse(await readFile(subsFile(vid, wantZh, 'fail.json'), 'utf8'))
    if (parsed && Date.now() - Number(parsed.at || 0) < SUBS_FAIL_TTL_MS) return parsed
  } catch {
    /* 没有失败缓存 */
  }
  return null
}

async function writeSubsFailure(vid, wantZh, reason, extra) {
  const payload = { reason, at: Date.now(), ...(extra || {}) }
  await mkdir(subsDir(), { recursive: true }).catch(() => {})
  await writeFile(subsFile(vid, wantZh, 'fail.json'), JSON.stringify(payload)).catch(() => {})
  return payload
}

function clearSubsFailure(vid, wantZh) {
  void rm(subsFile(vid, wantZh, 'fail.json'), { force: true }).catch(() => {})
}

function chatSubsBudgetMs() {
  const raw = Number(process.env.DSH_HACKERTUBE_SUBS_BUDGET_MS)
  if (Number.isFinite(raw) && raw >= 1000) return Math.min(raw, 120_000)
  return CHAT_SUBS_BUDGET_MS
}

/** 给一个 Promise 加硬上限；超时走 fallback，不让字幕检索拖住回答。 */
function withBudget(promise, ms, fallback) {
  let timer = null
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(fallback()), ms)
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

/**
 * 取一条视频的字幕。
 * 只做三件事：查缓存、调 yt-dlp、把失败翻译成可执行的提示。
 * 依赖缺失或上游风控时如实上报，不尝试自行修复环境。
 * 失败会短时间缓存，避免每个问题都重跑一遍慢管线。
 */
async function loadSubs(vid, wantZh, options = {}) {
  const budgetMs = Math.max(1000, Math.min(Number(options.budgetMs) || 120_000, 180_000))
  const dir = subsDir()
  const cacheFile = join(dir, `${vid}.${wantZh ? 'zh' : 'en'}.json`)
  try {
    const raw = await readFile(cacheFile, 'utf8')
    return { status: 200, body: JSON.parse(raw) }
  } catch {
    /* 未缓存 */
  }

  const cachedFailure = await readSubsFailure(vid, wantZh)
  if (cachedFailure) return subsFailureResult(cachedFailure)

  const deps = await probeDeps()
  if (!deps.ytdlp.ok) {
    const payload = await writeSubsFailure(vid, wantZh, 'missing-dependency', {
      need: 'yt-dlp',
      hint: deps.ytdlp.hint,
    })
    return subsFailureResult(payload)
  }

  await mkdir(dir, { recursive: true })
  const tmp = join(dir, `.tmp-${vid}-${Date.now()}`)
  await mkdir(tmp, { recursive: true })

  /* 约定路径：用户把导出的 cookie 放到插件缓存目录下，管线自动使用 */
  const cookieFile = join(cacheRoot(), 'cookies.txt')
  const hasCookies = await stat(cookieFile)
    .then((s) => s.size > 0)
    .catch(() => false)

  const langs = (wantZh ? SUBS_ZH.concat(SUBS_EN) : SUBS_EN).join(',')
  const args = [
    '--skip-download',
    '--write-subs',
    '--write-auto-subs',
    '--sub-langs',
    langs,
    '--sub-format',
    'vtt',
    '--no-warnings',
    '-o',
    join(tmp, '%(id)s.%(ext)s'),
  ]
  if (hasCookies) args.push('--cookies', cookieFile)
  args.push(`https://www.youtube.com/watch?v=${vid}`)

  const res = await runCmd('yt-dlp', args, budgetMs)

  let files = []
  try {
    files = (await readdir(tmp)).filter((f) => f.endsWith('.vtt'))
  } catch {
    /* 目录都没建出来 */
  }

  if (!files.length) {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
    if (res.err === 'timeout') {
      const payload = await writeSubsFailure(vid, wantZh, 'timeout', {
        hint: `字幕获取超过 ${Math.round(budgetMs / 1000)} 秒，本轮只使用视频简介。`,
      })
      return subsFailureResult(payload)
    }
    if (/sign in to confirm|not a bot|cookies/i.test(res.err)) {
      const payload = await writeSubsFailure(vid, wantZh, 'needs-cookies', {
        hint:
          'YouTube 要求登录校验。用浏览器扩展导出 Netscape 格式 cookies.txt，' +
          `放到 ${cookieFile}，然后重试。`,
        cookiePath: cookieFile,
      })
      return subsFailureResult(payload)
    }
    const payload = await writeSubsFailure(vid, wantZh, 'no-captions', {
      hint: '这条视频没有可用字幕，需要本地转写',
    })
    return subsFailureResult(payload)
  }

  /* 文件名形如 <vid>.<lang>.vtt，按优先级挑一条 */
  const order = wantZh ? SUBS_ZH.concat(SUBS_EN) : SUBS_EN
  let picked = null
  let pickedLang = null
  for (const lang of order) {
    const hit = files.find((f) => f.startsWith(`${vid}.${lang}.`))
    if (hit) {
      picked = hit
      pickedLang = lang
      break
    }
  }
  if (!picked) {
    picked = files[0]
    pickedLang = picked.slice(vid.length + 1, picked.length - 4)
  }

  let cues = []
  try {
    cues = parseVtt(await readFile(join(tmp, picked), 'utf8'))
  } catch {
    cues = []
  }
  await rm(tmp, { recursive: true, force: true }).catch(() => {})

  if (!cues.length) {
    const failed = await writeSubsFailure(vid, wantZh, 'no-captions', { hint: '字幕文件为空' })
    return subsFailureResult(failed)
  }

  const payload = {
    v: 1,
    vid,
    lang: pickedLang,
    auto: /^(zh|en)/.test(pickedLang) ? undefined : undefined,
    cues,
    at: Date.now(),
  }
  void writeFile(cacheFile, JSON.stringify(payload)).catch(() => {})
  clearSubsFailure(vid, wantZh)
  return { status: 200, body: payload }
}

/** 把秒数格式化成字幕时间戳 [m:ss] / [h:mm:ss]。 */
function cueClock(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0))
  const hh = Math.floor(s / 3600)
  const mm = Math.floor((s % 3600) / 60)
  const ss = s % 60
  const pad = (n) => (n < 10 ? '0' + n : String(n))
  return hh ? `${hh}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`
}

/** 取播放位置附近的字幕窗口；位置未知时退回视频开头。 */
function pickSubtitleWindow(cues, at) {
  if (!Array.isArray(cues) || !cues.length) return []
  const t = Number(at)
  if (Number.isFinite(t) && t > 0) {
    const from = Math.max(0, t - 180)
    const to = t + 180
    const hit = cues.filter((c) => c.end >= from && c.start <= to)
    if (hit.length) return hit.slice(0, 200)
    return cues.slice(0, 60)
  }
  return cues.slice(0, 120)
}

/**
 * 字幕检索结果转成回答上下文。成功的带时间戳文本，失败的带明确原因。
 * text 只在 Host 内部给模型用，publicSubtitle 才返回给浏览器。
 */
function subtitleContext(vid, at, result) {
  const body = (result && result.body) || {}
  if (result && result.status === 200 && Array.isArray(body.cues) && body.cues.length) {
    const windowCues = pickSubtitleWindow(body.cues, at)
    return {
      status: 'ok',
      hasSubtitles: true,
      lang: body.lang || '',
      window: {
        start: windowCues[0].start,
        end: windowCues[windowCues.length - 1].end,
        count: windowCues.length,
      },
      text: windowCues.map((c) => `[${cueClock(c.start)}] ${c.text}`).join('\n'),
    }
  }
  return {
    status: body.reason || 'error',
    hasSubtitles: false,
    hint: body.hint || '',
    ...(body.cookiePath ? { cookiePath: body.cookiePath } : {}),
    ...(body.need ? { need: body.need } : {}),
  }
}

function publicSubtitle(info) {
  const out = { status: info.status, hasSubtitles: !!info.hasSubtitles }
  if (info.lang) out.lang = info.lang
  if (info.window) out.window = info.window
  if (info.hint) out.hint = info.hint
  if (info.cookiePath) out.cookiePath = info.cookiePath
  if (info.need) out.need = info.need
  return out
}

function subtitlePromptBlock(info) {
  if (info.hasSubtitles) {
    return '\n\n以下是该视频在播放位置附近的字幕片段（带时间戳）：\n' + info.text + '\n'
  }
  const label =
    {
      'no-captions': '本条视频没有可用字幕',
      'needs-cookies': '字幕需要 YouTube cookies 才能获取',
      'missing-dependency': '字幕管线缺少依赖',
      timeout: '字幕获取超时',
    }[info.status] || '字幕不可用'
  return `\n\n（${label}，以下回答只能基于标题、简介和 HN 推荐理由，不要假装看过字幕。）\n`
}

/** 有预算的字幕检索：成功失败都收敛成可展示的状态。 */
async function loadSubtitleContext(vid, at, budgetMs) {
  const fallback = () => {
    const hint = `字幕获取超过 ${Math.round(budgetMs / 1000)} 秒，本轮只使用视频简介。`
    void writeSubsFailure(vid, false, 'timeout', { hint })
    return { status: 504, body: { reason: 'timeout', hint } }
  }
  try {
    const result = await withBudget(loadSubs(vid, false, { budgetMs }), budgetMs + 5000, fallback)
    return subtitleContext(vid, at, result)
  } catch (err) {
    return { status: 'error', hasSubtitles: false, hint: String(err?.message ?? err).slice(0, 200) }
  }
}

function sanitizeChatHistory(input) {
  if (!Array.isArray(input)) return []
  const out = []
  for (const raw of input.slice(-20)) {
    if (!raw || typeof raw !== 'object') continue
    const role = raw.role === 'assistant' || raw.role === 'ai' ? 'assistant' : raw.role === 'user' ? 'user' : null
    if (!role) continue
    const text = String(raw.text ?? raw.content ?? '').trim().slice(0, 4000)
    if (text) out.push({ role, text })
  }
  return out
}

/** system prompt 带视频与字幕上下文，历史对话按角色跟在后面。 */
function buildChatMessages(systemPrompt, history, question) {
  return [
    { role: 'system', content: [{ type: 'text', text: systemPrompt }] },
    ...history.map((h) => ({ role: h.role, content: [{ type: 'text', text: h.text }] })),
    { role: 'user', content: [{ type: 'text', text: question }] },
  ]
}

function send(res, code, body, type = 'application/json; charset=utf-8', extra = null) {
  const headers = {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  }
  /* 桌面端页面在 dsh-app:// 下拿不到 HTTP 地址，借每次响应把它带过去，
     前端才能把播放器中转页放回安全上下文 */
  if (state.origin) headers['X-Hackertube-Origin'] = state.origin
  if (extra) Object.assign(headers, extra)
  res.writeHead(code, headers)
  res.end(typeof body === 'string' ? body : JSON.stringify(body))
}

function json(res, code, body) {
  send(res, code, body)
}

/**
 * prefs 是读-改-写：喜欢列表走 400ms 防抖，语言偏好单独提交，
 * 两个请求同时到达会互相覆盖。串行化写入，后写的读得到前一次的结果。
 */
let prefsWriteChain = Promise.resolve()
function mergePrefsWrite(body) {
  const run = prefsWriteChain.then(async () => {
    const prev = await readCache('prefs.json')
    const old = prev && typeof prev === 'object' ? prev : {}
    const clean = {}
    /* 只更新请求里真的带了的集合，语言偏好这种局部写不会清空喜欢/稍后看 */
    for (const key of ['likes', 'later', 'seen', 'dismissed']) {
      const list = body && Array.isArray(body[key]) ? body[key] : Array.isArray(old[key]) ? old[key] : []
      clean[key] = list.map((x) => String(x)).filter((x) => /^[A-Za-z0-9_-]{6,20}$/.test(x)).slice(-400)
    }
    const nextLang = body && (body.lang === 'zh' || body.lang === 'en') ? body.lang : null
    if (nextLang) clean.lang = nextLang
    else if (old.lang === 'zh' || old.lang === 'en') clean.lang = old.lang
    clean.at = Date.now()
    await writeCache('prefs.json', clean)
    return clean
  })
  prefsWriteChain = run.catch(() => null)
  return run
}

async function handler(req, res) {
  const url = new URL(req.url ?? '/', 'http://local')
  const route = url.pathname.slice(PREFIX.length)

  if (!trusted(req)) return json(res, 403, { error: 'forbidden' })

  /* 浏览器半的执行回执：client.js 在各阶段 POST 上来，落盘供事后核查 */
  if (route === '/chat' && req.method === 'POST') {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > 262144) {
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', async () => {
      let body = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        return json(res, 400, { error: 'bad json' })
      }
      const vid = String(body.vid || '')
      const question = String(body.question || '').slice(0, 2000)
      if (!/^[A-Za-z0-9_-]{6,20}$/.test(vid) || !question) {
        return json(res, 400, { error: 'vid and question required' })
      }
      if (!state.ctx) return json(res, 503, { error: 'llm unavailable' })
      const at = Number(body.at)
      const playhead = Number.isFinite(at) && at > 0 ? at : 0
      const history = sanitizeChatHistory(body.history)
      const answerLang = body.lang === 'en' ? 'en' : 'zh'
      const budgetMs = chatSubsBudgetMs()

      const prepare = async () => {
        const [detail, subtitle] = await Promise.all([
          loadVideo(vid).catch(() => null),
          loadSubtitleContext(vid, playhead, budgetMs),
        ])
        const title = (detail && (detail.title || detail.t)) || vid
        const systemPrompt =
          `你在帮用户理解一个 Hacker News 推荐过的技术视频。\n` +
          `视频标题：${title}\n` +
          (detail && detail.channel ? `频道：${detail.channel}\n` : '') +
          (detail && detail.summary ? `简介：${detail.summary}\n` : '') +
          (detail && detail.why_hn ? `HN 推荐理由：${detail.why_hn}\n` : '') +
          subtitlePromptBlock(subtitle) +
          `\n\n回答要求：` +
          (answerLang === 'en'
            ? '用英文回答，紧扣视频内容；如果上下文里没有相关信息，直接说明看不到这部分内容，不要编造。'
            : '用简体中文回答，紧扣视频内容；如果上下文里没有相关信息，直接说明看不到这部分内容，不要编造。')
        return {
          subtitle,
          systemPrompt,
          messages: buildChatMessages(systemPrompt, history, question),
        }
      }

      if (body.stream === true) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        })
        if (typeof res.flushHeaders === 'function') res.flushHeaders()
        let closed = false
        const writeEvent = (payload) => {
          if (closed) return
          try {
            res.write('data: ' + JSON.stringify(payload) + '\n\n')
          } catch {
            closed = true
          }
        }
        const finish = (payload) => {
          if (closed) return
          try {
            res.write('data: ' + JSON.stringify(payload) + '\n\n')
            res.write('data: [DONE]\n\n')
            res.end()
          } catch {
            /* 客户端提前断开 */
          }
          closed = true
        }
        res.on('close', () => {
          closed = true
        })
        /* 先告诉前端进入字幕阶段，再开始可能很慢的 yt-dlp */
        writeEvent({ stage: 'subtitles' })
        try {
          const { subtitle, systemPrompt, messages } = await prepare()
          if (closed) return
          writeEvent({
            stage: 'answer',
            subtitle: publicSubtitle(subtitle),
            subtitleStatus: subtitle.status,
          })
          const answer = await askLlm(state.ctx, systemPrompt, {
            messages,
            onDelta: (piece) => writeEvent({ delta: piece }),
          })
          finish({
            done: true,
            answer,
            hasSubtitles: !!subtitle.hasSubtitles,
            subtitle: publicSubtitle(subtitle),
            subtitleStatus: subtitle.status,
            subtitleHint: subtitle.hint || '',
          })
        } catch (err) {
          finish({ error: String(err?.message ?? err).slice(0, 200) })
        }
        return
      }

      try {
        const { subtitle, systemPrompt, messages } = await prepare()
        const answer = await askLlm(state.ctx, systemPrompt, { messages })
        return json(res, 200, {
          answer,
          hasSubtitles: !!subtitle.hasSubtitles,
          subtitle: publicSubtitle(subtitle),
          subtitleStatus: subtitle.status,
          subtitleHint: subtitle.hint || '',
        })
      } catch (err) {
        return json(res, 502, { error: String(err?.message ?? err).slice(0, 200) })
      }
    })
    return
  }

  if (route === '/beacon' && req.method === 'POST') {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > 65536) {
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        /* 记请求头时避开 payload 自己的 origin 字段，免得覆盖客户端上报的值 */
        payload.reqReferer = req.headers.referer ?? req.headers.referrer ?? null
        payload.reqOrigin = req.headers.origin ?? null
        payload.reqSite = req.headers['sec-fetch-site'] ?? null
        const prev = state.beaconLog || []
        prev.push(payload)
        state.beaconLog = prev.slice(-20)
        void writeCache('beacon.json', state.beaconLog)
      } catch {
        /* 回执坏了不影响主流程 */
      }
      json(res, 200, { ok: true })
    })
    return
  }

    if (route === '/prefs') {
      if (req.method === 'POST') {
        let size = 0
        const chunks = []
        req.on('data', (c) => {
          size += c.length
          if (size > 262144) {
            req.destroy()
            return
          }
          chunks.push(c)
        })
        req.on('end', async () => {
          let body = null
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          } catch {
            return json(res, 400, { error: 'bad json' })
          }
          const clean = await mergePrefsWrite(body)
          return json(res, 200, {
            ok: true,
            lang: clean.lang || null,
            counts: {
              likes: clean.likes.length,
              later: clean.later.length,
              seen: clean.seen.length,
              dismissed: clean.dismissed.length,
            },
          })
        })
        return
      }
      const saved = await readCache('prefs.json')
      return json(res, 200, {
        likes: Array.isArray(saved && saved.likes) ? saved.likes : [],
        later: Array.isArray(saved && saved.later) ? saved.later : [],
        seen: Array.isArray(saved && saved.seen) ? saved.seen : [],
        dismissed: Array.isArray(saved && saved.dismissed) ? saved.dismissed : [],
        lang: saved && (saved.lang === 'zh' || saved.lang === 'en') ? saved.lang : null,
      })
    }
  /* 搜索框的中文查询先机翻成英文，再去命中英文标签与频道 */
  if (route === '/mt' && req.method === 'POST') {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > 8192) {
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', async () => {
      let body = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        return json(res, 400, { error: 'bad json' })
      }
      const text = String(body.text || '').trim().slice(0, 200)
      const to = body.to === 'zh' ? 'zh' : 'en'
      if (!text) return json(res, 400, { error: 'text required' })
      const out = await mtQuery(text, to)
      return json(res, 200, { text: out })
    })
    return
  }

  if (route === '/comments/translate' && req.method === 'POST') {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > 262144) {
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', async () => {
      let body = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        return json(res, 400, { error: 'bad json' })
      }
      const vid = String(body.vid || '')
      if (!/^[A-Za-z0-9_-]{6,20}$/.test(vid)) return json(res, 400, { error: 'bad vid' })
      const wanted = Array.isArray(body.ids) ? body.ids.map(String) : null
      const list = pickComments(vid).filter((c) => !wanted || wanted.indexOf(String(c.id)) >= 0)
      if (!list.length) return json(res, 200, { entries: {} })
      try {
        const cache = await translateComments(list)
        const entries = {}
        for (const c of list) {
          const zh = cache[MT_TAG + ':' + c.id]
          if (zh) entries[c.id] = zh
        }
        return json(res, 200, { entries })
      } catch (err) {
        return json(res, 500, { error: String(err?.message ?? err).slice(0, 200) })
      }
    })
    return
  }

  if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })

  try {
    if (route === '/recommend') {
      /* 首页推荐画像：likes 来自 prefs；query 参数覆盖 prefs，让前端在保存前也能立刻刷新 */
      const saved = (await readCache('prefs.json')) || {}
      const listParam = (name) => {
        if (!url.searchParams.has(name)) return normalizeIds(saved[name])
        return normalizeIds(String(url.searchParams.get(name) || '').split(','))
      }
      const likes = listParam('likes')
      const seen = listParam('seen')
      const dismissed = listParam('dismissed')
      const items = await loadList()
      let dataset = null
      let vectors = null
      try {
        dataset = await loadDataset()
      } catch {
        /* 导出不可用时只靠列表里的 HN 分数冷启动 */
      }
      try {
        vectors = await loadVectors()
      } catch {
        /* 没有 embeddings.npy 时降级到共推荐图 */
      }
      let playlists = []
      if (!likes.length) {
        /* 冷启动才有播放列表依赖；超时就用 HN 分数兜底，首页不能等上游 */
        try {
          playlists = (await Promise.race([
            loadPlaylists(),
            new Promise((resolve) => {
              const timer = setTimeout(() => resolve([]), 2500)
              if (timer && typeof timer.unref === 'function') timer.unref()
            }),
          ])).map(withChinese)
        } catch {
          playlists = []
        }
        if (!Array.isArray(playlists)) playlists = []
      }
      const payload = recommend({
        videos: items.length ? items : dataset ? dataset.videos : [],
        likes,
        seen,
        dismissed,
        related: dataset ? dataset.related : null,
        vectors,
        playlists,
        limit: Number(url.searchParams.get('limit')) || 10,
      })
      return json(res, 200, payload)
    }
    if (route === '/search') {
      const result = await searchLibrary({
        query: url.searchParams.get('q') || '',
        area: url.searchParams.get('area') || '',
        year: url.searchParams.get('year') || '',
        type: url.searchParams.get('type') || '',
        level: url.searchParams.get('level') || '',
        sort: url.searchParams.get('sort') || '',
        limit: url.searchParams.get('limit') || '',
        offset: url.searchParams.get('offset') || '',
      })
      return json(res, 200, result)
    }
    if (route === '/list') {
      const items = await loadList()
      if (!state.listJson) state.listJson = JSON.stringify(items)
      return send(res, 200, state.listJson, undefined, {
        'X-Hackertube-Stage': state.listMeta.stage || 'idle',
        'X-Hackertube-Source': state.listMeta.source || '',
        'X-Hackertube-Stale': state.listMeta.stale ? '1' : '0',
      })
    }
    if (route === '/list/status') {
      return json(res, 200, listStatusPayload())
    }
    if (route === '/playlists') {
      const list = await loadPlaylists(url.searchParams.get('force') === '1')
      return json(res, 200, list.map(withChinese))
    }
    if (route === '/playlist') {
      const slug = url.searchParams.get('slug')
      if (!slug || !/^[a-z0-9-]{2,64}$/.test(slug)) return json(res, 400, { error: 'bad-slug' })
      return json(res, 200, withChinese(await loadPlaylist(slug)))
    }
    if (route === '/browse') {
      if (!state.browseJson) state.browseJson = JSON.stringify(await loadBrowse())
      return send(res, 200, state.browseJson)
    }
    if (route === '/related') {
      const vid = url.searchParams.get('vid')
      if (!vid || !/^[A-Za-z0-9_-]{6,20}$/.test(vid)) return json(res, 400, { error: 'bad vid' })
      return json(res, 200, await loadRelated(vid))
    }
    if (route === '/video') {
      const vid = url.searchParams.get('vid')
      if (!vid) return json(res, 400, { error: 'vid required' })
      const detail = await loadVideo(vid)
      /* 详情先返回原文；中文只带已有缓存，绝不在这里等模型或机翻 */
      const payload = Object.assign({}, detail, { comments: pickComments(vid) })
      if (url.searchParams.get('lang') === 'zh') {
        const cached = await cachedDetailI18n(vid, detail)
        payload.i18n = cached.i18n
        payload.i18nSource = cached.i18nSource
      }
      return json(res, 200, payload)
    }
    if (route === '/video/translate') {
      const vid = url.searchParams.get('vid')
      if (!vid) return json(res, 400, { error: 'vid required' })
      const detail = await loadVideo(vid)
      const translation = await ensureDetailI18n(state.ctx, vid, detail)
      return json(res, 200, { vid, i18n: translation.i18n, i18nSource: translation.i18nSource })
    }
    if (route === '/media') {
      const vid = url.searchParams.get('vid')
      if (!vid || !/^[A-Za-z0-9_-]{6,20}$/.test(vid)) {
        return json(res, 400, { error: 'bad vid' })
      }
      return serveMedia(req, res, vid)
    }
    if (route === '/stream') {
      const vid = url.searchParams.get('vid')
      if (!vid || !/^[A-Za-z0-9_-]{6,20}$/.test(vid)) {
        return json(res, 400, { error: 'bad vid' })
      }
      return serveStream(req, res, vid)
    }
    if (route === '/embed') {
      const vid = url.searchParams.get('vid')
      if (!vid || !/^[A-Za-z0-9_-]{6,20}$/.test(vid)) {
        return json(res, 400, { error: 'bad vid' })
      }
      return serveEmbed(
        req,
        res,
        vid,
        url.searchParams.get('lang') === 'zh' ? 'zh' : 'en',
        url.searchParams.get('auto') === '1',
      )
    }
    if (route === '/config') {
      return json(res, 200, {
        origin: state.origin,
        authUrl: state.authUrl,
        mediaOrigin: state.mediaOrigin,
      })
    }
    if (route === '/taxonomy') {
      const lang = url.searchParams.get('lang') || 'en'
      const tax = await loadBrowse()
      if (lang !== 'zh') return json(res, 200, tax)
      const cache = await loadI18n('zh-taxonomy')
      if (url.searchParams.get('translate') === '1' && state.ctx) {
        const jobs = []
        for (const a of tax.areas || []) {
          if (a.name && !cache['a:' + a.id]) jobs.push({ key: 'a:' + a.id, text: a.name })
          for (const c of a.categories || []) {
            if (c.name && !cache['c:' + c.id]) jobs.push({ key: 'c:' + c.id, text: c.name })
          }
        }
        if (jobs.length) void translateTaxonomy(state.ctx, jobs).catch(() => {})
      }
      const out = {
        version: tax.version,
        areas: (tax.areas || []).map((a) => ({
          ...a,
          nameZh: cache['a:' + a.id] || null,
          categories: (a.categories || []).map((c) => ({
            ...c,
            nameZh: cache['c:' + c.id] || null,
          })),
        })),
      }
      return json(res, 200, out)
    }
    if (route === '/titles') {
      const lang = url.searchParams.get('lang') || 'zh'
      const store = lang + '-titles'
      const cache = await loadI18n(store)
      if (url.searchParams.get('translate') === '1') {
        const items = await loadList()
        const missing = items.filter((it) => it.t && !cache[it.v])
        void writeCache('titles-trigger.json', {
          at: Date.now(),
          hasCtx: !!state.ctx,
          items: items.length,
          missing: missing.length,
        })
        if (missing.length && state.ctx) {
          const limit = Number(url.searchParams.get('n') || 400)
          void translateTitles(state.ctx, missing.slice(0, limit), lang).catch(() => {})
        }
      }
      return json(res, 200, { lang, total: Object.keys(cache).length, entries: cache })
    }
    /**
     * 标题译文体检。没有 apply 只统计，apply=1 时把能修的修掉、
     * 把指令泄漏的条目删掉让下一轮重翻。可反复调用，幂等。
     */
    if (route === '/titles/lint') {
      const lang = url.searchParams.get('lang') || 'zh'
      const store = lang + '-titles'
      const cache = await loadI18n(store)
      const apply = url.searchParams.get('apply') === '1'
      const out = {
        lang,
        total: 0,
        changed: 0,
        removed: 0,
        leaks: 0,
        separators: 0,
        rawSeparators: 0,
        empty: 0,
        applied: apply,
        samples: [],
      }
      for (const [vid, raw] of Object.entries(cache)) {
        out.total += 1
        const clean = normalizeTitle(raw)
        const verdict = titleVerdict(clean)
        if (verdict === 'leak') {
          out.leaks += 1
          if (out.samples.length < 8) {
            out.samples.push({ vid, verdict, text: String(raw).slice(0, 90) })
          }
        }
        if (verdict === 'separator') out.separators += 1
        if (/[｜|]/.test(String(raw))) out.rawSeparators += 1
        if (verdict === 'empty') out.empty += 1
        const changed = clean !== raw
        if (changed) out.changed += 1
        if (!apply) continue
        if (verdict === 'leak' || verdict === 'empty') {
          delete cache[vid]
          out.removed += 1
        } else if (changed) {
          cache[vid] = clean
        }
      }
      if (apply && (out.changed || out.removed)) scheduleI18nSave(store)
      return json(res, 200, out)
    }
    /** 指定 id 强制重译：先删缓存再排队，用来验证新的提示词。 */
    if (route === '/titles/retranslate') {
      const store = 'zh-titles'
      let ids = String(url.searchParams.get('ids') || '')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
      if (!ids.length && url.searchParams.get('filter') === 'title-missing') {
        const limit = Number(url.searchParams.get('n') || 200)
        const list = await loadList()
        const cacheNow = await loadI18n(store)
        ids = list
          .filter((it) => it.t && !cacheNow[it.v])
          .slice(0, limit)
          .map((it) => it.v)
      }
      if (!ids.length && url.searchParams.get('filter') === 'title-structure') {
        const limit = Number(url.searchParams.get('n') || 200)
        const minScore = Number(url.searchParams.get('min') || 1)
        const list = await loadList()
        const cacheNow = await loadI18n(store)
        ids = list
          .filter((it) => {
            const z = cacheNow[it.v]
            return z && titleStructureScore(z) >= minScore
          })
          .slice(0, limit)
          .map((it) => it.v)
      }
      if (!ids.length) return json(res, 400, { error: 'ids required' })
      const cache = await loadI18n(store)
      let removed = 0
      for (const id of ids) {
        if (cache[id] !== undefined) {
          delete cache[id]
          removed += 1
        }
      }
      scheduleI18nSave(store)
      const list = await loadList()
      const items = list.filter((it) => ids.includes(it.v))
      if (state.ctx && items.length) void translateTitles(state.ctx, items, 'zh').catch(() => {})
      return json(res, 200, { requested: ids.length, removed, queued: items.length })
    }
    if (route === '/titles/progress') {
      const p = await readCache('titles-progress.json')
      return json(res, 200, p || { done: 0, total: 0 })
    }
    if (route === '/tools') {
      const out = { registered: null, names: [] }
      try {
        const tools = state.ctx?.get?.('tools')
        if (tools) {
          out.hasService = true
          const api = []
          let p = tools
          while (p && p !== Object.prototype) {
            api.push(...Object.getOwnPropertyNames(p))
            p = Object.getPrototypeOf(p)
          }
          out.api = Array.from(new Set(api)).slice(0, 30)
          for (const key of ['get', 'schemas', 'view', 'wireSchemas']) {
            if (typeof tools[key] !== 'function') continue
            try {
              const v = await tools[key]()
              if (Array.isArray(v) && v.length) {
                out.names = v
                  .map((x) => (typeof x === 'string' ? x : x && (x.name || x.id || x.tool)))
                  .filter(Boolean)
                out.via = key
                if (out.names.length) break
              } else if (v && typeof v === 'object') {
                out.names = Object.keys(v).slice(0, 80)
                out.via = key
                if (out.names.length) break
              }
            } catch {
              /* 换下一个 */
            }
          }
        }
      } catch (err) {
        out.error = String(err?.message ?? err).slice(0, 150)
      }
      return json(res, 200, out)
    }
    if (route === '/thumb') {
      const vid = url.searchParams.get('vid')
      if (!vid || !/^[A-Za-z0-9_-]{6,20}$/.test(vid)) {
        return json(res, 400, { error: 'bad vid' })
      }
      try {
        const upstream = await fetch(`https://i.ytimg.com/vi/${vid}/hqdefault.jpg`, {
          signal: AbortSignal.timeout(15_000),
        })
        if (!upstream.ok) {
          res.writeHead(502, { 'Content-Type': 'text/plain' })
          return res.end('upstream ' + upstream.status)
        }
        const buf = Buffer.from(await upstream.arrayBuffer())
        /* 从本域返回，画布才不会被跨域图片污染 */
        res.writeHead(200, {
          'Content-Type': 'image/jpeg',
          'Cache-Control': 'public, max-age=86400',
          'Content-Length': buf.length,
        })
        return res.end(buf)
      } catch (err) {
        res.writeHead(502, { 'Content-Type': 'text/plain' })
        return res.end(String(err?.message ?? err).slice(0, 120))
      }
    }
    if (route === '/i18n') {
      const lang = url.searchParams.get('lang') || 'zh'
      const entries = await loadI18n(lang)
      /* 有 pending=1 时顺手把未翻译的条目排进后台，返回当前已有的 */
      if (url.searchParams.get('translate') === '1' && state.ctx) {
        const items = await loadList()
        const missing = items.filter((it) => it.r && !entries[it.v])
        if (missing.length) {
          const limit = Number(url.searchParams.get('n') || 240)
          void translateEntries(state.ctx, missing.slice(0, limit), lang).catch(() => {})
        }
      }
      return json(res, 200, { lang, total: Object.keys(entries).length, entries })
    }
    if (route === '/deps') {
      const force = url.searchParams.get('force') === '1'
      return json(res, 200, await probeDeps(force))
    }
    if (route === '/subs') {
      const vid = url.searchParams.get('vid')
      if (!vid || !/^[A-Za-z0-9_-]{6,20}$/.test(vid)) {
        return json(res, 400, { reason: 'bad-vid' })
      }
      const lang = url.searchParams.get('lang') || 'zh'
      const result = await loadSubs(vid, lang !== 'en')
      return json(res, result.status, result.body)
    }
    return json(res, 404, { error: 'not found' })
  } catch (err) {
    return json(res, 502, { error: String(err?.message ?? err) })
  }
}

export function apply(ctx) {
  state.ctx = ctx
  /* 落一个启动标记：能不能写出这个文件，本身就说明 apply 有没有被调用 */
  void writeCache('boot.json', {
    at: Date.now(),
    pid: process.pid,
    profileDir: process.env.DSH_PROFILE_DIR || null,
  })

  let attempt = 0
  let done = false

  const tryRegister = () => {
    if (done) return
    let webServer = null
    try {
      webServer = ctx?.get?.('webServer')
    } catch {
      webServer = null
    }
    if (!webServer || typeof webServer.register !== 'function') {
      if (attempt < 2) {
        attempt += 1
        const t = setTimeout(tryRegister, 1500 * attempt)
        if (t && typeof t.unref === 'function') t.unref()
      }
      return
    }
    done = true
    /* 桌面端页面跑在 dsh-app:// 自定义协议下，不发 Referer，YouTube 因此报 153；
       记下 HTTP origin，让前端用绝对地址把中转页放进安全上下文 */
    try {
      const origin = typeof webServer.getOrigin === 'function' ? webServer.getOrigin() : null
      if (origin) state.origin = String(origin)
      const names = []
      let proto = webServer
      while (proto && proto !== Object.prototype) {
        for (const n of Object.getOwnPropertyNames(proto)) names.push(n)
        proto = Object.getPrototypeOf(proto)
      }
      void writeCache('webserver.json', {
        origin: state.origin,
        methods: Array.from(new Set(names)).slice(0, 40),
      })
    } catch (err) {
      void writeCache('webserver.json', { error: String(err?.message ?? err) })
    }

    /* 浏览器打开本应用的入口：dsh-app:// 不发 Referer，导致内嵌播放器全部失效；
       拿到带 launch token 的 HTTP 地址后，整个页面就能落到安全上下文里 */
    void (async () => {
      try {
        const conn = ctx?.get?.('connection')
        let info = { hasConn: !!conn }
        if (conn) {
          let proto = conn
          const keys = []
          while (proto && proto !== Object.prototype) {
            keys.push(...Object.getOwnPropertyNames(proto))
            proto = Object.getPrototypeOf(proto)
          }
          info.methods = Array.from(new Set(keys)).slice(0, 40)
          if (typeof conn.authenticatedUrl === 'function' && state.origin) {
            try {
              info.url = conn.authenticatedUrl(state.origin + '/')
              state.authUrl = info.url
            } catch (e) {
              info.urlError = String(e?.message ?? e)
            }
          }
        }
        await writeCache('auth-url.json', info)

        /* connection 可能比 apply 晚就绪，重试补齐 authUrl */
        if (!state.authUrl) {
          for (let i = 0; i < 15 && !state.authUrl; i += 1) {
            await new Promise((r) => setTimeout(r, 1000))
            try {
              const c2 = ctx?.get?.('connection')
              if (c2 && typeof c2.authenticatedUrl === 'function' && state.origin) {
                state.authUrl = c2.authenticatedUrl(state.origin + '/')
                await writeCache('auth-url.json', { hasConn: true, url: state.authUrl })
                break
              }
            } catch {
              /* 继续重试 */
            }
          }
        }
      } catch (err) {
        await writeCache('auth-url.json', { error: String(err?.message ?? err) })
      }
    })()

    /* 探针：试一次真实 LLM 调用，确认插件能用当前 profile 的模型 */
    void (async () => {
      const out = { steps: [] }
      try {
        const llm = ctx.get?.('llm')
        if (!llm) {
          await writeCache('llm-call.json', { steps: ['no llm service'] })
          return
        }
        const provider = 'magpie'
        const model = 'opencode-go/deepseek-v4.1-flash'
        const stream = llm.stream({
          provider,
          model,
          messages: [
            { role: 'user', content: [{ type: 'text', text: 'Reply with exactly: OK' }] },
          ],
        })
        let text = ''
        let raw = null
        for await (const chunk of stream) {
          if (raw === null) raw = JSON.stringify(chunk).slice(0, 400)
          if (typeof chunk === 'string') text += chunk
          else if (chunk && typeof chunk.text === 'string') text += chunk.text
          else if (chunk && typeof chunk.delta === 'string') text += chunk.delta
          else if (chunk && chunk.delta && typeof chunk.delta.text === 'string') text += chunk.delta.text
          if (text.length > 300) break
        }
        out.steps.push('chunk shape: ' + raw)
        out.steps.push('text: ' + JSON.stringify(text.slice(0, 150)))
      } catch (err) {
        out.steps.push('ERR: ' + String(err?.message ?? err).slice(0, 250))
      }
      await writeCache('llm-call.json', out)
    })()
    ctx.effect?.(
      () => webServer.register({ kind: 'prefix', path: PREFIX, handler }),
      'dsh-hackertube: routes',
    )
  }

  tryRegister()

  /* 让主对话能查这个视频库：Agent 在回答技术问题时可以主动检索 */
  try {
    ctx.inject(['tools'], (scope) => {
      scope.tools.register({
        name: 'hackertube_search',
        description:
          '在 Hacker News 二十年推荐的 6454 个技术视频里检索。' +
          '当用户讨论某个技术概念、想找深入讲解，或问有没有相关的演讲、课程、访谈时使用。' +
          '与面板搜索共用同一套排序：词边界、中英文扩展、标题/频道/标签/分类/摘要/HN 推荐理由加权。' +
          '返回标题、频道、时长、观看量、HN 推荐人数、匹配字段、摘要片段与链接。',
        parameters: {
          query: {
            type: 'string',
            required: true,
            description: '检索词，可以是技术概念、语言、框架名或自然语言描述，中英文均可',
          },
          limit: {
            type: 'number',
            description: '返回条数，默认 5，最多 15',
          },
          lang: {
            type: 'string',
            description: '返回文案的语言，zh 或 en，默认 zh',
          },
          area: {
            type: 'string',
            description: '按领域筛选，例如 software、ai-data、systems-security',
          },
          year: {
            type: 'number',
            description: '按发布年份筛选',
          },
          type: {
            type: 'string',
            description: '按内容类型筛选，例如 talk、course、lecture',
          },
          level: {
            type: 'string',
            description: '按难度筛选，例如 intro、intermediate、advanced、general',
          },
          sort: {
            type: 'string',
            description: '排序：relevance（默认）、score、year、views',
          },
        },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: String(value) }],
        },
        async execute(args) {
          const lang = args.lang === 'en' ? 'en' : 'zh'
          const tz = (zh, en) => (lang === 'zh' ? zh : en)
          const query = String(args.query || '').trim()
          if (!query) return tz('请提供检索词。', 'Provide a search query.')

          const result = await searchLibrary({
            query,
            limit: Math.min(Number(args.limit) || 5, 15),
            area: args.area,
            year: args.year,
            type: args.type,
            level: args.level,
            sort: args.sort,
            /* 工具输出要用中文标题和推荐理由，这两串只在这里取 */
            verbose: true,
          })
          if (!result.items.length) {
            return tz(
              '没有找到匹配的视频。可以换更宽泛的关键词，中英文都试试。',
              'No matching videos. Try broader keywords, in English or Chinese.',
            )
          }

          const fieldLabels = {
            title: ['标题', 'title'],
            title_zh: ['中文标题', 'Chinese title'],
            channel: ['频道', 'channel'],
            tags: ['标签', 'tags'],
            categories: ['分类', 'category'],
            topic: ['主题', 'topic'],
            summary: ['摘要', 'summary'],
            why_hn: ['HN 推荐理由', 'HN reason'],
          }
          const nf = (n) => {
            const v = Number(n) || 0
            if (lang === 'zh') {
              if (v >= 1e8) return (v / 1e8).toFixed(1).replace(/\.0$/, '') + ' 亿'
              if (v >= 1e4) return (v / 1e4).toFixed(1).replace(/\.0$/, '') + ' 万'
              return String(v)
            }
            if (v >= 1e9) return (v / 1e9).toFixed(1).replace(/\.0$/, '') + 'B'
            if (v >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M'
            if (v >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'K'
            return String(v)
          }

          return result.items
            .map((it, i) => {
              const zh = (it.match && it.match.titleZh) || ''
              const title = lang === 'zh' && zh ? zh : it.t
              const alt = lang === 'zh' && zh && zh !== it.t ? '（' + it.t + '）' : ''
              const mins = Math.max(1, Math.round((it.d || 0) / 60))
              const bits = [
                it.c || '',
                tz(mins + ' 分钟', mins + ' min'),
                tz(nf(it.w) + '次观看', nf(it.w) + ' views'),
              ]
              if (it.r) bits.push(tz(it.r + ' 人推荐', it.r + ' recommenders'))
              let line = i + 1 + '. ' + title + alt + ' — ' + bits.filter(Boolean).join(' · ')
              const matched = it.match && Array.isArray(it.match.fields) ? it.match.fields : []
              if (matched.length) {
                const labels = matched
                  .map((f) => (fieldLabels[f] ? fieldLabels[f][lang === 'zh' ? 0 : 1] : f))
                  .join(tz('、', ', '))
                line += '\n   ' + tz('匹配：', 'Matched: ') + labels
                if (it.match.snippet) line += ' — ' + it.match.snippet
              }
              const why = (it.match && it.match.why) || ''
              if (why) {
                line += '\n   ' + tz('HN：', 'HN: ') + (why.length > 110 ? why.slice(0, 110) + '…' : why)
              }
              line += '\n   https://www.youtube.com/watch?v=' + it.v
              return line
            })
            .join('\n\n')
        },
      })
      void writeCache('tool-registered.json', { ok: true, at: Date.now() })
    })
  } catch (err) {
    void writeCache('tool-registered.json', {
      ok: false,
      error: String(err?.message ?? err).slice(0, 200),
    })
  }

  /* 探针：列出 ctx 上可用的服务，决定推荐流能否直接读会话数据 */
  try {
    const own = Object.getOwnPropertyNames(ctx).filter((n) => n.startsWith('$'))
    const protoNames = []
    let p = Object.getPrototypeOf(ctx)
    while (p && p !== Object.prototype) {
      protoNames.push(...Object.getOwnPropertyNames(p))
      p = Object.getPrototypeOf(p)
    }
    const candidates = [
      'sessions',
      'agent',
      'agents',
      'llm',
      'model',
      'models',
      'completion',
      'inference',
      'provider',
      'providers',
      'ai',
      'chat',
      'prompt',
    ]
    const resolved = {}
    for (const name of candidates) {
      try {
        const svc = ctx.get?.(name)
        resolved[name] = svc ? 'yes' : 'no'
      } catch (err) {
        resolved[name] = 'throw: ' + String(err?.message ?? err).slice(0, 60)
      }
    }
    void writeCache('ctx-services.json', {
      dollarProps: own.slice(0, 60),
      proto: Array.from(new Set(protoNames)).slice(0, 60),
      resolved,
      apiOf: Object.fromEntries(
        ['sessions', 'llm', 'agents'].map((name) => {
          try {
            const svc = ctx.get?.(name)
            if (!svc) return [name, null]
            const keys = []
            let q = svc
            while (q && q !== Object.prototype) {
              keys.push(...Object.getOwnPropertyNames(q))
              q = Object.getPrototypeOf(q)
            }
            return [name, Array.from(new Set(keys)).slice(0, 40)]
          } catch (err) {
            return [name, 'throw: ' + String(err?.message ?? err).slice(0, 60)]
          }
        }),
      ),
    })
  } catch (err) {
    void writeCache('ctx-services.json', { error: String(err?.message ?? err) })
  }

  /**
   * 独立的中转服务器：DSH 的 webServer 在认证层后面，dsh-app:// 页面发起的
   * 跨源 iframe 请求带不上 cookie，会被 401 挡掉。这里另起一个只服务中转页、
   * 免认证、仅监听回环地址的小服务器，让播放器真正落在 HTTP 安全上下文。
   */
  try {
    /* 重载时旧实例的监听不会自动消失，先显式关掉，避免端口漂移后
       前端还指向旧版中转页（旧版带 X-Frame-Options，会被浏览器拒绝渲染） */
    const stale = globalThis.__htMediaServer
    if (stale && typeof stale.close === 'function') {
      try {
        stale.close()
      } catch {
        /* 已关闭 */
      }
    }

    const mediaServer = createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://local')
      if (u.pathname === '/embed') {
        const vid = u.searchParams.get('vid')
        if (!vid || !/^[A-Za-z0-9_-]{6,20}$/.test(vid)) {
          res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('bad vid')
          return
        }
        const lang = u.searchParams.get('lang') === 'zh' ? 'zh' : 'en'
        return serveEmbed(req, res, vid, lang, u.searchParams.get('auto') === '1')
      }
      /* 直链兜底也走免认证端口：dsh-app:// 页面带不上 Host 的认证 cookie */
      if (u.pathname === '/media' || u.pathname === '/stream') {
        const vid = u.searchParams.get('vid')
        if (!vid || !/^[A-Za-z0-9_-]{6,20}$/.test(vid)) {
          res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('bad vid')
          return
        }
        return u.pathname === '/media' ? serveMedia(req, res, vid) : serveStream(req, res, vid)
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('not found')
    })
    mediaServer.on('error', () => {
      /* 端口占用等异常不影响主面板 */
    })
    globalThis.__htMediaServer = mediaServer

    /* 优先用固定端口：前端可能缓存了地址，端口稳定才不会被旧值误导 */
    const tryListen = (ports) => {
      const port = ports[0]
      mediaServer.listen(port, '127.0.0.1', () => {
        state.mediaOrigin = `http://127.0.0.1:${port}`
        void writeCache('media-origin.json', { origin: state.mediaOrigin, port })
      })
      mediaServer.once('error', () => {
        if (ports.length > 1) tryListen(ports.slice(1))
      })
    }
    tryListen([18090, 18091, 18092, 18093, 0])

    ctx.effect(
      () => () => {
        try {
          mediaServer.close()
        } catch {
          /* 已关闭 */
        }
        if (globalThis.__htMediaServer === mediaServer) globalThis.__htMediaServer = null
      },
      'dsh-hackertube: media server',
    )
  } catch (err) {
    void writeCache('media-origin.json', { error: String(err?.message ?? err) })
  }

  /* 预热：把首次十几秒的抓取挪到 Host 启动阶段，面板打开时多半已就绪 */
  void loadList().catch(() => {})
  void loadBrowse().catch(() => {})
}
