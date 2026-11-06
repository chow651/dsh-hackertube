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
const docListeners = new Map()
global.document = {
  head: { appendChild() {} },
  activeElement: null,
  createElement() {
    const el = { setAttribute() {}, remove() {}, textContent: '' }
    styleEls.push(el)
    return el
  },
  addEventListener(type, fn) {
    if (!docListeners.has(type)) docListeners.set(type, new Set())
    docListeners.get(type).add(fn)
  },
  removeEventListener(type, fn) {
    if (docListeners.has(type)) docListeners.get(type).delete(fn)
  },
}
global.document.__emit = (type, event) => {
  for (const fn of docListeners.get(type) || []) fn(event)
}
global.IntersectionObserver = class {
  constructor(cb) {
    this.cb = cb
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

/* 语言偏好要跨“刷新”保留：模拟 localStorage；每个测试段可 clear() */
const langStorage = new Map()
global.localStorage = {
  getItem(key) {
    const k = String(key)
    return langStorage.has(k) ? langStorage.get(k) : null
  },
  setItem(key, value) {
    langStorage.set(String(key), String(value))
  },
  removeItem(key) {
    langStorage.delete(String(key))
  },
  clear() {
    langStorage.clear()
  },
}

/** react-test-renderer 的宿主节点替身：滚动位置与 scrollIntoView 都留痕，供行为断言。
 *  re-render 会反复调用 createNodeMock，滚动容器按 className 固定同一份替身，
 *  否则 ref 指向的节点和测试持有的节点不是同一个对象。 */
const stableNodes = new Map()
function makeNodeMock(element) {
  const cls = element && element.props ? String(element.props.className || '') : ''
  const stable = cls === 'ht-scroll' || cls === 'ht-watch' || cls === 'ht-rail'
  if (stable && stableNodes.has(cls)) return stableNodes.get(cls)
  const node = {
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    style: {},
    scrolledIntoView: false,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false } },
    getBoundingClientRect: () => ({ width: 900, height: 640 }),
    querySelector: () => null,
    querySelectorAll: () => [],
    scrollIntoView() {
      node.scrolledIntoView = true
    },
    focus() {},
    blur() {},
  }
  if (stable) stableNodes.set(cls, node)
  return node
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
const RELATED = [LIST[1], LIST[2]]

let depsBody = {
  ytdlp: { ok: true, version: 'test' },
  ffmpeg: { ok: true, version: 'test' },
  whisper: { ok: false, hint: 'pip install faster-whisper' },
}

let fetchCalls = 0
const fetchLog = []
const fetchPosts = []
let recommendMode = 'cold'
let recommendItems = [{ ...LIST[2], reason: { kind: 'hn', score: 22, recommenders: 19 } }]


const searchCalls = []
const chatCalls = []
const chatPlans = []

/** 把事件序列包装成 client.js 会消费的 SSE Response。 */
function sseResponse(events) {
  const text = events
    .map((event) => (typeof event === 'string' ? event : 'data: ' + JSON.stringify(event) + '\n\n'))
    .join('')
  const bytes = new TextEncoder().encode(text)
  let sent = false
  return {
    ok: true,
    status: 200,
    headers: {
      get: (name) => (String(name).toLowerCase() === 'content-type' ? 'text/event-stream; charset=utf-8' : null),
    },
    body: {
      getReader() {
        return {
          async read() {
            if (!sent) {
              sent = true
              return { done: false, value: bytes }
            }
            return { done: true, value: undefined }
          },
        }
      },
    },
    json: async () => ({}),
  }
}

let statusStage = 'export'
let statusExtra = {}
let listGate = null

/* 面板只渲染 Host 检索返回的结果：这里按请求参数返回一个可控替身，
   测试可以替换 searchResponder 来断言“面板确实相信 Host 的排序”。 */
function defaultSearchResponse(params) {
  let out = LIST.slice()
  if (params.area) {
    const area = TAX.areas.find((a) => a.id === params.area)
    const cats = new Set(((area && area.categories) || []).map((c) => c.id))
    out = out.filter((it) => (it.cats || []).some((c) => cats.has(c)))
  }
  if (params.year) out = out.filter((it) => String(it.y) === String(params.year))
  if (params.type) out = out.filter((it) => it.ct === params.type)
  if (params.level) out = out.filter((it) => it.lv === params.level)
  const q = String(params.q || '').trim().toLowerCase()
  if (q) out = out.filter((it) => [it.t, it.c, (it.tags || []).join(' ')].join(' ').toLowerCase().includes(q))
  if (params.sort === 'score') out = out.slice().sort((a, b) => (b.s || 0) - (a.s || 0))
  if (params.sort === 'year') out = out.slice().sort((a, b) => (b.y || 0) - (a.y || 0))
  if (params.sort === 'views') out = out.slice().sort((a, b) => (b.w || 0) - (a.w || 0))
  return { query: q, total: out.length, limit: Number(params.limit) || 200, offset: 0, items: out }
}
let searchResponder = defaultSearchResponse

/* T05：语言偏好与详情异步翻译的测试开关 */
let prefsLang = null
const prefsPosts = []
let translateRequests = 0
let translateGate = null
let translateReply = {
  i18n: {
    summary: '向量动画入门。',
    why_hn: 'HN 上首推的线性代数直觉课。',
    quote: '最友好的入门介绍。',
  },
  i18nSource: { summary: 'model', why_hn: 'machine', quote: 'model' },
}
/* 详情接口自带的缓存译文：有值时详情首屏就该直接显示译文 */
let detailI18n = null
let detailI18nSource = null
const detailBody = () =>
  detailI18n ? { ...DETAIL, i18n: detailI18n, i18nSource: detailI18nSource || {} } : DETAIL

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

global.fetch = async (url, options = {}) => {
  fetchCalls += 1
  if (options && options.method === 'POST') fetchPosts.push({ url: String(url), body: options.body })
  const u = String(url)
  if (u.includes('/hackertube/api/search')) {
    const qs = new URL(u, 'http://fixture.local').searchParams
    const params = {}
    qs.forEach((v, k) => { params[k] = v })
    searchCalls.push(params)
    const result = searchResponder(params)
    return { ok: true, status: 200, json: async () => result }
  }
  const method = (options && options.method) || 'GET'
  fetchLog.push(method + ' ' + u)
  let requestBody = null
  try {
    if (options && options.body) requestBody = JSON.parse(String(options.body))
  } catch {
    requestBody = null
  }
  if (u.includes('/prefs') && method === 'POST') prefsPosts.push(requestBody)
  if (u.includes('/video/translate')) {
    translateRequests += 1
    if (translateGate) await translateGate
    return { ok: true, status: 200, json: async () => translateReply }
  }
  if (u.includes('/hackertube/api/chat')) {
    const payload = JSON.parse(String(options.body || '{}'))
    chatCalls.push(payload)
    const plan = chatPlans.shift()
    if (plan && plan.pending) return new Promise(() => {})
    return sseResponse(
      plan || [
        { stage: 'subtitles' },
        { stage: 'answer', subtitle: { status: 'ok', hasSubtitles: true, window: { start: 60, end: 90, count: 2 } } },
        { delta: '默认回答' },
        {
          done: true,
          answer: '默认回答',
          hasSubtitles: true,
          subtitle: { status: 'ok', hasSubtitles: true, window: { start: 60, end: 90, count: 2 } },
        },
        'data: [DONE]\n\n',
      ],
    )
  }
  if (u.includes('/list/status')) {
    return { ok: true, status: 200, json: async () => statusBody() }
  }
  if (u.includes('/recommend')) {
    const query = new URL(u, 'http://fixture.local').searchParams
    const dismissed = new Set(String(query.get('dismissed') || '').split(',').filter(Boolean))
    return {
      ok: true,
      status: 200,
      json: async () => ({
        mode: recommendMode,
        items: recommendItems.filter((item) => !dismissed.has(item.v)),
      }),
    }
  }
  if (/\/hackertube\/api\/list(\?|$)/.test(u)) {
    if (listGate) await listGate
    return { ok: true, status: 200, json: async () => (statusStage === 'ready' ? LIST : LIST_EXPORT) }
  }
  let body = LIST
  if (u.includes('/browse') || u.includes('/taxonomy')) body = TAX
  else if (u.includes('/video')) body = detailBody()
  else if (u.includes('/related')) body = RELATED
  else if (u.includes('/deps')) body = depsBody
  else if (u.includes('/config')) body = { origin: 'http://127.0.0.1:54321', authUrl: null, mediaOrigin: 'http://127.0.0.1:18090' }
  else if (u.includes('/prefs')) body = { likes: [], later: [], seen: [], lang: prefsLang }
  else if (u.includes('/titles')) body = { entries: {} }
  else if (u.includes('/mt')) body = { text: '' }
  return { ok: true, status: 200, json: async () => body }
}

const listCalls = () =>
  fetchLog.filter((u) => /\/hackertube\/api\/list(\?|$)/.test(String(u))).length

/* ---------- 载入 client.js ---------- */

let captured = null
const winListeners = new Map()
const historyEntries = ['']
const historyCalls = []
const win = {
  __ModuleLoader__: {
    load(cfg) {
      captured = cfg
    },
  },
  location: { pathname: '/', search: '', hash: '' },
  navigator: { language: 'en-US', languages: ['en-US'] },
  addEventListener(type, fn) {
    if (!winListeners.has(type)) winListeners.set(type, new Set())
    winListeners.get(type).add(fn)
  },
  removeEventListener(type, fn) {
    if (winListeners.has(type)) winListeners.get(type).delete(fn)
  },
}
win.__emit = (type, event) => {
  for (const fn of winListeners.get(type) || []) fn(event)
}
const applyHistoryUrl = (url) => {
  const s = String(url || '')
  const i = s.indexOf('#')
  win.location.hash = i >= 0 ? s.slice(i) : ''
}
win.history = {
  pushState(state, title, url) {
    historyCalls.push(['push', url])
    historyEntries.push(url)
    applyHistoryUrl(url)
  },
  replaceState(state, title, url) {
    historyCalls.push(['replace', url])
    historyEntries[historyEntries.length - 1] = url
    applyHistoryUrl(url)
  },
  back() {
    historyCalls.push(['back'])
    historyEntries.pop()
    applyHistoryUrl(historyEntries[historyEntries.length - 1] || '')
    win.__emit('popstate', {})
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
    tree = create(React.createElement(main.comp, {}), { createNodeMock: makeNodeMock })
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
  await new Promise((r) => setTimeout(r, 300))
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
  await new Promise((r) => setTimeout(r, 300))
})
const afterSearch = text()
check('search narrows by channel', /1 (个视频|video)/.test(afterSearch) && afterSearch.includes('Intro to large language models'), afterSearch.slice(0, 100))

await act(async () => {
  input.props.onChange({ target: { value: 'zzzznomatch' } })
  await new Promise((r) => setTimeout(r, 300))
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
check('iframe uses relay', !iframe || /\/embed\?vid=[A-Za-z0-9_-]+/.test(String(iframe.props.src)), iframe && iframe.props.src)
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
const tree2 = await act(async () => create(React.createElement(main.comp, {}), { createNodeMock: makeNodeMock }))
check('reopen skips list refetch', listCalls() === before, 'list calls ' + before + ' → ' + listCalls())
check('reopen shows data immediately', /3 (个视频|videos)/.test(JSON.stringify(tree2.toJSON())), '')

/* ---------- T02：播放失败可见、可兜底、可返回 ---------- */

await act(async () => {
  tree2.unmount()
})

function treeText(t) {
  const out = []
  const walk = (n) => {
    if (n === null || n === undefined) return
    if (typeof n === 'string' || typeof n === 'number') out.push(String(n))
    else if (Array.isArray(n)) n.forEach(walk)
    else if (n.children) n.children.forEach(walk)
  }
  walk(t.toJSON())
  return out.join(' | ')
}
const findClass = (t, cls) => t.root.findAll((n) => n.props && String(n.props.className || '') === cls)
const findButton = (t, re) => t.root.findAllByType('button').find((b) => re.test(String(b.props.children)))
async function freshTree() {
  let t = null
  await act(async () => {
    t = create(React.createElement(main.comp, {}), { createNodeMock: makeNodeMock })
  })
  return t
}
/* 首页前排会被推荐重排，所以按 id 开卡，而不是靠位置 */
async function openCardByVid(t, vid) {
  const card = t.root
    .findAllByType('button')
    .find((b) => String(b.props.className || '') === 'ht-card' && b.props['data-vid'] === vid)
  await act(async () => {
    card.props.onClick()
  })
}
async function openFirstCard(t) {
  const cards = t.root.findAllByType('button').filter((b) => String(b.props.className || '') === 'ht-card')
  const card = cards.find((b) => b.props['data-vid'] === 'a1') || cards[0]
  await act(async () => {
    card.props.onClick()
  })
}
function resetRoute() {
  win.location.hash = ''
  historyEntries.length = 0
  historyEntries.push('')
}
async function emitPlaybackError(kind, code) {
  await act(async () => {
    win.__emit('message', { data: { __ht: kind, code, vid: 'a1' } })
  })
}

console.log('\n--- T02 playback resilience ---')

/* yt-error：可见错误 + YouTube 行动 + 重试 + 本地兜底入口 */
{
  resetRoute()
  const t = await freshTree()
  await openFirstCard(t)
  await emitPlaybackError('yt-error', 153)
  const body = treeText(t)
  check('T02 yt-error visible', /153/.test(body) && /(YouTube|内嵌|embed)/i.test(body), body.slice(0, 180))
  const yt = t.root.findAllByType('a').find((a) => String(a.props.href || '').includes('youtube.com/watch?v=a1'))
  check('T02 yt-error YouTube action', !!yt, yt && yt.props.href)
  const retry = findButton(t, /(重试播放器|Retry player)/)
  check('T02 yt-error retry action', !!retry)
  const local = findButton(t, /(尝试本地直连|Try local)/)
  check('T02 yt-error local fallback action', !!local)
  await act(async () => {
    retry.props.onClick()
  })
  const restored =
    t.root.findAllByType('iframe').length === 1 ||
    t.root.findAll((n) => n.props && String(n.props.className || '').includes('ht-video-wait')).length === 1
  check('T02 retry restores player slot', restored && !/Retry the player/.test(treeText(t)), '')
  await act(async () => {
    t.unmount()
  })
}

/* api-error：YouTube IFrame API 脚本加载失败也有文案 */
{
  resetRoute()
  const t = await freshTree()
  await openFirstCard(t)
  await emitPlaybackError('api-error', null)
  check('T02 api-error visible', /(播放器脚本|player script)/i.test(treeText(t)), treeText(t).slice(0, 160))
  await act(async () => {
    t.unmount()
  })
}

/* 缺依赖：给出 yt-dlp / ffmpeg 的具体安装提示，而不是黑屏 */
{
  resetRoute()
  depsBody = {
    ytdlp: { ok: false, hint: 'pip install -U yt-dlp' },
    ffmpeg: { ok: false, hint: '安装 ffmpeg 并加入 PATH' },
  }
  const t = await freshTree()
  await openFirstCard(t)
  await emitPlaybackError('yt-error', 150)
  const local = findButton(t, /(尝试本地直连|Try local)/)
  await act(async () => {
    local.props.onClick()
    await Promise.resolve()
  })
  const body = treeText(t)
  check('T02 yt-dlp dependency hint', /yt-dlp/.test(body) && /pip install -U yt-dlp/.test(body), body.slice(0, 200))
  check('T02 ffmpeg dependency hint', /ffmpeg/.test(body) && /加入 PATH|PATH/.test(body), body.slice(0, 200))
  check('T02 no local video when deps missing', t.root.findAllByType('video').length === 0, '')
  await act(async () => {
    t.unmount()
  })
}

/* 依赖齐全：本地直连可用，并可在流式与缓存播放间切换 */
{
  resetRoute()
  depsBody = {
    ytdlp: { ok: true, version: 'test' },
    ffmpeg: { ok: true, version: 'test' },
    whisper: { ok: false },
  }
  const t = await freshTree()
  await openFirstCard(t)
  await emitPlaybackError('yt-error', 153)
  const local = findButton(t, /(尝试本地直连|Try local)/)
  await act(async () => {
    local.props.onClick()
    await Promise.resolve()
  })
  const video = t.root.findAllByType('video')[0]
  check(
    'T02 local fallback uses stream',
    !!video && /\/stream\?vid=a1$/.test(String(video.props.src)),
    video && video.props.src,
  )
  const cacheBtn = findButton(t, /(缓存播放|cached playback)/i)
  check('T02 cached playback action', !!cacheBtn)
  await act(async () => {
    cacheBtn.props.onClick()
  })
  const video2 = t.root.findAllByType('video')[0]
  check(
    'T02 cached playback uses media',
    !!video2 && /\/media\?vid=a1$/.test(String(video2.props.src)),
    video2 && video2.props.src,
  )
  await act(async () => {
    t.unmount()
  })
}

console.log('\n--- T02 navigation ---')

/* 返回列表：保留搜索筛选并恢复滚动位置 */
{
  resetRoute()
  const t = await freshTree()
  const input = t.root.findAllByType('input')[0]
  await act(async () => {
    input.props.onChange({ target: { value: 'karpathy' } })
    await new Promise((r) => setTimeout(r, 300))
  })
  const scroller = findClass(t, 'ht-scroll')[0]
  scroller.instance.scrollTop = 420
  await openFirstCard(t)
  const back = t.root.findAllByType('button').find((b) => String(b.props.className || '') === 'ht-back')
  await act(async () => {
    back.props.onClick()
  })
  const body = treeText(t)
  check('T02 back keeps filter', /1 (个视频|video)/.test(body) && body.includes('Intro to large language models'), body.slice(0, 120))
  const restored = findClass(t, 'ht-scroll')[0]
  check('T02 back restores list scroll', !!restored && restored.instance.scrollTop === 420, restored && String(restored.instance.scrollTop))
  await act(async () => {
    t.unmount()
  })
}

/* 打开相关视频：新播放页从顶部开始 */
{
  resetRoute()
  const t = await freshTree()
  await openFirstCard(t)
  const watch = findClass(t, 'ht-watch')[0]
  watch.instance.scrollTop = 300
  const rel = findClass(t, 'ht-rel')
  check('T02 related items rendered', rel.length > 0, String(rel.length))
  await act(async () => {
    rel[0].props.onClick()
  })
  check('T02 related opens new video', treeText(t).includes('A talk about type systems'), treeText(t).slice(0, 120))
  const watch2 = findClass(t, 'ht-watch')[0]
  check('T02 related starts at top', !!watch2 && watch2.instance.scrollTop === 0, watch2 && String(watch2.instance.scrollTop))
  await act(async () => {
    t.unmount()
  })
}

/* Esc 返回；地址状态可深链恢复 */
{
  resetRoute()
  const t = await freshTree()
  await openFirstCard(t)
  await act(async () => {
    global.document.__emit('keydown', { key: 'Escape', metaKey: false, ctrlKey: false, altKey: false })
  })
  check('T02 Escape returns to list', /3 (个视频|videos)/.test(treeText(t)), treeText(t).slice(0, 100))
  await act(async () => {
    t.unmount()
  })
}

{
  resetRoute()
  win.location.hash = '#ht-watch=c3'
  const t = await freshTree()
  check('T02 deep link opens video', treeText(t).includes('Intro to large language models'), treeText(t).slice(0, 140))
  await act(async () => {
    global.document.__emit('keydown', { key: 'Escape', metaKey: false, ctrlKey: false, altKey: false })
  })
  check('T02 deep link Escape clears state', win.location.hash === '' && /3 (个视频|videos)/.test(treeText(t)), win.location.hash + ' / ' + treeText(t).slice(0, 80))
  await act(async () => {
    t.unmount()
  })
}

/* 浏览器 back：watch 写入地址状态，popstate 回到列表 */
{
  resetRoute()
  const t = await freshTree()
  await openFirstCard(t)
  check('T02 watch writes address state', win.location.hash === '#ht-watch=a1', win.location.hash)
  await act(async () => {
    win.history.back()
  })
  check('T02 browser back returns to list', /3 (个视频|videos)/.test(treeText(t)), treeText(t).slice(0, 100))
  await act(async () => {
    t.unmount()
  })
}

/* 窄布局：相关推荐/AI 的入口在评论之前，且有明确跳转按钮 */
{
  resetRoute()
  const t = await freshTree()
  await openFirstCard(t)
  const raw = JSON.stringify(t.toJSON())
  const railAt = raw.indexOf('"ht-rail"')
  const commentsAt = raw.indexOf('"ht-comments"')
  check('T02 rail before comments in DOM', railAt >= 0 && commentsAt >= 0 && railAt < commentsAt, railAt + '/' + commentsAt)
  const jump = findButton(t, /(相关推荐与 AI|Related & AI)/)
  check('T02 rail jump entry present', !!jump)
  const rail = findClass(t, 'ht-rail')[0]
  if (jump && rail) {
    await act(async () => {
      jump.props.onClick()
    })
  }
  check('T02 rail jump scrolls to rail', !!rail && rail.instance.scrolledIntoView === true, rail && String(rail.instance.scrolledIntoView))
  await act(async () => {
    t.unmount()
  })
}

/* ---------- T03：面板与 Agent 共用 Host 检索 ---------- */

console.log('\n--- T03 unified search ---')

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const selectByFilter = (t, name) =>
  t.root.findAllByType('select').find((s) => String((s.props && s.props['data-filter']) || '') === name)

/* 面板不再自己评分/排序/过滤：Host 返回什么顺序与集合，就渲染什么 */
{
  resetRoute()
  searchCalls.length = 0
  searchResponder = () => ({
    query: 'vectors',
    total: 2,
    limit: 2000,
    offset: 0,
    items: [
      { ...LIST[2], match: { fields: ['title', 'tags'], snippet: 'host says this row goes first' } },
      { ...LIST[0], match: { fields: ['title'], snippet: 'and this one goes second' } },
    ],
  })
  const t = await freshTree()
  const input = t.root.findAllByType('input')[0]
  await act(async () => {
    input.props.onChange({ target: { value: 'vectors' } })
  })
  /* 请求还在路上时要显示加载态，不能先闪一下“没有匹配的视频” */
  const pending = treeText(t)
  check(
    'T03 pending search shows loading, not empty state',
    /检索中|Searching/.test(pending) && !/没有匹配的视频|No matching videos/.test(pending),
    pending.slice(0, 140),
  )
  await act(async () => {
    await wait(300)
  })
  const body = treeText(t)
  check(
    'T03 panel calls host search',
    searchCalls.some((c) => c.q === 'vectors' && c.limit === '2000'),
    JSON.stringify(searchCalls.slice(-1)),
  )
  check(
    'T03 panel follows host order instead of local scoring',
    body.indexOf('Intro to large language models') >= 0 &&
      body.indexOf('Intro to large language models') < body.indexOf('Vectors, the first chapter'),
    body.slice(0, 200),
  )
  check(
    'T03 panel shows matched field and snippet',
    /匹配：标题|Match: title/.test(body) && body.includes('host says this row goes first'),
    body.slice(0, 240),
  )
  check('T03 result count comes from host total', /2 (个视频|videos)/.test(body), body.slice(0, 120))
  await act(async () => {
    t.unmount()
  })
}

/* Host 说命中就显示：查询词不在标题里也不该被面板二次过滤 */
{
  resetRoute()
  searchCalls.length = 0
  searchResponder = () => ({
    query: 'zzz-no-local-filter',
    total: 1,
    limit: 2000,
    offset: 0,
    items: [{ ...LIST[2], match: { fields: ['summary'], snippet: 'the host matched the summary, not the title' } }],
  })
  const t = await freshTree()
  const input = t.root.findAllByType('input')[0]
  await act(async () => {
    input.props.onChange({ target: { value: 'zzz-no-local-filter' } })
    await wait(300)
  })
  const body = treeText(t)
  check(
    'T03 panel does not re-filter host results',
    body.includes('Intro to large language models') && /1 (个视频|video)/.test(body),
    body.slice(0, 200),
  )
  await act(async () => {
    t.unmount()
  })
}

/* 筛选与排序参数原样交给同一个 Host 检索操作 */
{
  resetRoute()
  searchCalls.length = 0
  searchResponder = defaultSearchResponse
  const t = await freshTree()
  const year = selectByFilter(t, 'year')
  const type = selectByFilter(t, 'type')
  const level = selectByFilter(t, 'level')
  const sort = selectByFilter(t, 'sort')
  check('T03 filter selects rendered', !!year && !!type && !!level && !!sort, [!!year, !!type, !!level, !!sort] + '')
  if (year && type && level && sort) {
    await act(async () => {
      year.props.onChange({ target: { value: '2019' } })
      await wait(300)
    })
    check('T03 year filter sent to host', searchCalls.length > 0 && searchCalls[searchCalls.length - 1].year === '2019', JSON.stringify(searchCalls.slice(-1)))
    await act(async () => {
      type.props.onChange({ target: { value: 'talk' } })
      await wait(300)
    })
    check('T03 type filter sent to host', searchCalls[searchCalls.length - 1].type === 'talk', JSON.stringify(searchCalls.slice(-1)))
    await act(async () => {
      level.props.onChange({ target: { value: 'advanced' } })
      await wait(300)
    })
    check('T03 level filter sent to host', searchCalls[searchCalls.length - 1].level === 'advanced', JSON.stringify(searchCalls.slice(-1)))
    await act(async () => {
      sort.props.onChange({ target: { value: 'score' } })
      await wait(300)
    })
    check('T03 sort sent to host', searchCalls[searchCalls.length - 1].sort === 'score', JSON.stringify(searchCalls.slice(-1)))
    check('T03 filters reuse one host operation', searchCalls.every((c) => c.limit === '2000'), JSON.stringify(searchCalls.slice(-1)))
    const body = treeText(t)
    check('T03 filtered count follows host', /1 (个视频|video)/.test(body), body.slice(0, 160))
  }
  await act(async () => {
    t.unmount()
  })
}

/* ---------- T04：AI 观看会话按视频隔离 ---------- */

console.log('\n--- T04 watch session ---')

const flushTasks = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0))
  for (let i = 0; i < 30; i += 1) await Promise.resolve()
}
const askInput = (t) =>
  t.root
    .findAllByType('input')
    .find((i) => /就当前进度提问|Ask about this moment|思考中|Thinking/.test(String(i.props.placeholder || '')))
