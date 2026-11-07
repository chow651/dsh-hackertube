# HackerTube 交接文档

写给接手这个插件的下一个 agent。记录了架构、为什么这样设计、踩过哪些坑、现在什么能用。读完这一份就能开始改代码。

---

## 一、这个插件是什么

把 hackertube.org 的 6454 条视频做成 DSH 面板。这些视频是 Hacker News 二十年里被反复推荐的技术演讲、课程、论文讲解，每条都带推荐理由和讨论数据。

**定位**：不是视频网站，是「Agent 能引用、能检索、能把它变成文字的技术内容库」。用户在写代码时想知道「有没有讲 X 的深度内容」，这个面板回答那个问题。

**消费方有两层**：主对话里的 Agent 通过 `hackertube_search` 工具检索；用户自己打开面板浏览、播放、提问。

---

## 二、架构

### 双半结构

DSH 插件分两半，这是硬性架构，不是选择：

| 半 | 文件 | 能力 |
|---|---|---|
| Host | `index.js` | Node 环境：文件系统、子进程、网络、LLM 调用、工具注册 |
| Client | `client.js` | 浏览器环境：React 组件、DOM、CSS |

Client 半通过 `window.__ModuleLoader__.load()` 加载，返回 `{ inject, apply(ctx) }`。Host 半是标准的 `export function apply(ctx)`。

两半通过 HTTP 通信，路由前缀 `/hackertube/api`。

### 三套服务器

这是最容易搞混的地方，理清就通了：

```
DSH 的 webServer（端口动态，如 51306）
  ├─ 在认证层后面
  ├─ 提供 /hackertube/api/*
  └─ 只服务同源的 Client 半

插件自起的 mediaServer（固定 18090）
  ├─ 免认证
  ├─ 只提供 /embed?vid=xxx
  └─ 给 iframe 用，绕开认证层
```

**为什么需要第二套**：Client 半在 `dsh-app://` 下，与 `http://127.0.0.1:PORT` 不同源，跨源 iframe 请求带不上 cookie，会被 DSH 的 `authorizeIndex` 挡成 401。自起的服务器不在认证层后面，能返回真正的中转页。

### 播放链路

```
dsh-app:// 页面
└ iframe → http://127.0.0.1:18090/embed?vid=xxx   （插件自起，免认证）
  └ YouTube IFrame API 托管播放器
    └ 每秒 postMessage 回传 { __ht: 'time', t, d }
```

用 IFrame API 而不是直接嵌 embed，是为了拿到 `getCurrentTime()` —— 问答时要用播放位置做上下文。

---

## 三、关键决策与原因

### 为什么不用 `<video>` 播本地文件

试过。`yt-dlp | ffmpeg` 转 fMP4 流式播放，实测两小时视频要 17 秒才出首帧，而且用户明确拒绝占用磁盘。放弃。

### 为什么不用第三方前端（Invidious / Piped）

`yewtu.be` 有浏览器完整性检查，iframe 里无限转圈；`piped.video` 前端能加载但后端 API 拉不到流。都是别人维护的服务，不可控。

### 为什么不用 youtubei.js

18.3.0 版本能拿到 `playability_status: OK`，但 70 个格式全带 `signature_cipher`，`decipher()` 报 "No valid URL to decipher"，`hls_manifest_url` 是 null。库跟不上了。

### 为什么 LLM 走 `ctx.get('llm')`

复用当前 profile 已配置的 provider，用户不用再配一套 key。`listProviders()` 能看到 `magpie`、`deepseek-official` 等，`listModels(provider)` 拿到模型列表，`stream({provider, model, messages})` 发起调用。

**注意**：`messages` 的 `content` 必须是数组 `[{type:'text', text:'...'}]`，传字符串会报 `content.some is not a function`。

### 为什么翻译分三层

实测抽样 300 条：现成中文字幕 5.7%，只有英文字幕约 82%，完全没有 13%。所以：有中文用中文，只有英文交给 YouTube 自带翻译，完全没字幕的才需要本地 Whisper（还没实现）。

标题和推荐理由的翻译走 LLM，缓存在 `i18n/zh-titles.json` 和 `i18n/zh.json`。

### 为什么备用片源的判定和选取分开

判定用合取，任一硬门槛不过就淘汰；选取才打分。第一版是加权求和，结果「时长巧合 40 分 + 蹭到一个词 30 分」就能过关，实测立刻放进两条完全无关的视频。判定和选取揉在一起是这个模块最容易犯的错。

三条硬门槛：时长差 ≤2 秒、不早于原片发布、时长有效。过了门槛才进证据层，证据层要求至少一条内容凭据。

### 为什么官方号不参与打分

官方号是独立优先级层，存在即选中，哪怕播放量只有个位数。其余按本地化程度分档：中字 → 中文或高播放 → 转载。官方判定只看 UP 主名与频道名是否匹配，不看投稿类型（copyright）——实测同一个频道有的标自制、有的标转载，用投稿类型卡会漏掉一半官方号。

---

## 四、踩过的坑（带症状）

这一节比架构重要。每个都是真实故障，症状和原因都记下来了。

