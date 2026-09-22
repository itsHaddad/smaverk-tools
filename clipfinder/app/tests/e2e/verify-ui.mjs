// verify-ui.mjs: the phone UI gate. Drives the page through every state on an iPhone-sized viewport and,
// at each one, runs the Missions UI audit: nothing wider than the screen, no text spilling out of its box,
// the working column one width, page scale and base font unchanged. Screenshots land in tests/e2e/out/ui/.
//
//   bun tests/e2e/verify-ui.mjs [url]
//
// Awkward names are exercised where they show — the moment a file is picked — because that is cheap, and
// the heavy states (reading, found, a moment being trimmed, saved) are driven once on the real fixture.
import { chromium } from "playwright";
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, existsSync, copyFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const skillTool = [process.env.PAI_DIR, process.env.PAI_DIR && `${process.env.PAI_DIR}/..`, `${process.env.HOME}/.claude`]
  .filter(Boolean)
  .map((d) => `${d}/skills/Missions/Tools/uiaudit.mjs`)
  .find((f) => existsSync(f));
if (!skillTool) {
  console.error("uiaudit.mjs not found next to PAI_DIR or in ~/.claude/skills");
  process.exit(1);
}
const { auditPage, judge } = await import(skillTool);

const here = new URL(".", import.meta.url).pathname;
const root = join(here, "..", "..");
const out = join(here, "out", "ui");
mkdirSync(out, { recursive: true });
const args = process.argv.slice(2);
let url = args.find((a) => !a.startsWith("--"));
let server = null;
if (!url) {
  server = spawn("bun", [join(root, "serve.ts"), "8818"], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 800));
  url = "http://localhost:8818/";
}

const fixture = join(root, "tests", "fixtures", "talk6.mp3");
const dir = join(tmpdir(), "clipfinder-ui");
mkdirSync(dir, { recursive: true });
const NAMES = [
  { tag: "longname", name: "My very long podcast episode recording for the channel final edit v2 with the guest and more.mp3" },
  { tag: "nospace", name: "REC_20260920_143522_Zoom-Interview-Recording-With-Everyone-Talking-At-Once-Take-Three.mp3" },
  { tag: "unicode", name: "Poddavsnitt — säsong 3, avsnitt 12 (intervju med Åsa Öberg).mp3" },
];
for (const n of NAMES) {
  const f = join(dir, n.name);
  if (!existsSync(f)) copyFileSync(fixture, f);
}
// One short file, so the "too short to cut up" state is reachable without reading six minutes again.
const shortFile = join(dir, "a short note.mp3");
if (!existsSync(shortFile)) execFileSync("ffmpeg", ["-v", "error", "-y", "-t", "40", "-i", fixture, "-c", "copy", shortFile]);

// Every control in the working column is the full content width. The map is allowed its own (it is a picture).
const COLUMNS = ["#action", ".chips", ".moments", ".steps", "#status", ".caplabel", "#trust", "#exportbox"];


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

const fails = [];
const check = (ok, msg) => {
  console.log((ok ? "  ok   " : "  FAIL ") + msg);
  if (!ok) fails.push(msg);
};

const b = await chromium.launch({ headless: true, args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
const ctx = await b.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  acceptDownloads: true,
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
});
await ctx.route(/cloudflareinsights\.com/, (r) => (r.request().method() === "GET" ? r.continue() : r.fulfill({ status: 204, body: "" })));
const p = await ctx.newPage();
const errs = [];
p.on("pageerror", (e) => errs.push(`pageerror: ${e.message.slice(0, 160)}`));
p.on("console", (m) => { if (m.type() === "error" && !/cloudflareinsights|Failed to load resource/.test(m.text())) errs.push(`console: ${m.text().slice(0, 160)}`); });

let baseFont = null;
const snap = async (tag) => {
  await unlockCheck(p, tag, check);
  const f = await auditPage(p, COLUMNS);
  baseFont ??= f.font;
  await p.screenshot({ path: join(out, `${tag}.png`) });
  judge(f, tag, check, { baseFont, ignoreWidths: [".map"] });
};