const askForm = (t) => t.root.findAllByType('form').find((f) => String(f.props.className || '') === 'ht-rail-form')
async function sendQuestion(t, text) {
  const input = askInput(t)
  check('T04 rail input present', !!input, '')
  await act(async () => {
    input.props.onChange({ target: { value: text } })
  })
  const form = askForm(t)
  check('T04 rail form present', !!form, '')
  await act(async () => {
    form.props.onSubmit({ preventDefault() {} })
    await flushTasks()
  })
}
async function openCardAt(t, index) {
  const card = t.root.findAllByType('button').filter((b) => String(b.props.className || '') === 'ht-card')[index]
  await act(async () => {
    card.props.onClick()
  })
}
function subtitleDone(status, answer, extra = {}) {
  return [
    { stage: 'subtitles' },
    { stage: 'answer', subtitle: Object.assign({ status, hasSubtitles: status === 'ok' }, extra) },
    { delta: answer },
    {
      done: true,
      answer,
      hasSubtitles: status === 'ok',
      subtitle: Object.assign({ status, hasSubtitles: status === 'ok' }, extra),
    },
    'data: [DONE]\n\n',
  ]
}

/* 播放位置不因暂停过期；请求带历史；切换视频消息清空 */
{
  resetRoute()
  const t = await freshTree()
  await openFirstCard(t)
  await act(async () => {
    win.__emit('message', { data: { __ht: 'time', t: 125, d: 600, vid: 'a1' } })
  })
  check('T04 playhead visible', treeText(t).includes('2:05'), treeText(t).slice(0, 220))

  chatPlans.push(subtitleDone('ok', '回答一', { window: { start: 60, end: 90, count: 2 } }))
  await sendQuestion(t, '第一个问题')
  check('T04 first chat call', chatCalls.length === 1, String(chatCalls.length))
  check('T04 first request playhead', chatCalls[0] && chatCalls[0].at === 125, JSON.stringify(chatCalls[0] && chatCalls[0].at))
  check(
    'T04 first request no history',
    chatCalls[0] && Array.isArray(chatCalls[0].history) && chatCalls[0].history.length === 0,
    JSON.stringify(chatCalls[0] && chatCalls[0].history),
  )
  check('T04 answer rendered', treeText(t).includes('回答一'), treeText(t).slice(-200))
  check(
    'T04 subtitle window visible',
    /已读取 2 条字幕|Read 2 subtitle lines/.test(treeText(t)) && treeText(t).includes('1:00–1:30'),
    treeText(t).slice(-220),
  )

  const realNow = Date.now
  try {
    Date.now = () => realNow() + 60_000
    chatPlans.push(subtitleDone('ok', '回答二', { window: { start: 120, end: 150, count: 3 } }))
    await sendQuestion(t, '第二个问题')
  } finally {
    Date.now = realNow
  }
  check('T04 second chat call', chatCalls.length === 2, String(chatCalls.length))
  check(
    'T04 paused playhead retained',
    chatCalls[1] && chatCalls[1].at === 125,
    JSON.stringify(chatCalls[1] && chatCalls[1].at),
  )
  const history = (chatCalls[1] && chatCalls[1].history) || []
  check(
    'T04 follow-up carries history',
    history.length === 2 &&
      history[0].role === 'user' &&
      history[0].text === '第一个问题' &&
      history[1].role === 'assistant' &&
      history[1].text === '回答一',
    JSON.stringify(history),
  )

  const rel = findClass(t, 'ht-rel')
  await act(async () => {
    rel[0].props.onClick()
  })
  const switched = treeText(t)
  check(
    'T04 switch clears ai messages',
    !switched.includes('第一个问题') && !switched.includes('第二个问题'),
    switched.slice(0, 220),
  )
  check('T04 switch clears playhead display', !/当前播放位置|Playhead/.test(switched), '')

  await act(async () => {
    win.__emit('message', { data: { __ht: 'time', t: 30, d: 600, vid: 'b2' } })
    win.__emit('message', { data: { __ht: 'time', t: 300, d: 600, vid: 'a1' } })
  })
  check(
    'T04 new video keeps own playhead',
    treeText(t).includes('0:30') && !treeText(t).includes('5:00'),
    treeText(t).slice(0, 220),
  )
  await act(async () => {
    t.unmount()
  })
}

