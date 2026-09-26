// sample.mjs: a real recording through the built page, on a runner, and what came out measured.
//
//   node tools/sample.mjs --video recording.mp4 --out out/proof [--sample] [--keep 3]
//
// It serves dist/, opens it in Chromium, picks the recording, waits for the moments, makes the strongest three
// (the page's default), and takes the finished clips out of the page. Each one is checked with ffprobe: 9:16, a
// sound track, a length that matches the moment, and captions drawn on its frames. The browser's whole process
// tree is sampled from outside every second, the way the clip-length report measured Captions (peak RSS), so the
// memory a phone would need is a number, not a guess.
//
// With --sample it also writes the page's sample: the moments, each clip whole (its card states its length, so the file
// plays that long), a poster, and the three side by side for the studio card. The clips are the tool's own output,
// re-encoded smaller for the web.
//
// Run with node, not bun: the page is served by bun, the browser is driven from node (as the other gates' remote rigs are).
import { chromium } from "playwright";
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const arg = (n, d = "") => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const video = resolve(arg("video"));
const out = resolve(arg("out", "out/proof"));
const writeSample = process.argv.includes("--sample");
const root = resolve(new URL("..", import.meta.url).pathname);
if (!arg("video")) { console.error("usage: node tools/sample.mjs --video <file> --out <dir> [--sample]"); process.exit(2); }
mkdirSync(out, { recursive: true });

const probe = (f, entries) => JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", entries, "-of", "json", f]).toString());
const src = probe(video, "stream=codec_type,width,height,r_frame_rate:format=duration");
console.log(`recording: ${Math.round(Number(src.format.duration))} s, ${src.streams.filter((s) => s.width).map((s) => `${s.width}x${s.height}`).join(",")}`);

// ---- memory, from outside ------------------------------------------------------------------------------
const mem = { peakTotalMB: 0, peakOneMB: 0, byPhase: {}, samples: [] };
let phase = "load";
const sampleMem = () => {
  try {
    const rows = execFileSync("ps", ["-eo", "rss=,args="]).toString().split("\n").filter((l) => /ms-playwright|chrom(e|ium)|headless_shell/.test(l) && !/ps -eo/.test(l));
    const rss = rows.map((l) => Number(l.trim().split(/\s+/)[0]) / 1024).filter((n) => n > 0);
    const total = rss.reduce((a, b) => a + b, 0), one = Math.max(0, ...rss);
    mem.peakTotalMB = Math.max(mem.peakTotalMB, total);
    mem.peakOneMB = Math.max(mem.peakOneMB, one);
    const p = (mem.byPhase[phase] ??= { peakTotalMB: 0, peakOneMB: 0 });
    p.peakTotalMB = Math.max(p.peakTotalMB, total); p.peakOneMB = Math.max(p.peakOneMB, one);
    mem.samples.push([Math.round(performance.now() / 1000), phase, Math.round(total), Math.round(one)]);
  } catch { /* ps failed once; the next second samples again */ }
};
const memTimer = setInterval(sampleMem, 1000);

const port = 8829;
const server = spawn("bun", [join(root, "serve.ts"), String(port)], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 1000));
const fails = [];
const fail = (m) => { console.error(`PROOF FAIL: ${m}`); fails.push(m); };
const ok = (m) => console.log(`  ok  ${m}`);
const report = { video: arg("video"), source: src, started: new Date().toISOString() };

async function waitSaying(page, what, fn, ms) {
  const t0 = Date.now(); let last = "";
  const tick = setInterval(async () => {
    try {
      const s = await page.evaluate(() => ({ state: window.__clips.state, heard: Math.round(window.__clips.heardS ?? 0), made: (window.__clips.made ?? []).length, steps: document.getElementById("steps").innerText.replace(/\s+/g, " ").slice(0, 160), status: document.getElementById("status").textContent }));
      const line = JSON.stringify(s);
      if (line !== last) console.log(`      ${String(Math.round((Date.now() - t0) / 1000)).padStart(5)}s ${line}  mem ${Math.round(mem.peakTotalMB)} MB`);
      last = line;
    } catch { /* busy */ }
  }, 20000);
  try { await page.waitForFunction(fn, null, { timeout: ms, polling: 1000 }); return true; }
  catch { fail(`${what} did not happen in ${Math.round(ms / 1000)} s`); return false; }
  finally { clearInterval(tick); }
}

