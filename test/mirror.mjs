/**
 * mirror.js 的测试。
 * 纯函数部分逐条断言；解析器部分用 stub fetch 跑完整链路，不碰网络。
 */

import assert from 'node:assert/strict'
import {
  normalize, hasCJK, commonRun, bigramScore, parseDuration,
  hasSubtitles, isDerived, isOfficialAccount,
  collectEvidence, match, pickBest, RANK,
  createResolver,
} from '../mirror.js'

let passed = 0
const cases = []
const test = (name, fn) => cases.push({ name, fn })

/* ========================= 文本工具 ========================= */

test('normalize 去标点与小写', () => {
  assert.equal(normalize('Hello, World!'), 'helloworld')
  assert.equal(normalize('【熟肉】线性代数'), '熟肉线性代数')
  assert.equal(normalize(null), '')
})

test('hasCJK 判定', () => {
  assert.equal(hasCJK('线性代数'), true)
  assert.equal(hasCJK('Linear Algebra'), false)
  assert.equal(hasCJK('线性 Algebra'), true)
})

test('commonRun 返回子串本身', () => {
  const r = commonRun('How Harley-Davidson Killed Itself', 'Raw Sound of a Harley-Davidson')
  assert.ok(r.len >= 10)
  assert.equal(r.sub.includes('harley'), true)
  assert.equal(hasCJK(r.sub), false)
})

test('commonRun 空串安全', () => {
  assert.deepEqual(commonRun('', 'abc'), { len: 0, sub: '' })
  assert.deepEqual(commonRun('abc', null), { len: 0, sub: '' })
})

test('bigramScore 中文重合', () => {
  const s = bigramScore('线性代数的本质', '线性代数的本质 01')
  assert.ok(s > 0.9, `got ${s}`)
  assert.equal(bigramScore('完全无关的内容', '另一段文字'), 0)
})

test('parseDuration 多形态', () => {
  assert.equal(parseDuration('10:03'), 603)
  assert.equal(parseDuration('1:02:03'), 3723)
  assert.equal(parseDuration(592), 592)
  assert.equal(parseDuration('无效'), null)
})

/* ========================= 类型标记 ========================= */

test('字幕标记识别', () => {
  for (const s of ['【熟肉】某某', '中英字幕版', '官方双语 合集', '【中配】某某', '精校字幕']) {
    assert.equal(hasSubtitles(s), true, s)
  }
  assert.equal(hasSubtitles('生肉 无字幕'), false)
  assert.equal(hasSubtitles('Plain English Title'), false)
})

test('二创词表', () => {
  assert.equal(isDerived('如何降落一艘星舰（改编自某片）'), true)
  assert.equal(isDerived('【解说】这段代码为什么挂'), true)
  assert.equal(isDerived('Reaction: 第一次看'), true)
})

test('「万字解析」不算二创', () => {
  assert.equal(isDerived('【自制熟肉】万字解析：为何抄袭屡禁不止'), false)
})

test('官方号：完全同名', () => {
  assert.equal(isOfficialAccount({ owner: { name: '3Blue1Brown' } }, '3Blue1Brown'), true)
})

test('官方号：带后缀', () => {
  assert.equal(isOfficialAccount({ owner: { name: 'Kurzgesagt-科普' } }, 'Kurzgesagt – In a Nutshell'), true)
  assert.equal(isOfficialAccount({ owner: { name: 'Veritasium真理元素' } }, 'Veritasium'), true)
})

test('官方号：搬运号不误判', () => {
  assert.equal(isOfficialAccount({ owner: { name: '勤劳的视频搬运工人' } }, 'Veritasium'), false)
  assert.equal(isOfficialAccount({ owner: { name: '中文配音看世界' } }, 'Veritasium'), false)
  assert.equal(isOfficialAccount(null, 'Veritasium'), false)
})

/* ========================= 判定 ========================= */

const LOCAL = {
  id: 'dQw4w9WgXcQ',
  title: 'How Harley-Davidson Killed Itself',
  titleZh: '哈雷戴维森是怎样把自己作死的',
  channel: 'FortNine',
  duration: 1000,
  published: '2019-01-01T00:00:00Z',
}

const remote = (o = {}) => ({
  bvid: 'BV1xx411c7mD',
  title: '',
  desc: '',
  dur: 1000,
  pubdate: 1600000000,
  copyright: 2,
  owner: { name: '某人' },
  pages: [{ duration: 1000 }],
  ...o,
})

test('时长精确通过门槛', () => {
  const r = match(remote({ title: 'How Harley-Davidson Killed Itself', dur: 1002 }), LOCAL)
  assert.equal(r.gate.durationOk, true)
  assert.equal(r.ok, true)
})