/* 中文查询原样提交给 Host，由 Host 走现有机器翻译扩展 */
{
  resetRoute()
  searchCalls.length = 0
  searchResponder = () => ({
    query: '编译器优化',
    total: 1,
    items: [
      {
        ...LIST[2],
        match: { fields: ['tags', 'summary'], snippet: 'compiler optimization in practice' },
      },
    ],
  })
  const t = await freshTree()
  const input = t.root.findAllByType('input')[0]
  await act(async () => {
    input.props.onChange({ target: { value: '编译器优化' } })
    await wait(300)
  })
  const body = treeText(t)
  check('T03 chinese query sent to host unchanged', searchCalls.some((c) => c.q === '编译器优化'), JSON.stringify(searchCalls.slice(-1)))
  check('T03 chinese result snippet visible', body.includes('compiler optimization in practice'), body.slice(0, 200))
  check('T03 chinese matched fields visible', /匹配：标签、摘要|Match: tags, summary/.test(body), body.slice(0, 200))
  await act(async () => {
    t.unmount()
  })
}

/* 无字幕 / cookies 缺失 / 超时三种状态都必须可见 */
{
  resetRoute()
  const t = await freshTree()
  await openFirstCard(t)
  chatPlans.push(subtitleDone('no-captions', '仅简介回答', { hint: '这条视频没有可用字幕，需要本地转写' }))
  await sendQuestion(t, '这段在讲什么？')
  const body = treeText(t)
  check(
    'T04 no-captions visible',
    /没有可用字幕|No subtitles/.test(body) && /仅基于视频简介|description only/.test(body),
    body.slice(-260),
  )
  await act(async () => {
    t.unmount()
  })
}

