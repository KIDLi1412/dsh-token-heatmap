// Contract smoke for the Host-side plugin CONFIG + its schema: imports the
// real lib/index.js and verifies the schemastery schema behaves exactly as DSH
// 0.2.0 relies on when it derives a settings form from it (`schema(entry)`):
//   1. BOTH fields are declared `.volatile()`. DSH builds every settings form
//      out of the VOLATILE subtree alone, so a plain field means the entry is
//      dropped from `settings.describe()` and every write throws `Plugin entry
//      "…" has no volatile fields` — the ⚙ panel then silently keeps serving
//      the defaults (0.5.0 shipped exactly that bug). The gate below is the
//      condition `volatileForm()` / `isVolatilePath()` implement in
//      `@deepseek-ai/dsh-settings@0.2.0-rc.2` (lib/types/schema.js), restated
//      here so the guard fails in this smoke, not in the browser;
//   2. an empty user layer resolves through the defaults, malformed writes are
//      rejected, and an unknown-but-well-formed scheme survives (the client
//      renders it with its green fallback, mirroring the legacy parseConfig
//      leniency);
//   3. the cosmokit references those volatile fields parse to are unwrapped by
//      entryConfig(), so no caller can read a `{ get() }` wrapper as a value
//      and quietly fall back to the defaults.
// It also pins the one string two processes must agree on — the profile ENTRY
// ID the client asks `ctx.configForms.get(...)` for — against the bundle patch,
// and covers the removed-settings-document rescue plus the apply() contract.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Config, SETTINGS_NAMESPACE, TokenHeatmapSettingsSchema, apply, entryConfig, dshHomeDirectory, legacySettingFromDocument } from "../lib/index.js";
import { CONFIG_PATH, USAGE_PATH } from "../lib/index.js";

// ---- the DSH 0.2.0 settings gate (dsh-settings lib/types/schema.js) -------
// The volatile-reference protocol is a registered Symbol (cosmokit), which is
// how a `.volatile()` field's parsed value is recognized.
const VOLATILE_WRITE = Symbol.for("cosmokit.volatile.write");
const isVolatile = (value) => typeof value === "object" && value !== null && VOLATILE_WRITE in value;
/** DSH's `volatileForm(schema) !== undefined`: does this node serve a form? */
function served(schema) {
	if (schema.meta.volatile) return true;
	if (schema.type !== "object") return false;
	return Object.values(schema.dict ?? {}).some((child) => served(child));
}
/** The field names that form would carry (empty ⇒ describe() drops the entry). */
function servedFields(schema) {
	return Object.entries(schema.dict ?? {}).filter(([, child]) => served(child)).map(([key]) => key);
}
/** DSH's `isVolatilePath(schema, path)`: is this path inside the volatile subtree? */
function isVolatilePath(schema, path) {
	if (schema.meta.volatile) return true;
	const [key, ...rest] = path;
	const child = key === undefined ? void 0 : schema.dict?.[key];
	return child !== void 0 && isVolatilePath(child, rest);
}
/** DSH's `plainConfig(value)`: snapshots out of any volatile reference. */
function plain(value) {
	if (isVolatile(value)) return plain(value.get());
	if (Array.isArray(value)) return value.map(plain);
	if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, plain(child)]));
	return value;
}

// Entry id: DSH 0.2.0 keys a plugin's config form by its profile entry id, so
// this constant is simultaneously the client's `configForms.get(...)` argument
// and the `id` of the row the bundle patch inserts. If they ever drift, the ⚙
// panel silently stops persisting.
assert.equal(typeof SETTINGS_NAMESPACE, "string");
assert.equal(SETTINGS_NAMESPACE, "token-heatmap", "entry id must be token-heatmap");
const patch = readFileSync(new URL("../cordis.patch.yml", import.meta.url), "utf8");
assert.match(patch, new RegExp(`id:\\s*${SETTINGS_NAMESPACE}\\s*$`, "m"), "the bundle patch must insert this exact entry id");
assert.equal(TokenHeatmapSettingsSchema, Config, "the 0.1.x schema name must alias the current Config");

