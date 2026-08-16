/**
 * Diagnostic: why does the plugin's "today" differ from the DeepSeek
 * platform page's "today"?
 *
 * The platform page buckets by UTC (`tz=0`); the plugin buckets by the local
 * timezone. This script re-folds the PERSISTED session logs (multi-frame
 * `.zstd` JSONL under ~/.dsh/sessions) and reports the same usage by both
 * local-day and UTC-day keys, plus an hourly histogram, so the window skew
 * can be quantified.
 *
 * NOTE: live (in-memory) sessions are not on disk, so the totals here cover
 * only persisted sessions — the shape of the skew, not the exact grand total.
 *
 *   node scripts/verify-window.mjs
 */
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { bucketsOf, totalTokens } from "../lib/usage.js";

// Frame-locating logic copied from @deepseek-ai/dsh-session-persistence-jsonl
// (lib/types/zstd.js, MIT, part of DeepSeek Harness): the session logs are
// concatenated zstd frames, and Node's one-shot/streaming decoders only read
// the first frame, so frames must be located and decoded one by one.
const ZSTD_MAGIC = 4247762216;
function scanZstdFrames(buffer) {
	const frames = [];
	let offset = 0;
	while (offset < buffer.length) {
		const start = offset;
		if (buffer.length - offset < 4) break;
		if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`corrupt zstd: invalid frame magic at byte ${offset}`);
		offset += 4;
		if (offset === buffer.length) break;
		const descriptor = buffer.readUInt8(offset);
		offset += 1;
		if ((descriptor & 24) !== 0) throw new Error(`corrupt zstd: reserved frame-header bit at byte ${offset - 1}`);
		const contentSizeFlag = descriptor >>> 6;
		const singleSegment = (descriptor & 32) !== 0;
		const checksum = (descriptor & 4) !== 0;
		const dictionaryFlag = descriptor & 3;
		const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
		const contentSizeBytes = contentSizeFlag === 0 ? singleSegment ? 1 : 0 : 1 << contentSizeFlag;
		const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
		if (buffer.length - offset < remainingHeaderBytes) break;
		offset += remainingHeaderBytes;
		for (;;) {
			if (buffer.length - offset < 3) break;
			const blockHeader = buffer.readUIntLE(offset, 3);
			offset += 3;
			const lastBlock = (blockHeader & 1) !== 0;
			const blockType = blockHeader >>> 1 & 3;
			const blockSize = blockHeader >>> 3;
			if (blockType === 3) throw new Error(`corrupt zstd: reserved block type at byte ${offset - 3}`);
			const payloadBytes = blockType === 1 ? 1 : blockSize;
			if (buffer.length - offset < payloadBytes) break;
			offset += payloadBytes;
			if (lastBlock) break;
		}
		if (checksum) {
			if (buffer.length - offset < 4) break;
			offset += 4;
		}
		frames.push({ start, end: offset });
	}
	return frames;
}

function decompressLog(buffer) {
	return scanZstdFrames(buffer)
		.map(({ start, end }) => zstdDecompressSync(buffer.subarray(start, end)).toString("utf8"))
		.join("");
}

const sessionsRoot = join(homedir(), ".dsh", "sessions");

function walkSessionFiles(dir, out = []) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) walkSessionFiles(path, out);
		else if (entry.name === "session.jsonl.zstd") out.push(path);
	}
	return out;
}

