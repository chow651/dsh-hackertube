# 07: 会话右侧栏承载 HackerTube 页面

**What to build:** 在 DSH 原生右侧栏注册 HackerTube 的 tab 类型、引导页入口与页面主体，用户在会话页从右栏打开 HackerTube，在栏内浏览、检索、播放视频。复用现有 `HtRoot`，新增 rail 模式：不读写页面 hash，观看状态留在栏内；窄容器下收紧间距并保持单列。只使用原生 `sidebarRightTabs` 与 `sidebar.right.pane.tab`，不依赖 `dsh-better-sidebar` 的 `ctx.betterSidebar`，tab id 使用插件自有命名空间 `dsh-hackertube:right`。

**Blocked by:** 无

**Status:** done

- [x] 会话页右栏引导页出现 HackerTube 入口，点击后在栏内打开
- [x] 右栏宽度 320–480px 下首页单列，观看页可播放
- [x] 右栏内打开视频不改写主页面地址 hash，主区深链行为不变
- [x] 未安装 `dsh-better-sidebar` 时可用；安装后两者 tab 并存不冲突
- [x] 主区面板（`sidebar.panellist` + `main`）行为不变，`npm test` 全绿