{
  resetRoute()
  const t = await freshTree()
  await openCardAt(t, 1)
  chatPlans.push(
    subtitleDone('needs-cookies', '需要配置的回答', {
      hint: 'YouTube 要求登录校验。导出 Netscape 格式 cookies.txt，放到 C:\\temp\\cookies.txt，然后重试。',
      cookiePath: 'C:\\temp\\cookies.txt',
    }),
  )
  await sendQuestion(t, '这段在讲什么？')
  const body = treeText(t)
  check('T04 cookies hint visible', /cookies\.txt/.test(body) && /登录校验/.test(body), body.slice(-300))
  await act(async () => {
    t.unmount()
  })
}

{
  resetRoute()
  const t = await freshTree()
  await openCardAt(t, 2)
  chatPlans.push(subtitleDone('timeout', '超时回答', { hint: '字幕获取超时（20 秒）' }))
  await sendQuestion(t, '这段在讲什么？')
  const body = treeText(t)
  check('T04 timeout visible', /超时|timed out/.test(body) && /仅基于视频简介|description only/.test(body), body.slice(-260))
  await act(async () => {
    t.unmount()
  })
}

/* 取字幕期间有可见阶段，而不是无反馈等待 */
{
  resetRoute()
  const t = await freshTree()
  await openFirstCard(t)
  chatPlans.push({ pending: true })
  await sendQuestion(t, '这段在讲什么？')
  const body = treeText(t)
  check('T04 subtitle stage visible', /正在取当前播放位置附近的字幕|Loading subtitles/.test(body), body.slice(-260))
  await act(async () => {
    t.unmount()
  })
}