test('时长差 3 秒拒绝', () => {
  const r = match(remote({ title: 'How Harley-Davidson Killed Itself', dur: 1003 }), LOCAL)
  assert.equal(r.ok, false)
  assert.match(r.reason, /时长不符/)
})

test('早于原片拒绝', () => {
  const early = Date.parse('2019-01-01T00:00:00Z') / 1000 - 90 * 86400
  const r = match(remote({ title: 'How Harley-Davidson Killed Itself', pubdate: early }), LOCAL)
  assert.equal(r.ok, false)
  assert.match(r.reason, /早于原片/)
})

test('短标题不被 LCS 冒充', () => {
  const local = { ...LOCAL, title: 'Sony Releases Stupid Piece Of Shit That Doesnt Function', duration: 200 }
  const r = match(remote({ title: 'STUPID MOVE', dur: 200 }), local)
  assert.equal(r.ok, false)
})

test('品牌名重合不算搬运', () => {
  const r = match(remote({ title: 'Raw Sound of a Harley-Davidson ASMR', dur: 1000 }), LOCAL)
  assert.equal(r.ok, false)
})

test('简介含本条标识 → CONFIRMED', () => {
  const r = match(remote({
    title: '完全不相干的标题',
    desc: '原视频 https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    dur: 1000,
  }), LOCAL)
  assert.equal(r.ok, true)
  assert.equal(r.level, 'CONFIRMED')
})

test('简介指向别的视频 → 否决', () => {
  const r = match(remote({
    title: 'How Harley-Davidson Killed Itself',
    desc: '原视频 https://www.youtube.com/watch?v=ZZZZZZZZZZZ',
    dur: 1000,
  }), LOCAL)
  assert.equal(r.ok, false)
  assert.equal(r.level, 'CONTRADICTED')
})

test('简介声明转载且提频道 → CONFIRMED', () => {
  const r = match(remote({
    title: '某标题',
    desc: '搬运自 FortNine，原视频见频道',
    dur: 1000,
  }), LOCAL)
  assert.equal(r.ok, true)
  assert.equal(r.level, 'CONFIRMED')
})

test('只有转载字样、无频道 → 不成立', () => {
  const r = match(remote({
    title: '某标题',
    desc: '转载自网络',
    dur: 1000,
  }), LOCAL)
  assert.equal(r.ok, false)
})

test('两条弱证据不能凑成命中', () => {
  const local = { ...LOCAL, title: 'Demographic Collapse China Reckoning', channel: 'PolyMatter', duration: 800, titleZh: '' }
  const r = match(remote({
    title: 'iBlender 中文版插件教程',
    desc: '转载自 youtube.com 某处，来源网络',
    dur: 800,
  }), local)
  assert.equal(r.ok, false)
})

test('二创无凭据时被排除', () => {
  const local = { ...LOCAL, title: 'How Not to Land an Orbital Rocket Booster', channel: 'SpaceX', duration: 300, titleZh: '如何正确降落轨道火箭' }
  const r = match(remote({
    title: '如何降落一艘星舰（改编自How Not to Land an Orbital Rocket Booster）',
    dur: 300,
  }), local)
  assert.equal(r.ok, false)
  assert.equal(r.level, 'DERIVED')
})

test('二创词有凭据时不误杀', () => {
  const local = { ...LOCAL, title: 'How Not to Land an Orbital Rocket Booster', channel: 'SpaceX', duration: 300 }
  const r = match(remote({
    title: '如何降落一艘星舰（改编自How Not to Land an Orbital Rocket Booster）',
    desc: 'source https://youtu.be/dQw4w9WgXcQ',
    dur: 300,
  }), local)
  assert.equal(r.ok, true)
  assert.equal(r.level, 'CONFIRMED')
})

test('分P命中可替代总时长', () => {
  const local = { ...LOCAL, title: 'Vectors | Chapter 1', channel: '3Blue1Brown', duration: 592, titleZh: '线性代数的本质 第1章' }
  const r = match(remote({ title: 'Vectors | Chapter 1', dur: 9639 }), local, { pageHit: { index: 2, duration: 592 } })
  assert.equal(r.ok, true)
  assert.ok(r.hits.some((h) => h.code === 'E5'))
})

/* ========================= 选取 ========================= */

const cand = (title, play, up, extra = {}) => ({
  bvid: 'BV' + Math.random().toString(36).slice(2, 12),
  play,
  remote: { title, owner: { name: up }, stat: { view: play } },
  ...extra,
})

