// verify-ui.mjs: the phone UI gate. Drives the page through every state with awkward inputs (long names, no-space names,
// landscape and portrait clips) on an iPhone-sized viewport and, at each state, runs the Missions UI audit: nothing wider
// than the screen, no text spilling out of its box, the demo column one width, page scale and base font unchanged.
// Screenshots per state land in tests/e2e/out/ui/. Usage: bun tests/e2e/verify-ui.mjs [url] [--share]
import { chromium } from "playwright";
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
// The shared audit lives in the Missions skill; skills sit beside PAI_DIR on some machines and inside it on others.
const skillsDir = [process.env.PAI_DIR, process.env.PAI_DIR && process.env.PAI_DIR + "/..", process.env.HOME + "/.claude"].filter(Boolean).map((d) => d + "/skills/Missions/Tools/uiaudit.mjs").find((f) => existsSync(f));
if (!skillsDir) { console.error("uiaudit.mjs not found next to PAI_DIR or in ~/.claude/skills"); process.exit(1); }
const { auditPage, judge } = await import(skillsDir);
const here = new URL(".", import.meta.url).pathname; const out = here + "out/ui"; mkdirSync(out, { recursive: true });
const args = process.argv.slice(2); const share = args.includes("--share"); let url = args.find((a) => !a.startsWith("--")); let server = null;
if (!url) { server = spawn("bun", [here + "../../serve.ts", "8799"], { stdio: "ignore" }); await new Promise((r) => setTimeout(r, 800)); url = "http://localhost:8799/"; }
// Awkward inputs, cut from the 44 s fixture so each run is short.
const src = here + "../fixtures/speech44.mp4"; const dir = tmpdir() + "/captions-ui"; mkdirSync(dir, { recursive: true });
const CLIPS = [
  { tag: "longname", name: "My very long kitchen tour video for the channel final edit v2 with extra footage and more words.mp4", vf: null },
  { tag: "nospace", name: "IMG_20260918_143522_Screen-Recording-from-the-Living-Room-With-Everyone-Talking-At-Once.mp4", vf: null },
  { tag: "landscape", name: "landscape talk about the kitchen and the garden.mp4", vf: "scale=960:540,setsar=1" },
];
for (const c of CLIPS) { const f = dir + "/" + c.name; if (!existsSync(f)) execFileSync("ffmpeg", ["-v", "error", "-y", "-i", src, "-t", "9", ...(c.vf ? ["-vf", c.vf, "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-c:a", "copy"] : ["-c", "copy"]), f]); }
const COLUMNS = [".stage", "#action", ".chips", ".steps", ".result", "#status", ".caplabel", "#reset", "#trust"]; // must share one width; the stage is allowed its own (it is sized by the clip)


// Two controls must never claim the same pixels, in any state, at any width.
//
// Design review, 2026-09-21: "Lost it?" and "Remove the key from this device" were inline links on consecutive
// 22 px lines, each given a 44 px tap box by the page's own rule. The boxes overlapped by 123 x 22 px and the
// later one won the hit test, so aiming at the link that RECOVERS a key removed it instead. Measuring each
// control's own size cannot see that — only overlap can.
//
// The first version of this check could not have caught its own sibling (N1: the bottom 3 px of the key input
// belonged to the recovery link). It had no `input` in its selector, it ran only in the paid state where the
// locked controls are hidden, and it lived in one tool of three. So: every interactive thing, every state the
// matrix already visits, and the same function in all three tools.
const HITTABLE = "a[href], button, input, select, textarea, [onclick], [role=button], summary";
const overlaps = [];
async function unlockCheck(page, state, check) {
  let r;
  try {
    r = await page.evaluate((sel) => {
      const shown = [...document.querySelectorAll(sel)].filter((el) => {
        if (!el.offsetParent && getComputedStyle(el).position !== "fixed") return false;
        const b = el.getBoundingClientRect();
        return b.width > 0 && b.height > 0;
      });
      const boxes = shown.map((el) => ({ id: el.id || (el.textContent || el.value || el.placeholder || el.tagName).trim().slice(0, 24), r: el.getBoundingClientRect() }));
      const bad = [];
      for (let i = 0; i < boxes.length; i++)
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i].r, b = boxes[j].r;
          // A control legitimately inside another (a button in a label, a summary in details) is not a clash.
          if ((a.left >= b.left && a.right <= b.right && a.top >= b.top && a.bottom <= b.bottom) || (b.left >= a.left && b.right <= a.right && b.top >= a.top && b.bottom <= a.bottom)) continue;
          const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (w > 0.5 && h > 0.5)
            bad.push({ a: boxes[i].id, b: boxes[j].id, w: Math.round(w), h: Math.round(h), px: Math.round(w * h), ar: [a.x, a.y, a.width, a.height].map(Math.round), br: [b.x, b.y, b.width, b.height].map(Math.round) });
        }
      return { count: shown.length, bad, width: innerWidth };
    }, HITTABLE);
  } catch (e) {
    check(false, `${state}: the hit rectangles could not be measured (${String(e.message).slice(0, 90)})`);
    return;
  }
  overlaps.push({ state, width: r.width, controls: r.count, bad: r.bad });
  if (r.bad.length) check(false, `${state} @${r.width}px: ${r.bad.map((o) => `${o.a} and ${o.b} share ${o.w}x${o.h} px`).join("; ")}`);
}

