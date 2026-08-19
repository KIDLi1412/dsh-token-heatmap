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
 * Display settings (enabled + colorScheme) are owned by the plugin's
 * `token-heatmap` settings namespace — the config card in
 * 设置 → 插件 → 插件配置 reads/writes it through the settings scope, and the
 * legacy `<DSH_HOME>/storages/token-heatmap-config.json` document is
 * migrated into the namespace once at startup.
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
import { join, dirname } from "node:path";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { applyUsageDelta, createUsageState, mergeInto, renderUsage, zeroBuckets } from "./usage.js";
import { DEFAULT_CONFIG, parseConfig } from "./config.js";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import z from "@deepseek-ai/schemastery";

/** Stable Cordis plugin name. */
const name = "token-heatmap";

/** Services required before this plugin activates. */
const inject = ["webServer", "sessions", "sessionPersistence", "settings"];

//#region settings namespace
/**
 * Settings namespace owned by this plugin. Registering it makes the Host
 * serve a `token-heatmap` section (resolved from schema defaults, then any
 * composition `base`, then the user settings.yaml layer), which is exactly
 * what the official 设置 → 插件 → 插件配置 tab dispatches on: it renders the
 * card registered into `settings.plugin.item` whose `key` matches a served
 * namespace. The card edits `enabled` + `colorScheme` through the settings
 * scope; the legacy `<DSH_HOME>/storages/token-heatmap-config.json` document
 * is migrated once at startup (see migrateLegacyConfig).
 */
const SETTINGS_NAMESPACE = settingsNamespace("token-heatmap");

/**
 * Durable display preferences; also the wire envelope the browser scope
 * validates against. Scheme membership is deliberately NOT enforced (a newer
 * client may know a palette the server does not — the client falls back to
 * green); only the same shape bounds parseConfig applies: a short, non-blank
 * string.
 */
const TokenHeatmapSettingsSchema = z.object({
	enabled: z.boolean().default(true),
	colorScheme: z.string().min(1).max(32).default("green")
});
//#endregion

const USAGE_PATH = "/api/token-heatmap/usage";
const CONFIG_PATH = "/api/token-heatmap/config";
const CACHE_VERSION = 1;

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
		const tmp = `${path}.tmp`;
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

