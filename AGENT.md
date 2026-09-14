# AGENT.md — dsh-token-heatmap

DSH（DeepSeek Harness）web 插件：新会话（hero）屏上的 GitHub 风格每日 token 用量热力图，**年视图 / 月视图可切换**、六套配色与默认视图设置（设置 → 插件 → 插件配置），含今日/本月/累计统计。

## 快速命令

- 校验：`npm run check`（`node --check` 全部 lib）
- 测试：`npm test`（`scripts/smoke.mjs` + `settings-smoke.mjs` + `rc1-session-smoke.mjs`）
- 发布：推送 tag `vX.Y.Z` → GitHub Actions（OIDC Trusted Publisher）自动 `npm publish`。**不要手动 npm publish**；版本号与 tag 必须同步 bump。

## 结构

- `lib/index.js` — 服务端 half（cordis plugin，`inject: ["webServer","sessions","sessionPersistence","settings"]`）
  - `apply()`：注册官方 `session/event` 监听器实时折叠每个 usage 事件进缓存（不依赖 hero 屏挂载）；启动时一次性补折叠已存在 live 会话
  - `collectUsage()`：**主路径=请求时增量同步 live 会话 + 枚举 stored 会话补齐历史**（`readSessionEvents()` 双接口兼容：0.1.2 线的 `readFrom()` 与 0.1.3+ 的 `open()`/`handle.read()`；`listSnapshots()`/`list()` 的 `revision` 用于跳过未变更日志）
  - 缓存：`<DSH_HOME>/storages/token-heatmap-cache.json`（原子写，单飞锁 `withLock`）；测试用临时 `DSH_HOME`
  - 路由：`GET /api/token-heatmap/usage`、`GET|POST /api/token-heatmap/config`（loopback-only）
  - settings namespace：**`"token-heatmap"` 字面量**（0.1.2 起 `dsh-settings` 不再导出 `settingsNamespace()`）
  - 迁移：`migrateLegacyConfig()` 一次性导入旧 `storages/token-heatmap-config.json`
- `lib/usage.js` — 纯函数：`applyUsageDelta`（replace-last-sample 语义）/ `createUsageState` / `foldUsage` / `renderUsage` / 按本地日聚合
- `lib/config.js` — 纯函数：`DEFAULT_CONFIG` / `parseConfig`（短字符串 shape 约束 + `defaultView` 枚举；0.1.x 的 `enabled` 已废弃、读到即忽略）
- `lib/client.js` — 浏览器 half：**手写 `window.__ModuleLoader__.load({id, factory})` bundle，无构建步骤**；React 组件（`require("react")` / `require("react/jsx-runtime")`）；CSS 走 `data-plugin-css` 通道
  - `conversation.input.dock`（list slot，id `token-heatmap`，order 10）——hero 屏输入卡上方全宽条目（**无显示开关**：hero 屏始终渲染）
  - `settings.plugin.item`（keyed slot，**key** `token-heatmap`）——卡内只有 配色方案 / 默认视图 两个字段
  - 视图：`buildGrid()`（年，53 列 × 7 行）/ `buildMonthGrid()`（月，7 列 × 5–6 行 + 日号），`levelOf()` 绝对阈值分档，`S.viewNav` 年/月分段切换（在标题行**最右端**、刷新按钮之后），`shiftMonthKey()` 月游标步进；默认视图来自 `defaultView` 设置
- `scripts/*.mjs` — 自包含 smoke（mock ctx / mock settings scope / 临时 DSH_HOME）

## 兼容性（重要，改代码前必读）

