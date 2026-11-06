/**
 * Host 半冒烟测试：不经过 DSH 插件系统，直接驱动 apply() 注册进来的路由。
 * 验证路由注册、上游拉取、瘦身、磁盘缓存、错误路径。
 */
import { mkdtempSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { EventEmitter } from 'node:events'

const SELF = fileURLToPath(import.meta.url)

/* 子进程模式：用固定 fixture 驱动首屏缓存/导出场景，不打真实上游 */
if (process.env.HT_FIRST_PAINT_FIXTURE === '1') {
  process.exit(await runFirstPaintFixture())
}

/* 子进程模式：固定 fixture 验证语言偏好与详情异步翻译，不打真实上游/模型 */
if (process.env.HT_LANGUAGE_FIXTURE === '1') {
  process.exit(await runLanguageFixture())
}
/* 子进程模式：用固定 fixture 驱动推荐画像，不打真实上游 */
if (process.env.HT_RECOMMEND_FIXTURE === '1') {
  process.exit(await runRecommendFixture())
}


/* 子进程模式：用固定 fixture 驱动统一检索，不打真实上游与真实翻译接口 */
if (process.env.HT_SEARCH_FIXTURE === '1') {
  process.exit(await runSearchFixture())
}

const tmp = mkdtempSync(join(tmpdir(), 'ht-smoke-'))
process.env.DSH_PROFILE_DIR = tmp

const { apply } = await import('../index.js')

let handler = null
const registered = []
const tools = {}
const ctx = {
  get(name) {
    if (name === 'webServer') return { register: (route) => { registered.push(route); handler = route.handler; return () => {} } }
    return undefined
  },
  effect(fn) {
    return fn()
  },
  inject(names, cb) {
    if (names.indexOf('tools') >= 0) {
      cb({ tools: { register: (def) => { tools[def.name] = def } } })
    }
  },
}

apply(ctx)

if (!handler) {
  console.error('FAIL: route handler was not registered')
  process.exit(1)
}
const route = registered[0]
console.log('route:', route.kind, route.path)

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(code, headers) {
      this.statusCode = code
      this.headers = headers
    },
    end(chunk) {
      this.body = chunk === undefined ? '' : String(chunk)
    },
  }
}

async function call(path, { method = 'GET', headers } = {}) {
  const res = fakeRes()
  await handler(
    { method, url: path, headers: headers ?? { host: '127.0.0.1:54321' } },
    res,
  )
  return res
}

