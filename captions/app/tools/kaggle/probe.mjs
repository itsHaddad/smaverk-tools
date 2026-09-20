// probe.mjs: run the live captions page in headless Chromium on the Kaggle box, once with WebGPU flags and once
// without (pure WASM), and print engine/inference timings, device, words, and the GPU adapter seen by the page.
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
const URL = process.env.CAP_URL ?? "https://captions.smaverk.com/";
const CLIP = process.env.CAP_CLIP ?? "/kaggle/working/sample.mp4";
async function run(label, args) {
  const b = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", ...args] });
  const p = await b.newPage({ viewport: { width: 1000, height: 900 } });
  const errs = []; p.on("pageerror", (e) => errs.push(e.message.slice(0, 160))); p.on("console", (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 160)); });
  const t0 = Date.now(); const T = () => ((Date.now() - t0) / 1000).toFixed(1);
  await p.goto(URL, { waitUntil: "load" });
  const gpu = await p.evaluate(async () => { try { const a = await navigator.gpu?.requestAdapter(); if (!a) return "no adapter"; const i = a.info ?? (await a.requestAdapterInfo?.()) ?? {}; return `${i.vendor ?? "?"} ${i.architecture ?? ""} ${i.device ?? ""} ${i.description ?? ""}`.trim(); } catch (e) { return "error " + e.message; } });
  const cores = await p.evaluate(() => navigator.hardwareConcurrency);
  console.log(`[${label}] gpu adapter: ${gpu} | cores: ${cores} | isolated: ${await p.evaluate(() => crossOriginIsolated)}`);
  const out = { label, gpu, cores, runs: [] };
  for (let i = 0; i < 2; i++) {
    await p.setInputFiles("#file", CLIP);
    await p.waitForFunction(() => window.__cap.state === "loaded", null, { timeout: 30000 });
    const tp = Date.now(); await p.click("#action");
    let last = ""; const poll = setInterval(async () => { try { const s = await p.evaluate(() => [...document.querySelectorAll(".step")].map((e) => e.className.replace("step", "").trim() + ":" + e.textContent.trim().replace(/\s+/g, " ")).join(" | ")); if (s !== last) { last = s; console.log(`[${label}] ${T()}s ${s.slice(0, 120)}`); } } catch {} }, 3000);
    await p.waitForFunction(() => window.__cap.state === "captioned" || window.__cap.error, null, { timeout: 900000, polling: 1000 }).catch(() => {});
    clearInterval(poll);
    const r = await p.evaluate(() => ({ state: window.__cap.state, device: window.__cap.device, model: window.__cap.model, engineMs: Math.round(window.__cap.engineMs || 0), inferMs: Math.round(window.__cap.ms || 0), words: window.__cap.words.length, first: window.__cap.words.slice(0, 6).map((w) => w.text).join(" "), error: window.__cap.error ?? null, stage: window.__cap.stage ?? null, decode: window.__cap.decode ?? null }));
    r.pressToCaptionsMs = Date.now() - tp; out.runs.push(r);
    console.log(`[${label}] run ${i + 1}: ${JSON.stringify(r)}`);
    if (r.state !== "captioned") break;
    await p.evaluate(() => window.captions && window.captions.style("bar"));
  }
  out.errors = errs.slice(0, 6); console.log(`[${label}] errors: ${out.errors.join(" || ") || "none"}`);
  await b.close(); return out;
}
const results = [];
results.push(await run("webgpu", ["--enable-unsafe-webgpu", "--enable-features=Vulkan,UseSkiaRenderer", "--use-angle=vulkan", "--ignore-gpu-blocklist", "--use-vulkan=native", "--enable-gpu-rasterization"]));
results.push(await run("wasm", ["--disable-gpu"]));
writeFileSync("/kaggle/working/probe-results.json", JSON.stringify(results, null, 2));
console.log("RESULTS " + JSON.stringify(results.map((r) => ({ label: r.label, gpu: r.gpu, runs: r.runs.map((x) => ({ device: x.device, engineMs: x.engineMs, inferMs: x.inferMs, words: x.words, error: x.error })) }))));
