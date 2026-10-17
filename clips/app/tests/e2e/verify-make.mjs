// verify-make.mjs: the product gate. A five-minute recording with a face and a voice goes through the built page, and
// what the page promises is checked against the files that came out.
//
//   bun tests/e2e/verify-make.mjs
//
//   1. The moments are found and the strongest three are ticked; each is 90 seconds or less.
//   2. Two clips are made, one at a time, and a save writes a real file: 9:16, a sound track, the moment's
//      length (ffprobe), and captions drawn on its frames.
//   3. Every clip saves, with no key and nothing paid (free since 2026-10-17): a second save writes a second file.
//   4. No price, checkout or key box on the page; the one support link goes to Polar in its own tab.
//   5. Nothing carrying the recording leaves the page: every host is accounted for, no body over 8 KB.
import { chromium } from "playwright";
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeFixture } from "./fixture.mjs";

const port = 8827;
const here = new URL(".", import.meta.url).pathname;
const root = join(here, "..", "..");
const outDir = join(root, "tests", "e2e", "out");
mkdirSync(outDir, { recursive: true });
const fixture = makeFixture(root);

const server = spawn("bun", [join(root, "serve.ts"), String(port)], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));
let failed = false;
const fail = (m) => { console.error(`MAKE FAIL: ${m}`); failed = true; };
const ok = (m) => console.log(`  ok  ${m}`);
const probe = (f) => JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height:format=duration", "-of", "json", f]).toString());

async function waitSaying(page, what, fn, ms) {
  const t0 = Date.now(); let last = "";
  const tick = setInterval(async () => {
    try {
      const s = await page.evaluate(() => `${window.__clips.state} made=${(window.__clips.made ?? []).length} ${document.getElementById("steps").innerText.replace(/\s+/g, " ").slice(0, 120)}`);
      if (s !== last) console.log(`      ${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s  ${s}`);
      last = s;
    } catch { /* busy */ }
  }, 20000);
  try { await page.waitForFunction(fn, null, { timeout: ms, polling: 1000 }); return true; }
  catch { fail(`${what} did not happen in ${Math.round(ms / 1000)} s: ${await page.evaluate(() => JSON.stringify({ ...window.__clips, list: undefined })).catch(() => "")}`); return false; }
  finally { clearInterval(tick); }
}

