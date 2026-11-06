/**
 * 推荐画像（Taste Profile）。
 *
 * 只用站点本地导出里已有的两样数据：likes 视频的向量质心，以及
 * related.jsonl 的共推荐边。纯函数，不读文件、不联网；冷启动所需的
 * 播放列表与 HN 分数由调用方传入，方便用 fixture 测试。
 */

const MAX_LIKES = 60
/* 单个已喜欢视频最多贡献几条推荐，避免整行都被同一个来源占满 */
const MAX_PER_SOURCE = 3
/* 向量是主信号；HN 共推荐边只做次级加权。related.jsonl 里混有泛热门条目，
   如果权重过高会把「Sketchpad」「Startup School」这类噪声顶到线性代数视频前面。 */
const VECTOR_WEIGHT = 0.9
const RELATED_WEIGHT = 0.1

/** 清掉坏 id、去重并限量；前端 query 与 prefs 都走这一套。 */
export function normalizeIds(list, max = 400) {
  const out = []
  const seen = new Set()
  for (const raw of Array.isArray(list) ? list : []) {
    const id = String(raw || '')
    if (!/^[A-Za-z0-9_-]{6,20}$/.test(id) || seen.has(id)) continue
    seen.add(id)
    out.push(id)
    if (out.length >= max) break
  }
  return out
}

function relatedList(related, vid) {
  if (!related) return []
  if (typeof related.get === 'function') {
    const list = related.get(vid)
    return Array.isArray(list) ? list : []
  }
  const list = related[vid]
  return Array.isArray(list) ? list : []
}

function vectorIndex(vectors, vid) {
  if (!vectors || !vectors.index || typeof vectors.index.get !== 'function') return -1
  const at = vectors.index.get(vid)
  return at === undefined ? -1 : at
}

function cosineAt(vectors, a, b) {
  const { vec, dim, norms } = vectors
  const baseA = a * dim
  const baseB = b * dim
  let dot = 0
  for (let d = 0; d < dim; d += 1) dot += vec[baseA + d] * vec[baseB + d]
  return dot / ((norms[a] || 1) * (norms[b] || 1))
}

function buildCentroid(vectors, likes) {
  const indexes = []
  for (const vid of likes) {
    const at = vectorIndex(vectors, vid)
    if (at >= 0) indexes.push(at)
  }
  if (!indexes.length) return null
  const { vec, dim } = vectors
  const centroid = new Float32Array(dim)
  for (const at of indexes) {
    const base = at * dim
    for (let d = 0; d < dim; d += 1) centroid[d] += vec[base + d]
  }
  let norm = 0
  for (let d = 0; d < dim; d += 1) norm += centroid[d] * centroid[d]
  return { vec: centroid, norm: Math.sqrt(norm) || 1, count: indexes.length }
}

function centroidScore(vectors, at, centroid) {
  const { vec, dim, norms } = vectors
  const base = at * dim
  let dot = 0
  for (let d = 0; d < dim; d += 1) dot += vec[base + d] * centroid.vec[d]
  return dot / ((norms[at] || 1) * centroid.norm)
}

/** 已喜欢视频的共推荐边：越靠前权重越高，同一候选保留最强的来源。 */
function buildAffinity(related, likes) {
  const weights = new Map()
  for (const like of likes) {
    const list = relatedList(related, like)
    const total = list.length
    list.forEach((rid, index) => {
      const vid = typeof rid === 'string' ? rid : rid && rid.vid
      if (!vid || vid === like) return
      const w = total > 1 ? (total - index) / total : 1
      const prev = weights.get(vid)
      if (!prev || w > prev.w) weights.set(vid, { w, source: like })
    })
  }
  return weights
}

