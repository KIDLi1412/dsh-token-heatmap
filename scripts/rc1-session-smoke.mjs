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
import { collectUsage } from "../lib/index.js";

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
} finally {
	rmSync(tmpHome, { recursive: true, force: true });
	delete process.env.DSH_HOME;
}

console.log(failures.length === 0 ? "\nrc.1 session shape smoke passed" : `\n${failures.length} CHECK(S) FAILED`);
process.exit(failures.length === 0 ? 0 : 1);
