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
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { applyUsageDelta, createUsageState, mergeInto, renderLedger, renderUsage, zeroBuckets } from "./usage.js";
import { DEFAULT_CONFIG, parseConfig } from "./config.js";
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
 * DSH 0.1.2 起 `@deepseek-ai/dsh-settings` 不再导出 settingsNamespace 帮助函数：
 * namespace 直接以字面量传入（register/get/update 内部仍按
 * /^[a-z][a-z0-9-]*$/ 校验）。
 */
const SETTINGS_NAMESPACE = "token-heatmap";

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

//#region usage ledger (optional @linxin666/dsh-usage enhancement)
/**
 * Optional usage ledger written by the third-party @linxin666/dsh-usage
 * plugin (`<DSH_HOME>/dsh-usage/usage-ledger.json`) — the per-day/per-provider/
 * per-model aggregate its 设置 → 使用统计 card reads. When present it is complete
 * and real-time, so collectUsage serves it directly as an enhancement over the
 * session/event fold. It is NOT a DSH contract: the file, its shape, and its
 * version are owned by that plugin, so loadLedger only checks the `days`
 * shape (not version) and warns on mismatch. The session/event listener keeps
 * the cache fresh regardless, so a missing or changed ledger degrades
 * gracefully to the session-event fold.
 */
function ledgerPath() {
	const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
	return join(home, "dsh-usage", "usage-ledger.json");
}

/**
 * Read the optional @linxin666/dsh-usage ledger. Returns the parsed document
 * when present with a recognizable `days` shape, or null when absent/corrupt
 * (callers fall back to the session-event fold). Only the `days` shape is
 * checked — not `version` — because the ledger is a third-party plugin's
 * internal file, not a published contract; a shape mismatch logs a warning so
 * the fallback is observable instead of silent.
 */
