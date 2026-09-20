// bench-save.mjs: where the fast save spends its time. Loads the 44 s fixture, fills in fake words, and runs the
// export under several encoder settings, printing the per-stage timing the page reports. Usage: bun tests/e2e/bench-save.mjs [url]
import { chromium } from "playwright";
import { spawn } from "node:child_process";
const here = new URL(".", import.meta.url).pathname; const clip = here + "../fixtures/speech44.mp4";
let url = process.argv[2]; let server = null;
if (!url) { server = spawn("bun", [here + "../../serve.ts", "8796"], { stdio: "ignore" }); await new Promise((r) => setTimeout(r, 800)); url = "http://localhost:8796/"; }
const VARIANTS = [
  ["default", {}],
  ["realtime", { latencyMode: "realtime" }],
  ["no draw, no paint", { skipDraw: true, skipPaint: true }],
];
const b = await chromium.launch({ headless: true, args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
const p = await b.newPage({ viewport: { width: 430, height: 900 }, acceptDownloads: true });
p.on("download", (d) => d.cancel().catch(() => {}));
await p.goto(url, { waitUntil: "load" });
await p.waitForFunction(() => window.__cap && window.__cap.words && window.__cap.words.length > 0, null, { timeout: 30000 });
await p.setInputFiles("#file", clip);
await p.waitForFunction(() => window.__cap.state === "loaded" && document.getElementById("video").duration > 0, null, { timeout: 20000 });
const dur = await p.evaluate(() => { const w = window.captions.words; w.length = 0; const d = document.getElementById("video").duration; for (let t = 0, i = 0; t < d; t += 0.4, i++) w.push({ text: "word" + i, start: +t.toFixed(2), end: +(t + 0.3).toFixed(2) }); return d; });
// The engine warms itself after page load; let that finish so it does not compete for the CPU during the measurement.
const warm = await p.waitForFunction(() => window.__cap.engineWarm, null, { timeout: 120000 }).then(() => true).catch(() => false);
console.log(`clip ${dur.toFixed(1)} s; engine warm: ${warm}; variants: ${VARIANTS.length}, best of 2`);
for (const [name, opts] of VARIANTS) {
  let best = null;
  for (let i = 0; i < 2; i++) {
    const r = await p.evaluate(async (o) => { window.__cap.fastOpts = o; window.__cap.fastSaveError = undefined; await window.captions.export(); return { ms: Math.round(window.__cap.exportMs), path: window.__cap.exportPath, err: window.__cap.fastSaveError, timing: window.__cap.exportTiming, frames: window.__cap.exportFrames, bytes: window.__cap.exportBytes, codec: window.__cap.exportCodec }; }, opts);
    if (!best || r.ms < best.ms) best = r;
  }
  const r = best; const x = (dur / (r.ms / 1000)).toFixed(2);
  console.log(`${name.padEnd(20)} ${String(r.ms).padStart(6)} ms  ${x}×  ${r.path} ${r.codec ?? ""} ${r.frames ?? ""}f ${r.bytes ? (r.bytes / 1e6).toFixed(1) + "MB" : ""}  ${r.timing ? JSON.stringify(r.timing) : ""}${r.err ? "  ERR " + r.err : ""}`);
}
await b.close(); server?.kill();
