// verify-ui.mjs: the phone UI gate for Vertical. Every state (rest, loaded, working, ready, saved) with awkward inputs
// (a long name with spaces, a long name without spaces, a clip that is already vertical) on an iPhone-sized viewport,
// audited with the Missions UI audit at each state. Screenshots in tests/e2e/out/ui/. Usage: bun tests/e2e/verify-ui.mjs [url] [--share]
import { chromium } from "playwright";
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
const skillsDir = [process.env.PAI_DIR, process.env.PAI_DIR && process.env.PAI_DIR + "/..", process.env.HOME + "/.claude"].filter(Boolean).map((d) => d + "/skills/Missions/Tools/uiaudit.mjs").find((f) => existsSync(f));
if (!skillsDir) { console.error("uiaudit.mjs not found"); process.exit(1); }
const { auditPage, judge } = await import(skillsDir);
const here = new URL(".", import.meta.url).pathname; const out = here + "out/ui"; mkdirSync(out, { recursive: true });
const args = process.argv.slice(2); const share = args.includes("--share"); let url = args.find((a) => !a.startsWith("--")); let server = null;
if (!url) { server = spawn("bun", [here + "../../serve.ts", "8807"], { stdio: "ignore" }); await new Promise((r) => setTimeout(r, 800)); url = "http://localhost:8807/"; }
const src = here + "../fixtures/talk-moving-face.mp4"; const dir = tmpdir() + "/vertical-ui"; mkdirSync(dir, { recursive: true });
const CLIPS = [
  { tag: "longname", name: "Episode 12 with a very long title about the kitchen and the garden and everything else.mp4", vf: null },
  { tag: "nospace", name: "IMG_20260918_Screen-Recording-Of-The-Whole-Talk-With-Everyone-Talking-At-Once.mp4", vf: null },
  { tag: "portrait", name: "already vertical.mp4", vf: "crop=608:1080:656:0" },
];
for (const c of CLIPS) { const f = dir + "/" + c.name; if (!existsSync(f)) execFileSync("ffmpeg", ["-v", "error", "-y", "-i", src, "-t", "8", ...(c.vf ? ["-vf", c.vf, "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-c:a", "copy"] : ["-c", "copy"]), f]); }
const COLUMNS = [".stage", "#action", ".chips", ".steps", ".result", "#status", ".caplabel", "#reset", "#trust"];

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
p.on("console", (m) => { if (m.type() === "error" && !/cloudflareinsights|Failed to load resource|TensorFlow Lite|XNNPACK/.test(m.text())) errs.push("console: " + m.text().slice(0, 160)); });
let baseFont = null;
const snap = async (tag) => { await unlockCheck(p, tag, check); const f = await auditPage(p, COLUMNS); baseFont ??= f.font; await p.screenshot({ path: `${out}/${tag}.png` }); judge(f, tag, check, { baseFont, ignoreWidths: [".stage"] });
  // Design reviews 2 and 3 (B2): the sound control covered the speaker and the result inset. Controls stay off the picture.
  const over = await p.evaluate(() => { const st = document.getElementById("stage").getBoundingClientRect(); const hit = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.left < st.right && r.right > st.left && r.top < st.bottom && r.bottom > st.top; };
    const so = document.getElementById("sound"), sr = so.getBoundingClientRect(), win = window.__vert.win; const wl = win ? st.left + win.x * st.width : 0, wr = win ? wl + win.w * st.width : 0;
    return { sound: { shown: !!so.offsetParent, w: Math.round(sr.width), side: so.dataset.side, overWindow: !!so.offsetParent && !!win && so.dataset.side !== "bottom" && sr.left < wr - 1 && sr.right > wl + 1, wholePicture: !!win && win.w > 0.95 }, onStage: [...document.querySelectorAll("button, a, input, select")].filter((e) => e.id !== "tap" && e.id !== "sound" && e.id !== "seek" && e.offsetParent && hit(e)) /* #tap is the invisible play-and-drag surface */.map((e) => e.id || e.textContent.trim().slice(0, 20)) }; });
  check(over.onStage.length === 0 && (!over.sound.shown || (over.sound.w <= 48 && !over.sound.overWindow && (!over.sound.wholePicture || over.sound.side === "bottom"))), `${tag}: nothing covers the speaker: only the small sound button is on the picture, clear of the window${over.onStage.length ? " (" + over.onStage.join(", ") + ")" : ""}${over.sound.overWindow ? " (sound button over the window)" : ""}`); };
