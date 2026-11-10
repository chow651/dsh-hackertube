/**
 * HackerTube Client 半 —— 经典脚本，经 __ModuleLoader__ 注入。
 *
 * 落点：左栏面板图标（sidebar.panellist，id=hackertube）与主区面板
 * （main，key=hackertube）成对绑定，点图标即切到面板；会话页原生右侧栏
 * 另投一个 tab（sidebar.right.pane.tab，id=dsh-hackertube:right），
 * 不依赖 dsh-better-sidebar 的服务。
 * 数据全部来自 Host 的 /hackertube/api/*，浏览器不直接碰上游。
 */
window.__ModuleLoader__.load({
  id: 'dsh-hackertube',
  factory(require) {
    /* 最早的信号：factory 被调用本身就说明浏览器加载了这个模块 */
    try {
      fetch('/hackertube/api/beacon', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ at: Date.now(), phase: 'factory-enter' }),
        keepalive: true,
      }).catch(() => {})
    } catch {
      /* 回执失败不影响功能 */
    }

    function beacon(phase, extra) {
      try {
        fetch('/hackertube/api/beacon', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(Object.assign({ at: Date.now(), phase }, extra || {})),
          keepalive: true,
        }).catch(() => {})
      } catch {
        /* 回执失败不影响功能 */
      }
    }

    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useMemo, useRef } = React

    beacon('factory-body', {
      hasReact: !!React,
      hasCreateElement: typeof h === 'function',
      hasUseState: typeof useState === 'function',
    })

    /* 模块级缓存：面板卸载后重开不重复拉取 */
    const mem = {
      list: null,
      listP: null,
      status: null,
      tax: null,
      taxP: null,
      detail: new Map(),
      origin: undefined,
      lang: null,
      mediaOrigin: null,
      titles: {},
      titlesP: null,
      taxLang: null,
      /* 观看会话按视频 id 存：播放位置不能被下一条视频继承，暂停后也要保留 */
      sessions: new Map(),
      /* 落盘的播放进度：vid -> { t, d, at }，用于续播与历史列表 */
      progress: new Map(),
      progressP: null,
      playheadSubs: new Set(),
      /* 播放错误按视频 id 存：中转页的 yt-error / api-error 会先到全局监听，再由观看页订阅 */
      playback: new Map(),
      playbackSubs: new Set(),
      /* 电视里焦点落在播放器 iframe 时，方向键由中转页转发过来，按当前挂载的电视视图消费 */
      tvNavSubs: new Set(),
      /* 电视里左右键调进度：面板把秒数转给中转页里的播放器 */
      tvSeekSubs: new Set(),
      /* 电视里空格暂停 / 继续：同样转给中转页，焦点在面板上时也能用 */
      tvPlaySubs: new Set(),
      /* 一条放完自动接下一台：中转页的 onStateChange 会发 __ht:"state" */
      tvEndSubs: new Set(),
      /* 作者不允许内嵌的视频不进电视：yt-error 101/150 触发，会话内同步去重 */
      tvBlocked: new Set(),
      /* 当前电视视图订阅播放错误，命中就把这条永久移出片库并换台 */
      tvErrorSubs: new Set(),
      /* 播放器里点了「更多视频」，YouTube 在自己的 iframe 里换了片：yt-pick 触发 */
      tvPickSubs: new Set(),
      activeWatchVid: null,
    }

    function watchSession(vid) {
      let session = mem.sessions.get(vid)
      if (!session) {
        session = { playhead: null }
        mem.sessions.set(vid, session)
      }
      return session
    }

    /* ---------------- 观看地址状态 ----------------
     * 面板没有独立路由，用 hash 里的 ht-watch 片段保存当前视频。
     * 打开视频时 pushState，相关视频用 replaceState，浏览器后退走 popstate。
     */
    const WATCH_HASH_RE = /(?:[#&])ht-watch=([A-Za-z0-9_-]{1,20})/

    function readWatchVid() {
      try {
        const loc = typeof window !== 'undefined' && window.location ? window.location : null
        if (!loc) return null
        const m = WATCH_HASH_RE.exec(String(loc.hash || ''))
        return m ? m[1] : null
      } catch {
        return null
      }
    }

    function watchHashFor(vid, current) {
      const rest = String(current || '')
        .replace(/[#&]?ht-watch=[A-Za-z0-9_-]{1,20}/g, '')
        .replace(/^#+/, '')
        .replace(/^&+|&+$/g, '')
      if (!vid) return rest ? '#' + rest : ''
      return '#' + (rest ? rest + '&' : '') + 'ht-watch=' + vid
    }

    /** 写入观看地址；push=true 时新增历史条目，否则原地替换。返回是否成功。 */
    function setWatchHash(vid, mode) {
      try {
        const w = typeof window !== 'undefined' ? window : null
        const loc = w && w.location ? w.location : null
        if (!loc) return false
        const next = watchHashFor(vid, loc.hash)
        const url = String(loc.pathname || '') + String(loc.search || '') + next
        const hist = w.history || null
        if (mode === 'push' && hist && typeof hist.pushState === 'function') {
          hist.pushState({ htWatch: vid || null }, '', url)
          return true
        }
        if (hist && typeof hist.replaceState === 'function') {
          hist.replaceState({ htWatch: vid || null }, '', url)
          return true
        }
        if (typeof loc.hash === 'string') {
          loc.hash = next
          return true
        }
      } catch {
        /* 自定义协议下 history 可能受限：至少把 hash 改掉，让地址仍可恢复 */
        try {
          const w = typeof window !== 'undefined' ? window : null
          if (w && w.location) w.location.hash = watchHashFor(vid, w.location.hash)
        } catch {
          /* 两个通道都不可用就不强求地址状态 */
        }
      }
      return false
    }

    function setPlaybackError(vid, error) {
      if (!vid) return
      if (error) mem.playback.set(vid, error)
      else mem.playback.delete(vid)
      for (const fn of mem.playbackSubs) {
        try {
          fn(vid, error)
        } catch {
          /* 单个订阅失败不影响其它观看页 */
        }
      }
    }

    /** 把 YouTube 的 onError 数字码翻译成用户能判断的下一步。 */
    function playbackErrorCopy(error, lang) {
      if (!error || error.kind === 'api-error') {
        return {
          title: tx(lang, 'YouTube 播放器脚本加载失败', 'Could not load the YouTube player script'),
          hint: tx(
            lang,
            '通常是网络或浏览器拦截了 youtube.com 的脚本。可以在 YouTube 上直接观看，或尝试本地直连。',
            'The youtube.com script was blocked by the network or browser. Open it on YouTube, or try a local stream.',
          ),
        }
      }
      const code = Number(error.code)
      const hasCode = error.code !== null && error.code !== undefined && Number.isFinite(code)
      const known = {
        2: ['视频 ID 无效', 'Invalid video ID'],
        5: ['浏览器无法播放这个 HTML5 视频', 'This HTML5 video cannot be played in this browser'],
        100: ['视频不存在或已删除', 'The video is missing or has been removed'],
        101: ['视频作者不允许内嵌播放', 'The owner does not allow embedded playback'],
        150: ['视频作者不允许内嵌播放', 'The owner does not allow embedded playback'],
        153: ['YouTube 无法确认播放来源（错误 153）', 'YouTube could not verify the playback origin (error 153)'],
      }
      const label = known[code] || [
        tx(lang, 'YouTube 拒绝了内嵌播放', 'YouTube refused embedded playback') + (hasCode ? '（' + code + '）' : ''),
        'YouTube refused embedded playback' + (hasCode ? ' (error ' + code + ')' : ''),
      ]
      return {
        title: lang === 'zh' ? label[0] : label[1],
        hint: tx(
          lang,
          '可以重试播放器、在 YouTube 上直接观看，或尝试用本机 yt-dlp 直连播放。',
          'Retry the player, open it on YouTube, or try a local stream through yt-dlp on this machine.',
        ),
      }
    }

    const GRID_STEP = 60
    /* 配合 CSS content-visibility 把离屏卡片的布局成本降到接近零 */
    const GRID_CAP = 2000

    /** 界面文案：中文原句 + 英文对照，调用处不必写三元表达式 */
    const tx = (lang, zh, en) => (lang === 'zh' ? zh : en)

    /** 备用片源的档位标：官方 / 中字 / 中文 / 转载 */
    function mirrorTag(lang, label) {
      if (lang === 'zh') return label
      if (label === '官方') return 'Official'
      if (label === '中字') return 'Subbed'
      if (label === '中文') return 'Translated'
      return 'Repost'
    }

    /* ---------------- 语言偏好 ---------------- */

    const LANG_STORAGE_KEY = 'ht.lang'
    /* 详情译文的等待上限：模型慢就放弃本轮，原文照旧可读 */
    const TR_BUDGET_MS = 25000
    /* 电视里左右键的快进/快退秒数，跟 YouTube 网页端一致 */
    const TV_SEEK_STEP = 5

    function normalizeLang(value) {
      return String(value || '').toLowerCase().startsWith('zh') ? 'zh' : 'en'
    }

    /** 本地偏好先于浏览器语言；dsh-app:// 下写不进去时静默退回浏览器语言。 */
    function readStoredLang() {
      try {
        const v = localStorage.getItem(LANG_STORAGE_KEY)
        return v === 'zh' || v === 'en' ? v : null
      } catch {
        return null
      }
    }

    function browserLang() {
      try {
        /* DSH 宿主若明确声明中文，优先按它走；否则读浏览器语言列表 */
        const docLang = typeof document !== 'undefined' && document.documentElement ? document.documentElement.lang : ''
        if (docLang && String(docLang).toLowerCase().startsWith('zh')) return 'zh'
        const nav =
          (typeof window !== 'undefined' && window.navigator) ||
          (typeof navigator !== 'undefined' ? navigator : null)
        const list = nav && Array.isArray(nav.languages) && nav.languages.length ? nav.languages : nav ? [nav.language] : []
        for (const item of list) {
          const v = String(item || '').toLowerCase()
          if (v) return normalizeLang(v)
        }
      } catch {
        /* 无 navigator 的环境按英文处理 */
      }
      return 'en'
    }

    function initialLang() {
      return readStoredLang() || browserLang()
    }

    function rememberLang(next) {
      mem.lang = next
      try {
        localStorage.setItem(LANG_STORAGE_KEY, next)
      } catch {
        /* 私密模式写不进去，至少本次会话生效 */
      }
      try {
        void fetch('/hackertube/api/prefs', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ lang: next }),
        }).catch(() => {})
      } catch {
        /* 离线时只留本地副本 */
      }
    }

    /* ---------------- 取数 ---------------- */

    function getJSON(url) {
      /* 不用 credentials: same-origin —— 自定义协议下它可能让请求发不出去；
         同源默认就会带 cookie */
      return fetch(url).then((r) => {
        if (!r.ok) throw new Error('HTTP ' + r.status)
        /* Host 在每次响应头里下发真实 HTTP 地址，dsh-app:// 下也能拿到 */
        try {
          const o = r.headers.get('X-Hackertube-Origin')
          if (o && !mem.origin) mem.origin = o
        } catch {
          /* 读不到头不影响数据 */
        }
        return r.json()
      })
    }

    /* ---------------- 播放进度 ---------------- */

    /** 面板打开时拉一次全部进度，之后靠本地更新，避免每开一条视频打一次请求。 */
    function ensureProgress() {
      if (mem.progressP) return mem.progressP
      mem.progressP = getJSON('/hackertube/api/progress')
        .then((d) => {
          const entries = d && d.entries && typeof d.entries === 'object' ? d.entries : {}
          mem.progress = new Map(Object.entries(entries))
          return mem.progress
        })
        .catch(() => mem.progress)
      return mem.progressP
    }

    /** 续播点：太靠前没有意义，差 20 秒到结尾就不算。 */
    function resumeAt(vid, duration) {
      const entry = mem.progress.get(vid)
      if (!entry) return 0
      const t = Number(entry.t) || 0
      const d = Number(duration) || Number(entry.d) || 0
      if (t < 15) return 0
      if (d > 0 && t > d - 20) return 0
      return Math.floor(t)
    }

    function rememberProgress(vid, position) {
      if (!vid || !position) return
      const t = Number(position.t) || 0
      const d = Number(position.d) || 0
      if (t < 15) return
      if (d > 0 && t > d - 20) {
        /* 看完了就把进度清掉，历史里不再显示「继续观看」 */
        mem.progress.delete(vid)
        return
      }
      mem.progress.set(vid, { t: Math.round(t), d: Math.round(d), at: Date.now() })
    }

    function saveProgress(vid, position) {
      rememberProgress(vid, position)
      const entry = mem.progress.get(vid)
      if (!entry) return
      try {
        void fetch('/hackertube/api/progress', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ vid, t: entry.t, d: entry.d }),
          keepalive: true,
        }).catch(() => {})
      } catch {
        /* 离线时只留内存副本 */
      }
    }

    function loadList() {
      if (mem.list) return Promise.resolve(mem.list)
      if (!mem.listP) {
        mem.listP = getJSON('/hackertube/api/list')
          .then((d) => {
            if (!Array.isArray(d) || !d.length) throw new Error('列表为空')
            mem.list = d
            return d
          })
          .catch((e) => {
            mem.listP = null
            throw e
          })
      }
      return mem.listP
    }

    /** 首屏阶段状态：export → metadata → comments → ready；旧缓存时 stale=true。 */
    function loadListStatus() {
      return getJSON('/hackertube/api/list/status').catch(() => null)
    }

    /** 后台元信息补齐后，绕过 mem.list 重新取一次完整列表。 */
    function refreshList() {
      return getJSON('/hackertube/api/list')
        .then((d) => {
          if (!Array.isArray(d) || !d.length) return null
          mem.list = d
          return d
        })
        .catch(() => null)
    }

    function loadTaxonomy(lang) {
      const key = lang === 'zh' ? 'zh' : 'en'
      if (mem.tax && mem.taxLang === key) return Promise.resolve(mem.tax)
      if (!mem.taxP || mem.taxLang !== key) {
        mem.taxLang = key
        const q = key === 'zh' ? '/hackertube/api/taxonomy?lang=zh&translate=1' : '/hackertube/api/browse'
        mem.taxP = getJSON(q)
          .then((d) => {
            mem.tax = d
            return d
          })
          .catch((e) => {
            mem.taxP = null
            throw e
          })
      }
      return mem.taxP
    }

    /** 标题译文表：界面显示用；Host 检索读同一份缓存，中文查询靠它扩展 */
    function loadTitles() {
      if (mem.titlesP) return mem.titlesP
      mem.titlesP = getJSON('/hackertube/api/titles?lang=zh&translate=1')
        .then((d) => {
          mem.titles = (d && d.entries) || {}
          return mem.titles
        })
        .catch(() => {
          mem.titlesP = null
          return {}
        })
      return mem.titlesP
    }

    function titleOf(item, lang) {
      if (lang === 'zh' && mem.titles && mem.titles[item.v]) return mem.titles[item.v]
      return item.t || tx(lang, '(无标题)', '(untitled)')
    }

    /** 中文详情比原文多带一份缓存译文，缓存键必须带语言，两种结果不能互相顶掉。 */
    function detailCacheKey(vid, lang) {
      return lang === 'zh' ? vid + ':zh' : vid
    }

    /**
     * 详情只回原文和已有的译文缓存，Host 不会在这里等模型或机翻，
     * 所以带上 lang=zh 不会拖慢首屏，只是让已翻过的视频直接显示译文。
     */
    function loadDetail(vid, lang) {
      const key = detailCacheKey(vid, lang)
      const hit = mem.detail.get(key)
      if (hit) return Promise.resolve(hit)
      const q = '/hackertube/api/video?vid=' + encodeURIComponent(vid) + (lang === 'zh' ? '&lang=zh' : '')
      return getJSON(q).then((d) => {
        if (mem.detail.size > 40) mem.detail.delete(mem.detail.keys().next().value)
        mem.detail.set(key, d)
        return d
      })
    }

    /**
     * 桌面端页面跑在 dsh-app:// 自定义协议下，Chromium 不把它当作安全上下文，
     * 任何 iframe 请求都不会带 Referer，YouTube 就报 153。
     * 拿到 Host 的 http origin 后，用绝对地址把中转页放回 HTTP 上下文。
     */
    function loadOrigin() {
      if (mem.origin) return Promise.resolve(mem.origin)
      /* 等任何一次数据响应把头里的 origin 带回来，最多两秒 */
      return new Promise((resolve) => {
        let tries = 0
        const tick = () => {
          if (mem.origin) return resolve(mem.origin)
          if (tries >= 20) return resolve(null)
          tries += 1
          setTimeout(tick, 100)
        }
        tick()
      })
    }

    /** 插件自起的免认证中转服务器地址，播放器要靠它落到 HTTP 安全上下文。
     *  每次都向 Host 要一次，避免插件重载后端口变化时前端还拿着旧地址。 */
    function loadMediaOrigin() {
      return new Promise((resolve) => {
        let tries = 0
        const attempt = () => {
          if (tries >= 30) return resolve(mem.mediaOrigin || null)
          tries += 1
          getJSON('/hackertube/api/config')
            .then((d) => {
              if (d && d.mediaOrigin) {
                mem.mediaOrigin = String(d.mediaOrigin)
                return resolve(mem.mediaOrigin)
              }
              setTimeout(attempt, 150)
            })
            .catch(() => setTimeout(attempt, 150))
        }
        attempt()
      })
    }

    /* ---------------- 格式化 ---------------- */

    function fmtDur(sec) {
      const s = Math.max(0, Math.round(Number(sec) || 0))
      const hh = Math.floor(s / 3600)
      const mm = Math.floor((s % 3600) / 60)
      const ss = s % 60
      const pad = (n) => (n < 10 ? '0' + n : String(n))
      return hh ? hh + ':' + pad(mm) + ':' + pad(ss) : mm + ':' + pad(ss)
    }

    function fmtCount(n, lang = 'en') {
      const v = Number(n) || 0
      /* 截断而非四舍五入：YouTube 把 12 988 516 显示成 12M，不是 13M */
      const trim = (x) => {
        const s = x.toFixed(1)
        return s.endsWith('.0') ? s.slice(0, -2) : s
      }
      if (lang === 'zh') {
        /* 中文用万/亿，不混用 K/M/B */
        if (v >= 1e8) return trim(Math.floor(v / 1e6) / 100) + ' 亿'
        if (v >= 1e4) return Math.floor(v / 1e4) + ' 万'
        return String(v)
      }
      if (v >= 1e9) return trim(Math.floor(v / 1e8) / 10) + 'B'
      if (v >= 1e6) return trim(Math.floor(v / 1e5) / 10) + 'M'
      if (v >= 1e3) return trim(Math.floor(v / 1e2) / 10) + 'K'
      return String(v)
    }

    function fmtAgo(iso, lang = 'zh') {
      if (!iso) return ''
      const t = Date.parse(iso)
      if (!t) return ''
      const days = Math.floor((Date.now() - t) / 86400000)
      if (days < 1) return tx(lang, '今天', 'today')
      if (days < 30) return tx(lang, days + ' 天前', days + (days === 1 ? ' day ago' : ' days ago'))
      const months = Math.floor(days / 30)
      if (months < 12) return tx(lang, months + ' 个月前', months + (months === 1 ? ' month ago' : ' months ago'))
      const years = Math.floor(months / 12)
      return tx(lang, years + ' 年前', years + (years === 1 ? ' year ago' : ' years ago'))
    }

    /* 简介卡头部用的两个枚举标签，中文下必须译，英文下原样 */
    const CT_ZH = {
      course: '课程',
      talk: '演讲',
      lecture: '讲座',
      explainer: '科普',
      documentary: '纪录片',
      interview: '访谈',
      tutorial: '教程',
      commentary: '评论',
      demo: '演示',
      podcast: '播客',
      comedy: '喜剧',
      news: '新闻',
      music: '音乐',
      other: '其他',
    }
    const LV_ZH = { intro: '入门', intermediate: '进阶', general: '通用', advanced: '高阶' }
    const MATCH_FIELD_ZH = {
      title: '标题',
      title_zh: '中文标题',
      channel: '频道',
      tags: '标签',
      categories: '分类',
      topic: '主题',
      summary: '摘要',
      why_hn: 'HN 推荐理由',
    }

    /* ---------------- 样式 ---------------- */

    const CSS = `
.ht-root{height:100%;min-height:0;display:flex;flex-direction:column;overflow:hidden;
  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);
  font:14px/1.4 Roboto,"Segoe UI",-apple-system,BlinkMacSystemFont,Arial,sans-serif}
.ht-head{flex:none;display:flex;align-items:center;gap:12px;padding:14px 24px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.ht-brand{display:flex;align-items:center;gap:8px;font-weight:700;font-size:17px;letter-spacing:-.4px;white-space:nowrap}
.ht-brand b{color:#ff6600;font-weight:700}
.ht-lang{flex:none;height:32px;min-width:52px;padding:0 12px;border-radius:16px;cursor:pointer;  font:inherit;font-size:13px;border:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.ht-lang:hover{background:var(--dsw-alias-bg-layer-2)}
.ht-shuffle{flex:none;width:32px;height:32px;padding:0;border-radius:16px;cursor:pointer;font:inherit;display:inline-grid;place-items:center;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);transition:color .16s cubic-bezier(.32,.72,0,1),background .16s cubic-bezier(.32,.72,0,1),transform .16s cubic-bezier(.32,.72,0,1)}
.ht-shuffle:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.ht-shuffle:active{transform:rotate(-18deg)}
.ht-search{flex:1;max-width:640px;display:flex;min-width:0;position:relative;
  border:1px solid var(--dsw-alias-border-l1);border-radius:18px;overflow:hidden;
  background:var(--dsw-alias-bg-layer-1);
  transition:border-color .18s cubic-bezier(.32,.72,0,1),box-shadow .18s cubic-bezier(.32,.72,0,1)}
.ht-search:hover{border-color:var(--dsw-alias-border-l2)}
/* 焦点画在整个输入框上，输入区与按钮不再各自描边，避免左右两截 */
.ht-search:focus-within{border-color:rgba(255,102,0,.55);box-shadow:0 0 0 3px rgba(255,102,0,.12)}
.ht-search input{flex:1;min-width:0;height:34px;padding:0 14px;font:inherit;font-size:14px;color:inherit;
  background:none;border:0;outline:none}
.ht-search input::-webkit-search-cancel-button,
.ht-search input::-webkit-search-decoration{-webkit-appearance:none;appearance:none;display:none}
.ht-search button{width:48px;height:34px;border:0;cursor:pointer;background:none;
  color:var(--dsw-alias-label-secondary);display:grid;place-items:center;
  transition:color .16s cubic-bezier(.32,.72,0,1)}
.ht-search button:hover{color:var(--dsw-alias-label-primary)}
.ht-chips{flex:none;display:flex;gap:8px;overflow-x:auto;padding:12px 24px 0;
  scrollbar-width:none;-ms-overflow-style:none}
.ht-chips::-webkit-scrollbar{display:none}
.ht-chip{flex:none;height:32px;padding:0 12px;border-radius:8px;border:0;cursor:pointer;
  background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit;font-weight:500;white-space:nowrap;
  display:inline-flex;align-items:center}
.ht-chip:hover{background:var(--dsw-alias-bg-layer-2)}
.ht-chip.on{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base)}
.ht-filters{flex:none;display:flex;flex-wrap:wrap;gap:8px;padding:10px 24px 0}
.ht-filter{height:30px;padding:0 28px 0 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit;font-size:12.5px;cursor:pointer;outline:none}
.ht-filter:focus{border-color:rgba(255,102,0,.55)}
.ht-scroll{flex:1;min-height:0;overflow-y:auto;padding:0 24px 40px}
.ht-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(380px,100%),1fr));gap:32px 20px;padding-top:16px}
.ht-card.kbd{outline:2px solid var(--dsw-alias-label-primary);outline-offset:3px;border-radius:12px}
.ht-card{display:block;min-width:0;cursor:pointer;background:none;border:0;padding:0;
  text-align:left;color:inherit;font:inherit;
  content-visibility:auto;contain-intrinsic-size:auto 320px}
.ht-thumb{position:relative;aspect-ratio:16/9;border-radius:12px;overflow:hidden;
  background:var(--dsw-alias-bg-layer-1)}
.ht-thumb img{width:100%;height:100%;object-fit:cover;display:block;transition:border-radius .15s}
.ht-card:hover .ht-thumb img{border-radius:0}
.ht-dur{position:absolute;right:8px;bottom:8px;background:rgba(0,0,0,.8);color:#fff;
  font-size:12px;font-weight:500;padding:1px 4px;border-radius:4px}
.ht-info{padding-top:12px}
.ht-title{margin:0 0 4px;font-size:16px;font-weight:500;line-height:22px;height:44px;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.ht-sub{color:var(--dsw-alias-label-secondary);font-size:14px;line-height:20px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ht-foot{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:18px;margin-top:2px}
.ht-meta{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:6px 0 0;font-size:13px;line-height:18px;
  color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.ht-meta > span + span:not(.ht-hn-mark)::before{content:"·";margin-right:8px;color:var(--dsw-alias-label-tertiary)}
.ht-meta .ht-chan{font-weight:500}
.ht-meta b{font-weight:400;color:var(--dsw-alias-label-primary)}
.ht-match{margin:6px 0 0;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-secondary);
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.ht-match b{font-weight:500;color:var(--dsw-alias-label-tertiary)}
.ht-actions{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0 0}
.ht-comments{margin:30px 0 8px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:20px}
.ht-comments-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:4px}
.ht-comments-head .ht-link{font-size:12.5px;color:var(--dsw-alias-label-tertiary)}
.ht-comments-head .ht-link:hover{color:var(--dsw-alias-label-primary)}
.ht-comments-acts{display:flex;align-items:baseline;gap:14px}
.ht-comment-tr{margin-left:auto;padding:0;border:0;background:none;cursor:pointer;font:inherit;
  font-size:12px;color:var(--dsw-alias-label-tertiary)}
.ht-comment-tr:hover{color:var(--dsw-alias-label-primary);text-decoration:underline}
.ht-comment-tr:disabled{opacity:.55;cursor:default;text-decoration:none}
.ht-comments h2{display:flex;align-items:baseline;gap:8px;margin:0 0 10px;font-size:14px;font-weight:600}
.ht-comments h2 span{font-size:12.5px;font-weight:500;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.ht-comment{padding:12px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}
.ht-comment:last-child{border-bottom:0}
.ht-comment-head{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--dsw-alias-label-secondary);margin-bottom:6px}
.ht-comment-head b{font-weight:600;color:var(--dsw-alias-label-primary)}
.ht-stance{font-size:11.5px;padding:1px 6px;border-radius:4px;background:var(--dsw-alias-interactive-bg-hover)}
.ht-stance-strong_rec{color:var(--dsw-alias-label-primary)}
.ht-comment-text{margin:0;font-size:13.5px;line-height:21px;color:var(--dsw-alias-label-primary);white-space:pre-wrap}
.ht-comment-link{display:inline-block;margin-top:6px;font-size:12px;color:var(--dsw-alias-label-tertiary);text-decoration:none}
.ht-comment-link:hover{color:var(--dsw-alias-label-primary);text-decoration:underline}
.ht-state{color:var(--dsw-alias-label-secondary);padding:48px 0;text-align:center;font-size:14px}
.ht-sentinel{height:1px}
.ht-watch{flex:1;min-height:0;overflow-y:auto;padding:22px 24px 16px;container-type:inline-size}
.ht-watch-inner{max-width:1580px;margin:0 auto;display:grid;grid-template-columns:minmax(0,1fr) 388px;
  grid-template-areas:"main rail" "comments rail";
  align-items:start;gap:28px;padding-top:2px}
.ht-watch .ht-toolbar{margin:0 auto 12px;max-width:1580px}
.ht-primary{grid-area:main;min-width:0}
.ht-rail{grid-area:rail;position:sticky;top:0;align-self:start;display:flex;flex-direction:column;
  height:calc(100vh - 70px);min-height:420px}
/* 面板变窄时右栏落到正文下方：容器查询，跟随面板宽度而不是视口宽度 */
@container (max-width:1024px){
  .ht-watch-inner{grid-template-columns:minmax(0,1fr);grid-template-areas:"main" "rail" "comments"}
  .ht-rail{position:static;height:min(640px,70vh)}
}
.ht-back.ht-rail-jump{display:none}
@container (max-width:1024px){
  .ht-back.ht-rail-jump{display:inline-flex}
}
.ht-rail-head{position:relative;flex:none;display:flex;align-items:center;gap:4px;padding:4px;border-radius:999px;
  background:var(--dsw-alias-interactive-bg-hover)}
.ht-rail-ind{position:absolute;top:4px;bottom:4px;left:4px;width:calc(50% - 6px);border-radius:999px;
  background:var(--dsw-alias-bg-base);box-shadow:0 1px 2px rgba(15,17,21,.08);
  transition:transform .34s cubic-bezier(.32,.72,0,1)}
.ht-rail[data-pane="ai"] .ht-rail-ind{transform:translateX(calc(100% + 4px))}
.ht-rail-tab{position:relative;z-index:1;flex:1;height:32px;border-radius:999px;border:0;background:none;cursor:pointer;
  font:inherit;font-size:13px;font-weight:500;color:var(--dsw-alias-label-secondary);
  display:inline-flex;align-items:center;justify-content:center;gap:6px;
  transition:color .2s cubic-bezier(.32,.72,0,1)}
.ht-rail-tab[aria-selected="true"]{color:var(--dsw-alias-label-primary);font-weight:600}
.ht-rail-badge{font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.ht-rail-viewport{position:relative;flex:1;min-height:0;margin-top:12px;overflow:hidden}
.ht-rail-track{display:flex;width:200%;height:100%;transition:transform .34s cubic-bezier(.32,.72,0,1);
  will-change:transform}
.ht-rail[data-pane="ai"] .ht-rail-track{transform:translateX(-50%)}
.ht-rail-pane{width:50%;flex:none;height:100%;padding-right:2px;overflow-y:auto;overscroll-behavior:auto;
  -webkit-mask-image:linear-gradient(to bottom,transparent 0,#000 10px);
  mask-image:linear-gradient(to bottom,transparent 0,#000 10px)}
.ht-rail-pane::-webkit-scrollbar{width:8px}
.ht-rail-pane::-webkit-scrollbar-thumb{background:var(--dsw-alias-border-l2);border-radius:4px}
.ht-rail-empty{font-size:13px;color:var(--dsw-alias-label-tertiary);padding:12px 0}
.ht-rel{display:flex;gap:12px;width:100%;padding:10px 0;border:0;background:none;cursor:pointer;
  text-align:left;font:inherit;color:inherit;-webkit-mask:linear-gradient(#000,#000);mask:linear-gradient(#000,#000)}
.ht-rel:hover .ht-rel-title{text-decoration:underline;text-underline-offset:2px}
.ht-rel-thumb{position:relative;width:156px;flex:none;aspect-ratio:16/9;border-radius:10px;overflow:hidden;
  background:var(--dsw-alias-bg-layer-2)}
.ht-rel-thumb img{width:100%;height:100%;object-fit:cover;display:block}
.ht-rel-dur{position:absolute;right:6px;bottom:6px;padding:1px 5px;border-radius:4px;background:rgba(0,0,0,.78);
  color:#fff;font-size:11px;font-variant-numeric:tabular-nums}
.ht-rel-body{min-width:0}
.ht-rel-title{margin:0;font-size:13.5px;line-height:1.4;font-weight:500;color:var(--dsw-alias-label-primary);
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.ht-rel-meta{margin:6px 0 0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.ht-rail-ai{display:flex;flex-direction:column;overflow:hidden}
.ht-rail-log{flex:1;min-height:0;overflow-y:auto;padding-right:4px}
.ht-rail-hint{margin:0 0 10px;font-size:12.5px;line-height:1.65;color:var(--dsw-alias-label-secondary)}
.ht-rail-pos{margin:0 0 8px;font-size:11.5px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.ht-sub-stage{margin:0 0 10px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);
  display:flex;align-items:center;gap:6px}
.ht-sub-stage::before{content:"";width:6px;height:6px;border-radius:50%;background:#ff6600;
  animation:ht-sub-pulse 1.1s ease-in-out infinite}
@keyframes ht-sub-pulse{0%,100%{opacity:.35}50%{opacity:1}}
.ht-sub-note{margin:0 0 10px;padding:7px 10px;border-radius:8px;font-size:12px;line-height:1.55;
  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.ht-sub-note.ht-sub-ok{color:var(--dsw-alias-label-secondary)}
.ht-sub-note.ht-sub-no-captions,.ht-sub-note.ht-sub-needs-cookies,.ht-sub-note.ht-sub-timeout{border-left:2px solid #ff6600}
.ht-rail-suggest{display:flex;flex-direction:column;align-items:flex-start;gap:8px}
.ht-rail-suggest button{font:inherit;font-size:12.5px;padding:7px 12px;border-radius:999px;cursor:pointer;
  border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);
  color:var(--dsw-alias-label-secondary)}
.ht-rail-suggest button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ht-rail-form{display:flex;gap:8px;margin-top:10px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1)}
.ht-rail-form input{flex:1;min-width:0;height:38px;padding:0 14px;border-radius:999px;
  border:1px solid var(--dsw-alias-border-l2);background:transparent;font:inherit;font-size:13px;color:inherit;outline:none}
.ht-rail-form input:focus{border-color:var(--dsw-alias-label-tertiary);box-shadow:0 0 0 3px var(--dsw-alias-interactive-bg-hover)}
.ht-rail-form button{flex:none;height:38px;padding:0 16px;border-radius:999px;border:0;cursor:pointer;
  background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base);font:inherit;font-size:13px;font-weight:600}
.ht-rail-form button:disabled{opacity:.5;cursor:default}
/* 详情页按钮组 */
.ht-pill{display:inline-flex;align-items:center;gap:6px;height:36px;padding:0 16px;border-radius:999px;border:0;
  cursor:pointer;font:inherit;font-size:13px;font-weight:500;white-space:nowrap;
  background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);
  transition:background .16s cubic-bezier(.32,.72,0,1)}
.ht-pill:hover{background:var(--dsw-alias-border-l2)}
.ht-pill.on{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base)}
.ht-pill svg{flex:none}
.ht-pill-ghost{background:transparent;border:1px solid var(--dsw-alias-border-l2)}
.ht-pill-ghost:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ht-pill-tag{padding:1px 7px;border-radius:999px;font-size:11px;font-weight:600;line-height:1.5;
  background:rgba(0,174,236,.14);color:#0b7fa8}
.ht-hn-mark{display:inline-flex;align-items:center;gap:5px;padding:1px 8px;border-radius:999px;
  background:rgba(255,102,0,.12);color:#b4460a;font-size:12px;font-weight:600}
.ht-hn-mark i{width:5px;height:5px;border-radius:50%;background:#ff6600;display:inline-block}
/* 评论区 */
.ht-comments{grid-area:comments;margin:0;padding:22px 0 8px;border-top:1px solid var(--dsw-alias-border-l1)}
.ht-comments h2{display:flex;align-items:baseline;gap:8px;margin:0 0 4px;font-size:15px;font-weight:600}
.ht-comments h2 span{font-size:12.5px;font-weight:500;color:var(--dsw-alias-label-tertiary);
  font-variant-numeric:tabular-nums}
.ht-comments-sub{margin:0 0 12px;font-size:12.5px;color:var(--dsw-alias-label-tertiary)}
.ht-comment{padding:16px 0;border-bottom:1px solid var(--dsw-alias-border-l1);max-width:860px}
.ht-comment:last-child{border-bottom:0}
.ht-comment-head{display:flex;align-items:center;gap:10px;font-size:12.5px;
  color:var(--dsw-alias-label-secondary);margin-bottom:6px}
.ht-comment-head b{color:var(--dsw-alias-label-primary);font-weight:600}
.ht-stance{font-size:11.5px;padding:1px 7px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);
  color:var(--dsw-alias-label-secondary)}
.ht-stance-strong_rec{background:rgba(255,102,0,.12);color:#b4460a}
.ht-comment-text{margin:0;font-size:13.5px;line-height:1.7;color:var(--dsw-alias-label-primary)}
.ht-comment-link{display:inline-block;margin-top:8px;font-size:12.5px;color:var(--dsw-alias-label-tertiary);
  text-decoration:none}
.ht-comment-link:hover{color:var(--dsw-alias-label-primary);text-decoration:underline}
.ht-toolbar{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;gap:12px}
.ht-bot{flex:none;display:inline-flex;align-items:center;gap:7px;height:34px;padding:0 14px;
  border-radius:17px;cursor:pointer;font:inherit;font-size:13px;font-weight:500;
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-primary);
  transition:background .18s cubic-bezier(.32,.72,0,1),transform .18s cubic-bezier(.32,.72,0,1)}
.ht-bot:hover{background:var(--dsw-alias-bg-layer-2)}
.ht-bot:active{transform:scale(.96)}
.ht-bot-on{background:var(--dsw-alias-brand-primary);color:#fff;border-color:transparent}
.ht-drawer{flex:none;width:376px;box-sizing:border-box;display:flex;flex-direction:column;
  height:calc(100vh - 120px);max-height:720px;position:sticky;top:0;border-radius:20px;overflow:hidden;
  border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);
  box-shadow:0 1px 2px rgba(15,17,21,.04),0 12px 40px -12px rgba(15,17,21,.18);
  animation:ht-drawer-in .34s cubic-bezier(.32,.72,0,1)}
.ht-drawer::before{content:"";position:absolute;inset:0 0 auto;height:2px;
  background:linear-gradient(90deg,rgba(255,102,0,0),rgba(255,102,0,.55),rgba(255,102,0,0));pointer-events:none}
@keyframes ht-drawer-in{from{opacity:0;transform:translateX(18px) scale(.995)}to{opacity:1;transform:none}}
.ht-drawer-head{display:flex;align-items:center;gap:10px;padding:12px 14px 12px 16px;
  border-bottom:1px solid var(--dsw-alias-border-l1)}
.ht-drawer-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.ht-caret{display:inline-block;width:7px;height:15px;margin-left:2px;border-radius:2px;background:var(--dsw-alias-label-primary);vertical-align:-2px;animation:ht-blink 1s steps(2,start) infinite}
@keyframes ht-blink{to{opacity:0}}
.ht-drawer-pos{font-size:11.5px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;
  padding:2px 8px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover)}
.ht-drawer-dot{width:7px;height:7px;border-radius:50%;background:#ff6600;flex:none;
  box-shadow:0 0 0 3px rgba(255,102,0,.14)}
.ht-drawer-close{margin-left:auto;width:26px;height:26px;border-radius:13px;border:0;cursor:pointer;
  display:inline-grid;place-items:center;
  background:transparent;color:var(--dsw-alias-label-secondary);font-size:18px;line-height:1;
  transition:background .16s cubic-bezier(.32,.72,0,1)}
.ht-drawer-close:hover{background:var(--dsw-alias-bg-layer-2)}
.ht-drawer .ht-chat-log{flex:1;max-height:none}
.ht-drawer-tabs{display:flex;align-items:center;gap:2px;min-width:0}
.ht-drawer-tab{position:relative;font:inherit;font-size:12.5px;font-weight:500;height:28px;padding:0 10px;border-radius:8px;
  border:0;background:none;color:var(--dsw-alias-label-secondary);cursor:pointer;display:inline-flex;align-items:center;gap:6px;
  transition:background .16s cubic-bezier(.32,.72,0,1),color .16s cubic-bezier(.32,.72,0,1)}
.ht-drawer-tab:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ht-drawer-tab.on{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font-weight:600}
.ht-drawer-tab span{font-size:11px;font-weight:500;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.ht-drawer-pane{flex:1;min-height:0;display:flex;flex-direction:column}
.ht-drawer-scroll{flex:1;min-height:0;overflow-y:auto;padding:8px 16px 20px}
.ht-drawer-scroll .ht-comment{padding:12px 0}
.ht-drawer-scroll .ht-comment:first-child{padding-top:4px}
/* ---- markdown ---- */
.ht-md{font-size:13px;line-height:1.72;color:var(--dsw-alias-label-primary)}
.ht-md-p{margin:0 0 10px}
.ht-md-p:last-child{margin-bottom:0}
.ht-md-h{margin:14px 0 6px;font-size:13.5px;font-weight:600;line-height:1.5}
.ht-md-h:first-child{margin-top:0}
.ht-md-list{margin:0 0 10px;padding-left:18px}
.ht-md-list li{margin:2px 0}
.ht-md-q{margin:8px 0;padding:2px 0 2px 10px;border-left:2px solid var(--dsw-alias-border-l3);
  color:var(--dsw-alias-label-secondary)}
.ht-md-pre{margin:8px 0;padding:10px 12px;border-radius:10px;overflow-x:auto;
  background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);font-size:12px;line-height:1.6}
.ht-md-pre code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.ht-md-code{padding:1px 5px;border-radius:5px;background:var(--dsw-alias-bg-layer-2);
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.ht-md a{color:var(--dsw-alias-label-primary);text-decoration:underline;text-underline-offset:2px}
.ht-md strong{font-weight:600}
.ht-md em{font-style:italic}
.ht-player{position:relative;aspect-ratio:16/9;border-radius:12px;overflow:hidden;background:#000}
.ht-player iframe{width:100%;height:100%;border:0;display:block}
.ht-video{width:100%;height:100%;display:block;background:#000;object-fit:contain}
/* 播放失败不再留一块黑屏：覆盖层给出原因、下一步和兜底入口 */
.ht-player-error{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;gap:8px;
  padding:20px 24px;color:#f4f4f5;
  background:linear-gradient(180deg,#1b1c1f 0%,#0c0d0f 100%)}
.ht-player-error b{font-size:15px;font-weight:600}
.ht-player-error p{margin:0;max-width:64ch;font-size:12.5px;line-height:1.65;color:#c9c9cd}
.ht-player-error-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:4px}
.ht-error-btn{display:inline-flex;align-items:center;height:32px;padding:0 14px;border-radius:16px;
  border:0;cursor:pointer;font:inherit;font-size:12.5px;font-weight:600;text-decoration:none;
  background:#f4f4f5;color:#111}
.ht-error-btn:hover{background:#fff}
.ht-error-btn.ghost{background:transparent;border:1px solid rgba(255,255,255,.35);color:#f4f4f5}
.ht-error-btn.ghost:hover{background:rgba(255,255,255,.1)}
.ht-error-dep{margin:2px 0 0;font-size:12px;line-height:1.6;color:#ffb27a}
.ht-player-note{margin:8px 0 0;display:flex;flex-wrap:wrap;align-items:center;gap:10px;
  font-size:12.5px;color:var(--dsw-alias-label-secondary)}
.ht-back{height:32px;padding:0 12px;border-radius:16px;border:0;cursor:pointer;font:inherit;
  background:var(--dsw-alias-bg-layer-1);color:inherit;font-weight:500;display:inline-flex;
  align-items:center;gap:6px;margin-bottom:16px}
.ht-back:hover{background:var(--dsw-alias-bg-layer-2)}
.ht-resume{margin:8px 0 0;font-size:13px;color:var(--dsw-alias-label-secondary);display:flex;align-items:center;gap:8px}
.ht-resume-reset{padding:0;border:0;background:none;font:inherit;font-size:12.5px;color:var(--dsw-alias-label-tertiary);cursor:pointer;text-decoration:underline;text-underline-offset:2px}
.ht-resume-reset:hover{color:var(--dsw-alias-label-primary)}
.ht-h1{font-size:21px;line-height:1.32;font-weight:600;letter-spacing:-.2px;margin:16px 0 0}
.ht-channel{margin:10px 0 0;font-size:14px;font-weight:500}
/* 简介卡：浅灰底、默认折叠三行、底部渐隐，展开后完整显示 */
.ht-desc{margin:18px 0 0;padding:16px 18px;border-radius:18px;
  background:var(--dsw-alias-interactive-bg-hover)}
.ht-desc-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:10px;
  font-size:13px;color:var(--dsw-alias-label-secondary)}
.ht-desc-head b{font-weight:600;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
.ht-desc-body{position:relative;overflow:hidden}
.ht-desc.clamped .ht-desc-body{max-height:84px;
  -webkit-mask-image:linear-gradient(to bottom,#000 56px,transparent 84px);
  mask-image:linear-gradient(to bottom,#000 56px,transparent 84px)}
.ht-desc-p{margin:0 0 10px;font-size:13.5px;line-height:1.72;color:var(--dsw-alias-label-primary)}
.ht-desc-p:last-child{margin-bottom:0}
.ht-desc-why{color:var(--dsw-alias-label-secondary)}
.ht-tr-badge{display:inline-block;margin-left:8px;padding:0 6px;border-radius:999px;vertical-align:1px;
  font-size:11px;font-weight:600;font-style:normal;line-height:18px;
  background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.ht-tr-busy{font-size:12px;font-weight:500;color:var(--dsw-alias-label-tertiary)}
.ht-desc-quote{margin:12px 0 0;padding-left:12px;border-left:2px solid var(--dsw-alias-border-l3);
  font-size:13.5px;line-height:1.7;font-style:italic;color:var(--dsw-alias-label-secondary)}
.ht-desc-tags{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
.ht-desc-more{margin-top:10px;padding:0;border:0;background:none;cursor:pointer;font:inherit;
  font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.ht-desc-more:hover{text-decoration:underline;text-underline-offset:2px}
.ht-note{margin:14px 0 0;font-size:13px;color:var(--dsw-alias-label-secondary)}
.ht-stat{display:inline-flex;align-items:baseline;gap:4px;font-size:12px;padding:3px 9px;border-radius:999px;
  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary)}
.ht-stat b{font-weight:600;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
.ht-stat-strong{background:rgba(255,102,0,.14);color:#b4460a}
.ht-stat-strong b{color:#b4460a}
.ht-tag{font-size:12px;padding:3px 9px;border-radius:999px;background:var(--dsw-alias-bg-base);
  color:var(--dsw-alias-label-secondary)}
.ht-chat{margin-top:20px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;overflow:hidden;
  background:var(--dsw-alias-bg-layer-1)}
.ht-chat-head{padding:10px 14px;font-size:13px;font-weight:600;
  border-bottom:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary)}
.ht-chat-log{max-height:280px;overflow-y:auto;padding:14px 16px;display:flex;flex-direction:column;gap:12px;
  -webkit-mask-image:linear-gradient(to bottom,transparent 0,#000 12px,#000 calc(100% - 14px),transparent 100%);
  mask-image:linear-gradient(to bottom,transparent 0,#000 12px,#000 calc(100% - 14px),transparent 100%)}
.ht-chat-hint{margin:0;font-size:13px;color:var(--dsw-alias-label-secondary)}
.ht-chat-suggest{display:flex;flex-direction:column;gap:8px;align-items:flex-start;margin-top:2px}
.ht-chat-suggest button{font:inherit;font-size:12.5px;padding:7px 12px;border-radius:999px;cursor:pointer;
  border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);
  transition:border-color .16s cubic-bezier(.32,.72,0,1),color .16s cubic-bezier(.32,.72,0,1)}
.ht-chat-suggest button:hover{border-color:var(--dsw-alias-label-tertiary);color:var(--dsw-alias-label-primary)}
.ht-msg{font-size:13px;line-height:1.68;padding:8px 12px;border-radius:12px;white-space:pre-wrap;
  animation:ht-msg-in .26s cubic-bezier(.32,.72,0,1) both;
  max-width:92%}
.ht-msg-user{align-self:flex-end;background:var(--dsw-alias-interactive-bg-hover);
  color:var(--dsw-alias-label-primary);border-bottom-right-radius:4px}
.ht-msg-ai{align-self:stretch;background:transparent;padding:0 2px;color:var(--dsw-alias-label-primary)}
@keyframes ht-msg-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.ht-chat-form{display:flex;gap:8px;padding:12px 16px 16px;border-top:1px solid var(--dsw-alias-border-l1)}
.ht-chat-form input{flex:1;min-width:0;height:38px;padding:0 14px;font:inherit;font-size:13px;border-radius:999px;
  border-radius:8px;border:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
.ht-chat-form button{flex:none;height:38px;padding:0 18px;border-radius:999px;cursor:pointer;
  transition:transform .16s cubic-bezier(.32,.72,0,1),opacity .16s cubic-bezier(.32,.72,0,1);
  font:inherit;font-size:13px;border:0;background:var(--dsw-alias-brand-primary);color:#fff}
.ht-chat-form button:disabled{opacity:.5;cursor:default}
.ht-chat-form input{transition:border-color .18s cubic-bezier(.32,.72,0,1),box-shadow .18s cubic-bezier(.32,.72,0,1)}
.ht-chat-form input:focus{outline:none;border-color:rgba(255,102,0,.45);box-shadow:0 0 0 3px rgba(255,102,0,.12)}
.ht-chat-form button:not(:disabled):hover{transform:translateY(-1px)}
@media (prefers-reduced-motion: reduce){
  .ht-drawer,.ht-msg,.ht-caret,.ht-chat-form button{animation:none!important;transition:none!important}
}
.ht-link{color:var(--dsw-alias-brand-primary);text-decoration:none;background:none;border:0;
  font:inherit;cursor:pointer;padding:0}
.ht-link:hover{text-decoration:underline}
.ht-link:hover{text-decoration:underline}
.ht-open{flex:none;height:32px;padding:0 12px;border-radius:16px;display:inline-flex;
  align-items:center;font-size:13px;text-decoration:none;
  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-brand-primary)}
.ht-open:hover{background:var(--dsw-alias-bg-layer-2)}
.ht-notice{color:var(--dsw-alias-label-secondary);font-size:13px;padding:20px 0;text-align:center}
/* ---- 视图层 ---- */
.ht-nav{flex:none;display:flex;align-items:center;justify-content:center;gap:20px;height:44px;
  padding:0 24px;border-bottom:1px solid var(--dsw-alias-border-l1);position:relative}
.ht-nav .ht-tabs{display:flex;align-items:center;gap:20px}
.ht-tab{position:relative;height:44px;display:flex;align-items:center;font:inherit;font-size:13.5px;font-weight:500;
  color:var(--dsw-alias-label-secondary);background:none;border:0;cursor:pointer;white-space:nowrap;padding:0}
.ht-tab:hover{color:var(--dsw-alias-label-primary)}
.ht-tab.on{color:var(--dsw-alias-label-primary)}
.ht-tab.on::after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:2px;border-radius:2px;
  background:var(--dsw-alias-label-primary)}
.ht-tab-sep{width:1px;height:15px;background:var(--dsw-alias-border-l3)}
.ht-tab-tv{gap:6px}
.ht-tab-tv::before{content:"";width:5px;height:5px;border-radius:50%;background:#ff6600}
/* ---- 电视：播放器满铺，平时不出现任何浮层；简介与站外入口收在右侧毛玻璃抽屉 ---- */
.ht-tv{position:relative;flex:1;min-height:0;overflow:hidden;background:#000;color:#fff}
.ht-tv-stage{position:absolute;inset:0;background:#000}
.ht-tv-stage iframe{width:100%;height:100%;border:0;display:block;background:#000}
.ht-tv-wait{position:absolute;inset:0;display:grid;place-items:center;font-size:13px;color:rgba(255,255,255,.6)}
.ht-tv-onair{display:inline-flex;align-items:center;gap:6px;padding:3px 8px;border-radius:4px;
  background:#ff6600;color:#fff;font-size:11px;font-weight:700;letter-spacing:.08em}
.ht-tv-onair::before{content:"";width:5px;height:5px;border-radius:50%;background:#fff}
.ht-tv-mark{font-size:15px;font-weight:600;letter-spacing:-.01em}
.ht-tv-title{margin:0;font-size:22px;line-height:28px;font-weight:600;letter-spacing:-.01em;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.ht-tv-who{margin:4px 0 0;font-size:13px;color:rgba(255,255,255,.62)}
.ht-tv-meta{display:flex;flex-wrap:wrap;gap:14px;margin-top:2px;font-size:13px;
  color:rgba(255,255,255,.78);font-variant-numeric:tabular-nums}
.ht-tv-meta b{color:#ff6600;font-weight:600}
.ht-tv-foot{display:flex;align-items:center;flex-wrap:wrap;gap:10px;padding-top:12px;
  border-top:1px solid rgba(255,255,255,.12)}
.ht-tv-act{display:inline-flex;align-items:center;height:34px;padding:0 15px;border-radius:999px;
  cursor:pointer;font:inherit;font-size:13px;font-weight:500;white-space:nowrap;
  border:1px solid rgba(255,255,255,.35);background:transparent;color:#fff;
  transition:background .16s cubic-bezier(.32,.72,0,1)}
.ht-tv-act:hover{background:rgba(255,255,255,.1)}
/* 抽屉把手：贴在右边缘，是电视里唯一常驻的元素 */
.ht-tvd-handle{position:absolute;top:50%;right:0;transform:translateY(-50%);z-index:3;
  width:26px;height:78px;display:grid;place-items:center;padding:0;cursor:pointer;
  border:1px solid rgba(255,255,255,.18);border-right:0;border-radius:10px 0 0 10px;
  background:rgba(16,17,20,.42);color:rgba(255,255,255,.72);
  -webkit-backdrop-filter:blur(16px) saturate(1.2);backdrop-filter:blur(16px) saturate(1.2);
  transition:background .2s,border-color .2s,opacity .2s}
.ht-tvd-handle:hover{background:rgba(28,29,33,.74);border-color:rgba(255,255,255,.3)}
.ht-tvd-handle[aria-expanded="true"]{opacity:0;pointer-events:none}
.ht-tvd-scrim{position:absolute;inset:0;z-index:2;background:rgba(0,0,0,.16);
  opacity:0;pointer-events:none;transition:opacity .3s cubic-bezier(.32,.72,0,1)}
.ht-tvd-scrim.on{opacity:1;pointer-events:auto}
.ht-tvd{position:absolute;top:0;right:0;bottom:0;z-index:4;width:min(380px,86%);
  display:flex;flex-direction:column;gap:12px;padding:20px 20px 18px;
  overflow-y:auto;overscroll-behavior:contain;visibility:hidden;
  background:rgba(17,18,21,.62);color:#f7f7f7;
  border-left:1px solid rgba(255,255,255,.14);
  box-shadow:-30px 0 60px rgba(0,0,0,.38);
  -webkit-backdrop-filter:blur(24px) saturate(1.35);backdrop-filter:blur(24px) saturate(1.35);
  transform:translateX(calc(100% + 2px));
  transition:transform .3s cubic-bezier(.32,.72,0,1),visibility 0s .3s}
.ht-tvd.open{visibility:visible;transform:none;transition:transform .3s cubic-bezier(.32,.72,0,1)}
.ht-tvd-head{display:flex;align-items:flex-start;gap:10px}
.ht-tvd-title{margin:0;flex:1;min-width:0;font-size:18px;line-height:24px;font-weight:600;letter-spacing:-.01em}
.ht-tvd-x{flex:none;width:30px;height:30px;display:grid;place-items:center;padding:0;cursor:pointer;
  border-radius:50%;border:1px solid rgba(255,255,255,.2);background:transparent;color:rgba(255,255,255,.8)}
.ht-tvd-x:hover{background:rgba(255,255,255,.12)}
.ht-tvd-who{margin:0;font-size:12.5px;color:rgba(255,255,255,.6)}
.ht-tvd-desc{margin:0;font-size:13px;line-height:1.72;color:rgba(255,255,255,.82);
  white-space:pre-wrap;overflow-wrap:anywhere}
.ht-tvd-note{margin:0;font-size:12.5px;color:rgba(255,255,255,.45)}
.ht-tvd-acts{display:flex;flex-direction:column;gap:8px;margin-top:2px}
.ht-tvd-link{display:flex;align-items:center;gap:9px;min-height:40px;padding:0 14px;border-radius:10px;
  cursor:pointer;font:inherit;font-size:13px;font-weight:500;text-align:left;
  border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.06);color:#f7f7f7}
.ht-tvd-link:hover{background:rgba(255,255,255,.13)}
.ht-tvd-link svg{flex:none;opacity:.85}
.ht-tvd-foot{display:flex;gap:8px;margin-top:auto;padding-top:12px;
  border-top:1px solid rgba(255,255,255,.12)}
.ht-tvd-keys{margin:0;font-size:11.5px;color:rgba(255,255,255,.5)}
.ht-tvd-keys kbd{font:inherit;padding:1px 5px;border:1px solid rgba(255,255,255,.28);border-radius:4px;
  color:rgba(255,255,255,.78)}
/* 会话右栏的窄版电视：信息常驻，没有悬浮层，底部动作直接可点 */
.ht-tv-compact{flex:1;min-height:0;width:100%;display:flex;flex-direction:column;gap:12px;
  padding:12px 14px 14px;overflow:auto;cursor:auto}
.ht-tv-compact .ht-tv-stage{position:relative;inset:auto;flex:none;width:100%;aspect-ratio:16/9;
  border-radius:8px;overflow:hidden;background:#000}
.ht-tv-ctop{flex:none;display:flex;align-items:center;gap:8px;min-width:0}
.ht-tv-ctop .ht-tv-grow{flex:1;min-width:0}
.ht-tv-ctop .ht-tv-onair{padding:2px 7px;font-size:10.5px}
.ht-tv-ctop .ht-tv-mark{font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ht-tv-exit{flex:none;display:inline-flex;align-items:center;gap:5px;height:30px;padding:0 11px;
  border-radius:999px;cursor:pointer;font:inherit;font-size:12.5px;font-weight:500;color:#fff;
  border:1px solid rgba(255,255,255,.35);background:transparent}
.ht-tv-exit:hover{background:rgba(255,255,255,.1)}
.ht-tv-exit svg{flex:none}
.ht-tv-compact .ht-tv-info{flex:none;display:flex;flex-direction:column;gap:4px;min-width:0}
.ht-tv-compact .ht-tv-title{font-size:15px;line-height:20px}
.ht-tv-compact .ht-tv-who{font-size:12px;margin:0}
.ht-tv-compact .ht-tv-meta{gap:10px;font-size:12px;margin-top:0}
.ht-tv-cqueue{flex:none;min-width:0;margin-top:4px}
.ht-tv-qhead{margin:0 0 6px;font-size:12px;color:rgba(255,255,255,.55)}
.ht-tv-qrow{display:flex;gap:10px;overflow-x:auto;padding-bottom:6px;scrollbar-width:none}
.ht-tv-qrow::-webkit-scrollbar{display:none}
.ht-tv-qitem{flex:0 0 128px;min-width:0;display:flex;flex-direction:column;gap:4px;
  padding:0;border:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
.ht-tv-qthumb{display:block;width:100%;aspect-ratio:16/9;border-radius:6px;overflow:hidden;background:#000}
.ht-tv-qthumb img{width:100%;height:100%;object-fit:cover;display:block;opacity:.82}
.ht-tv-qitem:hover .ht-tv-qthumb img{opacity:1}
.ht-tv-qtitle{font-size:12px;line-height:16px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.ht-tv-qchan{font-size:11px;color:rgba(255,255,255,.45);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ht-tv-compact .ht-tv-foot{flex:none;margin-top:auto;gap:8px;padding-top:10px}
.ht-tv-compact .ht-tv-act{height:32px;padding:0 12px;font-size:12.5px;pointer-events:auto}
@container (max-width:560px){
  .ht-tv-title{font-size:17px;line-height:22px}
  .ht-tv-mark{font-size:13px}
  .ht-tv-meta{gap:10px;font-size:12px}
  .ht-tv-act{height:32px;padding:0 12px;font-size:12.5px}
  .ht-tvd{width:min(320px,92%);padding:16px 16px 14px}
}
.ht-areas{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(360px,100%),1fr));gap:12px;padding:16px 24px 40px}
.ht-area{border:1px solid var(--dsw-alias-border-l1);border-radius:16px;padding:16px 20px;cursor:pointer;text-align:left;
  background:none;font:inherit;color:inherit}
.ht-area:hover{border-color:var(--dsw-alias-border-l3)}
.ht-area h3{margin:0;display:flex;align-items:baseline;gap:8px;font-size:15px;font-weight:600}
.ht-area h3 em{font-style:normal;font-size:12.5px;font-weight:500;color:var(--dsw-alias-label-secondary)}
.ht-area .ht-cats{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.ht-area .ht-cat{font-size:12.5px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover);
  padding:2px 8px;border-radius:4px}
.ht-plgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(320px,100%),1fr));gap:24px 20px;padding:8px 24px 32px}
.ht-pl{display:flex;flex-direction:column;gap:8px;cursor:pointer;background:none;border:0;padding:0;text-align:left;
  font:inherit;color:inherit}
.ht-pl .ht-mosaic{position:relative;display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;gap:1px;
  aspect-ratio:16/9;border-radius:12px;overflow:hidden;background:var(--dsw-alias-bg-base)}
.ht-pl .ht-mosaic img{width:100%;height:100%;object-fit:cover;display:block}
.ht-pl .ht-count{position:absolute;right:8px;bottom:8px;padding:2px 8px;border-radius:4px;
  background:rgba(11,12,14,.68);color:#f7f7f7;font-size:11.5px;font-variant-numeric:tabular-nums}
.ht-pl h3{margin:0;font-size:14px;font-weight:600}
.ht-pl p{margin:0;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-secondary);
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.ht-sechead{display:flex;align-items:baseline;gap:10px;padding:16px 24px 4px}
.ht-sechead h2{margin:0;font-size:15px;font-weight:600}
.ht-sechead p{margin:0;font-size:12.5px;color:var(--dsw-alias-label-secondary)}
.ht-loading-text{padding:16px 0 0;font-size:13px;color:var(--dsw-alias-label-secondary)}
.ht-stagebar{display:flex;align-items:center;gap:8px;margin:0 24px;padding:8px 12px;border-radius:8px;
  background:var(--dsw-alias-interactive-bg-hover);font-size:12.5px;color:var(--dsw-alias-label-secondary)}
.ht-stagebar::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-brand-primary);
  animation:ht-pulse 1.2s ease-in-out infinite}
.ht-stale{margin:0 24px;padding:8px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);
  background:var(--dsw-alias-turn-trigger-bg);font-size:12.5px;color:var(--dsw-alias-label-secondary)}
@keyframes ht-pulse{0%,100%{opacity:.35}50%{opacity:1}}
.ht-skel{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(380px,100%),1fr));gap:32px 20px;padding-top:16px}
.ht-skel div{display:flex;flex-direction:column;gap:8px}
.ht-skel i{display:block;background:var(--dsw-alias-bg-skeleton);border-radius:12px}
.ht-skel i.b{aspect-ratio:16/9}
.ht-skel i.l{height:12px;border-radius:6px;width:72%}
.ht-skel i.m{height:12px;border-radius:6px;width:44%}
.ht-empty{display:flex;flex-direction:column;align-items:flex-start;gap:8px;padding:48px 24px}
.ht-empty b{font-size:14px;font-weight:600}
.ht-empty span{font-size:13px;color:var(--dsw-alias-label-secondary);max-width:52ch}
.ht-err{display:flex;align-items:center;gap:12px;margin:24px;padding:12px;border-radius:8px;
  border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-turn-trigger-bg);font-size:13px}
.ht-keys{position:fixed;inset:0;background:rgba(0,0,0,.24);display:grid;place-items:center;z-index:40}
.ht-keys .k{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:16px;
  padding:16px 20px;min-width:340px;box-shadow:0 18px 48px rgba(15,17,21,.18)}
.ht-keys h3{margin:0 0 10px;font-size:13.5px;font-weight:600}
.ht-keys table{border-collapse:collapse;font-size:12.5px}
.ht-keys td{padding:5px 0;color:var(--dsw-alias-label-secondary)}
.ht-keys td:first-child{width:110px;color:var(--dsw-alias-label-primary)}
.ht-keys kbd{display:inline-grid;place-items:center;min-width:20px;height:20px;padding:0 5px;border-radius:5px;
  background:var(--dsw-alias-interactive-bg-hover);border:1px solid var(--dsw-alias-border-l2);font:inherit;font-size:11.5px}
.ht-row{display:flex;gap:16px;padding:12px 0;border-bottom:1px solid var(--dsw-alias-border-l1);cursor:pointer;
  background:none;border-left:0;border-right:0;border-top:0;width:100%;text-align:left;font:inherit;color:inherit}
.ht-row .ht-thumb{width:220px;flex:none;aspect-ratio:16/9}
.ht-row .ht-title{font-size:15px;line-height:21px;height:42px}
.ht-hgrid{display:grid;grid-template-columns:1fr 1fr;gap:0 28px;padding:0 24px}
.ht-hgrid .ht-row .ht-thumb{width:180px}
/* 会话右栏：宿主给的是 320–480px 的窄容器，跟随容器宽度而不是视口 */
.ht-rail-shell{height:100%;min-height:0;display:flex;flex-direction:column;overflow:hidden;
  container-type:inline-size;background:var(--dsw-alias-bg-base)}
.ht-rail-shell .ht-root{height:100%;min-height:0}
@container (max-width:560px){
  .ht-head{padding:10px 12px;gap:8px;flex-wrap:wrap}
  .ht-brand{font-size:15px}
  .ht-scroll{padding:0 12px 32px}
  .ht-chips{padding:10px 12px 0}
  .ht-filters{padding:8px 12px 0}
  .ht-grid,.ht-skel{grid-template-columns:1fr;gap:20px}
  .ht-watch{padding:14px 12px 12px}
  .ht-watch .ht-toolbar{margin-bottom:8px}
  .ht-hgrid{padding:0 12px;grid-template-columns:1fr}
  .ht-hgrid .ht-row .ht-thumb{width:140px}
  .ht-sechead{padding:14px 12px 4px}
  .ht-stagebar,.ht-stale{margin-left:12px;margin-right:12px}
  .ht-empty,.ht-err{padding-left:12px;padding-right:12px;margin-left:0;margin-right:0}
  .ht-keys .k{min-width:0;width:calc(100vw - 48px)}
  /* 窄栏导航：单行横滑，「电视」排最前，分隔线让位给空间 */
  .ht-nav{justify-content:flex-start;gap:12px;padding:0 12px;overflow-x:auto;scrollbar-width:none}
  .ht-nav::-webkit-scrollbar{display:none}
  .ht-nav .ht-tabs{gap:14px}
  .ht-tab{font-size:12.5px}
  .ht-tab-sep{display:none}
  .ht-tab-tv{order:-1}
  .ht-tv-compact{padding:10px 12px 14px}
}
@container (max-width:440px){
  .ht-brand{font-size:14px}
  .ht-lang{min-width:44px;padding:0 8px}
  .ht-search{order:9;flex-basis:100%;max-width:none}
  .ht-row .ht-thumb{width:120px}
  .ht-row{gap:12px}
  .ht-tv-qchan{display:none}
}
@container (max-width:360px){
  .ht-tv-exit{padding:0 9px}
  .ht-tv-exit-label{display:none}
  .ht-tv-qitem{flex:0 0 116px}
}`

    /* ---------------- 图标 ---------------- */

    function PlayGlyph(size) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
        h('rect', { x: 1, y: 1, width: 22, height: 22, rx: 6, fill: '#ff6600' }),
        h('path', { d: 'M10 8.2v7.6l6-3.8z', fill: '#fff' }),
      )
    }

    function PanelIcon() {
      /* 图标一旦被渲染，说明 slot 注册和 UI 挂载都成了，不需要点开面板也能确认 */
      if (!mem.iconPinged) {
        mem.iconPinged = true
        beacon('icon-rendered')
      }
      return h(
        'span',
        { style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center' } },
        PlayGlyph(20),
      )
    }

    /* 操作按钮里的小图标，统一 16px 线性风格 */
    function Ico({ fill = false, children }) {
      const props = {
        width: 16,
        height: 16,
        viewBox: '0 0 24 24',
        'aria-hidden': true,
        fill: fill ? 'currentColor' : 'none',
        stroke: fill ? 'none' : 'currentColor',
      }
      if (!fill) {
        props.strokeWidth = 1.8
        props.strokeLinecap = 'round'
        props.strokeLinejoin = 'round'
      }
      return h('svg', props, children)
    }

    /* ---------------- 卡片 ---------------- */

    function Card({ item, onOpen, lang }) {
      const match = item.match
      const matchFields =
        match && Array.isArray(match.fields)
          ? match.fields.map((f) => tx(lang, MATCH_FIELD_ZH[f] || f, f)).join(tx(lang, '、', ', '))
          : ''
      return h(
        'button',
        { type: 'button', className: 'ht-card', 'data-vid': item.v, onClick: () => onOpen(item) },
        h(
          'div',
          { className: 'ht-thumb' },
          item.th ? h('img', { src: item.th, alt: '', loading: 'lazy' }) : null,
          item.d ? h('span', { className: 'ht-dur' }, fmtDur(item.d)) : null,
        ),
        h(
          'div',
          { className: 'ht-info' },
          h('p', { className: 'ht-title' }, titleOf(item, lang)),
          h(
            'div',
            { className: 'ht-meta' },
            item.c ? h('span', { className: 'ht-chan', key: 'c' }, item.c) : null,
            item.r
              ? h('span', { key: 'r' }, h('b', null, String(item.r)), tx(lang, ' 人推荐', item.r === 1 ? ' recommender' : ' recommenders'))
              : null,
            item.w ? h('span', { key: 'w' }, tx(lang, fmtCount(item.w, lang) + ' 次观看', fmtCount(item.w, lang) + ' views')) : null,
            item.y ? h('span', { key: 'y' }, String(item.y)) : null,
          ),
          match && match.snippet
            ? h(
                'p',
                { className: 'ht-match' },
                h('b', null, tx(lang, '匹配：', 'Match: ') + matchFields),
                matchFields ? ' — ' : '',
                match.snippet,
              )
            : null,
        ),
      )
    }

    /* ---------------- 首页推荐行（T06 推荐画像） ---------------- */

    /* ---------------- 分享卡片 ---------------- */

    /* ---------------- 播放页 ---------------- */

    /* ---------------- Markdown ---------------- */

    /** 行内：`代码`、**粗体**、*斜体*、[链接](url)。流式时允许不完整，遇到未闭合的标记当普通文本。 */
    function mdInline(text) {
      const out = []
      const s2 = String(text == null ? '' : text)
      let buf = ''
      let i = 0
      let key = 0
      const flush = () => {
        if (buf) {
          out.push(buf)
          buf = ''
        }
      }
      while (i < s2.length) {
        const c = s2[i]
        if (c === '`') {
          const j = s2.indexOf('`', i + 1)
          if (j > i) {
            flush()
            out.push(h('code', { key: 'c' + key++, className: 'ht-md-code' }, s2.slice(i + 1, j)))
            i = j + 1
            continue
          }
        }
        if (c === '*' && s2[i + 1] === '*') {
          const j = s2.indexOf('**', i + 2)
          if (j > i) {
            flush()
            out.push(h('strong', { key: 'b' + key++ }, mdInline(s2.slice(i + 2, j))))
            i = j + 2
            continue
          }
        }
        if (c === '*') {
          const j = s2.indexOf('*', i + 1)
          if (j > i + 1) {
            flush()
            out.push(h('em', { key: 'i' + key++ }, mdInline(s2.slice(i + 1, j))))
            i = j + 1
            continue
          }
        }
        if (c === '[') {
          const close = s2.indexOf(']', i)
          const open = s2.indexOf('(', close + 1)
          const end = s2.indexOf(')', open + 1)
          if (close > i && open === close + 1 && end > open) {
            flush()
            out.push(
              h(
                'a',
                { key: 'a' + key++, href: s2.slice(open + 1, end), target: '_blank', rel: 'noreferrer noopener' },
                s2.slice(i + 1, close),
              ),
            )
            i = end + 1
            continue
          }
        }
        buf += c
        i += 1
      }
      flush()
      return out
    }

    /** 块级：标题、列表、代码块、引用、段落。未闭合的代码块按到结尾处理，保证流式时不崩。 */
    function Markdown({ text }) {
      const lines = String(text == null ? '' : text).split(/\r?\n/)
      const blocks = []
      let i = 0
      let key = 0
      const isItem = (line) => /^\s*([-*+]|\d+[.)])\s+/.test(line)
      while (i < lines.length) {
        const line = lines[i]
        if (!line.trim()) {
          i += 1
          continue
        }
        if (/^\s*```/.test(line)) {
          const code = []
          i += 1
          while (i < lines.length && !/^\s*```/.test(lines[i])) {
            code.push(lines[i])
            i += 1
          }
          i += 1
          blocks.push(h('pre', { key: 'pre' + key++, className: 'ht-md-pre' }, h('code', null, code.join('\n'))))
          continue
        }
        const head = /^(#{1,4})\s+(.*)$/.exec(line)
        if (head) {
          blocks.push(h('h4', { key: 'h' + key++, className: 'ht-md-h' }, mdInline(head[2])))
          i += 1
          continue
        }
        if (/^>\s?/.test(line)) {
          const quoted = []
          while (i < lines.length && /^>\s?/.test(lines[i])) {
            quoted.push(lines[i].replace(/^>\s?/, ''))
            i += 1
          }
          blocks.push(h('blockquote', { key: 'q' + key++, className: 'ht-md-q' }, mdInline(quoted.join(' '))))
          continue
        }
        if (isItem(line)) {
          const ordered = /^\s*\d+[.)]\s+/.test(line)
          const startNo = ordered ? parseInt(line.trim(), 10) : 1
          const items = []
          let cur = null
          while (i < lines.length) {
            const m2 = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i])
            if (!m2) {
              /* 列表项之间常空一行；只要下一段还是列表就接着读 */
              let look = i
              while (look < lines.length && !lines[look].trim()) look += 1
              if (look < lines.length && look > i && /^(\s*)([-*+]|\d+[.)])\s+/.test(lines[look])) {
                i = look
                continue
              }
              break
            }
            const indent = m2[1].length
            const text = m2[3]
            /* 缩进两格以上算子项，挂到上一条目下面 */
            if (indent >= 2 && cur) {
              if (!cur.sub) cur.sub = []
              cur.sub.push(h('li', { key: 'sub' + key++ }, mdInline(text)))
            } else {
              cur = { text, sub: null }
              items.push(cur)
            }
            i += 1
          }
          blocks.push(
            h(
              ordered ? 'ol' : 'ul',
              ordered
                ? { key: 'l' + key++, className: 'ht-md-list', start: startNo }
                : { key: 'l' + key++, className: 'ht-md-list' },
              items.map((it) =>
                h(
                  'li',
                  { key: 'li' + key++ },
                  mdInline(it.text),
                  it.sub ? h('ul', { key: 'sub' + key++, className: 'ht-md-list' }, it.sub) : null,
                ),
              ),
            ),
          )
          continue
        }
        const para = []
        while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|>|```)/.test(lines[i]) && !isItem(lines[i])) {
          para.push(lines[i])
          i += 1
        }
        if (para.length) blocks.push(h('p', { key: 'p' + key++, className: 'ht-md-p' }, mdInline(para.join(' '))))
        else i += 1
      }
      return h('div', { className: 'ht-md' }, blocks)
    }

    /**
     * 讨论抽屉：AI 对话与 HN 评论共用一块侧栏，靠顶部 tab 切换。
     * 评论不再挤在正文下面，视频始终可见。
     */
    /**
     * 右栏：相关推荐与 AI 问答共用一栏，分段控件换页，各自独立滚动。
     * 默认停在相关推荐，看视频的人不需要先关掉提问框。
     */
    function SideRail({ vid, lang = 'zh', related, pane, onPane, onOpen, anchorRef, playhead }) {
      /* 观看会话按视频存，切回同一视频时接着上次的对话；换视频自然是一份新的 */
      const session = watchSession(vid)
      const [messages, setMessagesState] = useState(() => (session.messages || []).slice())
      const [input, setInput] = useState('')
      const [busy, setBusy] = useState(false)
      const [subtitle, setSubtitle] = useState(null)
      const [stage, setStage] = useState(null)

      const setMessages = (updater) => {
        setMessagesState((prev) => {
          const next = typeof updater === 'function' ? updater(prev) : updater
          session.messages = next
          return next
        })
      }

      /* 切到另一条视频：换上那条会话的消息，字幕与输入不跟过去 */
      useEffect(() => {
        const now = watchSession(vid)
        setMessagesState((now.messages || []).slice())
        setInput('')
        setSubtitle(null)
        setStage(null)
      }, [vid])

      const send = () => {
        const q = input.trim()
        if (!q || busy) return
        setInput('')
        const session = watchSession(vid)
        const at = Number(playhead && playhead.t)
        const lastPlayhead = Number.isFinite(at) && at > 0 ? at : Number(session.playhead && session.playhead.t) || 0
        const history = messages
          .filter((m) => m && m.text && !m.pending)
          .map((m) => ({ role: m.role === 'ai' ? 'assistant' : 'user', text: String(m.text).slice(0, 4000) }))
        setMessages((m) => m.concat([{ role: 'user', text: q }, { role: 'ai', text: '', pending: true }]))
        setBusy(true)
        setStage('subtitles')

        const append = (piece) =>
          setMessages((m) => {
            const next = m.slice()
            for (let i = next.length - 1; i >= 0; i -= 1) {
              if (next[i].role === 'ai') {
                next[i] = { role: 'ai', text: (next[i].text || '') + piece, pending: true }
                break
              }
            }
            return next
          })
        const settle = (finalText) =>
          setMessages((m) => {
            const next = m.slice()
            for (let i = next.length - 1; i >= 0; i -= 1) {
              if (next[i].role === 'ai') {
                next[i] = { role: 'ai', text: finalText != null ? finalText : next[i].text || '', pending: false }
                break
              }
            }
            return next
          })

        const run = async () => {
          let res
          try {
            res = await fetch('/hackertube/api/chat', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ vid, question: q, at: lastPlayhead, stream: true, lang, history }),
            })
          } catch (e) {
            settle(tx(lang, '请求失败：', 'Request failed: ') + String((e && e.message) || e))
            return
          }
          const type = res.headers.get('content-type') || ''
          if (!res.ok || !res.body || type.indexOf('text/event-stream') < 0) {
            const d = await res.json().catch(() => null)
            if (d && d.subtitle) setSubtitle(d.subtitle)
            settle(
              d && d.answer
                ? d.answer
                : tx(lang, '（' + ((d && d.error) || '没有拿到回答') + '）', '(' + ((d && d.error) || 'no answer') + ')'),
            )
            return
          }
          const reader = res.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ''
          let acc = ''
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            let cut = buffer.indexOf('\n\n')
            while (cut >= 0) {
              const raw = buffer.slice(0, cut).trim()
              buffer = buffer.slice(cut + 2)
              if (raw.indexOf('data:') === 0) {
                const payload = raw.slice(5).trim()
                if (payload === '[DONE]') continue
                try {
                  const evt = JSON.parse(payload)
                  if (evt.stage === 'subtitles') {
                    setStage('subtitles')
                  } else if (evt.stage === 'answer') {
                    setStage('answer')
                    if (evt.subtitle) setSubtitle(evt.subtitle)
                  } else if (evt.delta) {
                    acc += evt.delta
                    append(evt.delta)
                  } else if (evt.error) {
                    acc = tx(lang, '请求失败：', 'Request failed: ') + evt.error
                  } else if (evt.done && typeof evt.answer === 'string') {
                    acc = evt.answer
                    if (evt.subtitle) setSubtitle(evt.subtitle)
                  }
                } catch {
                  /* 半截 JSON，忽略 */
                }
              }
              cut = buffer.indexOf('\n\n')
            }
          }
          settle(acc)
        }

        run()
          .catch((e) => settle(tx(lang, '请求失败：', 'Request failed: ') + String((e && e.message) || e)))
          .finally(() => {
            setBusy(false)
            setStage(null)
          })
      }

      const subtitleNotice = (() => {
        if (!subtitle) return null
        const win = subtitle.window || {}
        if (subtitle.status === 'ok') {
          const range = fmtDur(win.start) + '–' + fmtDur(win.end)
          return {
            tone: 'ok',
            text: tx(
              lang,
              '已读取 ' + (win.count || 0) + ' 条字幕（' + range + '）',
              'Read ' + (win.count || 0) + ' subtitle lines (' + range + ')',
            ),
          }
        }
        const hint = subtitle.hint ? String(subtitle.hint) : ''
        if (subtitle.status === 'needs-cookies') {
          return { tone: 'needs-cookies', text: hint || tx(lang, '字幕需要 YouTube cookies。', 'Subtitles need YouTube cookies.') }
        }
        if (subtitle.status === 'missing-dependency') {
          return { tone: 'missing-dependency', text: hint || tx(lang, '字幕管线缺少依赖。', 'Subtitle pipeline dependency is missing.') }
        }
        if (subtitle.status === 'timeout') {
          return {
            tone: 'timeout',
            text: tx(lang, '字幕获取超时，本轮回答仅基于视频简介。', 'Subtitle lookup timed out; this answer uses the description only.'),
          }
        }
        if (subtitle.status === 'no-captions') {
          return {
            tone: 'no-captions',
            text: tx(lang, '本条视频没有可用字幕，回答仅基于视频简介。', 'No subtitles for this video; answers use the description only.'),
          }
        }
        return { tone: 'error', text: hint || tx(lang, '字幕不可用，回答仅基于视频简介。', 'Subtitles unavailable; answers use the description only.') }
      })()

      const tabBtn = (id, label, count) =>
        h(
          'button',
          {
            key: id,
            type: 'button',
            className: 'ht-rail-tab',
            'data-pane': id,
            'aria-selected': String(pane === id),
            onClick: () => onPane(id),
          },
          label,
          count != null ? h('span', { className: 'ht-rail-badge' }, String(count)) : null,
        )

      const relPane = h(
        'section',
        { key: 'rel', className: 'ht-rail-pane' },
        related && related.length
          ? related.map((r) =>
              h(
                'button',
                { key: r.v, type: 'button', className: 'ht-rel', onClick: () => onOpen(r) },
                h(
                  'div',
                  { className: 'ht-rel-thumb' },
                  r.th ? h('img', { src: r.th, alt: '', loading: 'lazy' }) : null,
                  r.d ? h('span', { className: 'ht-rel-dur' }, fmtDur(r.d)) : null,
                ),
                h(
                  'div',
                  { className: 'ht-rel-body' },
                  h('p', { className: 'ht-rel-title' }, titleOf(r, lang)),
                  h(
                    'p',
                    { className: 'ht-rel-meta' },
                    r.c || '',
                    r.c ? h('br', null) : null,
                    tx(lang, fmtCount(r.w || 0, lang) + ' 次观看', fmtCount(r.w || 0, lang) + ' views'),
                    r.p ? tx(lang, ' · ' + fmtAgo(r.p, lang), ' · ' + fmtAgo(r.p, lang)) : null,
                  ),
                ),
              ),
            )
          : h(
              'div',
              { className: 'ht-rail-empty' },
              tx(lang, '正在取相关推荐…', 'Loading related videos…'),
            ),
      )

      const aiPane = h(
        'section',
        { key: 'ai', className: 'ht-rail-pane ht-rail-ai' },
        h(
          'div',
          { className: 'ht-rail-log' },
          playhead && Number.isFinite(Number(playhead.t))
            ? h(
                'p',
                { className: 'ht-rail-pos' },
                tx(lang, '当前播放位置：', 'Playhead: ') + fmtDur(playhead.t),
              )
            : null,
          stage
            ? h(
                'p',
                { className: 'ht-sub-stage' },
                stage === 'subtitles'
                  ? tx(lang, '正在取当前播放位置附近的字幕…', 'Loading subtitles around your playhead…')
                  : tx(lang, '正在生成回答…', 'Generating answer…'),
              )
            : null,
          subtitleNotice
            ? h(
                'div',
                { className: 'ht-sub-note ht-sub-' + subtitleNotice.tone, 'data-status': subtitle.status },
                subtitleNotice.text,
              )
            : null,
          messages.length === 0
            ? h(
                'div',
                null,
                h(
                  'p',
                  { className: 'ht-rail-hint' },
                  tx(
                    lang,
                    '模型会读当前播放位置附近的字幕，所以「这段在讲什么」这类问题最准。',
                    'The model reads the subtitles around your playhead, so "what is this part about" works best.',
                  ),
                ),
                h(
                  'div',
                  { className: 'ht-rail-suggest' },
                  (lang === 'zh'
                    ? ['这段在讲什么？', '这里的关键概念是什么？', '他为什么这么说？']
                    : ['What is this part about?', "What's the key idea here?", 'Why does he say that?']
                  ).map((q) => h('button', { key: q, type: 'button', onClick: () => setInput(q) }, q)),
                ),
              )
            : messages.map((m, i) =>
                h(
                  'div',
                  { key: i, className: 'ht-msg ht-msg-' + m.role + (m.pending ? ' ht-msg-streaming' : '') },
                  m.role === 'ai' ? h(Markdown, { text: m.text }) : m.text,
                  m.pending ? h('span', { className: 'ht-caret', 'aria-hidden': 'true' }) : null,
                ),
              ),
        ),
        h(
          'form',
          {
            className: 'ht-rail-form',
            onSubmit: (e) => {
              e.preventDefault()
              send()
            },
          },
          h('input', {
            value: input,
            placeholder: busy
              ? tx(lang, '思考中…', 'Thinking…')
              : tx(lang, '就当前进度提问', 'Ask about this moment'),
            onChange: (e) => setInput(e.target.value),
            disabled: busy,
          }),
          h('button', { type: 'submit', disabled: busy || !input.trim() }, busy ? '…' : tx(lang, '发送', 'Send')),
        ),
      )

      return h(
        'aside',
        { className: 'ht-rail', 'data-pane': pane, ref: anchorRef },
        h(
          'div',
          { className: 'ht-rail-head', role: 'tablist' },
          h('span', { className: 'ht-rail-ind', 'aria-hidden': 'true' }),
          tabBtn('rel', tx(lang, '相关推荐', 'Related'), null),
          tabBtn('ai', tx(lang, 'AI 问答', 'Ask AI'), null),
        ),
        h('div', { className: 'ht-rail-viewport' }, h('div', { className: 'ht-rail-track' }, relPane, aiPane)),
      )
    }

    function WatchView({ item, onBack, lang, liked, savedLater, onToggle, onOpenItem }) {
      const [detail, setDetail] = useState(null)
      const [err, setErr] = useState('')
      const [origin, setOrigin] = useState(mem.mediaOrigin || null)
      const [related, setRelated] = useState(null)
      const [railPane, setRailPane] = useState('rel')
      const [descOpen, setDescOpen] = useState(false)
      const [descFit, setDescFit] = useState(true)
      const descRef = useRef(null)
      const [ctr, setCtr] = useState({})
      const [ctrOn, setCtrOn] = useState({})
      const [ctrBusy, setCtrBusy] = useState({})
      const [playErr, setPlayErr] = useState(null)
      const [playerKey, setPlayerKey] = useState(0)
      const [localMode, setLocalMode] = useState('idle')
      const [localBusy, setLocalBusy] = useState(false)
      const [depHint, setDepHint] = useState([])
      const [localErr, setLocalErr] = useState('')
      const [trText, setTrText] = useState(null)
      const [trSource, setTrSource] = useState({})
      const [trBusy, setTrBusy] = useState(false)
      /* 自动补译每个「视频 + 语言」只跑一次，避免字段永远补不全导致的循环请求 */
      const trTriedRef = useRef(null)
      const watchScrollRef = useRef(null)
      const railRef = useRef(null)
      const [playhead, setPlayhead] = useState(() => watchSession(item.v).playhead)
      /* 上次看到的位置；0 表示从头开始 */
      const [resumeFrom, setResumeFrom] = useState(0)
      /* 备用片源：命中才渲染按钮，没命中就一直保持 null，界面上什么都不出现 */
      const [mirror, setMirror] = useState(null)

      /* 播放位置按视频隔离：暂停后 relay 不再发事件，这里仍保留最后一次的值 */
      useEffect(() => {
        setPlayhead(watchSession(item.v).playhead || null)
        const sub = (vid, position) => {
          if (vid === item.v) setPlayhead(position)
        }
        mem.playheadSubs.add(sub)
        return () => {
          mem.playheadSubs.delete(sub)
          /* 离开这条视频时补一次落盘：看得短、还没到 15 秒节流点也不会丢 */
          const last = watchSession(item.v).playhead
          if (last) saveProgress(item.v, last)
        }
      }, [item.v])

      /* 续播：进度来自记忆里的 map，没有就先拉一次，再交给中转页 seek */
      useEffect(() => {
        let alive = true
        const known = resumeAt(item.v, item.d)
        if (known) setResumeFrom(known)
        ensureProgress().then(() => {
          if (!alive) return
          const at = resumeAt(item.v, item.d)
          if (at) setResumeFrom(at)
        })
        return () => {
          alive = false
        }
      }, [item.v])

      useEffect(() => {
        let alive = true
        loadMediaOrigin().then((o) => {
          if (!alive) return
          setOrigin(o)
          beacon('watch-open', {
            vid: item.v,
            mediaOrigin: o || null,
            finalSrc: o ? o + '/embed?vid=' + encodeURIComponent(item.v) : null,
          })
        })
        return () => {
          alive = false
        }
      }, [item.v])

      useEffect(() => {
        let alive = true
        setDetail(null)
        setErr('')
        setDescOpen(false)
        setCtr({})
        setCtrOn({})
        setCtrBusy({})
        setTrText(null)
        trTriedRef.current = null
        setTrSource({})
        setTrBusy(false)
        /* 语言只影响这一次请求带不带 lang=zh；切语言后由下面的异步翻译补齐，不重拉详情 */
        loadDetail(item.v, lang)
          .then((d) => {
            if (alive) setDetail(d)
          })
          .catch((e) => {
            if (alive) setErr(String((e && e.message) || e))
          })
        return () => {
          alive = false
        }
      }, [item.v])

      useEffect(() => {
        let alive = true
        setRelated(null)
        getJSON('/hackertube/api/related?vid=' + encodeURIComponent(item.v))
          .then((d) => {
            if (alive) setRelated(Array.isArray(d) ? d : [])
          })
          .catch(() => {
            if (alive) setRelated([])
          })
        return () => {
          alive = false
        }
      }, [item.v])

      /* 备用片源异步查，不挡正文：拿到就补一个按钮，没拿到就不出现。
         结果在 Host 侧落盘缓存，同一个视频第二次打开是 0 延迟。 */
      useEffect(() => {
        let alive = true
        setMirror(null)
        getJSON('/hackertube/api/mirror?vid=' + encodeURIComponent(item.v))
          .then((d) => {
            if (alive && d && d.url) setMirror(d)
          })
          .catch(() => {
            /* 查不到不是错误，只是没有别的源 */
          })
        return () => {
          alive = false
        }
      }, [item.v])

      /* 中转页的错误消息先进模块级缓存，再由当前观看页订阅；切视频时旧错误不跟过来 */
      useEffect(() => {
        mem.playback.delete(item.v)
        setPlayErr(null)
        setLocalMode('idle')
        setLocalBusy(false)
        setDepHint([])
        setLocalErr('')
        mem.activeWatchVid = item.v
        const sub = (vid, error) => {
          if (vid === item.v) setPlayErr(error)
        }
        mem.playbackSubs.add(sub)
        return () => {
          mem.playbackSubs.delete(sub)
          if (mem.activeWatchVid === item.v) mem.activeWatchVid = null
        }
      }, [item.v])

      /* 相关视频是同一个组件换 item：滚动容器不会自动归零，必须显式回到顶部 */
      useEffect(() => {
        const el = watchScrollRef.current
        if (el) el.scrollTop = 0
      }, [item.v])

      const hn = detail && detail.hn ? detail.hn : null
      const threadId = detail && detail.quote && detail.quote.id ? detail.quote.id : null
      /* 中文模式下优先用已拿到的译文，没有则退回原文 */
      const tr = lang === 'zh' && trText ? trText : {}
      const trSourceFor = (field) => (lang === 'zh' && trText && trText[field] ? trSource[field] || null : null)
      const trBadge = (field) => {
        const source = trSourceFor(field)
        if (!source) return null
        return h(
          'span',
          { className: 'ht-tr-badge', key: 'tr-' + field },
          source === 'model' ? tx(lang, '模型译', 'Model') : tx(lang, '机翻', 'Machine'),
        )
      }
      const quoteText =
        (lang === 'zh' ? tr.quote : null) || (detail && detail.quote && detail.quote.text ? detail.quote.text : '')
      const whyHnText = (lang === 'zh' ? tr.why_hn : null) || (detail && detail.why_hn) || ''
      const summaryText = (lang === 'zh' && tr.summary) || (detail && detail.summary) || ''
      const comments = detail && Array.isArray(detail.comments) ? detail.comments : []
      const tags = detail && Array.isArray(detail.tags) ? detail.tags : []
      const ctLabel = item.ct ? tx(lang, CT_ZH[item.ct] || item.ct, item.ct) : ''
      const lvLabel = item.lv ? tx(lang, LV_ZH[item.lv] || item.lv, item.lv) : ''
      /* 简介卡内容不空才渲染，避免空灰条 */
      const hasDesc = !!(summaryText || whyHnText || quoteText || tags.length || (hn && hn.strong))
      const showMore = !descFit || descOpen

      /* 详情返回的缓存译文直接显示；来源标识跟着译文一起进来 */
      useEffect(() => {
        if (!detail) return
        const cached = detail.i18n && Object.keys(detail.i18n).some((k) => detail.i18n[k]) ? detail.i18n : null
        setTrText(cached)
        setTrSource(detail.i18nSource || {})
      }, [detail])

      /* 译文不阻塞详情：详情先出原文，缺的字段再异步补齐 */
      useEffect(() => {
        if (lang !== 'zh' || !detail) {
          setTrBusy(false)
          return undefined
        }
        const fields = []
        if (typeof detail.summary === 'string' && detail.summary.trim()) fields.push('summary')
        if (typeof detail.why_hn === 'string' && detail.why_hn.trim()) fields.push('why_hn')
        if (detail.quote && typeof detail.quote.text === 'string' && detail.quote.text.trim()) fields.push('quote')
        if (!fields.length) {
          setTrBusy(false)
          return undefined
        }
        /* 详情带的缓存译文和已经补到的译文都算数，任缺一项才补 */
        const cached = detail.i18n || {}
        const have = (field) => !!cached[field] || !!(trText && trText[field])
        if (fields.every(have) || trTriedRef.current === lang + ':' + item.v) {
          setTrBusy(false)
          return undefined
        }
        let alive = true
        setTrBusy(true)
        /* 模型慢或卡住时不能让「正在翻译…」一直挂着：超时只是不再等，原文照旧可读 */
        const ctrl = typeof AbortController === 'function' ? new AbortController() : null
        const timer = ctrl ? setTimeout(() => ctrl.abort(), TR_BUDGET_MS) : null
        /* 每条视频每种语言只自动补一次：模型对过短的字段会跳过，反复补就是死循环 */
        trTriedRef.current = lang + ':' + item.v
        fetch('/hackertube/api/video/translate?vid=' + encodeURIComponent(item.v), ctrl ? { signal: ctrl.signal } : undefined)
          .then((r) => {
            if (!r.ok) throw new Error('HTTP ' + r.status)
            return r.json()
          })
          .then((d) => {
            if (!alive || !d || !d.i18n) return
            setTrText(d.i18n)
            setTrSource(d.i18nSource || {})
            mem.detail.set(
              detailCacheKey(item.v, 'zh'),
              Object.assign({}, detail, { i18n: d.i18n, i18nSource: d.i18nSource || {} }),
            )
          })
          .catch(() => {})
          .then(() => {
            if (timer) clearTimeout(timer)
            if (alive) setTrBusy(false)
          })
        return () => {
          alive = false
          if (timer) clearTimeout(timer)
        }
      }, [lang, detail, item.v])

      useEffect(() => {
        if (descOpen) return
        const el = descRef.current
        if (!el) return
        setDescFit(el.scrollHeight <= el.clientHeight + 2)
      }, [detail, lang, descOpen, item.v, trText, trBusy])

      /* 评论翻译：Host 按评论 id 缓存，已有的直接切显示，没有才发请求 */
      const runCommentTr = (ids) => {
        const targets = ids || comments.map((c) => String(c.id))
        if (!targets.length) return
        const busy = {}
        for (const id of targets) busy[id] = true
        setCtrBusy(busy)
        const payload = { vid: item.v }
        if (ids) payload.ids = targets
        fetch('/hackertube/api/comments/translate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        })
          .then((r) => r.json())
          .then((d) => {
            if (!d || !d.entries) return
            setCtr((prev) => Object.assign({}, prev, d.entries))
            const on = {}
            for (const id of Object.keys(d.entries)) on[id] = true
            setCtrOn((prev) => Object.assign({}, prev, on))
          })
          .catch(() => {})
          .then(() => setCtrBusy({}))
      }
      const toggleCommentTr = (id) => {
        const key = String(id)
        if (ctr[key]) {
          setCtrOn((prev) => Object.assign({}, prev, { [key]: !prev[key] }))
          return
        }
        runCommentTr([key])
      }

      const retryPlayer = () => {
        mem.playback.delete(item.v)
        setPlayErr(null)
        setLocalMode('idle')
        setLocalErr('')
        setDepHint([])
        setPlayerKey((k) => k + 1)
      }

      const dependencyHints = (d) => {
        const missing = []
        if (!d || !d.ytdlp || !d.ytdlp.ok) {
          missing.push(
            tx(lang, '缺少 yt-dlp：', 'yt-dlp is missing: ') +
              ((d && d.ytdlp && d.ytdlp.hint) || 'pip install -U yt-dlp'),
          )
        }
        if (!d || !d.ffmpeg || !d.ffmpeg.ok) {
          missing.push(
            tx(lang, '缺少 ffmpeg：', 'ffmpeg is missing: ') +
              ((d && d.ffmpeg && d.ffmpeg.hint) || 'install ffmpeg and add it to PATH'),
          )
        }
        return missing
      }

      /* 播放失败时就探测一次依赖：缺什么直接写在错误层里，不用用户再点一次 */
      useEffect(() => {
        if (!playErr) return undefined
        let alive = true
        getJSON('/hackertube/api/deps')
          .then((d) => {
            if (alive) setDepHint(dependencyHints(d))
          })
          .catch(() => {})
        return () => {
          alive = false
        }
      }, [playErr, item.v, lang])

      /* 用户主动点「尝试本地直连」才起流；缺什么就报什么，不自动装环境 */
      const startLocal = () => {
        if (localBusy) return
        setLocalBusy(true)
        setDepHint([])
        setLocalErr('')
        getJSON('/hackertube/api/deps')
          .then((d) => {
            const missing = dependencyHints(d)
            if (missing.length) {
              setDepHint(missing)
              return
            }
            setLocalMode('stream')
          })
          .catch((e) => {
            setDepHint([tx(lang, '依赖探测失败：', 'Dependency check failed: ') + String((e && e.message) || e)])
          })
          .then(() => setLocalBusy(false))
      }

      const jumpToRail = () => {
        const el = railRef.current
        if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'start', behavior: 'smooth' })
      }

      const errCopy = playbackErrorCopy(playErr, lang)
      const localBase = origin || ''
      const localSrc =
        (localBase || '/hackertube/api') +
        '/' +
        (localMode === 'media' ? 'media' : 'stream') +
        '?vid=' +
        encodeURIComponent(item.v)

      return h(
        'div',
        { className: 'ht-watch', ref: watchScrollRef },
        h(
          'div',
          { className: 'ht-toolbar' },
          h('button', { type: 'button', className: 'ht-back', onClick: onBack }, tx(lang, '← 返回列表', '← Back to list')),
          h(
            'button',
            { type: 'button', className: 'ht-back ht-rail-jump', onClick: jumpToRail },
            tx(lang, '相关推荐与 AI ↓', 'Related & AI ↓'),
          ),
        ),
        h(
          'div',
          { className: 'ht-watch-inner' },
          h(
            'div',
            { className: 'ht-primary' },
            h(
              'div',
              { className: 'ht-player' },
              localMode !== 'idle'
                ? h('video', {
                    key: 'local-' + localMode,
                    className: 'ht-video',
                    src: localSrc,
                    controls: true,
                    autoPlay: true,
                    poster: item.th || undefined,
                    onError: () =>
                      setLocalErr(
                        tx(
                          lang,
                          '本地直连播放失败，可以在 YouTube 上打开。',
                          'Local playback failed; open it on YouTube instead.',
                        ),
                      ),
                  })
                : playErr
                  ? h(
                      'div',
                      { className: 'ht-player-error', role: 'alert' },
                      h('b', null, errCopy.title),
                      h('p', null, errCopy.hint),
                      depHint.map((line, i) => h('p', { key: 'dep' + i, className: 'ht-error-dep' }, line)),
                      localErr ? h('p', { className: 'ht-error-dep' }, localErr) : null,
                      h(
                        'div',
                        { className: 'ht-player-error-actions' },
                        h('button', { type: 'button', className: 'ht-error-btn', onClick: retryPlayer }, tx(lang, '重试播放器', 'Retry player')),
                        h(
                          'a',
                          {
                            className: 'ht-error-btn',
                            href: 'https://www.youtube.com/watch?v=' + item.v,
                            target: '_blank',
                            rel: 'noreferrer noopener',
                          },
                          tx(lang, '在 YouTube 打开', 'Open on YouTube'),
                        ),
                        h(
                          'button',
                          { type: 'button', className: 'ht-error-btn ghost', onClick: startLocal, disabled: localBusy },
                          localBusy
                            ? tx(lang, '正在检查依赖…', 'Checking dependencies…')
                            : tx(lang, '尝试本地直连', 'Try local playback'),
                        ),
                      ),
                    )
                  : origin
                    ? h('iframe', {
                        key: 'embed-' + playerKey,
                        className: 'ht-video',
                        title: item.t,
                        src:
                      origin +
                      '/embed?vid=' +
                      encodeURIComponent(item.v) +
                      '&lang=' +
                      (lang === 'zh' ? 'zh' : 'en') +
                      (resumeFrom ? '&start=' + resumeFrom : ''),
                        allow:
                          'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen',
                        allowFullScreen: true,
                        onLoad: () => beacon('iframe-loaded', { vid: item.v }),
                      })
                    : h('div', { className: 'ht-video ht-video-wait' }, tx(lang, '正在准备播放器…', 'Preparing player…')),
            ),
            localMode !== 'idle'
              ? h(
                  'p',
                  { className: 'ht-player-note' },
                  localMode === 'stream'
                    ? tx(lang, '本地直连为流式播放，暂不支持拖动。', 'Local stream playback does not support seeking yet.')
                    : tx(lang, '正在播放本地缓存，可拖动进度。', 'Playing the local cache; seeking is supported.'),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'ht-link',
                      onClick: () => setLocalMode((m) => (m === 'stream' ? 'media' : 'stream')),
                    },
                    localMode === 'stream'
                      ? tx(lang, '改用缓存播放（可拖动）', 'Use cached playback (seekable)')
                      : tx(lang, '改用流式播放', 'Use stream playback'),
                  ),
                  h('button', { type: 'button', className: 'ht-link', onClick: retryPlayer }, tx(lang, '返回内嵌播放器', 'Back to embedded player')),
                  localErr ? h('span', { className: 'ht-error-dep' }, localErr) : null,
                )
              : null,
            h('h1', { className: 'ht-h1' }, titleOf(item, lang)),
            resumeFrom
              ? h(
                  'p',
                  { className: 'ht-resume' },
                  tx(lang, '从上次的 ', 'Resumed at ') + fmtDur(resumeFrom),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'ht-resume-reset',
                      onClick: () => {
                        setResumeFrom(0)
                        setPlayerKey((k) => k + 1)
                      },
                    },
                    tx(lang, '从头开始', 'Start over'),
                  ),
                )
              : null,
            item.c ? h('p', { className: 'ht-channel' }, item.c) : null,
            h(
              'div',
              { className: 'ht-meta' },
              item.w
                ? h('span', { key: 'w' }, tx(lang, fmtCount(item.w, lang) + ' 次观看', fmtCount(item.w, lang) + ' views'))
                : null,
              item.d ? h('span', { key: 'd' }, fmtDur(item.d)) : null,
              item.p ? h('span', { key: 'p' }, fmtAgo(item.p, lang)) : null,
              hn
                ? h(
                    'span',
                    { key: 'hn', className: 'ht-hn-mark' },
                    h('i', { 'aria-hidden': 'true' }),
                    tx(
                      lang,
                      hn.mentions + ' 次被提及 · ' + (hn.recommenders || 0) + ' 人推荐' +
                        (hn.first ? ' · ' + (hn.first === hn.last ? hn.first : hn.first + '–' + hn.last) : ''),
                      hn.mentions + ' mentions · ' + (hn.recommenders || 0) + ' recommenders' +
                        (hn.first ? ' · ' + (hn.first === hn.last ? hn.first : hn.first + '–' + hn.last) : ''),
                    ),
                  )
                : null,
            ),
            h(
              'div',
              { className: 'ht-actions' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'ht-pill' + (liked ? ' on' : ''),
                  onClick: () => onToggle('likes', item.v),
                },
                h(Ico, null, h('path', { d: 'M7 10v10H4V10zM7 20h9.2a2 2 0 0 0 2-1.6l1.2-6A2 2 0 0 0 17.4 10H13V6.5A2.5 2.5 0 0 0 10.5 4L7 10' })),
                liked ? tx(lang, '已喜欢', 'Liked') : tx(lang, '喜欢', 'Like'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'ht-pill' + (savedLater ? ' on' : ''),
                  onClick: () => onToggle('later', item.v),
                },
                h(Ico, null, h('circle', { cx: 12, cy: 12, r: 9 }), h('path', { d: 'M12 7v5l3.2 2' })),
                savedLater ? tx(lang, '已加入稍后看', 'Saved') : tx(lang, '稍后看', 'Watch later'),
              ),
              h(
                'a',
                {
                  className: 'ht-pill ht-pill-ghost',
                  href: 'https://www.youtube.com/watch?v=' + item.v,
                  target: '_blank',
                  rel: 'noreferrer noopener',
                },
                h(Ico, { fill: true }, h('path', { d: 'M23 12s-4.2-6.5-11-6.5S1 12 1 12s4.2 6.5 11 6.5S23 12 23 12zm-11 4a4 4 0 1 1 0-8 4 4 0 0 1 0 8z' })),
                tx(lang, '在 YouTube 观看', 'Watch on YouTube'),
              ),
              /* 备用片源。只有查到了才出现，查不到就完全没有这个入口。 */
              mirror && mirror.url
                ? h(
                    'a',
                    {
                      className: 'ht-pill ht-pill-ghost',
                      href: mirror.url,
                      target: '_blank',
                      rel: 'noreferrer noopener',
                      title:
                        (mirror.up || '') +
                        (mirror.play ? ' · ' + fmtCount(mirror.play, lang) + tx(lang, ' 次播放', ' views') : ''),
                    },
                    h(
                      Ico,
                      null,
                      h('rect', { x: 3, y: 7.5, width: 18, height: 12.5, rx: 3 }),
                      h('path', { d: 'M8.5 3.5L12 7l3.5-3.5M7.5 12.5v3M16.5 12.5v3' }),
                    ),
                    tx(lang, '在 B 站观看', 'Watch on Bilibili'),
                    mirror.label
                      ? h('span', { className: 'ht-pill-tag' }, mirrorTag(lang, mirror.label))
                      : null,
                  )
                : null,
            ),
            err
              ? h('p', { className: 'ht-note' }, tx(lang, '详情加载失败：', 'Failed to load details: ') + err)
              : null,
            !detail && !err
              ? h('p', { className: 'ht-note' }, tx(lang, '正在读取 HN 讨论记录…', 'Reading the HN threads…'))
              : null,
            hasDesc
              ? h(
                  'section',
                  { className: 'ht-desc' + (descOpen ? '' : ' clamped') },
                  ctLabel || lvLabel || trBusy
                    ? h(
                        'div',
                        { className: 'ht-desc-head' },
                        ctLabel ? h('span', { key: 'ct' }, ctLabel) : null,
                        ctLabel && lvLabel ? h('span', { key: 'dot' }, '·') : null,
                        lvLabel ? h('span', { key: 'lv' }, lvLabel) : null,
                        trBusy
                          ? h('span', { key: 'tr', className: 'ht-tr-busy' }, tx(lang, '正在翻译…', 'Translating…'))
                          : null,
                      )
                    : null,
                  h(
                    'div',
                    { className: 'ht-desc-body', ref: descRef },
                    summaryText
                      ? h('p', { className: 'ht-desc-p', key: 's' }, summaryText, trBadge('summary'))
                      : null,
                    whyHnText
                      ? h('p', { className: 'ht-desc-p ht-desc-why', key: 'w' }, whyHnText, trBadge('why_hn'))
                      : null,
                    quoteText
                      ? h(
                          'p',
                          { className: 'ht-desc-quote', key: 'q' },
                          tx(lang, '「' + quoteText + '」', '“' + quoteText + '”'),
                          trBadge('quote'),
                        )
                      : null,
                    hn || tags.length
                      ? h(
                          'div',
                          { className: 'ht-desc-tags', key: 't' },
                          hn && hn.strong
                            ? h(
                                'span',
                                { className: 'ht-stat ht-stat-strong', key: 'strong' },
                                h('b', null, String(hn.strong)),
                                tx(lang, ' 次强烈推荐', hn.strong === 1 ? ' strong rec' : ' strong recs'),
                              )
                            : null,
                          tags.map((t) => h('span', { className: 'ht-tag', key: t }, t)),
                        )
                      : null,
                  ),
                  showMore
                    ? h(
                        'button',
                        { type: 'button', className: 'ht-desc-more', onClick: () => setDescOpen((v) => !v) },
                        descOpen ? tx(lang, '收起', 'Show less') : tx(lang, '展开', 'Show more'),
                      )
                    : null,
                )
              : null,
          ),
          h(SideRail, {
            key: 'rail',
            vid: item.v,
            lang,
            related,
            pane: railPane,
            onPane: setRailPane,
            onOpen: onOpenItem,
            anchorRef: railRef,
            playhead,
          }),
          detail
            ? h(
                  'section',
                  { className: 'ht-comments' },
                  h(
                    'div',
                    { className: 'ht-comments-head' },
                    h(
                      'h2',
                      null,
                      tx(lang, 'HN 上的讨论', 'On Hacker News'),
                      h('span', null, String(comments.length)),
                    ),
                    threadId || comments.length
                      ? h(
                          'div',
                          { className: 'ht-comments-acts' },
                          comments.length && lang === 'zh'
                            ? h(
                                'button',
                                { type: 'button', className: 'ht-link', onClick: () => runCommentTr(null) },
                                tx(lang, '翻译全部', 'Translate all'),
                              )
                            : null,
                          threadId
                            ? h(
                                'a',
                                {
                                  className: 'ht-link',
                                  href: 'https://news.ycombinator.com/item?id=' + threadId,
                                  target: '_blank',
                                  rel: 'noreferrer noopener',
                                },
                                tx(lang, '查看原帖 →', 'View thread →'),
                              )
                            : null,
                        )
                      : null,
                  ),
                  h(
                    'p',
                    { className: 'ht-comments-sub' },
                    tx(lang, '评论按 HN 上的推荐力度排序，保留原文；可逐条机翻。', 'Sorted by how strongly HN recommends it, in the original language.'),
                  ),
                  comments.length
                    ? comments.map((c) =>
                    h(
                      'article',
                      { className: 'ht-comment', key: c.id },
                      h(
                        'div',
                        { className: 'ht-comment-head' },
                        h('b', null, c.author || 'anon'),
                        c.ym ? h('span', null, c.ym) : null,
                        c.stance
                          ? h(
                              'span',
                              { className: 'ht-stance ht-stance-' + c.stance },
                              tx(
                                lang,
                                { strong_rec: '强烈推荐', rec: '推荐', reference: '引用' }[c.stance] || c.stance,
                                c.stance.replace('_', ' '),
                              ),
                            )
                          : null,
                        c.text && lang === 'zh'
                          ? h(
                              'button',
                              {
                                type: 'button',
                                className: 'ht-comment-tr',
                                onClick: () => toggleCommentTr(c.id),
                                disabled: !!ctrBusy[c.id],
                              },
                              ctrBusy[c.id]
                                ? tx(lang, '翻译中…', 'Translating…')
                                : ctrOn[c.id]
                                  ? tx(lang, '原文', 'Original')
                                  : tx(lang, '翻译', 'Translate'),
                            )
                          : null,
                      ),
                      c.text
                        ? h('p', { className: 'ht-comment-text' }, ctrOn[c.id] && ctr[c.id] ? ctr[c.id] : c.text)
                        : null,
                      h(
                        'a',
                        {
                          className: 'ht-comment-link',
                          href: 'https://news.ycombinator.com/item?id=' + c.id,
                          target: '_blank',
                          rel: 'noreferrer noopener',
                        },
                        tx(lang, '看原帖', 'Open thread'),
                      ),
                    ),
                  )
                    : h(
                        'p',
                        { className: 'ht-note' },
                        tx(lang, 'Hacker News 上没有找到可展示的评论。', 'No comments to show from Hacker News.'),
                      ),
                )
              : null,
        ),
      )
    }

    /* ---------------- 主面板 ---------------- */


    /* ---------------- 本地集合 ---------------- */

    function readArr(key) {
      try {
        const v = JSON.parse(localStorage.getItem(key))
        return Array.isArray(v) ? v : []
      } catch {
        return []
      }
    }
    function writeArr(key, arr) {
      try {
        localStorage.setItem(key, JSON.stringify(arr))
      } catch {
        /* 私密模式下写不进去，不影响本次会话 */
      }
    }

    function useSaved() {
      const [saved, setSaved] = useState(() => ({
        likes: readArr('ht.likes'),
        later: readArr('ht.later'),
        seen: readArr('ht.seen'),
        dismissed: readArr('ht.dismissed'),
        blocked: readArr('ht.blocked'),
      }))
      const saveTimer = useRef(null)
      /* 订阅回调里拿到的 saved 可能是旧闭包，写集合前先读最新的 */
      const savedRef = useRef(saved)
      savedRef.current = saved
      /* dsh-app:// 下的 localStorage 不保证可用或跨会话，真正的存档放在 host 端 */
      useEffect(() => {
        let alive = true
        getJSON('/hackertube/api/prefs')
          .then((d) => {
            if (!alive || !d) return
            setSaved({
              likes: Array.isArray(d.likes) ? d.likes : [],
              later: Array.isArray(d.later) ? d.later : [],
              seen: Array.isArray(d.seen) ? d.seen : [],
              dismissed: Array.isArray(d.dismissed) ? d.dismissed : [],
              blocked: Array.isArray(d.blocked) ? d.blocked : [],
            })
            /* 宿主存档才是权威，把会话内的同步去重集合对齐过去 */
            mem.tvBlocked = new Set(Array.isArray(d.blocked) ? d.blocked : [])
          })
          .catch(() => {})
        return () => {
          alive = false
        }
      }, [])
      const update = (next) => {
        setSaved(next)
        writeArr('ht.likes', next.likes)
        writeArr('ht.later', next.later)
        writeArr('ht.seen', next.seen)
        writeArr('ht.dismissed', next.dismissed)
        writeArr('ht.blocked', next.blocked)
        if (saveTimer.current) clearTimeout(saveTimer.current)
        saveTimer.current = setTimeout(() => {
          try {
            void fetch('/hackertube/api/prefs', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                likes: next.likes,
                later: next.later,
                seen: next.seen,
                dismissed: next.dismissed,
                blocked: next.blocked,
              }),
            }).catch(() => {})
          } catch {
            /* 离线时只留本地副本 */
          }
        }, 400)
      }
      const toggle = (bucket, vid) => {
        const cur = saved[bucket]
        const next = cur.indexOf(vid) >= 0 ? cur.filter((x) => x !== vid) : cur.concat(vid)
        update(Object.assign({}, saved, { [bucket]: next }))
        return next.indexOf(vid) >= 0
      }
      const markSeen = (vid) => {
        const next = saved.seen.filter((x) => x !== vid).concat(vid).slice(-200)
        update(Object.assign({}, saved, { seen: next }))
      }
      /* 作者不允许内嵌：记进宿主 prefs，之后抽样与队列都避开 */
      const blockEmbed = (vid) => {
        if (!vid) return
        const cur = savedRef.current
        if (cur.blocked.indexOf(vid) >= 0) return
        update(Object.assign({}, cur, { blocked: cur.blocked.concat(vid).slice(-300) }))
      }
      return { saved, toggle, markSeen, blockEmbed }
    }

    /* ---------------- 视图组件 ---------------- */

    const NAV = {
      zh: [['home', '首页'], ['cats', '分类'], ['pl', '播放列表'], null, ['liked', '喜欢'], ['later', '稍后看'], ['history', '历史'], null, ['tv', '电视']],
      en: [['home', 'Home'], ['cats', 'Categories'], ['pl', 'Playlists'], null, ['liked', 'Liked'], ['later', 'Watch later'], ['history', 'History'], null, ['tv', 'TV']],
    }

    function ViewNav(props) {
      const tabs = NAV[props.lang] || NAV.zh
      return h(
        'div',
        { className: 'ht-nav' },
        h(
          'div',
          { className: 'ht-tabs' },
          tabs.map((t, i) =>
            t
              ? h(
                  'button',
                  {
                    key: t[0],
                    type: 'button',
                    'data-view': t[0],
                    className: 'ht-tab' + (t[0] === 'tv' ? ' ht-tab-tv' : '') + (props.view === t[0] ? ' on' : ''),
                    onClick: () => props.onPick(t[0]),
                  },
                  t[1],
                )
              : h('span', { key: 'sep' + i, className: 'ht-tab-sep' }),
          ),
        ),
      )
    }

    /** 首屏/后台加载阶段文案；Host 只给状态，翻译留在前端。 */
    function stageLabel(lang, status) {
      const stage = status && status.stage
      if (stage === 'export') {
        return tx(lang, '正在读取本地视频导出…', 'Loading local video export…')
      }
      if (stage === 'metadata') {
        const total = Number(status.total) || 0
        const done = Number(status.enriched) || 0
        return total
          ? tx(lang, '正在同步视频元信息 ' + done + '/' + total + '…', 'Syncing video metadata ' + done + '/' + total + '…')
          : tx(lang, '正在同步视频元信息…', 'Syncing video metadata…')
      }
      if (stage === 'comments') {
        return tx(lang, '正在解析 HN 评论…', 'Parsing HN comments…')
      }
      if (stage === 'ready' || stage === 'idle') return ''
      return tx(lang, '正在准备视频库…', 'Preparing the video library…')
    }

    /** 旧缓存提示：重新验证中说明在更新，失败后说明网络不可用。 */
    function staleLabel(lang, status) {
      if (!status || !status.stale) return ''
      return status.revalidating
        ? tx(lang, '显示的是本地旧缓存，正在后台更新…', 'Showing a stale local cache; refreshing in the background…')
        : tx(lang, '显示的是本地旧缓存，网络不可用，内容可能不是最新', 'Showing a stale local cache; the network is unavailable, so content may be outdated')
    }

    function Skeleton(props) {
      const label = props && props.label
      return h(
        'div',
        { className: 'ht-scroll' },
        label ? h('div', { className: 'ht-loading-text' }, label) : null,
        h(
          'div',
          { className: 'ht-skel' },
          [0, 1, 2, 3, 4, 5].map((i) =>
            h('div', { key: i }, h('i', { className: 'b' }), h('i', { className: 'l' }), h('i', { className: 'm' })),
          ),
        ),
      )
    }

    function EmptyState(props) {
      return h(
        'div',
        { className: 'ht-empty' },
        h('b', null, props.title),
        props.hint ? h('span', null, props.hint) : null,
        props.action
          ? h('button', { type: 'button', className: 'ht-chip', onClick: props.onAction }, props.action)
          : null,
      )
    }

    function AreaList(props) {
      const lang = props.lang
      return h(
        'div',
        { className: 'ht-scroll' },
        h(
          'div',
          { className: 'ht-areas' },
          props.areas.map((a) =>
            h(
              'button',
              { key: a.id, type: 'button', className: 'ht-area', onClick: () => props.onPick(a.id) },
              h('h3', null, lang === 'zh' && a.nameZh ? a.nameZh : a.name, h('em', null, String(a.count || ''))),
              h(
                'div',
                { className: 'ht-cats' },
                (a.categories || []).slice(0, 6).map((c) =>
                  h('span', { key: c.id, className: 'ht-cat' }, lang === 'zh' && c.nameZh ? c.nameZh : c.name),
                ),
              ),
            ),
          ),
        ),
      )
    }

    function PlaylistGrid(props) {
      const lang = props.lang
      const list = props.list || []
      const start = list.filter((p) => p.tier === 'start')
      const deep = list.filter((p) => p.tier !== 'start')
      const card = (p) =>
        h(
          'button',
          { key: p.slug, type: 'button', className: 'ht-pl', onClick: () => props.onOpen(p.slug) },
          h(
            'div',
            { className: 'ht-mosaic' },
            (p.cover || []).slice(0, 4).map((v, i) =>
              h('img', { key: i, src: 'https://i.ytimg.com/vi/' + v + '/hqdefault.jpg', alt: '', loading: 'lazy' }),
            ),
            h(
              'span',
              { className: 'ht-count' },
              tx(lang, p.count + ' 个 · ' + Math.floor(p.minutes / 60) + ' 小时', p.count + ' videos · ' + Math.floor(p.minutes / 60) + 'h'),
            ),
          ),
          h('h3', null, lang === 'zh' && p.titleZh ? p.titleZh : p.title),
          h('p', null, lang === 'zh' && p.pitchZh ? p.pitchZh : p.pitch),
        )
      return h(
        'div',
        { className: 'ht-scroll' },
        start.length ? h('div', { className: 'ht-sechead' }, h('h2', null, lang === 'zh' ? '从这里开始' : 'Start here')) : null,
        h('div', { className: 'ht-plgrid' }, start.map(card)),
        deep.length ? h('div', { className: 'ht-sechead' }, h('h2', null, lang === 'zh' ? '深挖' : 'Deep dives')) : null,
        h('div', { className: 'ht-plgrid' }, deep.map(card)),
      )
    }

    function PlaylistDetail(props) {
      const pl = props.pl
      const lang = props.lang
      return h(
        'div',
        { className: 'ht-scroll' },
        h(
          'div',
          { style: { padding: '24px 24px 0' } },
          h('h2', { style: { margin: '0 0 6px', fontSize: '21px', fontWeight: 600 } },
            props.lang === 'zh' && pl.titleZh ? pl.titleZh : pl.title),
          h(
            'p',
            { style: { margin: '0 0 8px', color: 'var(--dsw-alias-label-secondary)', fontSize: '13px', maxWidth: '72ch' } },
            lang === 'zh' ? pl.pitchZh || pl.pitch || pl.intro || '' : pl.intro || pl.pitch || '',
          ),
          h(
            'div',
            { style: { fontSize: '12.5px', color: 'var(--dsw-alias-label-secondary)', marginBottom: '12px' } },
            tx(lang, (pl.videos || []).length + ' 个视频 · ' + pl.minutes + ' 分钟', (pl.videos || []).length + ' videos · ' + pl.minutes + ' min'),
          ),
        ),
        h(
          'div',
          { style: { padding: '0 24px 40px' } },
          (pl.videos || []).map((v, i) =>
            h(
              'button',
              { key: v.vid, type: 'button', className: 'ht-row', onClick: () => props.onOpen(v) },
              h(
                'div',
                { className: 'ht-thumb' },
                h('img', {
                  src: v.thumbnail || 'https://i.ytimg.com/vi/' + v.vid + '/mqdefault.jpg',
                  alt: '',
                  referrerPolicy: 'no-referrer',
                }),
                h('span', { className: 'ht-dur' }, fmtDur(v.duration_s)),
              ),
              h(
                'div',
                { className: 'ht-info' },
                h('p', { className: 'ht-title' }, i + 1 + '. ' + titleOf({ v: v.vid, t: v.title }, props.lang)),
                h(
                  'div',
                  { className: 'ht-meta' },
                  v.channel ? h('span', { className: 'ht-chan' }, v.channel) : null,
                  v.views ? h('span', null, tx(lang, fmtCount(v.views, lang) + ' 次观看', fmtCount(v.views, lang) + ' views')) : null,
                ),
                v.note
                  ? h(
                      'p',
                      { style: { margin: '4px 0 0', fontSize: '12.5px', color: 'var(--dsw-alias-label-secondary)' } },
                      v.note,
                    )
                  : null,
              ),
            ),
          ),
        ),
      )
    }

    function SavedGrid(props) {
      const lang = props.lang
      if (!props.list.length) {
        return h(EmptyState, {
          title: props.emptyTitle,
          hint: props.emptyHint,
          action: lang === 'zh' ? '去首页看看' : 'Go to Home',
          onAction: () => props.onPick('home'),
        })
      }
      return h(
        'div',
        { className: 'ht-scroll' },
        h(
          'div',
          { className: 'ht-grid' },
          props.list.map((it) => h(Card, { key: it.v, item: it, lang, onOpen: props.onOpen })),
        ),
      )
    }

    /* ---------------- 电视随机播放 ----------------
       TristanTube 的电视算法：先按权重抽一个频道，再在频道里随机抽两条、
       留观看数多的那条；同一次会话里不重样。它给频道的权重来自人工分的
       S..D 档，这里换成频道内视频的平均 HN 推荐人数——同样是「频道质量」
       的代理，也保证视频多的频道不会按条数挤占小频道。 */
    const TV_TIER_WEIGHT = { S: 10, A: 6, B: 4, C: 2.5, D: 1 }

    function tvTier(avg) {
      if (avg >= 6) return 'S'
      if (avg >= 4) return 'A'
      if (avg >= 3) return 'B'
      if (avg >= 1) return 'C'
      return 'D'
    }

    /* 片库只按 items 的 identity 建一次；换台时只做加权抽样 */
    function buildTvPool(list) {
      const groups = new Map()
      for (const it of Array.isArray(list) ? list : []) {
        if (!it || !it.v) continue
        /* 没有频道名的视频各自成组，不捏成一个巨大的假频道 */
        const key = it.c || 'vid:' + it.v
        let g = groups.get(key)
        if (!g) {
          g = { weight: 0, recs: 0, count: 0, videos: [] }
          groups.set(key, g)
        }
        g.count += 1
        g.recs += Number(it.r) || 0
        g.videos.push(it)
      }
      let total = 0
      const out = []
      for (const g of groups.values()) {
        g.weight = TV_TIER_WEIGHT[tvTier(g.recs / g.count)]
        total += g.weight
        out.push(g)
      }
      return { groups: out, total }
    }

    function tvSampleOne(pool, seen, avoid) {
      if (!pool || !pool.total) return null
      for (let attempt = 0; attempt < 60; attempt += 1) {
        let roll = Math.random() * pool.total
        let group = pool.groups[pool.groups.length - 1]
        for (const g of pool.groups) {
          roll -= g.weight
          if (roll <= 0) {
            group = g
            break
          }
        }
        let best = null
        for (let k = 0; k < 2; k += 1) {
          const v = group.videos[Math.floor(Math.random() * group.videos.length)]
          if (!v || v.v === avoid || seen.has(v.v)) continue
          if (!best || (Number(v.w) || 0) > (Number(best.w) || 0)) best = v
        }
        if (best) return best
      }
      return null
    }

    /* 60 次加权抽样落空不代表片库用完，线性找一条没看过的补上；
       真的都看过了就返回 null，由调用方决定是否开新的一轮 */
    function tvPickOne(pool, seen, avoid) {
      const pick = tvSampleOne(pool, seen, avoid)
      if (pick) {
        seen.add(pick.v)
        return pick
      }
      for (const g of pool.groups) {
        for (const v of g.videos) {
          if (v.v === avoid || seen.has(v.v)) continue
          seen.add(v.v)
          return v
        }
      }
      return null
    }

    function tvFillQueue(queue, pool, seen, avoid, size = 4) {
      const out = queue.slice()
      while (out.length < size) {
        const pick = tvPickOne(pool, seen, avoid)
        if (!pick || out.some((it) => it.v === pick.v)) break
        out.push(pick)
      }
      return out
    }

    /* 电视节目信息：沉浸形态随信息层浮出，右栏紧凑形态常驻 */
    function TvInfo({ item, lang }) {
      if (!item) return null
      return h(
        'div',
        { className: 'ht-tv-info' },
        h('h1', { className: 'ht-tv-title' }, titleOf(item, lang)),
        item.c || item.y
          ? h('p', { className: 'ht-tv-who' }, [item.c, item.y ? String(item.y) : ''].filter(Boolean).join(' · '))
          : null,
        h(
          'div',
          { className: 'ht-tv-meta' },
          item.r
            ? h(
                'span',
                { key: 'r' },
                h('b', null, String(item.r)),
                tx(lang, ' 人推荐', item.r === 1 ? ' recommender' : ' recommenders'),
              )
            : null,
          item.w
            ? h(
                'span',
                { key: 'w' },
                tx(lang, fmtCount(item.w, lang) + ' 次观看', fmtCount(item.w, lang) + ' views'),
              )
            : null,
          item.d ? h('span', { key: 'd' }, fmtDur(item.d)) : null,
        ),
      )
    }

    /* 电视：主面板满铺沉浸，会话右栏用紧凑形态常驻信息；换台是加权随机抽台 */
    function TvView(props) {
      const { item, lang, onStep, onExit, onDetail, upNext = [], onPick } = props
      /* 紧凑形态由 prop 决定，不靠容器查询兜底，主面板任何宽度都不会冒出队列 */
      const compact = !!props.compact
      const vid = item ? item.v : ''
      /* 从播放器里点开的外来片：片库里没有，取不到简介与备用源 */
      const external = !!(item && item.ext)
      /* iframe 实际加载的 vid。播放器里点开的片中转页已经在放，这时不换地址，
         否则会黑一下并从头重播；换台、回溯一律跟着当前条目走 */
      const [frameVid, setFrameVid] = useState(vid)
      useEffect(() => {
        if (!vid) return
        setFrameVid((cur) => (props.keepFrame && cur ? cur : vid))
      }, [vid, props.keepFrame])
      const [origin, setOrigin] = useState(mem.mediaOrigin || null)
      /* 沉浸形态：信息收在右侧抽屉里，默认收起，鼠标移动不改变任何东西 */
      const [open, setOpen] = useState(false)
      const [detail, setDetail] = useState(null)
      const [mirror, setMirror] = useState(null)
      const frameRef = useRef(null)

      useEffect(() => {
        let alive = true
        loadMediaOrigin().then((o) => {
          if (alive) setOrigin(o || null)
        })
        return () => {
          alive = false
        }
      }, [])

      /* 简介与备用源只在抽屉打开时取，看电视本身不发请求。
         换台、换语言或换成片库外的片时先清掉上一台的，别把旧简介和旧入口留在抽屉里 */
      useEffect(() => {
        setDetail(null)
        setMirror(null)
        if (compact || !open || !vid || external) return undefined
        let alive = true
        loadDetail(vid, lang)
          .then((d) => {
            if (alive) setDetail(d)
          })
          .catch(() => {})
        getJSON('/hackertube/api/mirror?vid=' + encodeURIComponent(vid))
          .then((d) => {
            if (alive && d && d.url) setMirror(d)
          })
          .catch(() => {
            /* 没有备用源不是错误，按钮不出现即可 */
          })
        return () => {
          alive = false
        }
      }, [compact, open, vid, lang, external])

      /* 抽屉开着时 Esc 只收抽屉；捕获阶段拦下，别让 HtRoot 直接退出电视 */
      useEffect(() => {
        if (!open) return undefined
        const onKey = (e) => {
          if (e.key !== 'Escape') return
          e.stopPropagation()
          setOpen(false)
        }
        document.addEventListener('keydown', onKey, true)
        return () => document.removeEventListener('keydown', onKey, true)
      }, [open])

      /* 焦点在播放器里时按键不会冒泡到面板，中转页把方向键与 Esc 转出来，在这里消费 */
      useEffect(() => {
        const onNav = (d) => {
          if (!d) return
          if (d.key === 'Escape') {
            if (open) setOpen(false)
            else onExit()
            return
          }
          if (d.dir) onStep(d.dir > 0 ? 1 : -1)
        }
        mem.tvNavSubs.add(onNav)
        return () => {
          mem.tvNavSubs.delete(onNav)
        }
      }, [open, onStep, onExit])

      /* 左右键调进度：把秒数递给中转页里的播放器；观看页没有这层，YouTube 快捷键不受影响 */
      useEffect(() => {
        const seek = (delta) => {
          const frame = frameRef.current
          const win = frame && frame.contentWindow
          if (!win || !delta) return
          try {
            win.postMessage({ __ht: 'seek', delta }, '*')
          } catch {
            /* iframe 还在加载 */
          }
        }
        mem.tvSeekSubs.add(seek)
        return () => {
          mem.tvSeekSubs.delete(seek)
        }
      }, [])

      /* 空格暂停 / 继续：焦点在面板上时面板接，焦点落在播放器里时中转页自己处理 */
      useEffect(() => {
        const toggle = () => {
          const frame = frameRef.current
          const win = frame && frame.contentWindow
          if (!win) return
          try {
            win.postMessage({ __ht: 'toggle' }, '*')
          } catch {
            /* iframe 还在加载 */
          }
        }
        mem.tvPlaySubs.add(toggle)
        return () => {
          mem.tvPlaySubs.delete(toggle)
        }
      }, [])

      /* 一条放完自动接下一台；播放器在 iframe 里，结束状态由中转页转出来 */
      useEffect(() => {
        const onEnd = () => onStep(1)
        mem.tvEndSubs.add(onEnd)
        return () => {
          mem.tvEndSubs.delete(onEnd)
        }
      }, [onStep])

      /* 作者不允许内嵌（101/150）：把这条移出电视并换台，不在这里显示错误页 */
      const onBlockedRef = useRef(null)
      onBlockedRef.current = props.onBlocked
      useEffect(() => {
        if (!vid) return undefined
        const onErr = (id, code) => {
          if (id !== vid) return
          if (code !== 101 && code !== 150) return
          if (typeof onBlockedRef.current === 'function') onBlockedRef.current(id)
        }
        mem.tvErrorSubs.add(onErr)
        return () => {
          mem.tvErrorSubs.delete(onErr)
        }
      }, [vid])

      /* 点了播放器里的「更多视频」：中转页发现片源换了（prev 是这一台的 vid），交给面板跟着换 */
      const onAdoptRef = useRef(null)
      onAdoptRef.current = props.onAdopt
      useEffect(() => {
        if (!vid) return undefined
        const onPick = (d) => {
          if (!d || d.prev !== vid) return
          if (typeof onAdoptRef.current === 'function') onAdoptRef.current(d)
        }
        mem.tvPickSubs.add(onPick)
        return () => {
          mem.tvPickSubs.delete(onPick)
        }
      }, [vid])

      const stage = h(
        'div',
        { className: 'ht-tv-stage' },
        !item
          ? h('div', { className: 'ht-tv-wait' }, tx(lang, '电视里还没有节目', 'Nothing on TV yet'))
          : origin
            ? h('iframe', {
                key: 'tv-' + (frameVid || item.v),
                ref: frameRef,
                className: 'ht-tv-frame',
                title: titleOf(item, lang),
                src:
                  origin +
                  '/embed?vid=' +
                  encodeURIComponent(frameVid || item.v) +
                  '&lang=' +
                  (lang === 'zh' ? 'zh' : 'en') +
                  '&auto=1' +
                  (compact ? '' : '&kbd=1'),
                allow:
                  'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen',
                allowFullScreen: true,
              })
            : h('div', { className: 'ht-tv-wait' }, tx(lang, '正在准备播放器…', 'Preparing player…')),
      )

      /* 右栏窄版：ON AIR、播放器、标题、横向「接下来」、底部动作自上而下排完 */
      if (compact) {
        return h(
          'div',
          { className: 'ht-tv ht-tv-compact' },
          h(
            'div',
            { className: 'ht-tv-ctop' },
            h('span', { className: 'ht-tv-onair' }, tx(lang, 'ON AIR', 'ON AIR')),
            h('span', { className: 'ht-tv-mark' }, tx(lang, 'HackerTube TV', 'HackerTube TV')),
            h('div', { className: 'ht-tv-grow' }),
            h(
              'button',
              {
                type: 'button',
                className: 'ht-tv-exit',
                'data-tv-action': 'exit',
                'aria-label': tx(lang, '退出电视', 'Exit TV'),
                onClick: onExit,
              },
              h(
                'svg',
                { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
                h('path', {
                  d: 'M15 18l-6-6 6-6',
                  stroke: 'currentColor',
                  strokeWidth: 1.8,
                  strokeLinecap: 'round',
                  strokeLinejoin: 'round',
                }),
              ),
              h('span', { className: 'ht-tv-exit-label' }, tx(lang, '退出', 'Exit')),
            ),
          ),
          stage,
          h(TvInfo, { item, lang }),
          item && upNext.length
            ? h(
                'div',
                { className: 'ht-tv-cqueue' },
                h('p', { className: 'ht-tv-qhead' }, tx(lang, '接下来', 'Up next')),
                h(
                  'div',
                  { className: 'ht-tv-qrow' },
                  upNext.map((it) =>
                    h(
                      'button',
                      {
                        key: it.v,
                        type: 'button',
                        className: 'ht-tv-qitem',
                        'data-tvpick': it.v,
                        onClick: () => onPick && onPick(it),
                      },
                      h('span', { className: 'ht-tv-qthumb' }, it.th ? h('img', { src: it.th, alt: '' }) : null),
                      h('span', { className: 'ht-tv-qtitle' }, titleOf(it, lang)),
                      it.c ? h('span', { className: 'ht-tv-qchan' }, it.c) : null,
                    ),
                  ),
                ),
              )
            : null,
          h(
            'div',
            { className: 'ht-tv-foot' },
            h(
              'button',
              { type: 'button', className: 'ht-tv-act', 'data-tv-action': 'next', onClick: () => onStep(1) },
              tx(lang, '换台', 'Next channel'),
            ),
            external
              ? null
              : h(
                  'button',
                  { type: 'button', className: 'ht-tv-act', 'data-tv-action': 'detail', onClick: onDetail },
                  tx(lang, '看详情', 'Details'),
                ),
          ),
        )
      }

      /* 抽屉里的简介：有缓存译文就用译文，否则原文；绝不在这里触发机翻 */
      const tr = lang === 'zh' && detail && detail.i18n ? detail.i18n : {}
      const summaryText = tr.summary || (detail && detail.summary) || tr.why_hn || (detail && detail.why_hn) || ''

      return h(
        'div',
        { className: 'ht-tv' },
        stage,
        item
          ? h('div', {
              className: 'ht-tvd-scrim' + (open ? ' on' : ''),
              onClick: () => setOpen(false),
            })
          : null,
        item
          ? h(
              'aside',
              {
                className: 'ht-tvd' + (open ? ' open' : ''),
                role: 'dialog',
                'aria-label': tx(lang, '节目信息', 'Programme info'),
                'aria-hidden': open ? undefined : 'true',
              },
              h(
                'div',
                { className: 'ht-tvd-head' },
                h('h2', { className: 'ht-tvd-title' }, titleOf(item, lang)),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'ht-tvd-x',
                    'aria-label': tx(lang, '收起', 'Collapse'),
                    onClick: () => setOpen(false),
                  },
                  h(
                    'svg',
                    { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
                    h('path', {
                      d: 'M6 6l12 12M18 6L6 18',
                      stroke: 'currentColor',
                      strokeWidth: 1.9,
                      strokeLinecap: 'round',
                    }),
                  ),
                ),
              ),
              item.c || item.y
                ? h(
                    'p',
                    { className: 'ht-tvd-who' },
                    [item.c, item.y ? String(item.y) : ''].filter(Boolean).join(' · '),
                  )
                : null,
              h(
                'div',
                { className: 'ht-tv-meta' },
                item.r
                  ? h(
                      'span',
                      { key: 'r' },
                      h('b', null, String(item.r)),
                      tx(lang, ' 人推荐', item.r === 1 ? ' recommender' : ' recommenders'),
                    )
                  : null,
                item.w
                  ? h(
                      'span',
                      { key: 'w' },
                      tx(lang, fmtCount(item.w, lang) + ' 次观看', fmtCount(item.w, lang) + ' views'),
                    )
                  : null,
                item.d ? h('span', { key: 'd' }, fmtDur(item.d)) : null,
              ),
              summaryText
                ? h('p', { className: 'ht-tvd-desc' }, summaryText)
                : h(
                    'p',
                    { className: 'ht-tvd-note' },
                    external
                      ? tx(
                          lang,
                          '这支视频是从播放器里点开的，不在片库里，只有标题和频道。',
                          'Opened from the player, so only its title and channel are known.',
                        )
                      : detail
                        ? tx(lang, '这个视频没有简介。', 'No description for this video.')
                        : tx(lang, '正在读取简介…', 'Loading description…'),
                  ),
              h(
                'div',
                { className: 'ht-tvd-acts' },
                /* 播放器自身的站外跳转在电视里被遮住了，站外入口只留抽屉里这两个 */
                h(
                  'a',
                  {
                    className: 'ht-tvd-link',
                    href: 'https://www.youtube.com/watch?v=' + item.v,
                    target: '_blank',
                    rel: 'noreferrer noopener',
                  },
                  h(
                    'svg',
                    { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
                    h('rect', { x: 2.5, y: 5, width: 19, height: 14, rx: 4, stroke: 'currentColor', strokeWidth: 1.7 }),
                    h('path', { d: 'M10.4 9.1l5 2.9-5 2.9z', fill: 'currentColor' }),
                  ),
                  tx(lang, '在 YouTube 观看', 'Watch on YouTube'),
                ),
                mirror && mirror.url
                  ? h(
                      'a',
                      {
                        className: 'ht-tvd-link',
                        href: mirror.url,
                        target: '_blank',
                        rel: 'noreferrer noopener',
                        title:
                          (mirror.up || '') +
                          (mirror.play ? ' · ' + fmtCount(mirror.play, lang) + tx(lang, ' 次播放', ' views') : ''),
                      },
                      h(
                        'svg',
                        { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
                        h('rect', { x: 3, y: 7.5, width: 18, height: 12.5, rx: 3, stroke: 'currentColor', strokeWidth: 1.7 }),
                        h('path', {
                          d: 'M8.5 3.5L12 7l3.5-3.5',
                          stroke: 'currentColor',
                          strokeWidth: 1.7,
                          strokeLinecap: 'round',
                          strokeLinejoin: 'round',
                        }),
                      ),
                      tx(lang, '在 B 站观看', 'Watch on Bilibili'),
                    )
                  : null,
                external
                  ? null
                  : h(
                      'button',
                      { type: 'button', className: 'ht-tvd-link', onClick: onDetail },
                      h(
                        'svg',
                        { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
                        h('rect', {
                          x: 4,
                          y: 3,
                          width: 16,
                          height: 18,
                          rx: 2.5,
                          stroke: 'currentColor',
                          strokeWidth: 1.7,
                        }),
                        h('path', {
                          d: 'M8 8h8M8 12h8M8 16h5',
                          stroke: 'currentColor',
                          strokeWidth: 1.7,
                          strokeLinecap: 'round',
                        }),
                      ),
                      tx(lang, '看详情', 'Details'),
                    ),
              ),
              h(
                'div',
                { className: 'ht-tv-foot ht-tvd-foot' },
                h(
                  'button',
                  { type: 'button', className: 'ht-tv-act', 'data-tv-action': 'next', onClick: () => onStep(1) },
                  tx(lang, '换台', 'Next channel'),
                ),
                h(
                  'button',
                  { type: 'button', className: 'ht-tv-act', 'data-tv-action': 'exit', onClick: onExit },
                  tx(lang, '退出', 'Exit'),
                ),
              ),
              h(
                'p',
                { className: 'ht-tvd-keys' },
                h('kbd', null, '↑'),
                ' ',
                h('kbd', null, '↓'),
                ' ',
                tx(lang, '换台 · ', 'channels · '),
                h('kbd', null, '←'),
                ' ',
                h('kbd', null, '→'),
                ' ',
                tx(lang, '调进度 · ', 'seek · '),
                h('kbd', null, tx(lang, '空格', 'Space')),
                ' ',
                tx(lang, '暂停 / 继续 · ', 'play / pause · '),
                h('kbd', null, 'Esc'),
                ' ',
                tx(lang, '退出', 'exit'),
              ),
            )
          : null,
        item
          ? h(
              'button',
              {
                type: 'button',
                className: 'ht-tvd-handle',
                'data-tv-drawer': '1',
                'aria-label': tx(lang, '节目信息', 'Programme info'),
                'aria-expanded': open ? 'true' : 'false',
                onClick: () => setOpen((v) => !v),
              },
              h(
                'svg',
                { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
                h('path', {
                  d: 'M15 18l-6-6 6-6',
                  stroke: 'currentColor',
                  strokeWidth: 1.8,
                  strokeLinecap: 'round',
                  strokeLinejoin: 'round',
                }),
              ),
            )
          : null,
      )
    }

    function HtRoot(props) {
      /* 右栏模式：不读写页面 hash，观看状态只留在栏内，避免影响主会话地址 */
      const embedded = !!(props && props.embedded)
      const [items, setItems] = useState(mem.list || [])
      const [tax, setTax] = useState(mem.tax || null)
      const [phase, setPhase] = useState(mem.list ? 'ready' : 'loading')
      const [loadStage, setLoadStage] = useState(
        mem.status || { stage: mem.list ? 'ready' : 'idle', stale: false, revalidating: false, enriched: 0, total: 0 },
      )
      const [err, setErr] = useState('')
      const [q, setQ] = useState('')
      const [area, setArea] = useState('')
      /* 筛选与排序都作为参数交给 Host 检索，客户端不再自己匹配或排序 */
      const [year, setYear] = useState('')
      const [type, setType] = useState('')
      const [level, setLevel] = useState('')
      const [sort, setSort] = useState('')
      const [searchState, setSearchState] = useState({ key: '', items: [], total: 0, loading: false, error: '' })
      const [limit, setLimit] = useState(GRID_STEP)
      const [watching, setWatching] = useState(null)
      const [lang, setLang] = useState(() => {
        const next = mem.lang || initialLang()
        mem.lang = next
        return next
      })
      const [view, setView] = useState('home')
      const { saved, toggle, markSeen, blockEmbed } = useSaved()
      /* 电视播放历史留在 HtRoot：退出再进来还是这一台 */
      const tvSeenRef = useRef(new Set())
      const tvRef = useRef({ hist: [], pos: -1, queue: [] })
      const [tvState, setTvState] = useState(tvRef.current)
      /* 整份片库按频道分组一次，之后每次换台只做加权抽样。
         作者不允许内嵌的视频（prefs.blocked）不进电视频道池 */
      const blockedSet = useMemo(() => new Set(saved.blocked), [saved.blocked])
      const tvPool = useMemo(
        () => buildTvPool(items.filter((it) => !blockedSet.has(it.v))),
        [items, blockedSet],
      )
      /* 播放器里点开的外来片按 vid 回查片库条目，查到就沿用原条目 */
      const tvByVid = useMemo(() => {
        const map = new Map()
        for (const it of items) map.set(it.v, it)
        return map
      }, [items])
      const commitTv = (next, keep) => {
        /* keep 只由「播放器里点开」用：中转页已经在放那支片，电视的 iframe 不换地址，
           否则会黑一下并从头重播。其余换台路径一律清空，回到跟着 vid 走 */
        const value = { ...next, keep: keep && next.pos >= 0 && next.hist[next.pos] && next.hist[next.pos].v === keep ? keep : '' }
        tvRef.current = value
        setTvState(value)
      }
      const tvReturnRef = useRef('home')
      const [playlists, setPlaylists] = useState(null)
      const [plDetail, setPlDetail] = useState(null)
      const [plSlug, setPlSlug] = useState(null)
      const [helpOpen, setHelpOpen] = useState(false)
      const [rec, setRec] = useState(null)
      /* 每次「换一批」换一个 seed，Host 按它重新抽前排 */
      const [recSeed, setRecSeed] = useState(() => Math.floor(Math.random() * 1e9) + 1)
      /* 计数没有读者：它一变就重渲染，让后到的中文标题显示出来 */
      const [, bumpTitles] = useState(0)

      /* 中文标题只用于显示；搜索已经在 Host 侧索引里读同一份译文表 */
      const ensureTitles = () => {
        void loadTitles().then((t) => {
          if (Object.keys(t).length) bumpTitles((v) => v + 1)
        })
      }
      useEffect(() => {
        ensureTitles()
      }, [])

      /* 首页推荐画像：把当前 likes / seen / dismissed 带给 Host，马上按最新状态算。
         保存 prefs 有 400ms 防抖，如果等 POST 落盘再取会拿到上一版画像。 */
      const recKey = saved.likes.join(',') + '|' + saved.seen.join(',') + '|' + saved.dismissed.join(',')
      useEffect(() => {
        if (phase !== 'ready' || !items.length) return undefined
        let alive = true
        const params = new URLSearchParams()
        params.set('likes', saved.likes.slice(-80).join(','))
        params.set('seen', saved.seen.slice(-200).join(','))
        params.set('dismissed', saved.dismissed.slice(-200).join(','))
        params.set('limit', '10')
        params.set('seed', String(recSeed))
        getJSON('/hackertube/api/recommend?' + params.toString())
          .then((data) => {
            if (alive && data && Array.isArray(data.items)) setRec(data)
          })
          .catch(() => {})
        return () => {
          alive = false
        }
      }, [phase, recKey, recSeed])

      /* 宿主端保存过语言偏好就跟随；本机有明确选择或用户刚手动切换时不被覆盖 */
      const hostPrefRef = useRef(false)
      useEffect(() => {
        let alive = true
        /* localStorage 写不进去的宿主（dsh-app://）才需要宿主兜底 */
        if (readStoredLang()) return undefined
        getJSON('/hackertube/api/prefs')
          .then((d) => {
            if (!alive || !d || langTouchedRef.current) return
            const saved = d.lang === 'zh' || d.lang === 'en' ? d.lang : null
            if (!saved) return
            hostPrefRef.current = true
            if (saved === mem.lang) return
            mem.lang = saved
            setLang(saved)
          })
          .catch(() => {})
        return () => {
          alive = false
        }
      }, [])

      /* 宿主语言可能晚于模块挂载才写进 <html lang>；没有显式偏好时跟随宿主 */
      useEffect(() => {
        if (typeof document === 'undefined') return undefined
        const el = document.documentElement
        if (!el) return undefined
        const follow = () => {
          if (hostPrefRef.current || langTouchedRef.current || readStoredLang()) return
          const host = el.lang ? normalizeLang(el.lang) : ''
          if (!host || host === mem.lang) return
          mem.lang = host
          setLang(host)
        }
        follow()
        if (typeof MutationObserver === 'undefined') return undefined
        const mo = new MutationObserver(follow)
        mo.observe(el, { attributes: true, attributeFilter: ['lang'] })
        return () => mo.disconnect()
      }, [])

      const [reloadKey, setReloadKey] = useState(0)
      const [authUrl, setAuthUrl] = useState(null)
      const sentinelRef = useRef(null)
      const rootRef = useRef(null)
      /* 列表滚动位置保存在 HtRoot：进观看页时列表卸载，回来时要原位恢复 */
      const listScrollRef = useRef(null)
      const listScrollTop = useRef(0)
      const watchPushedRef = useRef(false)
      const langTouchedRef = useRef(false)

      /* 桌面端拿一个带 launch token 的 HTTP 地址，用于在新窗口获得安全上下文 */
      useEffect(() => {
        if (typeof location !== 'undefined' && /^https?:$/.test(location.protocol)) return
        getJSON('/hackertube/api/config')
          .then((d) => {
            if (d && d.authUrl) setAuthUrl(String(d.authUrl))
          })
          .catch(() => {})
      }, [])

      /* 列表与分类拆开：列表一到就渲染卡片，分类稍后补筛选条，互不阻塞首屏 */
      useEffect(() => {
        let alive = true
        if (!mem.list) setPhase('loading')
        loadList()
          .then(async (list) => {
            if (!alive) return
            setItems(list)
            setPhase('ready')
            /* 列表回来时同步问一次阶段，后台还在补元信息就继续展示进度 */
            const prev = mem.status && mem.status.stage
            const status = await loadListStatus()
            if (!alive || !status) return
            mem.status = status
            setLoadStage(status)
            if (status.stage === 'ready' && prev !== 'ready' && status.enriched > 0) {
              const fresh = await refreshList()
              if (alive && fresh) setItems(fresh)
            }
          })
          .catch((e) => {
            if (!alive) return
            setErr(String((e && e.message) || e))
            setPhase('error')
          })
        return () => {
          alive = false
        }
      }, [reloadKey])

      useEffect(() => {
        let alive = true
        loadTaxonomy(lang)
          .then((taxonomy) => {
            if (alive) setTax(taxonomy)
          })
          .catch(() => {})
        return () => {
          alive = false
        }
      }, [reloadKey, lang])

      /* 首屏阶段轮询：export → metadata → comments → ready；完成时把补齐后的列表换进来 */
      useEffect(() => {
        let alive = true
        let timer = null
        const tick = async () => {
          const status = await loadListStatus()
          if (!alive) return
          if (!status) {
            timer = setTimeout(tick, 2000)
            return
          }
          const prev = mem.status && mem.status.stage
          mem.status = status
          setLoadStage(status)
          if (status.stage === 'ready' && prev !== 'ready' && status.enriched > 0) {
            const fresh = await refreshList()
            if (alive && fresh) {
              setItems(fresh)
              setPhase('ready')
            }
          }
          if ((status.stage !== 'ready' && status.stage !== 'error') || status.revalidating) {
            timer = setTimeout(tick, 1000)
          }
        }
        tick()
        return () => {
          alive = false
          if (timer) clearTimeout(timer)
        }
      }, [reloadKey])

      /* 深链恢复：地址里带 ht-watch 的视频在列表就绪后直接打开 */
      useEffect(() => {
        if (embedded) return undefined
        if (phase !== 'ready' || watching) return
        const vid = readWatchVid()
        if (!vid) return
        const hit = items.find((it) => it.v === vid)
        if (hit) setWatching(hit)
      }, [items, phase, watching])

      /* 浏览器前进/后退与 hash 变化保持同一份观看状态 */
      useEffect(() => {
        if (embedded) return undefined
        const w = typeof window !== 'undefined' ? window : null
        if (!w || typeof w.addEventListener !== 'function') return undefined
        const sync = () => {
          const vid = readWatchVid()
          if (!vid) {
            watchPushedRef.current = false
            setWatching(null)
            return
          }
          const hit = (mem.list || items || []).find((it) => it.v === vid)
          if (hit) setWatching(hit)
        }
        w.addEventListener('popstate', sync)
        w.addEventListener('hashchange', sync)
        return () => {
          w.removeEventListener('popstate', sync)
          w.removeEventListener('hashchange', sync)
        }
      }, [items])

      const retry = () => {
        setErr('')
        setPhase('loading')
        setReloadKey((k) => k + 1)
      }

      /* 从观看页回来：列表重新挂载后把滚动位置放回原处 */
      useEffect(() => {
        if (watching || view !== 'home') return
        const el = listScrollRef.current
        if (el && listScrollTop.current) el.scrollTop = listScrollTop.current
      }, [watching, view])

      const areas = useMemo(() => {
        const list = tax && Array.isArray(tax.areas) ? tax.areas : []
        return list.map((a) => ({
          id: a.id,
          name: a.name,
          nameZh: a.nameZh,
          count: a.count,
          categories: (a.categories || []).map((c) => ({
            id: c.id,
            name: c.name,
            nameZh: c.nameZh,
          })),
        }))
      }, [tax])

      const years = useMemo(() => {
        const set = new Set()
        for (const it of items) if (Number(it.y)) set.add(Number(it.y))
        return [...set].sort((a, b) => b - a)
      }, [items])
      const types = useMemo(() => {
        const set = new Set()
        for (const it of items) if (it.ct) set.add(String(it.ct))
        return [...set].sort()
      }, [items])
      const levels = useMemo(() => {
        const order = ['intro', 'intermediate', 'advanced', 'general']
        const set = new Set()
        for (const it of items) if (it.lv) set.add(String(it.lv))
        return order.filter((x) => set.has(x))
      }, [items])

      /* 任何查询/筛选都走同一个 Host 检索操作；客户端只负责显示返回顺序 */
      const searchActive = !!(q.trim() || area || year || type || level || sort)
      const searchKey = [q.trim(), area, year, type, level, sort].join('\u0000')

      useEffect(() => {
        if (!searchActive) {
          setSearchState({ key: '', items: [], total: 0, loading: false, error: '' })
          setLimit(GRID_STEP)
          return undefined
        }
        let alive = true
        setSearchState((prev) => Object.assign({}, prev, { key: searchKey, loading: true, error: '' }))
        const timer = setTimeout(() => {
          const params = new URLSearchParams()
          const raw = q.trim()
          if (raw) params.set('q', raw)
          if (area) params.set('area', area)
          if (year) params.set('year', year)
          if (type) params.set('type', type)
          if (level) params.set('level', level)
          if (sort) params.set('sort', sort)
          params.set('limit', String(GRID_CAP))
          fetch('/hackertube/api/search?' + params.toString())
            .then((r) => {
              if (!r.ok) throw new Error('HTTP ' + r.status)
              return r.json()
            })
            .then((d) => {
              if (!alive) return
              const list = d && Array.isArray(d.items) ? d.items : []
              setSearchState({
                key: searchKey,
                items: list,
                total: d && typeof d.total === 'number' ? d.total : list.length,
                loading: false,
                error: '',
                areaFiltered: d ? d.areaFiltered !== false : true,
              })
              setLimit(GRID_STEP)
            })
            .catch((e) => {
              if (!alive) return
              setSearchState({ key: searchKey, items: [], total: 0, loading: false, error: String((e && e.message) || e) })
            })
        }, 120)
        return () => {
          alive = false
          clearTimeout(timer)
        }
      }, [searchKey])

      /* 推荐只决定先后，不新增一栏：把推荐到的视频提到列表最前，其余保持原顺序 */
      const orderedItems = useMemo(() => {
        const list = rec && Array.isArray(rec.items) ? rec.items : []
        if (!list.length || !items.length) return items
        const byId = new Map(items.map((it) => [it.v, it]))
        const front = []
        const moved = new Set()
        for (const r of list) {
          const hit = r && byId.get(r.v)
          if (!hit || moved.has(hit.v)) continue
          front.push(hit)
          moved.add(hit.v)
        }
        if (!front.length) return items
        return front.concat(items.filter((it) => !moved.has(it.v)))
      }, [items, rec])

      const filtered = searchActive ? searchState.items : orderedItems
      const resultTotal = searchActive ? searchState.total : items.length
      /* 输入变化到请求返回之间也算加载中：不然会先闪一下「没有匹配的视频」 */
      const searchLoading = searchActive && (searchState.loading || searchState.key !== searchKey)
      const searchError = searchActive ? searchState.error : ''

      /* 上报一次实测渲染结果：布局尺寸与关键计算样式，这是唯一能客观验证视觉的途径 */
      useEffect(() => {
        if (phase !== 'ready') return
        const el = rootRef.current
        if (!el || typeof el.getBoundingClientRect !== 'function') return
        const rect = el.getBoundingClientRect()
        const q = (sel) => (typeof el.querySelector === 'function' ? el.querySelector(sel) : null)
        const cs = (node) =>
          node && typeof window !== 'undefined' && window.getComputedStyle
            ? window.getComputedStyle(node)
            : null
        const rootCs = cs(el)
        const thumbCs = cs(q('.ht-thumb'))
        const titleCs = cs(q('.ht-title'))
        const gridCs = cs(q('.ht-grid'))
        const chipCs = cs(q('.ht-chip'))
        const scroller = q('.ht-scroll')
        beacon('panel-measured', {
          w: Math.round(rect.width),
          h: Math.round(rect.height),
          scrollH: scroller ? Math.round(scroller.getBoundingClientRect().height) : null,
          cards: typeof el.querySelectorAll === 'function' ? el.querySelectorAll('.ht-card').length : -1,
          items: items.length,
          shown: Math.min(limit, filtered.length),
          bg: rootCs ? rootCs.backgroundColor : null,
          fg: rootCs ? rootCs.color : null,
          thumbRadius: thumbCs ? thumbCs.borderRadius : null,
          titleSize: titleCs ? titleCs.fontSize : null,
          titleWeight: titleCs ? titleCs.fontWeight : null,
          titleLH: titleCs ? titleCs.lineHeight : null,
          gridGap: gridCs ? gridCs.gap : null,
          gridCols: gridCs ? gridCs.gridTemplateColumns.split(' ').length : null,
          chipH: chipCs ? chipCs.height : null,
        })
      }, [phase])

      useEffect(() => {
        const el = sentinelRef.current
        if (!el) return
        const io = new IntersectionObserver(
          (entries) => {
            if (entries.some((e) => e.isIntersecting)) {
              setLimit((n) => Math.min(n + GRID_STEP, GRID_CAP))
            }
          },
          { rootMargin: '500px' },
        )
        io.observe(el)
        return () => io.disconnect()
      }, [filtered.length, watching])

      /* 播放列表按需拉取：进过分类/列表页才会请求 */
      useEffect(() => {
        if (view !== 'pl' || playlists) return
        let alive = true
        getJSON('/hackertube/api/playlists')
          .then((d) => {
            if (alive) setPlaylists(Array.isArray(d) ? d : [])
          })
          .catch(() => {
            if (alive) setPlaylists([])
          })
        return () => {
          alive = false
        }
      }, [view, playlists])

      const openPlaylist = (slug) => {
        setPlSlug(slug)
        setPlDetail(null)
        setView('playlist')
        getJSON('/hackertube/api/playlist?slug=' + encodeURIComponent(slug))
          .then((d) => setPlDetail(d && d.videos ? d : { videos: [], title: slug }))
          .catch(() => setPlDetail({ videos: [], title: slug }))
      }

      const openItem = (it) => {
        if (!it) return
        markSeen(it.v)
        if (!embedded) {
          if (!watching) {
            const el = listScrollRef.current
            if (el) listScrollTop.current = el.scrollTop || 0
            watchPushedRef.current = setWatchHash(it.v, 'push')
          } else if (watching.v !== it.v) {
            /* 相关视频是在同一次观看里换片：替换当前历史条目，Esc 一次仍回列表 */
            setWatchHash(it.v, 'replace')
          }
        }
        setWatching(it)
      }

      const closeWatch = () => {
        if (!embedded) {
          if (watchPushedRef.current) {
            watchPushedRef.current = false
            try {
              const w = typeof window !== 'undefined' ? window : null
              if (w && w.history && typeof w.history.back === 'function') {
                w.history.back()
                setWatching(null)
                return
              }
            } catch {
              /* history 不可用时退回替换地址 */
            }
          }
          setWatchHash(null, 'replace')
        }
        setWatching(null)
      }

      /* 进电视：正在看的这条就是第一台；否则按 TristanTube 的规则抽一台 */
      const tvStart = (seed) => {
        const seen = tvSeenRef.current
        const cur = tvRef.current
        let hist = cur.hist
        let pos = cur.pos
        if (seed && seed.v && !mem.tvBlocked.has(seed.v) && (!hist[pos] || hist[pos].v !== seed.v)) {
          seen.add(seed.v)
          hist = hist.slice(0, pos + 1).concat([seed])
          pos = hist.length - 1
        }
        if (pos < 0) {
          let first = tvPickOne(tvPool, seen)
          if (!first) {
            /* 整份片库都看过了：开新的一轮 */
            seen.clear()
            first = tvPickOne(tvPool, seen)
          }
          if (first) {
            hist = [first]
            pos = 0
          }
        }
        const playing = pos >= 0 ? hist[pos].v : ''
        commitTv({
          hist,
          pos,
          queue: tvFillQueue(
            cur.queue.filter((it) => it.v !== playing),
            tvPool,
            seen,
            playing,
          ),
        })
      }

      /* ↓ / N：有前路就顺着历史走，没有就从「接下来」取一台，再不行才现抽 */
      const tvNext = () => {
        const cur = tvRef.current
        if (!tvPool.total) return
        /* 历史里可能有刚被发现不能内嵌的台，往前找下一台可用的 */
        let forward = cur.pos + 1
        while (forward < cur.hist.length && mem.tvBlocked.has(cur.hist[forward].v)) forward += 1
        if (cur.pos >= 0 && forward < cur.hist.length) {
          commitTv({ ...cur, pos: forward })
          return
        }
        const seen = tvSeenRef.current
        const playing = cur.pos >= 0 ? cur.hist[cur.pos].v : ''
        const queue = cur.queue.filter((it) => !mem.tvBlocked.has(it.v))
        let pick = queue[0]
        if (!pick) {
          pick = tvPickOne(tvPool, seen, playing)
          if (!pick) {
            /* 整份片库都看过了：开新的一轮，当前这条仍然跳过 */
            seen.clear()
            pick = tvPickOne(tvPool, seen, playing)
          }
        }
        if (!pick) return
        seen.add(pick.v)
        const hist = cur.hist.slice(0, cur.pos + 1).concat([pick])
        const rest = queue[0] === pick ? queue.slice(1) : queue
        commitTv({ hist, pos: hist.length - 1, queue: tvFillQueue(rest, tvPool, seen, pick.v) })
      }

      /* ↑ / P：回到上一台，和遥控器一样不绕回最后；跳过不能内嵌的台 */
      const tvPrev = () => {
        const cur = tvRef.current
        let back = cur.pos - 1
        while (back >= 0 && mem.tvBlocked.has(cur.hist[back].v)) back -= 1
        if (back >= 0) commitTv({ ...cur, pos: back })
      }

      /* 右栏「接下来」点哪台放哪台：往前翻历史就跳过去，抽好的下一台就从队列里取 */
      const tvPlay = (it) => {
        if (!it || !it.v || mem.tvBlocked.has(it.v)) return
        const cur = tvRef.current
        const forward = cur.hist.findIndex((h, i) => i > cur.pos && h.v === it.v && !mem.tvBlocked.has(h.v))
        if (forward > cur.pos) {
          commitTv({ ...cur, pos: forward })
          return
        }
        const at = cur.queue.findIndex((q) => q.v === it.v)
        const pick = at >= 0 ? cur.queue[at] : it
        const rest = at >= 0 ? cur.queue.slice(at + 1) : cur.queue
        tvSeenRef.current.add(pick.v)
        const hist = cur.hist.slice(0, cur.pos + 1).concat([pick])
        commitTv({ hist, pos: hist.length - 1, queue: tvFillQueue(rest, tvPool, tvSeenRef.current, pick.v) })
      }

      /* 播放器报 101/150（作者不允许内嵌）：永久移出电视，并从当前台往后换 */
      const tvDropBlocked = (vid) => {
        if (!vid || mem.tvBlocked.has(vid)) return
        mem.tvBlocked.add(vid)
        blockEmbed(vid)
        const cur = tvRef.current
        const curVid = cur.pos >= 0 ? cur.hist[cur.pos].v : ''
        const queue = cur.queue.filter((it) => it.v !== vid)
        if (curVid === vid) {
          commitTv({ ...cur, queue })
          tvNext()
        } else if (queue.length !== cur.queue.length) {
          commitTv({ ...cur, queue })
        }
      }

      /* 播放器里点了「更多视频」：面板跟着换到那支片，否则抽屉标题、字幕上下文和进度
         都停在上一台。片库里有这条就沿用原条目；没有就按 YouTube 给的标题与频道临时
         入档（ext），不进频道池，抽屉里也不去取简介与备用源 */
      const tvAdopt = (d) => {
        const vid = d && d.vid ? String(d.vid) : ''
        if (!vid) return
        if (mem.tvBlocked.has(vid)) {
          tvDropBlocked(vid)
          return
        }
        const cur = tvRef.current
        if (cur.pos >= 0 && cur.hist[cur.pos].v === vid) return
        const entry = tvByVid.get(vid) || {
          v: vid,
          t: String(d.title || ''),
          c: String(d.author || ''),
          th: 'https://i.ytimg.com/vi/' + vid + '/hq2.jpg',
          ext: true,
        }
        tvSeenRef.current.add(vid)
        const hist = cur.hist.slice(0, cur.pos + 1).concat([entry])
        commitTv(
          {
            hist,
            pos: hist.length - 1,
            queue: tvFillQueue(
              cur.queue.filter((it) => it.v !== vid),
              tvPool,
              tvSeenRef.current,
              vid,
            ),
          },
          vid,
        )
      }

      const enterTv = () => {
        if (view !== 'tv') tvReturnRef.current = view
        const seed = watching || null
        if (watching) closeWatch()
        tvStart(seed)
        setView('tv')
      }

      const exitTv = () => {
        const back = tvReturnRef.current
        setView(back && back !== 'tv' ? back : 'home')
      }

      const stepChannel = (delta) => {
        if (delta > 0) tvNext()
        else tvPrev()
      }

      /* 冷启动时电视可能比列表先打开；片库一到位就抽第一台，不用等用户按键 */
      useEffect(() => {
        if (view !== 'tv' || !tvPool.total || tvRef.current.pos >= 0) return
        tvStart(null)
      }, [view, tvPool])

      /* 键盘快捷键：与站点一致的那一套 */
      useEffect(() => {
        if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return
        const onKey = (e) => {
          if (e.metaKey || e.ctrlKey || e.altKey) return
          const el = document.activeElement
          const typing = el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)
          if (e.key === 'Escape') {
            if (typing) {
              el.blur()
              return
            }
            if (helpOpen) {
              setHelpOpen(false)
              return
            }
            if (watching) {
              closeWatch()
              return
            }
            if (view === 'tv') {
              exitTv()
              return
            }
            return
          }
          if (typing) return
          if (e.key === 't' || e.key === 'T') {
            if (view === 'tv') {
              if (watching) closeWatch()
              exitTv()
            } else {
              enterTv()
            }
            return
          }
          if (view === 'tv') {
            /* 上下换台、左右调进度：与遥控器的直觉一致，也和 YouTube 的左右快进对齐 */
            if (e.key === 'ArrowDown' || e.key === 'n' || e.key === 'N') {
              e.preventDefault()
              stepChannel(1)
              return
            }
            if (e.key === 'ArrowUp' || e.key === 'p' || e.key === 'P') {
              e.preventDefault()
              stepChannel(-1)
              return
            }
            if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
              e.preventDefault()
              const delta = e.key === 'ArrowRight' ? TV_SEEK_STEP : -TV_SEEK_STEP
              for (const fn of mem.tvSeekSubs) {
                try {
                  fn(delta)
                } catch {
                  /* 视图卸载中 */
                }
              }
              return
            }
            /* 空格暂停 / 继续：遥控器最顺手的那个键；阻止默认滚动 */
            if (e.key === ' ' || e.key === 'Spacebar') {
              e.preventDefault()
              for (const fn of mem.tvPlaySubs) {
                try {
                  fn()
                } catch {
                  /* 视图卸载中 */
                }
              }
              return
            }
            return
          }
          if (e.key === '/') {
            e.preventDefault()
            const input = rootRef.current && rootRef.current.querySelector('.ht-search input')
            if (input) input.focus()
            return
          }
          if (e.key === '?') {
            e.preventDefault()
            setHelpOpen((v) => !v)
            return
          }
          if (e.key === 'h' || e.key === 'H') {
            setView('home')
            if (watching) closeWatch()
            else setWatching(null)
            return
          }
          if (e.key === 'j' || e.key === 'k' || e.key === 'Enter') {
            const root = rootRef.current
            const cards = root ? Array.prototype.slice.call(root.querySelectorAll('.ht-card')) : []
            if (!cards.length) return
            if (e.key === 'Enter') {
              const cur = cards.findIndex((c) => c.classList.contains('kbd'))
              if (cur >= 0) {
                e.preventDefault()
                const vid = cards[cur].getAttribute('data-vid')
                const hit = items.find((it) => it.v === vid)
                if (hit) openItem(hit)
              }
              return
            }
            e.preventDefault()
            const cur = cards.findIndex((c) => c.classList.contains('kbd'))
            const next = e.key === 'j' ? Math.min(cards.length - 1, cur + 1) : Math.max(0, cur - 1)
            cards.forEach((c, i) => c.classList.toggle('kbd', i === next))
            cards[next].scrollIntoView({ block: 'nearest' })
            return
          }
          if (watching && (e.key === 'l' || e.key === 'w')) {
            e.preventDefault()
            toggle(e.key === 'l' ? 'likes' : 'later', watching.v)
          }
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [watching, toggle, helpOpen, view, items, tvPool])

      if (watching) {
        return h(WatchView, {
          item: watching,
          lang,
          onBack: closeWatch,
          liked: saved.likes.indexOf(watching.v) >= 0,
          savedLater: saved.later.indexOf(watching.v) >= 0,
          onToggle: toggle,
          onOpenItem: openItem,
        })
      }

      /* 沉浸形态只属于主面板；会话右栏保留头部与导航，电视只占剩余高度 */
      const tvItem = tvState.pos >= 0 ? tvState.hist[tvState.pos] : null
      /* 「接下来」先列已经翻过的前路，再列随机抽好的队列，和 ↓ 的实际走向一致 */
      const tvUpNext = []
      for (let k = tvState.pos + 1; k >= 0 && k < tvState.hist.length && tvUpNext.length < 4; k += 1) {
        if (mem.tvBlocked.has(tvState.hist[k].v)) continue
        tvUpNext.push(tvState.hist[k])
      }
      for (const it of tvState.queue) {
        if (tvUpNext.length >= 4) break
        if (mem.tvBlocked.has(it.v)) continue
        if (!tvUpNext.some((x) => x.v === it.v)) tvUpNext.push(it)
      }

      if (view === 'tv' && !embedded) {
        return h(TvView, {
          item: tvItem,
          keepFrame: !!(tvState.keep && tvItem && tvState.keep === tvItem.v),
          channel: tvItem ? tvItem.v : '',
          lang,
          onStep: stepChannel,
          onExit: exitTv,
          onDetail: () => {
            if (tvItem) openItem(tvItem)
          },
          onBlocked: tvDropBlocked,
          onAdopt: tvAdopt,
        })
      }

      const pickView = (next) => {
        if (next === 'tv') {
          enterTv()
          return
        }
        setView(next)
        if (next !== 'playlist') setPlDetail(null)
      }

      const savedList = (bucket) =>
        saved[bucket]
          .map((id) => items.find((it) => it.v === id))
          .filter(Boolean)
          .slice()
          .reverse()

      const body = (() => {
        /* 只有会话右栏会走到这里：主面板的电视在上面的早退里 */
        if (view === 'tv') {
          return h(TvView, {
            compact: true,
            item: tvItem,
            keepFrame: !!(tvState.keep && tvItem && tvState.keep === tvItem.v),
            channel: tvItem ? tvItem.v : '',
            lang,
            onStep: stepChannel,
            onExit: exitTv,
            onDetail: () => {
              if (tvItem) openItem(tvItem)
            },
            onBlocked: tvDropBlocked,
            onAdopt: tvAdopt,
            upNext: tvUpNext,
            onPick: tvPlay,
          })
        }
        if (view === 'cats') {
          return h(AreaList, {
            areas,
            lang,
            onPick: (id) => {
              setArea(id)
              setView('home')
            },
          })
        }
        if (view === 'pl') {
          if (!playlists) return h(Skeleton)
          return h(PlaylistGrid, { list: playlists, lang, onOpen: openPlaylist })
        }
        if (view === 'playlist') {
          if (!plDetail) return h(Skeleton)
          return h(PlaylistDetail, {
            pl: plDetail,
            lang,
            onOpen: (v) =>
              openItem({
                v: v.vid,
                t: v.title,
                c: v.channel,
                d: v.duration_s,
                w: v.views,
                th: v.thumbnail,
                p: v.published,
              }),
          })
        }
        if (view === 'liked' || view === 'later' || view === 'history') {
          const list = savedList(view === 'liked' ? 'likes' : view === 'later' ? 'later' : 'seen')
          const copy = {
            liked: [
              tx(lang, '还没有喜欢过任何视频', 'No liked videos yet'),
              tx(lang, '在详情页点喜欢，这里就会出现，并影响首页排序。', 'Like a video on its page and it shows up here.'),
            ],
            later: [
              tx(lang, '稍后看是空的', 'Watch later is empty'),
              tx(lang, '在详情页点稍后看，视频会留在这里等你。', 'Save a video for later and it waits here.'),
            ],
            history: [
              tx(lang, '还没有观看记录', 'No watch history yet'),
              tx(lang, '打开过的视频会出现在这里，并从首页推荐里避开。', 'Videos you open land here and drop out of the home feed.'),
            ],
          }[view]
          return h(SavedGrid, {
            list,
            lang,
            emptyTitle: copy[0],
            emptyHint: copy[1],
            onPick: pickView,
            onOpen: openItem,
          })
        }
        return null
      })()

      const shown = filtered.slice(0, limit)
      const stageText = stageLabel(lang, loadStage)
      const staleText = staleLabel(lang, loadStage)
      const loadingLabel = stageText || tx(lang, '正在准备视频库…', 'Preparing the video library…')

      return h(
        'div',
        { className: 'ht-root', ref: rootRef },
        h(
          'div',
          { className: 'ht-head' },
          h('div', { className: 'ht-brand' }, 'Hacker', h('b', null, 'Tube')),
          h(
            'button',
            {
              type: 'button',
              className: 'ht-shuffle',
              'data-testid': 'ht-shuffle',
              onClick: () => setRecSeed(Math.floor(Math.random() * 1e9) + 1),
              title: tx(lang, '换一批：重新排列首页前排', 'Shuffle: reorder the front of the grid'),
              'aria-label': tx(lang, '换一批', 'Shuffle'),
            },
            h(
              'svg',
              { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
              h('path', {
                d: 'M4 7h9l3-3M4 17h9l3 3M17 4l3 3-3 3M17 14l3 3-3 3',
                stroke: 'currentColor',
                strokeWidth: 1.8,
                strokeLinecap: 'round',
                strokeLinejoin: 'round',
              }),
            ),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'ht-lang',
              onClick: () => {
                const next = lang === 'zh' ? 'en' : 'zh'
                langTouchedRef.current = true
                rememberLang(next)
                setLang(next)
              },
              title: lang === 'zh' ? '切换到英文' : '切换到中文',
            },
            lang === 'zh' ? 'EN' : '中文',
          ),
          h(
            'form',
            {
              className: 'ht-search',
              onSubmit: (e) => e.preventDefault(),
            },
            h('input', {
              type: 'search',
              value: q,
              placeholder: tx(lang, '搜索标题、频道、标签，中英文均可', 'Search titles (English or Chinese), channels, tags'),
              onChange: (e) => setQ(e.target.value),
              'aria-label': tx(lang, '搜索视频', 'Search videos'),
            }),
            h(
              'button',
              { type: 'submit', 'aria-label': tx(lang, '搜索', 'Search') },
              h(
                'svg',
                { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
                h('circle', {
                  cx: 11,
                  cy: 11,
                  r: 7,
                  stroke: 'currentColor',
                  strokeWidth: 2,
                }),
                h('path', {
                  d: 'M16.5 16.5 21 21',
                  stroke: 'currentColor',
                  strokeWidth: 2,
                  strokeLinecap: 'round',
                }),
              ),
            ),
          ),
          h(
            'span',
            { className: 'ht-foot', style: { whiteSpace: 'nowrap' } },
            phase === 'ready'
              ? searchLoading
                ? tx(lang, '检索中…', 'Searching…')
                : tx(
                    lang,
                    resultTotal + ' 个视频',
                    resultTotal.toLocaleString('en-US') + (resultTotal === 1 ? ' video' : ' videos'),
                  )
              : '',
          ),
          authUrl
            ? h(
                'a',
                {
                  className: 'ht-open',
                  href: authUrl,
                  target: '_blank',
                  rel: 'noreferrer noopener',
                  title: tx(lang, '桌面端的自定义协议无法内嵌播放器，用浏览器打开即恢复正常', 'The desktop custom protocol cannot embed the player; open it in a browser instead'),
                },
                tx(lang, '浏览器打开', 'Open in browser'),
              )
            : null,
        ),
        h(ViewNav, { view, lang, onPick: pickView }),
        view === 'home' ? (h(
          'div',
          { className: 'ht-chips' },
          h(
            'button',
            {
              type: 'button',
              className: 'ht-chip' + (area === '' ? ' on' : ''),
              onClick: () => setArea(''),
            },
            tx(lang, '全部', 'All'),
          ),
          areas.map((a) =>
            h(
              'button',
              {
                type: 'button',
                key: a.id,
                className: 'ht-chip' + (area === a.id ? ' on' : ''),
                onClick: () => setArea(a.id),
              },
              lang === 'zh' && a.nameZh ? a.nameZh : a.name,
            ),
          ),
        )) : null,
        view === 'home' ? h(
          'div',
          { className: 'ht-filters' },
          h(
            'select',
            {
              className: 'ht-filter',
              'data-filter': 'year',
              value: year,
              onChange: (e) => setYear(e.target.value),
              'aria-label': tx(lang, '按年份筛选', 'Filter by year'),
            },
            h('option', { value: '' }, tx(lang, '全部年份', 'All years')),
            years.map((y) => h('option', { key: y, value: String(y) }, String(y))),
          ),
          h(
            'select',
            {
              className: 'ht-filter',
              'data-filter': 'type',
              value: type,
              onChange: (e) => setType(e.target.value),
              'aria-label': tx(lang, '按类型筛选', 'Filter by type'),
            },
            h('option', { value: '' }, tx(lang, '全部类型', 'All types')),
            types.map((t) =>
              h('option', { key: t, value: t }, lang === 'zh' ? CT_ZH[t] || t : t),
            ),
          ),
          h(
            'select',
            {
              className: 'ht-filter',
              'data-filter': 'level',
              value: level,
              onChange: (e) => setLevel(e.target.value),
              'aria-label': tx(lang, '按难度筛选', 'Filter by level'),
            },
            h('option', { value: '' }, tx(lang, '全部难度', 'All levels')),
            levels.map((l) =>
              h('option', { key: l, value: l }, lang === 'zh' ? LV_ZH[l] || l : l),
            ),
          ),
          h(
            'select',
            {
              className: 'ht-filter',
              'data-filter': 'sort',
              value: sort,
              onChange: (e) => setSort(e.target.value),
              'aria-label': tx(lang, '排序', 'Sort'),
            },
            h('option', { value: '' }, tx(lang, '默认排序', 'Default order')),
            h('option', { value: 'score' }, tx(lang, 'HN 推荐分', 'HN score')),
            h('option', { value: 'year' }, tx(lang, '最新发布', 'Newest')),
            h('option', { value: 'views' }, tx(lang, '最多观看', 'Most viewed')),
          ),
        ) : null,
        view === 'home' && phase === 'loading' ? h(Skeleton, { label: loadingLabel }) : null,
        view === 'home' ? (h(
          'div',
          {
            className: 'ht-scroll',
            ref: listScrollRef,
            onScroll: (e) => {
              listScrollTop.current = e.currentTarget.scrollTop || 0
            },
          },
          phase === 'ready' && staleText ? h('div', { className: 'ht-stale', role: 'status' }, staleText) : null,
          phase === 'ready' && stageText ? h('div', { className: 'ht-stagebar', role: 'status' }, stageText) : null,
          phase === 'error'
            ? h(
                'div',
                { className: 'ht-state' },
                h('div', null, tx(lang, '数据加载失败：', 'Failed to load: ') + err),
                h(
                  'button',
                  { type: 'button', className: 'ht-back', onClick: retry, style: { marginTop: 12 } },
                  tx(lang, '重试', 'Retry'),
                ),
              )
            : null,
          phase === 'ready' && searchLoading && !filtered.length
            ? h('div', { className: 'ht-state' }, tx(lang, '检索中…', 'Searching…'))
            : null,
          phase === 'ready' && searchError
            ? h('div', { className: 'ht-state' }, tx(lang, '检索失败：', 'Search failed: ') + searchError)
            : null,
          phase === 'ready' && !searchLoading && !searchError && !filtered.length
            ? h(
                'div',
                { className: 'ht-state' },
                /* 分类树不可用时领域筛选没有生效，不能把「筛选失灵」说成「没有结果」 */
                area && searchState.areaFiltered === false
                  ? tx(
                      lang,
                      '分类数据暂不可用，领域筛选没有生效。换个关键词，或稍后重试。',
                      'Category data is unavailable, so the area filter was not applied. Try another keyword or retry later.',
                    )
                  : tx(lang, '没有匹配的视频', 'No matching videos'),
              )
            : null,
          phase === 'ready' && filtered.length
            ? h(
                'div',
                { className: 'ht-grid' },
                shown.map((it) => h(Card, { key: it.v, item: it, lang, onOpen: openItem })),
              )
            : null,
          phase === 'ready' && filtered.length > limit && limit < GRID_CAP
            ? h('div', { ref: sentinelRef, className: 'ht-sentinel' })
            : null,
          phase === 'ready' && filtered.length > GRID_CAP && limit >= GRID_CAP
            ? h(
                'div',
                { className: 'ht-notice' },
                tx(lang, '已显示 ' + GRID_CAP + ' 条，用搜索或分类缩小范围', 'Showing ' + GRID_CAP + ' items; narrow it down with search or a category'),
              )
            : null,
        )) : body,
        helpOpen
          ? h(
              'div',
              { className: 'ht-keys', onClick: () => setHelpOpen(false) },
              h(
                'div',
                { className: 'k' },
                h('h3', null, lang === 'zh' ? '键盘快捷键' : 'Keyboard shortcuts'),
                h(
                  'table',
                  null,
                  (lang === 'zh'
                    ? [['/', '聚焦搜索'], ['j / k', '上下移动'], ['Enter', '打开'], ['l', '喜欢'], ['w', '稍后看'], ['h', '首页'], ['?', '这些快捷键'], ['Esc', '关闭']]
                    : [['/', 'Search'], ['j / k', 'Move'], ['Enter', 'Open'], ['l', 'Like'], ['w', 'Watch later'], ['h', 'Home'], ['?', 'Shortcuts'], ['Esc', 'Close']]
                  ).map((row) => h('tr', { key: row[0] }, h('td', null, h('kbd', null, row[0])), h('td', null, row[1]))),
                ),
              ),
            )
          : null,
      )
    }

    /* 会话右栏的页面主体：窄容器里复用同一份 HtRoot，但不碰页面 hash */
    function HtRail() {
      return h('div', { className: 'ht-rail-shell' }, h(HtRoot, { embedded: true }))
    }

    /* ---------------- 注册 ---------------- */

    return {
      inject: ['slots'],
      apply(ctx) {
        beacon('apply-enter', { hasCtx: !!ctx, hasSlots: !!(ctx && ctx.slots) })
        const slots = ctx && ctx.slots
        if (!slots || typeof slots.register !== 'function') {
          console.warn('[dsh-hackertube] slots 服务不可用，面板未注册')
          beacon('no-slots', { ctxKeys: ctx ? Object.keys(ctx).slice(0, 20) : null })
          if (typeof window !== 'undefined') {
            window.__dshHackertube = { loaded: true, registered: false, reason: 'no-slots' }
          }
          return
        }

        ctx.effect(() => {
          const el = document.createElement('style')
          el.setAttribute('data-dsh-hackertube', '')
          el.textContent = CSS
          document.head.appendChild(el)
          return () => {
            el.remove()
          }
        }, 'dsh-hackertube: styles')

        ctx.effect(() => {
          const d1 = slots.inject('sidebar.panellist', () =>
            slots.register(
              {
                name: 'sidebar.panellist',
                id: 'hackertube',
                order: 45,
                label: () => 'HackerTube',
              },
              PanelIcon,
            ),
          )
          const d2 = slots.inject('main', () =>
            slots.register({ name: 'main', key: 'hackertube' }, HtRoot),
          )
          return () => {
            for (const d of [d1, d2]) {
              if (typeof d === 'function') {
                try {
                  d()
                } catch {
                  /* 已被清理 */
                }
              }
            }
          }
        }, 'dsh-hackertube: native panel')

        /* 会话页原生右栏：只投 tab 类型与主体。id 用插件自有命名空间，
           kind 独占 hackertube；不接 dsh-better-sidebar 的 ctx.betterSidebar，
           两者同时安装时各占自己的 tab，不抢座位。 */
        if (typeof ctx.inject === 'function') {
          try {
            ctx.inject(['sidebarRightTabs'], (scope) => {
              const tabs = scope && scope.sidebarRightTabs
              if (!tabs || typeof tabs.register !== 'function') return
              ctx.effect(
                () =>
                  tabs.register({
                    id: 'dsh-hackertube:right',
                    kind: 'hackertube',
                    priority: 'extension',
                    keepMounted: true,
                    title: () => 'HackerTube',
                    guide: [
                      {
                        id: 'hackertube',
                        order: 60,
                        title: () => 'HackerTube',
                        description: () =>
                          initialLang() === 'zh'
                            ? '在会话右栏浏览与播放技术视频'
                            : 'Browse and play technical videos in the sidebar',
                        icon: (iconProps) => PlayGlyph((iconProps && iconProps.size) || 16),
                      },
                    ],
                  }),
                'dsh-hackertube: right pane type',
              )
              ctx.effect(
                () =>
                  ctx.slots.inject('sidebar.right.pane.tab', () =>
                    ctx.slots.register(
                      { name: 'sidebar.right.pane.tab', key: 'dsh-hackertube:right' },
                      HtRail,
                    ),
                  ),
                'dsh-hackertube: right pane body',
              )
              beacon('right-pane-registered', { id: 'dsh-hackertube:right' })
            })
          } catch (err) {
            console.warn('[dsh-hackertube] 右栏注册失败：', err)
            beacon('right-pane-error', { message: String((err && err.message) || err) })
          }
        }

        /* 刷新后可在控制台输入 __dshHackertube 直接看注册结果 */
        if (typeof window !== 'undefined') {
          window.__dshHackertube = {
            loaded: true,
            registered: true,
            at: Date.now(),
            panelId: 'hackertube',
          }
        }
        console.log('[dsh-hackertube] 面板已注册：sidebar.panellist + main')
        beacon('registered', { panelId: 'hackertube' })

        /* 中转页在 http:// 下无法直接回连 Host（跨源无 cookie），用 postMessage 递状态 */
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
          const onRelayMessage = (event) => {
            const data = event && event.data
            if (!data || typeof data !== 'object' || !data.__ht) return
            /* 播放位置每秒回传一次，问答时作为上下文，不写进 beacon 免得刷屏 */
            if (data.__ht === 'time') {
              const vid = String(data.vid || mem.activeWatchVid || '')
              if (!vid) return
              const position = { t: Number(data.t) || 0, d: Number(data.d) || 0, at: Date.now() }
              watchSession(vid).playhead = position
              /* 每 15 秒落一次盘，页面关掉也不会丢 */
              const lastWrite = watchSession(vid).savedAt || 0
              if (Date.now() - lastWrite > 15000) {
                watchSession(vid).savedAt = Date.now()
                saveProgress(vid, position)
              }
              for (const fn of mem.playheadSubs) {
                try {
                  fn(vid, position)
                } catch {
                  /* 订阅者卸载中 */
                }
              }
              return
            }
            if (data.__ht === 'yt-error' || data.__ht === 'api-error') {
              const errVid = String(data.vid || mem.activeWatchVid || '')
              const errCode = data.code == null ? null : Number(data.code)
              setPlaybackError(errVid, { kind: data.__ht, code: errCode })
              beacon('playback-error', data)
              /* 电视里作者不允许内嵌（101/150）：交给当前电视视图移出片库并换台 */
              if (data.__ht === 'yt-error') {
                for (const fn of mem.tvErrorSubs) {
                  try {
                    fn(errVid, errCode)
                  } catch {
                    /* 视图卸载中 */
                  }
                }
              }
              return
            }
            /* 播放器里点了「更多视频」，YouTube 在自己 iframe 里换了片：交给电视跟着换台 */
            if (data.__ht === 'yt-pick') {
              for (const fn of mem.tvPickSubs) {
                try {
                  fn(data)
                } catch {
                  /* 视图卸载中 */
                }
              }
              return
            }
            if (data.__ht === 'relay-loaded') {
              /* 重试后播放器真正就绪，清掉旧的错误覆盖层 */
              setPlaybackError(String(data.vid || mem.activeWatchVid || ''), null)
            }
            /* 电视里一条放完：交给当前电视视图接下一台 */
            if (data.__ht === 'state') {
              if (Number(data.s) === 0) {
                for (const fn of mem.tvEndSubs) {
                  try {
                    fn()
                  } catch {
                    /* 视图卸载中 */
                  }
                }
              }
              return
            }
            /* 电视的中转页把播放器里的方向键 / Esc 转出来，交给当前电视视图换台或退出 */
            if (data.__ht === 'nav') {
              for (const fn of mem.tvNavSubs) {
                try {
                  fn(data)
                } catch {
                  /* 视图卸载中 */
                }
              }
              return
            }
            beacon('relay-msg', data)
          }
          window.addEventListener('message', onRelayMessage)
          ctx.effect(
            () => () => window.removeEventListener('message', onRelayMessage),
            'dsh-hackertube: relay message',
          )
        }

        /* 查清楚宿主有没有把 HTTP 地址暴露给前端，决定播放器怎么落到安全上下文 */
        try {
          const boot = typeof window !== 'undefined' ? window.__DSH_BOOT__ : undefined
          beacon('boot-probe', {
            hasBoot: boot !== undefined && boot !== null,
            bootType: typeof boot,
            bootKeys: boot && typeof boot === 'object' ? Object.keys(boot).slice(0, 24) : null,
            bootSample: boot ? JSON.stringify(boot).slice(0, 600) : null,
            href: typeof location !== 'undefined' ? String(location.href) : null,
            base: typeof document !== 'undefined' ? String(document.baseURI) : null,
          })
        } catch (err) {
          beacon('boot-probe-error', { message: String(err && err.message) })
        }
      },
    }
  },
})
