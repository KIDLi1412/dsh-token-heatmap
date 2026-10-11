/**
 * dsh-token-heatmap — server half.
 *
 * Registers two loopback-only endpoints on the web server:
 *   GET  /api/token-heatmap/usage  — per-day token usage across every session
 *   GET  /api/token-heatmap/config — the plugin's display settings
 *   POST /api/token-heatmap/config — persist display settings (switch + scheme)
 *
 * The endpoints live under the `/api` prefix as exact routes, so they win
 * over the connection plugin's `/api` prefix handler; each handler applies
 * its own peer-socket loopback fence (the exact route bypasses the RPC trust
 * fence); Host is checked only as an additional defense.
 *
 * Display settings (colorScheme + defaultView) are owned by this plugin's
 * profile CONFIG — DSH 0.2.0 derives the settings form from the exported
 * `Config` schema, keys it by the profile entry id (`token-heatmap`, the id of
 * the row our bundle patch inserts), and the browser edits it through
 * `ctx.configForms.get("token-heatmap")`. The form serves `.volatile()` fields
 * only, so BOTH fields carry that flag (see `Config`). The plugin's own ⚙
 * panel writes the same values; the legacy
 * `<DSH_HOME>/storages/token-heatmap-config.json` document is migrated into it
 * once at startup.
 *
 * Usage aggregation is INCREMENTAL: per-session fold state (day/model
 * buckets plus the last usage sample) is cached in memory and persisted to
 * `<DSH_HOME>/storages/token-heatmap-cache.json`. On each request only the
 * events added since the last fold are processed — live sessions fold their
 * in-memory tail, while persisted sessions use the storage backend's opaque
 * revision when available. Steady-state cost stays O(new events) no matter
 * how large the logs grow.
 *
 * The fold semantics live in ./usage.js and mirror `dsh-token-meter`'s
 * `tokenUsage` projection (same semantics as the reference plugin
 * dsh-usage-stats, MIT © Ychris12138).
 *
 * @module dsh-token-heatmap
 */

import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { applyUsageDelta, createUsageState, mergeInto, renderUsage, zeroBuckets } from "./usage.js";
import { DEFAULT_CONFIG, VIEW_MODES, parseConfig } from "./config.js";
import z from "@deepseek-ai/schemastery";

/** Stable Cordis plugin name. */
const name = "token-heatmap";

/** Services required before this plugin activates. */
const inject = ["webServer", "sessions", "sessionPersistence", "settings"];

//#region plugin config
/**
 * Profile entry id this plugin's config form is keyed by: the `id` of the row
 * the bundle patch inserts, which is also what the browser asks
 * `ctx.configForms.get(...)` for. DSH 0.2.0 derives the form from the exported
 * `Config` schema, so no registration call exists (nor does `settings.get`).
 */
const SETTINGS_NAMESPACE = "token-heatmap";

/**
 * Durable display preferences; also the wire envelope the browser form
 * validates against. Scheme membership is deliberately NOT enforced (a newer
 * client may know a palette the server does not — the client falls back to
 * green); only the same shape bounds parseConfig applies: a short, non-blank
 * string. `defaultView` is bounded to the rendered view modes (year/month).
 *
 * Both fields MUST stay `.volatile()`: DSH 0.2.0 derives every settings form
 * from the VOLATILE subtree alone (`volatileForm()` in dsh-settings), so an
 * entry whose fields are all plain is dropped from `settings.describe()` —
 * the entry never reaches the browser form, and `settings.update()` throws
 * `Plugin entry "token-heatmap" has no volatile fields`. Either way the ⚙
 * panel silently keeps serving the defaults: 设置不生效. `.volatile()` makes
 * schemastery hand out a cosmokit reference (`{ get() }`) instead of the raw
 * value, so a direct parse of this schema yields wrappers — `entryConfig()`
 * unwraps them below (DSH's own `describe()` already serves plain values).
 *
 * The 0.1.x `enabled` master switch is gone: the card is always rendered on
 * the hero screen, so the field is neither accepted nor served (an old
 * settings.yaml keeps its dead `enabled` key, and nothing reads it). It must
 * NOT come back as a schema field either: a volatile `enabled` would put a
 * second, Host-rendered switch next to the card's own panel.
 */
const Config = z.object({
	colorScheme: z.string().min(1).max(32).default("green").volatile(),
	defaultView: z.union(VIEW_MODES.map((mode) => z.const(mode))).default("year").volatile()
});
/** @deprecated 0.1.x name; the schema IS the config now. Kept for old importers. */
const TokenHeatmapSettingsSchema = Config;
//#endregion

const USAGE_PATH = "/api/token-heatmap/usage";
const CONFIG_PATH = "/api/token-heatmap/config";
/**
 * Cache format version. 2 folds every session from its fork cut (see
 * `forkCutOf`): a version-1 cache may hold a forked child's inherited prefix —
 * the parent's tokens, already folded under the parent — so it is rebuilt.
 */
const CACHE_VERSION = 2;

/** Write a JSON response. */
function json(res, status, value) {
	const body = JSON.stringify(value);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-cache"
	});
	res.end(body);
}

/**
 * Loopback fence, primary on the PEER SOCKET address (not the
 * client-controllable Host header): the request must come from a loopback
 * interface. IPv4-mapped IPv6 (`::ffff:127.0.0.1`) is normalized. The Host
 * header is kept as an additional check, never as the deciding one.
 */