await p.goto(url, { waitUntil: "load" });
await p.waitForFunction(() => window.__vert && window.__vert.state === "sample", null, { timeout: 30000 });
await p.waitForTimeout(800); await snap("0-rest");
// The price is on the first phone screen (both cold users, 2026-09-18): the tag in the header, tall enough to tap, clear of the name and of the edge.
{ const t = await p.evaluate(() => { const el = document.getElementById("tag"), a = el.getBoundingClientRect(), b = document.querySelector(".brand").getBoundingClientRect(); return { text: el.textContent, top: a.top, bottom: a.bottom, h: a.height, right: a.right, gap: a.left - b.right, vw: innerWidth, vh: innerHeight }; });
  check(t.top >= 0 && t.bottom <= t.vh && t.h >= 44 && t.gap >= 8 && t.right <= t.vw - 15 && /\$\d+ once/.test(t.text), `the price is on the first screen: "${t.text}" (${Math.round(t.h)} px tall, ${Math.round(t.gap)} px from the name)`); }
for (const c of CLIPS) {
  await p.setInputFiles("#file", dir + "/" + c.name);
  await p.waitForFunction(() => window.__vert.state === "loaded" && document.getElementById("video").duration > 0, null, { timeout: 20000 });
  await p.waitForTimeout(600); await snap(`1-loaded-${c.tag}`);
  // The scrub line (the principal, 2026-09-18): along the bottom edge, 44 px to touch, and it moves the clip.
  const sk = await p.evaluate(async () => { const i = document.getElementById("seek"), v = document.getElementById("video"), st = document.getElementById("stage").getBoundingClientRect(), r = i.getBoundingClientRect(), b = document.querySelector("#seekbar i").getBoundingClientRect(); i.value = "500"; i.dispatchEvent(new Event("input", { bubbles: true })); await new Promise((r) => setTimeout(r, 400)); return { h: Math.round(r.height), line: Math.round(b.height), atBottom: Math.abs(r.bottom - st.bottom) < 2, frac: v.currentTime / v.duration }; });
  check(sk.h >= 44 && sk.line <= 8 && sk.atBottom && Math.abs(sk.frac - 0.5) < 0.1, `${c.tag}: the scrub line sits on the bottom edge and moves the clip (touch ${sk.h} px, line ${sk.line} px, went to ${(sk.frac * 100).toFixed(0)}%)`);
  // Design review 4 (B6): with the visitor's own clip and no track yet, the page says the window is not placed and shows no result picture.
  const unplaced = await p.evaluate(() => ({ hint: document.getElementById("hint")?.textContent?.trim() ?? "", inset: window.__vert.inset }));
  check(/not placed yet/.test(unplaced.hint) && unplaced.inset === false, `${c.tag}: before tracking the page says the window is not placed, and shows no result picture (hint "${unplaced.hint.slice(0, 40)}", inset ${unplaced.inset})`);
  const shown = await p.evaluate(() => document.getElementById("clipname").textContent); check(shown.length <= c.name.length && (c.name.length <= 30 ? shown === c.name : shown.includes("…") || shown === c.name), `${c.tag}: clip name fits ("${shown}")`);
  await p.click("#action");
  await p.waitForFunction(() => document.querySelector("#s2.active") || window.__vert.state === "ready" || window.__vert.error, null, { timeout: 300000, polling: 300 });
  await snap(`2-working-${c.tag}`);
  check(await p.evaluate(() => document.getElementById("seek").hidden), `${c.tag}: no scrubbing while the speaker is being found`);
  await p.waitForFunction(() => window.__vert.state === "ready" || window.__vert.error, null, { timeout: 300000, polling: 300 });
  await p.waitForTimeout(800); await snap(`3-ready-${c.tag}`);
  // Design review 7, 2026-09-19: the finished step is on the page when the work is done (it was switched off as it was written, for three rounds).
  { const done = await p.evaluate(() => { const r = document.getElementById("s3").getBoundingClientRect(); return { h: +r.height.toFixed(1), fs: getComputedStyle(document.getElementById("s3t")).fontSize, text: document.getElementById("s3t").textContent, others: [...document.querySelectorAll("#steps .step:not(#s3)")].filter((e) => e.getBoundingClientRect().height > 0).length }; });
    check(done.h > 0 && parseFloat(done.fs) >= 15 && done.others === 0 && done.text.length > 4, `${c.tag}: the finished step is visible, alone ("${done.text}", ${done.h} px, ${done.fs})`); }
  // Design review 4 (S2): Hold still keeps the place where the speaker was found; it does not jump to the middle.
  if (c.tag !== "portrait") { const held = await p.evaluate(async () => { const t = window.__vert.track, v = document.getElementById("video"); const at = t.reduce((a, b) => Math.abs(b.t - v.currentTime) < Math.abs(a.t - v.currentTime) ? b : a).cx; document.querySelector('.chip[data-mode="hold"]').click(); await new Promise((r) => setTimeout(r, 150)); const x = window.__vert.holdX; document.querySelector('.chip[data-mode="follow"]').click(); return { at, x }; });
    check(typeof held.x === "number" && Math.abs(held.x - held.at) < 0.08, `${c.tag}: Hold still stays where the speaker is (${held.x?.toFixed?.(2)} vs ${held.at.toFixed(2)})`); }
  if (c.tag !== "portrait") check(await p.evaluate(() => window.__vert.inset === true), `${c.tag}: the result picture shows once the speaker is found`);
  // Design review 3 (B5): the name and format promised before the save are the ones that arrive.
  const promised = await p.evaluate(() => { const o = document.getElementById("out"); return o && !o.hidden ? o.textContent.split(" · ") : null; });
  check(promised && /\.(mp4|webm)$/.test(promised[0]) && promised.some((x) => x.trim().toLowerCase().startsWith(promised[0].split(".").pop())), `${c.tag}: output named before saving ("${promised?.[0]}")`);
  check(!(await p.evaluate(() => window.__vert.error)), `${c.tag}: ready (face in ${Math.round((await p.evaluate(() => window.__vert.found)) * 100)}% of samples)`);
  await p.evaluate(() => { window.__vert.fastOpts = { minSpeed: 0 }; });
  const dl = share ? null : p.waitForEvent("download", { timeout: 180000 }).catch(() => null);
  await p.click("#action");
  await p.waitForFunction(() => window.__vert.state === "exported" || window.__vert.exportError, null, { timeout: 180000, polling: 300 });
  const got = dl ? await dl : null; await p.waitForTimeout(600);
  check(await p.evaluate(() => !document.getElementById("video").paused && getComputedStyle(document.getElementById("playicon")).opacity === "0"), `${c.tag}: after a save the clip plays again and no play icon covers the result`);
  if (got && promised) check(got.suggestedFilename().split(".").pop() === promised[0].split(".").pop(), `${c.tag}: saved as promised (${got.suggestedFilename().split(".").pop()} vs ${promised[0].split(".").pop()})`); await snap(`4-exported-${c.tag}`);
  { const r = await p.evaluate(() => { const a = document.getElementById("rbuy"), q = a.getBoundingClientRect(); return { text: a.textContent, h: q.height, href: a.href, newTab: a.target === "_blank" && document.getElementById("buy").target === "_blank", shown: q.width > 0 && !document.getElementById("rmark").hidden }; });
    check(r.shown && r.newTab && r.h >= 44 && /polar\.sh/.test(r.href) && /\$\d+ once/.test(r.text), `${c.tag}: the Saved box states the price with a link that opens the checkout in its own tab, so the clip stays ("${r.text}", ${Math.round(r.h)} px)`); }
  check(!(await p.evaluate(() => window.__vert.exportError)), `${c.tag}: exported (${await p.evaluate(() => window.__vert.exportPath)}), card shows "${await p.evaluate(() => document.getElementById("rname").textContent)}"`);
}
// Cold users, rounds 2 and 3: a window placed by hand must not be searched for. Drag it, and the page says it stays there;
// "Make it vertical" is then ready at once; choosing Follow afterwards starts the search that was skipped.
{ await p.setInputFiles("#file", dir + "/" + CLIPS[0].name);
  await p.waitForFunction(() => window.__vert.state === "loaded" && document.getElementById("video").duration > 0, null, { timeout: 20000 });
  const st = await p.evaluate(() => { const r = document.getElementById("stage").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width }; });
  await p.mouse.move(st.x, st.y); await p.mouse.down(); await p.mouse.move(st.x - st.w * 0.2, st.y, { steps: 6 }); await p.mouse.up(); await p.waitForTimeout(300);
  const placed = await p.evaluate(() => ({ hint: document.getElementById("hint").textContent, mode: window.__vert.mode, placed: window.__vert.placed, x: window.__vert.holdX }));
  check(placed.placed === true && placed.mode === "hold" && /stays where you put it/.test(placed.hint) && placed.x < 0.45, `a dragged window is held and the page says so (mode ${placed.mode}, x ${placed.x?.toFixed?.(2)}, "${placed.hint.slice(0, 36)}…")`);
  await snap("5-placed"); const t0 = Date.now(); await p.click("#action");
  await p.waitForFunction(() => window.__vert.state === "ready" || window.__vert.error, null, { timeout: 5000, polling: 100 }).catch(() => {});
  const quick = await p.evaluate(() => ({ state: window.__vert.state, skipped: window.__vert.skippedScan, x: window.__vert.holdX }));
  check(quick.state === "ready" && quick.skipped === true && Math.abs(quick.x - placed.x) < 0.001, `a placed window needs no speaker search: ready in ${Date.now() - t0} ms, still at ${quick.x?.toFixed?.(2)}`);
  await p.click('.chip[data-mode="follow"]'); await p.waitForFunction(() => window.__vert.state === "tracking" || window.__vert.state === "ready" && window.__vert.track?.length > 0, null, { timeout: 8000, polling: 100 }).catch(() => {});
  const follow = await p.evaluate(() => ({ state: window.__vert.state, skipped: window.__vert.skippedScan }));
  check(follow.skipped === false && (follow.state === "tracking" || follow.state === "ready"), `Follow the speaker after a held window starts the search (state ${follow.state})`);
  await p.waitForFunction(() => window.__vert.state === "ready" || window.__vert.error, null, { timeout: 300000, polling: 300 }); }
