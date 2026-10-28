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
  const st = await p.evaluate(() => ({ state: window.__cap?.state, action: document.getElementById("action")?.textContent, support: document.querySelector("#support a")?.href, gates: ["price", "buy", "keyrow", "paidpanel"].filter((id) => document.getElementById(id)), workerOk: typeof Worker }));
  if (st.state !== "sample") fail("state is " + st.state); if (!/Use my own clip/.test(st.action ?? "")) fail("action label " + st.action); if (!/^https:\/\/buy\.polar\.sh\//.test(st.support ?? "")) fail("support link " + st.support); if (st.gates.length) fail("a price or key box is on the page: " + st.gates.join(","));
  const html = await p.content(); const m = html.match(/src="app\.js\?v=(\d+)"/); if (!m) fail("app.js is not versioned");
  const js = await (await fetch(`http://localhost:${port}/app.js`)).text(); if (!/worker\.js\?v=\d+/.test(js)) fail("worker.js is not versioned");
  const w = await fetch(`http://localhost:${port}/worker.js`); if (w.status !== 200) fail("worker.js " + w.status);
  const sideways = await p.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1); if (sideways) fail("page scrolls sideways at 390px");
  // the studio page (served at smaverk.com by functions/_middleware.js) must load clean too
  const s2 = await b.newPage({ viewport: { width: 390, height: 844 } }); const errs2 = []; s2.on("pageerror", (e) => errs2.push(e.message));
  await s2.goto(`http://localhost:${port}/studio.html`, { waitUntil: "load" });
  const st2 = await s2.evaluate(() => ({ h1: document.querySelector("h1")?.textContent, tools: document.querySelectorAll(".tool").length, captions: document.querySelector(".tool .btn")?.getAttribute("href"), sideways: document.documentElement.scrollWidth > innerWidth + 1 }));
  // smaverk.com's own page (home.html, Maindesk) loads clean too; studio.html is the video tools' page at video.smaverk.com
  const s3 = await b.newPage({ viewport: { width: 390, height: 844 } }); const errs3 = []; s3.on("pageerror", (e) => errs3.push(e.message)); s3.on("response", (r) => { if (r.status() >= 400 && !/cloudflareinsights|events\.smaverk/.test(r.url())) errs3.push(`${r.status()} ${r.url()}`); });
  await s3.goto(`http://localhost:${port}/home.html`, { waitUntil: "load" });
  const st3 = await s3.evaluate(() => ({ h1: document.querySelector("h1")?.textContent, md: document.querySelector('a[href^="https://maindesk.smaverk.com/"]')?.textContent, shown: [...document.querySelectorAll(".log li, .chart .lane")].filter((e) => e.getBoundingClientRect().height > 0).length, sideways: document.documentElement.scrollWidth > innerWidth + 1 }));
  if (!/AI agent/.test(st3.h1 ?? "")) fail("home h1 " + st3.h1); if (st3.md !== "Open Maindesk") fail("home Maindesk link " + st3.md); if (st3.shown < 5) fail("home: the evening's log shows " + st3.shown + " rows"); if (st3.sideways) fail("home scrolls sideways"); if (errs3.length) fail("home: " + errs3.join(" | "));
  // A, 28 Oct: on a desktop the hero fits: the lead starts level with the headline (not above it), the buttons end level with
  // its bottom, and the evening's caption is one line, not broken short with empty space beside it
  await s3.setViewportSize({ width: 1440, height: 900 }); await s3.waitForTimeout(150);
  const fit = await s3.evaluate(() => { const r = (q) => document.querySelector(q).getBoundingClientRect(); return { h1: r("h1"), lead: r(".lead"), go: r(".go"), cap: r(".cap") }; });
  if (fit.lead.top < fit.h1.top - 2 || fit.lead.top > fit.h1.top + 16) fail(`home hero: the lead starts at ${Math.round(fit.lead.top)}, the headline at ${Math.round(fit.h1.top)}`);
  if (Math.abs(fit.go.bottom - fit.h1.bottom) > 3) fail(`home hero: Open Maindesk ends at ${Math.round(fit.go.bottom)}, the headline at ${Math.round(fit.h1.bottom)}`);
  if (fit.cap.height > 30) fail(`home: the caption breaks into ${Math.round(fit.cap.height)} px at 1440`);
  // design review r12, fill window (28 Oct): on a tall window the rows stay compact (100 px at most), the page is exactly the
  // window's height (nothing cut off, nothing to scroll) and the free height sits in the two spacers (Qa.ts blocks a band over
  // 64 px); no Play again button (A, 28 Oct): the chart itself replays the evening on a click, Enter, and coming back into view
  await s3.setViewportSize({ width: 1440, height: 1300 }); await s3.waitForTimeout(150);
  const tall = await s3.evaluate(() => ({ lanes: [...document.querySelectorAll(".chart .lane")].map((e) => e.getBoundingClientRect().height), page: document.documentElement.scrollHeight, win: innerHeight, gaps: [...document.querySelectorAll(".wrap>.gap")].map((e) => e.getBoundingClientRect().height), replay: !!document.getElementById("replay"), role: document.querySelector(".chart").getAttribute("role") }));
  if (tall.lanes.length !== 5 || tall.lanes.some((h) => h > 101)) fail(`home at 1440x1300: chart rows ${tall.lanes.map(Math.round).join("/")} px (five, 101 px at most)`);
  if (tall.page !== tall.win) fail(`home at 1440x1300: the page is ${tall.page} px in a ${tall.win} px window`);
  if (tall.gaps.length !== 2 || tall.gaps.some((h) => h > 64)) fail(`home at 1440x1300: spacers ${tall.gaps.map(Math.round).join("/")} px (two, 64 px at most)`);
  if (tall.replay) fail("home: the Play again button is back"); if (tall.role !== "button") fail(`home: the chart is not the replay control (role ${tall.role})`);
  const head = () => s3.evaluate(() => document.getAnimations().find((a) => a.animationName === "head")?.currentTime ?? -1);
  const replays = async (what, act) => { await s3.waitForTimeout(1200); const before = await head(); await act(); await s3.waitForTimeout(100); const after = await head();
    if (!(before > 1000 && after >= 0 && after < 700)) fail(`home: ${what} did not replay the evening (its head at ${Math.round(before)} ms, then ${Math.round(after)} ms)`); };
  await replays("a click on the chart", () => s3.click(".chart"));
  await replays("Enter on the chart", async () => { await s3.focus(".chart"); await s3.keyboard.press("Enter"); });
  await replays("the chart coming back into view", async () => { await s3.evaluate(() => { const d = document.createElement("div"); d.style.height = "3000px"; document.body.append(d); scrollTo(0, 3000); }); await s3.waitForTimeout(300); await s3.evaluate(() => scrollTo(0, 0)); await s3.waitForTimeout(300); });
  // with reduced motion nothing moves and the chart is no control
  const rm = await b.newPage({ viewport: { width: 1440, height: 1300 }, reducedMotion: "reduce" }); await rm.goto(`http://localhost:${port}/home.html`, { waitUntil: "load" });
  const still = await rm.evaluate(() => ({ moving: document.getAnimations().length, role: document.querySelector(".chart").getAttribute("role"), tab: document.querySelector(".chart").tabIndex }));
  if (still.moving || still.role !== null || still.tab !== -1) fail(`home with reduced motion: ${still.moving} animations, role ${still.role}, tabIndex ${still.tab}`); await rm.close();
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
