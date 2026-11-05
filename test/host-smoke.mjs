/**
 * Host 半冒烟测试：不经过 DSH 插件系统，直接驱动 apply() 注册进来的路由。
 * 验证路由注册、上游拉取、瘦身、磁盘缓存、错误路径。
 */
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmp = mkdtempSync(join(tmpdir(), 'ht-smoke-'))
process.env.DSH_PROFILE_DIR = tmp

const { apply } = await import('../index.js')

let handler = null
const registered = []
const ctx = {
  get(name) {
    if (name === 'webServer') return { register: (route) => { registered.push(route); handler = route.handler; return () => {} } }
    return undefined
  },
  effect(fn) {
    return fn()
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

let failures = 0
function check(name, ok, extra = '') {
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (extra ? ' — ' + extra : ''))
  if (!ok) failures += 1
}

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

/* 4. list：真实拉取上游 */
{
  const t0 = Date.now()
  const res = await call('/hackertube/api/list')
  const ms = Date.now() - t0
  check('list 200', res.statusCode === 200, 'got ' + res.statusCode)
  let items = null
  try {
    items = JSON.parse(res.body)
  } catch (e) {
    check('list parses', false, String(e.message))
  }
  if (items) {
    check('list count 6454', items.length === 6454, 'got ' + items.length)
    check('list payload size', res.body.length > 1e6, (res.body.length / 1048576).toFixed(2) + 'MB')
    check('list took', ms < 60000, ms + 'ms')
    const first = items[0]
    const need = ['v', 't', 'c', 'd', 'th', 'p', 'w', 'y', 'cats', 'tags', 's', 'r']
    const missing = need.filter((k) => !(k in first))
    check('slim fields complete', missing.length === 0, missing.join(','))
    check('no heavy fields', !('summary' in first) && !('why_hn' in first))
    check('categories are ids', Array.isArray(first.cats) && first.cats.every((x) => typeof x === 'string'))
    check('score present', typeof first.s === 'number', String(first.s))

    /* 值的完整性：之前只查 key 存在，漏掉了整批数据字段为空的情况 */
    const withThumb = items.filter((o) => typeof o.th === 'string' && o.th.startsWith('http')).length
    const withDur = items.filter((o) => typeof o.d === 'number' && o.d > 0).length
    const withPub = items.filter((o) => typeof o.p === 'string' && o.p.length >= 10).length
    const withViews = items.filter((o) => typeof o.w === 'number' && o.w > 0).length
    const withYear = items.filter((o) => typeof o.y === 'number' && o.y >= 2005).length
    /* 上游个别条目本身缺 duration / views，按覆盖率判定 */
    const enough = (n) => n >= items.length * 0.99
    check('thumbnail filled', enough(withThumb), withThumb + '/' + items.length)
    check('duration filled', enough(withDur), withDur + '/' + items.length)
    check('published filled', enough(withPub), withPub + '/' + items.length)
    check('views filled', enough(withViews), withViews + '/' + items.length)
    check('year filled', enough(withYear), withYear + '/' + items.length)
    check('sample thumbnail', String(first.th).includes('ytimg'), first.th)
    console.log('   sample:', first.v, '|', first.t.slice(0, 40), '| dur=' + first.d, '| y=' + first.y, '| views=' + first.w)
  }
  await new Promise((r) => setTimeout(r, 900))
  check('cache file written', existsSync(join(tmp, '.dsh-hackertube', 'list.json')))
}

/* 5. list 二次调用命中内存缓存 */
{
  const t0 = Date.now()
  const res = await call('/hackertube/api/list')
  const ms = Date.now() - t0
  check('list second call fast', res.statusCode === 200 && ms < 500, ms + 'ms')
}

/* 6. browse */
{
  const res = await call('/hackertube/api/browse')
  check('browse 200', res.statusCode === 200, 'got ' + res.statusCode)
  const tax = JSON.parse(res.body)
  check('browse 16 areas', Array.isArray(tax.areas) && tax.areas.length === 16, String(tax.areas?.length))
  await new Promise((r) => setTimeout(r, 400))
  check('browse cache', existsSync(join(tmp, '.dsh-hackertube', 'browse.json')))
}

/* 7. video 详情 */
{
  const res = await call('/hackertube/api/video?vid=fNk_zzaMoSs')
  check('video 200', res.statusCode === 200, 'got ' + res.statusCode)
  const d = JSON.parse(res.body)
  check('video has why_hn', typeof d.why_hn === 'string' && d.why_hn.length > 0)
  check('video has summary', typeof d.summary === 'string')
  check('video has hn stats', !!d.hn, JSON.stringify(d.hn && d.hn.mentions))
  check('video quote thread id', !!(d.quote && d.quote.id), String(d.quote && d.quote.id))
  check('video quote is object with text', typeof (d.quote && d.quote.text) === 'string')
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
{
  const res = await call('/hackertube/api/related?vid=fNk_zzaMoSs')
  check('related 200', res.statusCode === 200, 'got ' + res.statusCode)
  const list = JSON.parse(res.body)
  check('related 12 items', Array.isArray(list) && list.length === 12, String(list && list.length))
  check('related items carry title', Array.isArray(list) && list.every((x) => x && x.t))
  check('related items carry thumb', Array.isArray(list) && list.every((x) => x && x.th))
}

/* 11. 导出文件与清单落盘 */
{
  check('export manifest written', existsSync(join(tmp, '.dsh-hackertube', 'export', 'manifest.json')))
  check('export videos on disk', existsSync(join(tmp, '.dsh-hackertube', 'export', 'videos.jsonl')))
}

console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'ALL PASS') + ' | cache dir: ' + tmp)
process.exit(failures ? 1 : 0)
