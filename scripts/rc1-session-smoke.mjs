/**
 * Regression for DSH 0.1.2+ (rc.1): live sessions no longer expose an
 * `.events` array — the event count is `session.seq` and each event is read
 * via `session.eventAt(seq)` (0-based, the reads @deepseek-ai/dsh-token-meter
 * uses). collectUsage must fold such sessions — and survive a
 * sessionPersistence that exposes no list()/listSnapshots() enumeration —
 * instead of throwing "Cannot read properties of undefined (reading
 * 'length')" on `session.events.length`.
 *
 * Runs against a throwaway DSH_HOME so the real cache file is untouched.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectUsage, apply } from "../lib/index.js";

function localDay(ms) {
	const d = new Date(ms);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const now = Date.now();
const events = [
	{ seq: 1, time: now, type: "request/header", data: { header: { config: { provider: "deepseek-official", model: "deepseek-v4-flash" } } } },
	{ seq: 2, time: now, type: "assistant/message", data: { turn: 0, step: 0, message: { source: { provider: "deepseek-official", model: "deepseek-v4-flash" } }, usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200 } } },
	{ seq: 3, time: now, type: "request/header", data: { header: { config: { provider: "deepseek-official", model: "deepseek-v4-flash" } } } },
	{ seq: 4, time: now, type: "assistant/message", data: { turn: 1, step: 0, message: { source: { provider: "deepseek-official", model: "deepseek-v4-flash" } }, usage: { inputTokens: 300, outputTokens: 100 } } }
];

const makeCtx = (sessions) => ({
	get: (name) => (name === "sessions" ? sessions : void 0),
	logger: { warn() {} }
});

const tmpHome = mkdtempSync(join(tmpdir(), "thm-rc1-"));
process.env.DSH_HOME = tmpHome;

const failures = [];
const check = (name, ok, detail = "") => {
	console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures.push(name);
};

try {
	// rc.1 session shape: seq + eventAt, no .events array; persistence absent
	// on this context (the enumeration/read shapes are covered below).
	const rc1Session = { id: "rc1-s1", seq: events.length, eventAt: (n) => events[n] };
	const rc1Ctx = makeCtx({ list: () => [rc1Session] });

	const first = await collectUsage(rc1Ctx);
	const day = localDay(now);
	const dayEntry = first.days.find((entry) => entry.date === day);
	check("rc.1 session folded without throwing", first.total === 2100, `total=${first.total}`);
	check("rc.1 day total", dayEntry !== void 0 && dayEntry.tokens === 2100, JSON.stringify(dayEntry));
	check("model attribution", dayEntry?.models?.[0]?.model === "deepseek-official/deepseek-v4-flash");

	// Incremental: a second pass over the same session must not double count.
	const second = await collectUsage(rc1Ctx);
	check("incremental fold does not double count", second.total === 2100, `total=${second.total}`);

	// Legacy session shape (.events array) still folds identically. The cache
	// is shared across calls (collectUsage aggregates every known session), so
	// the legacy session ADDS its own 2100 on top of the rc.1 session.
	const legacySession = { id: "legacy-s1", events };
	const legacy = await collectUsage(makeCtx({ list: () => [legacySession] }));
	check("legacy .events shape still folds", legacy.total === 4200, `total=${legacy.total}`);

	// A sessionPersistence WITHOUT enumeration must not break the call either,
	// and the unenumerable persisted sessions stay in the cache (not dropped).
	const rc1WithPersistence = {
		get: (name) => name === "sessions" ? { list: () => [rc1Session] }
			: name === "sessionPersistence" ? { readFrom: async () => ({ events: [] }) } : void 0,
		logger: { warn() {} }
	};
	const persistedOk = await collectUsage(rc1WithPersistence);
	check("persistence without enumeration is tolerated", persistedOk.total === 4200, `total=${persistedOk.total}`);

	/**
	 * The 0.1.3+ stored-session shape: `sessionPersistence.list()` enumerates
	 * sessions and `open(id, "read")` + `handle.read()` returns the whole log —
	 * `listSnapshots`/`readFrom` are gone. collectUsage must fold those stored
	 * sessions, must use the snapshot revision to skip an unchanged log, and
	 * must fold only the newly appended events when the revision moves.
	 */
	async function persistedSmokeChecks() {
		const home = mkdtempSync(join(tmpdir(), "thm-persisted-"));
		process.env.DSH_HOME = home;
		try {
			const day = localDay(now);
			const storedEvents = [
				{ seq: 0, time: now, type: "request/header", data: { header: { config: { provider: "buddy", model: "deepseek-v4.1-flash" } } } },
				{ seq: 1, time: now, type: "assistant/message", data: { turn: 0, step: 0, message: { source: { provider: "buddy", model: "deepseek-v4.1-flash" } }, usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200 } } }
			];
			let log = storedEvents;
			let revision = "rev-1";
			const logged = [];
			const persistence = {
				list: async () => [{ header: { id: "stored-s1" }, revision }],
				open: async (id, access) => {
					logged.push(`${id}:${access}`);
					return {
						read: async () => ({ events: log }),
						close: async () => {}
					};
				}
			};
			const storedCtx = {
				get: (service) => (service === "sessionPersistence" ? persistence : void 0),
				logger: { warn() {} }
			};

			const firstRead = await collectUsage(storedCtx);
			const firstDay = firstRead.days.find((entry) => entry.date === day);
			check("list()+open() stored session folded", firstRead.total === 1700, `total=${firstRead.total}`);
			check("stored session model attribution", firstDay !== void 0 && firstDay.models[0].model === "buddy/deepseek-v4.1-flash", JSON.stringify(firstDay));
			check("open() called with read access", logged.length === 1 && logged[0] === "stored-s1:read", logged.join(","));

			// Same revision → the log is not re-read at all.
			await collectUsage(storedCtx);
			check("unchanged revision skips the log read", logged.length === 1, `reads=${logged.length}`);

			// Revision moved with one appended event → fold the delta only.
			log = [...storedEvents, { seq: 2, time: now, type: "assistant/message", data: { turn: 1, step: 0, message: { source: { provider: "buddy", model: "deepseek-v4.1-flash" } }, usage: { inputTokens: 10, outputTokens: 5 } } }];
			revision = "rev-2";
			const grown = await collectUsage(storedCtx);
			check("new revision folds only the appended event", grown.total === 1715, `total=${grown.total}`);

			// A shorter log (truncated/rewritten) refolds from scratch.
			log = [{ seq: 0, time: now, type: "assistant/message", data: { turn: 0, step: 0, message: { source: { provider: "buddy", model: "deepseek-v4.1-flash" } }, usage: { inputTokens: 7, outputTokens: 3 } } }];
			revision = "rev-3";
			const rewritten = await collectUsage(storedCtx);
			check("rewritten log refolds from scratch", rewritten.total === 10, `total=${rewritten.total}`);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	}

	await persistedSmokeChecks();

	// ---- session/event real-time fold ---------------------------------
	// apply() registers a session/event listener that folds each event into
	// the cache in real time, so live session usage is captured regardless of
	// hero-screen mounting — the rc.1 primary path that needs no third-party
	// plugin and no sessionPersistence enumeration.
	const seHome = mkdtempSync(join(tmpdir(), "thm-se-"));
	process.env.DSH_HOME = seHome;
	const seListeners = [];
	apply({
		logger: { warn() {} },
		effect: (fn) => fn(),
		on: (name, handler) => { seListeners.push({ name, handler }); return () => {}; },
		get: (n) => (n === "sessions" ? { list: () => [] } : void 0),
		webServer: { register() {} },
		settings: { register() {} },
	});
	const seListener = seListeners.find((e) => e.name === "session/event");
	check("session/event listener registered", seListener !== void 0);
	const seTime = Date.UTC(2026, 0, 20, 10, 0, 0);
	seListener.handler({ id: "se-s1" }, { seq: 0, time: seTime, type: "assistant/message", data: { turn: 0, step: 0, message: { source: { provider: "buddy", model: "deepseek-v4.1-flash" } }, usage: { inputTokens: 500, outputTokens: 200, cacheReadTokens: 100 } } });
	await new Promise((r) => setTimeout(r, 50));
	const seResult = await collectUsage({ get: () => void 0, logger: { warn() {} } });
	const seDay = seResult.days.find((d) => d.date === "2026-01-20");
	check("session/event folded into cache", seDay !== void 0 && seDay.tokens === 800, JSON.stringify(seDay));
	check("session/event model attribution", seDay?.models?.[0]?.model === "buddy/deepseek-v4.1-flash");
	rmSync(seHome, { recursive: true, force: true });
} finally {
	rmSync(tmpHome, { recursive: true, force: true });
	delete process.env.DSH_HOME;
}

console.log(failures.length === 0 ? "\nrc.1 session shape smoke passed" : `\n${failures.length} CHECK(S) FAILED`);
process.exit(failures.length === 0 ? 0 : 1);
