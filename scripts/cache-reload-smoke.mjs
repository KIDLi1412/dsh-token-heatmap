/**
 * Cache-reload smoke: the stored-session fold must REUSE token-heatmap-cache.json
 * across restarts, and stay exact while doing it.
 *
 * Before 0.5.2 every stored log was refolded whenever its revision moved, and on
 * DSH 0.2.0 that is every pass: the jsonl backend stamps a pre-v4 log with
 * `${fileRevision}:${historicalCorpusRevision}` — a sha256 over EVERY session
 * file — so one append anywhere moves every pre-v4 revision at once (measured on
 * a real install: 124 of 181 cached sessions shared one corpus hash, 44 MB of
 * logs re-read twice per pass, on each restart and each refresh). The fold also
 * started one event too early (`seq >= consumed` with a `consumed + 1` contiguity
 * test), so even a genuinely appended log was rebuilt from seq 0.
 *
 * The fake backend below mirrors that contract exactly: a whole-log `open()` +
 * `read()` (what 0.2.0 exposes), pre-v4 revisions carrying a corpus digest, and
 * a `readFrom()` variant for the 0.1.x range-read shape. Every scenario is
 * checked against a from-scratch fold of the same logs, so "cheaper" is never
 * allowed to mean "different".
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LIB = new URL("../lib/index.js", import.meta.url).href;
const DEV = "3501395697";
const INO = "1407374883737499";
const BASE = Date.parse("2026-10-01T10:00:00Z");

/** `n` usage events in the shape lib/usage.js folds (one per turn/step pair). */
function usageEvents(from, to, tokens = 10) {
	const events = [];
	for (let seq = from; seq < to; seq += 1) {
		events.push({
			seq,
			type: "assistant/chunk",
			time: BASE + seq * 1000,
			data: { turn: Math.floor(seq / 2), step: seq % 2, chunk: { type: "usage", usage: { inputTokens: tokens, outputTokens: 1 } } }
		});
	}
	return events;
}

const corpusHash = (value) => createHash("sha256").update(value).digest("hex");

/** One session's stored log: its events plus the stat identity behind its revision. */
function log(events, { legacy = true, size = events.length, mtime = 1791700760727736600 } = {}) {
	return { events, legacy, size, mtime };
}

/**
 * A fake `sessionPersistence` mirroring dsh-session-persistence-jsonl: `list()`
 * carries the opaque revision (stat fingerprint, plus a corpus digest for the
 * pre-v4 generations), `open()`/`read()` returns the WHOLE log, and `readFrom()`
 * — the 0.1.x shape — returns the range from `fromSeq`.
 */
function backend(logs, { corpus = "corpus-1", mode = "whole" } = {}) {
	const calls = Object.fromEntries([...logs.keys()].map((id) => [id, { opens: 0, reads: 0, events: 0, from: [] }]));
	const stat = (id) => `${DEV}:${INO}:${logs.get(id).size}:${logs.get(id).mtime}:${logs.get(id).mtime}`;
	const revision = (id) => (logs.get(id).legacy ? `${stat(id)}:${corpusHash(corpus)}` : stat(id));
	const deliver = (id, from) => {
		calls[id].reads += 1;
		const events = logs.get(id).events.filter((event) => event.seq >= from);
		calls[id].events += events.length;
		return { events };
	};
	return {
		calls,
		service: {
			async list() {
				return [...logs.keys()].map((id) => ({ header: { id }, revision: revision(id) }));
			},
			...(mode === "range"
				// The 0.1.x shape: a RANGE read, so the plugin cannot see the log's end.
				? {
					async readFrom(id, fromSeq) {
						calls[id].opens += 1;
						calls[id].from.push(fromSeq);
						return deliver(id, fromSeq);
					}
				}
				// The 0.2.0 shape: the WHOLE log comes back, prefix included.
				: {
					async open(id) {
						calls[id].opens += 1;
						return { read: async () => deliver(id, 0), close: async () => {} };
					}
				})
		}
	};
}

let moduleVersion = 0;
/** One aggregation run: a fresh module instance (a restart) against `home`. */
async function run(home, persistence) {
	process.env.DSH_HOME = home;
	const module = await import(`${LIB}?v=${moduleVersion++}`);
	const usage = await module.collectUsage({
		logger: { info: () => {}, warn: () => {} },
		get: (key) => (key === "sessions" ? { list: () => [] } : key === "sessionPersistence" ? persistence : void 0)
	});
	return usage;
}

