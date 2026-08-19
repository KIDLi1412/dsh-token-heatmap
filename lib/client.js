/**
 * dsh-token-heatmap — browser half.
 *
 * Hand-written `__ModuleLoader__` bundle (no build step): registers into the
 * conversation `input.dock` list slot and renders a GitHub-style heatmap of a
 * SELECTABLE CALENDAR YEAR (Jan 1 – Dec 31; columns = weeks, rows = Mon..Sun,
 * all seven weekday labels on the left) plus today / this-month / all-time
 * totals and a ‹year› year selector next to the stats. It also registers a
 * settings card into the official `settings.plugin.item` seat
 * (设置 → 插件 → 插件配置) with a display switch and a green/blue palette
 * choice, persisted through the server half's loopback config endpoint.
 *
 * The card is shown ONLY on the new-session (hero) screen — gated on
 * `session.composerPhase === "blank"` — and is positioned visually BELOW the
 * composer input card via a flex `order` on the dock wrapper (the dock's DOM
 * site sits above the bar, but the composer stack is a flex column and the
 * framework's true below-card seat `composer.dock` is disabled on the hero
 * screen).
 *
 * Cell colors use ABSOLUTE token thresholds (not window-relative ranks), so
 * a huge day is always dark regardless of its neighbours:
 *   level 0: 0            level 1: <1M      level 2: 1M–10M
 *   level 3: 10M–100M     level 4: ≥100M
 *
 * Data comes from the server half's loopback-only endpoint via same-origin
 * fetch: GET /api/token-heatmap/usage.
 */
