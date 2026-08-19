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
assert.deepEqual(TokenHeatmapSettingsSchema({}), { enabled: true, colorScheme: "green" });

// Explicit values pass through.
assert.deepEqual(TokenHeatmapSettingsSchema({ enabled: false, colorScheme: "blue" }), { enabled: false, colorScheme: "blue" });

// Non-boolean enabled is rejected → the Host refuses the write.
assert.throws(() => TokenHeatmapSettingsSchema({ enabled: "yes" }), /enabled/, "non-boolean enabled must throw");

// Blank scheme is rejected (min length 1).
assert.throws(() => TokenHeatmapSettingsSchema({ colorScheme: "" }), /colorScheme/, "blank scheme must throw");

// Overlong scheme is rejected (max length 32, matching parseConfig).
assert.throws(() => TokenHeatmapSettingsSchema({ colorScheme: "x".repeat(40) }), /colorScheme/, "overlong scheme must throw");

// Unknown-but-well-formed scheme is preserved verbatim, so a newer client's
// palette survives (the client falls back to green while rendering).
const resolved = TokenHeatmapSettingsSchema({ colorScheme: "rainbow" });
assert.deepEqual(resolved, { enabled: true, colorScheme: "rainbow" }, "unknown scheme must be preserved");

console.log("settings schema contract smoke passed");