// ---- the volatile gate: an entry with no volatile field is invisible -------
assert.equal(served(Config), true, "a Config with no volatile field is dropped from settings.describe() and every write throws");
assert.deepEqual(servedFields(Config).sort(), ["colorScheme", "defaultView"], "both display fields must be served by the derived form");
assert.equal(isVolatilePath(Config, ["colorScheme"]), true, "writes to colorScheme must pass the volatile-path check");
assert.equal(isVolatilePath(Config, ["defaultView"]), true, "writes to defaultView must pass the volatile-path check");
assert.equal(isVolatilePath(Config, ["enabled"]), false, "the retired switch must not be writable");
assert.equal(isVolatilePath(Config, []), false, "the section itself is not volatile; only its declared fields are");

// ---- schema behaviour (values read through the volatile references) --------
// Empty section → schema defaults.
assert.deepEqual(plain(Config({})), { colorScheme: "green", defaultView: "year" });

// Explicit values pass through.
assert.deepEqual(plain(Config({ colorScheme: "blue", defaultView: "month" })), { colorScheme: "blue", defaultView: "month" });

// The 0.1.x display switch is not part of the schema any more. Schemastery
// passes an undeclared key through untouched, so a stale `enabled` survives in
// the resolved section — which is fine: nothing reads it (serveConfig reports a
// constant true, and the client no longer gates on it).
assert.deepEqual(plain(Config({ enabled: false })), { enabled: false, colorScheme: "green", defaultView: "year" }, "retired enabled is inert");
assert.equal(plain(Config({ enabled: false })).colorScheme, "green", "retired enabled must not affect the resolved defaults");

// Blank scheme is rejected (min length 1).
assert.throws(() => Config({ colorScheme: "" }), /colorScheme/, "blank scheme must throw");

// Overlong scheme is rejected (max length 32, matching parseConfig).
assert.throws(() => Config({ colorScheme: "x".repeat(40) }), /colorScheme/, "overlong scheme must throw");

// Unknown-but-well-formed scheme is preserved verbatim, so a newer client's
// palette survives (the client falls back to green while rendering).
assert.deepEqual(plain(Config({ colorScheme: "rainbow" })), { colorScheme: "rainbow", defaultView: "year" }, "unknown scheme must be preserved");

// The view mode IS enumerated (unlike the scheme): an unknown mode has no
// renderer to fall back to in the client, so the Host refuses the write.
assert.throws(() => Config({ defaultView: "week" }), /defaultView/, "unknown view mode must throw");
assert.equal(plain(Config({ defaultView: "month" })).defaultView, "month");
assert.equal(plain(Config({})).defaultView, "year", "view default must be year");

// Every field parses to a volatile REFERENCE — that is what makes it served —
// so a caller that reads the parse result directly would hold `{ get() }`
// wrappers, never strings.
assert.equal(isVolatile(Config({}).colorScheme), true, "colorScheme must parse to a volatile reference");
assert.equal(isVolatile(Config({}).defaultView), true, "defaultView must parse to a volatile reference");
assert.equal(typeof Config({}).colorScheme, "object", "an unwrapped read is exactly the bug entryConfig() guards against");