window.__ModuleLoader__.load({
	id: "@kidli1412/dsh-token-heatmap",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");

		//#region css
		const css = [
			".thm_dock{box-sizing:border-box;width:100%;max-width:var(--dsh-composer-card-max-width,780px);margin:0 auto;padding:0 16px 2px}",
			".thm_card{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);border-radius:12px;padding:10px 12px 12px;display:flex;flex-direction:column;gap:8px}",
			".thm_head{flex-wrap:wrap;align-items:baseline;gap:4px 12px;display:flex}",
			".thm_title{color:var(--dsw-alias-label-primary);font-size:12px;font-weight:600;line-height:18px}",
			".thm_stat{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}",
			".thm_statLabel{margin-right:4px}",
			".thm_statValue{color:var(--dsw-alias-label-primary);font-size:12px;font-weight:600;line-height:18px;font-variant-numeric:tabular-nums}",
			".thm_yearNav{align-items:center;gap:2px;display:inline-flex}",
			".thm_yearBtn{cursor:pointer;color:var(--dsw-alias-label-tertiary);background:0 0;border:none;border-radius:4px;padding:0 5px;font-size:13px;line-height:18px}",
			".thm_yearBtn:hover:not(:disabled){color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover)}",
			".thm_yearBtn:disabled{opacity:.35;cursor:default}",
			".thm_yearLabel{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;min-width:36px;text-align:center;font-variant-numeric:tabular-nums}",
			".thm_refresh{cursor:pointer;color:var(--dsw-alias-label-tertiary);background:0 0;border:none;border-radius:6px;margin-left:auto;padding:2px 6px;font:inherit;font-size:11px;line-height:16px}",
			".thm_refresh:hover{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover)}",
			".thm_refresh:disabled{opacity:.5;cursor:default}",
			".thm_gridWrap{overflow-x:auto}",
			".thm_grid{width:max-content;display:flex;flex-direction:column;gap:2px}",
			".thm_months{margin-left:16px;display:flex}",
			".thm_monthLabel{color:var(--dsw-alias-label-tertiary);flex:none;font-size:10px;line-height:14px;white-space:nowrap;overflow:hidden}",
			".thm_row{display:flex;gap:2px}",
			".thm_rowLabel{color:var(--dsw-alias-label-caption);width:16px;flex:none;font-size:9px;line-height:12px;text-align:center}",
			".thm_cell{box-sizing:border-box;width:10px;height:10px;border-radius:2px;flex:none}",
			".thm_legend{align-items:center;gap:3px;margin-left:auto;font-size:10px;line-height:14px;display:inline-flex;color:var(--dsw-alias-label-tertiary)}",
			".thm_legendCell{box-sizing:border-box;width:9px;height:9px;border-radius:2px}",
			".thm_error{color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover-danger);border-radius:8px;padding:7px 8px;font-size:11px;line-height:16px;display:flex;justify-content:space-between;align-items:center;gap:8px}",
			".thm_retry{color:inherit;font:inherit;cursor:pointer;background:0 0;border:none;flex:none;padding:0}",
			".thm_loading{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;padding:6px 2px}",
			".thms_card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}",
			".thms_card:hover{border-color:var(--dsw-alias-label-dimmed)}",
			".thms_cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}",
			".thms_header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}",
			".thms_headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}",
			".thms_name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}",
			".thms_desc{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}",
			".thms_chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}",
			".thms_chevronOpen{transform:rotate(180deg)}",
			".thms_pending{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;flex:none;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}",
			".thms_body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding:12px 0 8px;display:flex;flex-direction:column;gap:12px}",
			".thms_loading{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5;margin:0}",
			".thms_error{color:var(--dsw-alias-label-error);font-size:12px;line-height:1.5;margin:0}",
			".thms_retryBtn{color:inherit;font:inherit;cursor:pointer;background:0 0;border:none;flex:none;padding:0;text-decoration:underline}",
			".thms_field{display:flex;flex-direction:column;gap:4px}",
			".thms_fieldLabel{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:1.5}",
			".thms_fieldHint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5;margin:0}",
			".thms_switchRow{display:flex;align-items:center;gap:10px}",
			".thms_switch{position:relative;width:36px;height:20px;flex:none;border-radius:999px;border:0;padding:0;cursor:pointer;background:var(--dsw-alias-interactive-bg-hover-solid);transition:background .15s}",
			".thms_switch:disabled{opacity:.5;cursor:default}",
			".thms_switchOn{background:var(--dsw-alias-state-business-primary)}",
			".thms_thumb{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .15s}",
			".thms_switchOn .thms_thumb{transform:translateX(16px)}",
			".thms_swatches{display:flex;flex-wrap:wrap;gap:8px}",
			".thms_swatch{appearance:none;font:inherit;cursor:pointer;align-items:center;gap:8px;border:1px solid var(--dsw-alias-border-l2);background:0 0;border-radius:8px;padding:6px 10px;display:flex}",
			".thms_swatch:hover:not(:disabled){border-color:var(--dsw-alias-label-dimmed)}",
			".thms_swatch:disabled{opacity:.5;cursor:default}",
			".thms_swatch[data-active=true]{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 1px var(--dsw-alias-state-business-primary) inset}",
			".thms_swatchCells{display:flex;gap:2px}",
			".thms_swatchCell{width:10px;height:10px;border-radius:2px}",
			".thms_swatchLabel{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5}",
			".thms_footer{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}",
			".thms_footerError{min-width:0;color:var(--dsw-alias-label-error);flex:1;margin:0;font-size:12px;line-height:1.5}",
			".thms_btn{appearance:none;font:inherit;cursor:pointer;border:1px solid #0000;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}",
			".thms_btn:disabled{opacity:.4;cursor:default}",
			".thms_discard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}",
			".thms_discard:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}",
			".thms_save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}"
		].join("");
		const tagId = "@kidli1412/dsh-token-heatmap/TokenHeatmap.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@kidli1412/dsh-token-heatmap";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		const S = {
			dock: "thm_dock",
			card: "thm_card",
			head: "thm_head",
			title: "thm_title",
			stat: "thm_stat",
			statLabel: "thm_statLabel",
			statValue: "thm_statValue",
			yearNav: "thm_yearNav",
			yearBtn: "thm_yearBtn",
			yearLabel: "thm_yearLabel",
			refresh: "thm_refresh",
			gridWrap: "thm_gridWrap",
			grid: "thm_grid",
			months: "thm_months",
			monthLabel: "thm_monthLabel",
			row: "thm_row",
			rowLabel: "thm_rowLabel",
			cell: "thm_cell",
			legend: "thm_legend",
			legendCell: "thm_legendCell",
			error: "thm_error",
			retry: "thm_retry",
			loading: "thm_loading",
			settingsCard: "thms_card",
			settingsCardOpen: "thms_cardOpen",
			settingsHeader: "thms_header",
			settingsHeadText: "thms_headText",
			settingsName: "thms_name",
			settingsDesc: "thms_desc",
			settingsChevron: "thms_chevron",
			settingsChevronOpen: "thms_chevronOpen",
			settingsPending: "thms_pending",
			settingsBody: "thms_body",
			settingsLoading: "thms_loading",
			settingsError: "thms_error",
			settingsRetry: "thms_retryBtn",
			settingsField: "thms_field",
			settingsFieldLabel: "thms_fieldLabel",
			settingsFieldHint: "thms_fieldHint",
			settingsSwitchRow: "thms_switchRow",
			settingsSwitch: "thms_switch",
			settingsSwitchOn: "thms_switchOn",
			settingsThumb: "thms_thumb",
			settingsSwatches: "thms_swatches",
			settingsSwatch: "thms_swatch",
			settingsSwatchCells: "thms_swatchCells",
			settingsSwatchCell: "thms_swatchCell",
			settingsSwatchLabel: "thms_swatchLabel",
			settingsFooter: "thms_footer",
			settingsFooterError: "thms_footerError",
			settingsBtn: "thms_btn",
			settingsDiscard: "thms_discard",
			settingsSave: "thms_save"
		};
		//#endregion

		//#region locale
		/** Locale namespace and dictionaries. */
		const NS = "tokenHeatmap";
		const zh = {
			title: "Token 用量",
			refresh: "刷新",
			loading: "加载中…",
			error: "Token 统计暂不可用",
			errorHint: "服务端未加载或请求失败",
			retry: "重试",
			today: "今日",
			month: "本月",
			total: "累计",
			prevYear: "上一年",
			nextYear: "下一年",
			less: "少",
			more: "多",
			cellTokens: "{date} · {tokens} tokens",
			weekdayLabel: ["一", "二", "三", "四", "五", "六", "日"],
			monthName: ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"],
			levelLegend: ["0", "<1M", "1M–10M", "10M–100M", "≥100M"],
			settingsTitle: "Token 用量热力图",
			settingsDescription: "新会话页面的 Token 用量热力图显示与配色。",
			settingsEnabled: "显示热力图",
			settingsEnabledHint: "关闭后，新会话输入框下方的 Token 用量热力图不再显示。",
			settingsScheme: "配色方案",
			settingsSchemeHint: "热力图格子的颜色主题：绿色为经典 GitHub 风格，其余为新增配色。",
			settingsGreen: "绿色",
			settingsBlue: "蓝色",
			settingsOrange: "橙色",
			settingsRed: "红色",
			settingsPurple: "紫色",
			settingsTeal: "青色",
			settingsSave: "保存",
			settingsSaving: "保存中…",
			settingsDiscard: "放弃修改",
			settingsUnsaved: "未保存",
			settingsSaveFailed: "保存失败，修改已保留，请重试。",
			settingsLoadFailed: "配置加载失败。",
			settingsRetry: "重试",
			settingsExpand: "展开设置",
			settingsCollapse: "收起设置"
		};
		const en = {
			title: "Token usage",
			refresh: "Refresh",
			loading: "Loading…",
			error: "Token stats unavailable",
			errorHint: "server half not loaded or request failed",
			retry: "Retry",
			today: "Today",
			month: "This month",
			total: "All time",
			prevYear: "Previous year",
			nextYear: "Next year",
			less: "Less",
			more: "More",
			cellTokens: "{date} · {tokens} tokens",
			weekdayLabel: ["M", "T", "W", "T", "F", "S", "S"],
			monthName: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
			levelLegend: ["0", "<1M", "1M–10M", "10M–100M", "≥100M"],
			settingsTitle: "Token usage heatmap",
			settingsDescription: "Display and colors of the token heatmap on the new-session screen.",
			settingsEnabled: "Show heatmap",
			settingsEnabledHint: "When off, the token heatmap below the composer is hidden.",
			settingsScheme: "Color scheme",
			settingsSchemeHint: "Cell palette: green is the classic GitHub style; the rest are new themes.",
			settingsGreen: "Green",
			settingsBlue: "Blue",
			settingsOrange: "Orange",
			settingsRed: "Red",
			settingsPurple: "Purple",
			settingsTeal: "Teal",
			settingsSave: "Save",
			settingsSaving: "Saving…",
			settingsDiscard: "Discard",
			settingsUnsaved: "Unsaved",
			settingsSaveFailed: "Save failed; your changes were kept.",
			settingsLoadFailed: "Failed to load configuration.",
			settingsRetry: "Retry",
			settingsExpand: "Show settings",
			settingsCollapse: "Hide settings"
		};
		//#endregion

		//#region helpers
		/** Locale-safe template interpolation: `t("key", {a})` replaces `{a}`. */
		function interpolate(template, params) {
			if (params === void 0) return template;
			return template.replace(/\{(\w+)\}/g, (match, key) => (Object.hasOwn(params, key) ? String(params[key]) : match));
		}

		/** Group thousands. */
		function fmt(n) {
			return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
		}

		/** Compact form: 1234 → "1.2k"; 61M → "61m"; 4.2B → "4.2b". */
		function fmtCompact(n) {
			if (n < 1000) return String(n);
			if (n < 1000000) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
			if (n < 1000000000) return `${(n / 1000000).toFixed(n < 10000000 ? 1 : 0)}m`;
			return `${(n / 1000000000).toFixed(n < 10000000000 ? 1 : 0)}b`;
		}

		/** Local-calendar `YYYY-MM-DD` key. */
		function dayKey(timeMs) {
			const date = new Date(timeMs);
			const month = String(date.getMonth() + 1).padStart(2, "0");
			const day = String(date.getDate()).padStart(2, "0");
			return `${date.getFullYear()}-${month}-${day}`;
		}

		/** Local-calendar `YYYY-MM` key. */
		function monthKey(timeMs) {
			const date = new Date(timeMs);
			return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
		}

		/** `YYYY-MM-DD` → `YYYY-MM` without any timezone parsing. */
		function monthOfDateKey(key) {
			return key.slice(0, 7);
		}

		/**
		 * Pick the display dictionary for locale-shaped helpers (month names,
		 * weekday labels, date formatting). The locale plugin resolves the UI
		 * language from `navigator.languages`, so mirror that probe here.
		 */
		function uiDict() {
			const candidates = typeof navigator !== "undefined"
				? [...(navigator.languages ?? []), navigator.language].filter(Boolean)
				: [];
			return candidates.some((tag) => tag.toLowerCase().startsWith("zh")) ? zh : en;
		}

		/** Display date "8月13日" / "Aug 13". */
		function dateLabel(key) {
			const [year, month, day] = key.split("-").map(Number);
			const names = uiDict().monthName;
			return `${names[month - 1]} ${day}日`;
		}

		/** Per-request staleness guard: only the most recent start may `isCurrent()`. */
		function createLoader() {
			let current = 0;
			return {
				start: () => ++current,
				isCurrent: (id) => id === current
			};
		}

		async function fetchJson(path) {
			const response = await fetch(path, { headers: { accept: "application/json" } });
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const payload = await response.json();
			if (payload === null || typeof payload !== "object") throw new Error("unexpected response");
			return payload;
		}

		async function postJson(path, body) {
			const response = await fetch(path, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body)
			});
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const payload = await response.json();
			if (payload === null || typeof payload !== "object") throw new Error("unexpected response");
			return payload;
		}

		/**
		 * Cell palettes by scheme, level 0 (empty) → 4 (peak). Green is the
		 * classic GitHub scale; the others are ColorBrewer single-hue ramps
		 * (blue/orange/red/purple) plus a custom teal. The active scheme comes
		 * from the settings card (配置 → 配色方案), persisted by the server
		 * half's config endpoint.
		 */
		const COLOR_SCHEMES = {
			green: ["rgba(128,128,128,0.15)", "#9be9a8", "#40c463", "#30a14e", "#216e39"],
			blue: ["rgba(128,128,128,0.15)", "#c6dbef", "#6baed6", "#3182bd", "#08519c"],
			orange: ["rgba(128,128,128,0.15)", "#fdd0a2", "#fdae6b", "#fd8d3c", "#d94801"],
			red: ["rgba(128,128,128,0.15)", "#fcbba1", "#fc9272", "#fb6a4a", "#cb181d"],
			purple: ["rgba(128,128,128,0.15)", "#bcbddc", "#9e9ac8", "#807dba", "#6a51a3"],
			teal: ["rgba(128,128,128,0.15)", "#99f6e4", "#2dd4bf", "#14b8a6", "#0f766e"]
		};
		/** Backward-compatible alias: the default (green) palette. */
		const CELL_COLORS = COLOR_SCHEMES.green;

		/**
		 * ABSOLUTE token thresholds per day (not relative ranks), so a large
		 * day is always dark no matter what its neighbours look like:
		 *   level 0: 0 tokens
		 *   level 1: 1 .. 1M
		 *   level 2: 1M .. 10M
		 *   level 3: 10M .. 100M
		 *   level 4: ≥ 100M
		 * e.g. 61M/day is level 3 (#30a14e, dark-ish green).
		 */
		function levelOf(tokens) {
			if (tokens <= 0) return 0;
			if (tokens < 1e6) return 1;
			if (tokens < 1e7) return 2;
			if (tokens < 1e8) return 3;
			return 4;
		}

		/**
		 * Build the GitHub-style grid for a CALENDAR YEAR (Jan 1 – Dec 31,
		 * local time). Columns are weeks (Mon-first), aligned so the first
		 * column starts on the Monday of the week containing Jan 1; cells
		 * outside the year are null, and days after today render as empty
		 * level-0 cells so the full year layout stays visible (for past years
		 * no day is in the future, so every in-year cell shows real or empty
		 * data). Month labels span the columns they cover (Jan..Dec).
		 * @param dayMap - date key → tokens.
		 * @param now - reference timestamp.
		 * @param year - calendar year to render; defaults to the year of `now`.
		 * @returns `{ columns, monthStarts }` where each column is
		 *   `{ month, cells: Array<{key, tokens, level} | null> }`.
		 */
		function buildGrid(dayMap, now, year) {
			const nowDate = new Date(now);
			const gridYear = year ?? nowDate.getFullYear();
			const yearStart = new Date(gridYear, 0, 1);
			const yearEnd = new Date(gridYear, 11, 31);
			const startKey = dayKey(yearStart.getTime());
			const endKey = dayKey(yearEnd.getTime());
			const todayKey = dayKey(nowDate.getTime());
			const firstColumn = new Date(yearStart.getFullYear(), yearStart.getMonth(), yearStart.getDate() - ((yearStart.getDay() + 6) % 7));
			const columns = [];
			const monthStarts = [];
			const cursor = new Date(firstColumn);
			while (cursor.getTime() <= yearEnd.getTime()) {
				const columnStartKey = dayKey(cursor.getTime());
				const cells = [];
				for (let d = 0; d < 7; d += 1) {
					const key = dayKey(cursor.getTime());
					if (key < startKey || key > endKey) {
						cells.push(null);
					} else {
						const future = key > todayKey;
						const tokens = future ? 0 : (dayMap.get(key) ?? 0);
						cells.push({ key, tokens, level: levelOf(tokens) });
					}
					cursor.setDate(cursor.getDate() + 1);
				}
				// Label the column by the month of its first in-year day; the
				// very first column may start in December of the previous year.
				const columnMonth = monthOfDateKey(cells.find((cell) => cell !== null)?.key ?? columnStartKey);
				columns.push({ month: columnMonth, cells });
				if (monthStarts.length === 0 || monthStarts[monthStarts.length - 1].month !== columnMonth) {
					monthStarts.push({ month: columnMonth, index: columns.length - 1 });
				}
			}
			return { columns, monthStarts };
		}
		//#endregion

		//#region TokenHeatmap
		/**
		 * The heatmap card. Shown only on the new-session hero screen
		 * (`composerPhase === "blank"`); a flex `order` on the wrapper places
		 * it below the composer input card.
		 * @param props - `session`/`input` from the InputZone owner share, `t`
		 *   bound by the slot runtime locale seat.
		 */
		function TokenHeatmap({ session, input, t }) {
			const dict = t !== void 0 ? t : (key) => zh[key] ?? key;
			const translate = (key, params) => interpolate(dict(key), params);
			const [data, setData] = react.useState(null);
			const [config, setConfig] = react.useState(null);
			const [error, setError] = react.useState(null);
			const [loading, setLoading] = react.useState(false);
			const [year, setYear] = react.useState(() => new Date().getFullYear());
			const loaderRef = react.useRef(null);
			if (loaderRef.current === null) loaderRef.current = createLoader();
			const load = react.useCallback(async () => {
				const id = loaderRef.current.start();
				setLoading(true);
				try {
					const [payload, cfg] = await Promise.all([
						fetchJson("/api/token-heatmap/usage"),
						fetchJson("/api/token-heatmap/config")
					]);
					if (loaderRef.current.isCurrent(id)) {
						setData(payload);
						setConfig(cfg);
						setError(null);
					}
				} catch (err) {
					if (loaderRef.current.isCurrent(id)) setError(err instanceof Error ? err.message : String(err));
				} finally {
					if (loaderRef.current.isCurrent(id)) setLoading(false);
				}
			}, []);
			react.useEffect(() => {
				load();
				const timer = window.setInterval(load, 5 * 60 * 1000);
				const onVisible = () => {
					if (document.visibilityState === "visible") load();
				};
				document.addEventListener("visibilitychange", onVisible);
				return () => {
					window.clearInterval(timer);
					document.removeEventListener("visibilitychange", onVisible);
				};
			}, [load]);

			// New-session hero only: a blank session whose composer is still in
			// the guidance phase. Conversed sessions hide the card.
			if (session === void 0 || session === null || input === void 0 || input === null) return null;
			if (session.composerPhase !== "blank") return null;
			// Master switch from the settings card (设置 → 插件 → 插件配置).
			if (config !== null && config.enabled === false) return null;

			const now = Date.now();
			// Year-selector bounds: the current year at most (no future usage),
			// and at least the earliest year present in the data so the selector
			// cannot wander into guaranteed-empty territory.
			const nowYear = new Date(now).getFullYear();
			let minYear = nowYear;
			for (const day of data?.days ?? []) {
				const y = Number(day.date.slice(0, 4));
				if (y < minYear) minYear = y;
			}
			const maxYear = nowYear;
			const todayTokens = data?.days?.find((day) => day.date === dayKey(now))?.tokens ?? 0;
			const monthPrefix = monthKey(now);
			let monthTokens = 0;
			for (const day of data?.days ?? []) {
				if (day.date.startsWith(monthPrefix)) monthTokens += day.tokens;
			}
			const totalTokens = data?.total ?? 0;

			const dayMap = new Map();
			for (const day of data?.days ?? []) dayMap.set(day.date, day.tokens);
			const grid = buildGrid(dayMap, now, year);
			const levelLegend = uiDict().levelLegend;
			// Palette from the settings card; unknown schemes fall back to green.
			const palette = COLOR_SCHEMES[config?.colorScheme] ?? COLOR_SCHEMES.green;

			const stats = [
				{ label: dict("today"), value: todayTokens },
				{ label: dict("month"), value: monthTokens },
				{ label: dict("total"), value: totalTokens }
			];

			let body;
			if (error !== null) {
				body = react_jsx_runtime.jsxs("div", {
					className: S.error,
					children: [
						react_jsx_runtime.jsx("span", {
							children: `${dict("error")}（${dict("errorHint")}）`
						}),
						react_jsx_runtime.jsx("button", {
							type: "button",
							className: S.retry,
							onClick: load,
							children: dict("retry")
						})
					]
				});
			} else if (data === null) {
				body = react_jsx_runtime.jsx("div", {
					className: S.loading,
					children: dict("loading")
				});
			} else {
				body = react_jsx_runtime.jsxs("div", {
					className: S.card,
					children: [
						react_jsx_runtime.jsxs("div", {
							className: S.head,
							children: [
								react_jsx_runtime.jsx("span", { className: S.title, children: dict("title") }),
								...stats.map((stat) => react_jsx_runtime.jsxs("span", {
									className: S.stat,
									title: `${stat.label}: ${fmt(stat.value)}`,
									children: [
										react_jsx_runtime.jsx("span", { className: S.statLabel, children: stat.label }),
										react_jsx_runtime.jsx("span", { className: S.statValue, children: fmtCompact(stat.value) })
									]
								}, stat.label)),
								react_jsx_runtime.jsxs("span", {
									className: S.yearNav,
									children: [
										react_jsx_runtime.jsx("button", {
											type: "button",
											className: S.yearBtn,
											disabled: year <= minYear,
											onClick: () => setYear(year - 1),
											"aria-label": dict("prevYear"),
											children: "\u2039"
										}),
										react_jsx_runtime.jsx("span", { className: S.yearLabel, children: String(year) }),
										react_jsx_runtime.jsx("button", {
											type: "button",
											className: S.yearBtn,
											disabled: year >= maxYear,
											onClick: () => setYear(year + 1),
											"aria-label": dict("nextYear"),
											children: "\u203a"
										})
									]
								}),
								react_jsx_runtime.jsx("button", {
									type: "button",
									className: S.refresh,
									disabled: loading,
									onClick: load,
									children: dict("refresh")
								})
							]
						}),
						react_jsx_runtime.jsx("div", {
							className: S.gridWrap,
							children: react_jsx_runtime.jsxs("div", {
								className: S.grid,
								children: [
									react_jsx_runtime.jsx("div", {
										className: S.months,
										children: grid.monthStarts.map((entry, index) => {
											const span = index + 1 < grid.monthStarts.length ? grid.monthStarts[index + 1].index - entry.index : grid.columns.length - entry.index;
											// One column = 10px cell + 2px gap = 12px; the label
											// box must span exactly N columns (no -2: there is no
											// gap between month labels, so a short box would drift
											// left by 2px per month).
											return react_jsx_runtime.jsx("span", {
												className: S.monthLabel,
												style: { width: span * 12 },
												children: uiDict().monthName[Number(entry.month.slice(5)) - 1]
											}, entry.month);
										})
									}),
									...Array.from({ length: 7 }, (_, row) => {
										const label = uiDict().weekdayLabel[row] ?? "";
										return react_jsx_runtime.jsxs("div", {
											className: S.row,
											children: [
												react_jsx_runtime.jsx("span", { className: S.rowLabel, children: label }),
												...grid.columns.map((column) => {
													const cell = column.cells[row];
													if (cell === null) {
														return react_jsx_runtime.jsx("span", { className: S.cell }, `${column.month}-${row}-null`);
													}
													return react_jsx_runtime.jsx("span", {
														className: S.cell,
														style: { background: palette[cell.level] },
														title: translate("cellTokens", { date: dateLabel(cell.key), tokens: fmt(cell.tokens) })
													}, cell.key);
												})
											]
										}, `row-${row}`);
									}),
									react_jsx_runtime.jsx("div", {
										className: S.row,
										children: [
											react_jsx_runtime.jsx("span", { className: S.rowLabel, children: "" }),
											react_jsx_runtime.jsx("span", {
												className: S.legend,
												children: [
													dict("less"),
													...palette.map((color, level) => react_jsx_runtime.jsx("span", {
														className: S.legendCell,
														style: { background: color },
														title: levelLegend[level] ?? ""
													}, `lvl-${level}`)),
													dict("more")
												]
											})
										]
									})
								]
							})
						})
					]
				});
			}

			return react_jsx_runtime.jsx("div", {
				className: S.dock,
				style: { order: 99 },
				children: body
			});
		}
		//#endregion

		//#region TokenHeatmapSettingsCard
		/**
		 * The plugin settings card, rendered inside the official
		 * 设置 → 插件 → 插件配置 tab (the `settings.plugin.item` seat).
		 *
		 * The Host only exposes its own allowlisted settings namespaces to the
		 * Web client, so this card does NOT bind a settingsScope; instead it
		 * reads/writes the plugin's own loopback config endpoint and stages a
		 * draft until the user saves, mirroring the official card chrome
		 * (disclosure header, unsaved badge, discard/save footer).
		 * @param props - `t` bound by the slot runtime locale seat.
		 */
		function TokenHeatmapSettingsCard({ t }) {
			const dict = t !== void 0 ? t : (key) => zh[key] ?? key;
			const [open, setOpen] = react.useState(false);
			const [loaded, setLoaded] = react.useState(null);
			const [draft, setDraft] = react.useState(null);
			const [saving, setSaving] = react.useState(false);
			const [saveFailed, setSaveFailed] = react.useState(false);
			const [loadFailed, setLoadFailed] = react.useState(false);
			const load = react.useCallback(async () => {
				try {
					const payload = await fetchJson("/api/token-heatmap/config");
					setLoaded(payload);
					setDraft(payload);
					setLoadFailed(false);
					setSaveFailed(false);
				} catch {
					setLoadFailed(true);
				}
			}, []);
			react.useEffect(() => {
				load();
			}, [load]);

			const dirty = loaded !== null && draft !== null && (draft.enabled !== loaded.enabled || draft.colorScheme !== loaded.colorScheme);
			const save = react.useCallback(async () => {
				if (draft === null || saving) return;
				setSaving(true);
				setSaveFailed(false);
				try {
					const payload = await postJson("/api/token-heatmap/config", draft);
					setLoaded(payload);
					setDraft(payload);
				} catch {
					setSaveFailed(true);
				} finally {
					setSaving(false);
				}
			}, [draft, saving]);
			const discard = () => {
				if (loaded !== null) setDraft(loaded);
				setSaveFailed(false);
			};
			const toggleEnabled = () => {
				if (draft !== null) setDraft({ ...draft, enabled: !draft.enabled });
			};
			const chooseScheme = (scheme) => {
				if (draft !== null) setDraft({ ...draft, colorScheme: scheme });
			};
			const title = dict("settingsTitle");

			let bodyContent;
			if (loadFailed) {
				bodyContent = react_jsx_runtime.jsxs("p", {
					className: S.settingsError,
					children: [
						dict("settingsLoadFailed"),
						" ",
						react_jsx_runtime.jsx("button", {
							type: "button",
							className: S.settingsRetry,
							onClick: load,
							children: dict("settingsRetry")
						})
					]
				});
			} else if (loaded === null || draft === null) {
				bodyContent = react_jsx_runtime.jsx("p", {
					className: S.settingsLoading,
					children: dict("loading")
				});
			} else {
				bodyContent = react_jsx_runtime.jsxs(react_jsx_runtime.Fragment, {
					children: [
						react_jsx_runtime.jsx("div", {
							className: S.settingsField,
							children: react_jsx_runtime.jsxs("div", {
								className: S.settingsSwitchRow,
								children: [
									react_jsx_runtime.jsx("button", {
										type: "button",
										role: "switch",
										"aria-checked": draft.enabled,
										"aria-label": dict("settingsEnabled"),
										disabled: saving,
										className: draft.enabled ? `${S.settingsSwitch} ${S.settingsSwitchOn}` : S.settingsSwitch,
										onClick: toggleEnabled,
										children: react_jsx_runtime.jsx("span", { className: S.settingsThumb })
									}),
									react_jsx_runtime.jsx("span", { className: S.settingsFieldLabel, children: dict("settingsEnabled") })
								]
							})
						}),
						react_jsx_runtime.jsx("p", {
							className: S.settingsFieldHint,
							children: dict("settingsEnabledHint")
						}),
						react_jsx_runtime.jsxs("div", {
							className: S.settingsField,
							children: [
								react_jsx_runtime.jsx("span", { className: S.settingsFieldLabel, children: dict("settingsScheme") }),
								react_jsx_runtime.jsx("div", {
									className: S.settingsSwatches,
									children: Object.keys(COLOR_SCHEMES).map((scheme) => react_jsx_runtime.jsx("button", {
										type: "button",
										disabled: saving,
										className: S.settingsSwatch,
										"data-active": draft.colorScheme === scheme,
										onClick: () => chooseScheme(scheme),
										children: [
											react_jsx_runtime.jsx("span", {
												className: S.settingsSwatchCells,
												children: COLOR_SCHEMES[scheme].slice(1).map((color, index) => react_jsx_runtime.jsx("span", {
													className: S.settingsSwatchCell,
													style: { background: color }
												}, `cell-${index}`))
											}),
											react_jsx_runtime.jsx("span", {
												className: S.settingsSwatchLabel,
												children: dict(`settings${scheme[0].toUpperCase()}${scheme.slice(1)}`)
											})
										]
									}, scheme))
								})
							]
						}),
						react_jsx_runtime.jsx("p", {
							className: S.settingsFieldHint,
							children: dict("settingsSchemeHint")
						}),
						react_jsx_runtime.jsxs("div", {
							className: S.settingsFooter,
							children: [
								saveFailed ? react_jsx_runtime.jsx("p", {
									className: S.settingsFooterError,
									children: dict("settingsSaveFailed")
								}) : null,
								react_jsx_runtime.jsx("button", {
									type: "button",
									className: `${S.settingsBtn} ${S.settingsDiscard}`,
									disabled: !dirty || saving,
									onClick: discard,
									children: dict("settingsDiscard")
								}),
								react_jsx_runtime.jsx("button", {
									type: "button",
									className: `${S.settingsBtn} ${S.settingsSave}`,
									disabled: !dirty || saving,
									onClick: save,
									children: dict(saving ? "settingsSaving" : "settingsSave")
								})
							]
						})
					]
				});
			}

			return react_jsx_runtime.jsxs("li", {
				className: open ? `${S.settingsCard} ${S.settingsCardOpen}` : S.settingsCard,
				children: [
					react_jsx_runtime.jsxs("button", {
						type: "button",
						className: S.settingsHeader,
						"aria-expanded": open,
						"aria-label": `${dict(open ? "settingsCollapse" : "settingsExpand")}: ${title}`,
						onClick: () => setOpen(!open),
						children: [
							react_jsx_runtime.jsxs("span", {
								className: S.settingsHeadText,
								children: [
									react_jsx_runtime.jsx("span", { className: S.settingsName, children: title }),
									react_jsx_runtime.jsx("span", { className: S.settingsDesc, children: dict("settingsDescription") })
								]
							}),
							dirty ? react_jsx_runtime.jsx("span", {
								className: S.settingsPending,
								children: dict("settingsUnsaved")
							}) : null,
							react_jsx_runtime.jsx("svg", {
								width: 14,
								height: 14,
								className: open ? `${S.settingsChevron} ${S.settingsChevronOpen}` : S.settingsChevron,
								viewBox: "0 0 14 14",
								fill: "none",
								xmlns: "http://www.w3.org/2000/svg",
								children: react_jsx_runtime.jsx("path", {
									d: "M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z",
									fill: "currentColor"
								})
							})
						]
					}),
					open ? react_jsx_runtime.jsx("div", {
						className: S.settingsBody,
						children: bodyContent
					}) : null
				]
			});
		}
		//#endregion

		//#region plugin body
		/** Services required by the client plugin body. */
		const inject = ["slots", "locale"];

		/**
		 * Client plugin body: register the dictionaries, the input-dock entry
		 * (heatmap below the composer card on the new-session screen) and the
		 * plugin settings card (设置 → 插件 → 插件配置).
		 *
		 * Slot-kind contract: `conversation.input.dock` is a LIST slot, so its
		 * registration is keyed by `id`; `settings.plugin.item` is a KEYED slot,
		 * so its registration must carry `key` (the settings namespace the card
		 * edits) — registering with `id` instead throws
		 * `keyed slot "settings.plugin.item" requires options.key` and fails
		 * the whole plugin load.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "token-heatmap: dictionaries");
			ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
				name: "conversation.input.dock",
				id: "token-heatmap",
				order: 10,
				locale: NS
			}, TokenHeatmap));
			ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
				name: "settings.plugin.item",
				key: "token-heatmap",
				order: 30,
				locale: NS
			}, TokenHeatmapSettingsCard));
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		exports.TokenHeatmap = TokenHeatmap;
		exports.TokenHeatmapSettingsCard = TokenHeatmapSettingsCard;
		exports.buildGrid = buildGrid;
		exports.levelOf = levelOf;
		exports.CELL_COLORS = CELL_COLORS;
		exports.COLOR_SCHEMES = COLOR_SCHEMES;
		return module.exports;
	}
});
