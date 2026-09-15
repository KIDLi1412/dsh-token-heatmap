/**
 * Smoke test for dsh-token-heatmap — no browser, no harness needed.
 *
 *   node scripts/smoke.mjs
 *
 * Verifies:
 *   1. usage.js aggregation: per-day totals, replace-last-sample semantics,
 *      model attribution, renderUsage shape.
 *   2. client.js: the __ModuleLoader__ factory runs against real react and
 *      buildGrid/levelOf produce a sane 5-week GitHub-style grid.
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
function check(name, condition, detail = "") {
	if (condition) {
		console.log(`  ok   ${name}`);
	} else {
		failures += 1;
		console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

// ---------------------------------------------------------------- config.js
console.log("config.js");
const config = await import(pathToFileURL(join(root, "lib/config.js")).href);
const defaults = { colorScheme: "green", defaultView: "year" };
check("default config shape", JSON.stringify(config.DEFAULT_CONFIG) === JSON.stringify(defaults));
check("parseConfig(undefined) → defaults", JSON.stringify(config.parseConfig(undefined)) === JSON.stringify(defaults));
check("parseConfig(null) → defaults", JSON.stringify(config.parseConfig(null)) === JSON.stringify(defaults));
check("parseConfig({}) → defaults", JSON.stringify(config.parseConfig({})) === JSON.stringify(defaults));
check("parseConfig({colorScheme:\"blue\"}) keeps the view default", JSON.stringify(config.parseConfig({ colorScheme: "blue" })) === JSON.stringify({ colorScheme: "blue", defaultView: "year" }));
check("parseConfig full override", JSON.stringify(config.parseConfig({ colorScheme: "blue", defaultView: "month" })) === JSON.stringify({ colorScheme: "blue", defaultView: "month" }));
check("invalid fields fall back to defaults", JSON.stringify(config.parseConfig({ junk: 1 })) === JSON.stringify(defaults));
// The 0.1.x display switch is retired: a stored `enabled` is ignored, never
// echoed back, and never disables the card.
check("legacy enabled:false is ignored", JSON.stringify(config.parseConfig({ enabled: false })) === JSON.stringify(defaults));
check("legacy enabled:true is ignored", JSON.stringify(config.parseConfig({ enabled: true })) === JSON.stringify(defaults));
check("unknown scheme preserved verbatim", JSON.stringify(config.parseConfig({ colorScheme: "rainbow" })) === JSON.stringify({ colorScheme: "rainbow", defaultView: "year" }));
check("blank scheme falls back to default", config.parseConfig({ colorScheme: "   " }).colorScheme === "green");
check("overlong scheme falls back to default", config.parseConfig({ colorScheme: "x".repeat(40) }).colorScheme === "green");
check("new scheme accepted by parseConfig", JSON.stringify(config.parseConfig({ colorScheme: "teal" })) === JSON.stringify({ colorScheme: "teal", defaultView: "year" }));
check("COLOR_SCHEMES lists all six schemes", JSON.stringify(config.COLOR_SCHEMES) === JSON.stringify(["green", "blue", "orange", "red", "purple", "teal"]));
// defaultView is bounded to the rendered modes (unlike colorScheme, which is
// only shape-bounded so newer palettes survive an older server).
check("VIEW_MODES lists year+month", JSON.stringify(config.VIEW_MODES) === JSON.stringify(["year", "month"]));
check("month defaultView accepted", config.parseConfig({ defaultView: "month" }).defaultView === "month");
check("padded defaultView accepted", config.parseConfig({ defaultView: " month " }).defaultView === "month");
check("unknown defaultView falls back to year", config.parseConfig({ defaultView: "week" }).defaultView === "year");
check("non-string defaultView falls back to year", config.parseConfig({ defaultView: 7 }).defaultView === "year");

// ---------------------------------------------------------------- usage.js
console.log("usage.js");
const usage = await import(pathToFileURL(join(root, "lib/usage.js")).href);

const day1 = Date.UTC(2026, 7, 13, 10, 0, 0);
const day2 = Date.UTC(2026, 7, 14, 10, 0, 0);
const events = [
	// Two usage samples on the same (turn, step): the later one replaces.
	{ seq: 1, type: "request/header", time: day1, data: { header: { config: { provider: "deepseek-official", model: "deepseek-v4-flash" } } } },
	{ seq: 2, type: "assistant/chunk", time: day1, data: { turn: 1, step: 1, chunk: { type: "usage", usage: { inputTokens: 100, outputTokens: 50 } } } },
	{ seq: 3, type: "assistant/chunk", time: day2, data: { turn: 1, step: 1, chunk: { type: "usage", usage: { inputTokens: 200, outputTokens: 80 } } } },
	// Second turn on day2 with a message-carried usage sample (model from source).
	{ seq: 4, type: "assistant/message", time: day2, data: { turn: 2, step: 1, message: { source: { provider: "pi-ai", model: "custom/foo" } }, usage: { inputTokens: 30, outputTokens: 10, cacheReadTokens: 5 } } },
	// A non-usage event that must be ignored.
	{ seq: 5, type: "tool/call", time: day2, data: { callId: "c1", tool: "pwsh" } }
];

const byDay = new Map();
usage.mergeInto(byDay, usage.foldUsage(events));
check("two days recorded", byDay.size === 2, `got ${byDay.size}`);
const d1 = byDay.get("2026-08-13");
const d2 = byDay.get("2026-08-14");
check("day1 total = 0 (sample replaced, re-attributed to day2)", d1 !== void 0 && usage.totalTokens(d1.totals) === 0, JSON.stringify(d1?.totals));
check("day2 total = 200+80 + 30+10+5 = 325", d2 !== void 0 && usage.totalTokens(d2.totals) === 325, JSON.stringify(d2?.totals));
check("day1 model bucket deepseek-official/deepseek-v4-flash", d1?.models.get("deepseek-official/deepseek-v4-flash") !== void 0);
check("day2 model bucket pi-ai/custom/foo", d2?.models.get("pi-ai/custom/foo") !== void 0);
check("day1 lost its sample after replacement", d1?.totals.inputTokens === 0 && d1?.totals.outputTokens === 0);

const rendered = usage.renderUsage(byDay, 1234);
check("renderUsage shape", rendered.days.length === 2 && rendered.days[0].date === "2026-08-13" && rendered.days[0].tokens === 0);
check("renderUsage total = 325", rendered.total === 325, `got ${rendered.total}`);
check("renderUsage sorted ascending", rendered.days[0].date < rendered.days[1].date);
check("day model list desc by tokens", rendered.days[1].models[0].model === "deepseek-official/deepseek-v4-flash" && rendered.days[1].models[1].model === "pi-ai/custom/foo");

// ---------------------------------------------------------------- client.js
console.log("client.js");
globalThis.window = {};
let loaded = null;
globalThis.window.__ModuleLoader__ = { load: (spec) => { loaded = spec; } };
// react may live in the DSH profiles dir (local dev, USERPROFILE/homedir) or
// in this repo's node_modules (CI). Try both so the smoke test runs anywhere.
const reactCandidates = [
	join(process.env.USERPROFILE ?? os.homedir(), ".dsh", "profiles", "node_modules", "react", "package.json"),
	join(root, "node_modules", "react", "package.json")
].filter(existsSync);
if (reactCandidates.length === 0) {
	console.error("react not found (looked in DSH profiles and repo node_modules); run: npm install --no-save react@18.3.1");
	process.exit(1);
}
const requireFromProfile = createRequire(pathToFileURL(reactCandidates[0]));
const fakeRequire = (name) => {
	if (name === "react") return requireFromProfile("react");
	if (name === "react/jsx-runtime") return requireFromProfile("react/jsx-runtime");
	throw new Error(`unexpected require: ${name}`);
};
await import(pathToFileURL(join(root, "lib/client.js")).href);
check("module loader captured", loaded !== null && loaded.id === "@kidli1412/dsh-token-heatmap");
const exports = loaded.factory(fakeRequire);
check("factory exports buildGrid/levelOf", typeof exports.buildGrid === "function" && typeof exports.levelOf === "function");
check("apply/inject exported", typeof exports.apply === "function" && Array.isArray(exports.inject));
check("settings panel exported", typeof exports.TokenHeatmapInlineSettings === "function");
check("all six palettes: 5 cells, shared level-0 gray", (() => {
	const names = ["green", "blue", "orange", "red", "purple", "teal"];
	if (Object.keys(exports.COLOR_SCHEMES).length !== names.length) return false;
	const base = exports.COLOR_SCHEMES.green[0];
	for (const name of names) {
		const palette = exports.COLOR_SCHEMES[name];
		if (!Array.isArray(palette) || palette.length !== 5) return false;
		if (palette[0] !== base) return false;
	}
	return true;
})());
check("palettes are pairwise distinct", (() => {
	const names = Object.keys(exports.COLOR_SCHEMES);
	for (let i = 0; i < names.length; i += 1) {
		for (let j = i + 1; j < names.length; j += 1) {
			if (exports.COLOR_SCHEMES[names[i]].join() === exports.COLOR_SCHEMES[names[j]].join()) return false;
		}
	}
	return true;
})());
check("CELL_COLORS aliases green", exports.CELL_COLORS === exports.COLOR_SCHEMES.green);

// ---- createConfigStore (settings-scope backed) -------------------------
function createMockScope(initial) {
	const listeners = new Set();
	let snapshot = initial;
	return {
		getSnapshot: () => snapshot,
		subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
		set: async (field, value) => {
			snapshot = { ...snapshot, value: { ...(snapshot.value ?? {}), [field]: value } };
			for (const l of listeners) l();
		},
		publish: (next) => { snapshot = next; for (const l of listeners) l(); }
	};
}
const mock = createMockScope({ status: "loading", value: void 0, writable: false, mode: "host" });
const store = exports.createConfigStore(mock);
check("store loading → defaults", store.getSnapshot().colorScheme === "green" && store.getSnapshot().defaultView === "year", JSON.stringify(store.getSnapshot()));
mock.publish({ status: "ready", value: { enabled: false, colorScheme: "purple", defaultView: "month" }, writable: true, mode: "host" });
check("store ready → resolved values", store.getSnapshot().colorScheme === "purple" && store.getSnapshot().defaultView === "month", JSON.stringify(store.getSnapshot()));
// The retired display switch is not part of the snapshot any more, so no
// renderer can gate on it.
check("store snapshot has no enabled flag", !Object.hasOwn(store.getSnapshot(), "enabled"), JSON.stringify(store.getSnapshot()));
mock.publish({ status: "unavailable", value: void 0, writable: false, mode: "host" });
check("store unavailable → defaults", store.getSnapshot().colorScheme === "green" && store.getSnapshot().defaultView === "year", JSON.stringify(store.getSnapshot()));
mock.publish({ status: "ready", value: { enabled: true, colorScheme: "green", defaultView: "year" }, writable: true, mode: "host" });
await store.set({ enabled: false });
check("store ignores a legacy enabled write", mock.getSnapshot().value.enabled !== false);
await store.set({ colorScheme: "blue" });
check("store set writes scheme through the scope", mock.getSnapshot().value.colorScheme === "blue");
await store.set({ colorScheme: "   " });
check("blank scheme sanitized to default", mock.getSnapshot().value.colorScheme === "green");
await store.set({ defaultView: "month" });
check("store set writes the default view through the scope", mock.getSnapshot().value.defaultView === "month");
await store.set({ defaultView: "week" });
check("unknown view sanitized to year", mock.getSnapshot().value.defaultView === "year");
mock.publish({ status: "ready", value: { enabled: true, colorScheme: "green", defaultView: "week" }, writable: true, mode: "host" });
check("unknown view from the wire → year fallback", store.getSnapshot().defaultView === "year", JSON.stringify(store.getSnapshot()));
store.dispose();

// Absolute color thresholds (per-day tokens).
check("levelOf absolute buckets", exports.levelOf(0) === 0 && exports.levelOf(5e5) === 1 && exports.levelOf(5e6) === 2 && exports.levelOf(61e6) === 3 && exports.levelOf(2e8) === 4, `got ${exports.levelOf(61e6)}`);

// buildGrid over the current calendar year (Jan 1 – Dec 31).
const now = new Date();
const dayMap = new Map();
for (let i = 0; i < 365; i += 1) {
	const d = new Date(now.getTime() - i * 86400000);
	const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
	dayMap.set(key, i % 5 === 0 ? 0 : (i + 1) * 1000000);
}
const grid = exports.buildGrid(dayMap, now.getTime());
const yearDays = (new Date(now.getFullYear(), 11, 31).getTime() - new Date(now.getFullYear(), 0, 1).getTime()) / 86400000 + 1;
check("year grid has 52..54 columns", grid.columns.length >= 52 && grid.columns.length <= 54, `got ${grid.columns.length}`);
check("every column has 7 cells", grid.columns.every((column) => column.cells.length === 7));
const filled = grid.columns.flatMap((column) => column.cells.filter((cell) => cell !== null));
check(`filled cells = ${yearDays} (calendar year)`, filled.length === yearDays, `got ${filled.length}`);
check("all 12 months present in month labels", grid.monthStarts.length === 12, `got ${grid.monthStarts.length}: ${grid.monthStarts.map((e) => e.month).join(",")}`);
const yearStr = String(now.getFullYear());
check("months run Jan..Dec", grid.monthStarts[0].month === `${yearStr}-01` && grid.monthStarts[11].month === `${yearStr}-12`);
// Month-label boundaries must align with column boundaries: with a 16px row
// label column and 12px per column (10px cell + 2px gap), label i must start
// at 16 + 12 * columnIndex — no cumulative drift (a 2px-short box per month
// would drift left by 2px × months).
check("month labels align with columns", (() => {
	let cumulative = 0;
	for (let i = 0; i < grid.monthStarts.length; i += 1) {
		const entry = grid.monthStarts[i];
		if (cumulative !== 12 * entry.index) return false;
		const span = i + 1 < grid.monthStarts.length ? grid.monthStarts[i + 1].index - entry.index : grid.columns.length - entry.index;
		cumulative += span * 12;
	}
	return cumulative === 12 * grid.columns.length;
})());
check("levels within 0..4", filled.every((cell) => cell.level >= 0 && cell.level <= 4));
check("level monotonic with tokens", (() => {
	const nonzero = filled.filter((cell) => cell.tokens > 0).map((cell) => cell.level);
	const tokens = filled.filter((cell) => cell.tokens > 0).map((cell) => cell.tokens);
	for (let i = 1; i < tokens.length; i += 1) {
		if (tokens[i] > tokens[i - 1] && nonzero[i] < nonzero[i - 1]) return false;
	}
	return true;
})());
check("zero days level 0", filled.filter((cell) => cell.tokens === 0).every((cell) => cell.level === 0));
check("today present in grid", filled.some((cell) => cell.key === `${yearStr}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`));

// Explicit year parameter: a past year with no data renders the full
// calendar as empty level-0 cells with Jan..Dec labels for THAT year.
const pastYear = now.getFullYear() - 3;
const pastGrid = exports.buildGrid(new Map(), now.getTime(), pastYear);
const pastDays = (new Date(pastYear, 11, 31).getTime() - new Date(pastYear, 0, 1).getTime()) / 86400000 + 1;
const pastFilled = pastGrid.columns.flatMap((column) => column.cells.filter((cell) => cell !== null));
check(`past-year grid filled = ${pastDays} days`, pastFilled.length === pastDays, `got ${pastFilled.length}`);
check("past-year cells all level 0", pastFilled.every((cell) => cell.level === 0));
check("past-year months Jan..Dec of that year", pastGrid.monthStarts.length === 12 && pastGrid.monthStarts[0].month === `${pastYear}-01` && pastGrid.monthStarts[11].month === `${pastYear}-12`);

// buildMonthGrid: the ‹年/月› toggle's month view. Monday-first weeks, one
// row per week the month spans (5 or 6), hard boundaries (leading/trailing
// cells null so they never paint), day numbers for the calendar face.
check("buildMonthGrid/月 label exported", typeof exports.buildMonthGrid === "function" && typeof exports.monthLabelFull === "function" && typeof exports.shiftMonthKey === "function");
const monthGrid = exports.buildMonthGrid(dayMap, now.getTime());
const monthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
check("month grid targets the current month", monthGrid.month === monthPrefix, `got ${monthGrid.month}`);
check("month grid has 5..6 weeks of 7 cells", monthGrid.weeks.length >= 5 && monthGrid.weeks.length <= 6 && monthGrid.weeks.every((week) => week.length === 7), `got ${monthGrid.weeks.length} weeks`);
const monthCells = monthGrid.weeks.flat().filter((cell) => cell !== null);
const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
check(`month grid filled cells = ${daysInMonth}`, monthCells.length === daysInMonth, `got ${monthCells.length}`);
check("month cells all belong to the month", monthCells.every((cell) => cell.key.startsWith(monthPrefix)));
check("month cells carry a day number", monthCells.every((cell) => cell.day >= 1 && cell.day <= daysInMonth));
check("month grid day numbers run 1..N in order", monthCells.map((cell) => cell.day).join(",") === Array.from({ length: daysInMonth }, (_, i) => i + 1).join(","));
// Monday-first: a cell's COLUMN within its week must be (getDay()+6)%7, so
// Monday sits in the first column and Sunday in the last.
check("month grid columns are Mon-first", (() => {
	const first = monthCells[0];
	const firstColumn = monthGrid.weeks[0].indexOf(first);
	if (firstColumn !== (new Date(first.key + "T00:00:00").getDay() + 6) % 7) return false;
	return monthGrid.weeks.every((week) => week.every((cell, column) => cell === null || (new Date(cell.key + "T00:00:00").getDay() + 6) % 7 === column));
})());
check("month grid leading days before the 1st are null", (() => {
	const firstIndex = monthGrid.weeks[0].findIndex((cell) => cell !== null);
	return monthGrid.weeks[0].slice(0, firstIndex).every((cell) => cell === null);
})());
check("month grid trailing days after the last are null", (() => {
	const lastWeek = monthGrid.weeks[monthGrid.weeks.length - 1];
	const lastIndex = lastWeek.map((cell) => cell !== null).lastIndexOf(true);
	return lastWeek.slice(lastIndex + 1).every((cell) => cell === null);
})());
check("month grid levels within 0..4 and match levelOf", monthCells.every((cell) => cell.level === exports.levelOf(cell.tokens)));
// Days after today render as empty level-0 cells (today itself keeps data).
const future = monthCells.filter((cell) => cell.key > `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`);
check("future month days are empty level 0", future.every((cell) => cell.level === 0 && cell.tokens === 0));
const explicitMonth = exports.buildMonthGrid(dayMap, now.getTime(), "2026-02");
check("explicit month honoured", explicitMonth.month === "2026-02");
check("February 2026 spans 4 week rows + padding", explicitMonth.weeks.length === 5, `got ${explicitMonth.weeks.length}`);
check("February 2026 has 28 filled cells", explicitMonth.weeks.flat().filter((cell) => cell !== null).length === 28);
const emptyMonth = exports.buildMonthGrid(new Map(), now.getTime(), "1999-12");
check("month with no data fills the calendar at level 0", emptyMonth.weeks.flat().filter((cell) => cell !== null).length === 31 && emptyMonth.weeks.flat().filter((cell) => cell !== null).every((cell) => cell.level === 0));
// Month cursor arithmetic across year boundaries.
check("shiftMonthKey steps months", exports.shiftMonthKey("2026-08", -1) === "2026-07" && exports.shiftMonthKey("2026-08", 1) === "2026-09");
check("shiftMonthKey crosses years", exports.shiftMonthKey("2026-01", -1) === "2025-12" && exports.shiftMonthKey("2026-12", 1) === "2027-01");
check("shiftMonthKey is a no-op on junk", exports.shiftMonthKey("nope", 1) === "nope");
// Display labels: zh uses "2026年8月", en uses "Aug 2026". The locale probe
// reads `navigator.languages`, so drive both explicitly — CI runs an English
// locale, where the zh-shaped template used to leak a "年" into the en label.
const withNavigator = (languages, run) => {
	const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
	// Node exposes `navigator` as a getter-only global, so replace the whole
	// property descriptor rather than assigning to it.
	Object.defineProperty(globalThis, "navigator", {
		configurable: true,
		writable: true,
		value: { languages, language: languages[0] }
	});
	try {
		return run();
	} finally {
		if (previous === void 0) delete globalThis.navigator;
		else Object.defineProperty(globalThis, "navigator", previous);
	}
};
const zhLabels = withNavigator(["zh-CN"], () => ({ month: exports.monthLabelFull("2026-08"), date: exports.dateLabel("2026-08-13") }));
const enLabels = withNavigator(["en-US"], () => ({ month: exports.monthLabelFull("2026-08"), date: exports.dateLabel("2026-08-13") }));
check("monthLabelFull zh = 2026年8月", zhLabels.month === "2026年8月", zhLabels.month);
check("monthLabelFull en = Aug 2026", enLabels.month === "Aug 2026", enLabels.month);
check("dateLabel zh = 8月13日", zhLabels.date === "8月13日", zhLabels.date);
check("dateLabel en = Aug 13", enLabels.date === "Aug 13", enLabels.date);

// ---- client apply(): slot registrations ---------------------------------
// The card owns its settings now, so the plugin must NOT claim the official
// 设置 → 插件 → 插件配置 seat any more — while still binding the settings
// namespace scope it reads and writes through.
console.log("client apply()");
const injectedSlots = [];
const registeredSlots = [];
let boundNamespace = null;
const applyContext = {
	settingsScope: {
		bind: (options) => {
			boundNamespace = options.namespace;
			return { getSnapshot: () => ({ status: "loading" }), subscribe: () => () => {}, set: async () => {}, load: async () => {} };
		}
	},
	locale: { register: () => () => {} },
	slots: {
		inject: (name, callback) => { injectedSlots.push(name); callback(); },
		register: (options) => { registeredSlots.push(options); return () => {}; }
	},
	effect: (fn) => fn()
};
exports.apply(applyContext);
check("apply registers the input-dock entry only", injectedSlots.length === 1 && injectedSlots[0] === "conversation.input.dock" && registeredSlots.length === 1, JSON.stringify({ injectedSlots, registeredSlots }));
check("apply does NOT register into settings.plugin.item", registeredSlots.every((options) => options.name !== "settings.plugin.item"), JSON.stringify(registeredSlots));
check("dock registration keeps id/locale/order", registeredSlots[0].id === "token-heatmap" && registeredSlots[0].locale === "tokenHeatmap" && registeredSlots[0].order === 10, JSON.stringify(registeredSlots[0]));
check("settings scope still bound to token-heatmap", boundNamespace === "token-heatmap", String(boundNamespace));

// ----------------------------------------------------------- server config route
console.log("server config route");
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
const dshHome = mkdtempSync(join(tmpdir(), "thm-config-"));
process.env.DSH_HOME = dshHome;
const server = await import(pathToFileURL(join(root, "lib/index.js")).href);
const routes = [];
// Minimal in-memory settings service mirroring the provider contract the
// plugin relies on: register/get/describe/update, with schema resolution.
const settingsSections = new Map();
const serverCtx = {
	logger: { warn: () => {} },
	effect: (fn) => fn(),
	webServer: { register: (route) => routes.push(route) },
	settings: {
		register: (ns, schema) => { settingsSections.set(ns, { schema, user: void 0 }); },
		get: (ns) => {
			const entry = settingsSections.get(ns);
			if (entry === void 0) return void 0;
			return entry.schema({ ...(entry.user ?? {}) });
		},
		describe: () => [...settingsSections.entries()].map(([ns, entry]) => ({
			ns,
			schema: null,
			value: entry.schema({ ...(entry.user ?? {}) }),
			revision: 0,
			user: entry.user
		})),
		update: async (ns, patch) => {
			const entry = settingsSections.get(ns);
			if (entry === void 0) throw new Error(`unregistered namespace ${ns}`);
			const next = { ...(entry.user ?? {}), ...patch };
			entry.schema(next); // validate: throws on malformed writes
			entry.user = next;
		}
	}
};
server.apply(serverCtx);
const configRoute = routes.find((route) => route.path === server.CONFIG_PATH);
check("config route registered", configRoute !== void 0);
function makeReq(method, bodyText, peer = "127.0.0.1", host = "localhost") {
	const req = new EventEmitter();
	req.method = method;
	req.socket = { remoteAddress: peer };
	req.headers = { host };
	if (bodyText !== void 0) process.nextTick(() => {
		req.emit("data", Buffer.from(bodyText, "utf8"));
		req.emit("end");
	});
	return req;
}
function makeRes() {
	return {
		status: null,
		writeHead(status) { this.status = status; },
		end(body) { this.body = body; }
	};
}
const getConfig = async (req, res) => { await configRoute.handler(req, res); return JSON.parse(res.body); };
let res = makeRes();
await configRoute.handler(makeReq("GET"), res);
const first = JSON.parse(res.body);
check("GET config → defaults", first.ok === true && first.enabled === true && first.colorScheme === "green" && first.defaultView === "year", JSON.stringify(first));
res = makeRes();
await configRoute.handler(makeReq("POST", JSON.stringify({ enabled: false, colorScheme: "blue", defaultView: "month" })), res);
const saved = JSON.parse(res.body);
// The retired switch stays advertised as true even when a client posts false,
// so a pre-0.2.0 client never hides the card.
check("POST config → saved values", saved.ok === true && saved.enabled === true && saved.colorScheme === "blue" && saved.defaultView === "month", JSON.stringify(saved));
res = makeRes();
await configRoute.handler(makeReq("GET"), res);
const second = JSON.parse(res.body);
check("GET config → persisted values", second.ok === true && second.enabled === true && second.colorScheme === "blue" && second.defaultView === "month", JSON.stringify(second));
const storedSection = settingsSections.get(server.SETTINGS_NAMESPACE).user;
check("settings section updated without the retired switch", JSON.stringify(storedSection) === JSON.stringify({ colorScheme: "blue", defaultView: "month" }), JSON.stringify(storedSection));
check("legacy config file absent after settings-backed write", !existsSync(join(dshHome, "storages", "token-heatmap-config.json")));
res = makeRes();
await configRoute.handler(makeReq("DELETE"), res);
check("POST-only fence → 405 on DELETE", res.status === 405);
res = makeRes();
await configRoute.handler(makeReq("GET", void 0, "10.0.0.5", "evil.example"), res);
check("loopback fence → 403 on foreign peer", res.status === 403);
res = makeRes();
await configRoute.handler(makeReq("POST", "not json"), res);
check("bad JSON body → 400", res.status === 400);
// The write path preserves the client's scheme verbatim (shape-bounded), so a
// newer client's palette survives an older server between restarts.
res = makeRes();
await configRoute.handler(makeReq("POST", JSON.stringify({ enabled: "yes", colorScheme: "rainbow", defaultView: "week" })), res);
const coerced = JSON.parse(res.body);
check("write preserves unknown scheme", coerced.ok === true && coerced.enabled === true && coerced.colorScheme === "rainbow", JSON.stringify(coerced));
check("write bounds the view to known modes", coerced.defaultView === "year", JSON.stringify(coerced));

// ---- legacy migration --------------------------------------------------
console.log("legacy config migration");
const legacyDir = join(dshHome, "storages");
const legacyFile = join(legacyDir, "token-heatmap-config.json");
mkdirSync(legacyDir, { recursive: true });
// 1. Non-default legacy document with no settings section → imported + dropped.
// Its `enabled` switch is retired, so only the surviving fields are imported.
writeFileSync(legacyFile, JSON.stringify({ enabled: false, colorScheme: "purple" }), "utf8");
settingsSections.get(server.SETTINGS_NAMESPACE).user = void 0;
await server.migrateLegacyConfig(serverCtx);
check("migration imports non-default values", JSON.stringify(settingsSections.get(server.SETTINGS_NAMESPACE).user) === JSON.stringify({ colorScheme: "purple" }), JSON.stringify(settingsSections.get(server.SETTINGS_NAMESPACE).user));
check("migration removes the legacy file", !existsSync(legacyFile));
// 2. Defaults-only legacy document → dropped without touching the section.
writeFileSync(legacyFile, JSON.stringify({ enabled: true, colorScheme: "green" }), "utf8");
settingsSections.get(server.SETTINGS_NAMESPACE).user = { enabled: false, colorScheme: "blue" };
await server.migrateLegacyConfig(serverCtx);
check("migration keeps an existing settings section", JSON.stringify(settingsSections.get(server.SETTINGS_NAMESPACE).user) === JSON.stringify({ enabled: false, colorScheme: "blue" }), JSON.stringify(settingsSections.get(server.SETTINGS_NAMESPACE).user));
check("migration still drops the file", !existsSync(legacyFile));
// 3. Corrupt legacy document → dropped, nothing imported.
writeFileSync(legacyFile, "not json", "utf8");
settingsSections.get(server.SETTINGS_NAMESPACE).user = void 0;
await server.migrateLegacyConfig(serverCtx);
check("migration drops a corrupt document", !existsSync(legacyFile));
check("migration imports nothing from a corrupt document", settingsSections.get(server.SETTINGS_NAMESPACE).user === void 0);

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
