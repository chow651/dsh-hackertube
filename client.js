/**
 * HackerTube Client 半 —— 经典脚本，经 __ModuleLoader__ 注入。
 *
 * 落点：左栏面板图标（sidebar.panellist，id=hackertube）与主区面板
 * （main，key=hackertube）成对绑定，点图标即切到面板。
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
      lang: 'en',
      mediaOrigin: null,
      titles: {},
      qMt: {},
      catZh: null,
      titlesP: null,
      playhead: null,
      taxLang: null,
    }

    const GRID_STEP = 60
    /* 配合 CSS content-visibility 把离屏卡片的布局成本降到接近零 */
    const GRID_CAP = 2000

    /** 界面文案：中文原句 + 英文对照，调用处不必写三元表达式 */
    const tx = (lang, zh, en) => (lang === 'zh' ? zh : en)

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

    /** 标题译文表；后台按批生成，前端拿到多少用多少。中文搜索也依赖它，所以英文模式一样要拉 */
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

    function loadDetail(vid, lang) {
      const key = lang === 'zh' ? vid + ':zh' : vid
      const hit = mem.detail.get(key)
      if (hit) return Promise.resolve(hit)
      const q =
        '/hackertube/api/video?vid=' +
        encodeURIComponent(vid) +
        (lang === 'zh' ? '&lang=zh' : '')
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
        const tick = () => {
          if (tries >= 30) return resolve(mem.mediaOrigin || null)
          tries += 1
          setTimeout(() => {
            getJSON('/hackertube/api/config')
              .then((d) => {
                if (d && d.mediaOrigin) {
                  mem.mediaOrigin = String(d.mediaOrigin)
                  return resolve(mem.mediaOrigin)
                }
                tick()
              })
              .catch(() => tick())
          }, 150)
        }
        tick()
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
  align-items:start;gap:28px;padding-top:2px}
.ht-watch .ht-toolbar{margin:0 auto 12px;max-width:1580px}
.ht-primary{min-width:0}
.ht-rail{position:sticky;top:0;align-self:start;display:flex;flex-direction:column;
  height:calc(100vh - 70px);min-height:420px}