/* ---------- T05：默认语言、持久化与详情异步翻译 ---------- */

/** 每个用例重新求值一份 client.js，等价于刷新页面后的全新模块状态。 */
function makeWin(navLang) {
  const listeners = new Map()
  const loc = { pathname: '/', search: '', hash: '' }
  const entries = ['']
  const w = {
    __ModuleLoader__: {
      load(cfg) {
        w.captured = cfg
      },
    },
    location: loc,
    navigator: { language: navLang, languages: [navLang] },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(fn)
    },
    removeEventListener(type, fn) {
      if (listeners.has(type)) listeners.get(type).delete(fn)
    },
  }
  w.__emit = (type, event) => {
    for (const fn of listeners.get(type) || []) fn(event)
  }
  const applyUrl = (url) => {
    const s = String(url || '')
    const i = s.indexOf('#')
    loc.hash = i >= 0 ? s.slice(i) : ''
  }
  w.history = {
    pushState(state, title, url) {
      entries.push(url)
      applyUrl(url)
    },
    replaceState(state, title, url) {
      entries[entries.length - 1] = url
      applyUrl(url)
    },
    back() {
      entries.pop()
      applyUrl(entries[entries.length - 1] || '')
      w.__emit('popstate', {})
    },
  }
  return w
}

function loadClientModule(w) {
  new Function('window', 'document', 'fetch', code)(w, global.document, global.fetch)
  return w.captured.factory((name) => (name === 'react' ? React : undefined))
}

