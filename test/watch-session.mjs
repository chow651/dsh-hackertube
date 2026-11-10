/**
 * T04 AI 观看会话的 Host 侧契约测试。
 *
 * 全部走注册路由这个公共 seam，数据来自临时目录里的固定 fixture：
 * 不访问 hackertube.org，也不调用真实 yt-dlp / LLM。
 */
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const VID = 'fixturevid1'
const VID_NO_SUBS = 'fixturevid2'
const VID_COOKIES = 'fixturevid3'
const VID_TIMEOUT = 'fixturevid4'

const dir = mkdtempSync(join(tmpdir(), 'ht-t04-'))
const root = join(dir, '.dsh-hackertube')
const exportDir = join(root, 'export')
const subsDir = join(root, 'subs')
mkdirSync(exportDir, { recursive: true })
mkdirSync(subsDir, { recursive: true })

const videos = [VID, VID_NO_SUBS, VID_COOKIES, VID_TIMEOUT].map((vid, i) => ({
  vid,
  title: 'Raft consensus, fixture ' + (i + 1),
  channel: 'FixtureConf',
  summary: 'A fixture summary about Raft consensus.',
  why_hn: 'HN fixture reason.',
  duration_s: 600,
  views: 1000,
  published: '2020-01-01T00:00:00Z',
  categories: [{ id: 'prog' }],
  tags: ['raft'],
  hn: { recommenders: 9 },
}))
writeFileSync(join(exportDir, 'videos.jsonl'), videos.map((v) => JSON.stringify(v)).join('\n') + '\n')
/* 空 JSONL 用一行空白占位：Host 的 exportFilesPresent() 要求每个导出文件 size > 0，
   0 字节会被判成没下完，进而去拉真实导出包，测试就联网了 */
writeFileSync(join(exportDir, 'mentions.jsonl'), '\n')
writeFileSync(join(exportDir, 'related.jsonl'), '\n')
writeFileSync(join(exportDir, 'embeddings.npy'), 'x')
writeFileSync(join(exportDir, 'embedding_ids.json'), '[]')
writeFileSync(join(exportDir, 'manifest.json'), JSON.stringify({ v: 1, at: Date.now(), bytes: 1 }))

/* 字幕窗口：at=92 时 ±180 秒只包含前两条，第三条必须被排除 */
writeFileSync(
  join(subsDir, VID + '.en.json'),
  JSON.stringify({
    v: 1,
    vid: VID,
    lang: 'en',
    at: Date.now(),
    cues: [
      { start: 70, end: 85, text: 'Raft elects a leader through terms.' },
      { start: 86, end: 100, text: 'A candidate requests votes from peers.' },
      { start: 400, end: 420, text: 'Out of the playhead window.' },
    ],
  }),
)

/* 失败缓存：短时间内在整个进程里复用，避免每个问题都重跑一遍 yt-dlp */
const failAt = Date.now()
writeFileSync(
  join(subsDir, VID_NO_SUBS + '.en.fail.json'),
  JSON.stringify({ reason: 'no-captions', hint: '这条视频没有可用字幕，需要本地转写', at: failAt }),
)
writeFileSync(
  join(subsDir, VID_COOKIES + '.en.fail.json'),
  JSON.stringify({
    reason: 'needs-cookies',
    hint: 'YouTube 要求登录校验。用浏览器扩展导出 Netscape 格式 cookies.txt，放到 ' + join(root, 'cookies.txt') + '，然后重试。',
    cookiePath: join(root, 'cookies.txt'),
    at: failAt,
  }),
)
writeFileSync(
  join(subsDir, VID_TIMEOUT + '.en.fail.json'),
  JSON.stringify({ reason: 'timeout', hint: '字幕获取超时（20 秒），本轮只使用视频简介。', at: failAt }),
)

process.env.DSH_PROFILE_DIR = dir

const { apply } = await import('../index.js?t04-fixture=1')

