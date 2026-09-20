// smoke.mjs: the deploy gate. Serves dist/ locally, opens it in headless Chromium, and fails on any page error,
// a missing sample track, a broken script URL, an unfilled Polar link, or sideways scroll on a phone.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
const port = 8806; const here = new URL(".", import.meta.url).pathname;
const server = spawn("bun", [here + "../serve.ts", String(port)], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));
let failed = false; const fail = (m) => { console.error("SMOKE FAIL: " + m); failed = true; };
try {
  const b = await chromium.launch({ args: ["--no-sandbox"] }); const p = await b.newPage({ viewport: { width: 390, height: 844 } });
  const errs = []; p.on("pageerror", (e) => errs.push(e.message)); p.on("response", (r) => { if (r.status() >= 400 && !/cloudflareinsights|unlock\.smaverk/.test(r.url())) errs.push(`${r.status()} ${r.url()}`); });
  // Nothing heavy downloads before the visitor shows intent (2026-09-19: a timed warm-up pulled 46 MB for visitors who only looked).
  const early = []; p.on("request", (r) => { if (/mediapipe\/|\/models\/|\.tflite|\.wasm/.test(r.url())) early.push(r.url().slice(0, 90)); });
  await p.goto(`http://localhost:${port}/`, { waitUntil: "networkidle" });
  await p.waitForTimeout(6000); if (early.length) fail("downloads before any tap: " + early.slice(0, 3).join(" | ")); p.removeAllListeners("request");
  const ok = await p.waitForFunction(() => window.__vert && window.__vert.state === "sample" && window.__vert.track && window.__vert.track.length > 10, null, { timeout: 15000 }).then(() => true).catch(() => false);
  if (!ok) fail("sample track did not load");
  const st = await p.evaluate(() => ({ action: document.getElementById("action")?.textContent, buy: document.getElementById("buy")?.href, out: window.__vert?.out }));
  if (!/Use my own clip/.test(st.action ?? "")) fail("action label " + st.action); if (!/polar\.sh/.test(st.buy ?? "")) fail("buy link " + st.buy); if (!st.out || st.out.height < 360 || Math.abs(st.out.width / st.out.height - 9 / 16) > 0.02 /* the sample output is 9:16 whatever the sample's size */) fail("sample output " + JSON.stringify(st.out));
  const html = await p.content(); if (!/src="app\.js\?v=\d+"/.test(html)) fail("app.js is not versioned");
  for (const f of ["mediapipe/vision_wasm_internal.wasm", "models/blaze_face_short_range.tflite", "sample.mp4", "poster.jpg", "llms.txt"]) { const r = await fetch(`http://localhost:${port}/${f}`, { method: "HEAD" }); if (r.status !== 200) fail(`${f} ${r.status}`); }
  const sideways = await p.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1); if (sideways) fail("page scrolls sideways at 390px");
  // The search pages (tools/pages.ts): each is the same tool at the same address depth, and each must arrive as the home
  // page does — sample playing, main button on the first screen, nothing missing, nothing 4xx.
  const pageDefs = readdirSync(here + "../pages").filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(here + "../pages/" + f, "utf8")));
  if (!pageDefs.length) fail("no search pages to check");
  for (const def of pageDefs) {
    const sp = await b.newPage({ viewport: { width: 390, height: 844 } }); const e = [];
    sp.on("pageerror", (x) => e.push(x.message));
    sp.on("response", (r) => { if (r.status() >= 400 && !/cloudflareinsights|unlock\.smaverk/.test(r.url())) e.push(`${r.status()} ${r.url()}`); });
    const res = await sp.goto(`http://localhost:${port}/${def.slug}`, { waitUntil: "networkidle" }); // no .html: the address a visitor gets
    if (res.status() !== 200) fail(`${def.slug}: ${res.status()}`);
    const ready = await sp.waitForFunction(() => window.__vert?.state === "sample" && window.__vert?.track?.length > 10, null, { timeout: 15000 }).then(() => true).catch(() => false);
    if (!ready) fail(`${def.slug}: the sample did not open`);
    const st = await sp.evaluate(() => { const btn = document.querySelector(".btn.primary"), r = btn.getBoundingClientRect();
      return { state: window.__vert?.state, below: Math.round(r.bottom - innerHeight), sideways: document.documentElement.scrollWidth > innerWidth + 1,
        words: (document.body.innerText ?? "").split(/\s+/).filter(Boolean).length, h1: document.querySelectorAll("h1").length, title: document.title }; });
    if (st.state !== "sample") fail(`${def.slug}: state is ${st.state}`);
    if (st.h1 !== 1) fail(`${def.slug}: ${st.h1} headlines`);
    if (st.below > 0) fail(`${def.slug}: the main button ends ${st.below} px below the first screen`);
    if (st.sideways) fail(`${def.slug}: scrolls sideways at 390px`);
    if (st.words > 240) fail(`${def.slug}: ${st.words} words at rest (max 240)`);
    if (e.length) fail(`${def.slug}: ${e.join(" | ")}`);
    console.log(`  ${def.slug}: ${st.words} words at rest — ${st.title}`);
    await sp.close();
  }
  if (errs.length) fail(errs.join(" | "));
  await b.close();
} catch (e) { fail(String(e?.message ?? e)); }
server.kill();
if (failed) process.exit(1); console.log("smoke ok");
