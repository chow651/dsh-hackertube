/**
 * Client 半渲染测试：用真实 React 18 跑组件，验证注册、数据流、筛选、播放页。
 * 依赖 mock 的 fetch / document / IntersectionObserver。
 */
import fs from 'node:fs'
import React from 'react'
import { act, create } from 'react-test-renderer'

const CLIENT = process.argv[2]
if (!CLIENT) {
  console.error('usage: node render-test.mjs <client.js path>')
  process.exit(2)
}

/* ---------- 环境 mock ---------- */

const styleEls = []
global.document = {
  head: { appendChild() {} },
  createElement() {
    const el = { setAttribute() {}, remove() {}, textContent: '' }
    styleEls.push(el)
    return el
  },
}
global.IntersectionObserver = class {
  constructor(cb) {
    this.cb = cb
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

const LIST = [
  { v: 'a1', t: 'Vectors, the first chapter', c: '3Blue1Brown', d: 592, th: 'https://i.ytimg.com/vi/a1/mqdefault.jpg', p: '2016-01-01T00:00:00Z', w: 12988516, ct: 'course', lv: 'intro', y: 2016, cats: ['prog'], tags: ['linear algebra'], s: 25, r: 17 },
  { v: 'b2', t: 'A talk about type systems', c: 'Some Conf', d: 3700, th: 'https://i.ytimg.com/vi/b2/mqdefault.jpg', p: '2019-06-01T00:00:00Z', w: 99284, ct: 'talk', lv: 'advanced', y: 2019, cats: ['prog'], tags: ['types'], s: 22, r: 9 },
  { v: 'c3', t: 'Intro to large language models', c: 'Andrej Karpathy', d: 3588, th: 'https://i.ytimg.com/vi/c3/mqdefault.jpg', p: '2023-11-23T00:00:00Z', w: 4298019, ct: 'talk', lv: 'intro', y: 2023, cats: ['ml'], tags: ['llm'], s: 22, r: 19 },
]
/* 本地导出的首屏形态：标题/频道/缩略图已有，时长与播放量等元信息还没补齐 */
const LIST_EXPORT = LIST.map((o) => ({ ...o, d: 0, w: 0, p: null, y: null }))
const TAX = {
  version: 'x',
  areas: [
    { id: 'software', name: 'Software Engineering', categories: [{ id: 'prog', name: 'Programming language design' }] },
    { id: 'ai-data', name: 'AI & Data', categories: [{ id: 'ml', name: 'Machine learning' }] },
  ],
}
const DETAIL = {
  vid: 'a1',
  title: 'Vectors, the first chapter',
  summary: 'An animated introduction to vectors.',
  why_hn: "HN's go-to recommendation for linear algebra intuition.",
  quote: { text: 'the most welcoming introduction ever', id: 18679785, year: '2018' },
  hn: { mentions: 20, recommenders: 17, strong: 14, first: '2018', last: '2026' },
  tags: ['linear algebra', 'visual intuition'],
}

let fetchCalls = 0
const fetchLog = []
let statusStage = 'export'
let statusExtra = {}
let listGate = null

const statusBody = () => ({
  stage: statusStage,
  source: statusStage === 'ready' ? 'upstream' : 'export',
  stale: false,
  revalidating: statusStage !== 'ready',
  enriched: statusStage === 'ready' ? LIST.length : 0,
  total: LIST.length,
  error: null,
  ...statusExtra,
})

global.fetch = async (url) => {
  fetchCalls += 1
  fetchLog.push(String(url))
  if (url.includes('/list/status')) {
    return { ok: true, status: 200, json: async () => statusBody() }
  }
  if (/\/hackertube\/api\/list(\?|$)/.test(String(url))) {
    if (listGate) await listGate
    return { ok: true, status: 200, json: async () => (statusStage === 'ready' ? LIST : LIST_EXPORT) }
  }
  const body = url.includes('/browse') ? TAX : url.includes('/video') ? DETAIL : LIST
  return { ok: true, status: 200, json: async () => body }
}

const listCalls = () =>
  fetchLog.filter((u) => /\/hackertube\/api\/list(\?|$)/.test(String(u))).length

/* ---------- 载入 client.js ---------- */

let captured = null
const win = {
  __ModuleLoader__: {
    load(cfg) {
      captured = cfg
    },
  },
}
const code = fs.readFileSync(CLIENT, 'utf8')
new Function('window', 'document', 'fetch', code)(win, global.document, global.fetch)

let failures = 0
function check(name, ok, extra = '') {
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (extra ? ' — ' + extra : ''))
  if (!ok) failures += 1
}

check('ModuleLoader invoked', !!captured)
check('module id', captured && captured.id === 'dsh-hackertube', captured && captured.id)

const mod = captured.factory((name) => (name === 'react' ? React : undefined))
check('factory returns inject+apply', mod && Array.isArray(mod.inject) && typeof mod.apply === 'function')
check('inject includes slots', mod.inject.includes('slots'), JSON.stringify(mod.inject))

/* ---------- 注册 ---------- */

const registered = []
const ctx = {
  slots: {
    inject(name, cb) {
      cb()
      return () => {}
    },
    register(opts, comp) {
      registered.push({ opts, comp })
      return () => {}
    },
  },
  effect(fn) {
    return fn()
  },
}
mod.apply(ctx)

const panel = registered.find((r) => r.opts.name === 'sidebar.panellist')
const main = registered.find((r) => r.opts.name === 'main')
check('panellist registered', !!panel, panel && JSON.stringify(panel.opts))
check('main registered', !!main, main && JSON.stringify(main.opts))
check('paired id === key', panel && main && panel.opts.id === main.opts.key, (panel && panel.opts.id) + ' vs ' + (main && main.opts.key))
check('style injected', styleEls.length === 1 && styleEls[0].textContent.length > 500, styleEls.length + ' el')

/* ---------- 渲染 ---------- */

async function render() {
  let tree = null
  await act(async () => {
    tree = create(React.createElement(main.comp, {}))
  })
  return tree
}

let releaseList = null
listGate = new Promise((resolve) => {
  releaseList = resolve
})

const tree = await render()
const json = () => JSON.stringify(tree.toJSON())

const text = () => {
  const out = []
  const walk = (n) => {
    if (n === null || n === undefined) return
    if (typeof n === 'string' || typeof n === 'number') out.push(String(n))
    else if (Array.isArray(n)) n.forEach(walk)
    else if (n.children) n.children.forEach(walk)
  }
  walk(tree.toJSON())
  return out.join(' | ')
}

check('root container rendered', json().includes('ht-root'), '')
check('data fetched', listCalls() >= 1, listCalls() + ' list calls')

/* 首屏：列表请求还没回来时，骨架屏要说清当前阶段 */
await act(async () => {
  await new Promise((r) => setTimeout(r, 30))
})
check('first paint stage visible', /正在读取本地视频导出|Loading local video export/.test(text()), text().slice(0, 180))
check('skeleton visible before list', json().includes('ht-skel'), '')

/* 列表先到：卡片立刻出现；元信息同步与旧缓存状态在后台可见 */
statusStage = 'metadata'
statusExtra = { stale: true }
await act(async () => {
  releaseList()
  await new Promise((r) => setTimeout(r, 40))
})
const firstBody = text()
check('renders 3 titles before metadata completes', LIST.every((it) => firstBody.includes(it.t)), firstBody.slice(0, 140))
check('export cards shown without enriched metadata', !/12\.9M/.test(firstBody), firstBody.slice(0, 140))
check('background sync stage visible', /正在同步视频元信息|Syncing video metadata/.test(firstBody), '')
check('background progress count visible', /0\/3/.test(firstBody), firstBody.slice(0, 140))
check('stale cache marker visible', /旧缓存|stale/i.test(firstBody), '')

/* 评论解析阶段也要有文案 */
statusStage = 'comments'
await act(async () => {
  await new Promise((r) => setTimeout(r, 1100))
})
check('comments stage visible', /正在解析 HN 评论|Parsing HN comments/.test(text()), text().slice(0, 180))

/* 后台完成：阶段条与旧缓存提示消失 */
statusStage = 'ready'
statusExtra = {}
await act(async () => {
  await new Promise((r) => setTimeout(r, 1100))
})
const body = text()
check('sync stage clears', !/正在同步视频元信息|正在解析 HN 评论/.test(body), '')
check('stale marker clears', !/旧缓存|stale/i.test(body), '')
check('renders 3 titles', LIST.every((it) => body.includes(it.t)), body.slice(0, 120))
check('shows recommender count', body.includes('17') && /(人推荐|recommenders?)/.test(body), '')
check('shows view count truncated', /12\.9M (次观看|views)/.test(body), '')
check('shows total count', /3 (个视频|videos)/.test(body), '')

const buttons = tree.root.findAllByType('button')
const chips = buttons.filter((b) => String(b.props.className || '').startsWith('ht-chip'))
check('chips = all + 2 areas', chips.length === 3, chips.length + '')
check('first chip is 全部', /全部|All/.test(text()), '')

/* 分类过滤 */
const aiChip = chips.find((c) => text().includes('AI & Data') && String(c.props.className).includes('ht-chip') && c.props.children === 'AI & Data')
const targetChip = chips[chips.length - 1]
await act(async () => {
  targetChip.props.onClick()
})
const afterFilter = text()
check('area filter keeps only karpathy', afterFilter.includes('Intro to large language models') && !afterFilter.includes('Vectors, the first chapter'), afterFilter.slice(0, 100))
check('filtered count updates', /1 (个视频|video)/.test(afterFilter), '')

/* 回到全部 */
await act(async () => {
  chips[0].props.onClick()
})
check('reset filter restores 3', /3 (个视频|videos)/.test(text()), '')

/* 搜索 */
const input = tree.root.findAllByType('input')[0]
check('search input exists', !!input, '')
await act(async () => {
  input.props.onChange({ target: { value: 'karpathy' } })
})
const afterSearch = text()
check('search narrows by channel', /1 (个视频|video)/.test(afterSearch) && afterSearch.includes('Intro to large language models'), afterSearch.slice(0, 100))

await act(async () => {
  input.props.onChange({ target: { value: 'zzzznomatch' } })
})
check('empty state', /没有匹配的视频|No matching videos/.test(text()), '')

await act(async () => {
  input.props.onChange({ target: { value: '' } })
})
check('clearing search restores', /3 (个视频|videos)/.test(text()), '')

/* 进播放页 */
const cards = tree.root.findAllByType('button').filter((b) => String(b.props.className || '') === 'ht-card')
check('3 cards rendered', cards.length === 3, cards.length + '')
await act(async () => {
  cards[0].props.onClick()
})

const iframe = tree.root.findAllByType('iframe')[0]
const waiting = tree.root.findAll((n) => n.props && String(n.props.className||'').includes('ht-video-wait')).length > 0
check('player slot rendered', !!iframe || waiting, iframe ? 'iframe' : (waiting ? 'waiting' : 'none'))
check('iframe uses relay', !iframe || String(iframe.props.src).indexOf('/embed?vid=a1') >= 0, iframe && iframe.props.src)
check('iframe allows autoplay', !iframe || String(iframe.props.allow).indexOf('autoplay') >= 0, '')

const watchBody = text()
check('shows why_hn', watchBody.includes("HN's go-to recommendation"), '')
check('shows summary', watchBody.includes('animated introduction'), '')
check('shows quote text', watchBody.includes('most welcoming introduction ever'), '')
check('quote not rendered as object', !watchBody.includes('[object Object]'), '')
check('shows hn stats',
  watchBody.includes('20') && /(次被提及|mentions?)/.test(watchBody) &&
    watchBody.includes('17') && /(人推荐|recommenders?)/.test(watchBody) &&
    watchBody.includes('14') && /(次强烈推荐|strong recs?)/.test(watchBody),
  '')
check('shows year span', watchBody.includes('2018–2026'), '')
check('shows tags', watchBody.includes('linear algebra'), '')

const anchors = tree.root.findAllByType('a')
const thread = anchors.find((a) => String(a.props.href || '').includes('news.ycombinator.com/item?id='))
check('HN thread link correct', thread && thread.props.href === 'https://news.ycombinator.com/item?id=18679785', thread && thread.props.href)
check('thread link has noopener', thread && thread.props.rel === 'noreferrer noopener', '')

/* 返回列表 */
const backBtn = tree.root.findAllByType('button').find((b) => String(b.props.className || '') === 'ht-back')
check('back button present', !!backBtn, '')
await act(async () => {
  backBtn.props.onClick()
})
check('back returns to grid', /3 (个视频|videos)/.test(text()) && tree.root.findAllByType('iframe').length === 0, '')

/* 卸载清理 */
await act(async () => {
  tree.unmount()
})
check('unmounted without error', true)

/* 重开面板：模块级缓存应命中，不重复请求列表 */
const before = listCalls()
const tree2 = await act(async () => create(React.createElement(main.comp, {})))
check('reopen skips list refetch', listCalls() === before, 'list calls ' + before + ' → ' + listCalls())
check('reopen shows data immediately', /3 (个视频|videos)/.test(JSON.stringify(tree2.toJSON())), '')

console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'ALL PASS'))
process.exit(failures ? 1 : 0)
