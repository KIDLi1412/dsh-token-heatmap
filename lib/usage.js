/**
 * dsh-token-heatmap — pure per-day, per-model token-usage aggregation over
 * session event logs. Kept free of cordis imports so it can be unit-tested
 * and validated against real logs outside the running harness.
 *
 * Aggregation semantics mirror `dsh-token-meter`'s `tokenUsage` projection
 * (and the reference plugin dsh-usage-stats, MIT © Ychris12138): a usage
 * sample rides an `assistant/chunk` (`data.chunk.type === "usage"`) or an
 * `assistant/message` (`data.usage`); a repeated sample for the same
 * (turn, step) REPLACES the earlier value instead of double counting it, and
 * the replacement is re-attributed to the day of the later event.
 *
 * Each sample is additionally attributed to the model that produced it:
 * `assistant/message` carries `data.message.source.model`; usage chunks fall
 * back to the last `request/header` `data.header.config.model`; samples with
 * no model information land in the `unknown/unknown` bucket.
 *
 * @module dsh-token-heatmap/usage
 */

/** Local-calendar `YYYY-MM-DD` key for a millisecond epoch. */
export function dayKey(timeMs) {
	const date = new Date(timeMs);
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}

/** Empty token bucket. */
export function zeroBuckets() {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0
	};
}

/** Provider usage → buckets (missing cache fields are absent in some reports). */
export function bucketsOf(usage) {
	return {
		inputTokens: usage.inputTokens ?? 0,
		outputTokens: usage.outputTokens ?? 0,
		cacheReadTokens: usage.cacheReadTokens ?? 0,
		cacheWriteTokens: usage.cacheWriteTokens ?? 0
	};
}

/** Total tokens across all buckets. */
export function totalTokens(buckets) {
	return buckets.inputTokens + buckets.outputTokens + buckets.cacheReadTokens + buckets.cacheWriteTokens;
}

/** Prompt-side cache hit rate in percent (0–100, one decimal), or null when no prompt tokens were reported. */
export function cacheHitRate(buckets) {
	const input = buckets.inputTokens ?? 0;
	const cacheRead = buckets.cacheReadTokens ?? 0;
	const cacheWrite = buckets.cacheWriteTokens ?? 0;
	const promptTokens = input + cacheRead + cacheWrite;
	if (promptTokens <= 0) return null;
	return Math.round((cacheRead / promptTokens) * 1000) / 10;
}

function addInto(target, source) {
	target.inputTokens += source.inputTokens;
	target.outputTokens += source.outputTokens;
	target.cacheReadTokens += source.cacheReadTokens;
	target.cacheWriteTokens += source.cacheWriteTokens;
	return target;
}

function subtractFrom(target, source) {
	target.inputTokens -= source.inputTokens;
	target.outputTokens -= source.outputTokens;
	target.cacheReadTokens -= source.cacheReadTokens;
	target.cacheWriteTokens -= source.cacheWriteTokens;
	return target;
}

/** Extract the usage sample an event carries, if any. */
function sampleOf(event) {
	if (event.type === "assistant/chunk" && event.data?.chunk?.type === "usage") {
		return {
			key: `${event.data.turn}:${event.data.step}`,
			usage: event.data.chunk.usage
		};
	}
	if (event.type === "assistant/message" && event.data?.usage !== void 0) {
		return {
			key: `${event.data.turn}:${event.data.step}`,
			usage: event.data.usage
		};
	}
	return void 0;
}

/**
 * The `provider/model` attribution key of a usage sample: the exact provider
 * route plus the model id, so the SAME model served by different providers
 * stays distinct. `assistant/message` names its provider via
 * `data.message.source`; usage chunks fall back to the last `request/header`
 * `data.header.config`; samples with no model information land in
 * `unknown/unknown`.
 */