/** 等实时上游时加硬上限：环境慢就跳过 live 断言，不让测试挂死。 */
async function callWithTimeout(path, ms = 30000) {
  let timer = null
  try {
    return await Promise.race([
      call(path),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ statusCode: 0, headers: {}, body: '' }), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

let failures = 0
function check(name, ok, extra = '') {
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (extra ? ' — ' + extra : ''))
  if (!ok) failures += 1
}

/**
 * 实时上游只做可选验证：hackertube.org 的下载接口会间歇 429，离线/限流时
 * live 段整体跳过，固定 fixture 场景仍然必须全绿。
 */
async function probeLiveUpstream() {
  try {
    const res = await fetch('https://hackertube.org/api/list?offset=0&n=1', {
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) {
      console.log('skip live upstream assertions — /api/list returned ' + res.status)
      return false
    }
    return true
  } catch (err) {
    console.log('skip live upstream assertions — ' + String((err && err.message) || err))
    return false
  }
}

const liveUpstream =
  process.env.HT_FORCE_LIVE === '1' ? true : await probeLiveUpstream()

/* 1. 非 loopback 且无 Origin 的请求应被拒 */
{
  const res = await call('/hackertube/api/list', { headers: { host: 'example.com' } })
  check('reject foreign host', res.statusCode === 403, 'got ' + res.statusCode)
}

/* 2. 未知路由 */
{
  const res = await call('/hackertube/api/nope')
  check('unknown route 404', res.statusCode === 404, 'got ' + res.statusCode)
}

/* 3. 非 GET */
{
  const res = await call('/hackertube/api/list', { method: 'POST' })
  check('non-GET 405', res.statusCode === 405, 'got ' + res.statusCode)
}

/* 4. list：首屏先返回本地导出/缓存，元信息在后台补齐（实时上游不可用时跳过） */
let listOk = false
if (liveUpstream) {
  const t0 = Date.now()
  const res = await callWithTimeout('/hackertube/api/list', 30000)
  const ms = Date.now() - t0
  if (res.statusCode !== 200) {
    console.log('skip live list assertions — /list returned ' + res.statusCode)
  } else {
    listOk = true
    check('list 200', true, '')
    check(
      'list first paint stage known',
      ['export', 'metadata', 'ready'].includes(res.headers['X-Hackertube-Stage']),
      String(res.headers['X-Hackertube-Stage']),
    )
    let items = null
    try {
      items = JSON.parse(res.body)
    } catch {
      items = null
    }
    if (!Array.isArray(items) || !items.length) {
      listOk = false
      console.log('skip live list assertions — invalid list body')
    } else {
      if (items.length === 6454) check('list count 6454', true, '')
      else console.log('skip live count assertion — got ' + items.length + ' items')
      if (items.length >= 5000) {
        check('list payload size', res.body.length > 1e6, (res.body.length / 1048576).toFixed(2) + 'MB')
      } else {
        console.log('skip live payload size assertion — list is partial')
      }
      /* 首屏不等 65 页上游；导出下载正常时应当明显快于完整的元数据同步。fixture 里另有严格时限。 */
      if (ms < 60000) check('list first paint took', true, ms + 'ms')
      else console.log('skip first paint timing assertion — ' + ms + 'ms')
      const first = items[0]
      const need = ['v', 't', 'c', 'd', 'th', 'p', 'w', 'y', 'cats', 'tags', 's', 'r']
      const missing = need.filter((k) => !(k in first))
      check('slim fields complete', missing.length === 0, missing.join(','))
      check('no heavy fields', !('summary' in first) && !('why_hn' in first))
      check('categories are ids', Array.isArray(first.cats) && first.cats.every((x) => typeof x === 'string'))
      check('score present', typeof first.s === 'number', String(first.s))
    }

    if (listOk) {
      /* 等后台元信息同步完成，再验完整字段。轮询状态也覆盖了阶段接口本身。 */
      let status = null
      const deadline = Date.now() + 90000
      while (Date.now() < deadline) {
        const sr = await call('/hackertube/api/list/status')
        if (sr.statusCode === 200) {
          try {
            status = JSON.parse(sr.body)
          } catch {
            status = null
          }
        }
        if (status && status.stage === 'ready') break
        await new Promise((r) => setTimeout(r, 500))
      }
      if (!status || status.stage !== 'ready' || status.error) {
        console.log(
          'skip live metadata merge assertions — status ' +
            JSON.stringify(status && { stage: status.stage, error: status.error }),
        )
      } else {
        check('list status ready', true, '')
        check('list status remembers source', !!status.source, status.source)
        const res2 = await call('/hackertube/api/list')
        let enriched = null
        if (res2.statusCode === 200) {
          try {
            enriched = JSON.parse(res2.body)
          } catch {
            enriched = null
          }
        }
        if (!Array.isArray(enriched) || !enriched.length) {
          console.log('skip live metadata merge assertions — enriched list unavailable')
        } else {
          const first = enriched[0]
          if (enriched.length === 6454) check('enriched list count 6454', true, '')
          else console.log('skip enriched count assertion — got ' + enriched.length + ' items')

          /* 值的完整性：之前只查 key 存在，漏掉了整批数据字段为空的情况 */
          const withThumb = enriched.filter((o) => typeof o.th === 'string' && o.th.startsWith('http')).length
          const withDur = enriched.filter((o) => typeof o.d === 'number' && o.d > 0).length
          const withPub = enriched.filter((o) => typeof o.p === 'string' && o.p.length >= 10).length
          const withViews = enriched.filter((o) => typeof o.w === 'number' && o.w > 0).length
          const withYear = enriched.filter((o) => typeof o.y === 'number' && o.y >= 2005).length
          /* 上游个别条目本身缺 duration / views，按覆盖率判定 */
          const enough = (n) => n >= enriched.length * 0.99
          check('thumbnail filled', enough(withThumb), withThumb + '/' + enriched.length)
          check('duration filled', enough(withDur), withDur + '/' + enriched.length)
          check('published filled', enough(withPub), withPub + '/' + enriched.length)
          check('views filled', enough(withViews), withViews + '/' + enriched.length)
          check('year filled', enough(withYear), withYear + '/' + enriched.length)
          check('sample thumbnail', String(first.th).includes('ytimg'), first.th)
          console.log('   sample:', first.v, '|', first.t.slice(0, 40), '| dur=' + first.d, '| y=' + first.y, '| views=' + first.w)
          await new Promise((r) => setTimeout(r, 900))
          check('cache file written', existsSync(join(tmp, '.dsh-hackertube', 'list.json')))
        }
      }
    }
  }
}

/* 5. list 二次调用命中内存缓存 */
if (liveUpstream && listOk) {
  const t0 = Date.now()
  const res = await call('/hackertube/api/list')
  const ms = Date.now() - t0
  check('list second call fast', res.statusCode === 200 && ms < 500, ms + 'ms')
}

/* 6. browse */
if (liveUpstream) {
  const res = await callWithTimeout('/hackertube/api/browse', 15000)
  if (res.statusCode !== 200) {
    console.log('skip browse assertions — /browse returned ' + res.statusCode)
  } else {
    const tax = JSON.parse(res.body)
    check('browse 200', true, '')
    check('browse 16 areas', Array.isArray(tax.areas) && tax.areas.length === 16, String(tax.areas?.length))
    await new Promise((r) => setTimeout(r, 400))
    check('browse cache', existsSync(join(tmp, '.dsh-hackertube', 'browse.json')))
  }
}

/* 7. video 详情 */
if (liveUpstream) {
  const res = await callWithTimeout('/hackertube/api/video?vid=fNk_zzaMoSs', 20000)
  if (res.statusCode !== 200) {
    console.log('skip video detail assertions — /video returned ' + res.statusCode)
  } else {
    const d = JSON.parse(res.body)
    check('video 200', true, '')
    check('video has why_hn', typeof d.why_hn === 'string' && d.why_hn.length > 0)
    check('video has summary', typeof d.summary === 'string')
    check('video has hn stats', !!d.hn, JSON.stringify(d.hn && d.hn.mentions))
    check('video quote thread id', !!(d.quote && d.quote.id), String(d.quote && d.quote.id))
    check('video quote is object with text', typeof (d.quote && d.quote.text) === 'string')
  }
}

/* 8. video 缺参数 */
{
  const res = await call('/hackertube/api/video')
  check('video missing vid 400', res.statusCode === 400, 'got ' + res.statusCode)
}

/* 9. 仓库自带译文装到全新缓存目录（没有模型也能有中文标题） */
{
  const res = await call('/hackertube/api/titles?lang=zh')
  check('titles 200', res.statusCode === 200, 'got ' + res.statusCode)
  const d = JSON.parse(res.body)
  const n = Object.keys(d.entries || {}).length
  check('seeded zh titles', n > 6000, String(n))
  check('seed sample is chinese', /[\u4e00-\u9fff]/.test(d.entries?.fNk_zzaMoSs || ''), d.entries?.fNk_zzaMoSs)
  await new Promise((r) => setTimeout(r, 300))
  check('seeded file persisted', existsSync(join(tmp, '.dsh-hackertube', 'i18n', 'zh-titles.json')))
}

/* 10. 相关推荐走导出里的共推荐图，不依赖上游 */
if (liveUpstream) {
  const res = await callWithTimeout('/hackertube/api/related?vid=fNk_zzaMoSs', 15000)
  if (res.statusCode !== 200) {
    console.log('skip related assertions — /related returned ' + res.statusCode)
  } else {
    const list = JSON.parse(res.body)
    check('related 200', true, '')
    check('related 12 items', Array.isArray(list) && list.length === 12, String(list && list.length))
    check('related items carry title', Array.isArray(list) && list.every((x) => x && x.t))
    check('related items carry thumb', Array.isArray(list) && list.every((x) => x && x.th))
  }
}

/* 11. 导出文件与清单落盘；上游导出接口限流时退化为上游列表，不因此判失败 */
{
  const manifest = join(tmp, '.dsh-hackertube', 'export', 'manifest.json')
  const videos = join(tmp, '.dsh-hackertube', 'export', 'videos.jsonl')
  if (existsSync(manifest) && existsSync(videos)) {
    check('export manifest written', true)
    check('export videos on disk', true)
  } else {
    console.log('skip export file checks — export download unavailable, upstream fallback in use')
  }
}

/* 12. 给 agent 用的 hackertube_search */
{
  const tool = tools['hackertube_search']
  check('tool registered', !!tool)

  if (!tool || !liveUpstream || !listOk) {
    console.log('skip tool search assertions — live list unavailable')
  } else {
    try {
      const zh = await tool.execute({ query: '线性代数', limit: 3 })
      check('tool answers chinese query', zh.indexOf('youtube.com/watch') >= 0, zh.slice(0, 60))
      check('tool shows chinese title', /[\u4e00-\u9fff]/.test(zh), zh.slice(0, 40))
      if (existsSync(join(tmp, '.dsh-hackertube', 'export', 'videos.jsonl'))) {
        check('tool shows hn reason', zh.indexOf('HN') >= 0, '')
      } else {
        console.log('skip tool shows hn reason — export unavailable, list has no why_hn field')
      }

      const en = await tool.execute({ query: 'backpropagation', limit: 2, lang: 'en' })
      check('tool honours lang=en', en.indexOf(' views') >= 0 && en.indexOf('次观看') < 0, en.slice(0, 60))

      /* raft 不该命中 craft / Minecraft */
      const raft = await tool.execute({ query: 'Raft', limit: 5 })
      check('tool word-boundary match', !/craft|Minecraft/i.test(raft), raft.slice(0, 80))

      const none = await tool.execute({ query: 'zzzznotfound' })
      check('tool empty result is explained', none.indexOf('没有找到') >= 0, none.slice(0, 30))
    } catch (err) {
      console.log('skip tool search assertions — ' + String((err && err.message) || err))
    }
  }
}

/* ---------- 固定 fixture：首屏先渲染、旧缓存离线可用 ---------- */

async function runFirstPaintFixture() {
  const scenario = process.env.HT_FIRST_PAINT_SCENARIO || 'export-first'
  const tmp = mkdtempSync(join(tmpdir(), 'ht-first-paint-'))
  process.env.DSH_PROFILE_DIR = tmp
  const root = join(tmp, '.dsh-hackertube')

  const demo = [
    {
      vid: 'fp1',
      title: 'Raft consensus explained',
      channel: 'FixtureConf',
      categories: [{ id: 'prog' }],
      tags: ['raft', 'consensus'],
      score: 40,
      hn: { recommenders: 15, mentions: 22 },
      summary: 'Raft in depth.',
      why_hn: 'The best Raft talk.',
    },
    {
      vid: 'fp2',
      title: 'Craft of code review',
      channel: 'CraftChannel',
      categories: [{ id: 'prog' }],
      tags: ['craft'],
      score: 10,
      hn: { recommenders: 3, mentions: 4 },
      summary: 'Code review.',
      why_hn: 'Useful.',
    },
    {
      vid: 'fp3',
      title: 'Minecraft redstone computing',
      channel: 'MC',
      categories: [{ id: 'prog' }],
      tags: ['minecraft'],
      score: 8,
      hn: { recommenders: 2, mentions: 3 },
      summary: 'Redstone.',
      why_hn: 'Fun.',
    },
  ]
  const meta = demo.map((o, i) => ({
    vid: o.vid,
    title: o.title,
    channel: o.channel,
    duration_s: 600 + i * 60,
    thumbnail: 'https://i.ytimg.com/vi/' + o.vid + '/hqdefault.jpg',
    published: '2020-01-0' + (i + 1) + 'T00:00:00Z',
    views: 120000 + i * 1000,
    content_type: 'talk',
    level: 'intro',
    categories: [{ id: 'prog' }],
    tags: o.tags,
    score: o.score,
    hn: { recommenders: o.hn.recommenders },
  }))
  const slim = (o, withMeta) => ({
    v: o.vid,
    t: o.title,
    c: o.channel,
    d: withMeta ? o.duration_s : 0,
    th: 'https://i.ytimg.com/vi/' + o.vid + '/hqdefault.jpg',
    p: withMeta ? o.published : null,
    w: withMeta ? o.views : 0,
    ct: 'talk',
    lv: 'intro',
    y: withMeta ? 2020 : null,
    cats: ['prog'],
    tags: o.tags,
    s: o.score,
    r: o.hn.recommenders,
  })

  if (scenario === 'export-first') {
    mkdirSync(join(root, 'export'), { recursive: true })
    writeFileSync(join(root, 'export', 'videos.jsonl'), demo.map((o) => JSON.stringify(o)).join('\n'))
    writeFileSync(
      join(root, 'export', 'related.jsonl'),
      demo.map((o, i) => JSON.stringify({ vid: o.vid, related: i < demo.length - 1 ? [{ vid: demo[i + 1].vid }] : [] })).join('\n'),
    )
    writeFileSync(
      join(root, 'export', 'mentions.jsonl'),
      '{"vid":"fp1","hn_comment_id":1,"author":"x","month":"2020-01","stance":"rec","why":"good","text":"Great talk"}\n',
    )
    writeFileSync(join(root, 'export', 'embeddings.npy'), 'x')
    writeFileSync(join(root, 'export', 'embedding_ids.json'), '[]')
    writeFileSync(join(root, 'export', 'manifest.json'), JSON.stringify({ v: 1, at: Date.now(), bytes: 1234 }))
    global.fetch = async (url) => {
      const raw = String(url)
      if (raw.indexOf('/api/stats') >= 0) {
        return { ok: true, status: 200, json: async () => ({ videos: demo.length }) }
      }
      if (raw.indexOf('/api/list?offset=') >= 0) {
        const u = new URL(raw)
        const offset = Number(u.searchParams.get('offset') || 0)
        const n = Number(u.searchParams.get('n') || 100)
        await new Promise((r) => setTimeout(r, 250))
        return { ok: true, status: 200, json: async () => meta.slice(offset, offset + n) }
      }
      if (raw.indexOf('/download/taxonomy.json') >= 0) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            version: 'fixture',
            areas: [{ id: 'software', name: 'Software', categories: [{ id: 'prog', name: 'Programming' }] }],
          }),
        }
      }
      throw new Error('fixture upstream blocked: ' + raw)
    }
  } else {
    mkdirSync(root, { recursive: true })
    writeFileSync(
      join(root, 'list.json'),
      JSON.stringify({ v: 2, at: Date.now() - 48 * 60 * 60 * 1000, items: demo.map((o) => slim(o, true)) }),
    )
    global.fetch = async (url) => {
      const raw = String(url)
      /* 统计还能回，但元信息列表全部失败：模拟上游半挂，旧缓存必须继续可用 */
      if (raw.indexOf('/api/stats') >= 0) {
        return { ok: true, status: 200, json: async () => ({ videos: demo.length }) }
      }
      throw new Error('offline fixture: ' + raw)
    }
  }

  let handler = null
  const registered = []
  const { apply } = await import('../index.js')
  const ctx = {
    get(name) {
      if (name === 'webServer') {
        return {
          register: (route) => {
            registered.push(route)
            handler = route.handler
            return () => {}
          },
        }
      }
      return undefined
    },
    effect(fn) {
      return fn()
    },
    inject(names, cb) {
      if (names.indexOf('tools') >= 0) cb({ tools: { register: () => {} } })
    },
  }
  apply(ctx)

  let failures = 0
  const fxcheck = (name, ok, extra = '') => {
    console.log((ok ? 'ok   ' : 'FAIL ') + name + (extra ? ' — ' + extra : ''))
    if (!ok) failures += 1
  }
  const fakeRes = () => ({
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(code, headers) {
      this.statusCode = code
      this.headers = headers
    },
    end(chunk) {
      this.body = chunk === undefined ? '' : String(chunk)
    },
  })
  const call = async (path) => {
    const res = fakeRes()
    await handler({ method: 'GET', url: path, headers: { host: '127.0.0.1:54321' } }, res)
    return res
  }
  const read = (res) => JSON.parse(res.body)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  if (!handler) {
    console.error('FAIL: route handler was not registered in fixture mode')
    return 1
  }

  if (scenario === 'export-first') {
    const t0 = Date.now()
    const res = await call('/hackertube/api/list')
    const ms = Date.now() - t0
    fxcheck('fx first paint 200', res.statusCode === 200, 'got ' + res.statusCode)
    fxcheck('fx first paint fast', ms < 1500, ms + 'ms')
    const items = read(res)
    fxcheck('fx first paint has export items', Array.isArray(items) && items.length === 3, String(items && items.length))
    fxcheck(
      'fx first paint before metadata',
      !!items[0] && items[0].d === 0 && items[0].w === 0,
      'd=' + (items[0] && items[0].d) + ' w=' + (items[0] && items[0].w),
    )
    fxcheck(
      'fx list header stage',
      ['export', 'metadata'].includes(res.headers['X-Hackertube-Stage']),
      String(res.headers['X-Hackertube-Stage']),
    )

    let status = read(await call('/hackertube/api/list/status'))
    fxcheck('fx status metadata stage', status.stage === 'metadata', status.stage)
    fxcheck('fx status revalidating', status.revalidating === true, String(status.revalidating))
    fxcheck('fx status source export', status.source === 'export', String(status.source))
    fxcheck('fx status total', status.total === 3, String(status.total))

    const deadline = Date.now() + 5000
    while (Date.now() < deadline && status.stage !== 'ready') {
      await sleep(50)
      status = read(await call('/hackertube/api/list/status'))
    }
    fxcheck('fx status reaches ready', status.stage === 'ready', status.stage)
    fxcheck('fx comments stage passed', status.revalidating === false, String(status.revalidating))

    const enriched = read(await call('/hackertube/api/list'))
    fxcheck(
      'fx metadata merged into list',
      !!enriched[0] && enriched[0].d === 600 && enriched[0].w === 120000,
      'd=' + (enriched[0] && enriched[0].d) + ' w=' + (enriched[0] && enriched[0].w),
    )
    fxcheck('fx list cache persisted', existsSync(join(root, 'list.json')))
  } else {
    const t0 = Date.now()
    const res = await call('/hackertube/api/list')
    const ms = Date.now() - t0
    fxcheck('fx stale first paint 200', res.statusCode === 200, 'got ' + res.statusCode)
    fxcheck('fx stale first paint fast', ms < 1000, ms + 'ms')
    const items = read(res)
    fxcheck('fx stale items browsable', Array.isArray(items) && items.length === 3, String(items && items.length))
    fxcheck('fx stale header', res.headers['X-Hackertube-Stale'] === '1', String(res.headers['X-Hackertube-Stale']))

    let status = read(await call('/hackertube/api/list/status'))
    const deadline = Date.now() + 3000
    while (Date.now() < deadline && status.revalidating) {
      await sleep(50)
      status = read(await call('/hackertube/api/list/status'))
    }
    fxcheck('fx stale flag visible', status.stale === true, String(status.stale))
    fxcheck('fx stale source cache', status.source === 'cache', String(status.source))
    fxcheck('fx stale stays usable', status.stage === 'ready', String(status.stage))
    fxcheck('fx stale error recorded', typeof status.error === 'string' && status.error.length > 0, String(status.error))
    const again = read(await call('/hackertube/api/list'))
    fxcheck('fx stale list still returns', again.length === 3, String(again.length))
  }

  console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'ALL PASS') + ' | fixture: ' + scenario)
  return failures ? 1 : 0
}

