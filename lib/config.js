/**
 * dsh-token-heatmap — config model.
 *
 * Pure validation/coercion for the plugin's user-facing settings:
 *   enabled      — master switch for the hero-screen heatmap card (default true)
 *   colorScheme  — cell palette name (default "green")
 *
 * The server half persists the raw JSON document under
 * `<DSH_HOME>/storages/token-heatmap-config.json` and serves it over the
 * loopback-only config endpoint; the settings card in
 * 设置 → 插件 → 插件配置 edits it.
 *
 * Scheme membership is deliberately NOT enforced here. The browser bundle is
 * served fresh at request time while the server half only reloads on restart,
 * so a client that knows a new palette must be able to store it against a
 * server still running older code; the client renders any unknown scheme with
 * its green fallback. The server bounds only the SHAPE (a short non-blank
 * string) so a foreign or hand-edited document still degrades to sane values.
 *
 * @module dsh-token-heatmap/config
 */

/** Default configuration (also what a corrupt or absent document resolves to). */
export const DEFAULT_CONFIG = Object.freeze({ enabled: true, colorScheme: "green" });

/** Canonical color schemes, in display order (informational; not enforced). */
export const COLOR_SCHEMES = Object.freeze(["green", "blue", "orange", "red", "purple", "teal"]);

/** Upper bound on a stored scheme name; anything longer is treated as junk. */
const SCHEME_MAX_LENGTH = 32;

/** Whether a value is a plain object. */
function isPlainObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Validate and coerce one raw config document into the canonical shape.
 * Unknown fields are dropped; missing or invalid fields fall back to the
 * default. `colorScheme` is preserved verbatim (any short non-blank string),
 * so a newer client's scheme survives an older server between restarts.
 * @param raw - parsed JSON document, or undefined for an absent file.
 * @returns the canonical config.
 */
export function parseConfig(raw) {
	const config = { ...DEFAULT_CONFIG };
	if (!isPlainObject(raw)) return config;
	if (typeof raw.enabled === "boolean") config.enabled = raw.enabled;
	if (typeof raw.colorScheme === "string") {
		const scheme = raw.colorScheme.trim();
		if (scheme.length > 0 && scheme.length <= SCHEME_MAX_LENGTH) config.colorScheme = scheme;
	}
	return config;
}