let ledgerMtime = -1;
let ledgerCached = null;
async function loadLedger(ctx) {
	try {
		const path = ledgerPath();
		const st = await stat(path);
		if (st.mtimeMs === ledgerMtime && ledgerCached !== null) {
			return ledgerCached;
		}
		const raw = await readFile(path, "utf8");
		const parsed = JSON.parse(raw);
		if (parsed !== null && typeof parsed === "object" && parsed.days !== null && typeof parsed.days === "object") {
			ledgerMtime = st.mtimeMs;
			ledgerCached = parsed;
			return parsed;
		}
		ledgerMtime = -1;
		ledgerCached = null;
		ctx?.logger?.warn("token-heatmap: usage ledger present but shape unrecognized; falling back to session-event fold");
	} catch {
		/* ledger absent — fall back to the session-event fold */
	}
	return null;
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
 * Length of a live session's fork-inherited prefix — the number of leading
 * events copied from its parent at fork time. Those events are the PARENT's
 * usage and are folded when the parent is folded, so a seeded child must skip
 * them or the same tokens are counted twice.
 *
 * `header.isSeeded` marks fork lineage; `inheritedEventCount` is the exact cut
 * (both are official Session state on 0.1.2+, and `isSeeded` alone is not
 * enough — a resumed session has a constructor seed but is NOT a fork, and its
 * seed is its own history, which must be folded).
 * @returns the inherited prefix length, or 0 for an unseeded/unknown session.
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
 * event carrying `{ inherited: true }` (an unmarked `session/end-seed` is a
 * compaction boundary, not a fork cut), so that event's seq + 1 is the cut.
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
 * On DSH 0.1.2+ (rc.1) sessionPersistence no longer exposes a session
 * enumeration (list/listSnapshots are gone), so persisted-only history is
 * kept in the cache untouched instead of being refreshed or dropped.
 * FORKED sessions (header.isSeeded) inherit their parent's event prefix; that
 * prefix is folded once under the parent, so folds start at the fork cut
 * (`skipUntil`) instead of seq 0 or the child double counts the parent's tokens.
 */
export async function collectUsage(ctx) {
	return withLock(async () => {
		// Optional enhancement: when the @linxin666/dsh-usage plugin's ledger
		// (<DSH_HOME>/dsh-usage/usage-ledger.json) is present, serve it directly
		// — it is complete and real-time. The ledger is a third-party plugin's
		// internal file (not a DSH contract), so loadLedger only checks the
		// days shape and warns on mismatch; absence is the normal path. The
		// session/event listener (see apply) keeps the cache fresh regardless,
		// so if the ledger later disappears this fallback serves a recent fold.
		const ledger = await loadLedger(ctx);
		if (ledger !== null) {
			return renderLedger(ledger, Date.now());
		}
		// Primary: incremental session-event fold. On rc.1 the session/event
		// listener folds live sessions in real time regardless of hero-screen
		// mounting; this request-time fold is a sync point that catches
		// anything the listener has not yet reached. Both share the per-session
		// `consumed` cursor, so they never double count.
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
					// refold from the cut. The inherited prefix belongs to the fork
					// parent and is folded there, so starting at the cut avoids
					// counting the parent's tokens a second time.
					state.days = new Map();
					state.lastSample = null;
					state.currentModel = null;
					state.consumed = 0;
					state.skipUntil = cut;
				}
				const from = Math.max(state.consumed ?? 0, cut);
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
						// Fork-inherited prefix: discover it from the log the first
						// time, else reuse the cut already recorded in the cache.
						const fromSeq = wasPersisted ? state.consumed : 0;
						const { events } = await persistence.readFrom(meta.id, fromSeq);
						const cut = wasPersisted ? (state.skipUntil ?? 0) : forkCutOfEvents(events);
						const start = Math.max(fromSeq, cut);
						const needsRefold = !wasPersisted || start !== fromSeq;
						if (needsRefold) {
							state.days = new Map();
							state.lastSample = null;
							state.currentModel = null;
							state.consumed = 0;
						}
						const fresh = events.filter((event) => typeof event.seq === "number" && event.seq >= Math.max(state.consumed ?? 0, cut));
						const contiguous = fresh.length === 0 ? (state.consumed ?? 0) <= cut : fresh[0].seq === (state.consumed ?? 0) + 1 || fresh[0].seq === cut;
						if (!contiguous && (state.consumed ?? 0) > cut) {
							// Log truncated or rewritten: refold the whole log from the cut.
							state.days = new Map();
							state.lastSample = null;
							state.currentModel = null;
							state.consumed = 0;
							const { events: allEvents } = await persistence.readFrom(meta.id, cut);
							const owned = allEvents.filter((event) => typeof event.seq === "number" && event.seq >= cut);
							applyUsageDelta(state, owned);
							state.consumed = owned.length > 0 ? owned[owned.length - 1].seq : cut;
						} else if (fresh.length > 0) {
							applyUsageDelta(state, fresh);
							state.consumed = fresh[fresh.length - 1].seq;
						} else {
							state.consumed = Math.max(state.consumed ?? 0, cut);
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
	// Real-time fold: listen to session/event and fold each usage event into
	// the cache immediately, so live session usage is captured regardless of
	// whether the hero screen is mounted (the client polls the usage endpoint
	// only there). This mirrors the session/event → ledger approach used by
	// @linxin666/dsh-usage and sidesteps the rc.1 limitation where
	// sessionPersistence no longer enumerates persisted sessions. The
	// request-time fold in collectUsage stays as a sync point; both share the
	// per-session `consumed` cursor so they never double count.
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
				// stray replay event from re-counting the parent's tokens.
				if (seq !== void 0 && seq < Math.max(state.consumed ?? 0, cut)) return;
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
				if (state.kind !== "live" || (state.skipUntil ?? 0) !== cut) {
					state.days = new Map();
					state.lastSample = null;
					state.currentModel = null;
					state.consumed = 0;
					state.skipUntil = cut;
				}
				const from = Math.max(state.consumed ?? 0, cut);
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

export { apply, inject, name, CONFIG_PATH, USAGE_PATH, SETTINGS_NAMESPACE, TokenHeatmapSettingsSchema, migrateLegacyConfig };