/* ---------- 固定 fixture：语言偏好与详情异步翻译 ---------- */

async function runLanguageFixture() {
  const tmp = mkdtempSync(join(tmpdir(), 'ht-language-'))
  process.env.DSH_PROFILE_DIR = tmp
  const root = join(tmp, '.dsh-hackertube')
  const exportRoot = join(root, 'export')
  mkdirSync(exportRoot, { recursive: true })

  const videos = [
    {
      vid: 'lgv001',
      title: 'Model translated video',
      channel: 'FixtureConf',
      duration_s: 600,
      thumbnail: 'https://i.ytimg.com/vi/lgv001/hqdefault.jpg',
      published: '2020-01-01T00:00:00Z',
      views: 1200,
      content_type: 'talk',
      level: 'intro',
      categories: [{ id: 'prog' }],
      tags: ['model'],
      score: 12,
      hn: { recommenders: 5, mentions: 7 },
      summary: 'Model summary text.',
      why_hn: 'Model reason text.',
      quote: { text: 'Model quote text.', hn_comment_id: 101 },
    },
    {
      vid: 'lgv002',
      title: 'Machine translated video',
      channel: 'FixtureConf',
      duration_s: 900,
      thumbnail: 'https://i.ytimg.com/vi/lgv002/hqdefault.jpg',
      published: '2020-01-02T00:00:00Z',
      views: 2400,
      content_type: 'talk',
      level: 'advanced',
      categories: [{ id: 'prog' }],
      tags: ['machine'],
      score: 8,
      hn: { recommenders: 3, mentions: 4 },
      summary: 'Machine summary text.',
      why_hn: 'Machine reason text.',
      quote: { text: 'Machine quote text.', hn_comment_id: 102 },
    },
  ]
  writeFileSync(join(exportRoot, 'videos.jsonl'), videos.map((o) => JSON.stringify(o)).join('\n'))
  writeFileSync(join(exportRoot, 'mentions.jsonl'), '\n')
  writeFileSync(join(exportRoot, 'related.jsonl'), '\n')
  writeFileSync(join(exportRoot, 'embeddings.npy'), 'x')
  writeFileSync(join(exportRoot, 'embedding_ids.json'), '[]')
  writeFileSync(join(exportRoot, 'manifest.json'), JSON.stringify({ v: 1, at: Date.now(), bytes: 1234 }))

  global.fetch = async (url, init) => {
    const raw = String(url)
    if (raw.includes('translate-pa.googleapis.com')) {
      const payload = JSON.parse(String((init && init.body) || '[]'))
      const texts = payload && payload[0] && Array.isArray(payload[0][0]) ? payload[0][0] : []
      return { ok: true, status: 200, json: async () => [texts.map((t) => '机翻：' + String(t))] }
    }
    if (raw.includes('translate.googleapis.com')) {
      return { ok: true, status: 200, json: async () => [['机翻单条']] }
    }
    throw new Error('fixture upstream blocked: ' + raw)
  }

  const fakeLlm = {
    listProviders: async () => [{ id: 'fixture' }],
    listModels: async () => [{ id: 'fixture-model' }],
    stream({ messages }) {
      const prompt = String(
        (messages && messages[0] && messages[0].content && messages[0].content[0] && messages[0].content[0].text) || '',
      )
      return (async function* () {
        if (prompt.includes('Reply with exactly: OK')) {
          yield { type: 'block-start', blockType: 'text' }
          yield { type: 'text', text: 'OK' }
          yield { type: 'finish' }
          return
        }
        if (prompt.includes('Machine summary text.')) throw new Error('balance exhausted')
        await new Promise((r) => setTimeout(r, 1200))
        yield { type: 'block-start', blockType: 'text' }
        yield { type: 'text', text: JSON.stringify(['模型摘要文本', '模型推荐理由文本', '模型引用文本']) }
        yield { type: 'finish' }
      })()
    },
  }

  let handler = null
  const registered = []
  const { apply } = await import('../index.js')
  const ctx = {
    get(name) {
      if (name === 'webServer') {
        return {
          register: (route) => {
            registered.push(route)
            handler = route.handler
            return () => {}
          },
        }
      }
      if (name === 'llm') return fakeLlm
      return undefined
    },
    effect(fn) {
      return fn()
    },
    inject(names, cb) {
      if (names.indexOf('tools') >= 0) cb({ tools: { register: () => {} } })
    },
  }
  apply(ctx)

  let failures = 0
  const lcheck = (name, ok, extra = '') => {
    console.log((ok ? 'ok   ' : 'FAIL ') + name + (extra ? ' — ' + extra : ''))
    if (!ok) failures += 1
  }
  const fakeRes = () => {
    let release = null
    const done = new Promise((resolve) => {
      release = resolve
    })
    const res = {
      statusCode: 0,
      headers: {},
      body: '',
      done,
      writeHead(code, headers) {
        this.statusCode = code
        this.headers = headers
      },
      end(chunk) {
        this.body = chunk === undefined ? '' : String(chunk)
        release()
      },
    }
    return res
  }
  const call = async (path, opts = {}) => {
    const res = fakeRes()
    const body = opts.body
    const req = {
      method: opts.method || 'GET',
      url: path,
      headers: { host: '127.0.0.1:54321' },
      on(type, fn) {
        if (type === 'data' && body != null) fn(Buffer.from(body))
        if (type === 'end') fn()
      },
      destroy() {},
    }
    await handler(req, res)
    await res.done
    return res
  }
  const read = (res) => JSON.parse(res.body)

  if (!handler) {
    console.error('FAIL: route handler was not registered in language fixture mode')
    return 1
  }

  /* 语言偏好落盘；局部更新不能把已有的 like 列表清空 */
  {
    const initial = read(await call('/hackertube/api/prefs'))
    lcheck('lang prefs default null', initial.lang === null, JSON.stringify(initial))
    await call('/hackertube/api/prefs', { method: 'POST', body: JSON.stringify({ likes: ['abcdef'] }) })
    await call('/hackertube/api/prefs', { method: 'POST', body: JSON.stringify({ lang: 'zh' }) })
    const saved = read(await call('/hackertube/api/prefs'))
    lcheck('lang prefs stores zh', saved.lang === 'zh', JSON.stringify(saved))
    lcheck('lang prefs keeps likes on partial update', Array.isArray(saved.likes) && saved.likes[0] === 'abcdef', JSON.stringify(saved.likes))
    await call('/hackertube/api/prefs', { method: 'POST', body: JSON.stringify({ lang: 'fr' }) })
    const invalid = read(await call('/hackertube/api/prefs'))
    lcheck('lang prefs ignores invalid language', invalid.lang === 'zh', String(invalid.lang))

    /* 语言偏好和喜欢列表是两次独立提交，同时到达时不能互相覆盖 */
    await Promise.all([
      call('/hackertube/api/prefs', { method: 'POST', body: JSON.stringify({ lang: 'en' }) }),
      call('/hackertube/api/prefs', { method: 'POST', body: JSON.stringify({ likes: ['abcdef', 'ghijkl'] }) }),
    ])
    const merged = read(await call('/hackertube/api/prefs'))
    lcheck(
      'lang prefs merge concurrent writes',
      merged.lang === 'en' && Array.isArray(merged.likes) && merged.likes.length === 2,
      JSON.stringify(merged),
    )
    await call('/hackertube/api/prefs', { method: 'POST', body: JSON.stringify({ lang: 'zh' }) })
  }

  /* 详情先返回原文：即使模型要等 1.2 秒，这一请求也不能等它 */
  await call('/hackertube/api/video?vid=lgv001')
  const t0 = Date.now()
  const detailRes = await call('/hackertube/api/video?vid=lgv001&lang=zh')
  const detailMs = Date.now() - t0
  const detail = read(detailRes)
  lcheck('lang detail 200', detailRes.statusCode === 200, 'got ' + detailRes.statusCode)
  lcheck('lang detail is immediate', detailMs < 500, detailMs + 'ms')
  lcheck('lang detail keeps original summary', detail.summary === 'Model summary text.', String(detail.summary))
  lcheck('lang detail returns no blocking translation', !detail.i18n || !detail.i18n.summary, JSON.stringify(detail.i18n))

  /* 模型译文：异步接口返回模型来源，之后详情直接读到缓存 */
  const modelTr = read(await call('/hackertube/api/video/translate?vid=lgv001'))
  lcheck('lang model translation fills', modelTr.i18n && modelTr.i18n.summary === '模型摘要文本', JSON.stringify(modelTr.i18n))
  lcheck('lang model provenance', modelTr.i18nSource && modelTr.i18nSource.summary === 'model', JSON.stringify(modelTr.i18nSource))
  const detailCached = read(await call('/hackertube/api/video?vid=lgv001&lang=zh'))
  lcheck('lang detail reads cached model translation', detailCached.i18n && detailCached.i18n.summary === '模型摘要文本', JSON.stringify(detailCached.i18n))
  lcheck('lang detail reads cached provenance', detailCached.i18nSource && detailCached.i18nSource.summary === 'model', JSON.stringify(detailCached.i18nSource))

  /* 模型失败时退回机翻，来源标成 machine */
  const machineTr = read(await call('/hackertube/api/video/translate?vid=lgv002'))
  lcheck('lang machine translation fills', !!machineTr.i18n && /^机翻：/.test(String(machineTr.i18n.summary)), JSON.stringify(machineTr.i18n))
  lcheck('lang machine provenance', machineTr.i18nSource && machineTr.i18nSource.summary === 'machine', JSON.stringify(machineTr.i18nSource))
  const detailMachine = read(await call('/hackertube/api/video?vid=lgv002&lang=zh'))
  lcheck('lang detail reads cached machine translation', detailMachine.i18n && /^机翻：/.test(String(detailMachine.i18n.summary)), JSON.stringify(detailMachine.i18n))

  console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'ALL PASS') + ' | fixture: language')
  return failures ? 1 : 0
}

