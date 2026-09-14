// Regenerate the README card screenshots from the RUNNING dsh web GUI.
//
// The GUI gates on a signed browser-session cookie, so a driven browser needs
// one: scripts/docs-screenshot-auth.mjs mints it from the local credential
// store (no token ever leaves the machine), and this script injects it as a
// request header while driving Chrome over CDP.
//
// One-time prep:
//   1. copy the new bundle into the installed profile (the server serves the
//      client half from there; its HMR watch re-hashes within ~1s):
//        Copy-Item lib/client.js "$env:USERPROFILE\.dsh\profiles\web\node_modules\@kidli1412\dsh-token-heatmap\lib\client.js" -Force
//   2. launch a disposable browser with a debugging port:
//        & "C:\Program Files\Google\Chrome\Application\chrome.exe" --headless=new `
//          --remote-debugging-port=9222 --user-data-dir=<temp>\chrome-profile `
//          --window-size=1440,800 --lang=zh-CN about:blank
//
// Then:
//   $env:NO_PROXY="127.0.0.1,localhost"
//   $env:THM_COOKIE = (node scripts/docs-screenshot-auth.mjs).Trim()
//   node scripts/docs-screenshot.mjs
//
// Outputs temp/shot-card-a.png (view as loaded), temp/shot-card-b.png (after
// flipping 年/月) and temp/shot-page.png (whole hero screen), which
// temp/make-docs-images.mjs crops into docs/*.jpg. All temp/ artifacts are
// gitignored.
import { writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = Number(process.env.THM_CDP_PORT ?? 9222);
const BASE = process.env.THM_BASE ?? "http://127.0.0.1:3080";
const cookie = process.env.THM_COOKIE ?? "";
if (cookie === "") throw new Error("THM_COOKIE is required (see scripts/docs-screenshot-auth.mjs)");

async function target() {
	for (let attempt = 0; attempt < 40; attempt += 1) {
		try {
			const list = await fetch(`http://127.0.0.1:${String(PORT)}/json/list`);
			const pages = await list.json();
			const page = pages.find((entry) => entry.type === "page");
			if (page !== undefined) return page;
		} catch { /* not up yet */ }
		await sleep(500);
	}
	throw new Error("CDP endpoint never came up");
}

const page = await target();
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
	socket.addEventListener("open", resolve, { once: true });
	socket.addEventListener("error", reject, { once: true });
});

let nextId = 0;
const pending = new Map();
socket.addEventListener("message", (event) => {
	const message = JSON.parse(typeof event.data === "string" ? event.data : event.data.toString());
	if (message.id === undefined) return;
	const entry = pending.get(message.id);
	if (entry === undefined) return;
	pending.delete(message.id);
	if (message.error !== undefined) entry.reject(new Error(`${entry.method}: ${JSON.stringify(message.error)}`));
	else entry.resolve(message.result);
});

function send(method, params = {}) {
	const id = (nextId += 1);
	return new Promise((resolve, reject) => {
		pending.set(id, { resolve, reject, method });
		socket.send(JSON.stringify({ id, method, params }));
	});
}

async function evaluate(expression) {
	const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
	if (result.exceptionDetails !== undefined) throw new Error(JSON.stringify(result.exceptionDetails));
	return result.result.value;
}

async function waitFor(expression, label, timeoutMs = 45000) {
	const started = Date.now();
	for (;;) {
		if (await evaluate(expression) === true) return;
		if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${label}`);
		await sleep(400);
	}
}

await send("Page.enable");
await send("Runtime.enable");
await send("Network.enable");
await send("Network.setExtraHTTPHeaders", { headers: { "accept-language": "zh-CN,zh;q=0.9", cookie } });
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 800, deviceScaleFactor: 2, mobile: false });
await send("Page.navigate", { url: `${BASE}/` });
await waitFor("document.readyState === 'complete'", "document load");
await waitFor("document.querySelector('.thm_card') !== null", "heatmap card");
await sleep(1200);

async function capture(name, label) {
	const clip = await evaluate(`(() => {
		const card = document.querySelector('.thm_card');
		const dock = card.closest('.thm_dock') ?? card;
		const r = dock.getBoundingClientRect();
		const x = Math.max(0, r.x - 6);
		return { x, y: Math.max(0, r.y - 6), width: Math.min(1440 - x, r.width + 12), height: r.height + 12 };
	})()`);
	const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { ...clip, scale: 2 } });
	writeFileSync(new URL(`../temp/shot-${name}.png`, import.meta.url), Buffer.from(shot.data, "base64"));
	console.log(`captured ${label} → temp/shot-${name}.png`);
}

await capture("card-a", "view as loaded");

// Flip the 年/月 toggle so both card states are captured. The segmented buttons
// carry aria-pressed, so click whichever mode is currently inactive.
const flipped = await evaluate(`(() => {
	const buttons = [...document.querySelectorAll('.thm_viewBtn')];
	const pressed = buttons.filter((button) => button.getAttribute('aria-pressed') === 'true');
	const target = buttons.find((button) => button.getAttribute('aria-pressed') === 'false');
	if (pressed.length !== 1 || target === undefined) return 'unusable';
	const from = pressed[0].textContent;
	target.click();
	return from;
})()`);
if (flipped === "unusable") throw new Error("年/月 toggle not found");
await sleep(800);
await capture("card-b", `other view (was ${flipped})`);

// Third state: the in-card ⚙ settings panel open (palette + default view).
const opened = await evaluate(`(() => {
	const gear = document.querySelector('.thm_gear');
	if (gear === null) return false;
	if (gear.getAttribute('aria-expanded') !== 'true') gear.click();
	return true;
})()`);
if (opened === true) {
	await sleep(700);
	await capture("settings", "settings panel");
} else {
	console.log("no ⚙ gear found; skipped the settings panel shot");
}

// Collapse the settings panel again so the context shot shows the card in its
// resting state (the dedicated panel shot above already covers it).
await evaluate(`(() => {
	const gear = document.querySelector('.thm_gear');
	if (gear !== null && gear.getAttribute('aria-expanded') === 'true') gear.click();
	return true;
})()`);
await sleep(500);
const full = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(new URL("../temp/shot-page.png", import.meta.url), Buffer.from(full.data, "base64"));
console.log("captured page → temp/shot-page.png");
socket.close();
