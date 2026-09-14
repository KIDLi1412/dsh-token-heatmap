// Compose the docs card screenshots into README-ready crops.
//
// Input: temp/shot-page.png (whole hero screen), temp/shot-card-a.png and
// temp/shot-card-b.png (the two card states) from scripts/docs-screenshot.mjs.
// Output: temp/preview-{main,month,year}.png. A real browser renders the crops
// (headless Edge/Chrome `--screenshot`), so text keeps proper anti-aliasing;
// convert them to JPEG afterwards, e.g. with ImageMagick or System.Drawing.
//
// The two card states come out in whatever order the live card was in when
// captured; pass THM_VIEW=month to declare that card-a is the month view
// (default: card-a is the year view).
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { existsSync } from "node:fs";

const root = new URL("../", import.meta.url);
const path = (name) => new URL(name, root).pathname.replace(/^\//u, "");
const b64 = (name) => readFileSync(new URL(name, root)).toString("base64");

const monthFirst = (process.env.THM_VIEW ?? "year") === "month";
const monthShot = b64(`temp/shot-card-${monthFirst ? "a" : "b"}.png`);
const yearShot = b64(`temp/shot-card-${monthFirst ? "b" : "a"}.png`);
const settingsShot = b64("temp/shot-settings.png");
const pageShot = b64("temp/shot-page.png");

// Page capture is 1440x800 CSS at deviceScaleFactor 2; the main column starts
// right of the sidebar, so the context crop pans the image to the card.
const main = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:#fff}
.crop{width:1050px;height:600px;overflow:hidden;position:relative}
.crop img{position:absolute;left:-305px;top:-70px;width:1440px;height:800px}
</style></head><body><div class="crop"><img src="data:image/png;base64,${pageShot}"></div></body></html>`;
writeFileSync(new URL("temp/preview-main.html", root), main);

const card = (data) => `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:#fff}img{display:block;width:1300px}</style></head><body><img src="data:image/png;base64,${data}"></body></html>`;
writeFileSync(new URL("temp/preview-month.html", root), card(monthShot));
writeFileSync(new URL("temp/preview-year.html", root), card(yearShot));
writeFileSync(new URL("temp/preview-settings.html", root), card(settingsShot));

const browser = [
	"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
	"C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
	"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
].find(existsSync);
if (browser === undefined) throw new Error("no Edge/Chrome found to render the crops");

const jobs = [
	{ file: "temp/preview-main.html", size: "1050,600", out: "temp/preview-main.png" },
	{ file: "temp/preview-month.html", size: "1300,505", out: "temp/preview-month.png" },
	{ file: "temp/preview-year.html", size: "1300,380", out: "temp/preview-year.png" },
	{ file: "temp/preview-settings.html", size: "1300,760", out: "temp/preview-settings.png" }
];
for (const job of jobs) {
	const result = spawnSync(browser, [
		"--headless=new",
		"--disable-gpu",
		"--hide-scrollbars",
		`--screenshot=${path(job.out)}`,
		`--window-size=${job.size}`,
		new URL(job.file, root).href
	], { stdio: "inherit" });
	if (result.status !== 0) throw new Error(`crop render failed for ${job.out}`);
	console.log(`rendered ${job.out}`);
	await sleep(1000);
}