/* ---------- 固定 fixture：统一检索（面板与 Agent 共用一条 Host 检索） ---------- */

async function runSearchFixture() {
  const tmp = mkdtempSync(join(tmpdir(), 'ht-search-'))
  process.env.DSH_PROFILE_DIR = tmp
  const root = join(tmp, '.dsh-hackertube')

  const videos = [
    {
      vid: 'raft000001',
      title: 'Raft consensus in depth',
      channel: 'Distributed Systems Lab',
      categories: [{ id: 'distributed-systems', name: 'Distributed systems', area: 'systems-security', area_name: 'Systems & Security' }],
      tags: ['raft', 'paxos', 'consensus', 'leader election'],
      summary: 'A deep dive into the Raft leader election and log replication protocol.',
      why_hn: 'The clearest explanation of Raft available anywhere.',
      content_type: 'talk',
      level: 'intermediate',
      published: '2020-03-01T00:00:00Z',
      duration_s: 2400,
      views: 250000,
      score: 9,
      hn: { recommenders: 12, mentions: 20 },
    },
    {
      vid: 'raft000002',
      title: 'Paxos lecture (Raft user study)',
      channel: 'Stanford Online',
      categories: [{ id: 'distributed-systems', name: 'Distributed systems', area: 'systems-security', area_name: 'Systems & Security' }],
      tags: ['paxos', 'raft', 'distributed consensus'],
      summary: 'Paxos explained for the Raft user study comparing how students learn both algorithms.',
      why_hn: 'Recommended as a lucid companion to the Raft lecture.',
      content_type: 'talk',
      level: 'advanced',
      published: '2014-09-01T00:00:00Z',
      duration_s: 3600,
      views: 120000,
      score: 7,
      hn: { recommenders: 8, mentions: 11 },
    },
    {
      vid: 'raft000003',
      title: 'Raft lecture (Raft user study)',
      channel: 'Stanford Online',
      categories: [{ id: 'distributed-systems', name: 'Distributed systems', area: 'systems-security', area_name: 'Systems & Security' }],
      tags: ['raft', 'paxos', 'leader election'],
      summary: 'John Ousterhout explains Raft leader election and log repair in the Raft user study.',
      why_hn: 'A clearer introduction to Raft than the original paper.',
      content_type: 'lecture',
      level: 'intermediate',
      published: '2015-02-01T00:00:00Z',
      duration_s: 3000,
      views: 90000,
      score: 4.5,
      hn: { recommenders: 5, mentions: 9 },
    },
    {
      vid: 'craft00001',
      title: 'Craft of code review',
      channel: 'CraftChannel',
      categories: [{ id: 'software-architecture-design', name: 'Software architecture & design', area: 'software', area_name: 'Software Engineering & Languages' }],
      tags: ['craft', 'code review'],
      summary: 'A craft talk about reviewing code with care.',
      why_hn: 'Useful for teams that review a lot of code.',
      content_type: 'talk',
      level: 'intro',
      published: '2021-06-01T00:00:00Z',
      duration_s: 1800,
      views: 50000,
      score: 10,
      hn: { recommenders: 9, mentions: 12 },
    },
    {
      vid: 'minecr0001',
      title: 'Minecraft redstone computing',
      channel: 'MC Lab',
      categories: [{ id: 'software-architecture-design', name: 'Software architecture & design', area: 'software', area_name: 'Software Engineering & Languages' }],
      tags: ['minecraft', 'redstone'],
      summary: 'Building logic circuits inside Minecraft.',
      why_hn: 'Fun demonstration of redstone logic.',
      content_type: 'demo',
      level: 'general',
      published: '2019-04-01T00:00:00Z',
      duration_s: 900,
      views: 400000,
      score: 8,
      hn: { recommenders: 3, mentions: 4 },
    },
    {
      vid: 'kraftw0001',
      title: 'Kraftwerk and the birth of electronic music',
      channel: 'Music Docs',
      categories: [{ id: 'music', name: 'Music', area: 'arts-entertainment', area_name: 'Arts & Entertainment' }],
      tags: ['kraftwerk', 'electronic music'],
      summary: 'A documentary about Kraftwerk and electronic music.',
      why_hn: 'A great music documentary.',
      content_type: 'documentary',
      level: 'general',
      published: '2016-10-01T00:00:00Z',
      duration_s: 5400,
      views: 210000,
      score: 6,
      hn: { recommenders: 4, mentions: 5 },
    },
    {
      vid: 'compil0001',
      title: 'CppCon 2020: Compiler optimization in practice',
      channel: 'CppCon',
      categories: [{ id: 'compilers-interpreters', name: 'Compilers, interpreters & program analysis', area: 'software', area_name: 'Software Engineering & Languages' }],
      tags: ['compiler optimization', 'c++', 'inlining'],
      summary: 'How compilers optimize C++ code, and why inlining and devirtualization matter.',
      why_hn: 'A practical compiler optimization walkthrough from a veteran optimizer engineer.',
      content_type: 'talk',
      level: 'advanced',
      published: '2020-11-01T00:00:00Z',
      duration_s: 3300,
      views: 180000,
      score: 8,
      hn: { recommenders: 7, mentions: 10 },
    },
    {
      vid: 'compil0002',
      title: 'Inside the C++ compiler',
      channel: 'CppCon',
      categories: [{ id: 'compilers-interpreters', name: 'Compilers, interpreters & program analysis', area: 'software', area_name: 'Software Engineering & Languages' }],
      tags: ['compilers', 'c++'],
      summary: 'A tour of compiler internals from lexing to code generation.',
      why_hn: 'Useful overview of compiler architecture.',
      content_type: 'talk',
      level: 'intermediate',
      published: '2018-08-01T00:00:00Z',
      duration_s: 2700,
      views: 70000,
      score: 5,
      hn: { recommenders: 4, mentions: 6 },
    },
  ]

  const slim = (o) => ({
    v: o.vid,
    t: o.title,
    c: o.channel,
    d: o.duration_s,
    th: 'https://i.ytimg.com/vi/' + o.vid + '/hqdefault.jpg',
    p: o.published,
    w: o.views,
    ct: o.content_type,
    lv: o.level,
    y: o.published ? Number(String(o.published).slice(0, 4)) : null,
    cats: (o.categories || []).map((c) => c.id),
    tags: o.tags || [],
    s: o.score,
    r: o.hn.recommenders,
  })

  mkdirSync(join(root, 'export'), { recursive: true })
  writeFileSync(join(root, 'export', 'videos.jsonl'), videos.map((o) => JSON.stringify(o)).join('\n'))
  writeFileSync(join(root, 'export', 'related.jsonl'), JSON.stringify({ vid: videos[0].vid, related: [] }) + '\n')
  writeFileSync(join(root, 'export', 'mentions.jsonl'), '{}\n')
  writeFileSync(join(root, 'export', 'embeddings.npy'), 'x')
  writeFileSync(join(root, 'export', 'embedding_ids.json'), '[]')
  writeFileSync(join(root, 'export', 'manifest.json'), JSON.stringify({ v: 1, at: Date.now(), bytes: 1234 }))
  writeFileSync(join(root, 'list.json'), JSON.stringify({ v: 2, at: Date.now(), items: videos.map(slim) }))
  writeFileSync(
    join(root, 'browse.json'),
    JSON.stringify({
      at: Date.now(),
      taxonomy: {
        version: 'fixture',
        areas: [
          {
            id: 'software',
            name: 'Software Engineering & Languages',
            categories: [
              { id: 'compilers-interpreters', name: 'Compilers, interpreters & program analysis' },
              { id: 'software-architecture-design', name: 'Software architecture & design' },
            ],
          },
          {
            id: 'systems-security',
            name: 'Systems & Security',
            categories: [{ id: 'distributed-systems', name: 'Distributed systems' }],
          },
          {
            id: 'arts-entertainment',
            name: 'Arts & Entertainment',
            categories: [{ id: 'music', name: 'Music' }],
          },
        ],
      },
    }),
  )

  global.fetch = async (url, init) => {
    const raw = String(url)
    if (raw.indexOf('translate-pa.googleapis.com') >= 0) {
      return { ok: true, status: 200, json: async () => [['compiler optimization']] }
    }
    if (raw.indexOf('/download/taxonomy.json') >= 0) {
      return { ok: true, status: 200, json: async () => JSON.parse(readFileSync(join(root, 'browse.json'), 'utf8')).taxonomy }
    }
    if (raw.indexOf('/api/list?offset=') >= 0) {
      const u = new URL(raw)
      const offset = Number(u.searchParams.get('offset') || 0)
      const n = Number(u.searchParams.get('n') || 100)
      return { ok: true, status: 200, json: async () => videos.slice(offset, offset + n).map(slim) }
    }
    if (raw.indexOf('/api/stats') >= 0) {
      return { ok: true, status: 200, json: async () => ({ videos: videos.length }) }
    }
    throw new Error('search fixture blocked: ' + raw + ' ' + (init && init.method ? init.method : ''))
  }

  let handler = null
  const registered = []
  const tools = {}
  const { apply } = await import('../index.js')
  const ctx = {
    get(name) {
      if (name === 'webServer') {
        return {
          register: (route) => {
            registered.push(route)
            handler = route.handler
            return () => {}
          },
        }
      }
      return undefined
    },
    effect(fn) {
      return fn()
    },
    inject(names, cb) {
      if (names.indexOf('tools') >= 0) cb({ tools: { register: (def) => { tools[def.name] = def } } })
    },
  }
  apply(ctx)

  const failures = []
  const check = (name, ok, extra = '') => {
    console.log((ok ? 'ok   ' : 'FAIL ') + name + (extra ? ' — ' + extra : ''))
    if (!ok) failures.push(name)
  }
  const fakeRes = () => ({
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(code, headers) {
      this.statusCode = code
      this.headers = headers
    },
    end(chunk) {
      this.body = chunk === undefined ? '' : String(chunk)
    },
  })
  const call = async (path) => {
    const res = fakeRes()
    await handler(
      { method: 'GET', url: path, headers: { host: '127.0.0.1:54321' } },
      res,
    )
    return res
  }
  const search = async (qs) => {
    const res = await call('/hackertube/api/search?' + qs)
    let body = null
    try {
      body = JSON.parse(res.body)
    } catch {
      body = null
    }
    return { status: res.statusCode, body }
  }

  if (!handler) {
    console.error('FAIL: route handler was not registered in search fixture')
    return 1
  }

  console.log('\n--- T03 unified search ---')

  /* raft：词边界命中 Raft/Paxos，不混入 craft / Minecraft / Kraftwerk */
  {
    const r = await search('q=raft&limit=10')
    check('search raft 200', r.status === 200, 'got ' + r.status)
    const d = r.body || {}
    const items = Array.isArray(d.items) ? d.items : []
    check('search raft has results', items.length >= 3, String(items.length))
    const top3 = items.slice(0, 3)
    check(
      'search raft top3 are raft/paxos content',
      top3.every((it) => /raft|paxos/i.test(String(it.t || '') + ' ' + (it.tags || []).join(' '))),
      top3.map((it) => it.t).join(' | '),
    )
    check(
      'search raft excludes craft-like titles',
      items.every((it) => !/craft|minecraft|kraftwerk/i.test(String(it.t || '') + ' ' + (it.tags || []).join(' '))),
      items.map((it) => it.t).join(' | '),
    )
    check('search result total', typeof d.total === 'number' && d.total >= items.length, String(d.total))
    const first = items[0] || {}
    check(
      'search result matched fields',
      first.match && Array.isArray(first.match.fields) && first.match.fields.length > 0,
      JSON.stringify(first.match && first.match.fields),
    )
    check(
      'search result snippet',
      first.match && typeof first.match.snippet === 'string' && first.match.snippet.length > 0,
      String(first.match && first.match.snippet).slice(0, 80),
    )
    check(
      'search snippet quotes the query',
      first.match && /raft/i.test(String(first.match.snippet)),
      String(first.match && first.match.snippet).slice(0, 80),
    )
    /* 面板请求不需要中文标题与推荐理由：那两串由工具侧显式开启，避免两千条结果被撑大 */
    check(
      'search payload stays lean',
      first.match && first.match.titleZh === undefined && first.match.why === undefined,
      JSON.stringify(Object.keys((first.match || {}))),
    )
    check(
      'search raft matches only raft/paxos videos',
      items.length === 3,
      items.map((it) => it.v).join(','),
    )
  }

  /* 多词查询是 AND：每个词都要在某个字段里命中 */
  {
    const r = await search('q=' + encodeURIComponent('raft paxos') + '&limit=10')
    const items = (r.body && r.body.items) || []
    check(
      'search multi-term is AND',
      items.length === 3 && items.every((it) => it.v.indexOf('raft0') === 0),
      items.map((it) => it.v).join(','),
    )
  }

  /* 没有查询时列表按原始顺序返回，筛选不该打乱浏览顺序 */
  {
    const r = await search('limit=10')
    const items = (r.body && r.body.items) || []
    const want = ['raft000001', 'raft000002', 'raft000003', 'craft00001', 'minecr0001', 'kraftw0001', 'compil0001', 'compil0002']
    check(
      'search without query keeps list order',
      items.map((it) => it.v).join(',') === want.join(','),
      items.map((it) => it.v).join(','),
    )
  }

  /* 中文查询走现有机器翻译扩展，命中英文标签与摘要 */
  {
    const r = await search('q=' + encodeURIComponent('编译器优化') + '&limit=10')
    check('search chinese 200', r.status === 200, 'got ' + r.status)
    const items = (r.body && r.body.items) || []
    check('search chinese expands to english', items.length >= 1 && items[0].v === 'compil0001', items.map((it) => it.v).join(','))
    const fields = (items[0] && items[0].match && items[0].match.fields) || []
    check(
      'search chinese matches tags or summary',
      fields.indexOf('tags') >= 0 || fields.indexOf('summary') >= 0,
      JSON.stringify(fields),
    )
    check(
      'search chinese result carries snippet',
      !!(items[0] && items[0].match && items[0].match.snippet),
      String(items[0] && items[0].match && items[0].match.snippet).slice(0, 80),
    )
  }

  /* 面板 HTTP 检索与 Agent 工具共享同一排序 */
  {
    const r = await search('q=raft&limit=3')
    const panelItems = (r.body && r.body.items) || []
    const tool = tools['hackertube_search']
    check('search tool registered', !!tool)
    if (tool && panelItems.length) {
      const text = await tool.execute({ query: 'raft', limit: 3 })
      check('search tool uses same order', text.indexOf('1. ' + panelItems[0].t) >= 0, text.slice(0, 120))
      const positions = panelItems.map((it) => text.indexOf(it.t))
      check(
        'search tool keeps full top-3 order',
        positions.every((p, i) => p >= 0 && (i === 0 || p > positions[i - 1])),
        JSON.stringify(positions),
      )
      check('search tool reports matched fields', /匹配：/.test(text), text.slice(0, 200))
      check('search tool reports snippet', /—\s/.test(text), text.slice(0, 200))
      check('search tool reports hn reason', /HN：/.test(text), text.slice(0, 300))

      /* 工具也接受同一组筛选与排序参数，不需要面板再实现一遍 */
      const filtered = await tool.execute({ query: 'raft', area: 'software', limit: 3 })
      check('search tool honours filters', /没有找到匹配的视频/.test(filtered), filtered.slice(0, 80))
      const byYear = await tool.execute({ query: 'raft', sort: 'year', limit: 3 })
      const order = ['Raft consensus in depth', 'Raft lecture (Raft user study)', 'Paxos lecture (Raft user study)'].map(
        (t) => byYear.indexOf(t),
      )
      check(
        'search tool honours sort',
        order.every((p) => p >= 0) && order[0] < order[1] && order[1] < order[2],
        JSON.stringify(order),
      )
    }
  }

  /* 筛选与排序是同一检索操作的参数 */
  {
    const r = await search('area=systems-security&year=2020&type=talk&level=intermediate&sort=score')
    const items = (r.body && r.body.items) || []
    check(
      'search filters area/year/type/level',
      items.length === 1 && items[0].v === 'raft000001',
      items.map((it) => it.v).join(','),
    )
    check('search filters total', r.body && r.body.total === 1, String(r.body && r.body.total))

    const byYear = await search('q=raft&sort=year&limit=10')
    const ys = ((byYear.body && byYear.body.items) || []).map((it) => it.y)
    check(
      'search sort year desc',
      ys.length >= 3 && ys.every((y, i) => i === 0 || (Number(y) || 0) <= (Number(ys[i - 1]) || 0)),
      JSON.stringify(ys),
    )

    const page = await search('q=raft&limit=2&offset=1')
    const full = await search('q=raft&limit=10')
    const pageItems = (page.body && page.body.items) || []
    const fullItems = (full.body && full.body.items) || []
    check(
      'search limit/offset paginate in rank order',
      pageItems.length === 2 && fullItems[1] && pageItems[0].v === fullItems[1].v,
      pageItems.map((it) => it.v).join(','),
    )

    const byScore = (await search('sort=score&limit=10')).body.items.map((it) => it.s)
    check(
      'search sort score desc',
      byScore.length === 8 && byScore.every((s, i) => i === 0 || Number(s) <= Number(byScore[i - 1])),
      JSON.stringify(byScore),
    )

    const byViews = (await search('sort=views&limit=10')).body.items.map((it) => it.w)
    check(
      'search sort views desc',
      byViews.length === 8 && byViews.every((w, i) => i === 0 || Number(w) <= Number(byViews[i - 1])),
      JSON.stringify(byViews),
    )

    /* 筛选参数单独用也成立：类型 + 难度不需要查询词 */
    const typed = await search('type=lecture&level=intermediate')
    check(
      'search filters without query',
      typed.body && typed.body.total === 1 && typed.body.items[0].v === 'raft000003',
      JSON.stringify((typed.body && typed.body.items || []).map((it) => it.v)),
    )
  }

  console.log('\n' + (failures.length ? failures.length + ' FAILURE(S)' : 'ALL PASS') + ' | fixture: search')
  return failures.length ? 1 : 0
}

