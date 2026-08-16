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
  - 修改后需点"保存"（显示"未保存"徽标提示），"放弃修改"可丢弃草稿；配置经回环端点持久化到 `<DSH_HOME>/storages/token-heatmap-config.json`。

## 安装 / Install

需要 `web` profile（`@deepseek-ai/dsh >= 0.1.0-rc.6`）与 `pnpm`。

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

- **服务端**（`lib/index.js` + `lib/usage.js` + `lib/config.js`）：作为 profile bundle 挂载，增量折叠全部会话事件日志中的 token 用量样本（`assistant/chunk` 的 `usage` 与 `assistant/message` 的 `usage`；同 `(turn, step)` 的重复样本按"替换"语义处理，归属后一天），按天、按模型聚合，缓存到 `<DSH_HOME>/storages/token-heatmap-cache.json`，并通过回环受限端点 `GET /api/token-heatmap/usage` 提供；显示配置（开关 + 配色）经 `GET/POST /api/token-heatmap/config` 读写，持久化到 `<DSH_HOME>/storages/token-heatmap-config.json`。
- **客户端**（`lib/client.js`）：手写 `__ModuleLoader__` bundle，注册进会话 `conversation.input.dock` 列表插槽，仅当 `session.composerPhase === "blank"`（新会话 hero 屏）且配置开关开启时渲染。框架真正的"卡片下方"插槽 `conversation.composer.dock` 在 hero 屏被 `!hero` 门控禁用，因此本插件利用 `input.dock` 容器（flex 列）的 CSS `order` 把自己排到输入卡片**之后**。配置卡注册进官方 `settings.plugin.item` 插槽（设置 → 插件 → 插件配置页签）；官方 Host 只向 Web 客户端暴露白名单内的设置命名空间，因此本插件不依赖 `settingsScope`，而是直接读写自己的回环配置端点。
- 语义与 `dsh-token-meter` 的 `tokenUsage` 投影一致（参考插件 [dsh-usage-stats](https://github.com/Ychris12138/dsh-usage-stats)，MIT）。

## 说明 / Notes

- 仅回环地址可访问数据端点，凭据不外发；插件只读，不修改任何会话数据。
- 无会话/无工作区时（`input.dock` 需要会话上下文）统计卡不渲染。
- 服务端与客户端都随 `dsh web` 启动加载，因此新增/更新插件后需要重启。

## License

MIT。聚合与回环端点实现参考了 [dsh-usage-stats](https://github.com/Ychris12138/dsh-usage-stats)（MIT © Ychris12138）。
