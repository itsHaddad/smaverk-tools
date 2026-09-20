// Captions in the browser: Whisper (transformers.js, loaded on demand) + canvas overlay + WebCodecs export (recorder fallback).
// Nothing leaves the device. A sample clip with pre-computed timings shows the result before anyone picks a file.

import { buildLines, lineAt as lineAtIn, type Line, type Word } from "./src/lib/lines";
import { outputBase, fitName } from "./src/lib/naming";
import { toMono16k, estimateFactor } from "./src/lib/audio";
import { fastSave, canFastSave, savedFps } from "./src/fastsave";
import { attachSeek } from "./src/seek";
import { Unlock, type UnlockState } from "./src/lib/unlock";
type Style = "bar" | "karaoke" | "big";
type State = "sample" | "loaded" | "working" | "captioned" | "exporting" | "exported";

// Sample files are fetched under the page's version (app.js?v=…), so a replaced sample reaches visitors at once: Cloudflare's edge
// kept serving a year-old "immutable" sample.mp4 after it was replaced (2026-09-18).
const ASSET_V = (() => { try { return new URL(import.meta.url).search; } catch { return ""; } })();
const SANDBOX = new URLSearchParams(location.search).get("rail") === "sandbox";
const RAIL = SANDBOX
  ? { link: "https://sandbox-api.polar.sh/v1/checkout-links/polar_cl_cr0egFs5EiYRoVHF9bm5AZghunw0Lnoe43szJ0ptTkQ/redirect" }
  : { link: "https://buy.polar.sh/polar_cl_EmfkZumlwFomZ7kIizVE6Xh0WnY0AEmn8LaS10NaemR" };
if (RAIL.link) for (const id of ["buy", "rbuy"]) (document.getElementById(id) as HTMLAnchorElement).href = RAIL.link; // the price box and the Saved box open the same checkout
const UNLOCK = "https://unlock.smaverk.com"; // the unlock worker: the only address this page knows about keys
const DEBUG = new URLSearchParams(location.search).has("debug");
const limit = () => (licensed ? 300 : 60); // seconds: free 60, paid 300
let capY: number | null = null; // where the person dragged the captions to (0 = top, 1 = bottom); null = the style's default
let capX: number | null = null; // sideways position of the caption centre (0 = left, 1 = right); null = centred

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const stage = $("stage"), video = $<HTMLVideoElement>("video"), canvas = $<HTMLCanvasElement>("canvas"), poster = $<HTMLImageElement>("poster");
const action = $<HTMLButtonElement>("action"), file = $<HTMLInputElement>("file"), status = $("status"), trust = $("trust"), reset = $<HTMLButtonElement>("reset");
const clipname = $("clipname"), hint = $("hint"), steps = $("steps"), result = $("result"), share = $<HTMLButtonElement>("share"), again = $<HTMLAnchorElement>("again");
const sound = $<HTMLButtonElement>("sound"), soundtxt = $("soundtxt"), playicon = $("playicon");
const seek = $<HTMLInputElement>("seek"); attachSeek(seek, $("seekbar"), video);
const chips = [...document.querySelectorAll<HTMLButtonElement>(".chip")];
const ctx = canvas.getContext("2d")!;

let words: Word[] = [], state: State = "sample", style: Style = "bar", currentFile: File | null = null, asr: any = null, licensed = false;
let sampleWords: Word[] = []; let chipsDrawn = false; let lastBlob: Blob | null = null; let lastName = "";
const dbg: any = ((window as any).__cap = { words: [] as Word[] });
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

// ---------- state and copy ----------
const LABEL: Record<State, string> = { sample: "Use my own clip", loaded: "Add captions", working: "Working…", captioned: "Save video", exporting: "Saving…", exported: "Caption another clip" };
function setState(s: State) {
  seek.hidden = s === "working" || s === "exporting"; // no scrubbing while the clip is being read or written
  state = s; action.textContent = LABEL[s]; action.disabled = s === "working" || s === "exporting";
  stage.classList.toggle("busy", s === "working" || s === "exporting"); // no play badge and no taps while the clip is read or written: a tap during a recorded save moved the playhead
  reset.hidden = s === "sample" || s === "exported"; trust.hidden = s !== "sample";
  hint.textContent = s === "sample" ? "Tap a style. Drag the captions to move." : s === "captioned" ? "Playing with captions. Drag them to move." : s === "exported" ? "Change the style or position and save again" : "";
  if (s !== "exported") result.classList.remove("on");
  editwords.hidden = !(s === "captioned" || s === "exported"); if (editwords.hidden) { wordlist.hidden = true; editwords.textContent = "Fix a word"; }
  action.classList.toggle("stuck", (s === "loaded" || s === "captioned") && wordlist.hidden); // sticky on phones only while it is the next step: a disabled "Working…" covered the named steps, and "Save video" covered the word box (design review 2, cold user 4)
  dbg.state = s;
}
const say = (t: string, tone: boolean | "ok" = false) => { status.textContent = t; status.className = "status" + (tone === true ? " err" : tone ? " ok" : ""); }; // true: something went wrong; "ok": good news

// ---------- sample at rest ----------
(async () => {
  // The look this page opens in: ?style= wins, then the page's own default (the search pages set data-style on <body>), then Bar.
  const url = new URL(location.href); const pre = (url.searchParams.get("style") ?? document.body.dataset.style) as Style | null; if (pre && ["bar", "karaoke", "big"].includes(pre)) pickStyle(pre);
  try { sampleWords = await (await fetch("sample-words.json" + ASSET_V)).json(); } catch { sampleWords = []; }
  words = sampleWords; dbg.words = words;
  video.src = "sample.mp4" + ASSET_V; video.muted = true; video.loop = true;
  video.play().catch(() => {});
  loadLicense();
})();