- 适配 **DSH 0.1.2 版本线**（`0.1.2-alpha.4` / `alpha.5` / `rc.1`），`dsh.compatibility.dshReleases` 精确逐版本声明（DSH STORE 契约；范围声明无效）
- `dsh.client.inject` 必须是 **rc.1 模块图存在**的包（`dsh-api-remotes` / `dsh-client-connection` / `dsh-client-locale` / `dsh-client-ui-conversation` / `dsh-client-ui-settings`）
- `engines.dsh: ^0.1.2-rc.1`；`peerDependencies` 声明 lockstep `@deepseek-ai/dsh-*` 宿主包（dsh-market 据此显示"宿主要求"）
- **rc.1 破坏性变更备忘**：
  - live session 无 `.events` 数组 → `session.seq` + `session.eventAt(seq)`（0 基，官方 `dsh-token-meter` 读法）
  - **hero 判断：`session.blank`（布尔，true=新会话）**；旧版用 `composerPhase === "blank"`——client 里已双兼容（`heroBlank`），改时别丢掉
  - **`sessionPersistence` 的 stored 会话读取接口换过两代**：0.1.2 线（`0.1.0-rc.8` … `0.1.2-rc.1`）是 `listSnapshots()` + `readFrom(id, fromSeq)`；**0.1.3-alpha.2 起改为 `list()` + `open(id,"read")`/`handle.read()`**（`readFrom`/`listSnapshots` 已移除，`list()` 的 snapshot 同样带 `revision`）。改这块必须两条都留（`readSessionEvents()`），且 `state.consumed` 存的是 **seq 不是 index**——只探测 `list()` 却调 `readFrom` 会让每个 stored 会话抛错并被吞掉，表现为热力图只剩进程内 live 的几天
  - `session/event` 监听器与 `collectUsage` 共用同一份内存缓存与 per-session `consumed` 游标，不要在其中一方重置状态而不重置另一方
- **DSH STORE 的 protectedDsh 信号**（客户端访问内置 UI/统计）是设计使然，README 已披露，保持现状

## 修改守则

- 服务端读 session 事件**必须走 `liveSessionEvents()`**（不要直接碰 `session.events`）
- 不要试图在 rc.1 上"恢复" persisted 会话枚举——官方没有公开 API，降级路径是有意为之
- client 保持手写 bundle 格式与 `data-plugin-css` 通道；组件是 React 组件（返回 JSX 元素，不要返回 DOM 节点）
- 新增视图/格子渲染必须同时改 `buildGrid`（年）与 `buildMonthGrid`（月）两条路径，并在 `scripts/smoke.mjs` 补对应几何断言（列=周一起、越界格为 null、level 与 `levelOf` 一致）
- settings 字段：`colorScheme` 只约束 shape（新色板要能存进旧服务端），`defaultView` 是枚举（未知值没有渲染器可回退）——加字段时想清楚属于哪种，并同步 `lib/config.js` / `lib/index.js` schema / client `createConfigStore` 三处 + 对应 smoke。**删字段**（如 0.3.0 删掉的 `enabled`）时：schema 移除该键即可，schemastery 会把未声明键原样透传（旧 `settings.yaml` 的键留着但没人读）；只有当该字段出现在回环兼容 API 的响应里才需要保留常量占位（`serveConfig` 的 `enabled: true`），否则旧客户端会改行为
- 文档截图（`docs/预览-新版会话页.jpg` / `月视图.jpg` / `年视图.jpg`）改 UI 后需重拍，工具链在 `scripts/`：`docs-screenshot-auth.mjs`（用 `~/.dsh/.credentials.yaml` 里的 browser-session secret 现签回环登录 cookie）→ `docs-screenshot.mjs`（CDP 驱动 headless 浏览器加载运行中的 `dsh web`，截整页 + 年/月两张卡片）→ `docs-screenshot-crop.mjs`（用系统 Edge/Chrome 无头渲染成 README 尺寸的裁切图，再用 System.Drawing/ImageMagick 转 JPEG 落到 `docs/`）。**截图前必须把新 `lib/client.js` 覆盖到 profile 安装目录**（服务端只从那里取客户端 half，HMR 轮询 ~1s 内重算 bundle rev）；headless 浏览器需要命名管道，受限沙箱下会被拒（需 danger-full-access）
- 新测试加入 `package.json` 的 `"test"` 链；改完必须 `npm run check && npm test` 全绿
- 提交用 Conventional Commits（`feat:` / `fix:` / `chore:` / `docs:`），原子提交；改动涉及运行时契约时同步 bump 版本 + README「兼容性」小节
- 本地仓库有 codegraph 索引（`.codegraph/`，已 gitignore），可先用 codegraph 探索再改
