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
const defaults = { enabled: true, colorScheme: "green" };
check("default config shape", JSON.stringify(config.DEFAULT_CONFIG) === JSON.stringify(defaults));
check("parseConfig(undefined) → defaults", JSON.stringify(config.parseConfig(undefined)) === JSON.stringify(defaults));
check("parseConfig(null) → defaults", JSON.stringify(config.parseConfig(null)) === JSON.stringify(defaults));
check("parseConfig({}) → defaults", JSON.stringify(config.parseConfig({})) === JSON.stringify(defaults));
check("parseConfig({enabled:false}) keeps scheme default", JSON.stringify(config.parseConfig({ enabled: false })) === JSON.stringify({ enabled: false, colorScheme: "green" }));
check("parseConfig({colorScheme:\"blue\"}) keeps enabled default", JSON.stringify(config.parseConfig({ colorScheme: "blue" })) === JSON.stringify({ enabled: true, colorScheme: "blue" }));
check("parseConfig full override", JSON.stringify(config.parseConfig({ enabled: false, colorScheme: "blue" })) === JSON.stringify({ enabled: false, colorScheme: "blue" }));
check("invalid fields fall back to defaults", JSON.stringify(config.parseConfig({ enabled: "yes", junk: 1 })) === JSON.stringify(defaults));
check("unknown scheme preserved verbatim", JSON.stringify(config.parseConfig({ colorScheme: "rainbow" })) === JSON.stringify({ enabled: true, colorScheme: "rainbow" }));
check("blank scheme falls back to default", config.parseConfig({ colorScheme: "   " }).colorScheme === "green");
check("overlong scheme falls back to default", config.parseConfig({ colorScheme: "x".repeat(40) }).colorScheme === "green");
check("new scheme accepted by parseConfig", JSON.stringify(config.parseConfig({ colorScheme: "teal" })) === JSON.stringify({ enabled: true, colorScheme: "teal" }));
check("COLOR_SCHEMES lists all six schemes", JSON.stringify(config.COLOR_SCHEMES) === JSON.stringify(["green", "blue", "orange", "red", "purple", "teal"]));

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
const requireFromProfile = createRequire(pathToFileURL(join(process.env.USERPROFILE ?? "C:\\Users\\me", ".dsh", "profiles", "node_modules", "react", "package.json")));
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
check("settings card exported", typeof exports.TokenHeatmapSettingsCard === "function");
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

// ----------------------------------------------------------- server config route
console.log("server config route");
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
const dshHome = mkdtempSync(join(tmpdir(), "thm-config-"));
process.env.DSH_HOME = dshHome;
const server = await import(pathToFileURL(join(root, "lib/index.js")).href);
const routes = [];
const serverCtx = {
	logger: { warn: () => {} },
	effect: (fn) => fn(),
	webServer: { register: (route) => routes.push(route) }
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
check("GET config → defaults", first.ok === true && first.enabled === true && first.colorScheme === "green", JSON.stringify(first));
res = makeRes();
await configRoute.handler(makeReq("POST", JSON.stringify({ enabled: false, colorScheme: "blue" })), res);
const saved = JSON.parse(res.body);
check("POST config → saved values", saved.ok === true && saved.enabled === false && saved.colorScheme === "blue", JSON.stringify(saved));
res = makeRes();
await configRoute.handler(makeReq("GET"), res);
const second = JSON.parse(res.body);
check("GET config → persisted values", second.ok === true && second.enabled === false && second.colorScheme === "blue", JSON.stringify(second));
check("config file written under DSH_HOME", readFileSync(join(dshHome, "storages", "token-heatmap-config.json"), "utf8").includes('"colorScheme": "blue"'));
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
await configRoute.handler(makeReq("POST", JSON.stringify({ enabled: "yes", colorScheme: "rainbow" })), res);
const coerced = JSON.parse(res.body);
check("write preserves unknown scheme", coerced.ok === true && coerced.enabled === true && coerced.colorScheme === "rainbow", JSON.stringify(coerced));

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
