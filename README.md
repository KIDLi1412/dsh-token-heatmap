# dsh-token-heatmap

DSH Web GUI 插件：在**新会话（hero）屏幕的输入框下方**显示一个 GitHub 风格的 token 用量热力图 —— **当前自然年（1月–12月）**每天的 token 用量，颜色深浅表示用量多少；同一行展示**今日 / 本月 / 累计** token 用量。

A DeepSeek Harness web plugin: a GitHub-style daily token-usage heatmap of the **current calendar year (Jan–Dec)** rendered **below the composer input card on the new-session screen only**, with today / this-month / all-time totals on the same line.

## 界面 / What you get

新会话屏幕输入框正下方出现一张统计卡（**只在新会话显示**；已对话的会话不显示）：

![热力图](docs/热力图.jpg)

- 📊 **自然年热力图**：GitHub 风格，覆盖所选自然年 1月–12月（可切换年份，`‹ 年份 ›` 选择器在统计行右侧，最多到当前年），列为周（周一起），行为星期（左侧标注一~日全部 7 天）；顶部月份标签按列跨度标注（左侧与格线对齐），今日之后的日期显示为空格。
- 🎨 **六套配色**：绿色（经典 GitHub 风格）、蓝色、橙色、红色、紫色、青色，可在 设置 → 插件 → 插件配置 切换；颜色按**绝对阈值**分档（按天 token 数，非相对排名）：0 / <1M / 1M–10M / 10M–100M / ≥100M 共 5 级，图例悬停显示各档范围；61M/天 显示为第 3 级。悬停任意格子显示日期与精确 token 数。
- 🔢 **统计行**（与标题同一行）：今日 / 本月 / 累计，悬停显示完整数值。
- 🔄 自动每 5 分钟刷新，窗口重新可见时也会刷新；行尾可手动刷新。
- ⚙️ **插件配置卡**（设置 → 插件 → 插件配置，随官方"插件配置"页签渲染）：
  - **显示热力图** 开关：关闭后新会话页面不再显示热力图卡片。
  - **配色方案**：绿色 / 蓝色 / 橙色 / 红色 / 紫色 / 青色，六个色板按钮即时预览。
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

- **服务端**（`lib/index.js` + `lib/usage.js` + `lib/config.js`）：作为 profile bundle 挂载，**实时折叠会话事件**（监听官方 `session/event`，每个 `assistant/chunk`/`assistant/message` 的 `usage` 事件即时写入缓存，不依赖 hero 屏挂载，绕过 rc.1 `sessionPersistence` 不再提供会话枚举的限制）；启动时一次性补折叠已存在的 live 会话（如 resumed 会话）；请求时 `collectUsage` 再做一次增量同步兜底。可选增强：若存在第三方插件 `@linxin666/dsh-usage` 的台账 `<DSH_HOME>/dsh-usage/usage-ledger.json`（设置 → 使用统计 的数据源，完整实时），则直接采用以恢复完整历史——该文件是第三方插件内部文件而非 DSH 契约，仅检查 `days` 形状（不校验 version），格式不符时告警并回退。该文件仅在 @linxin666/dsh-usage 安装并启用时存在；其按 retainDays（默认 180、最大 730）修剪旧天数，故以台账为源时 all-time 总量与旧日历年受该设置上限。同 `(turn, step)` 的重复样本按"替换"语义处理，归属后一天；按天、按模型聚合，缓存到 `<DSH_HOME>/storages/token-heatmap-cache.json`。通过回环受限端点 `GET /api/token-heatmap/usage` 提供；显示配置（开关 + 配色）由插件注册的 `token-heatmap` settings namespace 持有（settings.yaml），`GET/POST /api/token-heatmap/config` 作为回环兼容 API 读写同一 namespace，0.1.1 及更早的 `token-heatmap-config.json` 文档在启动时一次性迁移。
- **客户端**（`lib/client.js`）：手写 `__ModuleLoader__` bundle，注册进会话 `conversation.input.dock` 列表插槽，仅当 `session.composerPhase === "blank"`（新会话 hero 屏）且配置开关开启时渲染。框架真正的"卡片下方"插槽 `conversation.composer.dock` 在 hero 屏被 `!hero` 门控禁用，因此本插件利用 `input.dock` 容器（flex 列）的 CSS `order` 把自己排到输入卡片**之后**。配置卡注册进官方 `settings.plugin.item` 插槽（设置 → 插件 → 插件配置页签），经 settings scope 读写 `token-heatmap` namespace（该 namespace 由本插件在服务端注册，官方页签只渲染"Host 实际 serve 的 namespace ∩ 已注册 key"的卡片）。
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
- **0.1.4（DSH 0.1.2 适配）**：rc.1 起 live session 不再携带 `.events` 数组（改用 `session.seq` + `session.eventAt(seq)`，与官方 `dsh-token-meter` 相同），新会话判断从 `composerPhase === "blank"` 改为布尔 `session.blank`；`sessionPersistence` 在 rc.1 不再提供会话枚举（list/listSnapshots 已移除），持久化历史的增量刷新降级为保留已有缓存、只累计 live 会话。客户端注入模块列表同步为新架构模块（见上）。
- **0.1.6（session/event 实时折叠 + 可选台账增强）**：`apply()` 注册官方 `session/event` 监听器，每个 usage 事件即时折叠进缓存，解决 rc.1 上 live 会话仅在 hero 屏挂载时才折叠而漏计同一日其他会话用量的问题（表现为当日总量偏小、历史天数丢失）；启动时一次性补折叠已存在的 live 会话（如 resumed 会话）。可选增强：若存在第三方插件 `@linxin666/dsh-usage` 的台账 `<DSH_HOME>/dsh-usage/usage-ledger.json`（设置 → 使用统计 的数据源，完整实时），则直接采用以恢复完整历史——该文件是第三方插件内部文件而非 DSH 契约，仅检查 `days` 形状（不校验 version），格式不符时告警并回退到 session/event 折叠。该文件仅在 @linxin666/dsh-usage 安装并启用时存在；其按 retainDays（默认 180、最大 730）修剪旧天数，故以台账为源时 all-time 总量与旧日历年受该设置上限。token 口径与该统计卡一致（input + output + cacheRead + cacheWrite，不含 reasoningTokens）。

## License

MIT。聚合与回环端点实现参考了 [dsh-usage-stats](https://github.com/Ychris12138/dsh-usage-stats)（MIT © Ychris12138）。