const llmCalls = []
const fakeLlm = {
  async listProviders() {
    return [{ id: 'fixture-provider' }]
  },
  async listModels() {
    return [{ id: 'fixture-model' }]
  },
  stream(options) {
    llmCalls.push(JSON.parse(JSON.stringify({ provider: options.provider, model: options.model, messages: options.messages })))
    return (async function* () {
      yield { type: 'block-start', blockType: 'text' }
      yield { type: 'text', text: '固定回答' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  },
}

let handler = null
const ctx = {
  get(name) {
    if (name === 'webServer') {
      return {
        register(route) {
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
  inject() {},
}
apply(ctx)

if (!handler) {
  console.error('FAIL: route handler was not registered')
  process.exit(1)
}

function fakeRes() {
  let release
  const done = new Promise((resolve) => {
    release = resolve
  })
  return {
    statusCode: 0,
    headers: {},
    chunks: [],
    body: '',
    done,
    writeHead(code, headers) {
      this.statusCode = code
      this.headers = headers || {}
    },
    write(chunk) {
      this.chunks.push(String(chunk))
      return true
    },
    end(chunk) {
      if (chunk !== undefined) this.chunks.push(String(chunk))
      this.body = this.chunks.join('')
      release()
    },
    flushHeaders() {},
    on() {},
  }
}

async function post(path, payload) {
  const res = fakeRes()
  const req = {
    method: 'POST',
    url: path,
    headers: { host: '127.0.0.1:54321', 'content-type': 'application/json' },
    on(event, cb) {
      if (event === 'data') cb(Buffer.from(JSON.stringify(payload)))
      else if (event === 'end') setImmediate(cb)
    },
  }
  await handler(req, res)
  await res.done
  return res
}

let failures = 0
function check(name, ok, extra = '') {
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (extra ? ' — ' + extra : ''))
  if (!ok) failures += 1
}

function contentTexts(message) {
  if (!message || !Array.isArray(message.content)) return ''
  return message.content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).join('\n')
}

function lastSystemPrompt() {
  const call = llmCalls[llmCalls.length - 1]
  const system = call && call.messages.find((m) => m.role === 'system')
  return contentTexts(system)
}

console.log('--- T04 chat: history + subtitle window ---')
{
  const res = await post('/hackertube/api/chat', {
    vid: VID,
    question: '这段在讲什么？',
    at: 92,
    lang: 'zh',
    stream: true,
    history: [
      { role: 'user', text: '上一个问题' },
      { role: 'assistant', text: '上一个回答' },
    ],
  })
  check('T04 chat 200', res.statusCode === 200, 'got ' + res.statusCode)
  check(
    'T04 chat streams SSE',
    /text\/event-stream/.test(String(res.headers['Content-Type'] || '')),
    String(res.headers['Content-Type']),
  )
  const stageAt = res.body.indexOf('"stage":"subtitles"')
  const answerAt = res.body.indexOf('"stage":"answer"')
  check('T04 visible subtitle stage before answer', stageAt >= 0 && answerAt > stageAt, stageAt + '/' + answerAt)

  const call = llmCalls[llmCalls.length - 1]
  check('T04 llm called', !!call, String(llmCalls.length))
  const roles = call ? call.messages.map((m) => m.role) : []
  check(
    'T04 request carries history in order',
    roles.join(',') === 'system,user,assistant,user',
    roles.join(','),
  )
  const historyUser = call && call.messages[1] ? contentTexts(call.messages[1]) : ''
  const historyAi = call && call.messages[2] ? contentTexts(call.messages[2]) : ''
  const current = call && call.messages[3] ? contentTexts(call.messages[3]) : ''
  check('T04 history user text', historyUser === '上一个问题', historyUser)
  check('T04 history assistant text', historyAi === '上一个回答', historyAi)
  check('T04 current question separate', current === '这段在讲什么？', current)

  const system = lastSystemPrompt()
  check('T04 subtitle line at playhead', system.includes('[1:10] Raft elects a leader through terms.'), system.slice(-320))
  check('T04 subtitle line near playhead', system.includes('[1:26] A candidate requests votes from peers.'), '')
  check('T04 subtitle window is bounded', !system.includes('Out of the playhead window.'), '')
  check('T04 subtitle count reported', res.body.includes('"hasSubtitles":true'), res.body.slice(-240))
}

console.log('\n--- T04 subtitle failure states ---')
{
  const failFile = join(subsDir, VID_NO_SUBS + '.en.fail.json')
  const failMtime = statSync(failFile).mtimeMs
  const res = await post('/hackertube/api/chat', {
    vid: VID_NO_SUBS,
    question: '这段在讲什么？',
    at: 10,
    stream: false,
  })
  const body = JSON.parse(res.body)
  check('T04 no-captions 200', res.statusCode === 200, 'got ' + res.statusCode)
  check('T04 no-captions status', body.subtitle && body.subtitle.status === 'no-captions', JSON.stringify(body.subtitle))
  check('T04 no-captions hasSubtitles false', body.hasSubtitles === false, String(body.hasSubtitles))
  check('T04 no-captions hint visible', /没有可用字幕/.test(String(body.subtitle && body.subtitle.hint)), String(body.subtitle && body.subtitle.hint))
  /* 失败缓存命中时不会再写一次 fail.json（也就不会重跑 yt-dlp） */
  check('T04 failure cache avoids refetch', statSync(failFile).mtimeMs === failMtime, '')
  const system = lastSystemPrompt()
  check('T04 no-captions prompt admits no subtitles', system.includes('没有可用字幕') && system.includes('不要假装'), system.slice(-260))
}

{
  const res = await post('/hackertube/api/chat', {
    vid: VID_COOKIES,
    question: '这段在讲什么？',
    at: 10,
    stream: false,
  })
  const body = JSON.parse(res.body)
  check('T04 cookies status', body.subtitle && body.subtitle.status === 'needs-cookies', JSON.stringify(body.subtitle))
  check(
    'T04 cookies hint carries expected path',
    /cookies\.txt/.test(String(body.subtitle && body.subtitle.hint)) &&
      /cookies\.txt/.test(String(body.subtitle && body.subtitle.cookiePath)),
    String(body.subtitle && (body.subtitle.hint || body.subtitle.cookiePath)),
  )
}

{
  const res = await post('/hackertube/api/chat', {
    vid: VID_TIMEOUT,
    question: '这段在讲什么？',
    at: 10,
    stream: false,
  })
  const body = JSON.parse(res.body)
  check('T04 timeout status', body.subtitle && body.subtitle.status === 'timeout', JSON.stringify(body.subtitle))
  check('T04 timeout hint visible', /超时/.test(String(body.subtitle && body.subtitle.hint)), String(body.subtitle && body.subtitle.hint))
}

console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'ALL PASS') + ' | cache dir: ' + dir)
process.exit(failures ? 1 : 0)