async function mountModule(mod) {
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
  const main = registered.find((r) => r.opts.name === 'main')
  let t = null
  await act(async () => {
    t = create(React.createElement(main.comp, {}), { createNodeMock: makeNodeMock })
  })
  return t
}

function resetLangState() {
  langStorage.clear()
  prefsLang = null
  prefsPosts.length = 0
  translateRequests = 0
  translateGate = null
  detailI18n = null
  detailI18nSource = null
  translateReply = {
    i18n: {
      summary: '向量动画入门。',
      why_hn: 'HN 上首推的线性代数直觉课。',
      quote: '最友好的入门介绍。',
    },
    i18nSource: { summary: 'model', why_hn: 'machine', quote: 'model' },
  }
  fetchLog.length = 0
}

async function openWatch(t) {
  const cards = t.root.findAllByType('button').filter((b) => String(b.props.className || '') === 'ht-card')
  const card = cards.find((b) => b.props['data-vid'] === 'a1') || cards[0]
  await act(async () => {
    card.props.onClick()
    await new Promise((r) => setTimeout(r, 20))
  })
}

console.log('\n--- T05 language & translation ---')

/* 浏览器语言决定首次默认 */
{
  resetLangState()
  const t = await mountModule(loadClientModule(makeWin('zh-CN')))
  const body = treeText(t)
  check('T05 browser language defaults to chinese', /首页/.test(body) && /分类/.test(body), body.slice(0, 120))
  await act(async () => {
    t.unmount()
  })
}