/* 面板变窄时右栏落到正文下方：容器查询，跟随面板宽度而不是视口宽度 */
@container (max-width:1024px){
  .ht-watch-inner{grid-template-columns:minmax(0,1fr)}
  .ht-rail{position:static;height:min(640px,70vh)}
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
.ht-hn-mark{display:inline-flex;align-items:center;gap:5px;padding:1px 8px;border-radius:999px;
  background:rgba(255,102,0,.12);color:#b4460a;font-size:12px;font-weight:600}
.ht-hn-mark i{width:5px;height:5px;border-radius:50%;background:#ff6600;display:inline-block}
/* 评论区 */
.ht-comments{margin:30px 0 0;padding:22px 0 8px;border-top:1px solid var(--dsw-alias-border-l1)}
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
.ht-player{aspect-ratio:16/9;border-radius:12px;overflow:hidden;background:#000}
.ht-player iframe{width:100%;height:100%;border:0;display:block}
.ht-video{width:100%;height:100%;display:block;background:#000;object-fit:contain}
.ht-back{height:32px;padding:0 12px;border-radius:16px;border:0;cursor:pointer;font:inherit;
  background:var(--dsw-alias-bg-layer-1);color:inherit;font-weight:500;display:inline-flex;
  align-items:center;gap:6px;margin-bottom:16px}
.ht-back:hover{background:var(--dsw-alias-bg-layer-2)}
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
.ht-hgrid .ht-row .ht-thumb{width:180px}`

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
        ),
      )
    }

    /* ---------------- 分享卡片 ---------------- */

    function wrapLines(g, text, maxWidth) {
      const lines = []
      let cur = ''
      for (const ch of String(text)) {
        const next = cur + ch
        if (g.measureText(next).width > maxWidth && cur) {
          lines.push(cur)
          cur = ch
        } else {
          cur = next
        }
      }
      if (cur) lines.push(cur)
      return lines
    }

    async function makeShareCard(item, detail, quoteText) {
      const W = 1200
      const H = 675
      const c = document.createElement('canvas')
      c.width = W
      c.height = H
      const g = c.getContext('2d')
      if (!g) return

      g.fillStyle = '#0d1117'
      g.fillRect(0, 0, W, H)

      const img = new Image()
      img.src = '/hackertube/api/thumb?vid=' + encodeURIComponent(item.v)
      await new Promise((res) => {
        img.onload = res
        img.onerror = res
      })
      if (img.naturalWidth) {
        const ih = Math.round((img.naturalHeight / img.naturalWidth) * W)
        g.drawImage(img, 0, 0, W, ih)
      }

      const grad = g.createLinearGradient(0, 180, 0, 540)
      grad.addColorStop(0, 'rgba(13,17,23,0)')
      grad.addColorStop(0.65, 'rgba(13,17,23,0.94)')
      grad.addColorStop(1, '#0d1117')
      g.fillStyle = grad
      g.fillRect(0, 180, W, 360)

      const family = 'system-ui, -apple-system, "Segoe UI", sans-serif'

      g.fillStyle = '#e6edf3'
      g.font = 'bold 40px ' + family
      const titleLines = wrapLines(g, item.t || '(untitled)', W - 128).slice(0, 2)
      titleLines.forEach((line, i) => g.fillText(line, 64, 470 + i * 50))

      const quoteY = 470 + titleLines.length * 50 + 24
      if (quoteText) {
        g.fillStyle = '#8b949e'
        g.font = '24px ' + family
        const qLines = wrapLines(g, '\u201c' + quoteText + '\u201d', W - 128).slice(0, 2)
        qLines.forEach((line, i) => g.fillText(line, 64, quoteY + i * 34))
      }

      g.fillStyle = '#ff6600'
      g.font = 'bold 24px ' + family
      g.fillText('HackerTube', 64, H - 40)
      g.fillStyle = '#8b949e'
      g.font = '20px ' + family
      const meta = [item.c, item.d ? Math.round(item.d / 60) + ' min' : null]
        .filter(Boolean)
        .join(' · ')
      /* 右对齐到底部同一基线，避免依赖品牌文字的实测宽度 */
      if (meta) {
        const w = g.measureText(meta).width
        g.fillText(meta, W - 64 - w, H - 40)
      }

      const blob = await new Promise((res) => c.toBlob(res, 'image/png'))
      if (!blob) return
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = 'hackertube-' + item.v + '.png'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      setTimeout(() => URL.revokeObjectURL(a.href), 4000)
    }

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
    function SideRail({ vid, lang = 'zh', related, pane, onPane, onOpen }) {
      const [messages, setMessages] = useState([])
      const [input, setInput] = useState('')
      const [busy, setBusy] = useState(false)

      const send = () => {
        const q = input.trim()
        if (!q || busy) return
        setInput('')
        setMessages((m) => m.concat([{ role: 'user', text: q }, { role: 'ai', text: '', pending: true }]))
        setBusy(true)
        const at = mem.playhead && Date.now() - mem.playhead.at < 15000 ? mem.playhead.t : 0

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
              body: JSON.stringify({ vid, question: q, at, stream: true, lang }),
            })
          } catch (e) {
            settle(tx(lang, '请求失败：', 'Request failed: ') + String((e && e.message) || e))
            return
          }
          const type = res.headers.get('content-type') || ''
          if (!res.ok || !res.body || type.indexOf('text/event-stream') < 0) {
            const d = await res.json().catch(() => null)
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
                  if (evt.delta) {
                    acc += evt.delta
                    append(evt.delta)
                  } else if (evt.error) {
                    acc = tx(lang, '请求失败：', 'Request failed: ') + evt.error
                  } else if (evt.done && typeof evt.answer === 'string') {
                    acc = evt.answer
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
          .finally(() => setBusy(false))
      }

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
        { className: 'ht-rail', 'data-pane': pane },
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

      const hn = detail && detail.hn ? detail.hn : null
      const threadId = detail && detail.quote && detail.quote.id ? detail.quote.id : null
      /* 中文模式下优先用 Host 返回的译文，没有则退回原文 */
      const tr = (detail && detail.i18n) || {}
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

      useEffect(() => {
        if (descOpen) return
        const el = descRef.current
        if (!el) return
        setDescFit(el.scrollHeight <= el.clientHeight + 2)
      }, [detail, lang, descOpen, item.v])

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

      return h(
        'div',
        { className: 'ht-watch' },
        h(
          'div',
          { className: 'ht-toolbar' },
          h('button', { type: 'button', className: 'ht-back', onClick: onBack }, tx(lang, '← 返回列表', '← Back to list')),
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
              /* 中转页地址是异步拿到的；未就绪前不渲染 iframe，避免先请求一个必然 404 的相对路径 */
              origin
                ? h('iframe', {
                    className: 'ht-video',
                    title: item.t,
                    src: origin + '/embed?vid=' + encodeURIComponent(item.v) + '&lang=' + (lang === 'zh' ? 'zh' : 'en'),
                    allow:
                      'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen',
                    allowFullScreen: true,
                    onLoad: () => beacon('iframe-loaded', { vid: item.v }),
                  })
                : h('div', { className: 'ht-video ht-video-wait' }, tx(lang, '正在准备播放器…', 'Preparing player…')),
            ),
            h('h1', { className: 'ht-h1' }, titleOf(item, lang)),
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
                'button',
                {
                  type: 'button',
                  className: 'ht-pill',
                  onClick: () => {
                    void makeShareCard(item, detail, quoteText)
                  },
                },
                h(Ico, null, h('path', { d: 'M12 16V4M8 8l4-4 4 4M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3' })),
                tx(lang, '分享卡片', 'Share card'),
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
                  ctLabel || lvLabel
                    ? h(
                        'div',
                        { className: 'ht-desc-head' },
                        ctLabel ? h('span', { key: 'ct' }, ctLabel) : null,
                        ctLabel && lvLabel ? h('span', { key: 'dot' }, '·') : null,
                        lvLabel ? h('span', { key: 'lv' }, lvLabel) : null,
                      )
                    : null,
                  h(
                    'div',
                    { className: 'ht-desc-body', ref: descRef },
                    summaryText ? h('p', { className: 'ht-desc-p', key: 's' }, summaryText) : null,
                    whyHnText ? h('p', { className: 'ht-desc-p ht-desc-why', key: 'w' }, whyHnText) : null,
                    quoteText
                      ? h(
                          'p',
                          { className: 'ht-desc-quote', key: 'q' },
                          tx(lang, '「' + quoteText + '」', '“' + quoteText + '”'),
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
          h(SideRail, {
            key: 'rail',
            vid: item.v,
            lang,
            related,
            pane: railPane,
            onPane: setRailPane,
            onOpen: onOpenItem,
          }),
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
      }))
      const saveTimer = useRef(null)
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
            })
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
        if (saveTimer.current) clearTimeout(saveTimer.current)
        saveTimer.current = setTimeout(() => {
          try {
            void fetch('/hackertube/api/prefs', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ likes: next.likes, later: next.later, seen: next.seen }),
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
      return { saved, toggle, markSeen }
    }

    /* ---------------- 视图组件 ---------------- */

    const NAV = {
      zh: [['home', '首页'], ['cats', '分类'], ['pl', '播放列表'], null, ['liked', '喜欢'], ['later', '稍后看'], ['history', '历史']],
      en: [['home', 'Home'], ['cats', 'Categories'], ['pl', 'Playlists'], null, ['liked', 'Liked'], ['later', 'Watch later'], ['history', 'History']],
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
                    className: 'ht-tab' + (props.view === t[0] ? ' on' : ''),
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

    function HtRoot(props) {
      const [items, setItems] = useState(mem.list || [])
      const [tax, setTax] = useState(mem.tax || null)
      const [phase, setPhase] = useState(mem.list ? 'ready' : 'loading')
      const [loadStage, setLoadStage] = useState(
        mem.status || { stage: mem.list ? 'ready' : 'idle', stale: false, revalidating: false, enriched: 0, total: 0 },
      )
      const [err, setErr] = useState('')
      const [q, setQ] = useState('')
      /* 中文查询机翻成英文后的检索词：标签只有英文，靠它才能命中 */
      const [qMt, setQMt] = useState('')
      const [area, setArea] = useState('')
      const [limit, setLimit] = useState(GRID_STEP)
      const [watching, setWatching] = useState(null)
      const [lang, setLang] = useState(mem.lang || 'en')
      const [view, setView] = useState('home')
      const [playlists, setPlaylists] = useState(null)
      const [plDetail, setPlDetail] = useState(null)
      const [plSlug, setPlSlug] = useState(null)
      const [helpOpen, setHelpOpen] = useState(false)
      const { saved, toggle, markSeen } = useSaved()
      const [titlesVersion, setTitlesVersion] = useState(0)

      /* 标题译文表在两种语言下都要：中文界面用来显示，英文界面用来支持中文搜索 */
      const ensureTitles = () => {
        void loadTitles().then((t) => {
          if (Object.keys(t).length) setTitlesVersion((v) => v + 1)
        })
      }
      useEffect(() => {
        ensureTitles()
      }, [])

      /* 分类的中文名也参与检索：输入「数学」「安全」能命中整类，而不只是标题里带这两个字的视频 */
      const [taxReady, setTaxReady] = useState(0)
      useEffect(() => {
        if (mem.catZh) {
          setTaxReady((v) => v + 1)
          return undefined
        }
        let alive = true
        getJSON('/hackertube/api/taxonomy?lang=zh&translate=1')
          .then((d) => {
            if (!alive || !d) return
            const m = {}
            for (const a of d.areas || []) {
              if (a.nameZh) m['a:' + a.id] = a.nameZh
              for (const c of a.categories || []) if (c.nameZh) m[c.id] = c.nameZh
            }
            mem.catZh = m
            setTaxReady((v) => v + 1)
          })
          .catch(() => {})
        return () => {
          alive = false
        }
      }, [])
      const [reloadKey, setReloadKey] = useState(0)
      const [authUrl, setAuthUrl] = useState(null)
      const sentinelRef = useRef(null)
      const rootRef = useRef(null)

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

      const retry = () => {
        setErr('')
        setPhase('loading')
        setReloadKey((k) => k + 1)
      }

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

      const catToArea = useMemo(() => {
        const m = new Map()
        const list = tax && Array.isArray(tax.areas) ? tax.areas : []
        for (const a of list) {
          for (const c of a.categories || []) m.set(c.id, a.id)
        }
        return m
      }, [tax])

      const filtered = useMemo(() => {
        if (!items.length) return []
        /* 空格分词、全部命中才算命中；中文查译文、英文查原文，两种都能搜 */
        const tokens = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
        const mtTokens = String(qMt || '').toLowerCase().split(/\s+/).filter(Boolean)
        let out = items
        if (area) {
          out = out.filter((it) =>
            Array.isArray(it.cats) && it.cats.some((id) => catToArea.get(id) === area),
          )
        }
        if (tokens.length) {
          out = out.filter((it) => {
            const zh = (mem.titles && mem.titles[it.v]) || ''
            let catText = ''
            if (mem.catZh && Array.isArray(it.cats)) {
              /* 只用二级分类名，不用大区名：「安全」不该把数据库、操作系统的视频一起带出来 */
              const parts = []
              for (const id of it.cats) if (mem.catZh[id]) parts.push(mem.catZh[id])
              catText = parts.join(' ')
            }
            const hay = (
              (it.t || '') +
              '\n' +
              (it.c || '') +
              '\n' +
              zh +
              '\n' +
              catText +
              '\n' +
              (Array.isArray(it.tags) ? it.tags.join(' ') : '')
            ).toLowerCase()
            /* 原文命中，或者机翻后的英文命中，都算 */
            if (tokens.every((tok) => hay.indexOf(tok) >= 0)) return true
            return mtTokens.length > 0 && mtTokens.every((tok) => hay.indexOf(tok) >= 0)
          })
        }
        return out
      }, [items, q, qMt, area, catToArea, titlesVersion, taxReady])

      /* 查询里带汉字才需要机翻；结果按查询串缓存，重复输入不再请求 */
      useEffect(() => {
        const raw = q.trim()
        if (!raw || !/[\u4e00-\u9fff]/.test(raw)) {
          setQMt('')
          return undefined
        }
        if (mem.qMt[raw] != null) {
          setQMt(mem.qMt[raw])
          return undefined
        }
        let alive = true
        const timer = setTimeout(() => {
          fetch('/hackertube/api/mt', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: raw, to: 'en' }),
          })
            .then((r) => r.json())
            .then((d) => {
              if (!alive || !d || typeof d.text !== 'string') return
              mem.qMt[raw] = d.text
              setQMt(d.text)
            })
            .catch(() => {})
        }, 300)
        return () => {
          alive = false
          clearTimeout(timer)
        }
      }, [q])

      useEffect(() => {
        setLimit(GRID_STEP)
      }, [q, area])

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
        setWatching(it)
      }

      /* 键盘快捷键：与站点一致的那一套 */
      useEffect(() => {
        if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return
        const onKey = (e) => {
          if (e.metaKey || e.ctrlKey || e.altKey) return
          const el = document.activeElement
          const typing = el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)
          if (e.key === 'Escape') {
            if (typing) el.blur()
            setHelpOpen(false)
            return
          }
          if (typing) return
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
            setWatching(null)
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
      }, [watching, toggle])

      if (watching) {
        return h(WatchView, {
          item: watching,
          lang,
          onBack: () => setWatching(null),
          liked: saved.likes.indexOf(watching.v) >= 0,
          savedLater: saved.later.indexOf(watching.v) >= 0,
          onToggle: toggle,
          onOpenItem: (r) => {
            markSeen(r.v)
            setWatching({ v: r.v, t: r.t, c: r.c, d: r.d, w: r.w, th: r.th, p: r.p })
          },
        })
      }

      const pickView = (next) => {
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
              className: 'ht-lang',
              onClick: () => {
                const next = lang === 'zh' ? 'en' : 'zh'
                mem.lang = next
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
              ? tx(
                  lang,
                  filtered.length + ' 个视频',
                  filtered.length.toLocaleString('en-US') + (filtered.length === 1 ? ' video' : ' videos'),
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
        view === 'home' && phase === 'loading' ? h(Skeleton, { label: loadingLabel }) : null,
        view === 'home' ? (h(
          'div',
          { className: 'ht-scroll' },
          phase === 'ready' && staleText ? h('div', { className: 'ht-stale', role: 'status' }, staleText) : null,
          phase === 'ready' && stageText ? h('div', { className: 'ht-stagebar', role: 'status' }, stageText) : null,
          phase === 'loading'
            ? null
            : null,
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
          phase === 'ready' && !filtered.length
            ? h('div', { className: 'ht-state' }, tx(lang, '没有匹配的视频', 'No matching videos'))
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
              mem.playhead = { t: Number(data.t) || 0, d: Number(data.d) || 0, at: Date.now() }
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