video.addEventListener("loadedmetadata", () => {
  const ar = video.videoWidth / video.videoHeight || 9 / 16;
  stage.style.setProperty("--ar", String(ar)); stage.parentElement!.style.setProperty("--ar", String(ar)); canvas.width = video.videoWidth; canvas.height = video.videoHeight;
});
video.addEventListener("playing", () => { stage.classList.add("playing"); poster.hidden = true; });
video.addEventListener("pause", () => stage.classList.remove("playing"));
video.addEventListener("ended", () => stage.classList.remove("playing"));
// Tap = play/pause. Drag up or down = move the captions.
{ const tap = $("tap"); let y0 = 0, moved = false, down = false;
  tap.addEventListener("pointerdown", (e) => { down = true; moved = false; y0 = e.clientY; tap.setPointerCapture(e.pointerId); });
  let x0 = 0;
  tap.addEventListener("pointerdown", (e) => { x0 = e.clientX; });
  tap.addEventListener("pointermove", (e) => { if (!down) return; if (!moved && Math.abs(e.clientY - y0) < 8 && Math.abs(e.clientX - x0) < 8) return; moved = true; const r = stage.getBoundingClientRect(); capY = Math.min(0.92, Math.max(0.08, (e.clientY - r.top) / r.height)); capX = Math.min(0.85, Math.max(0.15, (e.clientX - r.left) / r.width)); dbg.capY = capY; dbg.capX = capX; touched(); });
  tap.addEventListener("pointerup", () => { if (!down) return; down = false; if (moved || state === "exporting") return; video.paused ? video.play().catch(() => {}) : video.pause(); });
  tap.addEventListener("pointercancel", () => { down = false; }); }
sound.addEventListener("click", () => { video.muted = !video.muted; sound.setAttribute("aria-pressed", String(!video.muted)); soundtxt.textContent = video.muted ? "Sound off" : "Sound on"; sound.setAttribute("aria-label", video.muted ? "Sound is off. Turn it on" : "Sound is on. Turn it off"); if (video.paused) video.play().catch(() => {}); });

// ---------- drawing ----------
const FONT = '"Bricolage Grotesque", ui-sans-serif, system-ui, sans-serif';
let lines: Line[] = []; let linesFor: Word[] | null = null; let linesLen = 0;
function lineAt(t: number, span = 6) { if (linesFor !== words || linesLen !== words.length) { lines = buildLines(words); linesFor = words; linesLen = words.length; } return lineAtIn(lines, t, span); }
function relines() { linesFor = null; }
function paint(c: CanvasRenderingContext2D, W: number, H: number, t: number, st: Style, mark: boolean, source: CanvasImageSource | null, thumb = false, keep = false) {
  if (!keep) c.clearRect(0, 0, W, H); if (source) c.drawImage(source, 0, 0, W, H);
  const line = lineAt(t, thumb ? 3 : 6); const fs = Math.round(Math.min(W, H) * (thumb ? 0.17 : 0.075));
  c.textAlign = "center"; c.textBaseline = "middle"; c.lineJoin = "round";
  if (line) {
    const text = line.ws.map((w) => w.text).join(" ");
    const yPos = thumb || capY === null ? (st === "big" ? 0.71 : st === "bar" ? 0.76 : 0.74) : capY; // defaults sit above the bottom fifth that Reels and TikTok cover with their own text and buttons
    const cx = thumb || capX === null ? W / 2 : W * capX;
    if (st === "bar") {
      c.font = `700 ${fs}px ${FONT}`; const y = H * yPos; const w = Math.min(W - fs, c.measureText(text).width + fs);
      c.fillStyle = "rgba(10,10,14,.78)"; roundRect(c, cx - w / 2, y - fs * 0.85, w, fs * 1.7, fs * 0.35); c.fillStyle = "#fff"; fitText(c, text, W - fs * 1.6, fs, 700); c.fillText(text, cx, y);
    } else if (st === "karaoke") {
      c.font = `800 ${fs}px ${FONT}`; fitText(c, text, W - fs, fs, 800); const y = H * yPos;
      let x = cx - c.measureText(text).width / 2; c.textAlign = "left"; c.lineWidth = fs * 0.22; c.strokeStyle = "rgba(10,10,14,.9)";
      line.ws.forEach((w, i) => { const s = w.text + " "; c.fillStyle = i === line.cur ? "#FFD84D" : "#fff"; c.strokeText(s, x, y); c.fillText(s, x, y); x += c.measureText(s).width; });
      c.textAlign = "center";
    } else {
      const big = Math.round(fs * 1.45); c.font = `800 ${big}px ${FONT}`; const y = H * yPos; c.lineWidth = big * 0.24; c.strokeStyle = "rgba(10,10,14,.92)"; c.fillStyle = "#fff";
      wrap(c, text, W - big).forEach((ln, i, arr) => { const yy = y + (i - (arr.length - 1) / 2) * big * 1.12; c.strokeText(ln, cx, yy); c.fillText(ln, cx, yy); });
    }
  }
  if (mark) { c.font = `700 ${Math.round(Math.min(W, H) * 0.035)}px ${FONT}`; c.textAlign = "right"; c.lineWidth = 3; c.strokeStyle = "rgba(0,0,0,.5)"; c.fillStyle = "rgba(255,255,255,.85)"; c.strokeText("smaverk.com", W - 12, H - 16); c.fillText("smaverk.com", W - 12, H - 16); }
}
function fitText(c: CanvasRenderingContext2D, text: string, maxW: number, fs: number, wt: number) { let f = fs; while (f > fs * 0.5 && c.measureText(text).width > maxW) { f -= 2; c.font = `${wt} ${f}px ${FONT}`; } }
function wrap(c: CanvasRenderingContext2D, text: string, maxW: number) { const out: string[] = []; let cur = ""; for (const w of text.split(" ")) { const t = cur ? cur + " " + w : w; if (c.measureText(t).width > maxW && cur) { out.push(cur); cur = w; } else cur = t; } if (cur) out.push(cur); return out.slice(0, 3); }
function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) { c.beginPath(); c.roundRect(x, y, w, h, r); c.fill(); }

