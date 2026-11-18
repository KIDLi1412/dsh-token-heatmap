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
  - **fork 切点**：`forkCutOf()`（live，`header.isSeeded === true` → `session.inheritedEventCount`）与 `forkCutOfEvents()`（stored，最后一个 `data.inherited === true` 的 `session/end-seed` 的 `seq + 1`），切点存在 per-session `state.skipUntil` 里，三条折叠路径（live 折叠 / `session/event` 监听 / stored 读取）统一从 `max(consumed, skipUntil)` 开始；切点新发现或不一致就 `resetFold()` 重折。**fork 子会话的前缀是父会话的 usage，父会话折叠时已计过**，从 0 折会双计（2026-09-14 实测 8.34 亿 → 13.15 亿）；`isSeeded=false` 的 resume 不是 fork，必须整份折
  - 缓存：`<DSH_HOME>/storages/token-heatmap-cache.json`（原子写，单飞锁 `withLock`）；测试用临时 `DSH_HOME`
  - 路由：`GET /api/token-heatmap/usage`、`GET|POST /api/token-heatmap/config`（loopback-only；读走 `entryConfig()` → `settings.describe()`）
  - **`export const Config = z.object({ colorScheme, defaultView })`：DSH 0.2.0 的设置来源**，以 **profile entry id**（= bundle patch 的 `id: token-heatmap`）为键；`SETTINGS_NAMESPACE` 就是这个字面量，三处（patch id / Host 常量 / 客户端 `configForms.get()`）必须一致
  - 迁移：`migrateLegacyConfig()` 一次性导入旧 `storages/token-heatmap-config.json`；`rescueRemovedSettingsDocument()` 在 Loader settle 后一次性抢救旧 `settings.yaml`（DSH 自己的按-entry-id 导入在本插件被拒挂载时跳过了它）
- `lib/usage.js` — 纯函数：`applyUsageDelta`（replace-last-sample 语义）/ `createUsageState` / `foldUsage` / `renderUsage` / 按本地日聚合
- `lib/config.js` — 纯函数：`DEFAULT_CONFIG` / `parseConfig`（短字符串 shape 约束 + `defaultView` 枚举；0.1.x 的 `enabled` 已废弃、读到即忽略）
- `lib/client.js` — 浏览器 half：**手写 `window.__ModuleLoader__.load({id, factory})` bundle，无构建步骤**；React 组件（`require("react")` / `require("react/jsx-runtime")`）；CSS 走 `data-plugin-css` 通道
  - **只注册 `conversation.input.dock`**（list slot，id `token-heatmap`，order 10）——hero 屏输入卡上方全宽条目（**无显示开关**：hero 屏始终渲染）。**不注册 `settings.plugin.item`**：设置页里没有本插件的卡片，配置改在卡片内（见下）
  - `TokenHeatmapInlineSettings` —— ⚙（`S.gear`，标题行最右端）弹出的**悬浮设置面板**：portal 到 `document.body`、`position:fixed`、`z-index:1100`，锚在 ⚙ 上方 8px 居中、按视口钳制 12px（`placePanel()`，与 dsh-session-cost 的统计 pill 弹层同一套做法与同一组 token：`--dsw-specific-menu` + `--dsw-elevation-prominent` + `--dsw-elevation-stroke-color`；0.2.0 起表面再加 `--dsw-radius-lg` + `--dsw-menu-backdrop-filter` 与原生弹层一致）；内容是标题/分隔线/配色 6 色板/默认视图年月分段/底部图例与说明；关闭方式为点外部 pointerdown、Esc、再点 ⚙（监听绑定在 `TokenHeatmap` 上，面板只负责画）。**点击即时写入配置表单**（无草稿/保存；`pending` 乐观回显，失败显示 `settingsSaveFailed`）
  - bundle 里 `require("react-dom")` 只服务这个 portal（DSH 0.2.0 的客户端模块注册表仍提供 `react` / `react/jsx-runtime` / `react-dom` / `react-dom/client`）；`scripts/smoke.mjs` 的 fakeRequire 会跨 profiles / repo 两棵 node_modules 解析它——**0.2.0 起 DSH 安装里不再有 `node_modules/react`**（React 打进 web frontend dist），所以本机跑 smoke 前要先 `npm install --no-save --no-package-lock react@18.3.1 react-dom@18.3.1`（CI 的 publish.yml 已经这么做）
  - 排布：`标题 · 统计… · ‹ › 步进器 · 年|月分段 … 刷新 · ⚙`（步进器和分段按钮成对，刷新与 ⚙ 收在行尾）
  - 视图：`buildGrid()`（年，53 列 × 7 行）/ `buildMonthGrid()`（月，7 列 × 5–6 行 + 日号），`levelOf()` 绝对阈值分档，`shiftMonthKey()` 月游标步进；默认视图来自 `defaultView` 设置
