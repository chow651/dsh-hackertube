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

/**
 * 生成首页推荐行。
 *
 * @param {object} input
 * @param {Array} input.videos 瘦身后的视频列表
 * @param {string[]} input.likes 已喜欢视频 id
 * @param {string[]} input.seen 已看过视频 id
 * @param {string[]} input.dismissed 点了「不感兴趣」的视频 id
 * @param {Map<string,string[]>|null} input.related 共推荐图
 * @param {object|null} input.vectors embeddings.npy 解析结果
 * @param {Array} input.playlists 站点策划播放列表（冷启动用）
 * @param {number} input.limit 返回条数上限
 */
export function recommend(input = {}) {
  const videos = Array.isArray(input.videos) ? input.videos : []
  const related = input.related || null
  const vectors = input.vectors || null
  const max = Math.max(1, Math.min(Number(input.limit) || 12, 24))
  const byId = new Map()
  for (const item of videos) if (item && item.v) byId.set(item.v, item)

  const allLikes = normalizeIds(input.likes)
  const likes = allLikes.filter((id) => byId.has(id)).slice(-MAX_LIKES)
  const excluded = new Set(allLikes.concat(normalizeIds(input.seen), normalizeIds(input.dismissed)))

  if (!likes.length) {
    return {
      mode: 'cold',
      items: coldStart({ videos, excluded, playlists: input.playlists, max }),
      profile: { likes: 0, vectors: !!vectors, playlists: Array.isArray(input.playlists) ? input.playlists.length : 0 },
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
      /* 没有向量时才让共推荐图单独决定排序 */
      score += (centroid ? RELATED_WEIGHT : 1) * rel.w
      hasSignal = true
    }
    /* 两条信号都没有时用 HN 分数兜底，只做微弱排序，不改变相关性 */
    if (!hasSignal) score += (Number(item.s) || 0) / 100000
    scored.push({ item, score })
  }
  scored.sort(
    (a, b) => b.score - a.score || (Number(b.item.s) || 0) - (Number(a.item.s) || 0),
  )

  const picked = []
  const pickedIds = new Set()
  const perSource = new Map()
  const pushEntry = (entry) => {
    const source = bestLikeSource(entry.item.v, likes, vectors, affinity)
    const sourceItem = source ? byId.get(source) : null
    picked.push(
      publicItem(entry.item, {
        kind: 'like',
        vid: source || likes[0],
        title: sourceItem ? sourceItem.t : '',
      }),
    )
    pickedIds.add(entry.item.v)
  }
  /* 第一轮按来源分散；只有一个 like 时这一轮会很少，第二轮补满整行。 */
  for (const entry of scored) {
    if (picked.length >= max) break
    const source = bestLikeSource(entry.item.v, likes, vectors, affinity)
    const used = perSource.get(source) || 0
    if (source && used >= MAX_PER_SOURCE) continue
    if (source) perSource.set(source, used + 1)
    pushEntry(entry)
  }
  if (picked.length < max) {
    for (const entry of scored) {
      if (picked.length >= max) break
      if (pickedIds.has(entry.item.v)) continue
      pushEntry(entry)
    }
  }

  return {
    mode: 'likes',
    items: picked,
    profile: { likes: likes.length, vectors: !!vectors, playlists: Array.isArray(input.playlists) ? input.playlists.length : 0 },
  }
}
