# AGENT.md — dsh-token-heatmap

DSH（DeepSeek Harness）web 插件：新会话（hero）屏上的 GitHub 风格每日 token 用量热力图，可选年份视图、绿/蓝配色与显示开关（设置 → 插件 → 插件配置），含今日/本月/累计统计。

## 快速命令

- 校验：`npm run check`（`node --check` 全部 lib）
- 测试：`npm test`（`scripts/smoke.mjs` + `settings-smoke.mjs` + `rc1-session-smoke.mjs`）
- 发布：推送 tag `vX.Y.Z` → GitHub Actions（OIDC Trusted Publisher）自动 `npm publish`。**不要手动 npm publish**；版本号与 tag 必须同步 bump。

## 结构

- `lib/index.js` — 服务端 half（cordis plugin，`inject: ["webServer","sessions","sessionPersistence","settings"]`）
  - `apply()`：注册官方 `session/event` 监听器实时折叠每个 usage 事件进缓存（不依赖 hero 屏挂载，绕过 rc.1 枚举限制）；启动时一次性补折叠已存在 live 会话
  - `collectUsage()`：**主路径=渲染 session/event 实时折叠的缓存**（请求时再做一次 live 增量同步兜底）；**可选增强**：若存在第三方插件 `@linxin666/dsh-usage` 的台账 `<DSH_HOME>/dsh-usage/usage-ledger.json`（设置→使用统计 数据源，完整实时，`renderLedger()` 转换），则直接采用——该文件是第三方插件内部文件而非 DSH 契约，仅检查 `days` 形状（不校验 version），格式不符告警并回退；该文件仅在 @linxin666/dsh-usage 安装并启用时存在，其按 retainDays（默认 180、最大 730）修剪旧天数
  - 缓存：`<DSH_HOME>/storages/token-heatmap-cache.json`（原子写，单飞锁 `withLock`）；测试用临时 `DSH_HOME`
  - 路由：`GET /api/token-heatmap/usage`、`GET|POST /api/token-heatmap/config`（loopback-only）
  - settings namespace：**`"token-heatmap"` 字面量**（0.1.2 起 `dsh-settings` 不再导出 `settingsNamespace()`）
  - 迁移：`migrateLegacyConfig()` 一次性导入旧 `storages/token-heatmap-config.json`
- `lib/usage.js` — 纯函数：`applyUsageDelta`（replace-last-sample 语义）/ `createUsageState` / `foldUsage` / `renderUsage` / 按本地日聚合
- `lib/config.js` — 纯函数：`DEFAULT_CONFIG` / `parseConfig`（布尔 + 短字符串 shape 约束）
- `lib/client.js` — 浏览器 half：**手写 `window.__ModuleLoader__.load({id, factory})` bundle，无构建步骤**；React 组件（`require("react")` / `require("react/jsx-runtime")`）；CSS 走 `data-plugin-css` 通道
  - `conversation.input.dock`（list slot，id `token-heatmap`，order 10）——hero 屏输入卡上方全宽条目
  - `settings.plugin.item`（keyed slot，**key** `token-heatmap`）
- `scripts/*.mjs` — 自包含 smoke（mock ctx / mock settings scope / 临时 DSH_HOME）

## 兼容性（重要，改代码前必读）

- 适配 **DSH 0.1.2 版本线**（`0.1.2-alpha.4` / `alpha.5` / `rc.1`），`dsh.compatibility.dshReleases` 精确逐版本声明（DSH STORE 契约；范围声明无效）
- `dsh.client.inject` 必须是 **rc.1 模块图存在**的包（`dsh-api-remotes` / `dsh-client-connection` / `dsh-client-locale` / `dsh-client-ui-conversation` / `dsh-client-ui-settings`）
- `engines.dsh: ^0.1.2-rc.1`；`peerDependencies` 声明 lockstep `@deepseek-ai/dsh-*` 宿主包（dsh-market 据此显示"宿主要求"）
- **rc.1 破坏性变更备忘**：
  - live session 无 `.events` 数组 → `session.seq` + `session.eventAt(seq)`（0 基，官方 `dsh-token-meter` 读法）
  - **hero 判断：`session.blank`（布尔，true=新会话）**；旧版用 `composerPhase === "blank"`——client 里已双兼容（`heroBlank`），改时别丢掉
  - **`sessionPersistence` 在 rc.1 不再提供会话枚举**（`list`/`listSnapshots` 已移除）→ 0.1.6 起 `apply()` 注册官方 `session/event` 监听器实时折叠 live 会话 usage（不依赖 hero 屏挂载，彻底绕过该限制）；可选增强：若存在第三方 `@linxin666/dsh-usage` 台账 `dsh-usage/usage-ledger.json` 则直接采用（第三方插件内部文件，非 DSH 契约，仅检查 `days` 形状）；旧版（有 `list`）仍走完整持久化增量路径
  - **fork 会话会双计父会话 usage**（0.1.7 修复）：fork 子会话的 header `isSeeded=true`，其前 `inheritedEventCount` 个事件是从父会话复制的**父的** usage，父会话折叠时已计过。折叠必须从 fork 切点开始（in-process 用 `session.inheritedEventCount`，持久化日志读最后一个 `data.inherited === true` 的 `session/end-seed` 的 seq+1），否则同一批 token 被计两次（实测 09-14 由 8.34 亿虚增到 13.15 亿）。**注意 `isSeeded=false` 的 resume 会话不是 fork**——它的 constructor seed 是自己的历史，必须全折；只有 `isSeeded=true` 才跳过。`CACHE_VERSION` 提升到 2 以强制重折已污染的缓存
- **DSH STORE 的 protectedDsh 信号**（客户端访问内置 UI/统计）是设计使然，README 已披露，保持现状

## 修改守则

- 服务端读 session 事件**必须走 `liveSessionEvents()`**（不要直接碰 `session.events`）
- 不要试图在 rc.1 上"恢复" persisted 会话枚举——官方没有公开 API，降级路径是有意为之
- client 保持手写 bundle 格式与 `data-plugin-css` 通道；组件是 React 组件（返回 JSX 元素，不要返回 DOM 节点）
- 新测试加入 `package.json` 的 `"test"` 链；改完必须 `npm run check && npm test` 全绿
- 提交用 Conventional Commits（`feat:` / `fix:` / `chore:` / `docs:`），原子提交；改动涉及运行时契约时同步 bump 版本 + README「兼容性」小节
- 本地仓库有 codegraph 索引（`.codegraph/`，已 gitignore），可先用 codegraph 探索再改