function isLoopbackAddress(address) {
	if (typeof address !== "string") return false;
	const a = address.toLowerCase();
	if (a === "::1") return true;
	const ipv4 = a.startsWith("::ffff:") ? a.slice(7) : a;
	const octets = ipv4.split(".");
	return octets.length === 4 && octets[0] === "127" && octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/** Parse a Host header without breaking bracketed or bare IPv6 literals. */
function hostNameOf(value) {
	if (typeof value !== "string") return null;
	const host = value.trim().toLowerCase();
	if (host.startsWith("[")) {
		const close = host.indexOf("]");
		if (close <= 1) return null;
		const suffix = host.slice(close + 1);
		if (suffix !== "" && !/^:\d+$/.test(suffix)) return null;
		return host.slice(1, close);
	}
	const firstColon = host.indexOf(":");
	const lastColon = host.lastIndexOf(":");
	if (firstColon !== lastColon) return host;
	if (lastColon === -1) return host.replace(/\.$/, "");
	if (!/^\d+$/.test(host.slice(lastColon + 1))) return null;
	return host.slice(0, lastColon).replace(/\.$/, "");
}

function isLoopbackHostHeader(req) {
	const hostName = hostNameOf(req.headers.host);
	return hostName === "localhost" || isLoopbackAddress(hostName);
}

/** Refuse callers whose peer socket is not loopback (Host header is defense-in-depth). */
function isLoopbackCaller(req) {
	const peer = req.socket?.remoteAddress;
	return isLoopbackAddress(peer) && isLoopbackHostHeader(req);
}

/** Refuse non-loopback callers and non-GET methods before any work. */
function rejectForeignCaller(req, res) {
	if (req.method !== "GET") {
		res.writeHead(405, { "content-type": "application/json; charset=utf-8" });
		res.end(JSON.stringify({ ok: false, error: "method-not-allowed" }));
		return true;
	}
	if (isLoopbackCaller(req)) return false;
	json(res, 403, { ok: false, error: "forbidden" });
	return true;
}

/** Refuse non-loopback callers and non-GET/POST methods before config work. */
function rejectForeignConfigCaller(req, res) {
	if (req.method !== "GET" && req.method !== "POST") {
		res.writeHead(405, { "content-type": "application/json; charset=utf-8" });
		res.end(JSON.stringify({ ok: false, error: "method-not-allowed" }));
		return true;
	}
	if (isLoopbackCaller(req)) return false;
	json(res, 403, { ok: false, error: "forbidden" });
	return true;
}

/** Collect a bounded request body as UTF-8 text. */
function readBody(req, limit = 4096) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > limit) {
				reject(new Error("request body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

//#region incremental cache
/** Cache file location under the dsh home. */
function cachePath() {
	const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
	return join(home, "storages", "token-heatmap-cache.json");
}

let loadedCache = null;
let loadPromise = null;
let inflight = null;

/** Serialize one session's fold state (Maps → plain objects). */
function serializeSession(state) {
	const days = {};
	for (const [date, entry] of state.days) {
		const models = {};
		for (const [model, buckets] of entry.models) models[model] = { ...buckets };
		days[date] = { totals: { ...entry.totals }, models };
	}
	return {
		kind: state.kind ?? "persisted",
		consumed: state.consumed ?? 0,
		...(state.skipUntil === void 0 || state.skipUntil === 0 ? {} : { skipUntil: state.skipUntil }),
		...(state.revision === void 0 ? {} : { revision: state.revision }),
		days,
		lastSample: state.lastSample === null ? null : {
			key: state.lastSample.key,
			day: state.lastSample.day,
			model: state.lastSample.model,
			buckets: { ...state.lastSample.buckets }
		},
		currentModel: state.currentModel
	};
}

/** Parse a serialized session entry back into fold state (lenient). */
function parseSession(raw) {
	const state = createUsageState();
	if (raw === null || typeof raw !== "object") return state;
	state.kind = typeof raw.kind === "string" ? raw.kind : "persisted";
	state.consumed = Number.isSafeInteger(raw.consumed) ? raw.consumed : 0;
	// Missing in a hand-edited or legacy entry: 0 means "no fork cut known",
	// which only re-folds the inherited prefix once, on the next pass.
	state.skipUntil = Number.isSafeInteger(raw.skipUntil) && raw.skipUntil > 0 ? raw.skipUntil : 0;
	if (typeof raw.revision === "string") state.revision = raw.revision;
	if (raw.days !== null && typeof raw.days === "object") {
		for (const [date, entry] of Object.entries(raw.days)) {
			if (entry === null || typeof entry !== "object") continue;
			const target = { totals: zeroBuckets(), models: new Map() };
			const totals = entry.totals;
			if (totals !== null && typeof totals === "object") {
				target.totals.inputTokens = Number.isFinite(totals.inputTokens) ? totals.inputTokens : 0;
				target.totals.outputTokens = Number.isFinite(totals.outputTokens) ? totals.outputTokens : 0;
				target.totals.cacheReadTokens = Number.isFinite(totals.cacheReadTokens) ? totals.cacheReadTokens : 0;
				target.totals.cacheWriteTokens = Number.isFinite(totals.cacheWriteTokens) ? totals.cacheWriteTokens : 0;
			}
			if (entry.models !== null && typeof entry.models === "object") {
				for (const [model, buckets] of Object.entries(entry.models)) {
					if (buckets === null || typeof buckets !== "object") continue;
					target.models.set(model, {
						inputTokens: Number.isFinite(buckets.inputTokens) ? buckets.inputTokens : 0,
						outputTokens: Number.isFinite(buckets.outputTokens) ? buckets.outputTokens : 0,
						cacheReadTokens: Number.isFinite(buckets.cacheReadTokens) ? buckets.cacheReadTokens : 0,
						cacheWriteTokens: Number.isFinite(buckets.cacheWriteTokens) ? buckets.cacheWriteTokens : 0
					});
				}
			}
			state.days.set(date, target);
		}
	}
	if (raw.lastSample !== null && raw.lastSample !== void 0 && typeof raw.lastSample === "object" && typeof raw.lastSample.key === "string" && typeof raw.lastSample.day === "string") {
		const buckets = raw.lastSample.buckets ?? {};
		state.lastSample = {
			key: raw.lastSample.key,
			day: raw.lastSample.day,
			model: typeof raw.lastSample.model === "string" ? raw.lastSample.model : "unknown",
			buckets: {
				inputTokens: Number.isFinite(buckets.inputTokens) ? buckets.inputTokens : 0,
				outputTokens: Number.isFinite(buckets.outputTokens) ? buckets.outputTokens : 0,
				cacheReadTokens: Number.isFinite(buckets.cacheReadTokens) ? buckets.cacheReadTokens : 0,
				cacheWriteTokens: Number.isFinite(buckets.cacheWriteTokens) ? buckets.cacheWriteTokens : 0
			}
		};
	}
	if (typeof raw.currentModel === "string") state.currentModel = raw.currentModel;
	return state;
}

/** Load the cache once per process; any corruption degrades to a fresh cache. */
async function loadCache() {
	if (loadedCache !== null) return loadedCache;
	loadPromise ??= (async () => {
		const fresh = { version: CACHE_VERSION, sessions: {} };
		try {
			const raw = await readFile(cachePath(), "utf8");
			const parsed = JSON.parse(raw);
			if (parsed !== null && typeof parsed === "object" && parsed.version === CACHE_VERSION && parsed.sessions !== null && typeof parsed.sessions === "object") {
				const sessions = {};
				for (const [id, entry] of Object.entries(parsed.sessions)) {
					if (typeof id === "string" && id.length > 0) sessions[id] = parseSession(entry);
				}
				return { version: CACHE_VERSION, sessions };
			}
		} catch {
			/* first run or corrupt cache */
		}
		return fresh;
	})();
	loadedCache = await loadPromise;
	return loadedCache;
}

/** Persist the cache atomically (temp + rename); failures are logged, never fatal. */
async function saveCache(ctx, cache) {
	try {
		const path = cachePath();
		await mkdir(dirname(path), { recursive: true });
		const serialized = { version: CACHE_VERSION, sessions: {} };
		for (const [id, state] of Object.entries(cache.sessions)) serialized.sessions[id] = serializeSession(state);
		const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
		await writeFile(tmp, JSON.stringify(serialized), "utf8");
		await rename(tmp, path);
	} catch (error) {
		ctx.logger.warn(`token-heatmap: saving usage cache failed: ${String(error)}`);
	}
}

/** Single-flight guard: concurrent requests share one aggregation run. */
function withLock(run) {
	if (inflight !== null) return inflight;
	inflight = run().finally(() => {
		inflight = null;
	});
	return inflight;
}
//#endregion

//#region config route + legacy migration
/** Legacy config file location under the dsh home (pre-0.1.2 storage). */
function configPath() {
	const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
	return join(home, "storages", "token-heatmap-config.json");
}

/** DSH home resolution, mirroring `@deepseek-ai/dsh-home-paths` (no extra peer). */
function dshHomeDirectory(env = process.env) {
	const configured = env.DSH_HOME;
	if (typeof configured === "string" && configured.trim() !== "") return configured.trim();
	return join(homedir(), ".dsh");
}

/**
 * One profile entry's descriptor from the settings service, or undefined when
 * the service is absent or the entry is not live. DSH 0.2.0 dropped the old
 * `settings.get(ns)` accessor — a plugin's settings ARE its profile entry
 * config now — so reads go through the same `describe()` view the settings UI
 * renders (its `value` is the resolved section, its `user` the raw user layer).
 * @param ctx - plugin context.
 * @param entryId - profile entry id (`token-heatmap`).
 * @returns the descriptor, or undefined.
 */
function entryDescriptor(ctx, entryId) {
	const settings = typeof ctx.get === "function" ? ctx.get("settings") : ctx.settings;
	if (settings === null || settings === void 0 || typeof settings.describe !== "function") return void 0;
	try {
		return settings.describe().find((row) => row.ns === entryId);
	} catch {
		return void 0;
	}
}

/**
 * The cosmokit volatile-reference protocol, declared by hand because this
 * plugin never imports cosmokit: `createVolatile()` stamps a registered Symbol
 * (so the reference is recognized across ESM/CJS copies) and exposes the
 * snapshot through `get()`. A `.volatile()` schema field parses to one of
 * these, which is what makes it editable live in DSH's settings form.
 */
const VOLATILE_WRITE = Symbol.for("cosmokit.volatile.write");

/**
 * One config field's plain value: a volatile reference reads through `get()`,
 * anything else is returned as-is.
 * @param value - one field out of a parsed Config section.
 * @returns the snapshot (the plain value) for that field.
 */
function scalarOf(value) {
	if (value === null || typeof value !== "object" || !(VOLATILE_WRITE in value)) return value;
	if (typeof value.get !== "function") return void 0;
	try {
		return value.get();
	} catch {
		return void 0;
	}
}

/**
 * One profile entry's resolved config section, read through the settings
 * service. DSH's own `describe()` already projects plain values, but a host
 * that hands out the raw parsed config (or this plugin's own test doubles)
 * would give us volatile references instead — unwrap them here so no caller
 * can mistake a `{ get() }` wrapper for the value and silently fall back to
 * the defaults.
 * @param ctx - plugin context.
 * @param entryId - profile entry id (`token-heatmap`).
 * @returns the resolved section with plain field values, or undefined when the
 * entry is absent.
 */
function entryConfig(ctx, entryId) {
	const value = entryDescriptor(ctx, entryId)?.value;
	if (value === null || typeof value !== "object") return void 0;
	return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, scalarOf(field)]));
}