test('官方号绝对优先，哪怕零播放', () => {
  const best = pickBest([
    cand('【中英字幕】某标题', 764272, '胭脂泪叹'),
    cand('某标题', 8, 'Veritasium真理元素'),
  ], 'Veritasium')
  assert.equal(best.rank, RANK.OFFICIAL)
  assert.equal(best.label, '官方')
  assert.equal(best.play, 8)
})

test('无官方时中字优先', () => {
  const best = pickBest([
    cand('Plain English Title', 50000, '搬运工甲'),
    cand('【中字】某标题', 300, '搬运工乙'),
  ], 'SomeChannel')
  assert.equal(best.rank, RANK.LOCALIZED)
  assert.equal(best.label, '中字')
})

test('中文标题零播放也算本地化', () => {
  const best = pickBest([cand('【中文标题】某视频', 5, 'u')], 'SomeChannel')
  assert.equal(best.rank, RANK.LOCALIZED)
  assert.equal(best.label, '中文')
})

test('高播放英文原题也算本地化', () => {
  const best = pickBest([cand('English Title Here', 50000, 'u')], 'SomeChannel')
  assert.equal(best.rank, RANK.LOCALIZED)
})

test('英文原题低播放落 RAW 但照样返回', () => {
  const best = pickBest([cand('Title B', 20, 'u')], 'SomeChannel')
  assert.equal(best.rank, RANK.RAW)
  assert.equal(best.label, '转载')
})

test('转载不因低播放被丢弃', () => {
  const best = pickBest([cand('English Title', 3, 'u')], 'SomeChannel')
  assert.ok(best)
})

test('同档内按播放量降序', () => {
  const best = pickBest([
    cand('【中字】A', 100, 'u1'),
    cand('【中字】B', 9000, 'u2'),
    cand('【中字】C', 500, 'u3'),
  ], 'SomeChannel')
  assert.equal(best.play, 9000)
})

test('备选保留在 alternates', () => {
  const best = pickBest([
    cand('【中字】A', 100, 'u1'),
    cand('【中字】B', 9000, 'u2'),
  ], 'SomeChannel')
  assert.equal(best.alternates.length, 1)
})

test('空候选返回 null', () => {
  assert.equal(pickBest([], 'x'), null)
  assert.equal(pickBest(null, 'x'), null)
})

/* ========================= 解析器（stub fetch） ========================= */

function makeHash() {
  /* 测试用占位哈希：不要求真 md5，只要稳定即可 */
  return (s) => {
    let h = 0
    for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0
    return h.toString(16)
  }
}

function stubFetch(routes) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url: String(url), init })
    for (const r of routes) {
      if (String(url).includes(r.match)) {
        const payload = JSON.stringify(r.body)
        return {
          status: r.status ?? 200,
          text: async () => payload,
          json: async () => JSON.parse(payload),
        }
      }
    }
    const payload = '{"code":-404}'
    return { status: 404, text: async () => payload, json: async () => JSON.parse(payload) }
  }
  impl.calls = calls
  return impl
}

const HANDSHAKE = [
  { match: '/x/frontend/finger/spi', body: { code: 0, data: { b_3: 'B3', b_4: 'B4' } } },
  {
    match: '/x/web-interface/nav',
    body: {
      code: -101,
      data: { wbi_img: { img_url: 'https://i0.hdslb.com/bfs/wbi/abcdef0123456789.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/9876543210fedcba.png' } },
    },
  },
]

test('解析器：命中并写入缓存', async () => {
  const store = new Map()
  const fetchImpl = stubFetch([
    ...HANDSHAKE,
    {
      match: '/search/type',
      body: {
        code: 0,
        data: {
          result: [
            { bvid: 'BV1aa411c7mD', title: '【中字】How Harley-Davidson Killed Itself', duration: '16:40', play: 5000 },
          ],
        },
      },
    },
    {
      match: '/x/web-interface/view',
      body: {
        code: 0,
        data: {
          bvid: 'BV1aa411c7mD',
          title: '【中字】How Harley-Davidson Killed Itself',
          desc: '',
          duration: 1000,
          pubdate: 1600000000,
          copyright: 2,
          owner: { name: '某搬运号' },
          stat: { view: 5000 },
          pages: [{ duration: 1000 }],
        },
      },
    },
  ])

  const resolver = createResolver({
    fetchImpl,
    hashFn: makeHash(),
    cacheFile: '/tmp/x.json',
    readFile: async (p) => { if (!store.has(p)) throw new Error('nope'); return store.get(p) },
    writeFile: async (p, v) => { store.set(p, v) },
    mkdir: async () => {},
  })

  const r = await resolver.resolve(LOCAL)
  assert.ok(r, 'should resolve')
  assert.equal(r.bvid, 'BV1aa411c7mD')
  assert.equal(r.label, '中字')
  assert.equal(r.url, 'https://www.bilibili.com/video/BV1aa411c7mD')
  await new Promise((x) => setTimeout(x, 10))
  assert.ok(store.has('/tmp/x.json'), 'cache should be written')
  const parsed = JSON.parse(store.get('/tmp/x.json'))
  assert.equal(parsed.entries[LOCAL.id].status, 'found')
})

