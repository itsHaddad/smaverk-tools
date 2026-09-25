// smoke.mjs: the first gate. Serves dist/, opens it in headless Chromium on a phone-sized screen, and fails on any page
// error, a missing sample, an unversioned script, a heavy download before the visitor has asked for anything, sideways
// scroll, the main button below the first screen, or more words at rest than the studio allows.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
const port = 8826;
const here = new URL(".", import.meta.url).pathname;
const server = spawn("bun", [`${here}../serve.ts`, String(port)], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));
let failed = false;
const fail = (m) => { console.error(`SMOKE FAIL: ${m}`); failed = true; };
try {
  const b = await chromium.launch({ args: ["--no-sandbox"] });
  for (const scheme of ["light", "dark"]) {
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, colorScheme: scheme });
    await ctx.route(/cloudflareinsights\.com/, (r) => (r.request().method() === "GET" ? r.continue() : r.fulfill({ status: 204, body: "" })));
    const p = await ctx.newPage();
    const errs = [];
    p.on("pageerror", (e) => errs.push(e.message));
    p.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|^\[WARNING\]/.test(m.text())) errs.push(`console: ${m.text().slice(0, 160)}`); });
    p.on("response", (r) => { if (r.status() >= 400 && !/cloudflareinsights|unlock\.smaverk|polar\.sh/.test(r.url())) errs.push(`${r.status()} ${r.url()}`); });
    // The tool is about 95 MB the first time: nothing of it may move before the visitor shows intent.
    const early = [];
    p.on("request", (r) => { if (/huggingface\.co|\.onnx|ort-wasm|onnxruntime|mediapipe|\.tflite|finder\.js|listen\.js/.test(r.url())) early.push(r.url().slice(0, 90)); });
    await p.goto(`http://localhost:${port}/`, { waitUntil: "networkidle" });
    await p.waitForTimeout(5000);
    if (early.length) fail(`${scheme}: downloads before any tap: ${early.slice(0, 3).join(" | ")}`);
    const ok = await p.waitForFunction(() => window.__clips?.state === "sample" && window.__clips.moments >= 3, null, { timeout: 15000 }).then(() => true).catch(() => false);
    if (!ok) fail(`${scheme}: the sample did not open: ${JSON.stringify(await p.evaluate(() => window.__clips ?? null))}`);
    const st = await p.evaluate(() => {
      const btn = document.getElementById("action"), r = btn.getBoundingClientRect(), reel = document.getElementById("reel").getBoundingClientRect();
      return {
        action: btn.textContent.trim(), below: Math.round(r.bottom - innerHeight), sideways: document.documentElement.scrollWidth > innerWidth + 1,
        words: (document.body.innerText ?? "").split(/\s+/).filter(Boolean).length, h1: document.querySelectorAll("h1").length,
        disabled: [...document.querySelectorAll("button")].filter((x) => x.disabled && x.offsetParent !== null).length,
        reel: { w: Math.round(reel.width), h: Math.round(reel.height) }, poster: document.getElementById("reel").getAttribute("poster"),
        src: document.getElementById("reel").currentSrc, small: [...document.querySelectorAll("p, li, span, b, button, a, label, summary")].filter((e) => e.offsetParent && e.textContent.trim() && parseFloat(getComputedStyle(e).fontSize) < 15).map((e) => e.textContent.trim().slice(0, 30)),
      };
    });
    if (!/Use my own recording/.test(st.action)) fail(`${scheme}: action label: ${st.action}`);
    if (st.h1 !== 1) fail(`${scheme}: ${st.h1} headlines`);
    if (st.sideways) fail(`${scheme}: page scrolls sideways at 390px`);
    if (st.words > 240) fail(`${scheme}: ${st.words} words at rest (max 240)`);
    if (st.disabled) fail(`${scheme}: ${st.disabled} button(s) disabled at rest`);
    if (st.below > 0) fail(`${scheme}: the main button ends ${st.below} px below the first phone screen`);
    if (st.reel.h < 200) fail(`${scheme}: the finished clip at rest is ${st.reel.w}x${st.reel.h}, too small to see`);
    if (!st.poster || !/sample-1\.mp4/.test(st.src)) fail(`${scheme}: the sample clip is not on the stage at rest (${st.src})`);
    if (st.small.length) fail(`${scheme}: text under 15 px: ${st.small.slice(0, 4).join(" | ")}`);
    console.log(`  ${scheme}: ${st.words} words · main button ${st.below <= 0 ? `${-st.below} px above` : `${st.below} px below`} the fold · stage ${st.reel.w}x${st.reel.h}`);
    if (errs.length) fail(`${scheme}: ${errs.join(" | ")}`);
    if (scheme === "light") {
      const html = await p.content();
      if (!/src="app\.js\?v=\d+"/.test(html)) fail("app.js is not versioned");
      const appjs = await (await fetch(`http://localhost:${port}/app.js`)).text();
      if (!/finder\.js\?v=\d+/.test(appjs) || !/listen\.js\?v=\d+/.test(appjs)) fail("a worker url is not versioned");
      for (const banned of ["FormData", "XMLHttpRequest", "navigator.sendBeacon"]) if (appjs.includes(banned)) fail(`app.js mentions ${banned}`);
      for (const f of ["sample.json", "sample-1.mp4", "sample-2.mp4", "sample-3.mp4", "sample-strip.mp4", "poster.jpg", "llms.txt", "finder.js", "listen.js", "models/blaze_face_short_range.tflite", "fonts/bricolage-grotesque-latin.woff2"]) {
        const r = await fetch(`http://localhost:${port}/${f}`, { method: "HEAD" });
        if (r.status !== 200) fail(`${f} ${r.status}`);
      }
      const sample = await (await fetch(`http://localhost:${port}/sample.json`)).json();
      if (!sample.credit || !sample.url) fail("the sample does not say where it came from");
      for (const m of sample.moments) if (!(m.endS > m.startS) || !m.clip || m.endS - m.startS > 90.5) fail(`a sample moment is wrong: ${JSON.stringify(m).slice(0, 120)}`);
    }
    await ctx.close();
  }
  await b.close();
} catch (e) {
  fail(String(e?.message ?? e));
}
server.kill();
if (failed) process.exit(1);
console.log("smoke ok");
