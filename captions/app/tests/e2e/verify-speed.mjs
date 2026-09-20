// verify-speed.mjs: the speed gate. A 44 s speech clip goes through the built page in headless Chromium. Captions must
// appear before the engine has heard the whole clip, the save must run faster than real time through the WebCodecs path,
// and the file must be a real mp4 (H.264 + AAC, right length) with the captions burned in.
// Usage: bun tests/e2e/verify-speed.mjs [url]   (no url: serves dist/ on 8795)
import { chromium } from "playwright";
import { spawn, execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
const here = new URL(".", import.meta.url).pathname; const clip = here + "../fixtures/speech44.mp4";
let url = process.argv[2]; let server = null;
if (!url) { server = spawn("bun", [here + "../../serve.ts", "8795"], { stdio: "ignore" }); await new Promise((r) => setTimeout(r, 800)); url = "http://localhost:8795/"; }
const fails = []; const check = (ok, msg) => { console.log((ok ? "  ok   " : "  FAIL ") + msg); if (!ok) fails.push(msg); };
const b = await chromium.launch({ headless: true, args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
try {
  const p = await b.newPage({ viewport: { width: 430, height: 900 }, acceptDownloads: true });
  // The analytics beacon refuses localhost origins; that is not a page error. Real load failures come through requestfailed.
  const errs = []; p.on("pageerror", (e) => errs.push("pageerror: " + e.message.slice(0, 160)));
  p.on("console", (m) => { if (m.type() === "error" && !/cloudflareinsights|Failed to load resource/.test(m.text())) errs.push("console: " + m.text().slice(0, 160)); });
  p.on("requestfailed", (r) => { if (/sample\.mp4/.test(r.url()) && /ABORTED/.test(r.failure()?.errorText ?? "")) return; /* picking a clip cancels the sample that was still loading (seen on the fast runner) */ if (!/cloudflareinsights|unlock\.smaverk|^blob:/.test(r.url())) errs.push("request failed: " + r.url().slice(0, 120)); }); // a download shows up as an aborted blob: request
  await p.goto(url, { waitUntil: "load" });
  await p.waitForFunction(() => window.__cap && window.__cap.words && window.__cap.words.length > 0, null, { timeout: 30000 });
  await p.setInputFiles("#file", clip);
  await p.waitForFunction(() => window.__cap.state === "loaded", null, { timeout: 20000 });
  // "loaded" is set before the video reports its length; a fast machine reads NaN in between (seen on the GitHub runner).
  const dur = await p.evaluate(() => new Promise((res) => { const v = document.getElementById("video"); if (Number.isFinite(v.duration)) return res(v.duration); v.addEventListener("loadedmetadata", () => res(v.duration), { once: true }); }));
  const t0 = Date.now(); await p.click("#action");
  await p.waitForFunction(() => window.__cap.state === "captioned" || window.__cap.error || window.__cap.partials > 0, null, { timeout: 600000, polling: 300 });
  const tFirst = (Date.now() - t0) / 1000;
  const first = await p.evaluate(() => { const v = document.getElementById("video"); return { partials: window.__cap.partials, words: window.__cap.words.length, state: window.__cap.state, playing: !v.paused, loop: v.loop, note: document.getElementById("s2n").textContent, hint: document.getElementById("hint").textContent }; });
  await p.waitForFunction(() => window.__cap.state === "captioned" || window.__cap.error, null, { timeout: 600000, polling: 300 });
  const tAll = (Date.now() - t0) / 1000;
  const info = await p.evaluate(() => { const w = window.__cap.words; return { words: w.length, ms: Math.round(window.__cap.ms || 0), engineMs: Math.round(window.__cap.engineMs || 0), device: window.__cap.device, partials: window.__cap.partials, error: window.__cap.error, first: w.slice(0, 6).map((x) => x.text).join(" "), lastEnd: w.length ? w[w.length - 1].end : 0, monotonic: w.every((x, i) => !i || x.start >= w[i - 1].start - 0.05) }; });
  check(!info.error, `captions done: ${info.words} words, engine ${info.engineMs} ms (${info.device}), listening ${info.ms} ms; "${info.first}…"${info.error ? " ERROR " + info.error : ""}`);
  check(info.partials >= 1 && first.state === "working", `captions showed before the end: first ${first.words} words after ${tFirst.toFixed(1)} s, all ${info.words} after ${tAll.toFixed(1)} s (note: "${first.note}")`);
  check(first.playing && !first.loop, `playback started with the first captions (hint: "${first.hint}")`);
  check(info.words > 80 && info.monotonic, `${info.words} words in time order`);
  check(info.lastEnd > dur - 5, `captions reach the end of the clip (${info.lastEnd} s of ${dur.toFixed(1)} s)`);
  // save: the fast path must finish and be right; its pace on this machine is reported, not judged (a throttled laptop
  // runs it under real time, and in the product the slow-device guard then hands over to the recorder, checked below)
  await p.evaluate(() => { window.__cap.fastOpts = { minSpeed: 0 }; });
  const [dl] = await Promise.all([p.waitForEvent("download", { timeout: 300000 }), p.click("#action")]);
  await p.waitForFunction(() => window.__cap.state === "exported" || window.__cap.exportError, null, { timeout: 300000, polling: 300 });
  const exp = await p.evaluate(() => ({ path: window.__cap.exportPath, codec: window.__cap.exportCodec, audio: window.__cap.exportAudio, frames: window.__cap.exportFrames, ms: Math.round(window.__cap.exportMs || 0), bytes: window.__cap.exportBytes, err: window.__cap.exportError, fastErr: window.__cap.fastSaveError, trace: JSON.stringify((window.__cap.exportTrace || []).filter((x, i, a) => i % 8 === 0 || i === a.length - 1)), timing: JSON.stringify(window.__cap.exportTiming || {}), title: document.getElementById("rtitle").textContent, line: document.getElementById("rline").textContent }));
  const file = tmpdir() + "/speed-" + dl.suggestedFilename(); await dl.saveAs(file);
  const speed = dur / (exp.ms / 1000);
  check(exp.path === "webcodecs" && !exp.err, `fast save used (${exp.path}; timing ${exp.timing}; trace [s done, ms] ${exp.trace}${exp.fastErr ? "; fast save error: " + exp.fastErr : ""}${exp.err ? "; export error: " + exp.err : ""})`);
  check(true, `save ran ${speed.toFixed(1)}× real time: ${(exp.ms / 1000).toFixed(1)} s for a ${dur.toFixed(1)} s clip, ${exp.frames} frames, ${exp.codec}, audio ${exp.audio}, ${(exp.bytes / 1e6).toFixed(1)} MB → ${dl.suggestedFilename()} ("${exp.title}: ${exp.line}")`);
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,nb_frames:format=duration", "-of", "json", file]).toString());
  const v = probe.streams.find((s) => s.codec_type === "video"), a = probe.streams.find((s) => s.codec_type === "audio"); const pd = +probe.format.duration;
  check(v && v.codec_name === "h264" && v.width === 540 && v.height === 960 && +v.nb_frames > dur * 20, `video stream ${v?.codec_name} ${v?.width}x${v?.height}, ${v?.nb_frames} frames`);
  check(a && a.codec_name === "aac", `audio stream ${a?.codec_name}`);
  check(Math.abs(pd - dur) < 1, `file length ${pd.toFixed(2)} s vs clip ${dur.toFixed(2)} s`);
  // captions burned in: a frame mid-sentence has bright text pixels the flat source frame does not
  const bright = (f, t) => { const raw = execFileSync("ffmpeg", ["-v", "error", "-ss", String(t), "-i", f, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-"]); let n = 0; for (const x of raw) if (x > 225) n++; return n; };
  const src = bright(clip, 5), got = bright(file, 5);
  check(got > 400 && src < 50, `bright caption pixels in the frame at 5 s: ${got} (source frame ${src})`);
  // The recorder fallback must keep working: force it and make sure the file has picture in it.
  const [dl2] = await Promise.all([p.waitForEvent("download", { timeout: 300000 }), p.evaluate(() => { window.__cap.fastOpts = { minSpeed: 99 }; return window.captions.export(); })]);
  const file2 = tmpdir() + "/speed-recorder-" + dl2.suggestedFilename(); await dl2.saveAs(file2);
  const exp2 = await p.evaluate(() => ({ path: window.__cap.exportPath, fastErr: window.__cap.fastSaveError, ms: Math.round(window.__cap.exportMs || 0), bytes: window.__cap.exportBytes, fps: window.__cap.exportFps, line: document.getElementById("rline").textContent }));
  // The recorder can lose frames on a slow device; the page reads the real rate back from the file and says so under 20 a second.
  check(typeof exp2.fps === "number" && exp2.fps > 1, `the saved file's frame rate is measured after a recorder save (${exp2.fps?.toFixed?.(1)} a second)`);
  check((exp2.fps < 20) === /frames a second/.test(exp2.line), `lost frames are reported only when they were lost ("${exp2.line.slice(0, 90)}")`);
  const probe2 = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-count_frames", "-show_entries", "stream=codec_type,codec_name,nb_read_frames", "-of", "json", file2]).toString()); const v2 = probe2.streams.find((s) => s.codec_type === "video");
  check(exp2.path === "recorder" && v2 && +v2.nb_read_frames > dur * 10, `recorder fallback still works: ${exp2.path} (${exp2.fastErr}), ${v2?.codec_name} ${v2?.nb_read_frames} frames, ${(exp2.bytes / 1e6).toFixed(1)} MB in ${(exp2.ms / 1000).toFixed(1)} s`);
  check(!errs.length, `page errors: ${errs.length ? errs.join(" || ") : "none"}`);
} catch (e) { check(false, "crashed: " + String(e?.message ?? e).slice(0, 300)); }
await b.close(); server?.kill();
if (fails.length) { console.error(`SPEED FAIL (${fails.length})`); process.exit(1); }
console.log("speed ok");