let browser;
try {
  browser = await chromium.launch({ args: ["--no-sandbox"] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.route(/cloudflareinsights\.com/, (r) => (r.request().method() === "GET" ? r.continue() : r.fulfill({ status: 204, body: "" })));
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  // 404s are reported by the response handler with their address; the speech engine prints its own "[WARNING]" lines as errors.
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|^\[WARNING\]/.test(m.text())) errs.push(`console: ${m.text().slice(0, 200)}`); });
  page.on("response", (r) => { if (r.status() >= 400 && !/cloudflareinsights|unlock\.smaverk|polar\.sh/.test(r.url())) errs.push(`${r.status()} ${r.url()}`); });
  const sent = [];
  page.on("request", (r) => { const body = r.postData(); if (body && body.length > 8192) sent.push({ url: r.url().slice(0, 100), bytes: body.length }); });

  await page.goto(`http://localhost:${port}/`, { waitUntil: "load" });
  await page.waitForFunction(() => !!window.__clips, null, { timeout: 20000 });

  phase = "find";
  const t0 = Date.now();
  await page.setInputFiles("#file", video);
  if (!(await waitSaying(page, "finding the moments", () => window.__clips.state === "found" || !!window.__clips.error, 3_600_000))) throw new Error("no moments");
  const found = await page.evaluate(() => ({ list: window.__clips.list, kept: window.__clips.kept, findMs: window.__clips.findMs, error: window.__clips.error }));
  if (found.error) throw new Error(`finding failed: ${found.error}`);
  report.find = { seconds: Math.round((Date.now() - t0) / 1000), moments: found.list.length, list: found.list };
  ok(`${found.list.length} moments in ${report.find.seconds} s, ${found.kept} ticked: ${found.list.filter((m) => m.keep).map((m) => `${m.startS.toFixed(1)}–${m.endS.toFixed(1)}`).join(", ")}`);
  if (found.kept !== 3) fail(`${found.kept} moments ticked by default, not 3`);

  phase = "make";
  const t1 = Date.now();
  await page.evaluate(() => { void window.clips.make(); }); // not awaited here: the wait below reports progress
  await waitSaying(page, "making the clips", () => window.__clips.state === "made", 3_600_000);
  const made = await page.evaluate(() => ({ made: window.__clips.made, makeMs: window.__clips.makeMs, error: window.__clips.error }));
  report.make = { seconds: Math.round((Date.now() - t1) / 1000), error: made.error ?? null };
  if (made.error) fail(`a clip failed: ${made.error}`);
  if (made.made.length !== 3) fail(`${made.made.length} clips made, not 3`);

  phase = "check";
  report.clips = [];
  for (const m of made.made) {
    // The clip, out of the page as the page holds it: the same bytes Save would write.
    const b64 = await page.evaluate(async (i) => {
      const url = window.clips.url(i);
      const blob = await (await fetch(url)).blob();
      const buf = new Uint8Array(await blob.arrayBuffer()); let s = "";
      for (let k = 0; k < buf.length; k += 0x8000) s += String.fromCharCode(...buf.subarray(k, k + 0x8000));
      return btoa(s);
    }, m.i);
    const f = join(out, m.name);
    writeFileSync(f, Buffer.from(b64, "base64"));
    const p = probe(f, "stream=codec_type,codec_name,width,height,duration,sample_rate:format=duration");
    const v = p.streams.find((s) => s.codec_type === "video"), a = p.streams.find((s) => s.codec_type === "audio");
    const dur = Number(p.format.duration), want = m.endS - m.startS;
    const row = { name: m.name, startS: m.startS, endS: m.endS, wantS: +want.toFixed(2), ffprobeS: +dur.toFixed(2), width: v?.width, height: v?.height, video: v?.codec_name, audio: a ? `${a.codec_name} ${a.sample_rate} Hz` : null, words: m.words, captionFrames: m.captionFrames, frames: m.frames, bytes: m.bytes, found: m.found, ms: m.ms };
    report.clips.push(row);
    const ratio = v ? v.width / v.height : 0;
    if (!v || Math.abs(ratio - 9 / 16) > 0.01) fail(`${m.name}: ${v?.width}x${v?.height} is not 9:16`);
    if (!a) fail(`${m.name}: no sound track`);
    if (Math.abs(dur - want) > 0.5) fail(`${m.name}: ffprobe says ${dur.toFixed(2)} s, the moment is ${want.toFixed(2)} s`);
    if (!(m.words > 0) || !(m.captionFrames > m.frames * 0.3)) fail(`${m.name}: ${m.words} words, captions on ${m.captionFrames} of ${m.frames} frames`);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", String(Math.min(8, dur / 2)), "-i", f, "-frames:v", "1", join(out, m.name.replace(/\.mp4$/, ".png"))]);
    ok(`${m.name}: ${v?.width}x${v?.height} ${v?.codec_name}, ${row.audio}, ${dur.toFixed(2)} s against ${want.toFixed(2)} s, ${m.words} words, captions on ${m.captionFrames}/${m.frames} frames, ${(m.bytes / 1e6).toFixed(1)} MB; cut ${m.ms.cut} ms, frame ${m.ms.frame} ms, listen ${m.ms.listen} ms, save ${m.ms.save} ms`);
  }
  if (sent.length) fail(`requests carrying more than 8 KB left the page: ${JSON.stringify(sent.slice(0, 3))}`);
  if (errs.length) fail(`page errors: ${errs.slice(0, 5).join(" | ")}`);
  await page.screenshot({ path: join(out, "made.png"), fullPage: true });

  if (writeSample) {
    const dist = join(root, "dist");
    const moments = [];
    for (const [k, c] of report.clips.entries()) {
      const name = `sample-${k + 1}.mp4`;
      execFileSync("ffmpeg", ["-v", "error", "-y", "-i", join(out, c.name), "-vf", "scale=432:768:flags=lanczos", "-c:v", "libx264", "-profile:v", "main", "-preset", "slow", "-crf", "26", "-maxrate", "450k", "-bufsize", "900k", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "64k", "-movflags", "+faststart", join(dist, name)]);
      const m = found.list.find((x) => Math.abs(x.startS - c.startS) < 0.01);
      const opening = await page.evaluate((i) => document.querySelectorAll(".moment .says")[i]?.textContent ?? "", made.made[k].i);
      moments.push({ startS: c.startS, endS: c.endS, why: m?.why ?? [], opening, clip: name, lengthS: c.ffprobeS });
    }
    execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", "3", "-i", join(dist, "sample-1.mp4"), "-frames:v", "1", "-q:v", "4", join(dist, "poster.jpg")]);
    // The studio card: the three clips side by side, which is nearly 16:9 — the card's own shape.
    const parts = report.clips.map((c) => ["-t", "12", "-i", join(out, c.name)]).flat();
    execFileSync("ffmpeg", ["-v", "error", "-y", ...parts, "-filter_complex", "[0:v]scale=240:426,setsar=1[a];[1:v]scale=240:426,setsar=1[b];[2:v]scale=240:426,setsar=1[c];[a][b][c]hstack=inputs=3[v]", "-map", "[v]", "-an", "-c:v", "libx264", "-preset", "slow", "-crf", "30", "-pix_fmt", "yuv420p", "-movflags", "+faststart", join(dist, "sample-strip.mp4")]);
    writeFileSync(join(dist, "sample.json"), JSON.stringify({ title: arg("title", "Astronaut interview from space, 15 min"), credit: arg("credit", "NASA, 10 May 2024 — public domain"), url: arg("url", "https://images.nasa.gov/details/iss071m261311538_NASA_Astronaut_Matt_Dominick_Talks_with_KMGH_Denver_240510"), durationS: Math.round(Number(src.format.duration) * 10) / 10, poster: "poster.jpg", moments }, null, 1));
    ok(`wrote the page's sample: ${moments.length} clips, poster, strip`);
  }
} catch (e) {
  fail(String(e?.stack ?? e));
} finally {
  clearInterval(memTimer);
  await browser?.close();
  server.kill();
}
report.memory = { peakTotalMB: Math.round(mem.peakTotalMB), peakOneProcessMB: Math.round(mem.peakOneMB), byPhase: Object.fromEntries(Object.entries(mem.byPhase).map(([k, v]) => [k, { peakTotalMB: Math.round(v.peakTotalMB), peakOneProcessMB: Math.round(v.peakOneMB) }])) };
report.fails = fails;
writeFileSync(join(out, "report.json"), JSON.stringify({ ...report, memSamples: mem.samples }, null, 1));
console.log(`memory: peak ${report.memory.peakTotalMB} MB for the whole browser, ${report.memory.peakOneProcessMB} MB in one process; by phase ${JSON.stringify(report.memory.byPhase)}`);
if (fails.length) { console.error(`${fails.length} failure(s)`); process.exit(1); }
console.log("proof ok");