function drawChips() {
  if (chipsDrawn || video.readyState < 2 || !words.length) return;
  const w = words[Math.min(4, words.length - 1)]; const saved = words;
  for (const ch of chips) { const cv = ch.querySelector("canvas")!; const cc = cv.getContext("2d")!; const W = cv.width, H = cv.height;
    cc.save(); const ar = video.videoWidth / video.videoHeight; const sw = ar > W / H ? video.videoHeight * (W / H) : video.videoWidth; const sh = ar > W / H ? video.videoHeight : video.videoWidth / (W / H);
    cc.drawImage(video, (video.videoWidth - sw) / 2, (video.videoHeight - sh) / 2, sw, sh, 0, 0, W, H); cc.restore();
    words = saved; paint(cc, W, H, (w.start + w.end) / 2, ch.dataset.style as Style, false, null, true);
  }
  chipsDrawn = true;
}
let markTick = 0;
let fastSaving = false; // the stage stays as it is during the fast save so the encoder has the whole CPU; the recorder fallback needs the repaint
(function loop() { if (video.readyState >= 2 && !fastSaving) { paint(ctx, canvas.width, canvas.height, video.currentTime, style, !licensed, video); if (!chipsDrawn && video.currentTime > 0.3 && words.length) drawChips(); if (!wordlist.hidden && ++markTick % 10 === 0) markLine(); } requestAnimationFrame(loop); })(); // the stage stays as it is while a save runs, so the encoder has the whole CPU
document.fonts?.load(`800 40px ${FONT}`).then(() => { chipsDrawn = false; }).catch(() => {});

// Fixing a misheard word: the list under the stage is editable; timings stay, an emptied word is dropped.
const wordlist = $("wordlist"), editwords = $<HTMLButtonElement>("editwords");
// Fix mode: the video pauses, the words of the line on screen are highlighted in the list, tapping a word jumps the
// video to it so you see the frame, and you retype in place. Enter or tapping elsewhere keeps the change; an emptied word is dropped.
function renderWords() { wordlist.replaceChildren(...words.map((w, i) => { const el = document.createElement("span"); el.className = "w"; el.contentEditable = "true"; el.textContent = w.text; el.dataset.i = String(i); el.title = `${w.start.toFixed(1)} s`; return el; })); }
function markLine() { if (wordlist.hidden) return; const line = lineAt(video.currentTime, 99); const on = new Set(line?.idx ?? []); let first: HTMLElement | null = null; for (const el of wordlist.children as any as HTMLElement[]) { const hit = on.has(Number(el.dataset.i)); el.classList.toggle("on", hit); if (hit && !first) first = el; } if (first && document.activeElement !== first && !wordlist.contains(document.activeElement)) first.scrollIntoView({ block: "nearest" }); }
wordlist.addEventListener("pointerdown", (e) => { const el = (e.target as HTMLElement).closest(".w") as HTMLElement | null; if (!el) return; const w = words[Number(el.dataset.i)]; if (w) { video.pause(); video.currentTime = w.start + 0.05; } });
wordlist.addEventListener("input", (e) => { const el = e.target as HTMLElement; const i = Number(el.dataset.i); if (words[i]) { words[i].text = el.textContent?.trim() ?? ""; relines(); touched(); } });
wordlist.addEventListener("focusout", (e) => { const el = e.target as HTMLElement; const i = Number(el.dataset.i); if (words[i] && !words[i].text) { words.splice(i, 1); relines(); renderWords(); } });
wordlist.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLElement).blur(); } });
editwords.addEventListener("click", () => { wordlist.hidden = !wordlist.hidden; if (!wordlist.hidden) { renderWords(); video.pause(); markLine(); wordlist.scrollIntoView({ block: "nearest", behavior: "smooth" }); } else video.play().catch(() => {}); editwords.textContent = wordlist.hidden ? "Fix a word" : "Done fixing"; action.classList.toggle("stuck", (state === "loaded" || state === "captioned") && wordlist.hidden); });
// After a save, changing anything (style, position, a word) makes the clip saveable again: the action goes back to "Save video".
function touched() { if (state === "exported") { setState("captioned"); if (video.paused) video.play().catch(() => {}); } }
function pickStyle(s: Style) { style = s; for (const ch of chips) ch.setAttribute("aria-pressed", String(ch.dataset.style === s)); dbg.style = s; touched(); }
for (const ch of chips) ch.addEventListener("click", () => pickStyle(ch.dataset.style as Style));

