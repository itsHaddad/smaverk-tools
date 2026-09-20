// sample-track.mjs: compute the track for dist/sample.mp4 with the real tracker in headless Chromium and write
// dist/sample-track.json, so the page shows the moving window at rest without running the tracker. Usage: bun tools/sample-track.mjs
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const here = new URL(".", import.meta.url).pathname;
const server = spawn("bun", [here + "../serve.ts", "8803"], { stdio: "ignore" }); await new Promise((r) => setTimeout(r, 800));
const b = await chromium.launch({ headless: true, args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
const p = await b.newPage(); await p.goto("http://localhost:8803/", { waitUntil: "load" });
await p.waitForFunction(() => window.__vert && window.__vert.state === "sample", null, { timeout: 30000 });
await p.evaluate(async () => { const r = await fetch("sample.mp4"); const f = new File([await r.blob()], "sample.mp4", { type: "video/mp4" }); window.vertical.load(f); });
await p.waitForFunction(() => window.__vert.state === "loaded" && document.getElementById("video").duration > 0, null, { timeout: 20000 });
await p.evaluate(() => window.vertical.run());
await p.waitForFunction(() => window.__vert.state === "ready" || window.__vert.error, null, { timeout: 300000, polling: 300 });
const r = await p.evaluate(() => ({ error: window.__vert.error, found: window.__vert.found, track: window.__vert.track }));
if (r.error || !r.track?.length) { console.error("tracking failed", r.error); process.exit(1); }
writeFileSync(here + "../dist/sample-track.json", JSON.stringify(r.track));
console.log(`sample track: ${r.track.length} points, face found in ${Math.round(r.found * 100)}% of samples`);
await b.close(); server.kill();