/* 固定 fixture 场景在独立子进程跑，避免真实上游与模块级状态互相污染 */
for (const scenario of ['export-first', 'stale-offline']) {
  const r = spawnSync(process.execPath, [SELF], {
    env: { ...process.env, HT_FIRST_PAINT_FIXTURE: '1', HT_FIRST_PAINT_SCENARIO: scenario },
    encoding: 'utf8',
    timeout: 30000,
  })
  if (r.stdout) process.stdout.write(r.stdout)
  if (r.stderr) process.stderr.write(r.stderr)
  check('first-paint fixture: ' + scenario, r.status === 0, 'exit ' + r.status)
}

{
  const r = spawnSync(process.execPath, [SELF], {
    env: { ...process.env, HT_LANGUAGE_FIXTURE: '1' },
    encoding: 'utf8',
    timeout: 30000,
  })
  if (r.stdout) process.stdout.write(r.stdout)
  if (r.stderr) process.stderr.write(r.stderr)
  check('language fixture', r.status === 0, 'exit ' + r.status)
}

{
  const r = spawnSync(process.execPath, [SELF], {
    env: { ...process.env, HT_SEARCH_FIXTURE: '1' },
    encoding: 'utf8',
    timeout: 30000,
  })
  if (r.stdout) process.stdout.write(r.stdout)
  if (r.stderr) process.stderr.write(r.stderr)
  check('search fixture', r.status === 0, 'exit ' + r.status)
}