// A name in a one-line box: shortened in the middle to the box's real width, measured with the box's own font. Re-fitted on resize.
const named = new Map<HTMLElement, string>();
function showName(el: HTMLElement, full: string) {
  named.set(el, full); el.title = full; el.textContent = full;
  const c = document.createElement("canvas").getContext("2d"); if (!c) return; c.font = getComputedStyle(el).font;
  const room = Math.max(40, el.clientWidth - 2); el.textContent = fitName(full, (t) => c.measureText(t).width <= room);
}
addEventListener("resize", () => { for (const [el, full] of named) if (el.isConnected) showName(el, full); });
// ---------- own clip ----------
function load(f: File) {
  currentFile = f; words = []; dbg.words = words; chipsDrawn = false; lastBlob = null; video.pause();
  // Show the clip right away: muted playback starts inside the file-pick gesture, so phones do not sit on a black frame until a tap.
  video.src = URL.createObjectURL(f); video.loop = true; video.muted = true; sound.setAttribute("aria-pressed", "false"); soundtxt.textContent = "Sound off"; sound.setAttribute("aria-label", "Sound is off. Turn it on");
  video.play().catch(() => {});
  showName(clipname, f.name); poster.hidden = true; steps.classList.remove("on");
  video.onloadedmetadata = () => { canvas.width = video.videoWidth || 720; canvas.height = video.videoHeight || 1280; stage.style.setProperty("--ar", String((video.videoWidth || 9) / (video.videoHeight || 16)));
    const d = video.duration; const first = engineReady || engineCached ? "" : " First time here: the tool downloads to your device once (about 45 MB) and stays. Nothing goes the other way.";
    if (isFinite(d) && d > limit() + 1) say(licensed ? `That clip is longer than five minutes, so this captions the first five.` + first : `That clip is longer than 60 seconds, so this captions the first minute. The paid version takes up to five minutes.` + first); else say((isFinite(d) ? `${Math.round(d)}-second clip loaded.` : "Clip loaded.") + first); };
  video.onerror = () => say("That file could not be opened. Try an mp4 or mov from your camera roll.", true);
  setState("loaded");
}
let warming = false;
// iPhone and iPad: WASM only until WebGPU is proven on a real device (ONNX Runtime's WebGPU path blows up memory on WebKit 26, microsoft/onnxruntime#26827, real-device reports as late as 2026-09-02).
const ENGINE_FORCE = isIOS ? "wasm" : undefined;
function warmEngine() { if (engineReady || warming) return; warming = true; try { const w = engine(); w.addEventListener("message", (e) => { if (e.data?.type === "ready") dbg.engineWarm = true; else if (e.data?.type === "error") dbg.engineWarmError = e.data.message; }); w.postMessage({ type: "load", force: ENGINE_FORCE }); dbg.warmed = true; } catch {} }
// The engine starts downloading the moment the picker opens or the demo is touched, so it is usually ready by the time a clip is chosen.
file.addEventListener("click", warmEngine); // opening the file picker is the intent; the download runs while the person chooses a clip. Tapping a style or the stage on the SAMPLE is not: the sample ships with its words (cold user, 2026-09-19: a style tap pulled 46 MB with no warning).
// On a decent connection the engine also starts by itself a few seconds after the page is up, so the first clip has no wait.
// Data saver and slow networks keep the download for the first sign of intent.
// No download before the visitor shows intent (design review of the search pages, 2026-09-19): a timed warm-up 3 s after the sample played pulled 46 MB for
// visitors who only looked, against a 2 MB budget, and search visitors bounce most. Picking a file, a style or the stage still starts it early.
file.addEventListener("click", () => { if (isPhone) say("Pick a clip. Your phone prepares the file before handing it over; that can take a moment. Nothing is sent anywhere."); });
file.addEventListener("change", () => { const f = file.files?.[0]; if (f) load(f); file.value = ""; });
reset.addEventListener("click", () => { file.click(); });

action.addEventListener("click", async () => {
  if (state === "sample" || state === "exported") return file.click();
  if (state === "loaded") return run();
  if (state === "captioned") return exportVideo();
});

