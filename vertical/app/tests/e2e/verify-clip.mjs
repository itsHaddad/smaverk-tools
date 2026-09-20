// verify-clip.mjs: the product gate. The moving-face fixture goes through the built page in headless Chromium: the tracker
// must find the face in most of the clip, the track must follow it (the face was placed by a known formula), the save must
// produce a real 9:16 mp4 of the right length, and the face must sit near the middle of the output frames.
// Usage: bun tests/e2e/verify-clip.mjs [url]   (no url: serves dist/ on 8802)
import { chromium } from "playwright";
import { spawn, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
const here = new URL(".", import.meta.url).pathname; const clip = here + "../fixtures/talk-moving-face.mp4";
let url = process.argv[2]; let server = null;
if (!url) { server = spawn("bun", [here + "../../serve.ts", "8802"], { stdio: "ignore" }); await new Promise((r) => setTimeout(r, 800)); url = "http://localhost:8802/"; }
const fails = []; const check = (ok, msg) => { console.log((ok ? "  ok   " : "  FAIL ") + msg); if (!ok) fails.push(msg); };
const b = await chromium.launch({ headless: true, args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
try {
  const p = await b.newPage({ viewport: { width: 430, height: 900 }, acceptDownloads: true });
  const errs = []; p.on("pageerror", (e) => errs.push("pageerror: " + e.message.slice(0, 160)));
  p.on("console", (m) => { if (m.type() === "error" && !/cloudflareinsights|Failed to load resource|TensorFlow Lite|XNNPACK/.test(m.text())) errs.push("console: " + m.text().slice(0, 160)); });
  p.on("requestfailed", (r) => { if (/sample\.mp4/.test(r.url()) && /ABORTED/.test(r.failure()?.errorText ?? "")) return; /* picking a clip cancels the sample that was still loading (seen on the fast runner) */ if (!/cloudflareinsights|unlock\.smaverk|^blob:/.test(r.url())) errs.push("request failed: " + r.url().slice(0, 120)); });
  await p.goto(url, { waitUntil: "load" });
  await p.waitForFunction(() => window.__vert && window.__vert.state === "sample", null, { timeout: 30000 });
  await p.setInputFiles("#file", clip);
  await p.waitForFunction(() => window.__vert.state === "loaded" && document.getElementById("video").duration > 0, null, { timeout: 20000 });
  const dur = await p.evaluate(() => document.getElementById("video").duration);
  const out = await p.evaluate(() => window.__vert.out);
  check(out && out.width === 608 && out.height === 1080, `output size for 1920x1080 is ${out?.width}x${out?.height}`);
  const t0 = Date.now(); await p.click("#action");
  await p.waitForFunction(() => window.__vert.state === "ready" || window.__vert.error, null, { timeout: 300000, polling: 300 });
  const tr = (Date.now() - t0) / 1000;
  const info = await p.evaluate(() => ({ error: window.__vert.error, detector: window.__vert.detector, detectorMs: window.__vert.detectorMs, scanMs: window.__vert.scanMs, looks: window.__vert.looks, found: window.__vert.found, bothFound: window.__vert.bothFound, measured: window.__vert.measured, n: window.__vert.track.length, track: window.__vert.track, samples: window.__vert.samples }));
  check(!info.error, `tracked in ${tr.toFixed(1)} s: tracker ${info.detector} (${info.detectorMs} ms), scan ${Math.round(info.scanMs / 1000)} s for a ${dur.toFixed(1)} s clip${info.error ? " ERROR " + info.error : ""}`);
  check(info.found >= 0.8, `face found in ${Math.round(info.found * 100)}% of the samples`);
  // the face was placed at x = 0.5 + 0.3*sin(2πt/12) (as a fraction of the width); the track must follow it within a margin and lag
  const truth = (t) => 0.5 + 0.3 * Math.sin((2 * Math.PI * t) / 12); let worst = 0, sum = 0, n = 0;
  for (const pt of info.track) { if (pt.t < 1) continue; const d = Math.abs(pt.cx - truth(pt.t - 0.35)); worst = Math.max(worst, d); sum += d; n++; }
  check(n > 40 && sum / n < 0.06 && worst < 0.14, `track follows the face: mean error ${(sum / n).toFixed(3)}, worst ${worst.toFixed(3)} of the width over ${n} points`);
  // save
  await p.evaluate(() => { window.__vert.fastOpts = { minSpeed: 0 }; });
  const [dl] = await Promise.all([p.waitForEvent("download", { timeout: 300000 }), p.click("#action")]);
  await p.waitForFunction(() => window.__vert.state === "exported" || window.__vert.exportError, null, { timeout: 300000, polling: 300 });
  const exp = await p.evaluate(() => ({ path: window.__vert.exportPath, codec: window.__vert.exportCodec, audio: window.__vert.exportAudio, frames: window.__vert.exportFrames, ms: Math.round(window.__vert.exportMs || 0), bytes: window.__vert.exportBytes, err: window.__vert.exportError, fastErr: window.__vert.fastSaveError, timing: JSON.stringify(window.__vert.exportTiming || {}), name: document.getElementById("rname").textContent }));
  const file = tmpdir() + "/vertical-" + dl.suggestedFilename(); await dl.saveAs(file);
  check(exp.path === "webcodecs" && !exp.err, `fast save used (${exp.path}; timing ${exp.timing}${exp.fastErr ? "; fast save error: " + exp.fastErr : ""}${exp.err ? "; export error: " + exp.err : ""})`);
  check(true, `save ran ${(dur / (exp.ms / 1000)).toFixed(1)}× real time: ${(exp.ms / 1000).toFixed(1)} s for ${dur.toFixed(1)} s, ${exp.frames} frames, ${exp.codec}, audio ${exp.audio}, ${(exp.bytes / 1e6).toFixed(1)} MB → ${dl.suggestedFilename()} (card: "${exp.name}")`);
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,nb_frames:format=duration", "-of", "json", file]).toString());
  const v = probe.streams.find((s) => s.codec_type === "video"), a = probe.streams.find((s) => s.codec_type === "audio"); const pd = +probe.format.duration;
  check(v && v.codec_name === "h264" && v.width === 608 && v.height === 1080 && +v.nb_frames > dur * 25, `video stream ${v?.codec_name} ${v?.width}x${v?.height}, ${v?.nb_frames} frames (9:16)`);
  check(a && a.codec_name === "aac", `audio stream ${a?.codec_name}`); check(Math.abs(pd - dur) < 1, `file length ${pd.toFixed(2)} s vs clip ${dur.toFixed(2)} s`);
  // the face must sit near the middle of the output: the portrait's face is a bright blob against a dark ground; measure the column of brightness at three times
  const centre = (t) => { const raw = execFileSync("ffmpeg", ["-v", "error", "-ss", String(t), "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-s", "76x135", "-"]); let sx = 0, sw = 0; for (let y = 0; y < 135; y++) for (let x = 0; x < 76; x++) { const b = raw[y * 76 + x]; if (b > 120) { sx += x * b; sw += b; } } return sw ? sx / sw / 76 : -1; };
  const cs = [3, 9, 15].map(centre); check(cs.every((c) => c > 0.3 && c < 0.7), `face near the middle of the output at 3, 9 and 15 s: ${cs.map((c) => c.toFixed(2)).join(", ")} of the width`);

  // ---- two people: the window follows whoever is talking (two podcast hosts, 2026-09-19; the study's six points) ----
  // The fixture is four seven-second turns of one locked two-shot joined end to end, so the turn boundaries are exact and
  // the truth file has the face positions and the silent quarter-seconds. Everything asserted here is measured, not guessed.
  await p.evaluate(() => window.vertical.two(true)); // off for visitors until it holds on clips nobody tuned it on (cold-user round 4); the gate keeps the work honest meanwhile
  const twoClip = here + "../fixtures/two-speakers-turns.mp4";
  const spec = JSON.parse(readFileSync(here + "../fixtures/two-speakers-turns.truth.json", "utf8"));
  const HALF = spec.faces.window_width_fraction / 2; // 0.158: the talking face is inside the window while it is within half a window of the centre
  const speakerAt = (t) => spec.turns.find((x) => t >= x.from && t < x.to)?.speaker ?? spec.turns[spec.turns.length - 1].speaker;
  const faceAt = (t, who) => { const seg = spec.faces.per_segment.find((x) => t >= x.from && t < x.to) ?? spec.faces.per_segment[spec.faces.per_segment.length - 1]; return seg[who].cx; };
  const truthX = (t) => faceAt(t, speakerAt(t));
  await p.setInputFiles("#file", twoClip);
  await p.waitForFunction(() => window.__vert.state === "loaded" && document.getElementById("video").duration > 0, null, { timeout: 20000 });
  const dur2 = await p.evaluate(() => document.getElementById("video").duration);
  const t2 = Date.now(); await p.click("#action");
  await p.waitForFunction(() => window.__vert.state === "ready" || window.__vert.error, null, { timeout: 300000, polling: 300 });
  const two = await p.evaluate(() => ({ error: window.__vert.error, scanMs: window.__vert.scanMs, looks: window.__vert.looks, bothFound: window.__vert.bothFound, switches: window.__vert.switches, found: window.__vert.found, audio: window.__vert.audio, audioError: window.__vert.audioError, combined: window.__vert.combined, crowd: window.__vert.crowd, measured: window.__vert.measured, samples: window.__vert.speakerSamples, n: window.__vert.track.length }));
  check(!two.error, `two-speaker clip tracked in ${((Date.now() - t2) / 1000).toFixed(1)} s: scan ${Math.round(two.scanMs / 1000)} s for ${dur2.toFixed(1)} s, sound ${two.audio}${two.audioError ? " (" + two.audioError + ")" : ""}${two.error ? " ERROR " + two.error : ""}`);
  // The open question of the study, answered by the run itself: does one window hold both faces, or does each need its own?
  console.log(`  note   one window for both faces: ${two.combined?.hits ?? 0} hits, ${two.combined?.misses ?? 0} misses, still used: ${two.combined?.used}; samples whose mouths were measured ${two.measured}; samples with three or more faces ${two.crowd}`);
  const oneCost = info.scanMs / 1000 / dur, twoCost = two.scanMs / 1000 / dur2;
  { const blind = info.samples.filter((s) => s.x === null).map((s) => s.t); if (blind.length) console.log(`  note   the one-speaker clip found nobody at ${blind.length} samples: ${blind.slice(0, 12).join(", ")}`); }
  console.log(`  note   the one-speaker clip: ${info.looks} looks, ${Math.round(info.scanMs / 1000)} s of scan (before this feature: 10 s, 0.50 s per second), two faces in ${Math.round((info.bothFound ?? 0) * 100)}% of its samples, mouths measured in ${info.measured} of ${info.samples.length} samples`);
  console.log(`  note   cost: one speaker ${info.looks} looks, ${oneCost.toFixed(2)} s of scan per second of clip; two speakers ${two.looks} looks, ${twoCost.toFixed(2)} s per second — ${(twoCost / oneCost).toFixed(2)}× (over 2.2× means the single-window path is worth forcing)`);
  check(two.bothFound >= 0.8, `two faces found in ${Math.round((two.bothFound ?? 0) * 100)}% of the samples`);
  // where the window actually is, asked of the page so the answer is the one the preview and the save use (cuts do not interpolate)
  const times = two.samples.map((s) => s.t);
  const centres = await p.evaluate((ts) => ts.map((t) => window.__vert.centreAt(t).cx), times);
  const silent = new Set(spec.voicing.silent_at);
  const settled = times.map((t, i) => ({ t, cx: centres[i], voiced: !silent.has(t), fresh: spec.changes.some((c) => t >= c && t < c + 1.5) })).filter((x) => x.voiced && !x.fresh);
  const inside = settled.filter((x) => Math.abs(x.cx - truthX(x.t)) <= HALF), near = settled.filter((x) => Math.abs(x.cx - truthX(x.t)) <= 0.08);
  check(inside.length / settled.length >= 0.9, `the talking man is inside the window in ${((inside.length / settled.length) * 100).toFixed(1)}% of the ${settled.length} settled voiced samples (${settled.length - inside.length} outside)`);
  console.log(`  note   within 0.08 of his face in ${((near.length / settled.length) * 100).toFixed(1)}% (a warning below 75%, not a failure)`);
  const sw = two.switches ?? [];
  const lags = spec.changes.map((c, i) => (sw[i] === undefined ? null : +(sw[i] - c).toFixed(2)));
  check(sw.length === 3 && lags.every((l) => l !== null && l >= 0 && l <= 2), `exactly 3 switches, each within 2 s after a real change: ${sw.join(", ")} (lags ${lags.join(", ")})`);
  check(sw.every((t, i) => i === 0 || t - sw[i - 1] >= 1.5), `no two switches closer than 1.5 s apart`);
  // and the same thing in the file that leaves the page: the saved frame must match the crop around the man who is talking
  await p.evaluate(() => { window.__vert.fastOpts = { minSpeed: 0 }; });
  const [dl2] = await Promise.all([p.waitForEvent("download", { timeout: 300000 }), p.click("#action")]);
  await p.waitForFunction(() => window.__vert.state === "exported" || window.__vert.exportError, null, { timeout: 300000, polling: 300 });
  const file2 = tmpdir() + "/vertical-two-" + dl2.suggestedFilename(); await dl2.saveAs(file2);
  const exp2 = await p.evaluate(() => ({ path: window.__vert.exportPath, err: window.__vert.exportError, fastErr: window.__vert.fastSaveError }));
  check(!exp2.err, `two-speaker clip saved (${exp2.path}${exp2.fastErr ? "; fast save gave up: " + exp2.fastErr : ""})`);
  const grey = (src, t, vf) => execFileSync("ffmpeg", ["-v", "error", "-ss", String(t), "-i", src, "-vf", (vf ? vf + "," : "") + "scale=64:113", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-"]);
  const apart = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };
  const cropAt = (t, who) => grey(twoClip, t, `crop=406:720:${Math.max(0, Math.min(spec.width - 406, Math.round(faceAt(t, who) * spec.width - 203)))}:0`);
  const shows = [3, 10, 17, 24].map((t) => { const who = speakerAt(t); const saved = grey(file2, t);
    const mine = apart(saved, cropAt(t, who)), other = apart(saved, cropAt(t, who === "left" ? "right" : "left"));
    return { t, who, ok: mine < other, mine: +mine.toFixed(1), other: +other.toFixed(1) }; });
  check(shows.every((s) => s.ok), `the saved file shows the man who is talking at 3, 10, 17 and 24 s: ${shows.map((s) => `${s.t}s ${s.who} ${s.mine} vs ${s.other}`).join(", ")}`);
  check(!errs.length, `page errors: ${errs.length ? errs.join(" || ") : "none"}`);
  if (fails.length) { // when something failed, the per-sample numbers are what tell you why: print them once, at the end
    console.log("  data   t voiced faces talk[left,right] pick centre truth");
    for (const [i, s] of two.samples.entries()) console.log(`    ${s.t.toFixed(2)} ${s.voiced ? "v" : "-"} ${s.faces} [${String(s.talk[0] ?? "-").slice(0, 5)},${String(s.talk[1] ?? "-").slice(0, 5)}] ${s.pick ?? "-"} ${centres[i]?.toFixed(3)} ${truthX(s.t).toFixed(3)}`);
  }
} catch (e) { check(false, "crashed: " + String(e?.message ?? e).slice(0, 300)); }
await b.close(); server?.kill();
if (fails.length) { console.error(`CLIP FAIL (${fails.length})`); process.exit(1); }
console.log("clip ok");
