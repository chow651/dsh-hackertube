# HackerTube for DeepSeek Harness

简体中文 | [English](README.en.md)

在 DSH 面板内浏览并播放 Hacker News 二十年间反复推荐的技术视频，无需切换到浏览器。触手可及的高质量英文视频信源，让你的 DeepSeek Harness 变得更丰富有趣。

![首页](docs/home.png)

数据集来自 Andrej Karpathy 的 [HackerTube](https://karpathy.bearblog.dev/hacker-tube/)。站点提供完整的数据导出，作者在博客中说明其用途：

> Export of the site's data available to give to your agent to easily create your own version.

本插件使用的正是这份官方导出。非官方项目，与 Andrej Karpathy、Hacker News、YouTube 均无隶属关系。

原站同样可以直接访问。将其并入面板带来两点差异：一是省去窗口切换，二是提供完整的中文支持，包括标题、分类、摘要与评论。

## 安装

需要已安装 DeepSeek Harness 本体。

```
plugin_manager install_bundle target=dsh-hackertube
```

包已发布到 npm，版本 0.1.1。也可以直接从 Git 仓库安装，宿主如何解析安装参数取决于版本。

```
plugin_manager install_bundle target=github:chow651/dsh-hackertube
```

安装后在插件列表中启用 `dsh-hackertube` 并刷新页面。无需额外配置，无需 API key，也不需要在安装前预取任何数据。

## 功能

![详情页](docs/watch.png)

收录 6454 个视频，分属 16 个大类与 150 个二级分类，按 HN 推荐力度排序。首页首次加载 60 条，滚动时分批追加。

详情页包含播放器、该视频在 HN 上的讨论，以及右侧的相关推荐。右侧另有 AI 问答页，会把当前播放位置前后三分钟的字幕片段一并交给模型，因此可以询问某一段的具体内容。

搜索支持中英文混用，中文查询会同时匹配中文标题与英文标签。

喜欢、稍后看与播放历史记录在宿主侧，清除浏览器数据不会丢失。

### 快捷键

| 按键 | 作用 |
|---|---|
| `/` | 聚焦搜索框 |
| `j` `k` | 在卡片间上下移动 |
| `Enter` | 打开当前卡片 |
| `l` | 标记喜欢 |
| `w` | 加入稍后看 |
| `h` | 返回首页 |
| `?` | 显示快捷键一览 |
| `Esc` | 关闭浮层 |

## 首次启动

插件加载时即开始下载官方数据导出（17.8 MB，一次性），并同时请求上游接口补齐 YouTube 的时长、播放量与发布时间。两者完成后列表才是完整状态，期间界面显示骨架屏。

| 项目 | 实测耗时 |
|---|---|
| 首次安装（空缓存） | 约 10 秒 |
| 后续启动，列表加载 | 45 毫秒 |
| 打开详情页 | 10 毫秒 |
| 相关推荐，有共推荐关系的 3778 个视频 | 2 毫秒 |
| 相关推荐，其余 2676 个视频（向量近邻） | 首次约 0.7 秒 |
| 摘要与推荐理由机翻 | 首次 0.4 至 1.8 秒 |

数据导出有效期为七天，YouTube 元信息缓存二十四小时。

## 中文支持

界面文案统一通过 `tx(lang, 中文, English)` 输出，两种语言下均不会出现中英混排。数量单位随语言切换，中文使用万与亿，英文使用 K 与 M。

内容层面的中文来源如下。

| 内容 | 来源 | 生效时机 |
|---|---|---|
| 6454 条视频标题 | 随仓库附带的译文表 | 安装后立即生效 |
| 166 条分类名称 | 随仓库附带 | 安装后立即生效 |
| 摘要、推荐理由、评论引用 | 打开时自动翻译 | 优先使用模型，模型不可用时使用机翻 |
| HN 评论正文 | 逐条翻译或整段翻译 | 首次约 1 秒，之后读取缓存 |

模型译文与机翻译文分别存放。配置模型后，模型译文会覆盖机翻结果，不会因机翻先行而无法更新。

机翻调用 Google 网页翻译的公共端点。评论正文默认保持英文原文，翻译为显式操作。

## 依赖与降级

| 能力 | 依赖 | 缺失时的表现 |
|---|---|---|
| 列表、分类、搜索、播放 | DSH 的 webServer 与外网 | 面板不可用或播放器无法加载 |
| 中文标题与分类名 | 无 | 已随仓库提供 |
| 摘要等三段文本的中文 | 模型或外网 | 显示英文原文 |
| AI 问答 | DSH 已配置模型 | 面板提示模型不可用，其余功能正常 |
| 评论翻译 | 外网 | 按钮无响应，文本保持原文 |
| 字幕与直链兜底播放 | PATH 中存在 yt-dlp 与 ffmpeg | 视频仍可播放，AI 缺少字幕上下文 |

yt-dlp 与 ffmpeg 均为可选。它们只影响两件事：AI 问答能否携带字幕上下文，以及 YouTube 嵌入被拒绝时能否回退到直链播放。

## 数据来源

`https://hackertube.org/download/hackertube-data.zip`，17.8 MB，导出于 2026 年 10 月 31 日。

```
videos.jsonl       6454 条视频，含标题、频道、摘要、推荐理由、标签、分类、HN 统计
mentions.jsonl    39834 条 HN 评论，含作者、月份、立场、原文
related.jsonl      3778 条共推荐关系
embeddings.npy     6454 × 384 维 float16 向量，用于补齐无共推荐关系的视频
embedding_ids.json 向量行号与视频 id 的对应
taxonomy.json      150 个分类，16 个大类
```

解压使用 Node 内置的 zlib，插件不引入任何 npm 运行时依赖。

导出不包含时长、播放量、发布时间与封面，这些字段属于 YouTube 元数据，因此列表仍会并行请求 65 页上游接口补齐，结果缓存一天。

## 缓存目录

全部位于 `$DSH_PROFILE_DIR/.dsh-hackertube/`，默认路径为 `~/.dsh/.dsh-hackertube/`。删除整个目录可恢复到初始状态。

```
export/               解包后的官方数据，约 48 MB
i18n/zh-titles.json   标题译文
i18n/zh-taxonomy.json 分类译文
i18n/zh.json          模型翻译的详情文本
i18n/zh-mt.json       机翻的详情文本
i18n/zh-comments.json 评论机翻缓存
list.json             YouTube 元信息与列表快照
prefs.json            喜欢、稍后看、历史
subs/                 字幕
```

## 已知限制

标题译文由模型生成后按规则校对，多数通顺，仍有约一千条偏向直译。

中文查询需要先机翻为英文才能命中英文标签，每次查询发起一次请求，含 300 毫秒防抖与内存缓存。断网时仅保留本地匹配。

YouTube 嵌入受上游策略限制，年龄限制或地区限制的视频需前往 YouTube 观看。

播放中转页监听 `127.0.0.1:18090`，端口被占用时依次尝试 18091 与 18092。

## 致谢

感谢 Andrej Karpathy 开发 HackerTube 并将数据导出公开，本插件建立在这份工作之上。

讨论内容来自 [Hacker News](https://news.ycombinator.com)，视频托管于 YouTube。

## 许可

MIT