// Reading the sound. iPhone camera files are QuickTime containers that Safari's own decodeAudioData refuses
// (a version-1 sample entry with a 'wave' box), so the first path demuxes and decodes with WebCodecs through
// Mediabunny, still entirely on the device. decodeAudioData is the fallback, then an audio-only remux + decode.
async function decodeViaWebCodecs(f: File, maxSeconds: number): Promise<Float32Array> {
  const mb = await import("mediabunny");
  const input = new mb.Input({ source: new mb.BlobSource(f), formats: [mb.MP4, mb.QTFF, mb.MATROSKA, mb.WEBM] });
  try {
    const track = await input.getPrimaryAudioTrack(); if (!track) throw new Error("no audio track");
    if (!(await track.canDecode())) throw new Error(`cannot decode ${track.codec ?? "unknown"} here`);
    const sink = new mb.AudioSampleSink(track); const parts: Float32Array[][] = []; let rate = track.sampleRate; let total = 0;
    for await (const s of sink.samples(0, maxSeconds)) { rate = s.sampleRate; const ab = s.toAudioBuffer(); const chs: Float32Array[] = []; for (let c = 0; c < ab.numberOfChannels; c++) chs.push(ab.getChannelData(c)); parts.push(chs); total += ab.length; s.close(); if (total >= rate * maxSeconds) break; }
    if (!total) throw new Error("no audio samples");
    const nch = parts[0].length; const chs = Array.from({ length: nch }, () => new Float32Array(total)); let off = 0;
    for (const p of parts) { for (let c = 0; c < nch; c++) chs[c].set(p[Math.min(c, p.length - 1)], off); off += p[0].length; }
    return toMono16k(chs, rate, maxSeconds);
  } finally { try { input.dispose?.(); } catch {} }
}
function decodeData(ac: AudioContext, data: ArrayBuffer): Promise<AudioBuffer> {
  // Safari sometimes rejects the promise form for files the callback form decodes.
  return new Promise((res, rej) => { try { const p = ac.decodeAudioData(data, res, (e) => rej(e ?? new Error("decodeAudioData failed"))); if (p && typeof (p as any).catch === "function") (p as any).catch(() => {}); } catch (e) { rej(e); } });
}
async function decodeViaAudioContext(data: ArrayBuffer, maxSeconds: number): Promise<Float32Array> {
  let ac: AudioContext; try { ac = new AudioContext({ sampleRate: 16000 }); } catch { ac = new AudioContext(); }
  try { const buf = await decodeData(ac, data.slice(0)); const chs: Float32Array[] = []; for (let c = 0; c < buf.numberOfChannels; c++) chs.push(buf.getChannelData(c)); return toMono16k(chs, buf.sampleRate, maxSeconds); }
  finally { await ac.close().catch(() => {}); }
}
async function remuxAudioOnly(f: File): Promise<ArrayBuffer> {
  const mb = await import("mediabunny");
  const input = new mb.Input({ source: new mb.BlobSource(f), formats: [mb.MP4, mb.QTFF, mb.MATROSKA, mb.WEBM] });
  const output = new mb.Output({ format: new mb.Mp4OutputFormat({ fastStart: "in-memory" }), target: new mb.BufferTarget() });
  const conv = await mb.Conversion.init({ input, output, video: { discard: true }, showWarnings: false } as any);
  await conv.execute(); const buf = (output.target as any).buffer as ArrayBuffer | null; try { input.dispose?.(); } catch {}
  if (!buf) throw new Error("remux produced nothing"); return buf;
}
async function decodeAudio(f: File): Promise<Float32Array> {
  const max = limit(); const tried: string[] = [];
  try { const a = await decodeViaWebCodecs(f, max); dbg.decode = "webcodecs"; return a; } catch (e: any) { tried.push("webcodecs: " + (e?.message ?? e)); }
  const data = await f.arrayBuffer();
  try { const a = await decodeViaAudioContext(data, max); dbg.decode = "decodeAudioData"; return a; } catch (e: any) { tried.push("decodeAudioData: " + (e?.name ?? "") + " " + (e?.message ?? e)); }
  try { const a = await decodeViaAudioContext(await remuxAudioOnly(f), max); dbg.decode = "remux+decodeAudioData"; return a; } catch (e: any) { tried.push("remux: " + (e?.message ?? e)); }
  throw Object.assign(new Error(tried.join(" | ")), { stage: "sound" });
}

