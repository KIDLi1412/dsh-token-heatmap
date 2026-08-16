/**
 * Verify the web profile resolves dsh-token-heatmap exactly like the server's
 * client-modules registry does at startup (require.resolve → dsh.client →
 * exports["./client"] → file read → rev). Run from anywhere:
 *
 *   node scripts/verify-install.mjs
 *
 * Exit 0 = the next `dsh web` restart will serve the client bundle.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { homedir } from "node:os";

const profileDir = process.env.DSH_HOME
	? join(process.env.DSH_HOME, "profiles", "web")
	: join(homedir(), ".dsh", "profiles", "web");
const require = createRequire(join(profileDir, "package.json"));

let failures = 0;
const check = (name, ok, detail = "") => {
	console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures += 1;
};

// 1. manifest
const manifest = JSON.parse(readFileSync(join(profileDir, "package.json"), "utf8"));
check("manifest dependency", manifest.dependencies?.["dsh-token-heatmap"] === "link:C:/Projects/DSH/dsh-token-heatmap", manifest.dependencies?.["dsh-token-heatmap"]);
check("in dsh.profile.bundles", (manifest.dsh?.profile?.bundles ?? []).includes("dsh-token-heatmap"));

// 2. server-side resolution chain (mirrors ClientModuleRegistry.resolveMeta)
let pkgPath;
try {
	pkgPath = require.resolve("dsh-token-heatmap/package.json");
	check("require.resolve finds package.json", true, pkgPath);
} catch (error) {
	check("require.resolve finds package.json", false, String(error));
	pkgPath = null;
}
if (pkgPath !== null) {
	const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
	check("package name", pkg.name === "dsh-token-heatmap", pkg.name);
	const client = pkg.dsh?.client;
	check("dsh.client declared", client !== void 0 && client.platform === "web", JSON.stringify(client));
	const clientRel = pkg.exports?.["./client"];
	check("exports[./client] is a string", typeof clientRel === "string", JSON.stringify(clientRel));
	if (typeof clientRel === "string") {
		const clientPath = join(dirname(pkgPath), clientRel);
		let body = null;
		try {
			body = readFileSync(clientPath, "utf8");
			check("client bundle readable", true, `${clientPath} (${body.length} bytes)`);
		} catch (error) {
			check("client bundle readable", false, String(error));
		}
		if (body !== null) {
			check("loader id matches package name", body.includes('id: "dsh-token-heatmap"'));
			check("rev", true, createHash("sha1").update(body).digest("hex").slice(0, 12));
		}
	}
}

// 3. server half loads without throwing (fiber will exist → client entry qualifies)
try {
	await import(pathToFileURL(join(profileDir, "node_modules", "dsh-token-heatmap", "lib", "index.js")).href);
	check("server half imports cleanly", true);
} catch (error) {
	check("server half imports cleanly", false, String(error));
}

console.log(failures === 0 ? "\nINSTALL OK — next restart will serve the bundle" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
