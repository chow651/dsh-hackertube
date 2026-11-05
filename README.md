# HackerTube for DSH

把 [hackertube.org](https://hackertube.org) 收录的 6454 个视频（Hacker News 二十年里被反复推荐的技术视频）做成一块 DSH 面板：直接播放、中英双语、中文搜索、带 AI 问答和 HN 讨论。

![首页](docs/home.png)

![详情页](docs/watch.png)

## 功能

- **浏览**：首页网格、16 个大类 / 150 个二级分类、播放列表、喜欢、稍后看、历史
- **播放**：自起中转服务器托管 YouTube IFrame 播放器，播放位置实时回传，用作 AI 的上下文
- **双语界面**：中英一键切换，界面文案零混排；热度数字中文走「万 / 亿」，英文走 K / M / B
- **中文搜索**：中文标题、英文原文、频道、标签、二级分类名都参与检索；中文查询会先机翻成英文再匹配英文标签
- **标题译文**：6454 条人工水准的中文标题随仓库附带，装完即用，不消耗模型额度
- **详情页**：简介卡（默认折叠、可展开）、HN 推荐理由、评论引用、话题标签
- **HN 讨论**：按推荐力度排序的前 12 条评论，可逐条或整段机翻
- **AI 问答**：右侧栏「相关推荐 / AI 问答」两页切换，流式输出，回答引用字幕与 HN 统计
- **分享卡片**：一键生成带 HN 数据的视频卡片
- **键盘操作**：`/` 聚焦搜索、方向键在卡片间移动、`Enter` 打开

## 安装

需要 DSH 本体。插件作为一个 bundle 安装后再启用：

```
plugin_manager install_bundle target=dsh-hackertube
```

如果还没发布到 npm，也可以从 Git 仓库直接装（宿主如何解析安装参数取决于版本，装不上就走 npm）：

```
plugin_manager install_bundle target=github:chow651/dsh-hackertube
```

装完在「插件」列表里启用 `dsh-hackertube`，刷新页面即可看到入口图标。首次打开会从 hackertube.org 拉一次数据（约 8 MB，之后走本地缓存，24 小时过期）。

## 运行前提与降级

插件只依赖 DSH 提供的 `webServer` 与（可选的）模型服务，不依赖任何 npm 包。

| 能力 | 需要 | 缺失时 |
|---|---|---|
| 列表、分类、搜索、播放 | `webServer` + 网络 | 面板不可用 / 播放器不可用 |
| 中文标题、分类名 | 无（随仓库附带） | — |
| AI 问答、标题增量翻译 | DSH 的模型服务 | 面板顶部提示「模型不可用」，其余功能正常 |
| 评论机翻 | 外网（Google 网页翻译公共端点） | 按钮报错，保留原文 |
| 字幕、备用直链播放 | `yt-dlp`、`ffmpeg` 在 PATH 里 | 只用 YouTube 播放器，AI 缺少字幕上下文 |

`yt-dlp` 与 `ffmpeg` 只影响两面：AI 问答时能否带上字幕、YouTube 嵌入被拒时能否回退到直链流。二者都不装也能正常看视频。

## 数据与缓存

全部落在 `$DSH_PROFILE_DIR/.dsh-hackertube/`（默认 `~/.dsh/.dsh-hackertube/`），删掉即恢复出厂：

```
list.json            列表缓存（24 小时）
browse.json          分类树
i18n/zh-titles.json  标题译文（首次由 data/ 铺入）
i18n/zh.json         详情页摘要/推荐理由/引用的译文
i18n/zh-comments.json  评论机翻缓存
prefs.json           喜欢 / 稍后看 / 历史
subs/                字幕缓存
```

仓库里的 `data/` 是预生成的译文打底数据，只在缓存缺失时拷进缓存目录，不会覆盖用户已有的翻译。

## 已知边界

- 标题译文由模型生成后人工规则校过（分隔符、结构、术语），仍有约 1000 条语序偏直译，可以重新跑 `/titles/retranslate` 修补
- 评论机翻走 Google 网页翻译的公共端点，用的是 Chrome 内置翻译的公开 key，可能随时失效或限流；失效时会自动退到 `translate_a` 单条接口
- 中文查询的机翻扩展是一次查询一次请求（300ms 防抖 + 内存缓存），离线时只保留本地匹配
- YouTube 嵌入受上游策略影响，个别视频（年龄限制、地区限制）只能在 YouTube 上看
- 播放器中转页跑在 `127.0.0.1:18090`，被占用时自动顺延到 18091/18092/18093

## 开发

```
node test/host-smoke.mjs      # Host 半：路由、缓存、翻译播种，33 项
node test/client-render.mjs   # Client 渲染：41 项，需要 react-test-renderer
```

```
npm install   # 只装测试用的 react / react-test-renderer
npm test
```

改代码后重载（不要重启 DSH）：

```
plugin_manager set_bundle enabled=false target=dsh-hackertube
plugin_manager set_bundle enabled=true  target=dsh-hackertube
```

Host 半改动重载即生效，Client 半需要刷新浏览器页面。

`prototype/`## 致谢

视频数据与推荐理由来自 [hackertube.org](https://hackertube.org)；讨论内容来自 [Hacker News](https://news.ycombinator.com)。本项目只是把这些公开数据搬进 DSH 面板。

## 许可

MIT
