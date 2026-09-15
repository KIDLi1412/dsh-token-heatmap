/**
 * dsh-token-heatmap — browser half.
 *
 * Hand-written `__ModuleLoader__` bundle (no build step): registers into the
 * conversation `input.dock` list slot and renders a GitHub-style token-usage
 * card on the new-session (hero) screen — a calendar-year grid (Jan 1 – Dec 31;
 * columns = weeks, rows = Mon..Sun, all seven weekday labels on the left) or a
 * single-month calendar, switchable from the header, plus today / this-month /
 * all-time totals and a ‹period› stepper. The card configures ITSELF through a
 * ⚙ panel (palette + default view) persisted in the `token-heatmap` settings
 * namespace (settings scope); it deliberately does not register into the
 * official `settings.plugin.item` seat (设置 → 插件 → 插件配置), so all of its
 * settings live on the card.
 *
 * The card is shown ONLY on the new-session (hero) screen — gated on the
 * boolean `session.blank`, with `composerPhase === "blank"` as the pre-0.1.2
 * fallback — and is positioned visually BELOW the composer input card via a
 * flex `order` on the dock wrapper (the dock's DOM site sits above the bar, but
 * the composer stack is a flex column and the framework's true below-card seat
 * `composer.dock` is disabled on the hero screen). There is no display switch:
 * the hero screen always renders it.
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
		// Only for the settings panel, which is PORTALED to document.body so the
		// card's own box can never clip it (the pattern the stat pills use).
		let reactDom = require("react-dom");

		//#region css
		const css = [
			// Surface matched to the composer card above it (measured computed
			// styles): same 22px radius, no hard border — the edge is the same
			// hairline + soft drop the composer uses — and the same 16px inner
			// inset, so the card's text lines up with the composer's placeholder.
			".thm_dock{box-sizing:border-box;width:100%;max-width:var(--dsh-composer-card-max-width,780px);margin:0 auto;padding:0;display:flex;flex-direction:column;gap:8px}",
			".thm_card{box-sizing:border-box;background:var(--dsw-alias-bg-base);border:none;border-radius:22px;box-shadow:0 0 0 .5px rgba(0,0,0,.1),0 4px 16px rgba(0,0,0,.03),0 0 24px rgba(0,0,0,.03);padding:14px 16px 16px;display:flex;flex-direction:column;gap:8px}",
			".thm_head{flex-wrap:wrap;align-items:baseline;gap:4px 12px;display:flex}",
			".thm_title{color:var(--dsw-alias-label-primary);font-size:12px;font-weight:600;line-height:18px}",
			".thm_stat{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}",
			".thm_statLabel{margin-right:4px}",
			".thm_statValue{color:var(--dsw-alias-label-primary);font-size:12px;font-weight:600;line-height:18px;font-variant-numeric:tabular-nums}",
			".thm_nav{align-items:center;gap:2px;display:inline-flex}",
			".thm_yearBtn{cursor:pointer;color:var(--dsw-alias-label-tertiary);background:0 0;border:none;border-radius:4px;padding:0 5px;font-size:13px;line-height:18px}",
			".thm_yearBtn:hover:not(:disabled){color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover)}",
			".thm_yearBtn:disabled{opacity:.35;cursor:default}",
			".thm_yearLabel{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;min-width:36px;text-align:center;font-variant-numeric:tabular-nums}",
			".thm_monthLabelNav{min-width:62px}",
			".thm_viewNav{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;align-items:center;display:inline-flex;overflow:hidden}",
			".thm_viewBtn{cursor:pointer;color:var(--dsw-alias-label-tertiary);background:0 0;border:none;padding:1px 10px;font:inherit;font-size:11px;line-height:18px}",
			".thm_viewBtn:hover:not(:disabled){color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover)}",
			".thm_viewBtn[data-active=true]{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover);font-weight:600}",
			".thm_viewBtn:disabled{opacity:.4;cursor:default}",
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
			// The calendar spans the card's full content width, so the weekday
			// rail (一) starts exactly under the "Token 用量" title.
			".thm_monthCal{display:flex;flex-direction:column;gap:3px}",
			".thm_weekHead{display:flex;gap:4px}",
			".thm_weekHeadCell{color:var(--dsw-alias-label-tertiary);flex:1;min-width:0;font-size:9px;line-height:12px;text-align:center}",
			".thm_week{display:flex;gap:4px}",
			".thm_day{box-sizing:border-box;flex:1;min-width:0;height:38px;border-radius:5px;flex-direction:column;align-items:center;justify-content:center;gap:1px;display:flex}",
			".thm_day[data-weekend=true]:not([data-empty=true]){background-color:var(--dsw-alias-interactive-bg-hover)}",
			".thm_dayNum{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:13px;font-variant-numeric:tabular-nums}",
			".thm_dayTokens{color:var(--dsw-alias-label-tertiary);font-size:8px;line-height:10px;font-variant-numeric:tabular-nums}",
			".thm_day[data-level=\"2\"] .thm_dayNum,.thm_day[data-level=\"3\"] .thm_dayNum,.thm_day[data-level=\"4\"] .thm_dayNum{color:#fff;text-shadow:0 1px 2px rgba(0,0,0,.28)}",
			".thm_day[data-level=\"2\"] .thm_dayTokens,.thm_day[data-level=\"3\"] .thm_dayTokens,.thm_day[data-level=\"4\"] .thm_dayTokens{color:rgba(255,255,255,.82)}",
			".thm_legend{align-items:center;justify-content:flex-end;gap:3px;font-size:10px;line-height:14px;display:flex;color:var(--dsw-alias-label-tertiary)}",			".thm_legendCell{box-sizing:border-box;width:9px;height:9px;border-radius:2px}",
			".thm_error{color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover-danger);border-radius:8px;padding:7px 8px;font-size:11px;line-height:16px;display:flex;justify-content:space-between;align-items:center;gap:8px}",
			".thm_retry{color:inherit;font:inherit;cursor:pointer;background:0 0;border:none;flex:none;padding:0}",
			".thm_loading{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;padding:6px 2px}",
			// The ⚙ at the row's right end opens a floating pill panel — the
			// card configures itself; nothing registers into 设置 → 插件 → 插件配置.
			".thm_gear{cursor:pointer;color:var(--dsw-alias-label-tertiary);background:0 0;border:none;border-radius:6px;align-items:center;padding:2px 4px;display:inline-flex}",
			".thm_gear:hover{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover)}",
			".thm_gear[data-active=true]{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}",
			// The settings panel mirrors DSH's own pill dialogs: portaled to
			// document.body, position:fixed (so the card can never clip it),
			// measure-then-place above the ⚙ and clamped to the viewport, with
			// the shipped dialog surface + elevation tokens.
			".thm_panel{position:fixed;z-index:1100;box-sizing:border-box;background:var(--dsw-specific-menu,#fff);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);width:400px;max-width:calc(100vw - 24px);box-shadow:var(--dsw-elevation-prominent,0 8px 32px rgba(0,0,0,.16));color:var(--dsw-alias-label-secondary);cursor:default;border:0;border-radius:12px;padding:16px;font-size:12px;line-height:18px;text-align:left;font-weight:400}",
			".thm_panelHead{color:var(--dsw-alias-label-primary);justify-content:space-between;align-items:center;gap:16px;margin-bottom:8px;font-weight:500;display:flex}",
			".thm_panelTitleLabel{align-items:center;gap:6px;display:inline-flex}",
			".thm_panelTitleLabel svg{flex:none;width:14px;height:14px}",
			".thm_panelRule{border-top:.5px solid var(--dsw-alias-border-l2);margin-bottom:12px}",
			".thm_group{flex-direction:column;gap:5px;display:flex}",
			".thm_group+.thm_group{margin-top:14px}",
			".thm_groupLabel{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}",
			".thm_swatches{flex-wrap:wrap;gap:6px;display:flex}",
			".thm_swatch{cursor:pointer;align-items:center;gap:6px;border:1px solid var(--dsw-alias-border-l2);background:0 0;border-radius:6px;padding:3px 8px;font:inherit;display:flex}",
			".thm_swatch:hover{border-color:var(--dsw-alias-label-dimmed)}",
			".thm_swatch[data-active=true]{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 1px var(--dsw-alias-state-business-primary) inset}",
			".thm_swatchCells{display:flex;gap:2px}",
			".thm_swatchCell{width:9px;height:9px;border-radius:2px}",
			".thm_swatchLabel{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}",
			".thm_seg{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;align-items:center;display:inline-flex;overflow:hidden;width:max-content}",
			".thm_segBtn{cursor:pointer;color:var(--dsw-alias-label-tertiary);background:0 0;border:none;padding:1px 10px;font:inherit;font-size:11px;line-height:18px}",
			".thm_segBtn:hover{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover)}",
			".thm_segBtn[data-active=true]{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover);font-weight:600}",
			".thm_panelFoot{border-top:.5px solid var(--dsw-alias-border-l2);margin-top:14px;padding-top:10px}",
			".thm_footLegend{align-items:center;gap:3px;font-size:10px;line-height:14px;display:flex;color:var(--dsw-alias-label-tertiary)}",
			".thm_footRule{color:var(--dsw-alias-label-caption);margin-top:6px;font-size:10px;line-height:14px}",
			".thm_footError{color:var(--dsw-alias-state-error-primary);margin-top:6px;font-size:10px;line-height:14px}"
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
			nav: "thm_nav",
			yearBtn: "thm_yearBtn",
			yearLabel: "thm_yearLabel",
			monthLabelNav: "thm_monthLabelNav",
			viewNav: "thm_viewNav",
			viewBtn: "thm_viewBtn",
			refresh: "thm_refresh",
			gridWrap: "thm_gridWrap",
			grid: "thm_grid",
			months: "thm_months",
			monthLabel: "thm_monthLabel",
			row: "thm_row",
			rowLabel: "thm_rowLabel",
			cell: "thm_cell",
			monthCal: "thm_monthCal",
			weekHead: "thm_weekHead",
			weekHeadCell: "thm_weekHeadCell",
			week: "thm_week",
			day: "thm_day",
			dayNum: "thm_dayNum",
			dayTokens: "thm_dayTokens",
			legend: "thm_legend",
			legendCell: "thm_legendCell",
			error: "thm_error",
			retry: "thm_retry",
			loading: "thm_loading",
			gear: "thm_gear",
			settingsPanel: "thm_panel",
			panelHead: "thm_panelHead",
			panelTitleLabel: "thm_panelTitleLabel",
			panelRule: "thm_panelRule",
			panelFoot: "thm_panelFoot",
			footLegend: "thm_footLegend",
			footRule: "thm_footRule",
			footError: "thm_footError",
			settingsGroup: "thm_group",
			settingsGroupLabel: "thm_groupLabel",
			settingsSwatches: "thm_swatches",
			settingsSwatch: "thm_swatch",
			settingsSwatchCells: "thm_swatchCells",
			settingsSwatchCell: "thm_swatchCell",
			settingsSwatchLabel: "thm_swatchLabel",
			seg: "thm_seg",
			segBtn: "thm_segBtn"
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
			prevMonth: "上一月",
			nextMonth: "下一月",
			viewYear: "年",
			viewMonth: "月",
			viewLabel: "视图",
			less: "少",
			more: "多",
			cellTokens: "{date} · {tokens} tokens",
			weekdayLabel: ["一", "二", "三", "四", "五", "六", "日"],
			monthName: ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"],
			dayLabel: (monthName, day) => `${monthName}${day}日`,
			monthYear: (year, monthName) => `${year}年${monthName}`,
			levelLegend: ["0", "<1M", "1M–10M", "10M–100M", "≥100M"],
			settingsTitle: "Token 用量热力图",
			settingsScheme: "配色方案",
			settingsSchemeHint: "热力图格子的颜色主题：绿色为经典 GitHub 风格，其余为新增配色。",
			settingsDefaultView: "默认视图",
			settingsDefaultViewHint: "新会话页面首次打开时显示的视图（标题行右端可随时切换）。",
			settingsGreen: "绿色",
			settingsBlue: "蓝色",
			settingsOrange: "橙色",
			settingsRed: "红色",
			settingsPurple: "紫色",
			settingsTeal: "青色",
			settingsThresholdNote: "颜色按每天 token 数的绝对阈值分档（悬停图例看各档范围）。",
			settingsSaveFailed: "保存失败，已回到服务端的值，请重试。",
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
			prevMonth: "Previous month",
			nextMonth: "Next month",
			viewYear: "Year",
			viewMonth: "Month",
			viewLabel: "View",
			less: "Less",
			more: "More",
			cellTokens: "{date} · {tokens} tokens",
			weekdayLabel: ["M", "T", "W", "T", "F", "S", "S"],
			monthName: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
			dayLabel: (monthName, day) => `${monthName} ${day}`,
			monthYear: (year, monthName) => `${monthName} ${year}`,
			levelLegend: ["0", "<1M", "1M–10M", "10M–100M", "≥100M"],
			settingsTitle: "Token usage heatmap",
			settingsScheme: "Color scheme",
			settingsSchemeHint: "Cell palette: green is the classic GitHub style; the rest are new themes.",
			settingsDefaultView: "Default view",
			settingsDefaultViewHint: "The view the new-session screen opens with (switchable anytime at the row's right end).",
			settingsGreen: "Green",
			settingsBlue: "Blue",
			settingsOrange: "Orange",
			settingsRed: "Red",
			settingsPurple: "Purple",
			settingsTeal: "Teal",
			settingsThresholdNote: "Colors follow absolute per-day token thresholds (hover the legend for each range).",
			settingsSaveFailed: "Save failed; the server value was restored.",
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
		 * Step a `YYYY-MM` key by whole months ("2026-01" -1 → "2025-12"),
		 * returning the input unchanged when it is not a month key.
		 * @param key - `YYYY-MM` month key.
		 * @param delta - signed month count.
		 */
		function shiftMonthKey(key, delta) {
			const [year, month] = key.split("-").map(Number);
			if (!Number.isFinite(year) || !Number.isFinite(month)) return key;
			const date = new Date(year, month - 1 + delta, 1);
			return monthKey(date.getTime());
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

		/**
		 * Display date "8月13日" / "Aug 13" — the whole shape comes from the
		 * dictionary, so an English UI never renders a Chinese 日 and the
		 * Chinese one never grows a space before it.
		 */
		function dateLabel(key) {
			const [year, month, day] = key.split("-").map(Number);
			const dict = uiDict();
			return dict.dayLabel(dict.monthName[month - 1], day);
		}

		/**
		 * Month-key navigation label, ordered per locale: "2026年8月" in Chinese
		 * (year first), "Aug 2026" in English (month first) — each dictionary
		 * owns its ordering rather than both sharing a Chinese-shaped template.
		 */
		function monthLabelFull(key) {
			const [year, month] = key.split("-").map(Number);
			const dict = uiDict();
			return dict.monthYear(year, dict.monthName[month - 1]);
		}

		/** Heatmap view modes: the calendar-year grid or a single-month calendar. */
		const VIEW_MODES = ["year", "month"];

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
		//#endregion

		//#region config store (settings-scope backed)
		/**
		 * Display preferences (colorScheme + defaultView), persisted through
		 * the Host `token-heatmap` settings namespace (settings.yaml) via the
		 * bound settings scope — NOT the legacy loopback config endpoint. The
		 * heatmap and the settings card read the store through
		 * useSyncExternalStore; while the scope is loading or unavailable the
		 * store falls back to the defaults (green / year view), so the UI never
		 * blocks on the settings transport. The 0.1.x display switch is gone:
		 * its `enabled` key is simply no longer read (see the settings card).
		 */
		const CONFIG_DEFAULTS = { colorScheme: "green", defaultView: "year" };
		/** Coerce a scheme to a non-blank string, else the default. */
		function sanitizeScheme(value) {
			if (typeof value !== "string") return CONFIG_DEFAULTS.colorScheme;
			const scheme = value.trim();
			return scheme.length > 0 && scheme.length <= 32 ? scheme : CONFIG_DEFAULTS.colorScheme;
		}
		/** Coerce a view mode to a known mode, else the default (year). */
		function sanitizeView(value) {
			if (typeof value !== "string") return CONFIG_DEFAULTS.defaultView;
			const view = value.trim();
			return VIEW_MODES.includes(view) ? view : CONFIG_DEFAULTS.defaultView;
		}
		/**
		 * Reactive adapter over one bound settings scope: a
		 * useSyncExternalStore-compatible store whose snapshot is
		 * `{ status, colorScheme, defaultView }` derived from the scope.
		 * `set(patch)` writes the touched fields through scope.set (async; the
		 * scope fences revisions and reloads on failure), and the snapshot
		 * only changes after the Host confirms. `reload()` re-reads from the
		 * Host; `dispose()` removes the subscription.
		 */
		function createConfigStore(scope) {
			const listeners = [];
			let snapshot = { status: "loading", ...CONFIG_DEFAULTS };
			const compute = () => {
				const s = scope.getSnapshot();
				if (s === void 0 || s === null || s.status !== "ready" || s.value === void 0 || s.value === null) {
					return { status: s === void 0 || s === null ? "unavailable" : s.status, ...CONFIG_DEFAULTS };
				}
				const v = s.value;
				return {
					status: s.status,
					colorScheme: sanitizeScheme(v.colorScheme),
					defaultView: sanitizeView(v.defaultView)
				};
			};
			const notify = () => {
				snapshot = compute();
				for (const listener of listeners.slice()) {
					try { listener(); } catch { /* contained: never break the fan-out */ }
				}
			};
			const unsubscribe = scope.subscribe(notify);
			snapshot = compute();
			return {
				getSnapshot: () => snapshot,
				subscribe: (listener) => {
					listeners.push(listener);
					return () => {
						const index = listeners.indexOf(listener);
						if (index !== -1) listeners.splice(index, 1);
					};
				},
				set: async (patch) => {
					if (Object.hasOwn(patch, "colorScheme")) {
						await scope.set("colorScheme", sanitizeScheme(patch.colorScheme));
					}
					if (Object.hasOwn(patch, "defaultView")) {
						await scope.set("defaultView", sanitizeView(patch.defaultView));
					}
				},
				reload: () => scope.load(),
				dispose: () => unsubscribe()
			};
		}
		/** Module-level store, created in apply() once the settings scope is bound. */
		let configStore = null;
		//#endregion

		/**
		 * Cell palettes by scheme, level 0 (empty) → 4 (peak). Green is the
		 * classic GitHub scale; the others are ColorBrewer single-hue ramps
		 * (blue/orange/red/purple) plus a custom teal. The active scheme comes
		 * from the settings card (配置 → 配色方案), persisted through the
		 * `token-heatmap` settings namespace.
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

		/**
		 * Build the calendar grid for ONE MONTH (the 年/月 view switch's month
		 * view): Monday-first weeks, exactly as many week rows as the month
		 * spans (5 or 6), cells outside the month null. Days after today are
		 * empty level-0 cells (today itself is always rendered with its real
		 * value), and every cell carries `day` (day of month) so the calendar
		 * can print numbers on top of the same absolute-threshold heat colors
		 * the year view uses.
		 * @param dayMap - date key → tokens.
		 * @param now - reference timestamp.
		 * @param month - `YYYY-MM` to render; defaults to the month of `now`.
		 * @returns `{ month, weeks, weekdays }` where each week is
		 *   `Array<{key, tokens, level, day} | null>` of 7 cells.
		 */
		function buildMonthGrid(dayMap, now, month) {
			const nowDate = new Date(now);
			const todayKey = dayKey(nowDate.getTime());
			const target = month ?? monthKey(nowDate.getTime());
			const [year, monthNumber] = target.split("-").map(Number);
			const monthStart = new Date(year, monthNumber - 1, 1);
			const monthEnd = new Date(year, monthNumber, 0);
			const startKey = dayKey(monthStart.getTime());
			const endKey = dayKey(monthEnd.getTime());
			const cursor = new Date(year, monthNumber - 1, 1 - ((monthStart.getDay() + 6) % 7));
			const weeks = [];
			while (cursor.getTime() <= monthEnd.getTime()) {
				const cells = [];
				for (let d = 0; d < 7; d += 1) {
					const key = dayKey(cursor.getTime());
					if (key < startKey || key > endKey) {
						cells.push(null);
					} else {
						const future = key > todayKey;
						const tokens = future ? 0 : (dayMap.get(key) ?? 0);
						cells.push({ key, tokens, level: levelOf(tokens), day: cursor.getDate() });
					}
					cursor.setDate(cursor.getDate() + 1);
				}
				weeks.push(cells);
			}
			return { month: target, weeks, weekdays: 7 };
		}
		//#endregion

		//#region TokenHeatmap
		/**
		 * The heatmap card. Shown only on the new-session hero screen
		 * (`session.blank`, or `composerPhase === "blank"` on older hosts); a
		 * flex `order` on the wrapper places it below the composer input card.
		 * @param props - `session`/`input` from the InputZone owner share, `t`
		 *   bound by the slot runtime locale seat.
		 */
		function TokenHeatmap({ session, input, t }) {
			const dict = t !== void 0 ? t : (key) => zh[key] ?? key;
			const translate = (key, params) => interpolate(dict(key), params);
			const [data, setData] = react.useState(null);
			const [error, setError] = react.useState(null);
			const [loading, setLoading] = react.useState(false);
			const [year, setYear] = react.useState(() => new Date().getFullYear());
			// Active view mode, seeded from the persisted default (the 年/月
			// switch at the row's right end; a manual switch wins for this
			// mount).
			const [view, setView] = react.useState(() => sanitizeView(configStore?.getSnapshot().defaultView));
			// Month-view cursor (`YYYY-MM`); initialised from the current month
			// and re-anchored when it would fall outside the navigable bounds.
			const [monthCursor, setMonthCursor] = react.useState(() => monthKey(Date.now()));
			// The ⚙ at the row's right end opens the floating settings panel;
			// the card configures itself here instead of living in
			// 设置 → 插件 → 插件配置. The panel is PORTALED to document.body and
			// anchored to this button, so the open state lives here with it.
			const gearRef = react.useRef(null);
			const [settingsOpen, setSettingsOpen] = react.useState(false);
			react.useEffect(() => {
				if (!settingsOpen) return;
				const onKeyDown = (event) => {
					if (event.key === "Escape") setSettingsOpen(false);
				};
				const onPointerDown = (event) => {
					const gear = gearRef.current;
					if (gear !== null && gear.contains(event.target)) return;
					const panel = document.querySelector(`.${S.settingsPanel}`);
					if (panel !== null && panel.contains(event.target)) return;
					setSettingsOpen(false);
				};
				document.addEventListener("keydown", onKeyDown);
				document.addEventListener("pointerdown", onPointerDown, true);
				return () => {
					document.removeEventListener("keydown", onKeyDown);
					document.removeEventListener("pointerdown", onPointerDown, true);
				};
			}, [settingsOpen]);
			const loaderRef = react.useRef(null);
			if (loaderRef.current === null) loaderRef.current = createLoader();
			const load = react.useCallback(async () => {
				const id = loaderRef.current.start();
				setLoading(true);
				try {
					const payload = await fetchJson("/api/token-heatmap/usage");
					if (loaderRef.current.isCurrent(id)) {
						setData(payload);
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

			// Display preferences come from the settings scope (auto-refreshed
			// on settings/document-updated and connection/reset), not from a
			// config fetch — the loopback endpoint remains as a back-compat API.
			const config = react.useSyncExternalStore(configStore.subscribe, configStore.getSnapshot);

			// New-session hero only. DSH 0.1.2+ (rc.1) exposes the state as
			// the boolean `session.blank` (the `composerPhase` string is
			// gone); older harnesses keep `composerPhase === "blank"`.
			// Conversed sessions hide the card. There is no display switch any
			// more: the card is always shown on the hero screen, and the
			// settings card only carries presentation choices.
			if (session === void 0 || session === null || input === void 0 || input === null) return null;
			const heroBlank = typeof session.blank === "boolean" ? session.blank === true : session.composerPhase === "blank";
			if (!heroBlank) return null;

			const now = Date.now();
			// Navigation bounds, derived from the data itself: at most the
			// current year/month (future usage cannot exist) and at least the
			// earliest one present, so the ‹ › selectors never wander into
			// guaranteed-empty territory.
			const nowYear = new Date(now).getFullYear();
			let minYear = nowYear;
			for (const day of data?.days ?? []) {
				const y = Number(day.date.slice(0, 4));
				if (y < minYear) minYear = y;
			}
			const maxYear = nowYear;
			const currentMonthKey = monthKey(now);
			let minMonth = currentMonthKey;
			for (const day of data?.days ?? []) {
				const key = monthOfDateKey(day.date);
				if (key < minMonth) minMonth = key;
			}
			const maxMonth = currentMonthKey;
			const todayTokens = data?.days?.find((day) => day.date === dayKey(now))?.tokens ?? 0;
			const monthPrefix = currentMonthKey;
			let monthTokens = 0;
			for (const day of data?.days ?? []) {
				if (day.date.startsWith(monthPrefix)) monthTokens += day.tokens;
			}
			const totalTokens = data?.total ?? 0;
			// Keep the last known cursor, but never outside the bounds (a
			// brand-new store of only old months must not open on next month).
			const activeMonth = monthCursor < minMonth
				? minMonth
				: monthCursor > maxMonth ? maxMonth : monthCursor;

			const dayMap = new Map();
			for (const day of data?.days ?? []) dayMap.set(day.date, day.tokens);
			const grid = buildGrid(dayMap, now, year);
			const monthGrid = buildMonthGrid(dayMap, now, activeMonth);
			const levelLegend = uiDict().levelLegend;
			// Palette from the in-card settings panel; unknown schemes fall back
			// to green.
			const palette = COLOR_SCHEMES[config.colorScheme] ?? COLOR_SCHEMES.green;

			// ‹ › step the active view: years in year view, months in month view.
			const stepBack = () => {
				if (view === "month") setMonthCursor(shiftMonthKey(activeMonth, -1));
				else setYear(year - 1);
			};
			const stepForward = () => {
				if (view === "month") setMonthCursor(shiftMonthKey(activeMonth, 1));
				else setYear(year + 1);
			};
			const backDisabled = view === "month" ? activeMonth <= minMonth : year <= minYear;
			const forwardDisabled = view === "month" ? activeMonth >= maxMonth : year >= maxYear;

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
									className: S.nav,
									children: [
										react_jsx_runtime.jsx("button", {
											type: "button",
											className: S.yearBtn,
											disabled: backDisabled,
											onClick: stepBack,
											"aria-label": dict(view === "month" ? "prevMonth" : "prevYear"),
											children: "\u2039"
										}),
										view === "month" ? react_jsx_runtime.jsx("span", {
											className: `${S.yearLabel} ${S.monthLabelNav}`,
											children: monthLabelFull(activeMonth)
										}) : react_jsx_runtime.jsx("span", { className: S.yearLabel, children: String(year) }),
										react_jsx_runtime.jsx("button", {
											type: "button",
											className: S.yearBtn,
											disabled: forwardDisabled,
											onClick: stepForward,
											"aria-label": dict(view === "month" ? "nextMonth" : "nextYear"),
											children: "\u203a"
										})
									]
								}),
								// The view switch sits next to the ‹ › stepper it pairs
								// with; the ⚙ closes the row on the right.
								react_jsx_runtime.jsx("span", {
									className: S.viewNav,
									role: "group",
									"aria-label": dict("viewLabel"),
									children: VIEW_MODES.map((mode) => react_jsx_runtime.jsx("button", {
										type: "button",
										className: S.viewBtn,
										"data-active": view === mode,
										"aria-pressed": view === mode,
										onClick: () => setView(mode),
										children: dict(mode === "month" ? "viewMonth" : "viewYear")
									}, mode))
								}),
								react_jsx_runtime.jsx("button", {
									type: "button",
									className: S.refresh,
									disabled: loading,
									onClick: load,
									children: dict("refresh")
								}),
								// The ⚙ owns the row's right end; the ‹ › stepper
								// and the view switch sit left of it, the stepper
								// next to the stats it moves through. This button is
								// also the settings panel's anchor.
								react_jsx_runtime.jsx("button", {
									type: "button",
									ref: gearRef,
									className: S.gear,
									"data-active": settingsOpen,
									"aria-haspopup": "dialog",
									"aria-expanded": settingsOpen,
									"aria-label": dict(settingsOpen ? "settingsCollapse" : "settingsExpand"),
									title: dict(settingsOpen ? "settingsCollapse" : "settingsExpand"),
									onClick: () => setSettingsOpen(!settingsOpen),
									children: react_jsx_runtime.jsx("svg", {
										width: 14,
										height: 14,
										viewBox: "0 0 24 24",
										fill: "none",
										stroke: "currentColor",
										"aria-hidden": "true",
										children: react_jsx_runtime.jsx("path", {
											d: "M10.9 2.6h2.2l.4 2.5 1.9.8 2-1.5 1.6 1.6-1.5 2 .8 1.9 2.5.4v2.2l-2.5.4-.8 1.9 1.5 2-1.6 1.6-2-1.5-1.9.8-.4 2.5h-2.2l-.4-2.5-1.9-.8-2 1.5-1.6-1.6 1.5-2-.8-1.9-2.5-.4v-2.2l2.5-.4.8-1.9-1.5-2 1.6-1.6 2 1.5 1.9-.8.4-2.5Z",
											"stroke-width": 1.5,
											"stroke-linejoin": "round",
											"stroke-linecap": "round"
										})
									})
								})
							]
						}),
						view === "month" ? react_jsx_runtime.jsx("div", {
							className: S.gridWrap,
							children: react_jsx_runtime.jsxs("div", {
								className: S.monthCal,
								children: [
									react_jsx_runtime.jsx("div", {
										className: S.weekHead,
										children: uiDict().weekdayLabel.map((label, index) => react_jsx_runtime.jsx("span", {
											className: S.weekHeadCell,
											children: label
										}, `weekhead-${index}`))
									}),
									...monthGrid.weeks.map((week, weekIndex) => react_jsx_runtime.jsx("div", {
										className: S.week,
										children: week.map((cell, dayIndex) => {
											if (cell === null) {
												return react_jsx_runtime.jsx("span", {
													className: S.day,
													"data-empty": "true"
												}, `empty-${weekIndex}-${dayIndex}`);
											}
											return react_jsx_runtime.jsxs("span", {
												className: S.day,
												"data-level": String(cell.level),
												"data-weekend": dayIndex >= 5 ? "true" : "false",
												style: { background: palette[cell.level] },
												title: translate("cellTokens", { date: dateLabel(cell.key), tokens: fmt(cell.tokens) }),
												children: [
													react_jsx_runtime.jsx("span", { className: S.dayNum, children: String(cell.day) }),
													cell.tokens > 0 ? react_jsx_runtime.jsx("span", {
														className: S.dayTokens,
														children: fmtCompact(cell.tokens)
													}) : null
												]
											}, cell.key);
										})
									}, `week-${weekIndex}`))
								]
							})
						}) : react_jsx_runtime.jsx("div", {
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
									})
								]
							})
						}),
						react_jsx_runtime.jsx("div", {
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
						}),
						settingsOpen ? react_jsx_runtime.jsx(TokenHeatmapInlineSettings, {
							dict,
							config,
							store: configStore,
							palette,
							translate,
							legend: levelLegend,
							anchor: gearRef.current,
							onClose: () => setSettingsOpen(false)
						}) : null
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

		//#region TokenHeatmapInlineSettings
		/** Distance between the ⚙ and the panel's bottom edge (native dialog spec). */
		const PANEL_GAP = 8;
		/** Viewport margin the placement clamp keeps (native dialog spec). */
		const PANEL_MARGIN = 12;

		/**
		 * Place the floating panel above its ⚙ trigger, clamped to the viewport —
		 * the same measure-then-place flow (and the same 8px gap / 12px margin)
		 * the built-in stat dialogs use. The panel is `position:fixed` and lives
		 * in `document.body`, so the card can never clip it.
		 * @param trigger - the ⚙ button the panel is anchored to.
		 * @param panel - the `position:fixed` panel element.
		 */
		function placePanel(trigger, panel) {
			const anchor = trigger.getBoundingClientRect();
			const width = panel.offsetWidth;
			const height = panel.offsetHeight;
			if (width === 0 || height === 0) return;
			const viewportWidth = window.innerWidth;
			const viewportHeight = window.innerHeight;
			const left = Math.min(
				Math.max(PANEL_MARGIN, anchor.left + anchor.width / 2 - width / 2),
				Math.max(PANEL_MARGIN, viewportWidth - width - PANEL_MARGIN)
			);
			let top = anchor.top - height - PANEL_GAP;
			if (top < PANEL_MARGIN) top = Math.min(anchor.bottom + PANEL_GAP, viewportHeight - height - PANEL_MARGIN);
			panel.style.left = `${Math.round(left)}px`;
			panel.style.top = `${Math.round(Math.max(PANEL_MARGIN, top))}px`;
			panel.style.visibility = "visible";
		}

		/**
		 * The card's settings panel: 配色方案 and 默认视图, edited from the card
		 * itself instead of inside 设置 → 插件 → 插件配置 (this plugin no longer
		 * registers into the `settings.plugin.item` seat).
		 *
		 * It is PORTALED to `document.body` (the card's own box can never clip
		 * it) and anchored to the ⚙ through `anchor`; the owner closes it on
		 * outside pointerdown and Escape, so this component only draws.
		 *
		 * Every control applies immediately through the bound settings scope —
		 * there is no draft/save step, so the component owns only a local save
		 * error. The 0.1.x 显示热力图 switch is gone (the card is always shown on
		 * the hero screen), so its stored `enabled` key is neither read nor
		 * written. The legacy loopback config endpoint remains as a back-compat
		 * API, but nothing in the UI uses it.
		 * @param props.dict - bound translator.
		 * @param props.config - current config store snapshot.
		 * @param props.store - config store (set writes through the scope).
		 * @param props.palette - active palette (level 0..4 → css color).
		 * @param props.translate - interpolation helper for translated labels.
		 * @param props.legend - level labels for the palette footnote.
		 * @param props.anchor - the ⚙ button the panel is placed against.
		 * @param props.onClose - collapse the panel.
		 */
		function TokenHeatmapInlineSettings({ dict, config, store, palette, translate, legend, anchor, onClose }) {
			const panelRef = react.useRef(null);
			const [saveFailed, setSaveFailed] = react.useState(false);
			const schemes = Object.keys(COLOR_SCHEMES);
			// Optimistic local echo: the settings scope only reports the new value
			// after the Host confirms, and a control must not lag behind the click.
			const [pending, setPending] = react.useState({});
			const scheme = pending.colorScheme ?? config.colorScheme;
			const defaultView = pending.defaultView ?? config.defaultView;
			// Place before paint (and again when the palette reflows the panel):
			// the trigger's box is only meaningful once the card is laid out.
			react.useLayoutEffect(() => {
				const panel = panelRef.current;
				if (panel === null || anchor === null || anchor === void 0) return;
				placePanel(anchor, panel);
			});
			react.useEffect(() => {
				const replace = () => {
					const panel = panelRef.current;
					if (panel === null || anchor === null || anchor === void 0) return;
					placePanel(anchor, panel);
				};
				window.addEventListener("resize", replace);
				window.addEventListener("scroll", replace, true);
				return () => {
					window.removeEventListener("resize", replace);
					window.removeEventListener("scroll", replace, true);
				};
			}, [anchor]);
			const commit = async (patch) => {
				setPending((current) => ({ ...current, ...patch }));
				setSaveFailed(false);
				try {
					await store.set(patch);
				} catch {
					setSaveFailed(true);
				}
			};
			const chooseScheme = (value) => {
				if (value !== scheme) commit({ colorScheme: value });
			};
			const chooseView = (value) => {
				if (value !== defaultView) commit({ defaultView: value });
			};
			const labelOf = (name) => dict(`settings${name[0].toUpperCase()}${name.slice(1)}`);
			const title = dict("settingsTitle");
			const panel = react_jsx_runtime.jsxs("div", {
				ref: panelRef,
				className: S.settingsPanel,
				role: "dialog",
				"aria-label": title,
				// Nothing may paint at the viewport origin before placement runs.
				style: { visibility: "hidden" },
				children: [
					react_jsx_runtime.jsxs("div", {
						className: S.panelHead,
						children: [
							react_jsx_runtime.jsxs("span", {
								className: S.panelTitleLabel,
								children: [
									react_jsx_runtime.jsxs("svg", {
										width: 14,
										height: 14,
										viewBox: "0 0 24 24",
										fill: "none",
										stroke: "currentColor",
										"stroke-width": 2,
										"stroke-linecap": "round",
										"stroke-linejoin": "round",
										"aria-hidden": "true",
										children: [
											react_jsx_runtime.jsx("circle", { cx: 12, cy: 12, r: 9 }),
											react_jsx_runtime.jsx("path", { d: "M12 11v5" }),
											react_jsx_runtime.jsx("path", { d: "M12 8h.01" })
										]
									}),
									react_jsx_runtime.jsx("span", { children: title })
								]
							})
						]
					}),
					react_jsx_runtime.jsx("div", { className: S.panelRule, "aria-hidden": "true" }),
					react_jsx_runtime.jsxs("div", {
						className: S.settingsGroup,
						children: [
							react_jsx_runtime.jsx("span", { className: S.settingsGroupLabel, children: dict("settingsScheme") }),
							react_jsx_runtime.jsx("div", {
								className: S.settingsSwatches,
								children: schemes.map((name) => react_jsx_runtime.jsxs("button", {
									type: "button",
									className: S.settingsSwatch,
									"data-active": scheme === name,
									"aria-pressed": scheme === name,
									title: labelOf(name),
									onClick: () => chooseScheme(name),
									children: [
										react_jsx_runtime.jsx("span", {
											className: S.settingsSwatchCells,
											children: COLOR_SCHEMES[name].slice(1).map((color, index) => react_jsx_runtime.jsx("span", {
												className: S.settingsSwatchCell,
												style: { background: color }
											}, `cell-${index}`))
										}),
										react_jsx_runtime.jsx("span", {
											className: S.settingsSwatchLabel,
											children: labelOf(name)
										})
									]
								}, name))
							})
						]
					}),
					react_jsx_runtime.jsxs("div", {
						className: S.settingsGroup,
						children: [
							react_jsx_runtime.jsx("span", { className: S.settingsGroupLabel, children: dict("settingsDefaultView") }),
							react_jsx_runtime.jsx("div", {
								className: S.seg,
								role: "group",
								"aria-label": dict("settingsDefaultView"),
								children: VIEW_MODES.map((mode) => react_jsx_runtime.jsx("button", {
									type: "button",
									className: S.segBtn,
									"data-active": defaultView === mode,
									"aria-pressed": defaultView === mode,
									onClick: () => chooseView(mode),
									children: dict(mode === "month" ? "viewMonth" : "viewYear")
								}, mode))
							})
						]
					}),
					react_jsx_runtime.jsxs("div", {
						className: S.panelFoot,
						children: [
							react_jsx_runtime.jsxs("div", {
								className: S.footLegend,
								children: [
									dict("less"),
									...palette.map((color, level) => react_jsx_runtime.jsx("span", {
										className: S.legendCell,
										style: { background: color },
										title: legend[level] ?? ""
									}, `foot-${level}`)),
									dict("more")
								]
							}),
							saveFailed ? react_jsx_runtime.jsx("div", {
								className: S.footError,
								children: dict("settingsSaveFailed")
							}) : react_jsx_runtime.jsx("div", {
								className: S.footRule,
								children: dict("settingsThresholdNote")
							})
						]
					})
				]
			});
			return reactDom.createPortal(panel, document.body);
		}
		//#endregion

		//#region plugin body
		/**
		 * Settings namespace the card reads/writes — must match the namespace
		 * the Host registers (lib/index.js). Spelled here rather than imported:
		 * a client package must not depend on a Host package.
		 */
		const SETTINGS_NS = "token-heatmap";
		/** Services required by the client plugin body. */
		const inject = ["slots", "locale", "connection", "remote", "settingsScope"];

		/**
		 * Client plugin body: register the dictionaries and the input-dock entry
		 * (the heatmap below the composer card on the new-session screen), backed
		 * by the `token-heatmap` settings namespace through a bound settings
		 * scope. The card configures itself through its own ⚙ panel, so this
		 * plugin does NOT register into `settings.plugin.item` (the official
		 * 设置 → 插件 → 插件配置 card seat) any more — the Host still serves the
		 * namespace, it just has no configuration card to dispatch.
		 *
		 * Slot-kind contract: `conversation.input.dock` is a LIST slot, so its
		 * registration is keyed by `id` (a `settings.plugin.item` registration
		 * would instead need `key`, the settings namespace the card edits).
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			// Bind the namespace scope on THIS plugin's fiber (settingsScope.bind
			// registers the disposer itself); the scope auto-loads and refreshes
			// on settings/document-updated and connection/reset. Requires the
			// injected connection (transport) and remote (invalidation) services.
			const scope = ctx.settingsScope.bind({ namespace: SETTINGS_NS });
			configStore = createConfigStore(scope);
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "token-heatmap: dictionaries");
			ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
				name: "conversation.input.dock",
				id: "token-heatmap",
				order: 10,
				locale: NS
			}, TokenHeatmap));
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		exports.TokenHeatmap = TokenHeatmap;
		exports.TokenHeatmapInlineSettings = TokenHeatmapInlineSettings;
		exports.buildGrid = buildGrid;
		exports.buildMonthGrid = buildMonthGrid;
		exports.levelOf = levelOf;
		exports.monthLabelFull = monthLabelFull;
		exports.dateLabel = dateLabel;
		exports.shiftMonthKey = shiftMonthKey;
		exports.CELL_COLORS = CELL_COLORS;
		exports.COLOR_SCHEMES = COLOR_SCHEMES;
		exports.createConfigStore = createConfigStore;
		return module.exports;
	}
});
