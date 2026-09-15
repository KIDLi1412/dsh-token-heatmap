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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
	// (rc.1 exposes no list/listSnapshots enumeration).
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

	// ---- ledger optional enhancement -----------------------------------
	// When the @linxin666/dsh-usage ledger exists, collectUsage serves it as
	// an optional enhancement (complete + real-time) over the session/event
	// fold, recovering full history even when persisted sessions cannot be
	// enumerated (rc.1). The file only exists when that plugin is installed.
	const ledgerHome = mkdtempSync(join(tmpdir(), "thm-ledger-"));
	process.env.DSH_HOME = ledgerHome;
	mkdirSync(join(ledgerHome, "dsh-usage"), { recursive: true });
	writeFileSync(
		join(ledgerHome, "dsh-usage", "usage-ledger.json"),
		JSON.stringify({
			version: 1,
			days: {
				"2026-01-15": {
					"buddy": {
						"deepseek-v4.1-flash": { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200, cacheWriteTokens: 0, reasoningTokens: 0, calls: 1, cost: 0 }
					}
				}
			}
		}),
		"utf8"
	);
	const ledgerResult = await collectUsage({ get: () => void 0, logger: { warn() {} } });
	const ledgerDay = ledgerResult.days.find((entry) => entry.date === "2026-01-15");
	check("ledger optional enhancement served", ledgerResult.total === 1700, `total=${ledgerResult.total}`);
	check("ledger day total", ledgerDay !== void 0 && ledgerDay.tokens === 1700, JSON.stringify(ledgerDay));
	check("ledger model attribution", ledgerDay?.models?.[0]?.model === "buddy/deepseek-v4.1-flash");
	// Without a ledger, collectUsage falls back to the session-event fold and
	// does not serve the (now-deleted) ledger data.
	rmSync(join(ledgerHome, "dsh-usage", "usage-ledger.json"), { force: true });
	const fallbackResult = await collectUsage({ get: () => void 0, logger: { warn() {} } });
	const fallbackHasLedgerDay = fallbackResult.days.some((entry) => entry.date === "2026-01-15");
	check("no ledger → fallback does not serve ledger data", !fallbackHasLedgerDay, `days=${fallbackResult.days.map((d) => d.date).join(",")}`);
	rmSync(ledgerHome, { recursive: true, force: true });

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

	// ---- fork sessions must not double count ---------------------------
	// A forked session (header.isSeeded) inherits its parent's event prefix.
	// Those events are the PARENT's usage and are folded when the parent is
	// folded, so the child must start at inheritedEventCount or the parent's
	// tokens are counted twice (the 2026-09-14 1.3B-vs-0.83B regression).
	const forkHome = mkdtempSync(join(tmpdir(), "thm-fork-"));
	process.env.DSH_HOME = forkHome;
	const fTime = Date.UTC(2026, 1, 3, 10, 0, 0);
	const model = { provider: "buddy", model: "deepseek-v4.1-flash" };
	const usageEvent = (seq, turn, inputTokens) => ({
		seq, time: fTime, type: "assistant/message",
		data: { turn, step: 0, message: { source: model }, usage: { inputTokens } }
	});
	// Parent: two own usage samples (1500 total).
	const parentEvents = [
		{ seq: 0, time: fTime, type: "request/header", data: { header: { config: model } } },
		usageEvent(1, 0, 1000),
		usageEvent(2, 1, 500)
	];
	const parent = { id: "fork-parent", seq: parentEvents.length, eventAt: (n) => parentEvents[n] };
	// Child: inherits the parent's prefix (seq 0..1), marks the cut at seq 2,
	// then adds ONE own sample (700). Only the own sample may be folded.
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
	// NOTE: assertions are per-day, not `result.total` — loadCache() is a
	// module-level singleton, so earlier sections in this file share one cache.
	// The day totals are what the regression is about and they stay isolated.
	const forkResult = await collectUsage(makeCtx({ list: () => [parent, child] }));
	const forkDay = forkResult.days.find((d) => d.date === "2026-02-03");
	// parent own 1500 + child own 700; a broken fold re-adds the inherited
	// prefix and reports 3700 here.
	check("fork child does not re-fold the inherited prefix", forkDay !== void 0 && forkDay.tokens === 2200, JSON.stringify(forkDay));

	// A RESUMED session is NOT a fork: its constructor seed is its own stored
	// history, so all of it must fold (isSeeded false ⇒ no cut).
	const resumedEvents = [
		{ seq: 0, time: fTime, type: "request/header", data: { header: { config: model } } },
		{ seq: 1, time: fTime, type: "session/end-seed", data: {} },
		{ seq: 2, time: fTime, type: "assistant/message", data: { turn: 0, step: 0, message: { source: model }, usage: { inputTokens: 400 } } }
	];
	const resumed = { id: "resumed-s1", header: { isSeeded: false }, seq: resumedEvents.length, eventAt: (n) => resumedEvents[n] };
	const resumedResult = await collectUsage(makeCtx({ list: () => [resumed] }));
	const resumedDay = resumedResult.days.find((d) => d.date === "2026-02-03");
	check("resumed session folds its whole own log", resumedDay !== void 0 && resumedDay.tokens === 2600, JSON.stringify(resumedDay));
	rmSync(forkHome, { recursive: true, force: true });
} finally {
	rmSync(tmpHome, { recursive: true, force: true });
	delete process.env.DSH_HOME;
}

console.log(failures.length === 0 ? "\nrc.1 session shape smoke passed" : `\n${failures.length} CHECK(S) FAILED`);
process.exit(failures.length === 0 ? 0 : 1);