const fails = []; const check = (ok, msg) => { console.log((ok ? "  ok   " : "  FAIL ") + msg); if (!ok) fails.push(msg); };
const b = await chromium.launch({ headless: true, args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, acceptDownloads: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1" });
if (share) await ctx.addInitScript(() => { navigator.canShare = () => true; navigator.share = async () => {}; });
const p = await ctx.newPage();
const errs = []; p.on("pageerror", (e) => errs.push("pageerror: " + e.message.slice(0, 160)));
p.on("console", (m) => { if (m.type() === "error" && !/cloudflareinsights|Failed to load resource/.test(m.text())) errs.push("console: " + m.text().slice(0, 160)); });
let baseFont = null;
const snap = async (tag) => { await unlockCheck(p, tag, check); const f = await auditPage(p, COLUMNS); baseFont ??= f.font; await p.screenshot({ path: `${out}/${tag}.png` }); judge(f, tag, check, { baseFont, ignoreWidths: [".stage"] }); };

await p.goto(url, { waitUntil: "load" });
await p.waitForFunction(() => window.__cap && window.__cap.words && window.__cap.words.length > 0, null, { timeout: 30000 });
await p.waitForTimeout(800); await snap("0-rest");
// The price is on the first phone screen (both cold users, 2026-09-18): the tag in the header, tall enough to tap, clear of the name and of the edge.
{ const t = await p.evaluate(() => { const el = document.getElementById("tag"), a = el.getBoundingClientRect(), b = document.querySelector(".brand").getBoundingClientRect(); return { text: el.textContent, top: a.top, bottom: a.bottom, h: a.height, right: a.right, gap: a.left - b.right, vw: innerWidth, vh: innerHeight }; });
  check(t.top >= 0 && t.bottom <= t.vh && t.h >= 44 && t.gap >= 8 && t.right <= t.vw - 15 && /\$\d+ once/.test(t.text), `the price is on the first screen: "${t.text}" (${Math.round(t.h)} px tall, ${Math.round(t.gap)} px from the name)`); }
let first = true;
for (const c of CLIPS) {
  await p.setInputFiles("#file", dir + "/" + c.name);
  await p.waitForFunction(() => window.__cap.state === "loaded" && document.getElementById("video").duration > 0, null, { timeout: 20000 });
  { const sk = await p.evaluate(async () => { const i = document.getElementById("seek"), v = document.getElementById("video"), st = document.getElementById("stage").getBoundingClientRect(), r = i.getBoundingClientRect(), b = document.querySelector("#seekbar i").getBoundingClientRect(); i.value = "500"; i.dispatchEvent(new Event("input", { bubbles: true })); await new Promise((r) => setTimeout(r, 400)); return { h: Math.round(r.height), line: Math.round(b.height), atBottom: Math.abs(r.bottom - st.bottom) < 2, frac: v.currentTime / v.duration }; });
    check(sk.h >= 44 && sk.line <= 8 && sk.atBottom && Math.abs(sk.frac - 0.5) < 0.1, `the scrub line sits on the bottom edge and moves the clip (touch ${sk.h} px, line ${sk.line} px, went to ${(sk.frac * 100).toFixed(0)}%)`); }
  await p.waitForTimeout(600); await snap(`1-loaded-${c.tag}`);
  const shown = await p.evaluate(() => document.getElementById("clipname").textContent);
  check(shown.length <= 40 && (c.name.length <= 40 ? shown === c.name : shown.includes("…")), `${c.tag}: clip name fits ("${shown}")`);
  await p.click("#action");
  await p.waitForFunction(() => document.querySelector("#s2.active") || window.__cap.state === "captioned" || window.__cap.error, null, { timeout: 300000, polling: 300 });
  await snap(`2-working-${c.tag}`);
  await p.waitForFunction(() => window.__cap.state === "captioned" || window.__cap.error, null, { timeout: 300000, polling: 300 });
  await p.waitForTimeout(800); await snap(`3-captioned-${c.tag}`);
  check(!(await p.evaluate(() => window.__cap.error)), `${c.tag}: captioned (${await p.evaluate(() => window.__cap.words.length)} words)`);
  // Design review 7, 2026-09-19: the finished step is on the page when the work is done (it was switched off as it was written, for three rounds).
  { const done = await p.evaluate(() => { const r = document.getElementById("s3").getBoundingClientRect(); return { h: +r.height.toFixed(1), fs: getComputedStyle(document.getElementById("s3t")).fontSize, text: document.getElementById("s3t").textContent, others: [...document.querySelectorAll("#steps .step:not(#s3)")].filter((e) => e.getBoundingClientRect().height > 0).length }; });
    check(done.h > 0 && parseFloat(done.fs) >= 15 && done.others === 0 && done.text.length > 4, `${c.tag}: the finished step is visible, alone ("${done.text}", ${done.h} px, ${done.fs})`); }
  if (first) { await p.click("#editwords"); await p.waitForTimeout(400); await snap(`3b-fixwords-${c.tag}`); await p.click("#editwords"); }
  await p.evaluate(() => { window.__cap.fastOpts = { minSpeed: 0 }; });
  const dl = share ? null : p.waitForEvent("download", { timeout: 120000 }).catch(() => null);
  await p.click("#action");
  // Design review 2, 2026-09-19: while the clip is written there is no play badge to tap (a tap moved the playhead of a recorded save) and no floating disabled button over the page.
  { await p.waitForFunction(() => window.__cap.state === "exporting" || window.__cap.state === "exported", null, { timeout: 20000, polling: 50 }).catch(() => {}); await p.waitForTimeout(300); // the badge fades over 150 ms
    const busy = await p.evaluate(() => ({ state: window.__cap.state, busy: document.getElementById("stage").classList.contains("busy"), badge: getComputedStyle(document.getElementById("playicon")).opacity, taps: getComputedStyle(document.getElementById("tap")).pointerEvents, stuck: document.getElementById("action").classList.contains("stuck") }));
    if (busy.state === "exporting") check(busy.busy && busy.badge === "0" && busy.taps === "none" && !busy.stuck, `${c.tag}: while saving, no play badge, no taps on the stage, no floating button (stage.busy ${busy.busy}, badge ${busy.badge}, taps ${busy.taps}, stuck ${busy.stuck})`); }
  await p.waitForFunction(() => window.__cap.state === "exported" || window.__cap.exportError, null, { timeout: 120000, polling: 300 });
  if (dl) await dl; await p.waitForTimeout(600); await snap(`4-exported-${c.tag}`);
  { const r = await p.evaluate(() => { const a = document.getElementById("rbuy"), q = a.getBoundingClientRect(); return { text: a.textContent, h: q.height, href: a.href, newTab: a.target === "_blank" && document.getElementById("buy").target === "_blank", shown: q.width > 0 && !document.getElementById("rmark").hidden }; });
    check(r.shown && r.newTab && r.h >= 44 && /polar\.sh/.test(r.href) && /\$\d+ once/.test(r.text), `${c.tag}: the Saved box states the price with a link that opens the checkout in its own tab, so the clip stays ("${r.text}", ${Math.round(r.h)} px)`); }
  check(!(await p.evaluate(() => window.__cap.exportError)), `${c.tag}: exported (${await p.evaluate(() => window.__cap.exportPath)}), card shows "${await p.evaluate(() => document.getElementById("rname").textContent)}"`);
  first = false;
}
check(!errs.length, `page errors: ${errs.length ? errs.join(" || ") : "none"}`);

// The paid panel is the one surface no state above reaches: at rest the page is locked and #paidpanel is hidden,
// so it had shipped without a single tap-target pass. Forced here with a real-length key, because key length is
// what the layout has to survive (design review, 2026-09-21).
try {
  await p.evaluate(() => {
    window.__cap.setLicensed(true);
    const k = document.getElementById("paidkey");
    if (k) k.textContent = "VRT-564BA4A7-F187-49F7-AF0E-B53A520F8173";
  });
  await p.waitForTimeout(250);
  await snap("9-paid");
  await p.evaluate(() => window.__cap.setLicensed(false));
} catch (e) {
  check(false, `the paid panel could not be measured: ${String(e.message).slice(0, 110)}`);
}

// What the guard saw, as data. A gate that fails with only screenshots costs whoever picks it up more than it
// saves, so every state, width, control count and offending pair is written down (the lead, 2026-09-21).
writeFileSync(`${out}/unlock-overlaps.json`, JSON.stringify({ tool: "captions", states: overlaps }, null, 2));
{
  const clashes = overlaps.filter((o) => o.bad.length);
  check(!clashes.length, clashes.length ? `${clashes.length} state(s) with overlapping controls — see unlock-overlaps.json` : `no overlapping controls in ${overlaps.length} states`);
}

await b.close(); server?.kill();
console.log(`screenshots in ${out}`);
if (fails.length) { console.error(`UI FAIL (${fails.length})`); process.exit(1); }
console.log("ui ok");