/**
 * One-time migration from the legacy config document
 * (`<DSH_HOME>/storages/token-heatmap-config.json`) into the registered
 * settings namespace. Runs once per process, best-effort: when the user has
 * no settings.yaml section yet, non-default values are imported through the
 * settings write path; the legacy file is removed either way (the namespace
 * becomes the single source of truth). A corrupt legacy document is dropped,
 * never imported. Failures are logged and never fatal.
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
		const descriptor = ctx.settings.describe().find((entry) => entry.ns === SETTINGS_NAMESPACE);
		const userExists = descriptor !== void 0 && descriptor.user !== void 0;
		if (!userExists) {
			const patch = {};
			if (legacy.enabled !== DEFAULT_CONFIG.enabled) patch.enabled = legacy.enabled;
			if (legacy.colorScheme !== DEFAULT_CONFIG.colorScheme) patch.colorScheme = legacy.colorScheme;
			if (Object.keys(patch).length > 0) await ctx.settings.update(SETTINGS_NAMESPACE, patch);
		}
		await rm(path, { force: true });
	} catch (error) {
		ctx.logger.warn(`token-heatmap: migrating legacy config failed: ${String(error)}`);
	}
}

/** Serve the resolved settings section (schema defaults + user layer). */
function serveConfig(ctx) {
	const section = ctx.settings.get(SETTINGS_NAMESPACE);
	return { enabled: section?.enabled !== false, colorScheme: typeof section?.colorScheme === "string" && section.colorScheme.length > 0 ? section.colorScheme : DEFAULT_CONFIG.colorScheme };
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
 * Collect per-day usage across live and persisted sessions, incrementally.
 *
 * Live sessions: fold only the in-memory events added since the last fold.
 * Persisted sessions: skipped when the backend's opaque revision is
 * unchanged (`sessionPersistence.listSnapshots`, falling back to always
 * reading the delta); when the revision changes, the new events are verified
 * to be contiguous with the last folded seq — a gap or an empty delta means
 * the log was truncated/rewritten, so the session is refolded from scratch.
 * Sessions that vanished are dropped, and a session switching between
 * live/persisted is refolded from scratch to stay exact.
 */
export async function collectUsage(ctx) {
	return withLock(async () => {
		const cache = await loadCache();
		const live = ctx.get("sessions");
		const attached = new Set();
		if (live !== void 0) {
			for (const session of live.list()) {
				attached.add(session.id);
				const state = cache.sessions[session.id] ?? createUsageState();
				if (state.kind !== "live") {
					// Live/persisted transition: refold the whole in-memory log.
					state.days = new Map();
					state.lastSample = null;
					state.currentModel = null;
					state.consumed = 0;
				}
				const count = session.events.length;
				if ((state.consumed ?? 0) < count) {
					applyUsageDelta(state, session.events.slice(state.consumed ?? 0));
					state.consumed = count;
				}
				state.kind = "live";
				cache.sessions[session.id] = state;
			}
		}
		const persistence = ctx.get("sessionPersistence");
		const persistedIds = new Set();
		if (persistence !== void 0) {
			// Prefer the backend's opaque per-log revisions (no file I/O in the
			// plugin, works for any backend that exposes listSnapshots).
			let snapshots = null;
			if (typeof persistence.listSnapshots === "function") {
				try {
					snapshots = await persistence.listSnapshots();
				} catch (error) {
					ctx.logger.warn(`token-heatmap: listSnapshots failed, falling back to list(): ${String(error)}`);
				}
			}
			const metas = snapshots !== null ? snapshots.map((entry) => entry.header) : await persistence.list();
			const revisionOf = new Map();
			if (snapshots !== null) for (const entry of snapshots) revisionOf.set(entry.header.id, entry.revision);
			for (const meta of metas) {
				persistedIds.add(meta.id);
				if (attached.has(meta.id)) continue;
				const state = cache.sessions[meta.id] ?? createUsageState();
				const revision = revisionOf.get(meta.id);
				const changed = state.kind !== "persisted" || (revision !== void 0 && revision !== state.revision) || revision === void 0;
				if (changed) {
					try {
						const wasPersisted = state.kind === "persisted";
						const fromSeq = wasPersisted ? state.consumed : 0;
						const { events } = await persistence.readFrom(meta.id, fromSeq);
						if (!wasPersisted) {
							state.days = new Map();
							state.lastSample = null;
							state.currentModel = null;
							state.consumed = 0;
						}
						const fresh = wasPersisted ? events.filter((event) => event.seq > (state.consumed ?? 0)) : events;
						const contiguous = fresh.length === 0 ? state.consumed === 0 : fresh[0].seq === state.consumed + 1;
						if (!contiguous && state.consumed > 0) {
							// Log truncated or rewritten: refold the whole log.
							state.days = new Map();
							state.lastSample = null;
							state.currentModel = null;
							state.consumed = 0;
							const { events: allEvents } = await persistence.readFrom(meta.id, 0);
							applyUsageDelta(state, allEvents);
							state.consumed = allEvents.length > 0 ? allEvents[allEvents.length - 1].seq : 0;
						} else if (fresh.length > 0) {
							applyUsageDelta(state, fresh);
							state.consumed = fresh[fresh.length - 1].seq;
						}
						state.kind = "persisted";
						if (revision !== void 0) state.revision = revision;
					} catch (error) {
						ctx.logger.warn(`token-heatmap: reading persisted session "${meta.id}" failed: ${String(error)}`);
					}
				}
				cache.sessions[meta.id] = state;
			}
		}
		for (const id of Object.keys(cache.sessions)) {
			if (!attached.has(id) && !persistedIds.has(id)) delete cache.sessions[id];
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
 * Plugin body: register the usage and config routes, the settings namespace
 * that backs the plugin configuration card (设置 → 插件 → 插件配置), and the
 * one-time legacy-config migration.
 * @param ctx - plugin context carrying webServer, sessions, sessionPersistence, and settings.
 */
function apply(ctx) {
	// The registration is fiber-bound: disposing this plugin removes the
	// namespace and its observers. `settings` is a hard dependency (inject),
	// so ctx.settings is available here unconditionally.
	ctx.settings.register(SETTINGS_NAMESPACE, TokenHeatmapSettingsSchema);
	// Best-effort, fire-and-forget: import the pre-0.1.2 config document into
	// the namespace and drop the file (see migrateLegacyConfig).
	migrateLegacyConfig(ctx);
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

export { apply, inject, name, CONFIG_PATH, USAGE_PATH, SETTINGS_NAMESPACE, TokenHeatmapSettingsSchema, migrateLegacyConfig };