function bestLikeSource(itemVid, likes, vectors, affinity) {
  if (vectors) {
    const at = vectorIndex(vectors, itemVid)
    if (at >= 0) {
      let best = null
      let bestScore = -Infinity
      for (const like of likes) {
        const likeAt = vectorIndex(vectors, like)
        if (likeAt < 0) continue
        const score = cosineAt(vectors, at, likeAt)
        if (score > bestScore) {
          bestScore = score
          best = like
        }
      }
      if (best) return best
    }
  }
  const rel = affinity.get(itemVid)
  return rel ? rel.source : likes[0]
}

function publicItem(item, reason) {
  return {
    v: item.v,
    t: item.t,
    c: item.c,
    d: item.d,
    th: item.th,
    p: item.p,
    w: item.w,
    y: item.y,
    s: item.s,
    r: item.r,
    reason,
  }
}

function coldStart({ videos, excluded, playlists, max }) {
  const byId = new Map()
  for (const item of videos) if (item && item.v) byId.set(item.v, item)
  const picked = []
  const used = new Set()
  const playlistTitle = (pl) => pl.titleZh || pl.title || pl.slug || ''
  const playlistIds = (pl) => {
    const ids = []
    if (Array.isArray(pl.cover)) ids.push(...pl.cover)
    if (Array.isArray(pl.videos)) {
      for (const entry of pl.videos) ids.push(entry && (entry.vid || entry.v))
    }
    return ids
  }

  /* 冷启动先给编辑信号：每个播放列表取前两条没看过的视频。 */
  for (const pl of Array.isArray(playlists) ? playlists : []) {
    let taken = 0
    for (const raw of playlistIds(pl)) {
      if (taken >= 2 || picked.length >= max) break
      const vid = String(raw || '')
      const item = byId.get(vid)
      if (!item || excluded.has(vid) || used.has(vid)) continue
      picked.push(
        publicItem(item, {
          kind: 'playlist',
          title: playlistTitle(pl),
          slug: pl.slug || '',
        }),
      )
      used.add(vid)
      taken += 1
    }
    if (picked.length >= max) break
  }

  /* 再用 HN 分数补满：没有播放列表或列表不够长时也能给出稳定推荐。 */
  const ranked = videos
    .filter((item) => item && item.v && !excluded.has(item.v) && !used.has(item.v))
    .sort((a, b) => (Number(b.s) || 0) - (Number(a.s) || 0) || (Number(b.r) || 0) - (Number(a.r) || 0))
  for (const item of ranked) {
    if (picked.length >= max) break
    picked.push(publicItem(item, { kind: 'hn', score: Number(item.s) || 0, recommenders: Number(item.r) || 0 }))
  }
  return picked
}


/* ---------------- 打散与随机插入 ---------------- */

/** 可复现的伪随机：同一个 seed 给出同一次顺序，刷新就换 seed。 */
function makeRandom(seed) {
  let a = (Number(seed) || 1) >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function shuffle(list, rand) {
  const out = list.slice()
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1))
    const tmp = out[i]
    out[i] = out[j]
    out[j] = tmp
  }
  return out
}

/** 两条视频的相似度：同频道最明显，其次共用分类。 */
function overlap(a, b) {
  if (!a || !b) return 0
  let same = 0
  if (a.c && b.c && a.c === b.c) same += 0.6
  const ac = Array.isArray(a.cats) ? a.cats : []
  const bc = Array.isArray(b.cats) ? b.cats : []
  if (ac.length && bc.length) {
    let shared = 0
    for (const id of ac) if (bc.indexOf(id) >= 0) shared += 1
    same += 0.4 * (shared / Math.max(ac.length, bc.length))
  }
  return same
}

/**
 * 从一个候选池里按「和已选内容越像越往后」挑出 count 条。
 * 只在前若干名里随机，既打散主题，又不至于把真正相关的挤掉。
 */