const home = mkdtempSync(join(tmpdir(), "thm-cache-reload-"));
mkdirSync(join(home, "storages"), { recursive: true });
const homeForScratch = () => {
	const dir = mkdtempSync(join(tmpdir(), "thm-cache-scratch-"));
	mkdirSync(join(dir, "storages"), { recursive: true });
	return dir;
};

/** The days a cold fold of the same logs produces — the exactness baseline. */
async function coldFold(logs, options) {
	return (await run(homeForScratch(), backend(logs, options).service)).days;
}

/** Every read counter must be exactly what the scenario expects. */
function assertReads(calls, expected, label) {
	for (const [id, want] of Object.entries(expected)) {
		const seen = calls[id].reads;
		assert.equal(seen, want, `${label}: ${id} reads (want ${want}, got ${seen})`);
	}
}

// ---------------------------------------------------------------- scenarios
// Two pre-v4 logs (corpus-tainted revisions) and two v4 logs (plain stat
// revisions), all stored, none live.
const logs = new Map([
	["legacy-untouched", log(usageEvents(0, 200))],
	["legacy-appended", log(usageEvents(0, 200))],
	["v4-untouched", log(usageEvents(0, 120), { legacy: false })],
	["v4-appended", log(usageEvents(0, 120), { legacy: false })]
]);

// 1. Cold start: every log is read once and folded.
let run1 = backend(logs, { corpus: "corpus-1" });
const cold = await run(home, run1.service);
assertReads(run1.calls, { "legacy-untouched": 1, "legacy-appended": 1, "v4-untouched": 1, "v4-appended": 1 }, "cold start");
assert.deepEqual(cold.days, await coldFold(logs, { corpus: "corpus-1" }), "cold start must equal a from-scratch fold");

// 2. Restart with NOTHING changed: the corpus digest moved (any append anywhere
//    does that) while every log's bytes are identical. Nothing may be read.
let run2 = backend(logs, { corpus: "corpus-2" });
const restarted = await run(home, run2.service);
assertReads(run2.calls, { "legacy-untouched": 0, "legacy-appended": 0, "v4-untouched": 0, "v4-appended": 0 }, "restart, corpus digest only");
assert.deepEqual(restarted.days, cold.days, "an untouched cache must survive a restart unchanged");

// 3. One append in a pre-v4 log and one in a v4 log: each is read once, and only
//    the new event is folded on top of the cached days.
logs.get("legacy-appended").events.push(...usageEvents(200, 201));
logs.get("legacy-appended").size += 1;
logs.get("legacy-appended").mtime += 1000;
logs.get("v4-appended").events.push(...usageEvents(120, 121));
logs.get("v4-appended").size += 1;
logs.get("v4-appended").mtime += 1000;
let run3 = backend(logs, { corpus: "corpus-3" });
const appended = await run(home, run3.service);
assertReads(run3.calls, { "legacy-untouched": 0, "legacy-appended": 1, "v4-untouched": 0, "v4-appended": 1 }, "one append each");
assert.deepEqual(appended.days, await coldFold(logs, { corpus: "corpus-3" }), "an incremental fold must equal a from-scratch fold");

// 4. Nothing at all moved: not even the digest. Still nothing to read.
let run4 = backend(logs, { corpus: "corpus-3" });
const idle = await run(home, run4.service);
assertReads(run4.calls, { "legacy-untouched": 0, "legacy-appended": 0, "v4-untouched": 0, "v4-appended": 0 }, "second request, same process state");
assert.deepEqual(idle.days, appended.days, "an idle pass must not disturb the totals");

// 5. A same-length REWRITE (same event count, one payload changed, new mtime):
//    `seq` cannot see it, so the session must be rebuilt, not trusted.
logs.get("legacy-untouched").events[100] = {
	...logs.get("legacy-untouched").events[100],
	data: { ...logs.get("legacy-untouched").events[100].data, chunk: { type: "usage", usage: { inputTokens: 999, outputTokens: 1 } } }
};
logs.get("legacy-untouched").mtime += 1000;
let run5 = backend(logs, { corpus: "corpus-5" });
const rewritten = await run(home, run5.service);
assertReads(run5.calls, { "legacy-untouched": 1, "legacy-appended": 0, "v4-untouched": 0, "v4-appended": 0 }, "same-length rewrite");
assert.deepEqual(rewritten.days, await coldFold(logs, { corpus: "corpus-5" }), "a rewritten log must be rebuilt exactly");