function step(n: 1 | 2 | 3, mode: "active" | "done" | "off", note = "") { const el = $(`s${n}`); el.className = "step" + (mode === "off" ? "" : " " + mode); $(`s${n}n`).textContent = note; }
// The engine runs in a worker so the page keeps breathing (timers tick, taps work) while it downloads, compiles and listens.
let worker: Worker | null = null; let engineReady = false; let engineCached = false;
(async () => { try { engineCached = await caches.has("transformers-cache"); } catch {} })();
function engine() { if (!worker) worker = new Worker(new URL("./worker.js", location.href), { type: "module" }); return worker; }
function ask<T>(msg: any, transfer: Transferable[], onMsg: (m: any) => T | undefined): Promise<T> {
  return new Promise((res, rej) => { const w = engine(); const on = (e: MessageEvent) => { const m = e.data; if (m.type === "error") { w.removeEventListener("message", on); rej(new Error(m.message)); return; } const r = onMsg(m); if (r !== undefined) { w.removeEventListener("message", on); res(r); } }; w.addEventListener("message", on); w.postMessage(msg, transfer); });
}
async function run() {
  if (!currentFile) return; setState("working"); say(""); steps.classList.remove("done"); steps.classList.add("on"); step(1, "active"); step(2, "off"); step(3, "off"); $("s3t").textContent = "Done";
  try {
    stageNow = "engine";
    if (!engineReady) {
      const s1 = $("s1t"); const bar1 = $("s1b").parentElement!; let setupTick: any = null; const tStart = performance.now();
      // Two visible phases: the download (real percentage), then the one-time setup where the engine compiles on the device (elapsed seconds, moving bar).
      const r = await ask<{ device: string; model: string }>({ type: "load", force: ENGINE_FORCE }, [], (m) => {
        if (m.type === "progress" && !setupTick) { $("s1b").style.width = m.pct + "%"; step(1, "active", `${m.pct}% of ${Math.round(m.total / 1e6)} MB, to your device`); }
        else if (m.type === "phase" && m.phase === "setup" && !setupTick) { s1.textContent = "Setting up on your device"; bar1.classList.add("pulse"); const t1 = performance.now(); const show = () => step(1, "active", `one time, ${Math.round((performance.now() - t1) / 1000)} s so far`); show(); setupTick = setInterval(show, 1000); }
        else if (m.type === "ready") { if (setupTick) clearInterval(setupTick); bar1.classList.remove("pulse"); dbg.engineBytes = m.bytes || 0; return { device: m.device, model: m.model }; }
      });
      engineReady = true; dbg.device = r.device; dbg.model = r.model; dbg.engineMs = performance.now() - tStart;
      s1.textContent = "The tool is on your device";
    }
    step(1, "done", "ready");
    stageNow = "sound"; step(2, "active", "reading the sound");
    const audio = await decodeAudio(currentFile);
    stageNow = "listen";
    // Estimate from the last run on this device when there is one; otherwise a cautious guess (WASM is slow on phones).
    const secs = audio.length / 16000; const factor = estimateFactor(dbg.device, navigator.hardwareConcurrency, dbg.ms, dbg.lastSecs);
    const est = Math.max(4, Math.round(secs * factor)); dbg.lastSecs = secs;
    const t0 = performance.now(); const elapsed = () => Math.round((performance.now() - t0) / 1000);
    let upTo = 0, done = 0, of = 0; dbg.partials = 0; words = []; dbg.words = words; relines();
    const left = () => (done ? Math.round((elapsed() / done) * (of - done)) : est - elapsed()); // once a window is done the pace is measured, not guessed
    const note = () => (upTo ? `captions to ${Math.round(upTo)} s, ` : "") + (left() > 0 ? `about ${left()} s left` : `still working, ${elapsed()} s`);
    step(2, "active", note()); const tick = setInterval(() => step(2, "active", note()), 1000);
    // The engine hears the clip in 30 s windows and sends each window's words as soon as it has them. The first batch starts
    // playback from the top, so the person watches captions on the part already heard while the rest is still being listened to.
    const onRun = (m: any) => {
      if (m.type === "partial") {
        if (!dbg.partials++) { dbg.firstPartialMs = performance.now() - t0; hint.textContent = "Captions appear as each part is heard."; video.loop = false; video.currentTime = 0; video.play().catch(() => {}); }
        words = words.concat(m.words); dbg.words = words; relines(); upTo = m.upTo; done = m.done; of = m.of; step(2, "active", note()); return;
      }
      if (m.type === "restart") { words = []; dbg.words = words; relines(); upTo = 0; done = 0; return; }
      if (m.type === "result") return { words: m.words as Word[], ms: m.ms as number };
    };
    let got: { words: Word[]; ms: number };
    try {
      const audioCopy = dbg.device === "webgpu" ? audio.slice() : null; // kept for a retry on a fresh engine if the GPU path fails mid-run
      try { got = await ask<{ words: Word[]; ms: number }>({ type: "run", audio }, [audio.buffer], onRun); }
      catch (e) {
        if (!audioCopy) throw e;
        // A WebGPU session can break on a second clip (seen: "Buffer was destroyed before mapping was resolved"). Start a fresh worker on WASM and try once more.
        dbg.gpuFallback = String((e as any)?.message ?? e); worker?.terminate(); worker = null; engineReady = false; words = []; dbg.words = words; relines(); upTo = 0; done = 0;
        step(2, "active", "one moment"); const s1 = $("s1t"); s1.textContent = "Setting up again";
        const r = await ask<{ device: string }>({ type: "load", force: "wasm" }, [], (m) => (m.type === "ready" ? { device: m.device } : undefined));
        engineReady = true; dbg.device = r.device; s1.textContent = "The tool is on your device";
        got = await ask<{ words: Word[]; ms: number }>({ type: "run", audio: audioCopy }, [audioCopy.buffer], onRun);
      }
    } finally { clearInterval(tick); }
    words = got.words; dbg.words = words; dbg.ms = got.ms; relines();
    step(2, "done", `${(got.ms / 1000).toFixed(0)} s`);
    if (!words.length) { step(3, "done"); $("s3t").textContent = "We could not hear any speech in that clip."; setState("loaded"); return; }
    // A receipt the person can check against the browser's own network tab: bytes came in (engine), nothing carried the clip out.
    relines(); step(3, "done", `${words.length} words`); $("s3t").textContent = "Done."; steps.classList.add("done"); // the panel stays on with this one line (it was switched off as it was written: design review 7 of Vertical, same code)
    setState("captioned"); video.loop = false; if (!dbg.partials) { video.currentTime = 0; video.play().catch(() => {}); }
    if (matchMedia("(max-width: 899px)").matches) clipname.parentElement!.scrollIntoView({ block: "start", behavior: "smooth" }); // the clip name stays in view above the stage
  } catch (e: any) {
    dbg.error = String(e?.message ?? e); dbg.stage = e?.stage ?? stageNow; steps.classList.remove("on"); setState("loaded");
    const human = dbg.stage === "sound" ? "Could not read the sound in that clip." : dbg.stage === "engine" ? "Could not get the tool ready." : "Something went wrong while listening to the clip.";
    const detail = `${navigator.userAgent}\nstage: ${dbg.stage}\nmode: ${dbg.device ?? "?"}\nerror: ${dbg.error}\nfile: ${currentFile?.name} ${currentFile?.type} ${currentFile?.size}`;
    status.className = "status err"; status.replaceChildren(
      document.createTextNode(human + " Try again, or another file. "),
      Object.assign(document.createElement("a"), { href: "mailto:hello@smaverk.com?subject=" + encodeURIComponent("Captions: it failed on my clip") + "&body=" + encodeURIComponent(detail), textContent: "Send me the details" }),
      document.createTextNode(" and I will fix it."),
      Object.assign(document.createElement("small"), { textContent: ` (${dbg.stage}: ${String(dbg.error).slice(0, 160)})`, style: "display:block;opacity:.7;font-size:13px;margin-top:4px" }));
  }
}
let stageNow: "engine" | "sound" | "listen" = "engine";