function localKey(timeMs) {
	const d = new Date(timeMs);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function utcKey(timeMs) {
	const d = new Date(timeMs);
	return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function sampleOf(event) {
	if (event.type === "assistant/chunk" && event.data?.chunk?.type === "usage" && event.data?.chunk?.usage) {
		return { key: `${event.data.turn}:${event.data.step}`, time: event.time, usage: event.data.chunk.usage };
	}
	if (event.type === "assistant/message" && event.data?.usage !== void 0) {
		return { key: `${event.data.turn}:${event.data.step}`, time: event.time, usage: event.data.usage };
	}
	return void 0;
}

const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const localDays = new Map();
const utcDays = new Map();
const hourBins = new Map();
let sessions = 0;
let events = 0;

function addInto(target, source) {
	target.inputTokens += source.inputTokens;
	target.outputTokens += source.outputTokens;
	target.cacheReadTokens += source.cacheReadTokens;
	target.cacheWriteTokens += source.cacheWriteTokens;
}

function subtractFrom(target, source) {
	target.inputTokens -= source.inputTokens;
	target.outputTokens -= source.outputTokens;
	target.cacheReadTokens -= source.cacheReadTokens;
	target.cacheWriteTokens -= source.cacheWriteTokens;
}

for (const file of walkSessionFiles(sessionsRoot)) {
	const raw = decompressLog(readFileSync(file));
	// Replace-last-sample semantics, mirroring lib/usage.js applyUsageDelta:
	// a repeated sample for the same (turn, step) replaces the earlier one.
	let last = null;
	for (const line of raw.split("\n")) {
		if (line.trim() === "") continue;
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		events += 1;
		const sample = sampleOf(event);
		if (sample === void 0) continue;
		const buckets = bucketsOf(sample.usage);
		const lk = localKey(sample.time);
		const uk = utcKey(sample.time);
		const hour = new Date(sample.time).getHours();
		if (last !== null && last.key === sample.key) {
			subtractFrom(localDays.get(last.lk) ?? zero, last.buckets);
			subtractFrom(utcDays.get(last.uk) ?? zero, last.buckets);
			hourBins.set(last.hour, (hourBins.get(last.hour) ?? 0) - totalTokens(last.buckets));
		}
		if (!localDays.has(lk)) localDays.set(lk, { ...zero });
		if (!utcDays.has(uk)) utcDays.set(uk, { ...zero });
		addInto(localDays.get(lk), buckets);
		addInto(utcDays.get(uk), buckets);
		hourBins.set(hour, (hourBins.get(hour) ?? 0) + totalTokens(buckets));
		last = { key: sample.key, lk, uk, hour, buckets };
	}
	sessions += 1;
}

const now = new Date();
const todayLocal = localKey(now.getTime());
const todayUtc = utcKey(now.getTime());

const fmt = (b) => (b === void 0 ? "—" : `${(totalTokens(b) / 1e6).toFixed(1)}M  (in ${(b.inputTokens / 1e6).toFixed(2)}M + out ${(b.outputTokens / 1e6).toFixed(2)}M + cache ${(b.cacheReadTokens / 1e6).toFixed(1)}M)`);

console.log(`persisted sessions scanned: ${sessions}, events: ${events}`);
console.log(`now: local ${now.toLocaleString()} | UTC ${now.toUTCString()}`);
console.log(`\nlocal-day totals (plugin/heatmap keying):`);
for (const [key, b] of [...localDays.entries()].sort()) console.log(`  ${key}${key === todayLocal ? "  ← today" : ""}  ${fmt(b)}`);
console.log(`\nutc-day totals (platform page keying):`);
for (const [key, b] of [...utcDays.entries()].sort()) console.log(`  ${key}${key === todayUtc ? "  ← today" : ""}  ${fmt(b)}`);
console.log(`\nlocal-hour histogram (persisted sessions, tokens):`);
for (let h = 0; h < 24; h += 1) {
	const v = hourBins.get(h) ?? 0;
	console.log(`  ${String(h).padStart(2, "0")}:00  ${(v / 1e6).toFixed(1).padStart(7)}M  ${"#".repeat(Math.round(v / 1e6 / 2))}`);
}
const morning = [...hourBins.entries()].filter(([h]) => h < 8).reduce((s, [, v]) => s + v, 0);
const dayRest = [...hourBins.entries()].filter(([h]) => h >= 8).reduce((s, [, v]) => s + v, 0);
console.log(`\npersisted usage local 00:00–08:00: ${(morning / 1e6).toFixed(1)}M   (inside local today, outside UTC today)`);
console.log(`persisted usage local 08:00–24:00: ${(dayRest / 1e6).toFixed(1)}M   (the UTC today window)`);
