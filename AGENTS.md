# dsh-hackertube

DSH 插件：把 [hackertube.org](https://hackertube.org) 的 6454 条视频（Hacker News 二十年推荐）做成面板，带播放、中文翻译、AI 问答和分享卡片。

## 快速开始

```
# 改完代码后重载（不要重启 DSH）
plugin_manager set_bundle enabled=false target=dsh-hackertube
plugin_manager set_bundle enabled=true  target=dsh-hackertube
```

Host 半改动重载即生效；Client 半需要刷新浏览器页面。

## 改代码前必读

**[`HANDOFF.md`](HANDOFF.md)** —— 架构、关键决策的原因、踩过的坑、当前状态、待办。

三件最容易踩的事：

1. **`dsh-app://` 不是安全上下文**，Chromium 不给它发 Referer。任何依赖 Referer 的第三方嵌入都会失败。播放器走的是插件自起的 HTTP 中转服务器（端口 18090），不是直接 iframe。
2. **中转页不能设 `X-Frame-Options`**。父页面是 `dsh-app://`，与本服务器不同源，`SAMEORIGIN` 会让浏览器拒绝渲染。
3. **重载时旧监听不会自动关闭**。服务器挂在 `globalThis.__htMediaServer` 上，`apply` 开头显式 `close()` 旧的，否则前端会连到残留实例。

## 测试

```bash
npm test                        # 四段串联：mirror + watch-session + host-smoke + client-render
node test/mirror.mjs            # 备用片源判定，40 项，不联网
node test/watch-session.mjs     # 观看会话与字幕上下文
node test/host-smoke.mjs        # Host 半，含 export-first / stale-offline / language / search / recommend fixture
node test/client-render.mjs client.js   # Client 渲染
npm run test:mirror-live        # 真实链路抽查，需要外网；不进 npm test
```

Host 冒烟里的 live 上游断言在拿到限流或离线时会 skip 而不是 fail；`HT_FORCE_LIVE=1` 可强制走 live 路径。

## 代码结构

| 文件 | 职责 |
|---|---|
| `index.js` | Host 半：数据抓取、缓存、检索、中转服务器、字幕、LLM、工具注册 |
| `client.js` | Client 半：面板 UI、播放器、观看会话、推荐排序 |
| `recommend.js` | 推荐画像的纯函数：向量质心、共推荐边、冷启动 |
| `mirror.js` | 备用片源的判定与解析：时长门槛、证据分级、多版本选取、缓存 |
| `cordis.patch.yml` | 插件声明（`inject: [tools]`） |
| `ROADMAP.md` | 待办清单与已知约束 |

运行时数据在 `~/.dsh/.dsh-hackertube/`（缓存、译文、cookie、诊断日志）。

## Agent skills

### Issue tracker

Team task board + local `.scratch/ht-ux/` markdown mirror. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: `GLOSSARY.md` + `docs/adr/`. See `docs/agents/domain.md`.