function modelOf(event) {
	const source = event.data?.message?.source;
	if (source !== void 0 && typeof source.model === "string") {
		return `${typeof source.provider === "string" && source.provider.length > 0 ? source.provider : "unknown"}/${source.model}`;
	}
	const config = event.data?.header?.config;
	if (config !== void 0 && typeof config.model === "string") {
		return `${typeof config.provider === "string" && config.provider.length > 0 ? config.provider : "unknown"}/${config.model}`;
	}
	return void 0;
}

/** Day entry: totals plus a per-model bucket map. */
function entryOf(byDay, day) {
	let entry = byDay.get(day);
	if (entry === void 0) {
		entry = {
			totals: zeroBuckets(),
			models: new Map()
		};
		byDay.set(day, entry);
	}
	return entry;
}

/**
 * One session's incremental fold state. `days` holds the already-folded
 * per-day entries; `lastSample`/`currentModel` let a later event slice keep
 * the replace-last-sample semantics and model attribution across fold
 * boundaries without replaying the whole log.
 */
export function createUsageState() {
	return {
		days: new Map(),
		lastSample: null,
		currentModel: null,
		consumed: 0
	};
}

/**
 * Fold a slice of NEW events onto an existing session state (mutating).
 * Replacements for the same (turn, step) subtract the previous sample's
 * buckets from the day/model bucket they were attributed to, so a slice
 * starting mid-step (e.g. a usage chunk at the tail of the previous fold)
 * stays exact.
 * @param state - session fold state (mutated in place).
 * @param events - the new events, in seq order, starting after the last fold.
 */
export function applyUsageDelta(state, events) {
	let last = state.lastSample;
	let currentModel = state.currentModel;
	for (const event of events) {
		if (event.type === "request/header") {
			const model = modelOf(event);
			if (model !== void 0) currentModel = model;
		}
		const sample = sampleOf(event);
		if (sample === void 0) continue;
		const buckets = bucketsOf(sample.usage);
		const model = modelOf(event) ?? currentModel ?? "unknown/unknown";
		const day = dayKey(event.time);
		const entry = entryOf(state.days, day);
		if (last !== null && last.key === sample.key) {
			// Same turn/step re-reported: replace instead of double counting.
			const previous = state.days.get(last.day);
			if (previous !== void 0) {
				subtractFrom(previous.totals, last.buckets);
				const previousModel = previous.models.get(last.model);
				if (previousModel !== void 0) subtractFrom(previousModel, last.buckets);
			}
		}
		addInto(entry.totals, buckets);
		let modelBucket = entry.models.get(model);
		if (modelBucket === void 0) {
			modelBucket = zeroBuckets();
			entry.models.set(model, modelBucket);
		}
		addInto(modelBucket, buckets);
		last = { key: sample.key, day, model, buckets };
	}
	state.lastSample = last;
	state.currentModel = currentModel;
}

/**
 * Fold one session's events into per-day, per-model token buckets.
 * @param events - session event log in seq order.
 * @returns Map<`YYYY-MM-DD`, { totals, models: Map<model, buckets> }> with
 *   only days that saw usage.
 */
export function foldUsage(events) {
	const state = createUsageState();
	applyUsageDelta(state, events);
	return state.days;
}

/**
 * Merge one session's folded days into a global per-day map.
 * @param byDay - global map to mutate.
 * @param sessionDays - session day map (from foldUsage or a state).
 */
export function mergeInto(byDay, sessionDays) {
	for (const [day, entry] of sessionDays) {
		const target = entryOf(byDay, day);
		addInto(target.totals, entry.totals);
		for (const [model, buckets] of entry.models) {
			let modelBucket = target.models.get(model);
			if (modelBucket === void 0) {
				modelBucket = zeroBuckets();
				target.models.set(model, modelBucket);
			}
			addInto(modelBucket, buckets);
		}
	}
}

/**
 * Render a global per-day map into the wire shape for the usage endpoint.
 * @param byDay - day → entry map.
 * @param updatedAt - computation timestamp.
 * @returns `{ days, total, updatedAt }` with `days` sorted ascending; each
 *   day carries `models` (descending by tokens) and a `cacheHitRate` percent.
 */