function pickDiverse(pool, count, picked, rand, spread = 8) {
  const out = []
  const rest = pool.slice()
  while (out.length < count && rest.length) {
    const window = rest.slice(0, Math.min(spread, rest.length))
    let bestAt = 0
    let bestScore = -Infinity
    for (let i = 0; i < window.length; i += 1) {
      const entry = window[i]
      let penalty = 0
      for (const chosen of picked.concat(out)) penalty += overlap(entry.item, chosen.item)
      /* 干扰项打破平局，让每次刷新都换一批 */
      const score = -penalty + rand() * 0.35 - i * 0.01
      if (score > bestScore) {
        bestScore = score
        bestAt = i
      }
    }
    out.push(rest.splice(bestAt, 1)[0])
  }
  return out
}

/**
 * 首页前排顺序。
 *
 * 不是因为「多一栏」而存在：它只决定网格里前几格放谁。相关、半相关、
 * 完全无关三种各取一部分，按固定节奏交替插进前排，看起来像随手翻出来的
 * 一屏，而不是同一个主题刷一列。
 */
const MIX = [['related', 5], ['semi', 3], ['wild', 2]]

function interleave(buckets, max, rand) {
  const queues = {
    related: buckets.related.slice(),
    semi: buckets.semi.slice(),
    wild: buckets.wild.slice(),
  }
  /* 每一轮把节奏本身轻微打乱，避免每次刷新都是同一个排列骨架 */
  const pattern = []
  for (const [name, weight] of MIX) for (let i = 0; i < weight; i += 1) pattern.push(name)
  const out = []
  while (out.length < max && (queues.related.length || queues.semi.length || queues.wild.length)) {
    let placed = false
    for (const name of shuffle(pattern, rand)) {
      const queue = queues[name]
      if (!queue.length) continue
      out.push(queue.shift())
      placed = true
      if (out.length >= max) break
    }
    if (!placed) break
  }
  return out
}

function toPublic(entry, likes, byId, vectors, affinity, tier) {
  const source = bestLikeSource(entry.item.v, likes, vectors, affinity)
  const sourceItem = source ? byId.get(source) : null
  return publicItem(entry.item, {
    kind: 'like',
    tier,
    vid: source || likes[0],
    title: sourceItem ? sourceItem.t : '',
  })
}

/**
 * 生成首页前排顺序。
 *
 * @param {object} input
 * @param {Array} input.videos 瘦身后的视频列表
 * @param {string[]} input.likes 已喜欢视频 id
 * @param {string[]} input.seen 已看过视频 id
 * @param {string[]} input.dismissed 点了「不感兴趣」的视频 id
 * @param {Map<string,string[]>|null} input.related 共推荐图
 * @param {object|null} input.vectors embeddings.npy 解析结果
 * @param {number} input.limit 前排条数
 * @param {number} input.seed 刷新用的随机种子
 */