- `scripts/*.mjs` — 自包含 smoke（mock ctx / mock settings scope / 临时 DSH_HOME）+ 文档截图工具链（见「修改守则」）

## 兼容性（重要，改代码前必读）

- 适配 **DSH 0.2.0 / 0.2.1 / 0.2.2 三条版本线**（本机 `0.2.2-rc.4`，已逐项复核），`dsh.compatibility.dshReleases` 精确逐版本声明（DSH STORE 契约；范围声明无效）——`0.2.0-rc.2`、`0.2.1-rc.2`、`0.2.1-rc.5`、`0.2.2-rc.4` 都标 `compatible`
- `dsh.client.inject` 必须是 **0.2.0 客户端模块图存在**的包（`dsh-api-remotes` / `dsh-client-connection` / `dsh-client-locale` / `dsh-client-ui-conversation` / `dsh-client-ui-settings`）；客户端 `inject` 服务是 `["slots","locale","configForms"]`
- `engines.dsh: ^0.2.0-rc.2 || ^0.2.2-rc.4`；`peerDependencies` 声明 lockstep `@deepseek-ai/dsh-*` 宿主包（dsh-market 据此显示"宿主要求"），并全部标 `peerDependenciesMeta.optional`——它们由 DSH 运行时提供、本插件从不 import，标 optional 后 npm/pnpm 不再把它们装进依赖树（0.2.0 起这些包彼此还有 peer，沿用自动安装会解析冲突）。每条 `@deepseek-ai/dsh-*` 声明同样写 `^0.2.0-rc.2 || ^0.2.2-rc.4`：范围在语义上等价于 `^0.2.0-rc.2`，但**显式列出验证过的版本线**才是 dsh-market / 闸门要读的那份"声明"（0.2.1-rc.1 起兼容性判定优先看 `engines.dsh`）。升级 DSH 后同步时只需把这个后缀换成新复核到的版本，第一段别动
- **宿主兼容闸门会拒绝挂载，不只是警告**：`dsh-app-boot` 的 `evaluatePluginCompatibility()` 比对声明与运行时版本（`semver.satisfies(..., { includePrerelease: true })`），不符时 `dsh plugin add` 直接拒绝安装、已装的 bundle 在 `plugin_manager list_bundles` 里显示 `incompatible-version` + `rows: []`（插件完全没挂载）。**0.2.1 起判定顺序变了**：声明了 `engines.dsh` 就**只**看它（peer 全部忽略），没声明才逐条比对 `@deepseek-ai/dsh*` peer（见下"0.2.1 备忘"）。改范围前后都用本仓库 `temp/compat-preflight.mjs` 预检——它自己扫 pnpm store 找 `dsh-app-boot`，不写死随更新变化的路径哈希
- **0.2.0 破坏性变更备忘**：
  - **设置模型**：插件自建 namespace + `settings.register(ns, schema)` → **导出 `Config`（schemastery）**，以 profile entry id 为键的表单；Host 读别人用 `settings.describe()`（**`settings.get(ns)` 已删除**，写成 `?.` 会静默回默认值）、写自己用 `settings.update(ns, patch)`；浏览器端 `ctx.configForms.get(entryId)`（`getSnapshot`/`subscribe`/`set`/`unset`/`mutate`），`settingsScope` 已删除
  - **`settings.yaml` 被取消**：DSH 在启动后把旧文档整体导入 profile 并改名为 `settings.yaml.imported`（按 section→entry id），导入失败的 section 只留在重命名后的文件里——插件被拒挂载时值不会被自动带走（`rescueRemovedSettingsDocument()` 就是为它写的）
  - **整站 cookie 鉴权**：0.2.0 给 `dsh web` 的每个请求加了签名 cookie（无 cookie → `401 dsh web authentication required`）。插件端点的 loopback fence 保留；用 node 直接探端点会拿到 401，这**不代表插件没挂载**
  - `session.seq` / `session.eventAt(seq)`、`sessions.list()`、`sessionPersistence` 的 `list()` + `open()`、`webServer.register({kind,path,handler})` 在 0.2.0 均未变（已逐项核对 0.2.0-rc.2）
  - 原生弹层皮肤：stat dialog 改用 `border-radius:var(--dsw-radius-lg)` + `backdrop-filter:var(--dsw-menu-backdrop-filter)`，⚙ 面板已跟（读 token 时带 fallback）