export function renderUsage(byDay, updatedAt) {
	const days = [...byDay.entries()]
		.map(([date, entry]) => {
			const models = [...entry.models.entries()]
				.map(([model, buckets]) => ({
					model,
					...buckets,
					tokens: totalTokens(buckets),
					cacheHitRate: cacheHitRate(buckets)
				}))
				.sort((a, b) => b.tokens - a.tokens);
			return {
				date,
				...entry.totals,
				tokens: totalTokens(entry.totals),
				cacheHitRate: cacheHitRate(entry.totals),
				models
			};
		})
		.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
	const total = days.reduce((sum, day) => sum + day.tokens, 0);
	return { days, total, updatedAt };
}

/**
 * Render a DSH built-in usage ledger (`<DSH_HOME>/dsh-usage/usage-ledger.json`)
 * into the same wire shape as renderUsage. The ledger is the complete,
 * real-time, per-day/per-provider/per-model token aggregate that the built-in
 * 设置 → 使用统计 card reads, so using it as the heatmap's primary source keeps
 * the heatmap exact across process restarts.
 *
 * The session-event fold in collectUsage cannot enumerate persisted sessions
 * on DSH 0.1.2+ rc.1 (sessionPersistence no longer exposes list/listSnapshots)
 * and only folds live sessions while the hero screen is mounted (the client
 * polls the usage endpoint only there), which silently drops both same-day
 * usage from sessions that ended off-hero and all pre-restart history. The
 * ledger has neither gap.
 *
 * Token口径与 renderUsage 一致：input + output + cacheRead + cacheWrite
 * (reasoningTokens 是思维链长度，不计入主用量，与内置统计总量口径一致)。
 *
 * @param ledger - parsed usage-ledger.json (`{ version, days }`).
 * @param updatedAt - computation timestamp.
 * @returns `{ days, total, updatedAt }` in the same shape as renderUsage:
 *   `days` sorted ascending; each day carries `models` (descending by tokens)
 *   and a `cacheHitRate` percent. Returns an empty result for a null/invalid
 *   ledger so callers can fall back to the session-event fold.
 */
export function renderLedger(ledger, updatedAt) {
	const days = [];
	let total = 0;
	const ledgerDays = ledger !== null && typeof ledger === "object" ? ledger.days : null;
	if (ledgerDays !== null && typeof ledgerDays === "object") {
		for (const [date, providers] of Object.entries(ledgerDays)) {
			if (providers === null || typeof providers !== "object") continue;
			const models = [];
			const dayTotals = zeroBuckets();
			for (const [provider, providerModels] of Object.entries(providers)) {
				if (providerModels === null || typeof providerModels !== "object") continue;
				for (const [model, buckets] of Object.entries(providerModels)) {
					if (buckets === null || typeof buckets !== "object") continue;
					const b = {
						inputTokens: Number.isFinite(buckets.inputTokens) ? buckets.inputTokens : 0,
						outputTokens: Number.isFinite(buckets.outputTokens) ? buckets.outputTokens : 0,
						cacheReadTokens: Number.isFinite(buckets.cacheReadTokens) ? buckets.cacheReadTokens : 0,
						cacheWriteTokens: Number.isFinite(buckets.cacheWriteTokens) ? buckets.cacheWriteTokens : 0
					};
					addInto(dayTotals, b);
					models.push({
						model: `${provider}/${model}`,
						...b,
						tokens: totalTokens(b),
						cacheHitRate: cacheHitRate(b)
					});
				}
			}
			models.sort((a, b) => b.tokens - a.tokens);
			days.push({
				date,
				...dayTotals,
				tokens: totalTokens(dayTotals),
				cacheHitRate: cacheHitRate(dayTotals),
				models
			});
			total += totalTokens(dayTotals);
		}
	}
	days.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
	return { days, total, updatedAt };
}
