# Spec: HackerTube P0 UX Foundation

## Problem Statement

用户打开 HackerTube 时，经常先看到长时间的无文案骨架屏；搜索 `raft` 会命中 `craft`、`Minecraft` 和 `Kraftwerk`，真正讲 Raft 的视频被埋在后面；YouTube 嵌入被拒绝时播放器只显示「前往平台观看」，插件没有任何解释或兜底；打开相关视频后页面停在旧滚动位置，返回列表又丢失原来的浏览位置；AI 对话在切换视频后继续复用上一条视频的消息，暂停超过 15 秒再问「这段在讲什么」会退回到视频开头；中文用户第一次打开默认是英文界面，详情页的中文翻译还会阻塞整个详情请求。

这些问题的共同点是：数据、播放和 AI 能力都已经存在，但用户看不到状态、找不准内容、接不住上下文。插件现在更像一个视频墙，还没有成为用户和 Agent 都能依赖的技术内容库。

## Solution

把 P0 收敛为一条完整的用户体验基础链路：

- 首屏先从本地官方导出或旧缓存渲染视频库，远端元信息在后台补齐；缓存过期也先展示旧快照。
- 面板搜索和 `hackertube_search` 共用 Host 端有序检索：词边界、中文查询扩展、字段权重、摘要与 HN 推荐理由参与排序。
- 播放器能够识别 YouTube 嵌入错误，显示可理解的错误和「在 YouTube 打开」，并在用户主动选择时尝试本地直链兜底。
- 观看会话按视频隔离：滚动位置、播放位置、AI 消息和语言状态不会被下一条视频继承；相关视频打开从顶部开始，返回列表恢复原位置。
- AI 使用当前播放位置附近的字幕上下文，按视频保存对话；字幕不可用时明确说明回答只基于简介，不假装读过字幕。
- 默认语言读取宿主或浏览器语言并持久化；详情翻译改为后台完成，页面先显示原文。
- 移除详情页的分享卡片入口，降低观看页的失败面和维护成本。

推荐画像作为 P1：用用户喜欢过的视频、现有向量和共推荐关系生成首页推荐；不引入协同过滤框架。局部画面、Whisper 转写和健康面板不在本轮范围。

## User Stories

1. As a Chinese-speaking user, I want the panel to open in Chinese by default, so that I do not have to switch language every time.
2. As a Chinese-speaking user, I want my language choice to persist after a page refresh, so that the panel respects my preference.
3. As a user opening the panel for the first time, I want to see video cards as soon as the local export is ready, so that I do not stare at a blank skeleton while upstream pages load.
4. As a user with a stale local cache and no network, I want to see the cached video library instead of an error, so that I can still browse previously loaded content.
5. As a user waiting for metadata, I want to see what stage the plugin is in and how many items are being enriched, so that I know the plugin is working.
6. As a user searching for `raft`, I want the Raft lectures to rank above unrelated `craft` or `Minecraft` videos, so that search results match my intent.
7. As a user searching in Chinese, I want queries such as `编译器优化` to match English tags and summaries, so that the Chinese interface is not limited to literal Chinese title matches.
8. As a user searching the library, I want results ranked by title, channel, tags, categories, summary and HN recommendation reasons, so that the most relevant videos come first.
9. As a user browsing search results, I want to see which field matched and a short snippet, so that I can judge a result without opening every video.
10. As an Agent, I want `hackertube_search` to use the same ranked retrieval as the panel, so that my answers and the user's manual search agree.
11. As a user whose YouTube embed is blocked, I want a clear error message with an explanation, so that I do not think the plugin is broken.
12. As a user whose YouTube embed is blocked, I want a button to open the video on YouTube, so that I have a guaranteed path to watch it.
13. As a user with yt-dlp and ffmpeg installed, I want an optional direct-stream fallback, so that I can still watch when embedding is rejected.
14. As a user without yt-dlp or ffmpeg, I want a precise dependency hint instead of a silent black player, so that I know what to install.
15. As a user opening a related video, I want the new watch page to start at the top, so that I see the player and title rather than landing in the comments.
16. As a user returning from a video to the list, I want the list to restore my previous scroll position and filters, so that I do not lose my place.
17. As a user sharing or reloading a video, I want a stable link to that video, so that I can return to the same watch page.
18. As a user pressing Escape on a watch page, I want to return to the previous view, so that keyboard navigation stays predictable.
19. As a user asking a follow-up question in the AI pane, I want the model to receive the previous messages in that watch session, so that pronouns and follow-ups work.
20. As a user switching to another video, I want the AI chat to reset for the new video, so that old context does not leak into the new answer.
21. As a user pausing a video for a minute, I want the AI question to still use the last known playhead, so that "this part" refers to what I was watching.
22. As a user asking about a video with subtitles, I want the AI to receive the subtitle lines around my playhead with timestamps, so that the answer is grounded in the actual content.
23. As a user asking about a video without subtitles, I want the AI pane to say that the answer is based only on the description, so that I do not trust a hallucinated transcript.
24. As a user waiting for subtitle retrieval, I want a visible stage and a bounded timeout, so that the AI pane does not look frozen for two minutes.
25. As a user with a configured `cookies.txt`, I want the subtitle pipeline to use it, so that YouTube rate limits do not block every question.
26. As a user without cookies, I want a clear hint and the expected path, so that I can enable subtitles without reading source code.
27. As a user opening a Chinese detail page for the first time, I want the original detail to appear immediately, so that I can start reading while translation runs.
28. As a user reading a translated detail page, I want to know whether the text came from the model or machine translation, so that I can judge its quality.
29. As a user, I want the share-card button removed from the watch page, so that the action row only contains actions that work reliably.
30. As a user who likes videos, I want the home page to recommend content related to my likes, so that repeat visits feel personalized.
31. As a user with no likes yet, I want curated playlists and high-signal HN videos on the home page, so that the first visit is not an endless wall of thumbnails.
32. As a user, I want a clear explanation for each recommendation, so that I understand why a video is shown.
33. As a user, I want to mark a recommendation as not interested, so that the home feed can improve.
34. As a user browsing a narrow panel, I want the related/AI rail to remain reachable without scrolling past all comments, so that I can act on the current video.
35. As a user who opens the panel again after closing it, I want my last view, video and position restored where practical, so that the plugin behaves like a library rather than a reset-on-open widget.
36. As a user, I want empty, loading and error states to be visually distinct, so that I never mistake a failed request for an empty result.
37. As a user, I want comments and HN recommendation reasons to show their full context and stance labels in Chinese, so that the HN data is actually usable.
38. As a developer, I want the existing public route and component seams tested, so that these UX changes are protected against regressions.

