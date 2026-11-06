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
global.fetch = async (url) => {
  fetchCalls += 1
  fetchLog.push(String(url))
  const u = String(url)
  let body = LIST
  if (u.includes('/browse') || u.includes('/taxonomy')) body = TAX
  else if (u.includes('/video')) body = DETAIL
  else if (u.includes('/related')) body = RELATED
  else if (u.includes('/deps')) body = depsBody
  else if (u.includes('/config')) body = { origin: 'http://127.0.0.1:54321', authUrl: null, mediaOrigin: 'http://127.0.0.1:18090' }
  else if (u.includes('/prefs')) body = { likes: [], later: [], seen: [] }
  else if (u.includes('/titles')) body = { entries: {} }
  else if (u.includes('/mt')) body = { text: '' }
  return { ok: true, status: 200, json: async () => body }
}

const listCalls = () => fetchLog.filter((u) => u.indexOf('/hackertube/api/list') >= 0).length

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

const tree = await render()
const json = () => JSON.stringify(tree.toJSON())

check('root container rendered', json().includes('ht-root'), '')
check('data fetched', listCalls() >= 1, listCalls() + ' list calls')

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

const body = text()
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
async function openFirstCard(t) {
  const card = t.root.findAllByType('button').find((b) => String(b.props.className || '') === 'ht-card')
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

console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'ALL PASS'))
process.exit(failures ? 1 : 0)