try {
  await p.goto(url, { waitUntil: "load" });
  await p.waitForFunction(() => window.__cf?.state === "sample" && window.__cf.moments > 0, null, { timeout: 30000 });
  await p.waitForTimeout(800);
  await snap("0-rest");

  // What it costs is on the first phone screen, tall enough to tap, clear of the name and of the edge.
  // While the tool is free that is the word "Free" and no number; a number here would be an unapproved
  // price in front of a visitor, so the gate fails on one.
  {
    const t = await p.evaluate(() => {
      const el = document.getElementById("tag");
      const a = el.getBoundingClientRect();
      const brand = document.querySelector(".brand").getBoundingClientRect();
      return { text: el.textContent, top: a.top, bottom: a.bottom, h: a.height, right: a.right, gap: a.left - brand.right, vw: innerWidth, vh: innerHeight };
    });
    check(t.top >= 0 && t.bottom <= t.vh && t.h >= 44 && t.gap >= 8 && t.right <= t.vw - 15 && /free/i.test(t.text) && !/\$\d/.test(t.text), `what it costs is on the first screen: "${t.text.trim()}" (${Math.round(t.h)} px tall, ${Math.round(t.gap)} px from the name)`);
  }
  // The main button sits whole inside the first screen.
  {
    const m = await p.evaluate(() => {
      const r = document.querySelector(".btn.primary").getBoundingClientRect();
      return { below: Math.round(r.bottom - innerHeight), h: Math.round(r.height) };
    });
    check(m.below <= 0, `the main button is on the first screen (${m.below <= 0 ? `${-m.below} px of room` : `${m.below} px below`})`);
  }
  // A moment can be played from the list, and the list says what it is.
  {
    const first = await p.evaluate(() => {
      const li = document.querySelector(".moment");
      const go = li.querySelector(".go").getBoundingClientRect();
      return { at: li.querySelector(".at")?.textContent.trim(), says: li.querySelector(".says")?.textContent.trim(), why: li.querySelector(".why")?.textContent.trim(), tap: Math.round(Math.min(go.width, go.height)) };
    });
    check(first.tap >= 44, `the play button is ${first.tap} px`);
    check(/\d+:\d\d/.test(first.at ?? "") && (first.says ?? "").length > 5 && (first.why ?? "").length > 5, `a moment reads as "${first.at}" · "${(first.says ?? "").slice(0, 40)}…" · "${(first.why ?? "").slice(0, 40)}"`);
  }

  // Awkward names, at the moment they show.
  for (const n of NAMES) {
    await p.setInputFiles("#file", join(dir, n.name));
    await p.waitForFunction(() => window.__cf?.state === "reading", null, { timeout: 20000 });
    await p.waitForTimeout(500);
    await snap(`1-picked-${n.tag}`);
    const shown = await p.evaluate(() => ({ text: document.getElementById("clipname").textContent, title: document.getElementById("clipname").title }));
    check(shown.text.length <= 40 && (n.name.length <= 34 ? shown.text === n.name : shown.text.includes("…")) && shown.title === n.name, `${n.tag}: the name fits ("${shown.text}")`);
    // There is a way out while it is still reading, which is when someone would want one.
    check(await p.isVisible("#reset"), `${n.tag}: the way out is on screen while it reads`);
    await p.click("#reset");
    await p.waitForFunction(() => window.__cf?.state === "sample", null, { timeout: 10000 });
  }

  // A recording too short to cut up says so, rather than showing an empty list.
  await p.setInputFiles("#file", shortFile);
  await p.waitForFunction(() => window.__cf?.state === "found", null, { timeout: 900000, polling: 500 });
  await p.waitForTimeout(500);
  await snap("2-tooshort");
  check(!(await p.evaluate(() => window.__cf.moments)) && /too short/i.test(await p.evaluate(() => document.getElementById("s3t").textContent)), "a 40-second recording says it is too short to cut up");
  await p.click("#reset");
  await p.waitForFunction(() => window.__cf?.state === "sample", null, { timeout: 10000 });

  // The real run: reading, found, trimming, saved.
  await p.setInputFiles("#file", fixture);
  await p.waitForFunction(() => window.__cf?.state === "reading" && window.__cf.heardS > 30, null, { timeout: 300000, polling: 500 });
  await p.waitForTimeout(400);
  await snap("3-reading");
  await p.waitForFunction(() => window.__cf?.state === "found", null, { timeout: 900000, polling: 500 });
  await p.waitForTimeout(800);
  await snap("4-found");
  check(await p.evaluate(() => window.__cf.moments > 0), `${await p.evaluate(() => window.__cf.moments)} moments found`);

  await p.click(".moment:nth-child(1)");
  await p.waitForTimeout(400);
  await snap("5-trimming");
  {
    const t = await p.evaluate(() => {
      const row = document.querySelector('.moment[aria-current="true"] .trimrow');
      if (!row) return null;
      const sliders = [...row.querySelectorAll("input[type=range]")].map((i) => Math.round(i.getBoundingClientRect().height));
      return { shown: row.getBoundingClientRect().height > 0, sliders };
    });
    check(!!t?.shown && t.sliders.length === 2 && t.sliders.every((h) => h >= 44), `the trim handles show and are ${t?.sliders.join("/")} px tall`);
    const moved = await p.evaluate(async () => {
      const li = document.querySelector('.moment[aria-current="true"]');
      const before = window.__cf.list[Number(li.dataset.i)].startS;
      const s = li.querySelector(".ts");
      s.value = String(Number(s.value) - 30);
      s.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 200));
      return { before, after: window.__cf.list[Number(li.dataset.i)].startS, label: li.querySelector(".at").textContent.trim() };
    });
    check(moved.after < moved.before, `the start moved from ${moved.before} s to ${moved.after} s and the label says "${moved.label}"`);
  }
  await snap("5b-trimmed");

  // What a key opens is decided by the unlock worker, which is off this page: stubbed here, real everywhere else.
  await p.route(/unlock\.smaverk\.com\/entitlements/, (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "granted", tools: ["clipfinder"], expires: null }) }));
  await p.fill("#key", "SMVCF-TEST-0000-0000");
  await p.click("#keygo");
  await p.waitForFunction(() => window.__cf?.licensed === true, null, { timeout: 15000 });

  const [dl] = await Promise.all([p.waitForEvent("download", { timeout: 30000 }), p.click('[data-save="edl"]')]);
  await dl.saveAs(join(out, dl.suggestedFilename()));
  await p.waitForTimeout(400);
  await snap("6-saved");
  check(/saved/i.test(await p.evaluate(() => document.getElementById("rtitle").textContent)), `the saved box names the file (${dl.suggestedFilename()})`);

  if (errs.length) check(false, errs.join(" | "));
} catch (e) {
  check(false, String(e?.stack ?? e?.message ?? e));
} finally {
  // The paid panel is the one surface no state above reaches: at rest the page is locked and #paidpanel is hidden,
  // so it had shipped without a single tap-target pass. The key comes from SAMPLE_KEY in the shared unlock module,
  // at the length Polar actually issues — the overlapping tap targets only reproduced with a full-length key,
  // because that is what wraps, and a short stub would have shown a tidy panel and certified a state nobody saw.
  if (!(await p.evaluate(() => typeof window.__cf?.setLicensed === "function"))) {
    // Say what is wrong, not "setLicensed is not a function" from inside an evaluate. An audit that cannot reach
    // a state must fail loudly and name the reason: silently certifying a state it never saw is how the unlock
    // panel shipped unaudited in the first place.
    check(false, "this tool exposes no way to force the paid state (window.__cf.setLicensed), so the paid panel cannot be audited");
  } else {
    try {
      await p.evaluate(() => window.__cf.setLicensed(true));
      await p.waitForTimeout(250);
      await snap("9-paid");
      await p.evaluate(() => window.__cf.setLicensed(false));
    } catch (e) {
      check(false, `the paid panel could not be measured: ${String(e.message).slice(0, 110)}`);
    }
  }

  // What the guard saw, as data. A gate that fails with only screenshots costs whoever picks it up more than it
  // saves, so every state, width, control count and offending pair is written down (the lead, 2026-09-21).
  writeFileSync(join(out, "unlock-overlaps.json"), JSON.stringify({ tool: "clipfinder", states: overlaps }, null, 2));
  {
    const clashes = overlaps.filter((o) => o.bad.length);
    check(!clashes.length, clashes.length ? `${clashes.length} state(s) with overlapping controls — see unlock-overlaps.json` : `no overlapping controls in ${overlaps.length} states`);
  }

  await b.close();
  server?.kill();
}
if (fails.length) {
  console.error(`\n${fails.length} UI failure(s)`);
  process.exit(1);
}
console.log("phone UI gate ok");
