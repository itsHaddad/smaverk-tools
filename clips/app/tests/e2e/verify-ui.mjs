// verify-ui.mjs: the phone UI gate. Drives the page through every state on an iPhone-sized screen and, at each one,
// runs the Missions UI audit (nothing wider than the screen, no text out of its box, one column width, base font kept)
// and the overlap guard the other three tools run (no two controls claim the same pixels). Screenshots in tests/e2e/out/ui/.
//
//   bun tests/e2e/verify-ui.mjs [url]
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync, existsSync, copyFileSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeFixture } from "./fixture.mjs";

const here = new URL(".", import.meta.url).pathname;
const root = join(here, "..", "..");
const PRICE = readFileSync(join(root, "app.ts"), "utf8").match(/export const PRICE = "(\$\d+)"/)?.[1] ?? "(no price constant)";
const skillTool = [process.env.PAI_DIR, process.env.PAI_DIR && `${process.env.PAI_DIR}/..`, `${process.env.HOME}/.claude`].filter(Boolean).map((d) => `${d}/skills/Missions/Tools/uiaudit.mjs`).find((f) => existsSync(f));
if (!skillTool) { console.error("uiaudit.mjs not found next to PAI_DIR or in ~/.claude/skills"); process.exit(1); }
const { auditPage, judge } = await import(skillTool);

const out = join(here, "out", "ui");
mkdirSync(out, { recursive: true });
let url = process.argv.slice(2).find((a) => !a.startsWith("--"));
let server = null;
if (!url) { server = spawn("bun", [join(root, "serve.ts"), "8828"], { stdio: "ignore" }); await new Promise((r) => setTimeout(r, 800)); url = "http://localhost:8828/"; }

const fixture = makeFixture(root);
const dir = join(tmpdir(), "clips-ui"); mkdirSync(dir, { recursive: true });
const NAMES = [
  { tag: "longname", name: "My very long podcast episode recording for the channel final edit v2 with the guest and more.mp4" },
  { tag: "unicode", name: "Poddavsnitt — säsong 3, avsnitt 12 (intervju med Åsa Öberg).mp4" },
];
for (const n of NAMES) { const f = join(dir, n.name); if (!existsSync(f)) copyFileSync(fixture, f); }
const COLUMNS = ["#action", ".moments", ".steps", "#status", ".caplabel", "#trust", ".reel"];

const HITTABLE = "a[href], button, input, select, textarea, [onclick], [role=button], summary";
const overlaps = [];
async function unlockCheck(page, state, check) {
  const r = await page.evaluate((sel) => {
    const shown = [...document.querySelectorAll(sel)].filter((el) => { if (!el.offsetParent && getComputedStyle(el).position !== "fixed") return false; const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0; });
    const boxes = shown.map((el) => ({ id: el.id || (el.textContent || el.value || el.placeholder || el.tagName).trim().slice(0, 24), r: el.getBoundingClientRect() }));
    const bad = [];
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i].r, b = boxes[j].r;
      if ((a.left >= b.left && a.right <= b.right && a.top >= b.top && a.bottom <= b.bottom) || (b.left >= a.left && b.right <= a.right && b.top >= a.top && b.bottom <= a.bottom)) continue;
      const w = Math.min(a.right, b.right) - Math.max(a.left, b.left), h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (w > 0.5 && h > 0.5) bad.push({ a: boxes[i].id, b: boxes[j].id, w: Math.round(w), h: Math.round(h) });
    }
    return { count: shown.length, bad, width: innerWidth };
  }, HITTABLE);
  overlaps.push({ state, width: r.width, controls: r.count, bad: r.bad });
  if (r.bad.length) check(false, `${state} @${r.width}px: ${r.bad.map((o) => `${o.a} and ${o.b} share ${o.w}x${o.h} px`).join("; ")}`);
}