let browser;
try {
  browser = await chromium.launch({ args: ["--no-sandbox"] });
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  await ctx.route(/cloudflareinsights\.com/, (r) => (r.request().method() === "GET" ? r.continue() : r.fulfill({ status: 204, body: "" })));
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  // 404s are reported by the response handler with their address; the speech engine prints its own "[WARNING]" lines as errors.
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|^\[WARNING\]/.test(m.text())) errs.push(`console: ${m.text().slice(0, 200)}`); });
  page.on("response", (r) => { if (r.status() >= 400 && !/cloudflareinsights|unlock\.smaverk|polar\.sh/.test(r.url())) errs.push(`${r.status()} ${r.url()}`); });
  const sent = [];
  page.on("request", (r) => { if (/^(blob|data):/.test(r.url())) return; /* the page reading its own finished clip, not the network */ const u = new URL(r.url()); const body = r.postData(); if (u.host !== `localhost:${port}` || body) sent.push({ host: u.host, bytes: body ? body.length : 0, url: r.url().slice(0, 100) }); });

  await page.goto(`http://localhost:${port}/`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__clips?.state === "sample", null, { timeout: 20000 });

  // 1. Finding.
  await page.setInputFiles("#file", fixture);
  if (!(await waitSaying(page, "finding the moments", () => window.__clips.state === "found", 1_500_000))) throw new Error("no list");
  const list = await page.evaluate(() => window.__clips.list);
  if (!list.length) throw new Error("no moments in a five-minute talk");
  if (list.filter((m) => m.keep).length !== Math.min(3, list.length)) fail(`${list.filter((m) => m.keep).length} ticked of ${list.length}`);
  if (list.some((m) => m.endS - m.startS > 90)) fail(`a moment runs over 90 s: ${JSON.stringify(list.map((m) => m.endS - m.startS))}`);
  ok(`${list.length} moments, the strongest ${list.filter((m) => m.keep).length} ticked, every one 90 s or less`);

  // 2. Making two (not three: a gate's minutes are better spent on the checks than on the third clip, which the runner proof makes).
  await page.evaluate(() => { for (let i = 2; i < window.__clips.list.length; i++) window.clips.keep(i, false); window.clips.keep(0, true); if (window.__clips.list.length > 1) window.clips.keep(1, true); });
  const want = await page.evaluate(() => window.__clips.kept);
  await page.click("#action");
  if (!(await waitSaying(page, "making the clips", () => window.__clips.state === "made", 1_500_000))) throw new Error("not made");
  const made = await page.evaluate(() => window.__clips.made);
  if (made.length !== want) fail(`${made.length} clips made of ${want}`);

  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 20000 }), page.click(".moment .save")]);
  const f = join(outDir, dl.suggestedFilename());
  await dl.saveAs(f);
  const p = probe(f), m = made[0];
  const v = p.streams.find((s) => s.codec_type === "video"), a = p.streams.find((s) => s.codec_type === "audio");
  const dur = Number(p.format.duration), len = m.endS - m.startS;
  if (!v || Math.abs(v.width / v.height - 9 / 16) > 0.01) fail(`the saved clip is ${v?.width}x${v?.height}, not 9:16`);
  else if (!a) fail("the saved clip has no sound");
  else if (Math.abs(dur - len) > 0.5) fail(`the saved clip is ${dur.toFixed(2)} s; the moment is ${len.toFixed(2)} s`);
  else if (!(m.words > 0 && m.captionFrames > m.frames * 0.3)) fail(`captions: ${m.words} words, drawn on ${m.captionFrames} of ${m.frames} frames`);
  else ok(`${dl.suggestedFilename()}: ${v.width}x${v.height}, ${a.codec_name} sound, ${dur.toFixed(2)} s for a ${len.toFixed(2)} s moment, ${m.words} words, captions on ${m.captionFrames}/${m.frames} frames; cut ${m.ms.cut} ms, frame ${m.ms.frame} ms, listen ${m.ms.listen} ms, save ${m.ms.save} ms`);

  // 3. Every clip saves: the second one too.
  if (made.length > 1) {
    const [dl2] = await Promise.all([page.waitForEvent("download", { timeout: 20000 }), page.click(".moment:nth-child(2) .save")]);
    const f2 = join(outDir, dl2.suggestedFilename());
    await dl2.saveAs(f2);
    const v2 = probe(f2).streams.find((s) => s.codec_type === "video");
    if (!v2 || Math.abs(v2.width / v2.height - 9 / 16) > 0.01) fail(`the second clip is ${v2?.width}x${v2?.height}, not 9:16`);
    else ok(`the second clip saves too, with no key: ${dl2.suggestedFilename()}`);
  }

  // 4. No price, checkout or key box; one support link to Polar, in its own tab.
  {
    const s = await page.evaluate(() => ({ href: document.querySelector("#support a")?.href ?? "", tab: document.querySelector("#support a")?.target, gates: ["price", "buy", "keyrow", "paidpanel"].filter((id) => document.getElementById(id)), money: document.body.innerText.match(/\$\d+/g) ?? [] }));
    if (s.gates.length) fail(`a price or key box is on the page: ${s.gates.join(", ")}`);
    else if (s.money.length) fail(`the page states a price: ${s.money.join(", ")}`);
    else if (!/^https:\/\/buy\.polar\.sh\//.test(s.href) || s.tab !== "_blank") fail(`the support link is missing or opens in this tab: "${s.href}"`);
    else ok("no price or key box, and one support link to Polar in its own tab");
  }

  // 5. Nothing left with the recording.
  const ALLOWED = /^(huggingface\.co|[\w.-]*\.hf\.co|cdn\.jsdelivr\.net|static\.cloudflareinsights\.com|cloudflareinsights\.com|events\.smaverk\.com|localhost:\d+)$/;
  const strangers = sent.filter((s) => !ALLOWED.test(s.host)), heavy = sent.filter((s) => s.bytes > 8192);
  if (strangers.length) fail(`requests to hosts nothing accounts for: ${JSON.stringify(strangers.slice(0, 4))}`);
  if (heavy.length) fail(`requests carrying more than 8 KB: ${JSON.stringify(heavy.slice(0, 4))}`);
  if (!strangers.length && !heavy.length) ok(`${sent.length} request(s) off the page's own files, every host accounted for, the largest body ${Math.max(0, ...sent.map((s) => s.bytes))} bytes`);


  if (errs.length) fail(errs.join(" | "));
  await page.screenshot({ path: join(outDir, "made.png"), fullPage: true });
} catch (e) {
  fail(String(e?.stack ?? e?.message ?? e));
} finally {
  await browser?.close();
  server.kill();
}
if (failed) process.exit(1);
console.log("make gate ok");