/* 已保存的选择优先于浏览器语言 */
{
  resetLangState()
  langStorage.set('ht.lang', 'zh')
  const t = await mountModule(loadClientModule(makeWin('en-US')))
  const body = treeText(t)
  check('T05 stored preference wins over browser', /首页/.test(body) && !/Home \| Categories/.test(body), body.slice(0, 120))
  await act(async () => {
    t.unmount()
  })
}

/* 本机选择与宿主偏好冲突时以本机为准，刷新后语言不被顶回去 */
{
  resetLangState()
  langStorage.set('ht.lang', 'zh')
  prefsLang = 'en'
  const t = await mountModule(loadClientModule(makeWin('en-US')))
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10))
  })
  check('T05 local choice outranks host preference', /首页/.test(treeText(t)), treeText(t).slice(0, 120))
  await act(async () => {
    t.unmount()
  })
}

/* 没有本地记录时跟随宿主偏好 */
{
  resetLangState()
  prefsLang = 'zh'
  const t = await mountModule(loadClientModule(makeWin('en-US')))
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10))
  })
  check('T05 host preference applies without local storage', /首页/.test(treeText(t)), treeText(t).slice(0, 120))
  await act(async () => {
    t.unmount()
  })
}

/* 没有保存过时跟随英文浏览器 */
{
  resetLangState()
  const t = await mountModule(loadClientModule(makeWin('en-US')))
  const body = treeText(t)
  check('T05 english browser defaults to english', /Home/.test(body) && /Categories/.test(body), body.slice(0, 120))
  await act(async () => {
    t.unmount()
  })
}

/* 切换语言：写本地存储 + 写宿主偏好；刷新后仍然生效 */
{
  resetLangState()
  const t = await mountModule(loadClientModule(makeWin('en-US')))
  const langBtn = t.root.findAllByType('button').find((b) => String(b.props.className || '') === 'ht-lang')
  await act(async () => {
    langBtn.props.onClick()
    await Promise.resolve()
  })
  check('T05 language toggle stores local preference', langStorage.get('ht.lang') === 'zh', String(langStorage.get('ht.lang')))
  check('T05 language toggle posts host preference', prefsPosts.some((p) => p && p.lang === 'zh'), JSON.stringify(prefsPosts))
  check('T05 language toggle switches UI', /首页/.test(treeText(t)), treeText(t).slice(0, 120))
  await act(async () => {
    t.unmount()
  })

  const reopened = await mountModule(loadClientModule(makeWin('en-US')))
  check('T05 language survives refresh', /首页/.test(treeText(reopened)), treeText(reopened).slice(0, 120))
  await act(async () => {
    reopened.unmount()
  })
}

/* 详情页：原文先出现，译文异步补齐，并标注模型译/机翻；分享卡片入口消失 */
{
  resetLangState()
  langStorage.set('ht.lang', 'zh')
  let release = null
  translateGate = new Promise((resolve) => {
    release = resolve
  })
  const t = await mountModule(loadClientModule(makeWin('zh-CN')))
  await openWatch(t)
  const initial = treeText(t)
  check('T05 detail shows original immediately', initial.includes('An animated introduction to vectors.'), initial.slice(0, 220))
  check('T05 translation pending state visible', /正在翻译|Translating/.test(initial), initial.slice(0, 220))
  const detailCall = fetchLog.findIndex((line) => /\/video\?vid=a1/.test(line))
  const translateCall = fetchLog.findIndex((line) => /\/video\/translate\?vid=a1/.test(line))
  check(
    'T05 translate runs after the detail request',
    detailCall >= 0 && translateCall > detailCall,
    'detail=' + detailCall + ' translate=' + translateCall,
  )
  check('T05 translation not applied before it arrives', !initial.includes('向量动画入门。'), '')
  check('T05 share card action removed from watch page', !findButton(t, /(分享卡片|Share card)/), '')

  await act(async () => {
    release()
    await new Promise((r) => setTimeout(r, 30))
  })
  const after = treeText(t)
  check('T05 translated summary fills asynchronously', after.includes('向量动画入门。'), after.slice(0, 260))
  check('T05 model provenance label visible', after.includes('模型译'), after.slice(0, 260))
  check('T05 machine provenance label visible', after.includes('机翻'), after.slice(0, 260))
  check('T05 async translation request fired', translateRequests > 0, String(translateRequests))
  await act(async () => {
    t.unmount()
  })
}

