# 06: 基于 like 的首页推荐画像（P1）

**What to build:** 用 likes、现有 `embeddings.npy` 和 `related.jsonl` 生成轻量内容画像，首页出现「因为你喜欢…」的推荐；没有 like 时用 playlists 和 HN score 冷启动；支持「不感兴趣」反馈。不引入开源协同过滤框架或额外 Python 服务。

**Blocked by:** 01 - 首屏从本地视频库先渲染

**Status:** ready-for-agent

- [ ] 至少一个 like 时，推荐结果与已喜欢视频相关，并排除已看过项
- [ ] 没有 like 时首页仍有可解释的编辑推荐
- [ ] 反馈后推荐顺序变化，并显示推荐理由
- [ ] 不新增 Python 运行时或外部推荐服务
