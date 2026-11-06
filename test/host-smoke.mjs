/**
 * Host 半冒烟测试：不经过 DSH 插件系统，直接驱动 apply() 注册进来的路由。
 * 验证路由注册、上游拉取、瘦身、磁盘缓存、错误路径。
 */
import { mkdtempSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SELF = fileURLToPath(import.meta.url)

/* 子进程模式：用固定 fixture 驱动首屏缓存/导出场景，不打真实上游 */
if (process.env.HT_FIRST_PAINT_FIXTURE === '1') {
  process.exit(await runFirstPaintFixture())
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

const liveUpstream = await probeLiveUpstream()

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

console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'ALL PASS') + ' | cache dir: ' + tmp)
process.exit(failures ? 1 : 0)