const fails = [];
const check = (ok, msg) => { console.log((ok ? "  ok   " : "  FAIL ") + msg); if (!ok) fails.push(msg); };
const b = await chromium.launch({ headless: true, args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, acceptDownloads: true,
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1" });
await ctx.route(/cloudflareinsights\.com/, (r) => (r.request().method() === "GET" ? r.continue() : r.fulfill({ status: 204, body: "" })));
const p = await ctx.newPage();
const errs = [];
p.on("pageerror", (e) => errs.push(`pageerror: ${e.message.slice(0, 160)}`));
p.on("console", (m) => { if (m.type() === "error" && !/cloudflareinsights|Failed to load resource|^\[WARNING\]/.test(m.text())) errs.push(`console: ${m.text().slice(0, 160)}`); });
let baseFont = null;
const snap = async (tag) => { await unlockCheck(p, tag, check); const f = await auditPage(p, COLUMNS); baseFont ??= f.font; await p.screenshot({ path: join(out, `${tag}.png`) }); judge(f, tag, check, { baseFont, ignoreWidths: [".reel"] }) /* the stage is the tall clip's own width (design review r8 round 3), like the other tools' .stage */; };
// Every control a phone user taps is at least 44 px each way.
const taps = async (tag) => {
  const small = await p.evaluate(() => [...document.querySelectorAll("button, a[href], input, label.keep, summary")].filter((e) => e.offsetParent && !e.closest(".foot") && !e.closest("details:not([open]) > :not(summary)")).map((e) => { const r = e.getBoundingClientRect(); return { id: e.id || e.className || e.tagName, w: Math.round(r.width), h: Math.round(r.height), type: e.type }; }).filter((x) => x.type !== "range" && x.type !== "checkbox" && (x.h < 44 || x.w < 44) && x.w > 0));
  check(!small.length, `${tag}: every control is at least 44 px${small.length ? `: ${JSON.stringify(small.slice(0, 4))}` : ""}`);
};

try {
  await p.goto(url, { waitUntil: "load" });
  await p.waitForFunction(() => window.__clips?.state === "sample" && window.__clips.moments > 0, null, { timeout: 30000 });
  await p.waitForTimeout(800);
  await snap("0-rest");
  await taps("0-rest");
  {
    const t = await p.evaluate(() => { const el = document.getElementById("tag"), a = el.getBoundingClientRect(), brand = document.querySelector(".brand").getBoundingClientRect(); return { text: el.textContent, top: a.top, bottom: a.bottom, h: a.height, right: a.right, gap: a.left - brand.right, vw: innerWidth, vh: innerHeight }; });
    check(t.top >= 0 && t.bottom <= t.vh && t.h >= 44 && t.gap >= 8 && t.right <= t.vw - 15 && t.text.includes(PRICE), `what it costs is on the first screen: "${t.text.trim()}"`);
    const m = await p.evaluate(() => { const r = document.getElementById("action").getBoundingClientRect(), v = document.getElementById("reel").getBoundingClientRect(); return { below: Math.round(r.bottom - innerHeight), reelTop: Math.round(v.top), reelBottom: Math.round(v.bottom) }; });
    check(m.below <= 0, `the main button is on the first screen (${m.below <= 0 ? `${-m.below} px of room` : `${m.below} px below`}), the finished clip above it (${m.reelTop}–${m.reelBottom} px)`);
  }
  // A sample clip plays from the list.
  await p.click(".moment:nth-child(2) .go");
  await p.waitForTimeout(600);
  check(/sample-2\.mp4/.test(await p.evaluate(() => document.getElementById("reel").currentSrc)), "the second sample moment plays its own clip");

  for (const n of NAMES) {
    await p.setInputFiles("#file", join(dir, n.name));
    await p.waitForFunction(() => window.__clips?.state === "reading", null, { timeout: 20000 });
    await p.waitForTimeout(500);
    await snap(`1-picked-${n.tag}`);
    const shown = await p.evaluate(() => ({ text: document.getElementById("clipname").textContent, title: document.getElementById("clipname").title }));
    check(shown.text.length <= 40 && shown.title === n.name, `${n.tag}: the name fits ("${shown.text}")`);
    check(await p.isVisible("#reset"), `${n.tag}: the way out is on screen while it reads`);
    await p.click("#reset");
    await p.waitForFunction(() => window.__clips?.state === "sample", null, { timeout: 10000 });
  }

  await p.setInputFiles("#file", fixture);
  await p.waitForFunction(() => window.__clips?.state === "reading" && (window.__clips.heardS ?? 0) > 30, null, { timeout: 300000, polling: 500 });
  await snap("2-reading");
  // B2 (design review 1): the stage shows the visitor's own recording, not the sample's finished clip, once a file is picked.
  check((await p.evaluate(() => document.getElementById("reel").currentSrc)).startsWith("blob:"), "the stage shows the picked recording, not the sample clip");
  await p.waitForFunction(() => window.__clips?.state === "found", null, { timeout: 1_200_000, polling: 1000 });
  await p.waitForTimeout(600);
  await snap("3-found");
  // B4: once the moments are found, every step before making is done, the download step included.
  check(await p.evaluate(() => ["s1", "s2"].every((id) => document.getElementById(id).classList.contains("done"))), "when the moments are found, steps 1 and 2 are both done");
  // B1: tapping a moment makes it current and opens its trim row.
  {
    const n = await p.evaluate(() => document.querySelectorAll(".moment").length);
    const k = Math.min(n, 2);
    await p.click(`.moment:nth-child(${k}) .go`);
    await p.waitForTimeout(500);
    const t = await p.evaluate((k) => { const li = document.querySelector(`.moment:nth-child(${k})`); const row = li.querySelector(".trimrow"); return { cur: li.getAttribute("aria-current"), shown: !!row && row.getBoundingClientRect().height > 0 }; }, k);
    check(t.cur === "true" && t.shown, `tapping moment ${k} makes it current (${t.cur}) and opens its trim row (${t.shown})`);
    // B3: with one moment playing, tapping another moves the playing mark to it, and only to it.
    if (n > 1) {
      await p.click(".moment:nth-child(1) .go");
      await p.waitForTimeout(800);
      await p.click(".moment:nth-child(2) .go");
      await p.waitForTimeout(1200);
      const playing = await p.evaluate(() => [...document.querySelectorAll(".moment")].map((li, i) => (li.hasAttribute("data-playing") ? i + 1 : 0)).filter(Boolean));
      check(playing.length === 1 && playing[0] === 2, `after tapping moment 2 while 1 plays, only moment 2 is marked playing (${JSON.stringify(playing)})`);
    }
    await p.evaluate(() => document.getElementById("reel").pause());
  }
  await taps("3-found");
  {
    const t = await p.evaluate(() => { const li = document.querySelector(".moment"); const row = li.querySelector(".trimrow"); li.setAttribute("aria-current", "true"); const keep = li.querySelector("label.keep").getBoundingClientRect(); return { keepH: Math.round(keep.height), label: document.getElementById("action").textContent }; });
    check(t.keepH >= 44 && /^Make \d clips?$/.test(t.label), `a tick is ${t.keepH} px tall and the button says "${t.label}"`);
  }
  await p.evaluate(() => { for (let i = 1; i < window.__clips.list.length; i++) window.clips.keep(i, false); });
  check((await p.textContent("#action")) === "Make 1 clip", `unticking changes the button to "${await p.textContent("#action")}"`);
  await p.click("#action");
  await p.waitForFunction(() => window.__clips?.state === "making", null, { timeout: 20000 });
  await p.waitForTimeout(3000);
  await snap("4-making");
  // B6 (design review 3): the step labels keep whole words while the longest note sits beside them. The label was squeezed to
  // one letter per line on a phone, because the note column took its full width and letters were allowed to split.
  {
    const words = () => p.evaluate(() => {
      const split = [];
      for (const el of document.querySelectorAll("#steps .step > span, #steps .step small")) {
        const t = el.firstChild; if (!t || t.nodeType !== 3) continue;
        for (const m of t.textContent.matchAll(/\S+/g)) { const r = document.createRange(); r.setStart(t, m.index); r.setEnd(t, m.index + m[0].length); if (r.getClientRects().length > 1) split.push(m[0]); }
      }
      const s3 = document.getElementById("s3t"); const lh = parseFloat(getComputedStyle(s3).lineHeight) || 20;
      return { split, h: Math.round(s3.getBoundingClientRect().height), lh: Math.round(lh) };
    });
    let w = await words();
    check(!w.split.length && w.h <= 2 * w.lh, `making: the step labels keep whole words (label ${w.h} px for a ${w.lh} px line${w.split.length ? `; split: ${w.split.join(", ")}` : ""})`);
    await p.evaluate(() => { document.getElementById("s3n").textContent = "clip 10 of 10: finding the speaker 100%"; });
    w = await words();
    check(!w.split.length && w.h <= 2 * w.lh, `making, the longest note: the step labels keep whole words (label ${w.h} px${w.split.length ? `; split: ${w.split.join(", ")}` : ""})`);
  }
  await p.waitForFunction(() => window.__clips?.state === "made", null, { timeout: 1_200_000, polling: 1000 });
  await p.waitForTimeout(600);
  await snap("5-made");
  await taps("5-made");
  check(await p.isVisible(".moment .save"), "a finished clip has its own Save button");
  // B7 (design review 3): on the small iPhone the memory messages are for, both sit on the first screen, above the stage.
  {
    const se = await b.newContext({ viewport: { width: 375, height: 667 }, screen: { width: 375, height: 667 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1" });
    await se.route(/cloudflareinsights\.com/, (r) => (r.request().method() === "GET" ? r.continue() : r.fulfill({ status: 204, body: "" })));
    const q = await se.newPage();
    const where = () => q.evaluate(() => { const el = document.getElementById("notice"); const r = el.getBoundingClientRect(); return { hidden: el.hidden, text: el.textContent, top: Math.round(r.top), bottom: Math.round(r.bottom), vh: innerHeight }; });
    await q.goto(url, { waitUntil: "load" });
    await q.waitForFunction(() => window.__clips?.state === "sample", null, { timeout: 30000 });
    await q.evaluate(() => sessionStorage.setItem("smaverk.clips.busy", "making"));
    await q.reload({ waitUntil: "load" });
    await q.waitForFunction(() => window.__clips?.state === "sample", null, { timeout: 30000 });
    let n = await where();
    check(!n.hidden && /started again/.test(n.text) && n.top >= 0 && n.bottom <= n.vh, `375x667, a page started again mid-make: the notice is on the first screen (${n.top}-${n.bottom} of ${n.vh}): "${n.text.slice(0, 60)}"`);
    await q.screenshot({ path: join(out, "6-restarted-se.png") });
    await q.setInputFiles("#file", fixture);
    await q.waitForFunction(() => window.__clips?.state === "reading" && window.__clips.sourceHeight, null, { timeout: 30000 });
    await q.waitForTimeout(300);
    n = await where();
    check(!n.hidden && /enough memory/.test(n.text) && n.top >= 0 && n.bottom <= n.vh, `375x667, a 1080p recording picked: the warning is on the first screen (${n.top}-${n.bottom} of ${n.vh}): "${n.text.slice(0, 60)}"`);
    await q.screenshot({ path: join(out, "7-warned-se.png") });
    await q.waitForFunction(() => window.__clips?.state === "found", null, { timeout: 1_200_000, polling: 1000 });
    n = await where();
    check(!n.hidden && /enough memory/.test(n.text), `375x667: the warning is still there when the moments are found ("${n.text.slice(0, 40)}")`);
    await se.close();
  }
  if (errs.length) check(false, errs.join(" | "));
} catch (e) {
  check(false, String(e?.stack ?? e?.message ?? e));
} finally {
  try { await p.evaluate(() => window.__clips.setLicensed(true)); await p.waitForTimeout(250); await snap("9-paid"); await p.evaluate(() => window.__clips.setLicensed(false)); }
  catch (e) { check(false, `the paid panel could not be measured: ${String(e.message).slice(0, 110)}`); }
  writeFileSync(join(out, "unlock-overlaps.json"), JSON.stringify({ tool: "clips", states: overlaps }, null, 2));
  const clashes = overlaps.filter((o) => o.bad.length);
  check(!clashes.length, clashes.length ? `${clashes.length} state(s) with overlapping controls — see unlock-overlaps.json` : `no overlapping controls in ${overlaps.length} states`);
  await b.close();
  server?.kill();
}
if (fails.length) { console.error(`\n${fails.length} UI failure(s)`); process.exit(1); }
console.log("phone UI gate ok");
