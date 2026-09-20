// smoke.mjs: the first deploy gate. Serves dist/ locally, opens it in headless Chromium, and fails on
// any page error, a missing sample, an unversioned script, a heavy download before the visitor has asked
// for anything, sideways scroll on a phone, or more words at rest than the studio allows.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
const port = 8816;
const here = new URL(".", import.meta.url).pathname;
const server = spawn("bun", [`${here}../serve.ts`, String(port)], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));
let failed = false;
const fail = (m) => {
  console.error(`SMOKE FAIL: ${m}`);
  failed = true;
};
try {
  const b = await chromium.launch({ args: ["--no-sandbox"] });
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
  // The analytics beacon posts to another host; from localhost the browser refuses the preflight and
  // writes a console error about our own page that is not about our own page. The script itself loads
  // untouched — it carries an integrity check — and only the report it sends is swallowed, which is what
  // Qa.ts does and what keeps review rounds out of the visit numbers.
  await ctx.route(/cloudflareinsights\.com/, (r) => (r.request().method() === "GET" ? r.continue() : r.fulfill({ status: 204, body: "" })));
  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  p.on("console", (m) => { if (m.type() === "error") errs.push(`console: ${m.text().slice(0, 160)}`); });
  p.on("response", (r) => { if (r.status() >= 400 && !/cloudflareinsights|unlock\.smaverk|polar\.sh/.test(r.url())) errs.push(`${r.status()} ${r.url()}`); });
  // Nothing heavy downloads before the visitor shows intent: 64 MB for someone who only looked is theft
  // of their data allowance (learned on Vertical, 2026-09-19).
  const early = [];
  p.on("request", (r) => { if (/huggingface\.co|\.onnx|ort-wasm|onnxruntime/.test(r.url())) early.push(r.url().slice(0, 90)); });

  await p.goto(`http://localhost:${port}/`, { waitUntil: "networkidle" });
  await p.waitForTimeout(6000);
  if (early.length) fail(`downloads before any tap: ${early.slice(0, 3).join(" | ")}`);
  p.removeAllListeners("request");

  const ok = await p
    .waitForFunction(() => window.__cf && window.__cf.state === "sample" && window.__cf.moments >= 3, null, { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  if (!ok) fail(`the sample did not open: ${JSON.stringify(await p.evaluate(() => window.__cf ?? null))}`);

  const st = await p.evaluate(() => {
    const btn = document.querySelector(".btn.primary");
    const r = btn.getBoundingClientRect();
    const map = document.getElementById("map").getBoundingClientRect();
    return {
      action: btn.textContent.trim(),
      buy: document.getElementById("buy")?.getAttribute("href"),
      below: Math.round(r.bottom - innerHeight),
      sideways: document.documentElement.scrollWidth > innerWidth + 1,
      words: (document.body.innerText ?? "").split(/\s+/).filter(Boolean).length,
      h1: document.querySelectorAll("h1").length,
      disabled: [...document.querySelectorAll("button")].filter((x) => x.disabled && x.offsetParent !== null).length,
      selects: document.querySelectorAll("select").length,
      map: { w: Math.round(map.width), h: Math.round(map.height) },
      moments: window.__cf.moments,
      reasons: (window.__cf.list ?? []).every((m) => m.why.length > 0),
      ordered: (window.__cf.list ?? []).every((m) => m.endS > m.startS),
    };
  });
  if (!/Use my own recording/.test(st.action)) fail(`action label: ${st.action}`);
  if (st.h1 !== 1) fail(`${st.h1} headlines`);
  if (st.sideways) fail("page scrolls sideways at 390px");
  if (st.words > 240) fail(`${st.words} words at rest (max 240)`);
  if (st.disabled) fail(`${st.disabled} button(s) disabled at rest`);
  if (st.selects) fail(`${st.selects} native dropdown(s)`);
  if (st.map.h < 120 || st.map.w < 120) fail(`the recording map is ${st.map.w}x${st.map.h}, too small to count as the picture`);
  if (!st.reasons) fail("a moment came with no reason");
  if (!st.ordered) fail("a moment ends before it starts");
  if (st.below > 0) fail(`the main button ends ${st.below} px below the first phone screen`);
  console.log(`  rest: ${st.words} words · ${st.moments} moments · main button ${st.below <= 0 ? `${-st.below} px above` : `${st.below} px below`} the fold`);

  const html = await p.content();
  if (!/src="app\.js\?v=\d+"/.test(html)) fail("app.js is not versioned");
  const appjs = await (await fetch(`http://localhost:${port}/app.js`)).text();
  if (!/worker\.js\?v=\d+/.test(appjs)) fail("the worker url is not versioned");
  // The page must never have a way to send the recording anywhere. Anything that could is a bug in the promise.
  for (const banned of ["FormData", "XMLHttpRequest", "navigator.sendBeacon"]) if (appjs.includes(banned)) fail(`app.js mentions ${banned}`);

  for (const f of ["sample.json", "sample.m4a", "llms.txt", "fonts/bricolage-grotesque-latin.woff2"]) {
    const r = await fetch(`http://localhost:${port}/${f}`, { method: "HEAD" });
    if (r.status !== 200) fail(`${f} ${r.status}`);
  }
  const sample = await (await fetch(`http://localhost:${port}/sample.json`)).json();
  if (!sample.credit || !sample.url) fail("the sample does not say where it came from");
  for (const [target, set] of Object.entries(sample.sets)) {
    if (!set.length) fail(`the sample has no moments at ${target}s`);
    for (const m of set) if (!(m.clipEndS > m.clipStartS)) fail(`a sample moment has no excerpt at ${target}s`);
  }

  // Dark mode is a state, not a nicety: it has to survive the same checks.
  const dctx = await b.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "dark" });
  await dctx.route(/cloudflareinsights\.com/, (r) => (r.request().method() === "GET" ? r.continue() : r.fulfill({ status: 204, body: "" })));
  const d = await dctx.newPage();
  const derrs = [];
  d.on("pageerror", (e) => derrs.push(e.message));
  await d.goto(`http://localhost:${port}/`, { waitUntil: "networkidle" });
  await d.waitForFunction(() => window.__cf?.moments >= 3, null, { timeout: 15000 }).catch(() => fail("the sample did not open in dark mode"));
  if (await d.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) fail("dark mode scrolls sideways at 390px");
  if (derrs.length) fail(`dark mode: ${derrs.join(" | ")}`);
  await d.close();

  if (errs.length) fail(errs.join(" | "));
  await b.close();
} catch (e) {
  fail(String(e?.message ?? e));
}
server.kill();
if (failed) process.exit(1);
console.log("smoke ok");
