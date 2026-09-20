// bench-after-run.mjs: does a captioning run leave something behind that slows the save? Exports the 44 s fixture
// (fake words) with the engine merely warm, then runs a real captioning, exports again, waits, exports once more.
// Usage: bun tests/e2e/bench-after-run.mjs [url]
import { chromium } from "playwright";
import { spawn } from "node:child_process";
const here = new URL(".", import.meta.url).pathname; const clip = here + "../fixtures/speech44.mp4";
let url = process.argv[2]; let server = null;
if (!url) { server = spawn("bun", [here + "../../serve.ts", "8798"], { stdio: "ignore" }); await new Promise((r) => setTimeout(r, 800)); url = "http://localhost:8798/"; }
const b = await chromium.launch({ headless: true, args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
const p = await b.newPage({ viewport: { width: 430, height: 900 }, acceptDownloads: true });
p.on("download", (d) => d.cancel().catch(() => {}));
await p.goto(url, { waitUntil: "load" });
await p.waitForFunction(() => window.__cap && window.__cap.words && window.__cap.words.length > 0, null, { timeout: 30000 });
await p.setInputFiles("#file", clip);
await p.waitForFunction(() => window.__cap.state === "loaded" && document.getElementById("video").duration > 0, null, { timeout: 20000 });
const dur = await p.evaluate(() => document.getElementById("video").duration);
const warm = await p.waitForFunction(() => window.__cap.engineWarm, null, { timeout: 120000 }).then(() => true).catch(() => false);
const fakeWords = () => p.evaluate(() => { const w = window.captions.words; w.length = 0; const d = document.getElementById("video").duration; for (let t = 0, i = 0; t < d; t += 0.4, i++) w.push({ text: "word" + i, start: +t.toFixed(2), end: +(t + 0.3).toFixed(2) }); });
const doExport = async (label) => {
  const r = await p.evaluate(async () => { window.__cap.fastOpts = { minSpeed: 0 }; window.__cap.fastSaveError = undefined; await window.captions.export(); return { ms: Math.round(window.__cap.exportMs), path: window.__cap.exportPath, err: window.__cap.fastSaveError, timing: window.__cap.exportTiming, frames: window.__cap.exportFrames }; });
  console.log(`${label.padEnd(28)} ${String(r.ms).padStart(6)} ms  ${(dur / (r.ms / 1000)).toFixed(2)}×  ${r.path} ${r.frames ?? ""}f  ${JSON.stringify(r.timing)}${r.err ? "  ERR " + r.err : ""}`);
};
console.log(`clip ${dur.toFixed(1)} s; engine warm: ${warm}`);
await fakeWords(); await doExport("1 warm engine, no run");
const t0 = Date.now();
await p.evaluate(() => window.captions.run());
await p.waitForFunction(() => window.__cap.state === "captioned" || window.__cap.error, null, { timeout: 600000, polling: 500 });
console.log(`captioning took ${((Date.now() - t0) / 1000).toFixed(1)} s, ${await p.evaluate(() => window.__cap.words.length)} words, device ${await p.evaluate(() => window.__cap.device)}`);
await doExport("2 right after captioning");
await p.waitForTimeout(20000);
await doExport("3 twenty seconds later");
await p.evaluate(() => { document.getElementById("video").pause(); });
await doExport("4 video paused, again");
await b.close(); server?.kill();