// ---- entry reads (no `settings.get` in 0.2.0) ----------------------------
// A fake host exposing only describe(): the value is the resolved section. The
// old accessor is gone, so a plugin that still called it would read undefined
// and silently serve the defaults.
const fakeHost = {
	get: (key) => (key === "settings" ? { describe: () => [{ ns: SETTINGS_NAMESPACE, value: Config({ colorScheme: "teal" }), user: { colorScheme: "teal" } }] } : void 0)
};
assert.deepEqual(entryConfig(fakeHost, SETTINGS_NAMESPACE), { colorScheme: "teal", defaultView: "year" }, "entryConfig must read through describe() and unwrap the volatile references");
const plainHost = {
	get: (key) => (key === "settings" ? { describe: () => [{ ns: SETTINGS_NAMESPACE, value: { colorScheme: "orange", defaultView: "month" } }] } : void 0)
};
assert.deepEqual(entryConfig(plainHost, SETTINGS_NAMESPACE), { colorScheme: "orange", defaultView: "month" }, "the plain descriptor DSH serves must pass through unchanged");
assert.equal(entryConfig(fakeHost, "other-entry"), void 0, "an absent entry reads undefined");
assert.equal(entryConfig({ get: () => void 0 }, SETTINGS_NAMESPACE), void 0, "an absent settings service reads undefined");

// ---- apply() against a fake host ----------------------------------------
// DSH 0.2.0 dropped `settings.register(ns, schema)` (the Config export is the
// form), so the body must register its two routes and never touch the settings
// document apart from the rescue.
const routes = [];
const applyCtx = {
	root: {},
	get: (key) => (key === "settings" ? { describe: () => [], update: () => Promise.resolve() } : void 0),
	logger: { info: () => {}, warn: () => {} },
	effect: (fn) => { fn(); return () => {}; },
	on: () => () => {},
	webServer: { register: (route) => { routes.push(route); return () => {}; } },
	settings: { describe: () => [], update: () => Promise.resolve() }
};
apply(applyCtx);
assert.deepEqual(routes.map((route) => [route.kind, route.path]), [
	["exact", USAGE_PATH],
	["exact", CONFIG_PATH]
], "the body must register exactly the two exact routes");

// ---- removed settings.yaml rescue ---------------------------------------
// DSH 0.2.0 imported the removed `settings.yaml` sections keyed by entry id,
// but skipped ours while the bundle was refused for incompatible peers. The
// scan is deliberately narrow: one top-level section, one scalar.
const legacyDocument = [
	"ui-theme:",
	"  preference: light",
	"token-heatmap:",
	"  enabled: true",
	"  colorScheme: purple",
	"  defaultView: month",
	"other:",
	"  colorScheme: rainbow"
].join("\n");
assert.equal(legacySettingFromDocument(legacyDocument, "token-heatmap", "colorScheme"), "purple", "the section value must be read");
assert.equal(legacySettingFromDocument(legacyDocument, "token-heatmap", "defaultView"), "month");
assert.equal(legacySettingFromDocument(legacyDocument, "other", "colorScheme"), "rainbow", "another section must not bleed in");
assert.equal(legacySettingFromDocument(legacyDocument, "token-heatmap", "missing"), null, "an absent field reads null");
assert.equal(legacySettingFromDocument("token-heatmap:\n  colorScheme: \"teal\" # keep", "token-heatmap", "colorScheme"), "teal", "quotes and inline comments are tolerated");
assert.equal(legacySettingFromDocument(null, "token-heatmap", "colorScheme"), null, "a missing document reads null");
assert.equal(legacySettingFromDocument("  token-heatmap:\n    colorScheme: purple", "token-heatmap", "colorScheme"), null, "an indented section is not the top-level one");
assert.equal(legacySettingFromDocument("token-heatmap:\n  enabled: true\nother:\n  colorScheme: x", "token-heatmap", "colorScheme"), null, "the scan must stop at the next section");
assert.equal(dshHomeDirectory({ DSH_HOME: "  C:/custom-home  " }), "C:/custom-home", "DSH_HOME wins and is trimmed");
assert.equal(dshHomeDirectory({ DSH_HOME: "   " }), join(homedir(), ".dsh"), "a blank DSH_HOME falls back to the home directory");
assert.equal(dshHomeDirectory({}), join(homedir(), ".dsh"), "without DSH_HOME the home directory is used");

console.log("settings schema contract smoke passed");