export function recommend(input = {}) {
  const videos = Array.isArray(input.videos) ? input.videos : []
  const related = input.related || null
  const vectors = input.vectors || null
  const max = Math.max(1, Math.min(Number(input.limit) || 12, 24))
  const seed = Number(input.seed) || 1
  const rand = makeRandom(seed)
  const byId = new Map()
  for (const item of videos) if (item && item.v) byId.set(item.v, item)

  const allLikes = normalizeIds(input.likes)
  const likes = allLikes.filter((id) => byId.has(id)).slice(-MAX_LIKES)
  const excluded = new Set(allLikes.concat(normalizeIds(input.seen), normalizeIds(input.dismissed)))

  /* 冷启动没有偏好信号：编辑播放列表与 HN 高分混着抽，同样打散主题 */
  if (!likes.length) {
    const playlistEntries = []
    const seenPlaylist = new Set()
    const playlists = Array.isArray(input.playlists) ? shuffle(input.playlists, rand) : []
    for (const pl of playlists) {
      const ids = []
      if (Array.isArray(pl.cover)) ids.push(...pl.cover)
      if (Array.isArray(pl.videos)) {
        for (const entry of pl.videos) ids.push(entry && (entry.vid || entry.v))
      }
      let taken = 0
      for (const raw of ids) {
        if (taken >= 1) break
        const vid = String(raw || '')
        const item = byId.get(vid)
        if (!item || excluded.has(vid) || seenPlaylist.has(vid)) continue
        seenPlaylist.add(vid)
        playlistEntries.push({
          item,
          score: 1,
          source: { kind: 'playlist', tier: 'playlist', title: pl.titleZh || pl.title || pl.slug || '', slug: pl.slug || '' },
        })
        taken += 1
      }
    }
    const hnPool = videos
      .filter((item) => item && item.v && !excluded.has(item.v) && !seenPlaylist.has(item.v))
      .sort((a, b) => (Number(b.s) || 0) - (Number(a.s) || 0))
      .slice(0, 240)
      .map((item) => ({ item, score: Number(item.s) || 0, source: { kind: 'hn', tier: 'hn', score: Number(item.s) || 0 } }))

    const wantPlaylist = Math.max(1, Math.min(playlistEntries.length, Math.round(max * 0.4)))
    const wantHn = Math.max(1, max - wantPlaylist)
    const pickedPlaylist = pickDiverse(playlistEntries, wantPlaylist, [], rand, 6)
    const pickedHn = pickDiverse(hnPool, wantHn, pickedPlaylist, rand, 10)
    const picked = interleave(
      {
        related: pickedPlaylist.map((e) => publicItem(e.item, e.source)),
        semi: pickedHn.map((e) => publicItem(e.item, e.source)),
        wild: [],
      },
      max,
      rand,
    )
    return {
      mode: 'cold',
      seed,
      items: picked,
      profile: { likes: 0, vectors: !!vectors, playlists: playlists.length },
    }
  }

  const centroid = vectors ? buildCentroid(vectors, likes) : null
  const affinity = buildAffinity(related, likes)
  const scored = []
  for (const item of videos) {
    if (!item || !item.v || excluded.has(item.v)) continue
    let score = 0
    let hasSignal = false
    if (centroid) {
      const at = vectorIndex(vectors, item.v)
      if (at >= 0) {
        score += VECTOR_WEIGHT * ((centroidScore(vectors, at, centroid) + 1) / 2)
        hasSignal = true
      }
    }
    const rel = affinity.get(item.v)
    if (rel) {
      score += (centroid ? RELATED_WEIGHT : 1) * rel.w
      hasSignal = true
    }
    if (!hasSignal) score += (Number(item.s) || 0) / 100000
    scored.push({ item, score })
  }
  scored.sort((a, b) => b.score - a.score || (Number(b.item.s) || 0) - (Number(a.item.s) || 0))

  /* 三段：相关（前 45%）、半相关（中间）、完全无关（尾部随机） */
  const cutRelated = Math.max(1, Math.round(scored.length * 0.45))
  const cutSemi = Math.max(cutRelated + 1, Math.round(scored.length * 0.8))
  const nearBand = scored.slice(0, cutRelated)
  const semiBand = scored.slice(cutRelated, cutSemi)
  const wildBand = scored.slice(cutSemi)

  const wantRelated = Math.max(1, Math.round(max * 0.5))
  const wantSemi = Math.max(1, Math.round(max * 0.3))
  const wantWild = Math.max(1, max - wantRelated - wantSemi)

  const relatedPick = pickDiverse(nearBand, wantRelated, [], rand, 8)
  const semiPick = pickDiverse(semiBand, wantSemi, relatedPick, rand, 10)
  const wildPick = pickDiverse(shuffle(wildBand, rand), wantWild, relatedPick.concat(semiPick), rand, 12)

  const ordered = interleave(
    {
      related: relatedPick.map((e) => toPublic(e, likes, byId, vectors, affinity, 'related')),
      semi: semiPick.map((e) => toPublic(e, likes, byId, vectors, affinity, 'semi')),
      wild: wildPick.map((e) => toPublic(e, likes, byId, vectors, affinity, 'wild')),
    },
    max,
    rand,
  )

  return {
    mode: 'likes',
    seed,
    items: ordered,
    profile: { likes: likes.length, vectors: !!vectors },
  }
}