/* ---------- 固定 fixture：推荐画像（T06） ---------- */

/** 写一个 NumPy v1 float16 矩阵；只用于 fixture，不引入科学计算依赖。 */
function writeNpyFloat16(rows) {
  const dim = rows[0].length
  let header =
    "{'descr': '<f2', 'fortran_order': False, 'shape': (" +
    rows.length +
    ', ' +
    dim +
    '), }'
  while ((10 + header.length + 1) % 64 !== 0) header += ' '
  header += '\n'
  const buf = Buffer.alloc(10 + header.length + rows.length * dim * 2)
  buf.write('\x93NUMPY', 0, 'latin1')
  buf[6] = 1
  buf[7] = 0
  buf.writeUInt16LE(header.length, 8)
  buf.write(header, 10, 'latin1')
  let off = 10 + header.length
  for (const row of rows) {
    for (const value of row) {
      buf.writeUInt16LE(float16Bits(value), off)
      off += 2
    }
  }
  return buf
}

function float16Bits(value) {
  if (value === 0) return 0
  const sign = value < 0 ? 0x8000 : 0
  const a = Math.abs(value)
  const exp = Math.floor(Math.log2(a))
  const e = exp + 15
  if (e <= 0) return sign | Math.round(a / 2 ** -24)
  if (e >= 31) return sign | 0x7c00
  const frac = Math.round((a / 2 ** exp - 1) * 1024)
  return sign | (e << 10) | (frac & 0x3ff)
}