test('解析器：缓存命中不重复请求', async () => {
  const store = new Map()
  const fetchImpl = stubFetch([
    ...HANDSHAKE,
    { match: '/search/type', body: { code: 0, data: { result: [] } } },
  ])
  const resolver = createResolver({
    fetchImpl,
    hashFn: makeHash(),
    cacheFile: '/tmp/y.json',
    readFile: async () => { throw new Error('none') },
    writeFile: async (p, v) => { store.set(p, v) },
    mkdir: async () => {},
  })

  await resolver.resolve(LOCAL)
  const before = fetchImpl.calls.length
  const second = await resolver.resolve(LOCAL)
  assert.equal(second, null)
  /* 第二次走内存/缓存，不应新增搜索请求 */
  assert.equal(fetchImpl.calls.length, before)
})

test('解析器：无候选时写 none 状态', async () => {
  const store = new Map()
  const fetchImpl = stubFetch([
    ...HANDSHAKE,
    { match: '/search/type', body: { code: 0, data: { result: [] } } },
  ])
  const resolver = createResolver({
    fetchImpl,
    hashFn: makeHash(),
    cacheFile: '/tmp/z.json',
    readFile: async () => { throw new Error('none') },
    writeFile: async (p, v) => { store.set(p, v) },
    mkdir: async () => {},
  })
  const r = await resolver.resolve(LOCAL)
  assert.equal(r, null)
  await new Promise((x) => setTimeout(x, 10))
  const parsed = JSON.parse(store.get('/tmp/z.json'))
  assert.equal(parsed.entries[LOCAL.id].status, 'none')
})

test('解析器：非法 id 直接返回 null', async () => {
  const resolver = createResolver({ fetchImpl: stubFetch([]), hashFn: makeHash() })
  assert.equal(await resolver.resolve({ id: 'x', title: 't', duration: 100 }), null)
  assert.equal(await resolver.resolve({ id: 'dQw4w9WgXcQ', title: '', duration: 100 }), null)
})

test('解析器：并发调用合并成一次', async () => {
  const fetchImpl = stubFetch([
    ...HANDSHAKE,
    { match: '/search/type', body: { code: 0, data: { result: [] } } },
  ])
  const resolver = createResolver({
    fetchImpl,
    hashFn: makeHash(),
    readFile: async () => { throw new Error('none') },
  })
  const [a, b] = await Promise.all([resolver.resolve(LOCAL), resolver.resolve(LOCAL)])
  assert.equal(a, null)
  assert.equal(b, null)
  const searchCalls = fetchImpl.calls.filter((c) => c.url.includes('/search/type')).length
  /* 三个查询词 × 两页 = 6，没有翻倍就说明合并生效 */
  assert.equal(searchCalls, 6, `got ${searchCalls}`)
})

test('解析器：invalidate 清缓存', async () => {
  const store = new Map()
  const fetchImpl = stubFetch([
    ...HANDSHAKE,
    { match: '/search/type', body: { code: 0, data: { result: [] } } },
  ])
  const resolver = createResolver({
    fetchImpl,
    hashFn: makeHash(),
    cacheFile: '/tmp/w.json',
    readFile: async () => { throw new Error('none') },
    writeFile: async (p, v) => { store.set(p, v) },
    mkdir: async () => {},
  })
  await resolver.resolve(LOCAL)
  await new Promise((x) => setTimeout(x, 10))
  assert.ok(JSON.parse(store.get('/tmp/w.json')).entries[LOCAL.id])
  await resolver.invalidate(LOCAL.id)
  await new Promise((x) => setTimeout(x, 10))
  assert.equal(JSON.parse(store.get('/tmp/w.json')).entries[LOCAL.id], undefined)
})

/* ========================= 执行 ========================= */

let failed = 0
for (const c of cases) {
  try {
    await c.fn()
    passed += 1
    console.log(`  ✓ ${c.name}`)
  } catch (e) {
    failed += 1
    console.log(`  ✗ ${c.name}`)
    console.log(`      ${String(e.message).split('\n')[0]}`)
  }
}
console.log(`\n${passed}/${cases.length} 通过${failed ? `，${failed} 失败` : ''}`)
process.exit(failed ? 1 : 0)