// ---------- export ----------
// Slow path, kept as the fallback: play the clip once and record the canvas and its sound in real time.
let recCtx: AudioContext | null = null, recSrc: MediaElementAudioSourceNode | null = null; // a video element can be wired to Web Audio once, so these live for the page
async function recordSave(): Promise<{ blob: Blob; ext: string }> {
  const mime = ["video/mp4;codecs=avc1,mp4a.40.2", "video/webm;codecs=vp9,opus", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
  const ext = (mime || "video/webm").includes("mp4") ? "mp4" : "webm";
  const stream = canvas.captureStream(30);
  if (!recCtx) { recCtx = new AudioContext(); recSrc = recCtx.createMediaElementSource(video); recSrc.connect(recCtx.destination); }
  await recCtx.resume().catch(() => {}); const dest = recCtx.createMediaStreamDestination(); recSrc!.connect(dest);
  for (const t of dest.stream.getAudioTracks()) stream.addTrack(t);
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 6_000_000 } : undefined);
  const chunks: Blob[] = []; rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const done = new Promise<void>((res) => (rec.onstop = () => res()));
  video.pause(); video.currentTime = 0; await new Promise((r) => (video.onseeked = r));
  const total = Math.min(video.duration, limit()); const wasMuted = video.muted; video.muted = false;
  rec.start(250); await video.play();
  const tick = setInterval(() => say(`Writing your video. About ${Math.max(0, Math.ceil(total - video.currentTime))} s left.`), 500);
  try { await new Promise<void>((res) => { const end = () => { if (video.ended || video.currentTime >= total) res(); else requestAnimationFrame(end); }; end(); }); }
  finally { clearInterval(tick); video.pause(); rec.stop(); await done; recSrc!.disconnect(dest); video.muted = wasMuted; }
  return { blob: new Blob(chunks, { type: mime || "video/webm" }), ext };
}
async function exportVideo() {
  if (!words.length || !currentFile) return; setState("exporting"); result.classList.remove("on");
  try {
    // Fast path first: frames decoded and re-encoded with WebCodecs, sound copied, several times faster than real time.
    let saved: { blob: Blob; ext: string } | null = null; const t0 = performance.now(); dbg.fastSaveError = undefined; dbg.exportTrace = [];
    if (canFastSave()) {
      try {
        video.pause(); say("Writing your video."); fastSaving = true;
        const r = await fastSave(currentFile, limit(), (c, W, H, t) => paint(c, W, H, t, style, !licensed, null, false, true), (d, tot) => { say(`Writing your video. ${Math.round(d)} of ${Math.round(tot)} s.`); dbg.exportTrace.push([+d.toFixed(1), Math.round(performance.now() - t0)]); }, dbg.fastOpts ?? {});
        saved = r; dbg.exportPath = "webcodecs"; dbg.exportCodec = r.codec; dbg.exportAudio = r.audio; dbg.exportFrames = r.frames; dbg.exportTiming = r.timing;
      } catch (e: any) { dbg.fastSaveError = String(e?.message ?? e); if (e?.timing) dbg.exportTiming = e.timing; } finally { fastSaving = false; }
    }
    let lostFrames = ""; if (!saved) { dbg.exportPath = "recorder"; saved = await recordSave(); const fps = await savedFps(saved.blob); dbg.exportFps = fps;
      // The recorder writes in real time; a slow device loses frames. Say so, with the number read from the file itself.
      if (fps && fps < 20) lostFrames = ` This device kept about ${Math.round(fps)} frames a second, so the clip may look jerky. A shorter clip or a newer device keeps them all.`; }
    dbg.exportMs = performance.now() - t0;
    lastBlob = saved.blob; lastName = `${outputBase(currentFile.name)}-captions.${saved.ext}`;
    dbg.exportBytes = lastBlob.size; say("");
    // ?debug on the URL: one plain line about how the save ran, for checking a real phone without developer tools.
    if (DEBUG) { const secs = Math.min(video.duration || 0, limit()); const x = secs ? (secs / (dbg.exportMs / 1000)).toFixed(1) : "?"; const t = dbg.exportTiming ? ` draw ${dbg.exportTiming.draw} ms, encode ${dbg.exportTiming.encode} ms, decode ${dbg.exportTiming.decode} ms` : ""; $("rmark").insertAdjacentText("beforebegin", `Debug: ${dbg.exportPath === "webcodecs" ? "fast save" : "recorded"} ${x}× real time (${(dbg.exportMs / 1000).toFixed(1)} s for ${Math.round(secs)} s), ${dbg.exportCodec ?? ""} ${dbg.exportAudio ?? ""};${t}${dbg.fastSaveError ? "; fast save gave up: " + dbg.fastSaveError : ""}; engine ${dbg.device ?? "?"} ${dbg.ms ? Math.round(dbg.ms / 1000) + " s" : ""}. `); }
    const size = `${(lastBlob.size / 1e6).toFixed(1)} MB`;
    if (phoneShare(lastBlob, lastName)) {
      // On a phone the share sheet puts the clip in Photos or straight into the app; Downloads is the wrong place.
      $("rtitle").textContent = "Your video is ready"; $("rline").textContent = `${size}. Save it to Photos or send it straight to the app you post from.` + lostFrames;
      share.hidden = false; share.textContent = "Save to Photos / share"; share.className = "btn hi"; again.textContent = "Download the file instead"; $("rios").hidden = true;
    } else {
      saveBlob(lastBlob, lastName);
      $("rtitle").textContent = "Saved"; $("rline").textContent = `${size}. Check your Downloads.` + lostFrames;
      share.hidden = true; again.textContent = "Save again"; $("rios").hidden = !isIOS;
    }
    $("rmark").hidden = licensed;
    steps.classList.remove("on"); result.classList.add("on"); setState("exported"); if (video.paused) video.play().catch(() => {}); /* the clip plays again after a save, so no play icon covers the result */
    showName($("rname"), lastName); // once the card is visible, so the name is fitted to the card's real width; the ending stays readable
    result.scrollIntoView({ block: "nearest", behavior: "smooth" });
  } catch (e: any) { dbg.exportError = String(e); say("The video did not save. Reload the page and try again.", true); setState("captioned"); }
}
const isPhone = isIOS || /Android/i.test(navigator.userAgent);
dbg.outputBase = outputBase;
function phoneShare(b: Blob, name: string) { try { return isPhone && !!(navigator as any).canShare?.({ files: [new File([b], name, { type: b.type })] }); } catch { return false; } }
function saveBlob(b: Blob, name: string) { const a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 60_000); }
again.addEventListener("click", (e) => { e.preventDefault(); if (lastBlob) saveBlob(lastBlob, lastName); });
share.addEventListener("click", async () => { if (!lastBlob) return; try { await navigator.share({ files: [new File([lastBlob], lastName, { type: lastBlob.type })], title: "Captioned clip" }); } catch {} });

