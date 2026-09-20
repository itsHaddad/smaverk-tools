// smoke.mjs: the deploy gate. Serves dist/ locally, opens it in headless Chromium, and fails on any page error,
// a missing sample, or a broken script/worker URL. Runs before every deploy (see deploy.sh).
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
const port = 8793; const here = new URL(".", import.meta.url).pathname;
const server = spawn("bun", [here + "../serve.ts", String(port)], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));
let failed = false; const fail = (m) => { console.error("SMOKE FAIL: " + m); failed = true; };
try {
  const b = await chromium.launch({ args: ["--no-sandbox"] }); const p = await b.newPage({ viewport: { width: 390, height: 844 } });
  const errs = []; p.on("pageerror", (e) => errs.push(e.message)); p.on("response", (r) => { if (r.status() >= 400 && !/cloudflareinsights|unlock\.smaverk/.test(r.url())) errs.push(`${r.status()} ${r.url()}`); });
  // Nothing heavy downloads before the visitor shows intent (2026-09-19: a timed warm-up pulled 46 MB for visitors who only looked).
  const early = []; p.on("request", (r) => { if (/hf\.co|huggingface|jsdelivr|\.onnx|ort-wasm|\.wasm/.test(r.url())) early.push(r.url().slice(0, 90)); });
  await p.goto(`http://localhost:${port}/`, { waitUntil: "networkidle" });
  await p.waitForTimeout(6000); if (early.length) fail("downloads before any tap: " + early.slice(0, 3).join(" | ")); p.removeAllListeners("request");
  const ok = await p.waitForFunction(() => window.__cap && window.__cap.words && window.__cap.words.length > 0, null, { timeout: 15000 }).then(() => true).catch(() => false);
  if (!ok) fail("sample words did not load");
  const st = await p.evaluate(() => ({ state: window.__cap?.state, action: document.getElementById("action")?.textContent, buy: document.getElementById("buy")?.href, workerOk: typeof Worker }));
  if (st.state !== "sample") fail("state is " + st.state); if (!/Use my own clip/.test(st.action ?? "")) fail("action label " + st.action); if (!/polar\.sh/.test(st.buy ?? "")) fail("buy link " + st.buy);
  const html = await p.content(); const m = html.match(/src="app\.js\?v=(\d+)"/); if (!m) fail("app.js is not versioned");
  const js = await (await fetch(`http://localhost:${port}/app.js`)).text(); if (!/worker\.js\?v=\d+/.test(js)) fail("worker.js is not versioned");
  const w = await fetch(`http://localhost:${port}/worker.js`); if (w.status !== 200) fail("worker.js " + w.status);
  const sideways = await p.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1); if (sideways) fail("page scrolls sideways at 390px");
  // the studio page (served at smaverk.com by functions/_middleware.js) must load clean too
  const s2 = await b.newPage({ viewport: { width: 390, height: 844 } }); const errs2 = []; s2.on("pageerror", (e) => errs2.push(e.message));
  await s2.goto(`http://localhost:${port}/studio.html`, { waitUntil: "load" });
  const st2 = await s2.evaluate(() => ({ h1: document.querySelector("h1")?.textContent, tools: document.querySelectorAll(".tool").length, captions: document.querySelector(".tool .btn")?.getAttribute("href"), sideways: document.documentElement.scrollWidth > innerWidth + 1 }));
  if (!/your device/.test(st2.h1 ?? "")) fail("studio h1 " + st2.h1); if (st2.tools < 2) fail("studio tools " + st2.tools); if (!/captions\.smaverk\.com/.test(st2.captions ?? "")) fail("studio captions link " + st2.captions); if (st2.sideways) fail("studio scrolls sideways"); if (errs2.length) fail("studio: " + errs2.join(" | "));
  // Studio design review 3, 2026-09-19: the Captions card's words belong to the clip, not to the card. Every line of the sample, at a phone
  // width and a desktop width, stays inside the picture (it may wrap to two rows there, it may not hang off the sides).
  for (const width of [390, 1280]) { await s2.setViewportSize({ width, height: 844 }); await s2.waitForTimeout(150);
    const out = await s2.evaluate(async () => { const box = document.querySelector('.demo[data-demo="captions"]'), v = box.querySelector("video").getBoundingClientRect(), cap = box.querySelector(".cap");
      const w = await (await fetch("sample-words.json")).json(); const lines = []; let cur = []; for (const x of w) { cur.push(x.text); if (x.br) { lines.push(cur.join(" ")); cur = []; } } if (cur.length) lines.push(cur.join(" "));
      const bad = []; for (const line of lines) { cap.textContent = line; const r = document.createRange(); r.selectNodeContents(cap); const g = r.getBoundingClientRect(); if (g.left < v.left - 0.5 || g.right > v.right + 0.5 || g.bottom > v.bottom) bad.push(line + " (" + Math.round(g.left - v.left) + " / " + Math.round(v.right - g.right) + " px)"); }
      return { lines: lines.length, bad }; });
    if (!out.lines) fail("studio: no caption lines to check at " + width + " px"); if (out.bad.length) fail("studio: caption hangs outside the clip at " + width + " px: " + out.bad.join("; ")); }
  // The search pages (tools/pages.ts): each is the same tool at the same address depth, opened in its own look, and each
  // must arrive as the home page does — sample playing, main button on the first screen, nothing missing, nothing 4xx.
  const pageDefs = readdirSync(here + "../pages").filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(here + "../pages/" + f, "utf8")));
  if (!pageDefs.length) fail("no search pages to check");
  for (const def of pageDefs) {
    const sp = await b.newPage({ viewport: { width: 390, height: 844 } }); const e = [];
    sp.on("pageerror", (x) => e.push(x.message));
    sp.on("response", (r) => { if (r.status() >= 400 && !/cloudflareinsights|unlock\.smaverk/.test(r.url())) e.push(`${r.status()} ${r.url()}`); });
    const res = await sp.goto(`http://localhost:${port}/${def.slug}`, { waitUntil: "networkidle" }); // no .html: the address a visitor gets
    if (res.status() !== 200) fail(`${def.slug}: ${res.status()}`);
    const ready = await sp.waitForFunction(() => window.__cap?.state === "sample" && window.__cap?.words?.length > 0, null, { timeout: 15000 }).then(() => true).catch(() => false);
    if (!ready) fail(`${def.slug}: the sample did not open`);
    const st = await sp.evaluate(() => { const btn = document.querySelector(".btn.primary"), r = btn.getBoundingClientRect();
      return { state: window.__cap?.state, pressed: [...document.querySelectorAll(".chip")].filter((c) => c.getAttribute("aria-pressed") === "true").map((c) => c.dataset.style),
        below: Math.round(r.bottom - innerHeight), sideways: document.documentElement.scrollWidth > innerWidth + 1,
        words: (document.body.innerText ?? "").split(/\s+/).filter(Boolean).length, h1: document.querySelectorAll("h1").length, title: document.title }; });
    if (st.state !== "sample") fail(`${def.slug}: state is ${st.state}`);
    if (st.h1 !== 1) fail(`${def.slug}: ${st.h1} headlines`);
    if (st.below > 0) fail(`${def.slug}: the main button ends ${st.below} px below the first screen`);
    if (st.sideways) fail(`${def.slug}: scrolls sideways at 390px`);
    if (st.words > 240) fail(`${def.slug}: ${st.words} words at rest (max 240)`);
    if (def.style && String(st.pressed) !== def.style) fail(`${def.slug}: opens on "${st.pressed}", not "${def.style}"`);
    if (e.length) fail(`${def.slug}: ${e.join(" | ")}`);
    console.log(`  ${def.slug}: ${st.words} words at rest, opens on ${st.pressed} — ${st.title}`);
    await sp.close();
  }
  if (errs.length) fail(errs.join(" | "));
  await b.close();
} catch (e) { fail(String(e?.message ?? e)); }
server.kill();
if (failed) process.exit(1); console.log("smoke ok");
