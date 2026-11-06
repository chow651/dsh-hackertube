/**
 * 备用片源解析（Mirror Source）。
 *
 * 给定一条主站视频的标识、标题与时长，判断镜像站上是否存在同一支片子，
 * 并在存在多个版本时挑出最好的那个。判定与选取是纯函数，可单独测试；
 * 网络与缓存由调用方注入缓存目录，方便用 fixture 跑。
 *
 * 设计口径：宁可漏，不可错。判定用合取，一个无关视频不能靠时长巧合混进来；
 * 档位只决定同源多版本时选哪个，不决定显不显示。
 */

/* ==========================================================================
   一、文本工具
   ========================================================================== */

const PUNCT = /[\s\u3000!-/:-@[-`{-~。，、；：？！""''（）【】《》〈〉—…·|｜+*#&@]+/g

export function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(PUNCT, '')
}

const CJK = /[\u4e00-\u9fff]/

export function hasCJK(s) {
  return CJK.test(String(s || ''))
}

/**
 * 最长公共子串。返回长度与实际子串——子串内容要参与判定，
 * 纯英文品牌名巧合（Harley Davidson）必须能被识别出来。
 */
export function commonRun(a, b) {
  const A = normalize(a)
  const B = normalize(b)
  if (!A.length || !B.length) return { len: 0, sub: '' }
  const m = B.length
  let prev = new Int32Array(m + 1)
  let cur = new Int32Array(m + 1)
  let best = 0
  let endInA = 0
  for (let i = 1; i <= A.length; i += 1) {
    const ai = A.charCodeAt(i - 1)
    for (let j = 1; j <= m; j += 1) {
      if (ai === B.charCodeAt(j - 1)) {
        const v = prev[j - 1] + 1
        cur[j] = v
        if (v > best) {
          best = v
          endInA = i
        }
      } else cur[j] = 0
    }
    const t = prev
    prev = cur
    cur = t
    cur.fill(0)
  }
  return { len: best, sub: A.slice(endInA - best, endInA) }
}

/** 中文用字符 bigram 重合度：比子串匹配更抗意译改写。 */
export function bigramScore(a, b) {
  const grams = (s) => {
    const t = normalize(s).replace(/[^\u4e00-\u9fff]/g, '')
    const out = new Set()
    for (let i = 0; i < t.length - 1; i += 1) out.add(t.slice(i, i + 2))
    return out
  }
  const A = grams(a)
  const B = grams(b)
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const g of A) if (B.has(g)) inter += 1
  return inter / Math.min(A.size, B.size)
}

export function parseDuration(s) {
  if (typeof s === 'number') return s
  if (!s) return null
  const p = String(s).split(':').map(Number)
  if (p.some(Number.isNaN)) return null
  return p.reduce((x, y) => x * 60 + y, 0)
}

/* ==========================================================================
   二、类型标记
   ========================================================================== */

const SUBTITLE_MARKS = [
  '熟肉', '中字', '中文字幕', '中英字幕', '中英双字', '双语', '官方双语',
  '中文配音', '中配', '字幕版', '全熟', '精校字幕', 'AI字幕', '汉化',
]
const RAW_MARKS = ['生肉', '无字幕', '英文原版', '无中字']

/** 标题是否声明了本地化字幕 */
export function hasSubtitles(title) {
  const t = String(title || '')
  if (RAW_MARKS.some((k) => t.includes(k))) return false
  return SUBTITLE_MARKS.some((k) => t.toLowerCase().includes(k.toLowerCase()))
}

/**
 * 二次创作：借用了原片素材但做了新内容。
 * 「万字解析」不列入——搬运号常拿它当自家噱头，实测会误伤真熟肉。
 */
const DERIVED_MARKS = [
  '改编', '解说', '讲解', '点评', '杂谈', '解读', '吐槽', '速看',
  '一口气', '看完', '分钟看懂', '深度拆解', '带你', '聊一聊',
  'reaction', 'react to', '观后感', '影评',
]

export function isDerived(title) {
  const t = String(title || '').toLowerCase()
  return DERIVED_MARKS.some((k) => t.includes(k.toLowerCase()))
}

/** 频道名主词：`Kurzgesagt – In a Nutshell` → `kurzgesagt` */
function primaryName(s) {
  const raw = String(s || '')
  const first = raw.split(/\s+[–—|·:]\s+|\s*\|\s*/)[0] || raw
  return normalize(first) || normalize(raw)
}

/**
 * 官方入驻号：以名字为准，不以投稿类型为准。
 * 实测同一频道有的标自制（copyright=1）、有的标转载，用投稿类型卡会漏一半。
 */
export function isOfficialAccount(remote, channel) {
  if (!remote) return false
  const up = normalize(remote.owner?.name)
  const ch = normalize(channel)
  if (!up || !ch) return false
  const upMain = primaryName(remote.owner?.name)
  const chMain = primaryName(channel)

  if (up === ch) return true
  if (upMain && chMain && upMain === chMain) return true
  if (chMain.length >= 4 && up.startsWith(chMain) && up.length - chMain.length <= 6) return true
  if (upMain.length >= 4 && ch.startsWith(upMain) && ch.length - upMain.length <= 6) return true
  if (up.length >= 4 && ch.length >= 4 && (up.includes(ch) || ch.includes(up))) return true
  return false
}

/* ==========================================================================
   三、判定
   ========================================================================== */

/**
 * 收集证据。
 * E1/E2 是外部凭据，直接 CONFIRMED；E3~E5 是内容相似，只给 STRONG。
 * 弱信号权重归零，仅用于排查，不参与判定。
 */
export function collectEvidence(remote, local, opts = {}) {
  const hits = []
  const desc = String(remote.desc || '')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
  const title = String(remote.title || '')
  const vid = String(local.id || '')

  /* 反证机制：简介里出现的视频 ID 是双向证据。
     出现本条 → 就是这支；只出现别的 → 是同一作者的另一支，直接否决。
     实测踩过：某频道《这不是邦联国旗？》的简介写着另一支视频的 ID，
     被同频道一条时长巧合的片子顶上来。 */
  const ids = [...desc.matchAll(/(?:youtu\.be\/|[?&]v=)([A-Za-z0-9_-]{11})/g)].map((m) => m[1])
  const uniq = [...new Set(ids)]
  const hasThisId = uniq.includes(vid)
  const hasOtherOnly = uniq.length > 0 && !hasThisId

  if (hasThisId) hits.push({ code: 'E1', weight: 3, why: '简介含本条源视频标识' })
  else if (hasOtherOnly) hits.push({ code: 'NEG', weight: 0, why: `简介指向别的视频 ${uniq.slice(0, 2).join(',')}` })

  const declares = /转载|搬运|原作者|原视频|原链接|来源[:：]|source[:：]|credit|转自/i.test(desc)
  const channelHit = String(local.channel || '').length > 2
    && desc.toLowerCase().includes(String(local.channel).toLowerCase())
  if (declares && channelHit && !hasOtherOnly) {
    hits.push({ code: 'E2', weight: 3, why: '简介声明转载且提及原频道' })
  }

  /* 原标题被保留。除覆盖率外还要求绝对长度：短标题六个字符就能刷到 0.6。 */
  const en = commonRun(local.title, title)
  const enRatio = en.len / Math.max(1, Math.min(normalize(local.title).length, normalize(title).length))
  if (enRatio >= 0.6 && en.len >= 12 && (en.len >= 20 || enRatio >= 0.8)) {
    hits.push({ code: 'E3', weight: 2.5, why: `原标题 LCS ${en.len}「${en.sub.slice(0, 30)}」` })
  }

  /* 译名吻合。重合片段必须含中文，否则品牌名会对上无关视频。 */
  if (local.titleZh) {
    const zh = commonRun(local.titleZh, title)
    const zhRatio = zh.len / Math.max(1, Math.min(normalize(local.titleZh).length, normalize(title).length))
    const bigram = bigramScore(local.titleZh, title)
    if ((bigram >= 0.5 || zhRatio >= 0.5) && zh.len >= 6 && (hasCJK(zh.sub) || zh.len >= 20)) {
      hits.push({ code: 'E4', weight: 2, why: `译名 bigram ${bigram.toFixed(2)} / LCS ${zh.len}「${zh.sub.slice(0, 22)}」` })
    }
  }

  if (opts.pageHit) {
    hits.push({ code: 'E5', weight: 2.5, why: `分P ${opts.pageHit.index} 时长命中` })
  }

  return hits
}

/**
 * 主判定。
 * @returns {{ ok: boolean, level: string, reason: string, hits: Array, gate: object }}
 *   level: CONFIRMED | STRONG | DERIVED | CONTRADICTED | REJECT
 */
export function match(remote, local, opts = {}) {
  const gate = {}
  const localDur = local.duration
  /* 详情接口给的是 duration，搜索结果是 dur——两边都得认 */
  const remoteDur = opts.pageHit
    ? opts.pageHit.duration
    : parseDuration(remote.dur ?? remote.duration)

  gate.delta = remoteDur == null || !localDur ? null : Math.abs(remoteDur - localDur)
  gate.durationOk = gate.delta != null && gate.delta <= 2

  const remoteAt = Number(remote.pubdate || 0)
  const localAt = Date.parse(local.published || '') / 1000
  gate.timeOk = !remoteAt || !localAt || remoteAt >= localAt - 30 * 86400

  gate.valid = !!remoteDur && remoteDur > 10

  if (!gate.durationOk || !gate.timeOk || !gate.valid) {
    const why = []
    if (!gate.durationOk) why.push(`时长不符 Δ${gate.delta ?? '?'}s`)
    if (!gate.timeOk) why.push('早于原片')
    if (!gate.valid) why.push('时长无效')
    return { ok: false, level: 'REJECT', reason: why.join(' / '), hits: [], gate }
  }

  const hits = collectEvidence(remote, local, opts)
  const strong = hits.filter((h) => h.weight >= 2)
  const credential = hits.some((h) => h.code === 'E1' || h.code === 'E2')

  const negative = hits.find((h) => h.code === 'NEG')
  if (negative) return { ok: false, level: 'CONTRADICTED', reason: negative.why, hits, gate }

  if (!strong.length) {
    return { ok: false, level: 'REJECT', reason: '证据不足', hits, gate }
  }

  /* 二创过滤只在没有外部凭据时生效：简介里有本条标识就说明是原片本身。 */
  if (!credential && isDerived(remote.title)) {
    return { ok: false, level: 'DERIVED', reason: '二创', hits, gate }
  }

  if (credential) {
    const why = hits.filter((h) => h.code === 'E1' || h.code === 'E2').map((h) => h.why).join('；')
    return { ok: true, level: 'CONFIRMED', reason: why, hits, gate }
  }
  return { ok: true, level: 'STRONG', reason: strong.map((h) => h.why).join('；'), hits, gate }
}

/* ==========================================================================
   四、选取
   ========================================================================== */

export const RANK = { OFFICIAL: 0, LOCALIZED: 1, RAW: 2 }

const RANK_LABEL = { 0: '官方', 1: '中字', 2: '转载' }

/**
 * 同源多版本时挑一个。
 * 官方号是独立优先级层，不参与打分；其余按本地化程度分档，
 * 同档内显式字幕 > 播放量。转载不会因为播放量低被丢弃——
 * 有的频道根本没有官方入驻，高质量转载就是唯一选项。
 */
export function pickBest(candidates, channel) {
  if (!Array.isArray(candidates) || !candidates.length) return null

  const scored = candidates.map((c) => {
    const play = Number(c.remote?.stat?.view ?? c.play ?? 0)
    const title = String(c.remote?.title || c.title || '')
    const subtitles = hasSubtitles(title)
    const chineseTitle = hasCJK(title)
    const popular = play >= 10000
    const official = isOfficialAccount(c.remote, channel)
    const rank = official ? RANK.OFFICIAL
      : (subtitles || chineseTitle || popular) ? RANK.LOCALIZED
      : RANK.RAW
    return { ...c, play, subtitles, chineseTitle, official, rank }
  })

  scored.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank
    if (a.subtitles !== b.subtitles) return a.subtitles ? -1 : 1
    return b.play - a.play
  })

  const best = scored[0]
  return {
    ...best,
    label: best.rank === RANK.OFFICIAL ? '官方' : best.subtitles ? '中字' : best.chineseTitle ? '中文' : RANK_LABEL[2],
    alternates: scored.slice(1),
  }
}

/* ==========================================================================
   五、访问层
   ========================================================================== */

const CLIENT_IDS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
]
const LANGUAGES = ['zh-CN,zh;q=0.9', 'zh-CN,zh;q=0.9,en;q=0.8', 'zh-CN,zh;q=0.9,en-US;q=0.7']

const mixinTable = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28,
  14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54,
  21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
]

function pick(list) {
  return list[Math.floor(Math.random() * list.length)]
}

function mixin(name) {
  return mixinTable.map((n) => name[n]).join('').slice(0, 32)
}

function signQuery(params, mixinKey, hashFn) {
  const all = { ...params, wts: Math.round(Date.now() / 1000) }
  const q = Object.keys(all)
    .sort()
    .map((k) => {
      const v = String(all[k]).replace(/[!'()*]/g, '')
      return `${encodeURIComponent(k)}=${encodeURIComponent(v)}`
    })
    .join('&')
  return `${q}&w_rid=${hashFn(q + mixinKey)}`
}

/* 设备指纹哑值。注意不要带 dm_img_inter——实测带上必被判风控。 */
const DEVICE_HINTS = {
  dm_img_list: '[]',
  dm_img_str: 'V2ViR0wgMS4wIChPcGVuR0wgRVMgMi4wIENocm9taXVtKQ',
  dm_cover_img_str:
    'QU5HTEUgKEludGVsLCBJbnRlbChSKSBVSEQgR3JhcGhpY3MgNjMwICgweDAwMDAzRTlCKSBEaXJlY3QzRDExIHZzXzVfMCBwc181XzApLCBvciBzaW1pbGFy',
}

/**
 * 会话：一套匿名标识 + 一份签名口令。
 * 标题里不写站点名，调用方只需要知道这是「备用源」。
 */
export class Session {
  constructor({ fetchImpl, hashFn, base, timeoutMs = 8000 }) {
    this.fetch = fetchImpl
    this.hash = hashFn
    this.base = base
    this.timeout = timeoutMs
    this.cookie = ''
    this.mixinKey = ''
    this.used = 0
    this.limit = 90
    this.ready = null
  }

  async ensure() {
    if (!this.ready) this.ready = this.#handshake().catch((e) => { this.ready = null; throw e })
    return this.ready
  }

  async #handshake() {
    const ua = pick(CLIENT_IDS)
    const res = await this.fetch(`${this.base}/x/frontend/finger/spi`, {
      headers: { 'User-Agent': ua, Referer: `${this.base.replace('api.', 'www.')}/` },
      signal: AbortSignal.timeout(this.timeout),
    })
    const spi = await res.json()
    const d = spi?.data || {}
    this.cookie = [
      `buvid3=${d.b_3}`,
      `buvid4=${d.b_4}`,
      `b_nut=${Math.round(Date.now() / 1000)}`,
    ].join('; ')

    const nav = await this.fetch(`${this.base}/x/web-interface/nav`, {
      headers: { 'User-Agent': ua, Referer: `${this.base.replace('api.', 'www.')}/`, Cookie: this.cookie },
      signal: AbortSignal.timeout(this.timeout),
    })
    const navJson = await nav.json()
    const img = navJson?.data?.wbi_img?.img_url?.split('/').pop()?.split('.')[0] || ''
    const sub = navJson?.data?.wbi_img?.sub_url?.split('/').pop()?.split('.')[0] || ''
    if (!img || !sub) throw new Error('handshake failed')
    this.mixinKey = mixin(img + sub)
    this.used = 0
    return this
  }

  async rotate() {
    this.ready = null
    this.cookie = ''
    this.mixinKey = ''
    return this.ensure()
  }

  headers(referer) {
    const h = {
      'User-Agent': pick(CLIENT_IDS),
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': pick(LANGUAGES),
      Cookie: this.cookie,
    }
    if (referer) {
      h.Referer = referer
      try { h.Origin = new URL(referer).origin } catch { /* 非法 URL 就不带 Origin */ }
    }
    return h
  }
}

/* ==========================================================================
   六、解析器
   ========================================================================== */

/**
 * @param {object} opts
 *   fetchImpl   注入的 fetch（Node 18+ 默认即可）
 *   hashFn      md5 文本 → 十六进制
 *   cacheFile   缓存落盘路径；为 null 时不落盘，只保留内存
 *   readFile/writeFile/mkdir  注入的文件操作，测试时可用 stub
 */
export function createResolver(opts = {}) {
  const {
    fetchImpl = globalThis.fetch,
    hashFn,
    cacheFile = null,
    readFile = null,
    writeFile = null,
    mkdir = null,
    now = () => Date.now(),
    base = 'https://api.bilibili.com',
    timeoutMs = 8000,
    overallMs = 20000,
    ttlFound = 180 * 86400e3,
    ttlMiss = 7 * 86400e3,
  } = opts

  if (!hashFn) throw new Error('createResolver: hashFn is required')

  const session = new Session({ fetchImpl, hashFn, base, timeoutMs })
  const memory = new Map()
  const inflight = new Map()
  let loaded = null
  let dirty = false

  /* ---------- 缓存 ---------- */

  async function load() {
    if (loaded) return loaded
    if (!cacheFile || !readFile) { loaded = { v: 1, entries: {} }; return loaded }
    try {
      const raw = await readFile(cacheFile, 'utf8')
      const parsed = JSON.parse(raw)
      loaded = parsed && parsed.v === 1 && parsed.entries ? parsed : { v: 1, entries: {} }
    } catch {
      loaded = { v: 1, entries: {} }
    }
    return loaded
  }

  async function flush() {
    if (!cacheFile || !writeFile || !dirty) return
    dirty = false
    try {
      if (mkdir) await mkdir(cacheFile.replace(/[\\/][^\\/]+$/, ''), { recursive: true })
      await writeFile(cacheFile, JSON.stringify(await load()), 'utf8')
    } catch {
      /* 落盘失败不影响本次返回 */
    }
  }

  function fresh(entry) {
    if (!entry) return false
    const age = now() - Number(entry.at || 0)
    if (entry.status === 'found') return age < ttlFound
    if (entry.status === 'none') return age < ttlMiss
    return false
  }

  /* ---------- 访问 ---------- */

  let swapping = false

  async function call(path, params, referer) {
    await session.ensure()
    /* 配额按会话计。并发下可能同时越线，用 swapping 标记避免重复握手。 */
    if (session.used > session.limit && !swapping) {
      swapping = true
      try { await session.rotate() } finally { swapping = false }
    }
    const q = signQuery(params, session.mixinKey, hashFn)
    const res = await fetchImpl(`${base}${path}?${q}`, {
      headers: session.headers(referer),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { json = null }
    if (res.status === 412 || json?.code === -412 || json?.code === -352) {
      await session.rotate()
      const err = new Error('throttled')
      err.throttled = true
      throw err
    }
    if (!json || json.code !== 0) {
      const err = new Error(`upstream ${json?.code ?? res.status}`)
      err.code = json?.code
      throw err
    }
    session.used += 1
    return json.data
  }

  /** 搜索：失败重试一次，风控时换会话。 */
  async function search(keyword, page) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const data = await call(
          '/x/web-interface/wbi/search/type',
          { search_type: 'video', keyword, page, page_size: 50 },
          `https://search.bilibili.com/all?keyword=${encodeURIComponent(keyword)}`,
        )
        return Array.isArray(data?.result) ? data.result : []
      } catch (e) {
        if (!e.throttled) return []
        await new Promise((r) => setTimeout(r, 700 + Math.floor(Math.random() * 900)))
      }
    }
    return []
  }

  async function detail(bvid) {
    try {
      const data = await call(
        '/x/web-interface/view',
        { bvid },
        `https://www.bilibili.com/video/${bvid}`,
      )
      return data || null
    } catch {
      return null
    }
  }

  /* ---------- 查询词 ---------- */

  function queries(local) {
    const out = []
    const channel = String(local.channel || '')
    if (channel.length > 2) out.push(channel)

    const raw = String(local.title || '')
    out.push(raw.length > 70 ? raw.slice(0, 70) : raw)
    const beforePipe = raw.split(/\s*[|—–]\s*/)[0]
    if (beforePipe.length >= 8 && beforePipe !== raw) out.push(beforePipe)

    const zh = String(local.titleZh || '')
    if (zh) {
      out.push(zh)
      const noPunct = zh.replace(/[：:，,。.、「」【】《》"'（）()!？?·—–]+/g, ' ').replace(/\s+/g, ' ').trim()
      if (noPunct !== zh && noPunct.length >= 3) out.push(noPunct)
      const head = zh.split(/[：:，,。.、]/)[0].trim()
      if (head.length >= 3 && head !== zh) out.push(head)
    }

    /* 控制词数：每个词两页，四个词就是八个并发请求。
       再多会挤在同一秒打出去，得不偿失。 */
    return [...new Set(out.filter((s) => String(s || '').trim().length > 2))].slice(0, 4)
  }

  /* ---------- 主流程 ---------- */

  /**
   * @param {object} local
   *   id        源视频标识
   *   title     原标题
   *   titleZh   中文译名（可选，但显著提升命中率）
   *   channel   频道名
   *   duration  时长（秒）
   *   published 发布时间（ISO 字符串，可选）
   * @returns {Promise<{url,label,play,bvid,title,up,reason,alternates}|null>}
   */
  async function resolve(local) {
    const vid = String(local?.id || '')
    if (!/^[A-Za-z0-9_-]{6,20}$/.test(vid)) return null
    if (!local?.title || !local?.duration) return null

    const cache = await load()
    const hit = cache.entries[vid]
    if (fresh(hit)) {
      if (hit.status !== 'found') { memory.set(vid, null); return null }
      const value = {
        url: hit.url,
        bvid: hit.bvid,
        label: hit.label,
        play: hit.play,
        title: hit.title,
        up: hit.up,
        reason: hit.reason,
        alternates: [],
      }
      memory.set(vid, value)
      return value
    }
    if (memory.has(vid)) {
      const cached = memory.get(vid)
      if (cached) return cached
    }

    if (inflight.has(vid)) return inflight.get(vid)

    const task = (async () => {
      const deadline = now() + overallMs
      const pool = new Map()

      /* 查询词与分页全部并发：3 个词 × 2 页 = 6 个请求同时发，
         只等一个往返。串行发要三倍时间。 */
      const plan = []
      for (const q of queries(local)) {
        plan.push([q, 1], [q, 2])
      }
      const results = await Promise.all(plan.map(([q, p]) => search(q, p)))
      for (const list of results) {
        for (const item of list) {
          const bvid = String(item?.bvid || '')
          if (!bvid || pool.has(bvid)) continue
          pool.set(bvid, {
            bvid,
            title: String(item.title || '').replace(/<[^>]+>/g, ''),
            dur: parseDuration(item.duration),
            play: Number(item.play || 0),
          })
        }
      }
      if (now() > deadline) { /* 超时也继续往下走，已有结果足够判定 */ }

      /* 只有时长对得上的才值得拉详情——平均 2.3 个。 */
      const near = [...pool.values()]
        .filter((c) => c.dur != null && Math.abs(c.dur - local.duration) <= 2)
        .slice(0, 8)

      const details = await Promise.all(near.map((c) => detail(c.bvid)))
      const accepted = []
      for (let i = 0; i < near.length; i += 1) {
        const remote = details[i]
        if (!remote) continue
        const pages = Array.isArray(remote.pages) ? remote.pages : []
        let pageHit = null
        if (pages.length > 1) {
          const idx = pages.findIndex((p) => Math.abs(p.duration - local.duration) <= 2)
          if (idx >= 0) pageHit = { index: idx + 1, duration: pages[idx].duration }
        }
        const verdict = match(remote, local, { pageHit })
        if (verdict.ok) accepted.push({ remote, pageHit, verdict, bvid: near[i].bvid })
      }

      const best = pickBest(accepted, local.channel)
      const entry = { at: now() }
      if (best) {
        const page = best.pageHit?.index || null
        Object.assign(entry, {
          status: 'found',
          url: `https://www.bilibili.com/video/${best.bvid}${page ? `?p=${page}` : ''}`,
          bvid: best.bvid,
          label: best.label,
          play: best.play,
          title: String(best.remote?.title || '').slice(0, 200),
          up: String(best.remote?.owner?.name || '').slice(0, 80),
          reason: best.verdict.reason,
        })
      } else {
        entry.status = 'none'
      }
      cache.entries[vid] = entry
      dirty = true
      void flush()

      if (!best) { memory.set(vid, null); return null }
      const value = {
        url: entry.url,
        bvid: entry.bvid,
        label: entry.label,
        play: entry.play,
        title: entry.title,
        up: entry.up,
        reason: entry.reason,
        alternates: (best.alternates || []).map((a) => ({
          bvid: a.bvid,
          label: a.label,
          play: a.play,
          title: String(a.remote?.title || '').slice(0, 120),
        })),
      }
      memory.set(vid, value)
      return value
    })()

    inflight.set(vid, task)
    try {
      return await task
    } finally {
      inflight.delete(vid)
    }
  }

  /** 标记失效：链接被删或迁移时调用，下次访问会重新解析。 */
  async function invalidate(vid) {
    const cache = await load()
    if (cache.entries[vid]) {
      delete cache.entries[vid]
      dirty = true
      memory.delete(vid)
      await flush()
    }
  }

  /** 批量预热，供后台补数据用。命中缓存的直接跳过。 */
  async function warm(list, concurrency = 2) {
    const queue = [...list]
    const out = { scanned: 0, found: 0, missed: 0 }
    const worker = async () => {
      for (;;) {
        const item = queue.shift()
        if (!item) return
        out.scanned += 1
        const r = await resolve(item)
        if (r) out.found += 1
        else out.missed += 1
        await new Promise((res) => setTimeout(res, 150 + Math.floor(Math.random() * 250)))
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker))
    return out
  }

  async function stats() {
    const cache = await load()
    const all = Object.values(cache.entries)
    return {
      total: all.length,
      found: all.filter((e) => e.status === 'found').length,
      none: all.filter((e) => e.status === 'none').length,
      memory: memory.size,
      inflight: inflight.size,
    }
  }

  async function snapshot() {
    const cache = await load()
    return JSON.parse(JSON.stringify(cache))
  }

  return { resolve, invalidate, warm, stats, snapshot, session }
}