// ---------- paid version: one key, checked by the unlock worker (src/lib/unlock.ts, the same file in all three tools) ----------
const unlock = new Unlock({
  tool: "captions",
  sandbox: SANDBOX,
  paidLine: "No mark on your videos, and clips up to five minutes.",
  render: (s: UnlockState) => paintLicense(s),
});
function paintLicense(s: UnlockState) {
  licensed = s.on; dbg.licensed = s.on; dbg.unlockTools = s.tools;
  $("keystatus").textContent = s.text; $("keystatus").className = "fine" + (s.tone ? " " + s.tone : "");
  $("keyrow").hidden = s.on; $("buy").parentElement!.hidden = s.on; $("tag").hidden = s.on; $("pricefine").hidden = s.on; $("afterpay").hidden = s.on; $("paidpanel").hidden = !s.on;
  // The key in full, so it can be carried to another device. Masking it protected nothing: it is the person's own
  // key and it is in their email, and a masked key cannot be typed into a second device (cold user, 2026-09-20).
  $("paidkey").textContent = s.key;
  $("keylost").setAttribute("href", unlock.portal);
  // A key that opens more than this tool says so, and the link carries it across in one click.
  const others = unlock.elsewhere;
  $("keyalso").hidden = others.length === 0;
  if (others.length) $("keyalso").innerHTML = `This key also opens ${others.map((o) => `<a href="${o.href}">${o.name}</a>`).join(" and ")}.`;
  trust.textContent = s.on ? "Up to five minutes. English. Nothing leaves your device." : "Free up to 60 seconds. English. Nothing leaves your device.";
  // The checkout opens in its own tab, so a clip being worked on stays here (cold user, 2026-09-19). When the key
  // arrives from that tab and a marked copy has already been saved, say so rather than leave a stale file believed good.
  if (s.on && s.became === "another-tab" && state === "exported") { touched(); say("The paid version is on. Save the video again: the new copy has no mark.", "ok"); }
  if (s.on && s.became === "checkout") $("keystatus").scrollIntoView({ block: "center", behavior: "smooth" });
}
$("removekey").addEventListener("click", (e) => { e.preventDefault(); unlock.forget(); });
$("keycopy").addEventListener("click", async (e) => {
  e.preventDefault();
  try { await navigator.clipboard.writeText(unlock.state.key); $("keycopy").textContent = "Copied"; }
  catch { getSelection()?.selectAllChildren($("paidkey")); $("keycopy").textContent = "Select it and copy"; } // no clipboard permission: hand them the selection instead
  setTimeout(() => ($("keycopy").textContent = "Copy"), 2500);
});
$("keygo").addEventListener("click", async () => { if (await unlock.paste($<HTMLInputElement>("key").value)) $<HTMLInputElement>("key").value = ""; });
$("key").addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") $("keygo").click(); });
const loadLicense = () => unlock.start();

// ---------- founding offer: $19 for the first 100 buyers, counted from real orders ----------
(async () => {
  try { const r = await fetch(`${UNLOCK}/count`); const j = r.ok ? await r.json() : null; if (typeof j?.paid !== "number") return;
    const left = Math.max(0, 100 - j.paid); $("founding").textContent = left >= 100 ? "Founding price for the first 100 buyers." : left > 0 ? `Founding price for the first 100 buyers. ${left} left.` : "Founding price ended; the price goes up on the next batch."; dbg.foundingLeft = left; } catch {}
})();

// ---------- for automations ----------
// For rigs that need the paid state without a rail: paints it, exactly as a real key would. It does not store a key,
// so a reload goes back to whatever the device actually holds.
dbg.setLicensed = (on: boolean) => paintLicense({ on, key: on ? "TEST-KEY" : "", tools: on ? ["captions"] : [], expires: null, text: on ? "Paid version on this device." : "Already paid? Paste your key here.", tone: on ? "ok" : "", became: "" });
(window as any).captions = {
  load: (f: File) => load(f), run, export: exportVideo, style: pickStyle,
  get words() { return words; }, get state() { return state; },
};
setState("sample");