### 1. `X-Frame-Options: SAMEORIGIN` 把自己锁死

**症状**：iframe 区域纯黑，但 `load` 事件正常触发。

**原因**：中转页在 18090，父页面在 `dsh-app://`，不同源。`SAMEORIGIN` 让浏览器拒绝渲染，但 `onLoad` 照样触发 —— 这就是"事件触发不等于渲染成功"。

**解法**：中转页不设这个头。

### 2. 重载后旧服务器还活着

**症状**：改了中转页代码，重载插件，前端看到的还是旧页面。

**原因**：`ctx.effect` 的清理不保证在每次重载路径上执行，旧 `http.Server` 继续监听。

**解法**：服务器挂在 `globalThis.__htMediaServer`，`apply` 开头显式 `close()` 旧的。

### 3. 动态端口让前端拿到过期地址

**症状**：前端 `mediaOrigin` 是 `http://127.0.0.1:53020`，但实际服务器在 61123。

**原因**：`listen(0)` 每次分配新端口，前端缓存了旧值。

**解法**：固定端口 18090，占用则依次试 18091-18093。

### 4. beacon 撞认证，诊断数据全是假的

**症状**：中转页的 beacon 从来没到达，判断成"页面没加载"。实际页面加载了，`background:#000` 就是那块黑。

**原因**：beacon 发到 `http://127.0.0.1:PORT/hackertube/api/beacon`，跨源无 cookie，401。

**解法**：改用 `postMessage` 递回父页面，由父页面代发。**观察通道和被测对象共享失效模式时，看到的"什么都没有"是假的。**

### 5. 日志字段被自己覆盖

**症状**：beacon 记录里 `origin` 一直是 null，但客户端明明传了值。

**原因**：Host 侧写日志时 `payload.origin = req.headers.origin`，用请求头的空值覆盖了客户端字段。

**解法**：请求头字段加 `req` 前缀（`reqOrigin`、`reqReferer`）。

### 6. reasoning 混进正文

**症状**：AI 回答开头带着 "We need answer exactly OK. Need comply." 这类推理过程。

**原因**：流式 chunk 里只有 `block-start` 带 `blockType`，后续增量没有标记，光看单个 chunk 分不清是推理还是正文。

**解法**：跟踪当前块类型，`block-start` 时记下 `blockType`，`block-end` 时清空，中间的增量按当前块类型决定要不要收。

### 7. 模型把批内编号带进译文

**症状**：`Fire test: wooden house` 译成 `10. 防火测试：木结构房屋`。

**原因**：prompt 里用了 `1. xxx` 编号，模型有时把编号一起输出。

**解法**：`stripLeadingIndex()` 剥掉行首的 `N. ` / `N、` / `N)`，写入缓存前调用。

### 8. LLM 调用挂死拖住整批

**症状**：翻译进度卡在 5680/6454 不动，十几分钟零进展。

**原因**：某个 provider 的 stream 不 resolve 也不 reject。

**解法**：`streamOnce` 包一层 `Promise.race`，90 秒硬超时。

### 9. `NO_PROXY` 里的 `[::1]` 让 httpx 崩

**症状**：Python 脚本报 `httpx.InvalidURL: Invalid port: ':1]'`。

**原因**：环境变量 `NO_PROXY=localhost,127.0.0.1,::1,[::1]`，方括号形式 httpx 解析不了。

**解法**：跑 Python 时覆盖 `NO_PROXY=localhost,127.0.0.1,::1`。

### 10. `useMemo` 把新字段吃掉

**症状**：接口返回 `nameZh: "软件工程与编程语言"`，但 UI 显示英文。

**原因**：`areas` 的 `useMemo` 里写的是 `{ id: a.id, name: a.name }`，`nameZh` 没取出来。

**解法**：加进映射。**改接口字段时，顺手检查所有 useMemo 的映射。**

### 11. 设备指纹第四个参数是毒药

**症状**：按社区教程补齐 `dm_img_list` / `dm_img_str` / `dm_cover_img_str` / `dm_img_inter` 四个参数后，特定接口返回 `-352` 风控校验失败。

**原因**：`dm_img_inter` 带上必被判异常，其余三个是必需的。

**解法**：只带前三个。这个反直觉的点没有任何教程写过。

### 12. 短标题靠 LCS 冒充

**症状**：《STUPID MOVE》被判成《Sony Releases Stupid Piece Of Shit》。

**原因**：相似度用短串做分母，六个字符重合就够 0.6。

**解法**：除覆盖率外增加绝对长度下限（≥12 字符），且长串要过 20 或覆盖率 0.8。

### 13. 品牌名重合被当成内容证据

**症状**：两条完全不同频道的哈雷视频被判为同一支。

**原因**：最长公共子串是 `harleydavidson`，14 个字符，纯英文品牌名。

**解法**：中文匹配要求重合片段必须含中文字符，或长度过 20。

### 14. 简介里的视频地址是双向证据

**症状**：某频道《这不是邦联国旗？》被同频道另一支 282 秒的片子顶上来。

**原因**：简介里写着「原视频」和频道名，命中转载证据，但地址指向的是同作者的另一支视频。