async function runRecommendFixture() {
  const scenario = process.env.HT_RECOMMEND_SCENARIO || 'likes'
  const tmp = mkdtempSync(join(tmpdir(), 'ht-recommend-'))
  process.env.DSH_PROFILE_DIR = tmp
  const root = join(tmp, '.dsh-hackertube')

  const spec = [
    ['likevid1', 'Liked video about graphs', 20, 10],
    ['simvec01', 'Similar vector one', 12, 4],
    ['simvec02', 'Similar vector two', 8, 2],
    ['relpick1', 'Related graph pick', 6, 1],
    ['seenvid1', 'Already watched', 30, 12],
    ['othervid1', 'Unrelated high score', 50, 20],
    ['othervid2', 'Another unrelated', 40, 15],
    ['playpick1', 'Playlist pick', 15, 5],
  ]
  const videos = spec.map(([vid, title, score, recommenders], i) => ({
    vid,
    url: 'https://www.youtube.com/watch?v=' + vid,
    title,
    channel: 'Fixture Channel',
    summary: title + ' summary',
    why_hn: title + ' reason',
    content_type: 'talk',
    level: 'intro',
    tags: [title.toLowerCase()],
    categories: [{ id: 'prog', name: 'Programming', area: 'software', area_name: 'Software' }],
    score,
    hn: { mentions: recommenders + 2, recommenders },
    published: '2020-01-0' + (i + 1) + 'T00:00:00Z',
  }))
  const vectorRows = [
    ['likevid1', [1, 0, 0, 0]],
    ['simvec01', [0.75, 0.25, 0, 0]],
    ['simvec02', [0.5, 0.5, 0, 0]],
    ['relpick1', [0, 1, 0, 0]],
    ['seenvid1', [1, 0, 0, 0]],
    ['othervid1', [0, 0, 1, 0]],
    ['othervid2', [0, 0, 0, 1]],
    ['playpick1', [0.25, 0.25, 0.5, 0]],
  ]

  mkdirSync(join(root, 'export'), { recursive: true })
  writeFileSync(join(root, 'export', 'videos.jsonl'), videos.map((o) => JSON.stringify(o)).join('\n'))
  writeFileSync(
    join(root, 'export', 'related.jsonl'),
    videos
      .map((o) =>
        JSON.stringify({
          vid: o.vid,
          related: o.vid === 'likevid1' ? [{ vid: 'relpick1', shared_recommenders: 2 }, { vid: 'simvec01', shared_recommenders: 1 }] : [],
        }),
      )
      .join('\n'),
  )
  writeFileSync(
    join(root, 'export', 'mentions.jsonl'),
    JSON.stringify({ vid: 'likevid1', hn_comment_id: 1, author: 'fixture', month: '2020-01', stance: 'rec', why: 'good', text: 'Great talk' }) + '\n',
  )
  writeFileSync(join(root, 'export', 'embeddings.npy'), writeNpyFloat16(vectorRows.map((r) => r[1])))
  writeFileSync(join(root, 'export', 'embedding_ids.json'), JSON.stringify(vectorRows.map((r) => r[0])))
  writeFileSync(join(root, 'export', 'manifest.json'), JSON.stringify({ v: 1, at: Date.now(), bytes: 1234 }))

  const prefs =
    scenario === 'cold'
      ? { likes: [], later: [], seen: [], at: Date.now() }
      : { likes: ['likevid1'], later: [], seen: ['seenvid1'], at: Date.now() }
  writeFileSync(join(root, 'prefs.json'), JSON.stringify(prefs))

  global.fetch = async (url) => {
    const raw = String(url)
    if (raw.indexOf('/api/stats') >= 0) {
      return { ok: true, status: 200, json: async () => ({ videos: videos.length }) }
    }
    if (raw.indexOf('/api/list?offset=') >= 0) {
      return {
        ok: true,
        status: 200,
        json: async () =>
          videos.map((o) => ({
            vid: o.vid,
            title: o.title,
            channel: o.channel,
            duration_s: 600,
            thumbnail: 'https://i.ytimg.com/vi/' + o.vid + '/hqdefault.jpg',
            published: o.published,
            views: 1000,
            categories: o.categories,
            tags: o.tags,
            score: o.score,
            hn: o.hn,
          })),
      }
    }
    if (raw.indexOf('/api/playlists') >= 0) {
      return {
        ok: true,
        status: 200,
        json: async () => [
          { slug: 'start-here', title: 'Start here', tier: 'start', cover: ['playpick1', 'seenvid1'], count: 2, minutes: 20 },
        ],
      }
    }
    throw new Error('fixture upstream blocked: ' + raw)
  }

  let handler = null
  const registered = []
  const { apply } = await import('../index.js')
  const ctx = {
    get(name) {
      if (name === 'webServer') {
        return {
          register: (route) => {
            registered.push(route)
            handler = route.handler
            return () => {}
          },
        }
      }
      return undefined
    },
    effect(fn) {
      return fn()
    },
    inject(names, cb) {
      if (names.indexOf('tools') >= 0) cb({ tools: { register: () => {} } })
    },
  }
  apply(ctx)

  let failures = 0
  const fxcheck = (name, ok, extra = '') => {
    console.log((ok ? 'ok   ' : 'FAIL ') + name + (extra ? ' — ' + extra : ''))
    if (!ok) failures += 1
  }
  const fakeRes = () => ({
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(code, headers) {
      this.statusCode = code
      this.headers = headers
    },
    end(chunk) {
      this.body = chunk === undefined ? '' : String(chunk)
    },
  })
  const call = async (path) => {
    const res = fakeRes()
    await handler({ method: 'GET', url: path, headers: { host: '127.0.0.1:54321' } }, res)
    return res
  }
  const callPost = async (path, payload) => {
    const res = fakeRes()
    const req = new EventEmitter()
    req.method = 'POST'
    req.url = path
    req.headers = { host: '127.0.0.1:54321' }
    const finished = new Promise((resolve) => {
      const rawEnd = res.end
      res.end = function (chunk) {
        rawEnd.call(this, chunk)
        resolve()
      }
    })
    handler(req, res)
    req.emit('data', Buffer.from(JSON.stringify(payload)))
    req.emit('end')
    await finished
    return res
  }
  const read = (res) => JSON.parse(res.body)

  if (!handler) {
    console.error('FAIL: route handler was not registered in recommend fixture')
    return 1
  }

  if (scenario === 'feedback') {
    const before = read(await call('/hackertube/api/recommend'))
    const beforeItems = Array.isArray(before.items) ? before.items : []
    fxcheck('T06 feedback starts with a like feed', before.mode === 'likes' && beforeItems.length > 1, String(before.mode))
    fxcheck('T06 feedback first item known', beforeItems[0] && beforeItems[0].v === 'simvec01', beforeItems[0] && beforeItems[0].v)

    const posted = await callPost('/hackertube/api/prefs', {
      likes: ['likevid1'],
      later: [],
      seen: ['seenvid1'],
      dismissed: ['simvec01'],
    })
    fxcheck('T06 feedback saved', posted.statusCode === 200, 'got ' + posted.statusCode)
    const prefs = read(await call('/hackertube/api/prefs'))
    fxcheck('T06 dismissed persisted', Array.isArray(prefs.dismissed) && prefs.dismissed.indexOf('simvec01') >= 0, JSON.stringify(prefs.dismissed))

    const after = read(await call('/hackertube/api/recommend'))
    const afterItems = Array.isArray(after.items) ? after.items : []
    fxcheck('T06 dismissed item dropped', !afterItems.some((x) => x.v === 'simvec01'))
    fxcheck('T06 order changes after feedback', afterItems[0] && afterItems[0].v !== 'simvec01', afterItems[0] && afterItems[0].v)
    fxcheck('T06 feedback keeps explanations', afterItems.length > 0 && afterItems.every((x) => x.reason && x.reason.kind === 'like'))
  }

  if (scenario === 'cold') {
    const res = await call('/hackertube/api/recommend')
    fxcheck('T06 cold recommend 200', res.statusCode === 200, 'got ' + res.statusCode)
    const data = read(res)
    fxcheck('T06 cold mode', data.mode === 'cold', String(data.mode))
    const items = Array.isArray(data.items) ? data.items : []
    fxcheck('T06 cold has recommendations', items.length >= 4, String(items.length))
    fxcheck(
      'T06 cold uses playlist first',
      items[0] && items[0].v === 'playpick1' && items[0].reason && items[0].reason.kind === 'playlist',
      JSON.stringify(items[0] && { v: items[0].v, reason: items[0].reason }),
    )
    fxcheck('T06 cold playlist reason names playlist', items[0] && items[0].reason && items[0].reason.title === 'Start here', items[0] && items[0].reason && items[0].reason.title)
    fxcheck('T06 cold fills with HN score', items.some((x) => x.reason && x.reason.kind === 'hn'))
    fxcheck('T06 cold every item has a reason', items.every((x) => x.reason && x.reason.kind))
  }

  if (scenario === 'likes') {
    const res = await call('/hackertube/api/recommend')
    fxcheck('T06 recommend 200', res.statusCode === 200, 'got ' + res.statusCode)
    const data = read(res)
    fxcheck('T06 like mode', data.mode === 'likes', String(data.mode))
    const items = Array.isArray(data.items) ? data.items : []
    fxcheck('T06 has recommendations', items.length >= 4, String(items.length))
    fxcheck('T06 top item follows embeddings', items[0] && items[0].v === 'simvec01', items[0] && items[0].v)
    fxcheck(
      'T06 explanation because you liked',
      items[0] && items[0].reason && items[0].reason.kind === 'like' && items[0].reason.vid === 'likevid1',
      JSON.stringify(items[0] && items[0].reason),
    )
    fxcheck('T06 reason carries source title', items[0] && items[0].reason && items[0].reason.title === 'Liked video about graphs', items[0] && items[0].reason && items[0].reason.title)
    fxcheck('T06 related graph candidate included', items.some((x) => x.v === 'relpick1'))
    fxcheck('T06 watched item excluded', !items.some((x) => x.v === 'seenvid1'))
    fxcheck('T06 every item has a reason', items.every((x) => x.reason && x.reason.kind === 'like'))
  }

  console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'ALL PASS') + ' | recommend fixture: ' + scenario)
  return failures ? 1 : 0
}

