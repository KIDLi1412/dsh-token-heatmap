# dsh-token-heatmap

DSH Web GUI 插件：在**新会话（hero）屏幕的输入框下方**显示一个 GitHub 风格的 token 用量热力图 —— 可在**年视图（当前自然年 1月–12月）**与**月视图（单月日历，逐日数值）**之间切换，颜色深浅表示用量多少；同一行展示**今日 / 本月 / 累计** token 用量。

A DeepSeek Harness web plugin: a GitHub-style daily token-usage heatmap rendered **below the composer input card on the new-session screen only**, switchable between a **calendar-year grid (Jan–Dec)** and a **single-month calendar with per-day numbers**, with today / this-month / all-time totals on the same line.

## 界面 / What you get

新会话屏幕输入框正下方出现一张统计卡（**只在新会话显示**；已对话的会话不显示）：

![新会话页面上的月视图](docs/预览-新版会话页.jpg)

### 月视图 / Month view

![月视图](docs/月视图.jpg)

单月日历：7 列（周一起，表头一~日）× 5–6 行，每格显示**日号 + 当日 token 数**（如 `4 44m`），底色沿用同一套绝对阈值配色，一眼看出这个月哪几天在烧 token；周末列有浅色底以便区分。标题行的 `‹ 2026年9月 ›` 按**月**步进（最新到本月，最早到有数据的第一天）。

### 年视图 / Year view

![年视图](docs/年视图.jpg)

GitHub 风格自然年热力图：覆盖所选自然年 1月–12月（`‹ 2026 ›` 按**年**步进，最多到当前年），列为周（周一起），行为星期（左侧标注一~日全部 7 天）；顶部月份标签按列跨度标注（左侧与格线对齐），今日之后的日期显示为空格。

### 共同特性 / Shared

- 🔀 **年 / 月切换**：标题行右侧的分段按钮即时切换视图；默认视图可在 设置 → 插件 → 插件配置 里选（见下）。
- 🎨 **六套配色**：绿色（经典 GitHub 风格）、蓝色、橙色、红色、紫色、青色，可在 设置 → 插件 → 插件配置 切换；颜色按**绝对阈值**分档（按天 token 数，非相对排名）：0 / <1M / 1M–10M / 10M–100M / ≥100M 共 5 级，卡片右下角图例悬停显示各档范围；61M/天 显示为第 3 级。悬停任意格子（年视图的 10px 格子或月视图的日期格）显示日期与精确 token 数。
- 🔢 **统计行**（与标题同一行）：今日 / 本月 / 累计，悬停显示完整数值；本月/累计与当前视图无关，始终是实时值。
- 🔄 自动每 5 分钟刷新，窗口重新可见时也会刷新；行尾可手动刷新。
- ⚙️ **插件配置卡**（设置 → 插件 → 插件配置，随官方"插件配置"页签渲染）：
  - **显示热力图** 开关：关闭后新会话页面不再显示热力图卡片。
  - **配色方案**：绿色 / 蓝色 / 橙色 / 红色 / 紫色 / 青色，六个色板按钮即时预览。
  - **默认视图**：年 / 月，决定新会话页面首次打开时显示哪个视图（之后手动切换只影响当前页面）。
  - 修改后需点"保存"（显示"未保存"徽标提示），"放弃修改"可丢弃草稿；配置经 `token-heatmap` settings namespace 持久化到 `<DSH_HOME>/settings.yaml`（0.1.1 及更早版本存在 `<DSH_HOME>/storages/token-heatmap-config.json` 的旧配置会在启动时自动迁移）。

## 安装 / Install

需要 `web` profile 与 `pnpm`。DSH 兼容版本见下方「兼容性 / Compatibility」；运行于 `@deepseek-ai/dsh >= 0.1.2-alpha.4`（0.1.2 版本线）。

从 npm 安装：

```powershell
dsh plugin --profile web add @kidli1412/dsh-token-heatmap
```

从 GitHub 安装：