// 6. A shortened log (the tail was dropped): also a rewrite, also rebuilt. The
//    removed 101 events must leave the totals, and nothing else may move.
const day = (usage) => usage.days.find((entry) => entry.date === "2026-10-01");
const beforeShortening = day(rewritten).tokens;
logs.get("legacy-appended").events = logs.get("legacy-appended").events.slice(0, 100);
logs.get("legacy-appended").size = 100;
logs.get("legacy-appended").mtime += 1000;
let run6 = backend(logs, { corpus: "corpus-6" });
const shortened = await run(home, run6.service);
assertReads(run6.calls, { "legacy-untouched": 0, "legacy-appended": 1, "v4-untouched": 0, "v4-appended": 0 }, "shortened log");
assert.deepEqual(shortened.days, await coldFold(logs, { corpus: "corpus-6" }), "a shortened log must be rebuilt exactly");
assert.equal(day(shortened).tokens, beforeShortening - 101 * 11, "the dropped tail must leave the totals, and nothing else");

// 7. The range-read shape (0.1.x `readFrom`), which never shows the log's end.
const rangeHome = mkdtempSync(join(tmpdir(), "thm-cache-range-"));
mkdirSync(join(rangeHome, "storages"), { recursive: true });
const rangeLogs = new Map([["range-1", log(usageEvents(0, 50))]]);
let range1 = backend(rangeLogs, { corpus: "range-1", mode: "range" });
const rangeCold = await run(rangeHome, range1.service);
assert.deepEqual(range1.calls["range-1"].from, [0], "a cold range read starts at seq 0");

// 7a. Only the corpus digest moved, so the file is provably untouched: not read.
let range2 = backend(rangeLogs, { corpus: "range-2", mode: "range" });
const rangeIdle = await run(rangeHome, range2.service);
assert.equal(range2.calls["range-1"].reads, 0, "a range log whose corpus digest moved is not read");
assert.deepEqual(rangeIdle.days, rangeCold.days, "an untouched range log must survive the restart");

// 7b. The file itself moved but holds nothing new: one range read from the folded
//     cursor, and the days are KEPT — an empty range delta is not a rewrite.
rangeLogs.get("range-1").mtime += 1000;
let range3 = backend(rangeLogs, { corpus: "range-3", mode: "range" });
const rangeKept = await run(rangeHome, range3.service);
assert.equal(range3.calls["range-1"].reads, 1, "a moved range log is read once");
assert.deepEqual(range3.calls["range-1"].from, [49], "the range read resumes at the folded cursor");
assert.deepEqual(rangeKept.days, rangeCold.days, "an empty range delta must not rebuild the session");

// 8. Fork cut: a stored fork log starts with a copy of the parent's events, and
//    only the events after the marked cut may count. 10 inherited usage events
//    (110 tokens) followed by 20 owned ones (220) must total 220.
const forkHome = mkdtempSync(join(tmpdir(), "thm-cache-fork-"));
mkdirSync(join(forkHome, "storages"), { recursive: true });
const forkEvents = [
	...usageEvents(0, 10),
	{ seq: 10, type: "session/end-seed", time: BASE, data: { inherited: true } },
	...usageEvents(11, 31)
];
const forkLogs = new Map([["fork-1", log(forkEvents)]]);
const fork = await run(forkHome, backend(forkLogs, { corpus: "fork-1" }).service);
assert.equal(fork.days.find((day) => day.date === "2026-10-01").tokens, 20 * 11, "the fork's inherited prefix must not be counted");

// 9. Fail-safe: a revision whose shape carries no stat fingerprint (the in-memory
//    backend's `memory:<name>:<counter>`) is never "proven unchanged", so the log
//    is still read — the optimization may only ever cost a read, never a stale
//    fold.
const memoryHome = mkdtempSync(join(tmpdir(), "thm-cache-memory-"));
mkdirSync(join(memoryHome, "storages"), { recursive: true });
const memoryLogs = new Map([["memory-1", log(usageEvents(0, 30))]]);
let counter = 0;
const memoryBackend = () => {
	const calls = { reads: 0 };
	return {
		calls,
		service: {
			async list() {
				return [{ header: { id: "memory-1" }, revision: `memory:test:${++counter}` }];
			},
			async open() {
				return { read: async () => { calls.reads += 1; return { events: memoryLogs.get("memory-1").events }; }, close: async () => {} };
			}
		}
	};
};
await run(memoryHome, memoryBackend().service);
const memorySecond = memoryBackend();
await run(memoryHome, memorySecond.service);
assert.equal(memorySecond.calls.reads, 1, "an unrecognizable revision shape must still be read");

console.log("cache reload smoke passed");