/**
 * Best-effort read of one scalar out of the pre-0.2.0 `settings.yaml` section
 * for this entry. DSH's own importer moves those sections into the profile
 * once, keyed by entry id — and skipped ours while the bundle was refused for
 * incompatible peers, leaving the value only in the renamed document. This is
 * a deliberately narrow scan (one top-level section, one scalar) rather than a
 * YAML dependency: anything it cannot read is simply left for the user.
 * @param text - contents of `settings.yaml` or `settings.yaml.imported`.
 * @param section - top-level section name (`token-heatmap`).
 * @param field - scalar key inside it.
 * @returns the raw trimmed string value, or null.
 */
function legacySettingFromDocument(text, section, field) {
	if (typeof text !== "string") return null;
	const lines = text.split(/\r?\n/);
	const inSection = /^[^\s#][^:]*:/;
	let inside = false;
	for (const line of lines) {
		if (inSection.test(line)) {
			inside = line.trim() === `${section}:` && !line.startsWith(" ");
			continue;
		}
		if (!inside) continue;
		const match = /^\s+([A-Za-z0-9_-]+):\s*(.*?)\s*$/.exec(line);
		if (match === null || match[1] !== field) continue;
		return match[2].replace(/\s+#.*$/, "").replace(/^["']|["']$/g, "");
	}
	return null;
}

/** Files the legacy value may still live in, newest name first. */
const LEGACY_SETTINGS_FILES = ["settings.yaml.imported", "settings.yaml"];

/**
 * One-time rescue of display preferences from the removed settings document.
 *
 * DSH 0.2.0 imported the old `settings.yaml` sections per entry id, but this
 * plugin was refused (incompatible peers) at that moment, so its section —
 * `colorScheme` / `defaultView`, plus the dead `enabled` — only survives in
 * the renamed document. Runs only when the entry has no user value yet, only
 * for non-default fields, best effort, never blocking.
 * @param ctx - plugin context carrying the settings service.
 */
async function rescueRemovedSettingsDocument(ctx) {
	try {
		const descriptor = entryDescriptor(ctx, SETTINGS_NAMESPACE);
		if (descriptor === void 0) return;
		const settings = typeof ctx.get === "function" ? ctx.get("settings") : ctx.settings;
		const user = descriptor.user;
		if (user !== null && typeof user === "object" && (Object.hasOwn(user, "colorScheme") || Object.hasOwn(user, "defaultView"))) return;
		const home = dshHomeDirectory();
		let text = null;
		for (const file of LEGACY_SETTINGS_FILES) {
			try {
				text = readFileSync(join(home, file), "utf8");
			} catch {
				continue;
			}
			if (text !== null) break;
		}
		if (text === null) return;
		const patch = {};
		const scheme = legacySettingFromDocument(text, SETTINGS_NAMESPACE, "colorScheme");
		if (scheme !== null && scheme !== DEFAULT_CONFIG.colorScheme) patch.colorScheme = scheme;
		const view = legacySettingFromDocument(text, SETTINGS_NAMESPACE, "defaultView");
		if (view !== null && VIEW_MODES.includes(view) && view !== DEFAULT_CONFIG.defaultView) patch.defaultView = view;
		if (Object.keys(patch).length === 0) return;
		await settings.update(SETTINGS_NAMESPACE, patch);
		ctx.logger.info(`token-heatmap: carried ${JSON.stringify(patch)} over from the removed settings.yaml`);
	} catch (error) {
		ctx.logger.warn(`token-heatmap: legacy settings rescue skipped: ${String(error)}`);
	}
}

/**
 * One-time migration from the legacy config document
 * (`<DSH_HOME>/storages/token-heatmap-config.json`) into the plugin config.
 * Runs once per process, best-effort: when the user has no config value yet,
 * non-default values are imported through the settings write path; the legacy
 * file is removed either way (the config entry becomes the single source of
 * truth). A corrupt legacy document is dropped, never imported. Failures are
 * logged and never fatal.
 * @param ctx - plugin context carrying the settings service.
 */
async function migrateLegacyConfig(ctx) {
	try {
		const path = configPath();
		let rawText;
		try {
			rawText = await readFile(path, "utf8");
		} catch {
			return; // no legacy document
		}
		let legacy;
		try {
			legacy = parseConfig(JSON.parse(rawText));
		} catch {
			await rm(path, { force: true });
			return;
		}
		const descriptor = entryDescriptor(ctx, SETTINGS_NAMESPACE);
		const settings = typeof ctx.get === "function" ? ctx.get("settings") : ctx.settings;
		const userExists = descriptor !== void 0 && descriptor.user !== void 0;
		if (!userExists && settings !== void 0 && typeof settings.update === "function") {
			const patch = {};
			// The legacy document's `enabled` switch died with 0.2.0: import only
			// what the card still owns.
			if (legacy.colorScheme !== DEFAULT_CONFIG.colorScheme) patch.colorScheme = legacy.colorScheme;
			if (legacy.defaultView !== DEFAULT_CONFIG.defaultView) patch.defaultView = legacy.defaultView;
			if (Object.keys(patch).length > 0) await settings.update(SETTINGS_NAMESPACE, patch);
		}
		await rm(path, { force: true });
	} catch (error) {
		ctx.logger.warn(`token-heatmap: migrating legacy config failed: ${String(error)}`);
	}
}

/**
 * Serve the resolved config section (schema defaults + user layer).
 * `enabled` stays in the payload as a constant true: the legacy loopback
 * endpoint is a back-compat API, and a pre-0.2.0 client that reads it must not
 * lose the card over a switch this version no longer has.
 */
function serveConfig(ctx) {
	const section = entryConfig(ctx, SETTINGS_NAMESPACE);
	const scheme = typeof section?.colorScheme === "string" && section.colorScheme.length > 0 ? section.colorScheme : DEFAULT_CONFIG.colorScheme;
	const view = typeof section?.defaultView === "string" && VIEW_MODES.includes(section.defaultView) ? section.defaultView : DEFAULT_CONFIG.defaultView;
	return { enabled: true, colorScheme: scheme, defaultView: view };
}

async function handleConfig(ctx, req, res) {
	if (rejectForeignConfigCaller(req, res)) return;
	try {
		if (req.method === "GET") {
			json(res, 200, { ok: true, ...serveConfig(ctx) });
			return;
		}
		let raw;
		try {
			raw = JSON.parse(await readBody(req));
		} catch (error) {
			json(res, 400, { ok: false, error: "bad-json", message: "request body must be a JSON object" });
			return;
		}
		// parseConfig coerces the write the same way the legacy file path did
		// (boolean check, scheme trimmed and shape-bounded, unknown schemes kept
		// verbatim); the settings schema then validates the canonical shape.
		const config = parseConfig(raw);
		await ctx.settings.update(SETTINGS_NAMESPACE, config);
		json(res, 200, { ok: true, ...serveConfig(ctx) });
	} catch (error) {
		ctx.logger.warn(`token-heatmap: config ${req.method} failed: ${String(error)}`);
		json(res, 500, { ok: false, error: "internal", message: error instanceof Error ? error.message : String(error) });
	}
}
//#endregion

/**
 * Enumerate a live session's events from an offset, across session shapes.
 *
 * Pre-0.1.2 sessions kept the whole log on the object as `.events`; DSH
 * 0.1.2+ (rc.1) live sessions expose no `.events` array — the count is
 * `session.seq` and each event is read via `session.eventAt(seq)` (0-based,
 * the same reads @deepseek-ai/dsh-token-meter uses).
 * @returns `{ count, events }` — `count` the session's total event count,
 *   `events` the events from `from` onward.
 */
function liveSessionEvents(session, from) {
	if (Array.isArray(session.events)) {
		return { count: session.events.length, events: session.events.slice(from) };
	}
	if (typeof session.seq !== "number" || typeof session.eventAt !== "function") {
		return { count: 0, events: [] };
	}
	const events = [];
	for (let seq = from; seq < session.seq; seq += 1) {
		const event = session.eventAt(seq);
		if (event !== void 0) events.push(event);
	}
	return { count: session.seq, events };
}

/**
 * Fork-inherited prefix length of a live session: the number of leading
 * events copied from its parent at fork time. Those events carry the PARENT's
 * usage and are folded when the parent is folded, so a seeded child must skip
 * them or the same tokens are counted twice (measured 2026-09-14: 13.15e8
 * instead of 8.34e8).
 *
 * `header.isSeeded` marks fork lineage and `inheritedEventCount` is the exact
 * cut (both are official Session state on 0.1.2+, the cut is what
 * `Session.ownEvents()` starts from). `isSeeded` alone is NOT enough: a
 * resumed session also carries a constructor seed, but that seed is its OWN
 * history and must be folded in full.
 * @returns the inherited prefix length, or 0 when the session is not a fork.
 */
function forkCutOf(session) {
	if (session === null || typeof session !== "object") return 0;
	if (session.header?.isSeeded !== true) return 0;
	const inherited = session.inheritedEventCount;
	return typeof inherited === "number" && Number.isSafeInteger(inherited) && inherited > 0 ? inherited : 0;
}

/**
 * Fork-inherited prefix length read from a STORED event log. DSH projects the
 * in-process `inheritedEventCount` into the log as the LAST `session/end-seed`
 * event carrying `{ inherited: true }` (an UNMARKED `session/end-seed` is a
 * compaction boundary, not a fork cut), so that event's seq + 1 is the cut.
 * This mirrors `dsh-session-format-v2-to-v3`, which derives the restored cut
 * from that same marker.
 * @returns the inherited prefix length, or 0 when the log carries no fork cut.
 */
function forkCutOfEvents(events) {
	let cut = 0;
	for (const event of events) {
		if (event?.type === "session/end-seed" && event.data?.inherited === true && typeof event.seq === "number") {
			cut = Math.max(cut, event.seq + 1);
		}
	}
	return cut;
}

/** First seq a session's fold may read: its fork cut, never past its cursor. */
function liveFoldFrom(consumed, cut) {
	return Math.max(consumed, cut);
}

/** Drop a session's folded days so the next fold starts at its fork cut. */
function resetFold(state, cut) {
	state.days = new Map();
	state.lastSample = null;
	state.currentModel = null;
	state.consumed = 0;
	state.skipUntil = cut;
}

/**
 * Read one stored session's events from `fromSeq` onward, across the two
 * `sessionPersistence` generations this plugin declares compatibility with:
 *
 * - 0.1.0-rc.8 … 0.1.2-rc.1 expose `readFrom(id, fromSeq)`, a RANGE read: the
 *   events come back from `fromSeq` on, so an empty result means "nothing new";
 * - 0.1.3-alpha.2 and later dropped `readFrom`/`listSnapshots` in favour of
 *   `open(id, "read")` + `handle.read()`, which returns the WHOLE log — the
 *   caller's `seq`-based delta filter makes the extra prefix harmless.
 *
 * @returns `{ events, whole }`, whose `whole` flag keeps those two result
 *   shapes apart: an empty result means "this log holds no such events" for a
 *   whole read, but "nothing new since `fromSeq`" for a range read. `null` when
 *   the backend offers neither read path (callers must not treat that as an
 *   empty log).
 */
async function readSessionEvents(persistence, id, fromSeq) {
	if (typeof persistence.readFrom === "function") {
		const { events } = await persistence.readFrom(id, fromSeq);
		return { events, whole: false };
	}
	if (typeof persistence.open === "function") {
		const handle = await persistence.open(id, "read");
		try {
			const { events } = await handle.read();
			return { events, whole: true };
		} finally {
			if (typeof handle.close === "function") await handle.close();
		}
	}
	return null;
}

/**
 * Whether two opaque backend revisions prove that the log FILE did not change.
 *
 * A revision can move while this log sits untouched, and on 0.2.0 it usually
 * does: the jsonl backend stamps a pre-v4 log with
 * `${fileRevision}:${historicalCorpusRevision}`, where the corpus part is a
 * sha256 over EVERY session file (its `list()` and `historicalCorpusRevision`),
 * so one append anywhere — including the session the user is typing in — moves
 * the revision of every pre-v4 session at once (measured on a real install: 124
 * of 181 cached sessions carried one shared corpus hash). `fileRevision` is
 * `dev:ino:size:mtimeNs:ctimeNs`, whose mtime part changes on any write, so an
 * identical leading fingerprint proves this log's bytes did not change and the
 * days folded from it are still exact.
 *
 * Deliberately best-effort and fail-safe: the trailing part must look like the
 * interposed digest (32+ hex) and the leading part like a stat fingerprint, so
 * a token of any other shape — `memory:<name>:<counter>` from the in-memory
 * backend, or a future format — is never "proven same" and only costs the read
 * it would have cost before. The two shapes this recognizes are exactly the two
 * 0.2.0 emits.
 * @param previous - the revision stored in the cache (`state.revision`).
 * @param revision - the revision the backend reports now.
 * @returns whether the two share a stat fingerprint, i.e. the file is unchanged.
 */
function sameLogFile(previous, revision) {
	if (typeof previous !== "string" || typeof revision !== "string" || previous === revision) return false;
	/** The leading stat fingerprint of one revision, or null when unrecognizable. */
	const fingerprint = (value) => {
		const at = value.lastIndexOf(":");
		if (at <= 0 || !/^[0-9a-f]{32,}$/.test(value.slice(at + 1))) return null;
		const head = value.slice(0, at);
		return /^[0-9]+(:[0-9]+){2,}$/.test(head) ? head : null;
	};
	const head = fingerprint(revision);
	return head !== null && head === fingerprint(previous);
}

/**
 * Collect per-day usage across live and persisted sessions, incrementally.
 *
 * Live sessions: fold only the in-memory events added since the last fold.
 * Persisted sessions: enumerated through `sessionPersistence` and skipped when
 * the backend's opaque revision is unchanged (`listSnapshots` on the 0.1.2
 * train, `list()` on 0.1.3+). When the revision moves, the log is read and the
 * events past `consumed` — the seq of the last event already folded — are
 * folded on top of the cached days when they are contiguous; anything else
 * (no owned events, a shorter log, a gap, a rewrite at the same length) rebuilds
 * the session from its cut, and a revision that merely carries a different
 * corpus fingerprint leaves the file provably untouched, so nothing is even
 * read (`sameLogFile`). Sessions that vanished are dropped, and a session
 * switching between live/persisted is refolded from scratch to stay exact.
 * A backend that offers neither `readFrom()` nor `open()` (the 0.1.2+ shape
 * this plugin was first adapted to) cannot be read at all: its already-folded
 * days are kept untouched and the session/event listener covers everything
 * appended from now on.
 *
 * FORKED sessions (`header.isSeeded`) start their log with a copy of the
 * parent's events. That prefix belongs to the parent and is folded there, so
 * both the live and the stored path fold from the session's fork cut
 * (`skipUntil`) instead of seq 0; discovering or moving a cut refolds the
 * session from it.
 */
export async function collectUsage(ctx) {
	return withLock(async () => {
		// Primary: incremental session-event fold. The session/event listener
		// (see apply) folds live sessions in real time regardless of hero-screen
		// mounting; this request-time fold is a sync point that catches anything
		// the listener has not yet reached. Both share the per-session `consumed`
		// cursor, so they never double count.
		const cache = await loadCache();
		const live = ctx.get("sessions");
		const attached = new Set();
		if (live !== void 0) {
			for (const session of live.list()) {
				attached.add(session.id);
				const state = cache.sessions[session.id] ?? createUsageState();
				const cut = forkCutOf(session);
				if (state.kind !== "live" || (state.skipUntil ?? 0) !== cut) {
					// Live/persisted transition, or the fork cut was (re)discovered:
					// refold from the cut. The inherited prefix stays folded under
					// the parent, so starting at the cut avoids double counting it.
					resetFold(state, cut);
				}
				const from = liveFoldFrom(state.consumed ?? 0, cut);
				const { count, events } = liveSessionEvents(session, from);
				if (from < count) {
					applyUsageDelta(state, events);
					state.consumed = count;
				}
				state.kind = "live";
				cache.sessions[session.id] = state;
			}
		}
		const persistence = ctx.get("sessionPersistence");
		const persistedIds = new Set();
		const canEnumeratePersisted = persistence !== void 0 && (
			typeof persistence.list === "function" || typeof persistence.listSnapshots === "function"
		);
		if (canEnumeratePersisted) {
			// Prefer the backend's opaque per-log revisions (no file I/O in the
			// plugin): `listSnapshots` is the 0.1.2 spelling, `list()` returns
			// the same snapshots on 0.1.3+.
			let snapshots = null;
			if (typeof persistence.listSnapshots === "function") {
				try {
					snapshots = await persistence.listSnapshots();
				} catch (error) {
					ctx.logger.warn(`token-heatmap: listSnapshots failed, falling back to list(): ${String(error)}`);
				}
			}
			if (snapshots === null && typeof persistence.list === "function") snapshots = await persistence.list();
			const metas = snapshots !== null ? snapshots.map((entry) => entry.header) : await persistence.list();
			const revisionOf = new Map();
			if (snapshots !== null) for (const entry of snapshots) revisionOf.set(entry.header.id, entry.revision);
			for (const meta of metas) {
				persistedIds.add(meta.id);
				if (attached.has(meta.id)) continue;
				const state = cache.sessions[meta.id] ?? createUsageState();
				const revision = revisionOf.get(meta.id);
				const previous = state.kind === "persisted" && typeof state.revision === "string" ? state.revision : void 0;
				// A revision-less backend must be read every pass; with revisions,
				// an unchanged log is skipped entirely.
				const changed = state.kind !== "persisted" || revision === void 0 || revision !== state.revision;
				if (changed) {
					try {
						// Only the interposed corpus fingerprint moved: this log's own bytes
						// are untouched, so its folded days are still exact and even the read
						// is skipped. Without this, every pass that follows an append ANYWHERE
						// re-reads every pre-v4 session (measured on a real install: 124
						// sessions, 44 MB of logs per pass, after each restart and refresh).
						if (previous !== void 0 && revision !== void 0 && sameLogFile(previous, revision)) {
							state.revision = revision;
							cache.sessions[meta.id] = state;
							continue;
						}
						const wasPersisted = state.kind === "persisted";
						const prior = state.consumed ?? 0;
						const read = await readSessionEvents(persistence, meta.id, wasPersisted ? prior : 0);
						if (read === null) {
							// No read path on this backend: keep the folded days as they
							// are rather than reporting an empty log as a rewrite.
							ctx.logger.warn(`token-heatmap: sessionPersistence exposes neither readFrom() nor open() on this DSH; stored session "${meta.id}" cannot be read`);
							cache.sessions[meta.id] = state;
							continue;
						}
						// Both read paths hand back events carrying their own `seq`, and
						// every decision below is made on `seq`, never on an index into the
						// slice.
						const events = read.events;
						// Fork-inherited prefix: discovered from the log on the first read
						// (fromSeq 0, so the marker is in view), reused from the cache
						// afterwards.
						const cut = wasPersisted ? (state.skipUntil ?? 0) : forkCutOfEvents(events);
						// This session's OWN events: everything at or after the cut. The
						// prefix before it is the fork parent's, folded when that was folded.
						const owned = events.filter((event) => typeof event.seq === "number" && event.seq >= cut);
						const last = owned.length > 0 ? owned[owned.length - 1].seq : void 0;
						// `consumed` is the seq of the last event already folded, so the next
						// seq this session owes us is `consumed + 1`; a cursor below the cut
						// means the cut was (re)discovered, and the cached days may then hold
						// the inherited prefix.
						const folded = Math.max(prior, cut);
						if (!wasPersisted || prior < cut) {
							// First sight, a live→stored transition, or a (re)discovered cut:
							// fold this session from its cut. `fromSeq` was 0 for a fresh
							// state, so the whole log is in hand either way.
							resetFold(state, cut);
							applyUsageDelta(state, owned);
							state.consumed = last ?? cut;
						} else {
							const tail = owned.filter((event) => event.seq > folded);
							/** Rebuild from the cut by re-reading: a range read gave only a delta. */
							const refoldByRead = async () => {
								const full = await readSessionEvents(persistence, meta.id, cut);
								const all = (full?.events ?? []).filter((event) => typeof event.seq === "number" && event.seq >= cut);
								resetFold(state, cut);
								applyUsageDelta(state, all);
								state.consumed = all.length > 0 ? all[all.length - 1].seq : cut;
							};
							if (tail.length > 0 && tail[0].seq === folded + 1) {
								// Contiguous append: fold only what is new. The filter used to
								// start at `consumed` — one event too early — and the contiguity
								// test then demanded `consumed + 1`, so this branch never ran and
								// every append refolded the whole log.
								applyUsageDelta(state, tail);
								state.consumed = tail[tail.length - 1].seq;
							} else if (!read.whole) {
								// Range read: an empty delta means "nothing new", while a
								// non-empty one that skips seqs means the log dropped events we
								// had already folded — rebuild only then.
								if (tail.length > 0) await refoldByRead();
							} else if (revision !== void 0) {
								// Whole log with a change token: it holds no owned events, got
								// shorter, dropped events in the middle, or was rewritten at the
								// same length — none of which `seq` can rule out, so rebuild the
								// session from its cut rather than trust the cached days.
								resetFold(state, cut);
								applyUsageDelta(state, owned);
								state.consumed = last ?? cut;
							}
							// A whole log from a revision-less backend with nothing new keeps
							// the fold: with no change token at all, `seq` is the only evidence
							// that backend offers, and re-folding it every pass is exactly what
							// this rework removes.
						}
						state.skipUntil = cut;
						state.kind = "persisted";
						if (revision !== void 0) state.revision = revision;
					} catch (error) {
						ctx.logger.warn(`token-heatmap: reading persisted session "${meta.id}" failed: ${String(error)}`);
					}
				}
				cache.sessions[meta.id] = state;
			}
		} else if (persistence !== void 0) {
			// DSH 0.1.2+ (rc.1): sessionPersistence exposes no session
			// enumeration (list/listSnapshots are gone). Previously folded
			// persisted days stay in the cache untouched — they are neither
			// refreshed (no enumeration to walk) nor dropped (they still
			// describe real past days).
			ctx.logger.warn("token-heatmap: sessionPersistence exposes no list()/listSnapshots() enumeration on this DSH; persisted-only history will not refresh");
		}
		for (const id of Object.keys(cache.sessions)) {
			if (!attached.has(id) && !persistedIds.has(id) && canEnumeratePersisted) delete cache.sessions[id];
		}
		const byDay = new Map();
		for (const state of Object.values(cache.sessions)) mergeInto(byDay, state.days);
		// Keep the atomic cache write inside the single-flight section. Otherwise
		// overlapping saves can race on the same temporary file.
		await saveCache(ctx, cache);
		return renderUsage(byDay, Date.now());
	});
}

async function handleUsage(ctx, req, res) {
	if (rejectForeignCaller(req, res)) return;
	try {
		const result = await collectUsage(ctx);
		json(res, 200, { ok: true, ...result });
	} catch (error) {
		ctx.logger.warn(`token-heatmap: usage aggregation failed: ${String(error)}`);
		json(res, 500, { ok: false, error: "internal", message: error instanceof Error ? error.message : String(error) });
	}
}

/**
 * Plugin body: register the usage and config routes and run the two one-time
 * legacy migrations. DSH 0.2.0 needs no namespace registration — the exported
 * `Config` is the form — so nothing here touches the settings document beyond
 * the rescues.
 * @param ctx - plugin context carrying webServer, sessions, sessionPersistence, and settings.
 */
function apply(ctx) {
	// Best-effort, fire-and-forget: import the pre-0.1.2 config document into
	// the config entry and drop the file (see migrateLegacyConfig), then rescue
	// whatever the removed settings.yaml still holds. The rescue waits for the
	// Loader to settle, exactly like DSH's own importer did, so the entry it
	// inspects is the live one.
	migrateLegacyConfig(ctx);
	const loader = ctx.root?.loader;
	const settled = typeof loader?.await === "function" ? Promise.resolve(loader.await()).catch(() => void 0) : Promise.resolve();
	settled.then(() => rescueRemovedSettingsDocument(ctx)).catch(() => void 0);
	// Real-time fold: listen to session/event and fold each usage event into
	// the cache immediately, so live session usage is captured regardless of
	// whether the hero screen is mounted (the client polls the usage endpoint
	// only there) and regardless of what sessionPersistence can enumerate —
	// this is the path that keeps counting on a host whose stored logs are
	// unreachable. The request-time fold in collectUsage stays as a sync point;
	// both share the per-session `consumed` cursor so they never double count.
	if (typeof ctx.on === "function") ctx.effect(() => {
		let saveTimer = null;
		let disposed = false;
		const disposer = ctx.on("session/event", (session, event) => {
			loadCache().then((cache) => {
				if (disposed) return;
				const state = cache.sessions[session.id] ?? createUsageState();
				const cut = forkCutOf(session);
				if ((state.skipUntil ?? 0) !== cut) state.skipUntil = cut;
				const seq = typeof event.seq === "number" ? event.seq : void 0;
				// Constructor seeds (a fork's inherited prefix, or a resume's own
				// stored log) are never published here, so a live event at or after
				// the cut is the only thing this feed carries; the guard keeps a
				// stray replay of the parent's prefix from re-counting it.
				if (seq !== void 0 && seq < liveFoldFrom(state.consumed ?? 0, cut)) return;
				applyUsageDelta(state, [event]);
				if (seq !== void 0) state.consumed = Math.max(state.consumed ?? 0, seq + 1);
				state.kind = "live";
				cache.sessions[session.id] = state;
				if (saveTimer === null) {
					saveTimer = setTimeout(() => {
						saveTimer = null;
						saveCache(ctx, cache).catch(() => {});
					}, 2000);
				}
			}).catch(() => {});
		});
		return () => {
			disposed = true;
			if (saveTimer !== null) clearTimeout(saveTimer);
			if (typeof disposer === "function") disposer();
		};
	}, "token-heatmap: session/event fold");
	// Initial fold of live sessions that existed before this plugin loaded
	// (e.g. resumed sessions): fold their in-memory tail from the last cursor
	// so the heatmap has history before the first session/event arrives.
	ctx.effect(() => {
		let disposed = false;
		loadCache().then(async (cache) => {
			if (disposed) return;
			const sessions = typeof ctx.get === "function" ? ctx.get("sessions") : void 0;
			if (sessions === void 0) return;
			for (const session of sessions.list()) {
				if (disposed) return;
				const state = cache.sessions[session.id] ?? createUsageState();
				const cut = forkCutOf(session);
				if (state.kind !== "live" || (state.skipUntil ?? 0) !== cut) resetFold(state, cut);
				const from = liveFoldFrom(state.consumed ?? 0, cut);
				const { count, events } = liveSessionEvents(session, from);
				if (from < count) {
					applyUsageDelta(state, events);
					state.consumed = count;
				}
				state.kind = "live";
				cache.sessions[session.id] = state;
			}
			if (!disposed) await saveCache(ctx, cache);
		}).catch(() => {});
		return () => { disposed = true; };
	}, "token-heatmap: initial live fold");
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: USAGE_PATH,
		handler: (req, res) => handleUsage(ctx, req, res)
	}), "token-heatmap: usage route");
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: CONFIG_PATH,
		handler: (req, res) => handleConfig(ctx, req, res)
	}), "token-heatmap: config route");
}

export {
	apply,
	inject,
	name,
	Config,
	CONFIG_PATH,
	USAGE_PATH,
	SETTINGS_NAMESPACE,
	TokenHeatmapSettingsSchema,
	migrateLegacyConfig,
	entryConfig,
	dshHomeDirectory,
	legacySettingFromDocument,
	rescueRemovedSettingsDocument
};
