// probe-long.mjs: on the Kaggle box, run a 5-minute English clip (paid limit) and a 60-second clip (free limit)
// through the live page on WASM: decode, caption, save. Prints timings, word counts, coverage, memory, file sizes.
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
const URL = process.env.CAP_URL ?? "https://captions.smaverk.com/";
const CASES = [{ file: "/kaggle/working/long300.mp4", licensed: true, label: "paid-300s" }, { file: "/kaggle/working/short60.mp4", licensed: false, label: "free-60s" }];
const b = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--autoplay-policy=no-user-gesture-required"] });
const results = [];
for (const c of CASES) {
  const p = await b.newPage({ viewport: { width: 1000, height: 900 }, acceptDownloads: true });
  const errs = []; p.on("pageerror", (e) => errs.push(e.message.slice(0, 200))); p.on("console", (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 200)); });
  const t0 = Date.now(); const T = () => ((Date.now() - t0) / 1000).toFixed(0);
  await p.goto(URL, { waitUntil: "load" });
  await p.waitForFunction(() => window.__cap && window.__cap.words && window.__cap.words.length > 0, null, { timeout: 30000 });
  await p.evaluate((lic) => { window.__cap.setLicensed(lic); }, c.licensed);
  await p.setInputFiles("#file", c.file);
  await p.waitForFunction(() => window.__cap.state === "loaded", null, { timeout: 60000 });
  const dur = await p.evaluate(() => document.getElementById("video").duration);
  console.log(`[${c.label}] loaded duration=${dur.toFixed(1)}s status="${(await p.textContent("#status")).trim().slice(0, 80)}"`);
  const tp = Date.now(); await p.click("#action");
  let last = ""; const poll = setInterval(async () => { try { const s = await p.evaluate(() => [...document.querySelectorAll(".step")].filter((e) => /active/.test(e.className)).map((e) => e.textContent.trim().replace(/\s+/g, " ")).join(" | ")); if (s !== last) { last = s; console.log(`[${c.label}] ${T()}s ${s.slice(0, 100)}`); } } catch {} }, 15000);
  await p.waitForFunction(() => window.__cap.state === "captioned" || window.__cap.error, null, { timeout: 1500000, polling: 2000 }).catch(() => {});
  clearInterval(poll);
  const r = await p.evaluate(() => { const w = window.__cap.words; const mem = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : null; const perMin = {}; for (const x of w) { const m = Math.floor(x.start / 60); perMin[m] = (perMin[m] || 0) + 1; } return { state: window.__cap.state, device: window.__cap.device, decode: window.__cap.decode, engineMs: Math.round(window.__cap.engineMs || 0), inferMs: Math.round(window.__cap.ms || 0), words: w.length, firstWords: w.slice(0, 8).map((x) => x.text).join(" "), lastWordEnd: w.length ? +w[w.length - 1].end.toFixed(1) : null, wordsPerMinute: perMin, heapMB: mem, error: window.__cap.error ?? null, stage: window.__cap.stage ?? null, done: document.getElementById("s3t").textContent }; });
  r.pressToCaptionsS = Math.round((Date.now() - tp) / 1000); r.label = c.label; r.durationS = +dur.toFixed(1);
  console.log(`[${c.label}] captions: ${JSON.stringify(r)}`);
  if (r.state === "captioned") {
    const te = Date.now();
    const [dl] = await Promise.all([p.waitForEvent("download", { timeout: 900000 }), p.click("#action")]).catch((e) => [null]);
    await p.waitForFunction(() => window.__cap.state === "exported" || window.__cap.exportError, null, { timeout: 900000, polling: 2000 }).catch(() => {});
    r.exportS = Math.round((Date.now() - te) / 1000); r.exportBytes = await p.evaluate(() => window.__cap.exportBytes ?? null); r.exportError = await p.evaluate(() => window.__cap.exportError ?? null); r.exportFile = dl ? dl.suggestedFilename() : null; r.result = (await p.textContent("#rline")).trim();
    console.log(`[${c.label}] export: ${r.exportS}s ${r.exportBytes} bytes file=${r.exportFile} err=${r.exportError} "${r.result}"`);
  }
  r.errors = errs.slice(0, 5); results.push(r); await p.close();
}
await b.close();
writeFileSync("/kaggle/working/long-results.json", JSON.stringify(results, null, 2));
console.log("RESULTS " + JSON.stringify(results));
