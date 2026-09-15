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

	// ---- forked sessions fold from their fork cut ----------------------
	// A forked session (header.isSeeded) opens with a copy of its PARENT's
	// events; `inheritedEventCount` is the exact cut. That prefix is folded
	// when the parent is folded, so a child folding from seq 0 counts the same
	// tokens twice (measured 2026-09-14: 13.15e8 instead of 8.34e8).
	const forkHome = mkdtempSync(join(tmpdir(), "thm-fork-"));
	process.env.DSH_HOME = forkHome;
	const fTime = Date.UTC(2026, 1, 3, 10, 0, 0);
	const fModel = { provider: "buddy", model: "deepseek-v4.1-flash" };
	const usageEvent = (seq, turn, inputTokens) => ({
		seq, time: fTime, type: "assistant/message",
		data: { turn, step: 0, message: { source: fModel }, usage: { inputTokens } }
	});
	// Parent: two own usage samples (1500 total).
	const parentEvents = [
		{ seq: 0, time: fTime, type: "request/header", data: { header: { config: fModel } } },
		usageEvent(1, 0, 1000),
		usageEvent(2, 1, 500)
	];
	const parent = { id: "fork-parent", seq: parentEvents.length, eventAt: (n) => parentEvents[n] };
	// Child: inherits the parent's prefix (seq 0..1), marks the cut at seq 2,
	// then adds ONE own sample (700) — only that sample may be folded.
	const childEvents = [
		parentEvents[0],
		parentEvents[1],
		{ seq: 2, time: fTime, type: "session/end-seed", data: { inherited: true } },
		usageEvent(3, 2, 700)
	];
	const child = {
		id: "fork-child",
		header: { isSeeded: true },
		inheritedEventCount: 2,
		seq: childEvents.length,
		eventAt: (n) => childEvents[n]
	};
	const forkCtx = makeCtx({ list: () => [parent, child] });
	const forkResult = await collectUsage(forkCtx);
	const forkDay = forkResult.days.find((d) => d.date === "2026-02-03");
	// parent own 1500 + child own 700; a fold from seq 0 reports 3700 here.
	check("fork child does not re-fold the inherited prefix", forkDay !== void 0 && forkDay.tokens === 2200, JSON.stringify(forkDay));
	check("fork child keeps model attribution", forkDay?.models?.[0]?.model === "buddy/deepseek-v4.1-flash");
	// A second pass must not add the prefix back on top of the folded days.
	const forkAgain = await collectUsage(forkCtx);
	const forkDayAgain = forkAgain.days.find((d) => d.date === "2026-02-03");
	check("fork child stays stable across passes", forkDayAgain !== void 0 && forkDayAgain.tokens === 2200, JSON.stringify(forkDayAgain));

	// A RESUMED session is NOT a fork: its constructor seed is its own stored
	// history, so the whole log folds (isSeeded false → no cut). The unmarked
	// `session/end-seed` here is a compaction boundary and must not be read as
	// a fork cut.
	const resumedEvents = [
		{ seq: 0, time: fTime, type: "request/header", data: { header: { config: fModel } } },
		{ seq: 1, time: fTime, type: "session/end-seed", data: {} },
		usageEvent(2, 0, 400)
	];
	const resumed = { id: "resumed-s1", header: { isSeeded: false }, seq: resumedEvents.length, eventAt: (n) => resumedEvents[n] };
	const resumedResult = await collectUsage(makeCtx({ list: () => [resumed] }));
	const resumedDay = resumedResult.days.find((d) => d.date === "2026-02-03");
	// 2200 (fork) + this session's own 400; a bogus cut would drop it to 2200.
	check("resumed session folds its whole own log", resumedDay !== void 0 && resumedDay.tokens === 2600, JSON.stringify(resumedDay));
	rmSync(forkHome, { recursive: true, force: true });

	// ---- a STORED fork is cut from its end-seed marker ------------------
	// The persisted path has no `inheritedEventCount`: DSH projects the cut
	// into the log as the last `session/end-seed` carrying `{ inherited: true }`
	// (dsh-session-format-v2-to-v3 derives the restored cut the same way).
	// One shared DSH_HOME (the cache singleton is per process), one DAY per log
	// so each expectation stays exact.
	const storedForkHome = mkdtempSync(join(tmpdir(), "thm-fork-stored-"));
	process.env.DSH_HOME = storedForkHome;
	const sfModel = { provider: "buddy", model: "deepseek-v4.1-flash" };
	/** Fold one stored log; returns the day it uses, with no other writer. */
	async function storedForkDay(id, day, log) {
		const persistence = {
			list: async () => [{ header: { id }, revision: "rev-1" }],
			open: async () => ({ read: async () => ({ events: log }), close: async () => {} })
		};
		const result = await collectUsage({ get: (s) => (s === "sessionPersistence" ? persistence : void 0), logger: { warn() {} } });
		return result.days.find((d) => d.date === day);
	}
	const at = (day) => Date.parse(`${day}T10:00:00Z`);
	const sfUsage = (seq, turn, time, inputTokens) => ({
		seq, time, type: "assistant/message",
		data: { turn, step: 0, message: { source: sfModel }, usage: { inputTokens } }
	});

	// Inherited prefix (1000) marked at seq 2, then the child's own 700.
	const seededTime = at("2026-02-17");
	const seededDay = await storedForkDay("stored-fork-s1", "2026-02-17", [
		{ seq: 0, time: seededTime, type: "request/header", data: { header: { config: sfModel } } },
		sfUsage(1, 0, seededTime, 1000),
		{ seq: 2, time: seededTime, type: "session/end-seed", data: { inherited: true } },
		sfUsage(3, 1, seededTime, 700)
	]);
	// Folded from the cut: 700. From seq 0 it would be 1700.
	check("stored fork folds from its inherited end-seed cut", seededDay !== void 0 && seededDay.tokens === 700, JSON.stringify(seededDay));

	// Inherited prefix (1000), an UNMARKED compaction boundary, the LAST
	// marked cut at seq 3, then the child's own 500.
	const mixedTime = at("2026-02-18");
	const mixedDay = await storedForkDay("stored-mixed-s1", "2026-02-18", [
		{ seq: 0, time: mixedTime, type: "request/header", data: { header: { config: sfModel } } },
		sfUsage(1, 0, mixedTime, 1000),
		{ seq: 2, time: mixedTime, type: "session/end-seed", data: {} },
		{ seq: 3, time: mixedTime, type: "session/end-seed", data: { inherited: true } },
		sfUsage(4, 1, mixedTime, 500)
	]);
	// 500: the unmarked boundary must not cut (that gives 0 here) and the
	// prefix before the marked cut must not fold (that would make it 1500).
	check("unmarked end-seed is not a fork cut", mixedDay !== void 0 && mixedDay.tokens === 500, JSON.stringify(mixedDay));

	// An unseeded log folds in full even though it carries an end-seed marker.
	const plainTime = at("2026-02-19");
	const plainDay = await storedForkDay("stored-plain-s1", "2026-02-19", [
		sfUsage(0, 0, plainTime, 1000),
		{ seq: 1, time: plainTime, type: "session/end-seed", data: {} },
		sfUsage(2, 1, plainTime, 500)
	]);
	check("unseeded stored log folds in full", plainDay !== void 0 && plainDay.tokens === 1500, JSON.stringify(plainDay));
	rmSync(storedForkHome, { recursive: true, force: true });
} finally {
	rmSync(tmpHome, { recursive: true, force: true });
	delete process.env.DSH_HOME;
}

console.log(failures.length === 0 ? "\nrc.1 session shape smoke passed" : `\n${failures.length} CHECK(S) FAILED`);
process.exit(failures.length === 0 ? 0 : 1);