**解法**：从简介提取所有视频标识，含本条才算凭据；只有别的就一票否决，标题再像也不认。

### 15. 查询词之间写成串行，延迟翻四倍

**症状**：按需解析要 2.3 秒。

**原因**：三个查询词依次 `await`，每个词两页并发，实际等了三轮往返。

**解法**：所有词所有页一次性并发出去，只等一个往返，降到 575 毫秒。

---

## 五、当前状态

### 能用

- 面板：6454 条视频，检索（面板与工具共用 Host 索引）、16 个领域分类筛选、年份/类型/难度/排序、窗口化滚动
- 首屏：本地导出或旧缓存先渲染，远端元信息后台补齐，阶段与旧数据状态可见
- 播放：中转页 + YouTube IFrame API；嵌入被拒时给出错误、YouTube 链接与 yt-dlp/ffmpeg 直连兜底
- 观看：深链 `#ht-watch=<vid>`、Esc 返回、列表滚动与筛选复原
- 中文：标题 100% 翻译（6454/6454），领域名与分类名，详情原文先出、译文异步补齐并标注模型译/机翻
- AI：右栏按视频隔离的观看会话，带播放位置附近字幕与对话历史
- 推荐：likes 驱动的推荐画像，只改首页网格前排的先后（相关/半相关/无关混排），可换一批
- 备用片源：按需解析中文平台的搬运，命中才在「在 YouTube 观看」旁补一个入口
- 播放进度：按视频落盘，重开时续播，页面显示上次位置并提供「从头开始」
- 工具：`hackertube_search` 已注册，与面板共用同一检索

### 不能用 / 没实现

- **Whisper 转写**：13% 完全没有字幕的视频需要它，只做了依赖探测
- **局部画面**：AI 只吃字幕，不抽帧
- **健康面板**：诊断仍写在 `~/.dsh/.dsh-hackertube/`，没有 UI
- **视频转笔记**：没做
- **分享卡片**：实现已删除，功能从产品里拿掉
- **HN 评论考古**：没做

### 环境依赖

| 依赖 | 用途 | 缺失时 |
|---|---|---|
| yt-dlp | 拉字幕 | `/subs` 返回 424 |
| ffmpeg | 音频抽取（转写用） | 转写不可用 |
| faster-whisper | 本地转写 | 转写不可用 |

三者都通过 `/hackertube/api/deps` 探测，缺什么在 UI 上说明，插件不替用户装。

---

## 六、改代码的注意事项

### 重载流程

```
plugin_manager set_bundle enabled=false target=dsh-hackertube
plugin_manager set_bundle enabled=true  target=dsh-hackertube
```

Host 半重载即生效。Client 半要刷新浏览器页面（DSH 有 client bundle 缓存）。

### 验证方式

**没有浏览器自动化时**，用 token 换 cookie 直接 curl：

```bash
# 从 ~/.dsh/.dsh-hackertube/auth-url.json 拿带 token 的地址
curl -s -c ck.txt -L -o /dev/null "http://127.0.0.1:PORT/?token=XXX"
curl -s -b ck.txt "http://127.0.0.1:PORT/hackertube/api/list"
```

**有 Playwright 时**（推荐），能验证真实渲染：

```bash
cd $TEMP/ht-rec && node ui-check.js
```

脚本在 `%TEMP%\ht-rec\`，用的是系统 Chrome（`channel: 'chrome'`），不用下载浏览器。

### 诊断文件

Host 半会往 `~/.dsh/.dsh-hackertube/` 写诊断文件，改代码时很有用：

| 文件 | 内容 |
|---|---|
| `boot.json` | apply 是否被调用、进程 pid |
| `media-origin.json` | 中转服务器实际端口 |
| `auth-url.json` | 带 token 的访问地址 |
| `beacon.json` | 客户端上报的诊断事件 |
| `llm-probe.json` / `llm-call.json` | LLM 服务探测结果 |

### 三件必须记住的

1. **不要给中转页加 `X-Frame-Options`**
2. **`apply` 开头要关掉旧的 mediaServer**
3. **跨源 iframe 的 `load` 事件触发不等于渲染成功**

---

## 七、下一步优先级建议

本轮（`.scratch/ht-ux/`）已交付首屏、检索、播放兜底、观看导航、AI 会话与语言翻译。剩下的按依赖排：

1. **局部画面**：问题涉及图表、演示或代码演示时，用 `yt-dlp --download-sections` 取 5–10 秒再抽 1–3 帧，只在 provider 支持 image 时发送；字幕仍是主上下文。
2. **Whisper 转写**：补那 13%。`faster-whisper` 已装，实测 small 模型 19.3x 实时。
3. **视频转笔记**：字幕进 Agent，生成带时间戳锚点的 markdown，点时间戳跳回原片。
4. **健康状态**：数据新鲜度、字幕依赖、cookies、模型、端口、缓存占用做成一处小 popover。本轮明确不做。
5. **HN 评论考古**：拉 Algolia 的当年讨论帖，展示评论树。

详细清单见 `ROADMAP.md`。工单与规格见 `.scratch/ht-ux/`。