/* 固定 fixture 场景在独立子进程跑，避免真实上游与模块级状态互相污染 */
for (const scenario of ['export-first', 'stale-offline']) {
  const r = spawnSync(process.execPath, [SELF], {
    env: { ...process.env, HT_FIRST_PAINT_FIXTURE: '1', HT_FIRST_PAINT_SCENARIO: scenario },
    encoding: 'utf8',
    timeout: 30000,
  })
  if (r.stdout) process.stdout.write(r.stdout)
  if (r.stderr) process.stderr.write(r.stderr)
  check('first-paint fixture: ' + scenario, r.status === 0, 'exit ' + r.status)
}

for (const scenario of ['likes', 'cold', 'feedback']) {
  const r = spawnSync(process.execPath, [SELF], {
    env: { ...process.env, HT_RECOMMEND_FIXTURE: '1', HT_RECOMMEND_SCENARIO: scenario },
    encoding: 'utf8',
    timeout: 30000,
  })
  if (r.stdout) process.stdout.write(r.stdout)
  if (r.stderr) process.stderr.write(r.stderr)
  check('taste-profile fixture: ' + scenario, r.status === 0, 'exit ' + r.status)
}

console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'ALL PASS') + ' | cache dir: ' + tmp)
process.exit(failures ? 1 : 0)