```powershell
dsh plugin --profile web add github:KIDLi1412/dsh-token-heatmap
```

本地开发（手动，本地链接）：

```powershell
dsh plugin --profile web add "link:path/to/dsh-token-heatmap"
```

安装完成后**重启正在运行的 `dsh web`**，并在浏览器中硬刷新（Ctrl+Shift+R）。侧边栏无新增入口——统计卡直接出现在新会话输入框下方。卸载：

```powershell
dsh plugin --profile web remove @kidli1412/dsh-token-heatmap
```

## 工作原理 / How it works

- **服务端**（`lib/index.js` + `lib/usage.js` + `lib/config.js`）：作为 profile bundle 挂载，**实时折叠会话事件**（监听官方 `session/event`，每个 `assistant/chunk`/`assistant/message` 的 `usage` 事件即时写入缓存，不依赖 hero 屏挂载）；启动时一次性补折叠已存在的 live 会话（如 resumed 会话）；请求时 `collectUsage` 再做一次增量同步兜底，并枚举 **已归档（stored）会话**补齐历史——两种 `sessionPersistence` 接口都支持：0.1.2 线的 `listSnapshots()` + `readFrom()`，以及 0.1.3 起取代它们的 `list()` + `open()`/`handle.read()`。同 `(turn, step)` 的重复样本按"替换"语义处理，归属后一天；按天、按模型聚合，缓存到 `<DSH_HOME>/storages/token-heatmap-cache.json`。通过回环受限端点 `GET /api/token-heatmap/usage` 提供；显示配置（开关 + 配色 + 默认视图）由插件注册的 `token-heatmap` settings namespace 持有（settings.yaml），`GET/POST /api/token-heatmap/config` 作为回环兼容 API 读写同一 namespace，0.1.1 及更早的 `token-heatmap-config.json` 文档在启动时一次性迁移。
- **客户端**（`lib/client.js`）：手写 `__ModuleLoader__` bundle，注册进会话 `conversation.input.dock` 列表插槽，仅当 `session.composerPhase === "blank"`（新会话 hero 屏）且配置开关开启时渲染。框架真正的"卡片下方"插槽 `conversation.composer.dock` 在 hero 屏被 `!hero` 门控禁用，因此本插件利用 `input.dock` 容器（flex 列）的 CSS `order` 把自己排到输入卡片**之后**。同一份数据由 `buildGrid()`（年，53 列 × 7 行）与 `buildMonthGrid()`（月，7 列 × 5–6 行，带日号）两个纯函数分别铺格，共用 `levelOf()` 的绝对阈值分档与 `palette` 配色；`‹ ›` 按钮按当前视图步进年或月，边界取"当前年/月"与"数据里最早的月"。配置卡注册进官方 `settings.plugin.item` 插槽（设置 → 插件 → 插件配置页签），经 settings scope 读写 `token-heatmap` namespace（该 namespace 由本插件在服务端注册，官方页签只渲染"Host 实际 serve 的 namespace ∩ 已注册 key"的卡片）。
- 语义与 `dsh-token-meter` 的 `tokenUsage` 投影一致（参考插件 [dsh-usage-stats](https://github.com/Ychris12138/dsh-usage-stats)，MIT）。

## 说明 / Notes

- 仅回环地址可访问数据端点，凭据不外发；插件只读，不修改任何会话数据。
- 无会话/无工作区时（`input.dock` 需要会话上下文）统计卡不渲染。
- 服务端与客户端都随 `dsh web` 启动加载，因此新增/更新插件后需要重启。

## 兼容性 / Compatibility

- **DSH**：manifest 通过 `dsh.compatibility.dshReleases` 将官方最新三个版本 `0.1.2-alpha.4`、`0.1.2-alpha.5`、`0.1.2-rc.1` 逐项声明为 `compatible`（DSH STORE 的精确逐版本兼容证据；仅范围声明不会恢复上架）。插件使用的客户端注入（`dsh-api-remotes` / `dsh-client-connection` / `dsh-client-locale` / `dsh-client-ui-conversation` / `dsh-client-ui-settings`）与 Host 服务（`settings` namespace、`webServer` 精确路由）在这条版本线上保持稳定。
- **Node**：`^22.19.0 || >=24.0.0`（与 DSH 一致）。
- **宿主要求（dsh-market 显示）**：`engines.dsh: ^0.1.2-rc.1`，并将运行时依赖的 lockstep 宿主包声明为 `peerDependencies`（`dsh-host-webserver` / `dsh-session` / `dsh-session-persistence` / `dsh-settings` 与客户端模块 `dsh-api-remotes` / `dsh-client-connection` / `dsh-client-locale` / `dsh-client-ui-conversation` / `dsh-client-ui-settings`，均为 `^0.1.2-rc.1`）；插件市场会据此显示"宿主要求"并判断与当前 DSH 是否匹配。
- **依赖**：`@deepseek-ai/dsh-settings` 自 0.1.3 起提升为 `^0.1.2-rc.1`、`@deepseek-ai/schemastery` 提升为 `^3.18.2`，与 DSH 0.1.2 版本线对齐。npm 的 prerelease 解析规则下 `^0.1.0-rc.7` 不会解析到 `0.1.2-rc.1`（只会装 `0.1.0-rc.8`），因此较低的范围会拉到与新版 DSH 不同 train 的 settings 副本。
- **0.1.4（DSH 0.1.2 适配）**：rc.1 起 live session 不再携带 `.events` 数组（改用 `session.seq` + `session.eventAt(seq)`，与官方 `dsh-token-meter` 相同），新会话判断从 `composerPhase === "blank"` 改为布尔 `session.blank`；`sessionPersistence` 的 stored 会话枚举在 0.1.3-alpha.2 被替换（`listSnapshots`/`readFrom` → `list()` + `open()`/`handle.read()`），两条接口见 0.1.6 条目。客户端注入模块列表同步为新架构模块（见上）。
- **0.1.6（session/event 实时折叠 + stored 会话枚举修复）**：`apply()` 注册官方 `session/event` 监听器，每个 usage 事件即时折叠进缓存，解决 live 会话仅在 hero 屏挂载时才折叠而漏计同一日其他会话用量的问题（表现为当日总量偏小、历史天数丢失）；启动时一次性补折叠已存在的 live 会话（如 resumed 会话）。**stored 会话枚举修复**：0.1.3-alpha.2 起 `sessionPersistence` 移除了 `readFrom()` 与 `listSnapshots()`，只保留 `list()` + `open()`/`handle.read()`；旧实现只探测 `list`/`listSnapshots` 却无条件调用 `readFrom`，导致每个 stored 会话抛错并被吞成一条 warn —— 表现为热力图只剩进程内 live 的几天。现在两条接口都支持（`list()` 的 `revision` 同样用于跳过未变更的日志，增量仍按 `seq` 去重与连续性校验），stored 会话可完整补齐历史；两者都不可用时不再误判为"日志被截断"，而是保留已折叠天数并告警。token 口径与 `dsh-token-meter` 一致（input + output + cacheRead + cacheWrite，不含 reasoningTokens）。
- **0.2.0（月视图 + 默认视图设置）**：新增 `buildMonthGrid()` 月视图（周一起、5–6 行、日号 + 当日 token 数）与 年/月 分段切换，`‹ ›` 按当前视图步进年或月；settings namespace 新增 `defaultView`（`"year" | "month"`）字段——与 `colorScheme` 的"只约束 shape"不同，**`defaultView` 是枚举校验**（未知视图没有可回退的渲染器），旧 Host 上该字段会被 schema 丢弃、旧客户端读到未知值时回退为"年"。0.1.x 的 `settings.yaml` 无需迁移（缺字段即取默认 `year`）。

## License

MIT。聚合与回环端点实现参考了 [dsh-usage-stats](https://github.com/Ychris12138/dsh-usage-stats)（MIT © Ychris12138）。