// Cold user, round 3b: Hold still chosen without a drag searched for the speaker and then left the window in the middle, through half his face.
{ await p.setInputFiles("#file", dir + "/" + CLIPS[0].name);
  await p.waitForFunction(() => window.__vert.state === "loaded" && document.getElementById("video").duration > 0, null, { timeout: 20000 });
  await p.click('.chip[data-mode="hold"]'); await p.click("#action");
  await p.waitForFunction(() => window.__vert.state === "ready" || window.__vert.error, null, { timeout: 300000, polling: 300 });
  const h = await p.evaluate(() => { const xs = window.__vert.track.map((q) => q.cx).sort((a, b) => a - b); return { mode: window.__vert.mode, x: window.__vert.holdX, mid: xs[xs.length >> 1], skipped: window.__vert.skippedScan }; });
  check(h.mode === "hold" && h.skipped === false && Math.abs(h.x - h.mid) < 0.02, `Hold still without a drag ends on the speaker (window ${h.x?.toFixed?.(2)}, speaker ${h.mid?.toFixed?.(2)})`); await snap("6-hold-no-drag"); }
check(!errs.length, `page errors: ${errs.length ? errs.join(" || ") : "none"}`);

// The paid panel is the one surface no state above reaches: at rest the page is locked and #paidpanel is hidden,
// so it had shipped without a single tap-target pass. Forced here with a real-length key, because key length is
// what the layout has to survive (design review, 2026-09-21).
try {
  await p.evaluate(() => {
    window.__vert.setLicensed(true);
    const k = document.getElementById("paidkey");
    if (k) k.textContent = "VRT-564BA4A7-F187-49F7-AF0E-B53A520F8173";
  });
  await p.waitForTimeout(250);
  await snap("9-paid");
  await p.evaluate(() => window.__vert.setLicensed(false));
} catch (e) {
  check(false, `the paid panel could not be measured: ${String(e.message).slice(0, 110)}`);
}

// What the guard saw, as data. A gate that fails with only screenshots costs whoever picks it up more than it
// saves, so every state, width, control count and offending pair is written down (the lead, 2026-09-21).
writeFileSync(`${out}/unlock-overlaps.json`, JSON.stringify({ tool: "vertical", states: overlaps }, null, 2));
{
  const clashes = overlaps.filter((o) => o.bad.length);
  check(!clashes.length, clashes.length ? `${clashes.length} state(s) with overlapping controls — see unlock-overlaps.json` : `no overlapping controls in ${overlaps.length} states`);
}

await b.close(); server?.kill();
console.log(`screenshots in ${out}`);
if (fails.length) { console.error(`UI FAIL (${fails.length})`); process.exit(1); }
console.log("ui ok");
