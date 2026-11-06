# 06: 基于 like 的首页推荐画像（P1）

**What to build:** 用 likes、现有 `embeddings.npy` 和 `related.jsonl` 生成轻量内容画像，首页出现「因为你喜欢…」的推荐；没有 like 时用 playlists 和 HN score 冷启动；支持「不感兴趣」反馈。不引入开源协同过滤框架或额外 Python 服务。

**Blocked by:** 01 - 首屏从本地视频库先渲染

**Status:** ready-for-agent

- [ ] 至少一个 like 时，相关视频出现在前排，并排除已看过项
- [ ] 前排混入半相关与无关内容，同一频道或主题不连片
- [ ] 没有 like 时冷启动把播放列表与 HN 高分混排
- [ ] 「换一批」改变前排顺序，同一 seed 顺序稳定
- [ ] 不新增 Python 运行时或外部推荐服务