- **0.2.1（2026-10-18 复核 `0.2.1-rc.2`，2026-10-31 复核 `0.2.1-rc.5`）**：本插件**不需要改代码**，只补了声明；逐项结论：
  - **兼容性判定优先 `engines.dsh`**（0.2.1-rc.1 发布说明的"其他变更"）：声明了 `engines.dsh` 就只按它判，peer 不再参与——所以 `engines.dsh` 必须自己覆盖所有支持的版本线（现在是 `^0.2.0-rc.2 || ^0.2.2-rc.4`），别只改 peer 忘了它
  - 0.2.1 把**输入区统计扩展拆成 `activity` 与 `usage` 两个入口**（替换旧 `stats` 整行的插件要改注册 ID）——本插件注册的是 `conversation.input.dock`（0.2.1 仍在 `dsh-client-ui-conversation` 里提供），与这条变更无关
  - 0.2.1 移除运行时 invariant 插件与各包 `./invariant` 导出、子路径插件不再读独立 `package.json`（显示文本/图标改走子路径导出）：本插件都不涉及（不 import `./invariant`，也没有独立展示清单）
  - 运行时相关契约逐项复核通过：`webServer.register`、`settings.describe()` / `settings.update()`、`sessions.list()` + `session.seq`/`eventAt(seq)`/`inheritedEventCount`/`header.isSeeded`、`sessionPersistence.list()` + `open(id,"read")` + `handle.read()` 都在；5 个客户端注入包在 0.2.1 仍声明 `dsh.client`（web），前端模块表仍提供 `react` / `react/jsx-runtime` / `react-dom` / `react-dom/client`；`session.blank`（hero 判断）仍在 `dsh-api-session-controller`；`configForms` 与 `conversation.input.dock` 仍在
  - 0.2.1 还修了"启停插件时其他插件的样式被移除、需刷新才恢复"（用 `data-plugin-css` 通道的插件受益）；另新增了若干扩展位（用户消息、新会话页、模型选择器等），本插件暂未使用
  - **rc.3 / rc.4 / rc.5 三个后续 RC 没有插件契约变化**（rc.3：侧栏与会话视图的「更多」菜单、新建会话草稿修复、模型列表刷新方式；rc.4：ACP 模式下诊断输出混进 stdout；rc.5：思考内容展示）——同步时只需把声明后缀换成 `^0.2.1-rc.5` 并在 `dshReleases` 记一条。rc.5 实测：9 个宿主包全部升到 `0.2.1-rc.5`（5 个客户端包仍声明 `dsh.client` web），运行中的宿主（commit `d4db512`）照常加载本插件两半（bundle 200 / rev `f6cf91d5a8fb`、两个端点 200），`temp/compat-preflight.mjs` 对 rc.2 / rc.5 / 0.2.1 / 0.2.2-alpha.2 全部 COMPATIBLE，`npm test` 全绿