## Implementation Decisions

- The video list is loaded from the local official export and cache first; upstream metadata enrichment runs in the background and merges into the same list without blocking first paint. Expired cache is served immediately with a stale marker while revalidation runs.
- Retrieval lives on the Host side behind one public search operation. The panel and the Agent tool both call it; the panel no longer maintains a separate client-side scoring implementation.
- Search scoring considers title, Chinese title, channel, tags, category names, summary, HN recommendation reason and HN score. Latin terms use word-boundary matching; Chinese queries are expanded through the existing machine-translation path and matched against both Chinese and English fields.
- Search returns ranked results with matched-field metadata and a short snippet. Filters and sort order are parameters of the same operation.
- The media relay reports a structured playback error to the parent frame. The watch page renders an error state with a YouTube link and an optional direct-stream fallback; it never silently displays a black player.
- The watch page has a route-like state for the current video, with browser back/Escape behavior and deep-link restoration. List scroll position and filters live outside the watch component so returning restores them.
- Each watch session owns its playhead, messages and subtitle window keyed by video id. AI requests send the session message history; switching videos starts a new session.
- Subtitle retrieval uses YouTube automatic captions and auto-translated tracks through the existing yt-dlp path, with the existing machine-translation cache for display. Subtitle failures are cached for a short time, and AI answers label whether subtitles were available.
- Detail translation returns the original detail immediately and fills translated fields asynchronously. A provenance flag distinguishes model translation from machine translation.
- The share-card action is removed from the watch page. Its implementation is left for a later cleanup change.
- The home recommendation path builds a taste profile from liked videos using the existing embeddings and co-recommendation graph, with playlists and HN score as cold-start sources. It does not add a Python service or a collaborative-filtering framework.
- No health panel is added in this spec. Existing diagnostic endpoints remain available but are not exposed as a new settings surface.

## Testing Decisions

- Tests assert external behavior: a user sees cards before upstream metadata finishes; a `raft` query returns Raft videos before `craft` videos; a blocked embed produces a visible error and optional fallback; changing video resets the watch session; an AI request includes the previous messages and the last playhead.
- Host-side tests use the registered route handler as the seam. Existing `test/host-smoke.mjs` remains the prior art; new search and cache scenarios extend that style with fixture data rather than live upstream responses.
- Client-side tests use the rendered React component with mocked fetch as the seam. Existing `test/client-render.mjs` remains the prior art; new tests assert visible text and interaction outcomes, not internal state.
- Browser verification covers scroll restoration, narrow-layout rail ordering, player error overlay and AI pane reset; it is a manual or scripted end-to-end check, not a unit test.
- The full test suite runs once on the integration branch after all tickets merge.

## Out of Scope

- A full health/settings panel.
- Whisper transcription or any local speech-to-text.
- Automatic frame extraction for every AI question; optional local frames are a later ticket.
- Share-card generation and redesign.
- A dedicated narrow-screen redesign beyond keeping the rail reachable in the watch layout.
- GitHub issue publication or external tracker integration.

## Further Notes

The project already has two independent search paths and a rich set of diagnostic endpoints; most of this work is connecting existing capabilities into one user-visible path rather than building new infrastructure. The central risk is merge conflict between Host and Client changes, so ticket branches must be based on `integration/ht-ux` and merged in dependency order.