/* 宿主已有译文：详情一次到位，不再发翻译请求 */
{
  resetLangState()
  langStorage.set('ht.lang', 'zh')
  detailI18n = { summary: '缓存摘要', why_hn: '缓存推荐理由', quote: '缓存引用' }
  detailI18nSource = { summary: 'model', why_hn: 'machine', quote: 'model' }
  const t = await mountModule(loadClientModule(makeWin('zh-CN')))
  await openWatch(t)
  const body = treeText(t)
  check(
    'T05 cached translation shows without waiting',
    body.includes('缓存摘要') && !body.includes('An animated introduction to vectors.'),
    body.slice(0, 220),
  )
  check('T05 cached translation keeps provenance', body.includes('模型译') && body.includes('机翻'), body.slice(0, 220))
  check('T05 cached translation skips async request', translateRequests === 0, String(translateRequests))
  check(
    'T05 cached detail is requested in chinese',
    fetchLog.some((line) => /\/video\?vid=a1/.test(line) && /lang=zh/.test(line)),
    '',
  )
  await act(async () => {
    t.unmount()
  })
}

/* 英文界面不请求翻译 */
{
  resetLangState()
  const t = await mountModule(loadClientModule(makeWin('en-US')))
  await openWatch(t)
  const body = treeText(t)
  check('T05 english watch keeps original detail', body.includes('An animated introduction to vectors.'), body.slice(0, 200))
  check('T05 english watch skips translation request', translateRequests === 0, String(translateRequests))
  check('T05 english watch has no provenance label', !/模型译|机翻/.test(body), '')
  await act(async () => {
    t.unmount()
  })
}

/* 模型跳过的字段不能把自动补译变成循环请求 */
{
  resetLangState()
  /* 服务端对过短的字段直接跳过，返回里就只剩空值 */
  translateReply = { i18n: { summary: null, why_hn: null, quote: null }, i18nSource: {} }
  const t = await mountModule(loadClientModule(makeWin('zh-CN')))
  await openWatch(t)
  await act(async () => {
    await new Promise((r) => setTimeout(r, 120))
  })
  const firstRound = translateRequests
  await act(async () => {
    await new Promise((r) => setTimeout(r, 400))
  })
  check('T05 empty translation reply does not loop', translateRequests === 1 && firstRound <= 1, 'requests=' + translateRequests)
  await act(async () => {
    t.unmount()
  })
}
console.log('\n--- T06 taste profile ---')

/** 首页网格里卡片标题的显示顺序 */
const gridTitles = (t) => findClass(t, 'ht-card').map((c) => instanceText(c).slice(0, 60))

function instanceText(inst) {
  const out = []
  const walk = (node) => {
    if (node === null || node === undefined) return
    if (typeof node === 'string' || typeof node === 'number') {
      out.push(String(node))
      return
    }
    if (Array.isArray(node)) {
      node.forEach(walk)
      return
    }
    if (node.children) node.children.forEach(walk)
    else if (node.props && node.props.children !== undefined) walk(node.props.children)
  }
  walk(inst)
  return out.join(' | ')
}

/* 有 like：推荐结果只改顺序，不新增一栏，也不在卡片上加理由 */
{
  resetRoute()
  recommendMode = 'likes'
  recommendItems = [
    { ...LIST[2], reason: { kind: 'like', vid: 'a1', title: LIST[0].t } },
    { ...LIST[0], reason: { kind: 'like', vid: 'a1', title: LIST[0].t } },
  ]
  const t = await freshTree()
  await act(async () => {
    await new Promise((r) => setTimeout(r, 80))
  })
  const body = treeText(t)
  check('T06 no separate recommendation section', !/为你推荐|Recommended for you|编辑精选|Editor's picks/.test(body), body.slice(0, 160))
  check('T06 no reason text on cards', !/因为你喜欢|Because you liked/.test(body), body.slice(0, 200))

  const titles = gridTitles(t)
  check('T06 grid keeps one row of cards', findClass(t, 'ht-card').length === 3, String(findClass(t, 'ht-card').length))
  check(
    'T06 recommended videos moved to the front',
    titles[0].includes('Intro to large language models') &&
      titles.some((x) => x.includes('Vectors, the first chapter')),
    titles.join(' / ').slice(0, 200),
  )
  check(
    'T06 non-recommended videos keep their order after the front',
    titles[2].includes('A talk about type systems'),
    titles.join(' / ').slice(0, 200),
  )
  await act(async () => {
    t.unmount()
  })
}

/* 没有 like：冷启动排序同样只改顺序 */
{
  resetRoute()
  recommendMode = 'cold'
  recommendItems = [{ ...LIST[1], reason: { kind: 'hn', score: 22, recommenders: 9 } }]
  const t = await freshTree()
  await act(async () => {
    await new Promise((r) => setTimeout(r, 80))
  })
  const body = treeText(t)
  check('T06 cold start adds no section', !/编辑精选|Editor's picks/.test(body), body.slice(0, 160))
  const titles = gridTitles(t)
  check(
    'T06 cold start moves the pick to the front',
    titles[0].includes('A talk about type systems'),
    titles.join(' / ').slice(0, 200),
  )
  check('T06 cold start keeps every card', findClass(t, 'ht-card').length === 3, String(findClass(t, 'ht-card').length))
  await act(async () => {
    t.unmount()
  })
}

/* 搜索时顺序交回 Host 检索，不再被推荐重排 */
{
  resetRoute()
  recommendMode = 'likes'
  recommendItems = [{ ...LIST[2], reason: { kind: 'like', vid: 'a1', title: LIST[0].t } }]
  const t = await freshTree()
  await act(async () => {
    await new Promise((r) => setTimeout(r, 80))
  })
  const input = t.root.findAllByType('input')[0]
  searchResponder = () => ({
    query: 'vectors',
    total: 1,
    items: [{ ...LIST[0], match: { fields: ['title'], snippet: 'Vectors', snippetField: 'title' } }],
  })
  await act(async () => {
    input.props.onChange({ target: { value: 'vectors' } })
    await new Promise((r) => setTimeout(r, 450))
  })
  const titles = gridTitles(t)
  check('T06 search hits the host endpoint', searchCalls.length > 0, JSON.stringify(searchCalls.slice(-1)))
  check(
    'T06 search results ignore recommendation order',
    titles.length === 1 && titles[0].includes('Vectors, the first chapter'),
    titles.join(' / ').slice(0, 200),
  )
  searchResponder = defaultSearchResponse
  await act(async () => {
    t.unmount()
  })
}

console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'ALL PASS'))
process.exit(failures ? 1 : 0)