- **0.2.2（2026-11-18 复核 `0.2.2-rc.4`）**：依然**不需要改代码**，仍然只动声明。0.2.2 是自 0.2.1 以来第一个带插件相关变更的版本线：**Cordis 升到 4.1.0**（Loader 1.1.0 / Include 1.1.0，配置访问统一到 Fiber）、**Session Projection 注册 API 改异步**（要插件启动时持有句柄）、tools 的 `resolve`/`executable` 与 `tools.mode` 迁移、`agent.model` 取代在 `agent/request` 里改 route。逐项结论：本插件不注册 session projection、不碰 tools/agent 层，都不涉及；设置管道（`settings.describe()` + `volatileForm` + `isVolatilePath` + `plainConfig`）与 schemastery 的 `.volatile()` 在 Cordis 4.1.0 / schemastery 3.19.0 上行为不变（本插件的 `^3.18.2` 范围已含 3.19.0）。静态核对（`temp/inspect-dsh.mjs`）：9 个宿主包全部 `0.2.2-rc.4`、5 个客户端包仍声明 `dsh.client`(web)、前端模块表仍提供 react 全套、`conversation.input.dock` / `configForms` / `session.blank` / `session/event` / `sessionPersistence` 的 `list()`+`open()`+`read()` 都在；用 `0.2.2-rc.4` 自己的闸门判定 rc.1 / rc.4 / rc.5 全 COMPATIBLE。**注意**：本机这次更新把旧安装目录替换掉了，正在运行的旧进程（0.2.1-rc.5）会读不到部分模块——重启到 0.2.2 后实机验收通过（`temp/host-check.mjs`）：宿主就是 `0.2.2-rc.4`（commit `70005a5`），客户端 entry `rev f6cf91d5a8fb`、bundle 200、`/api/token-heatmap/usage` 与 `/config` 均 200
- **0.1.x 破坏性变更备忘（历史，仍然有效——双兼容代码还在）**：
  - live session 无 `.events` 数组 → `session.seq` + `session.eventAt(seq)`（0 基，官方 `dsh-token-meter` 读法）
  - **hero 判断：`session.blank`（布尔，true=新会话）**；旧版用 `composerPhase === "blank"`——client 里已双兼容（`heroBlank`），改时别丢掉
  - **`sessionPersistence` 的 stored 会话读取接口换过两代**：0.1.2 线（`0.1.0-rc.8` … `0.1.2-rc.1`）是 `listSnapshots()` + `readFrom(id, fromSeq)`；**0.1.3-alpha.2 起改为 `list()` + `open(id,"read")`/`handle.read()`**（`readFrom`/`listSnapshots` 已移除，`list()` 的 snapshot 同样带 `revision`）。改这块必须两条都留（`readSessionEvents()`），且 `state.consumed` 存的是 **seq 不是 index**——只探测 `list()` 却调 `readFrom` 会让每个 stored 会话抛错并被吞掉，表现为热力图只剩进程内 live 的几天
  - `session/event` 监听器与 `collectUsage` 共用同一份内存缓存与 per-session `consumed` 游标，不要在其中一方重置状态而不重置另一方
  - **fork 的切点也必须三条路径一致**：`state.skipUntil` 是 per-session 的 fork 切点，`apply()` 的 `session/event` 守卫、`collectUsage` 的 live 折叠、启动时的首次补折叠都读同一份；只改其中一条会让同一批 token 被计两次或少计
  - **缓存格式版本**：per-session 折叠状态的字段变了（如 0.4.1 的 `skipUntil`）就必须 bump `CACHE_VERSION`，否则旧缓存里已双计的天数会留着且与新折叠口径混在一起
- **settings 归谁管（重要）**：0.2.0 起**没有** `settings.register` / `settings.get`——**导出的 `Config` 就是表单与持久化管道**，以 profile entry id 为键；Host 侧读配置走 `entryConfig()`（`settings.describe()`），写走 `settings.update()`，客户端走 `ctx.configForms.get("token-heatmap")`。三处字面量必须一致（bundle patch 的 `id` = Host `SETTINGS_NAMESPACE` = 客户端 `SETTINGS_NS`），`scripts/settings-smoke.mjs` 有断言盯着 Host 常量与 patch id；`settings.plugin.item` 那张卡自 0.4.0 起就不注册（配置在卡片 ⚙ 面板里）
- **DSH STORE 的 protectedDsh 信号**（客户端访问内置 UI/统计）是设计使然，README 已披露，保持现状

