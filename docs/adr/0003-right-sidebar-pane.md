# 会话右栏使用原生 sidebarRightTabs，不接 better-sidebar 服务

会话页需要在不离开对话的情况下看视频。DSH 原生右侧栏由宿主 `ui-sidebar-right` 拥有，插件只能注册 tab 类型与页面主体；`dsh-better-sidebar` 也是往同一个座位投 tab，并不接管右栏。

采用原生 `ctx.sidebarRightTabs.register()` + `sidebar.right.pane.tab` 席位注册一个 `kind: hackertube` 的 tab，id 固定为 `dsh-hackertube:right`。页面主体复用 `HtRoot`，用 `embedded` 模式跳过页面 hash 的读写，观看状态留在栏内。

被否决的方案：

- 通过 `ctx.betterSidebar.registerTab()` 注册。这会把 HackerTube 的可用性绑在第三方插件上，未安装 better-sidebar 的环境直接没有入口；而且 better-sidebar 的服务可以由它自己替换，原生座位反而更稳定。
- 另写一套右栏专用 UI。列表、检索、播放器、AI 会话都已有实现，复制一份会让两处行为分叉。
- 在右栏复用主区 hash 深链。右栏改 `location.hash` 会同时改变主会话页面的地址，Esc/返回行为互相干扰。

已知代价：右栏宽度通常 320–480px，视频区较小；这是栏内观看的固有限制，不通过压缩内容规避，靠容器查询把间距和列宽收紧。tab 内不做地址路由，因此右栏内换片不产生可分享链接；需要固定链接时仍走主区面板的 `#ht-watch=<vid>`。

状态：accepted
