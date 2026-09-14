// Contract smoke for the Host-side settings namespace + schema: imports the
// real lib/index.js and verifies the schemastery schema behaves exactly as
// the settings service relies on (`schema(mergedSection)`): an empty user
// section resolves through the defaults, malformed writes are rejected, and
// an unknown-but-well-formed scheme survives (the client renders it with its
// green fallback, mirroring the legacy parseConfig leniency).
import assert from "node:assert/strict";
import { SETTINGS_NAMESPACE, TokenHeatmapSettingsSchema } from "../lib/index.js";

// Namespace branding: the exact string the client card keys on.
assert.equal(typeof SETTINGS_NAMESPACE, "string");
assert.equal(SETTINGS_NAMESPACE, "token-heatmap", "namespace must be token-heatmap");

// Empty section → schema defaults.
assert.deepEqual(TokenHeatmapSettingsSchema({}), { colorScheme: "green", defaultView: "year" });

// Explicit values pass through.
assert.deepEqual(TokenHeatmapSettingsSchema({ colorScheme: "blue", defaultView: "month" }), { colorScheme: "blue", defaultView: "month" });

// The 0.1.x display switch is not part of the schema any more. Schemastery
// passes an undeclared key through untouched, so a stale `enabled` survives in
// the resolved section — which is fine: nothing reads it (serveConfig reports a
// constant true, and the client no longer gates on it).
assert.deepEqual(TokenHeatmapSettingsSchema({ enabled: false }), { enabled: false, colorScheme: "green", defaultView: "year" }, "retired enabled is inert");
assert.equal(TokenHeatmapSettingsSchema({ enabled: false }).colorScheme, "green", "retired enabled must not affect the resolved defaults");

// Blank scheme is rejected (min length 1).
assert.throws(() => TokenHeatmapSettingsSchema({ colorScheme: "" }), /colorScheme/, "blank scheme must throw");

// Overlong scheme is rejected (max length 32, matching parseConfig).
assert.throws(() => TokenHeatmapSettingsSchema({ colorScheme: "x".repeat(40) }), /colorScheme/, "overlong scheme must throw");

// Unknown-but-well-formed scheme is preserved verbatim, so a newer client's
// palette survives (the client falls back to green while rendering).
const resolved = TokenHeatmapSettingsSchema({ colorScheme: "rainbow" });
assert.deepEqual(resolved, { colorScheme: "rainbow", defaultView: "year" }, "unknown scheme must be preserved");

// The view mode IS enumerated (unlike the scheme): an unknown mode has no
// renderer to fall back to in the client, so the Host refuses the write.
assert.throws(() => TokenHeatmapSettingsSchema({ defaultView: "week" }), /defaultView/, "unknown view mode must throw");
assert.equal(TokenHeatmapSettingsSchema({ defaultView: "month" }).defaultView, "month");
assert.equal(TokenHeatmapSettingsSchema({}).defaultView, "year", "view default must be year");

console.log("settings schema contract smoke passed");