## 修改守则

- 服务端读 session 事件**必须走 `liveSessionEvents()`**（不要直接碰 `session.events`）
- 不要试图在 rc.1 上"恢复" persisted 会话枚举——官方没有公开 API，降级路径是有意为之
- client 保持手写 bundle 格式与 `data-plugin-css` 通道；组件是 React 组件（返回 JSX 元素，不要返回 DOM 节点）
- 新增视图/格子渲染必须同时改 `buildGrid`（年）与 `buildMonthGrid`（月）两条路径，并在 `scripts/smoke.mjs` 补对应几何断言（列=周一起、越界格为 null、level 与 `levelOf` 一致）
- settings 字段：`colorScheme` 只约束 shape（新色板要能存进旧服务端），`defaultView` 是枚举（未知值没有渲染器可回退）——加字段时想清楚属于哪种，并同步 `lib/config.js` / `lib/index.js` 的 `Config` schema / client `createConfigStore` 三处 + 对应 smoke（`scripts/settings-smoke.mjs` 同时盯着 entry id 三方一致）。**删字段**（如 0.3.0 删掉的 `enabled`）时：schema 移除该键即可，schemastery 会把未声明键原样透传（旧配置里的键留着但没人读）；只有当该字段出现在回环兼容 API 的响应里才需要保留常量占位（`serveConfig` 的 `enabled: true`），否则旧客户端会改行为
- 文档截图（`docs/预览-新版会话页.jpg` / `月视图.jpg` / `年视图.jpg` / `卡片设置面板.jpg`）改 UI 后需重拍，工具链在 `scripts/`：`docs-screenshot-auth.mjs`（用 `~/.dsh/.credentials.yaml` 里的 browser-session secret 现签回环登录 cookie）→ `docs-screenshot.mjs`（CDP 驱动 headless 浏览器加载运行中的 `dsh web`，截整页 + 年/月/⚙ 三张卡片状态）→ `docs-screenshot-crop.mjs`（用系统 Edge/Chrome 无头渲染成 README 尺寸的裁切图，再用 System.Drawing/ImageMagick 转 JPEG 落到 `docs/`；`THM_VIEW=month` 用于 card-a 恰好是月视图时）。**不需要手工同步**（见下条），但注意 ⚙ 里切过「默认视图」后，`shot-card-a/b` 哪张是年、哪张是月会翻转
- **本机是开发模式（junction 链接）**：`~/.dsh/profiles/web/package.json` 里本插件是 `link:C:/Projects/DSH/dsh-token-heatmap`，`node_modules/@kidli1412/dsh-token-heatmap` 是指向本仓库的 **Junction**。所以**改仓库即改运行时**：编辑 `lib/client.js` 后服务端的 HMR 轮询会在 ~1s 内重算 bundle rev，硬刷新浏览器就能看到（实测：写入标记 → 1s 后新 rev 里已含该标记）。推论：① 不要再往 profile 复制文件——`Copy-Item` 会报 "Cannot overwrite the item … with itself"；② `git checkout -- lib/client.js` 会**立刻改变正在运行的 GUI**（仓库文件就是运行时文件），回滚工作区前先确认；③ 唯一需要重启 `dsh web` 的是 Host half（`lib/index.js` 的 settings schema / 路由 / 折叠逻辑），客户端 half 不用
- 新测试加入 `package.json` 的 `"test"` 链；改完必须 `npm run check && npm test` 全绿
- 提交用 Conventional Commits（`feat:` / `fix:` / `chore:` / `docs:`），原子提交；改动涉及运行时契约时同步 bump 版本 + README「兼容性」小节
- 本地仓库有 codegraph 索引（`.codegraph/`，已 gitignore），可先用 codegraph 探索再改
