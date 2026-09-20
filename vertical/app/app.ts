// Vertical: a landscape clip in, a 9:16 clip out with the speaker kept in frame. The face is found on the device
// (MediaPipe in WebAssembly), the moving window is smoothed here, the file is written with WebCodecs. Nothing leaves the device.
import { pickSpeaker, SPEAK, buildTrack, centreAt, cropRect, outputSize, windowFraction, type Point, type Sample } from "./src/lib/track";
import { outputBase, fitName } from "./src/lib/naming";
import { loadDetector, scanClip, delegate } from "./src/detect";
import { fastSave, canFastSave, savedFps } from "./src/fastsave";
import { attachSeek } from "./src/seek";
import { Unlock, type UnlockState } from "./src/lib/unlock";
type State = "sample" | "loaded" | "tracking" | "ready" | "exporting" | "exported"; type Mode = "follow" | "hold";

// Sample files are fetched under the page's version (app.js?v=…), so a replaced sample reaches visitors at once: Cloudflare's edge
// kept serving a year-old "immutable" sample.mp4 after it was replaced (2026-09-18).
const ASSET_V = (() => { try { return new URL(import.meta.url).search; } catch { return ""; } })();
const SANDBOX = new URLSearchParams(location.search).get("rail") === "sandbox";
const RAIL = SANDBOX
  ? { product: "053f7bf2-a6ac-4749-98f1-92d840bbdf2e", link: "https://sandbox-api.polar.sh/v1/checkout-links/polar_cl_n8mJO32zNi3Tsyf4Ir5tOubvaQKYkAcZr0LgO0HqGiI/redirect" }
  : { product: "eff2bec5-b235-4664-90cf-2038397749c8", link: "https://buy.polar.sh/polar_cl_mVsARzcnp4LFpUW1BsP2eXqQrFc5fSDu99afw3oTurT" };
const UNLOCK = "https://unlock.smaverk.com"; // the unlock worker: the only address this page knows about keys
const DEBUG = new URLSearchParams(location.search).has("debug");
const limit = () => (licensed ? 300 : 60);

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const stage = $("stage"), video = $<HTMLVideoElement>("video"), canvas = $<HTMLCanvasElement>("canvas"), poster = $<HTMLImageElement>("poster");
const action = $<HTMLButtonElement>("action"), file = $<HTMLInputElement>("file"), status = $("status"), trust = $("trust"), reset = $<HTMLButtonElement>("reset");
const clipname = $("clipname"), hint = $("hint"), steps = $("steps"), result = $("result"), share = $<HTMLButtonElement>("share"), again = $<HTMLAnchorElement>("again");
const sound = $<HTMLButtonElement>("sound"), soundtxt = $("soundtxt");
const seek = $<HTMLInputElement>("seek"); attachSeek(seek, $("seekbar"), video);
const chips = [...document.querySelectorAll<HTMLButtonElement>(".chip")];
const ctx = canvas.getContext("2d", { alpha: false })!;
if (RAIL.link && !RAIL.link.startsWith("__")) for (const id of ["buy", "rbuy"]) (document.getElementById(id) as HTMLAnchorElement).href = RAIL.link; // the price box and the Saved box open the same checkout

let state: State = "sample", mode: Mode = "follow", holdX = 0.5, track: Point[] = [], samples: Sample[] = [], srcW = 16, srcH = 9;
let currentFile: File | null = null, licensed = false, lastBlob: Blob | null = null, lastName = "";
const dbg: any = ((window as any).__vert = {});
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isPhone = isIOS || /Android/i.test(navigator.userAgent);

// ---------- state and copy ----------
const LABEL: Record<State, string> = { sample: "Use my own clip", loaded: "Make it vertical", tracking: "Working…", ready: "Save video", exporting: "Saving…", exported: "Make another" };
function setState(s: State) {
  seek.hidden = s === "tracking" || s === "exporting"; // no scrubbing while the clip is being read or written
  sound.hidden = s === "sample" && stage.dataset.sampleSound !== "1"; // build.sh notes whether the sample has a sound track; a control for a silent clip would do nothing
  state = s; action.textContent = LABEL[s]; action.disabled = s === "tracking" || s === "exporting";
  action.classList.toggle("stuck", s === "loaded" || s === "ready"); // sticky on phones only while it is the next step (a disabled "Working…" covered the named steps in Captions: design review 2, 2026-09-19)
  stage.classList.toggle("busy", s === "tracking" || s === "exporting"); // no play badge while the clip is read or written
  reset.hidden = s === "sample" || s === "exported"; trust.hidden = s !== "sample";
  hint.textContent = hintFor(s);
  if (s !== "exported") result.classList.remove("on");
  // What you are about to get, before you commit: name, size, length, format, and where the mark is.
  // The container the save will write, so the name shown at "ready" is the name that downloads (design review 3, B5).
  const recorderMp4 = () => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported("video/mp4;codecs=avc1,mp4a.40.2");
  const plannedExt = () => canFastSave() || recorderMp4() ? "mp4" : "webm";
  const outEl = $("out"); if (s === "ready" && currentFile) { const o = outputSize(srcW, srcH); const d = Math.min(video.duration || 0, limit()); outEl.textContent = `${outputBase(currentFile.name)}-vertical.${plannedExt()} · ${o.width} × ${o.height} · ${Math.floor(d / 60)}:${String(Math.round(d % 60)).padStart(2, "0")} · ${plannedExt().toUpperCase()}${licensed ? "" : " · with a small smaverk.com mark"}`; outEl.hidden = false; } else outEl.hidden = true;
  dbg.state = s;
}
const say = (t: string, tone: boolean | "ok" = false) => { status.textContent = t; status.className = "status" + (tone === true ? " err" : tone ? " ok" : ""); }; // true: something went wrong; "ok": good news
// Cold users, rounds 2 and 3: after placing the window by hand the page still said "not placed yet" and then searched for a speaker nobody asked for.
let placed = false; // the person dragged the window on this clip
function hintFor(s: State): string { return s === "sample" ? "The yellow window is what gets saved. It follows the speaker; the small picture is a preview of it. Drag sideways to hold it where you want." : s === "ready" ? "The yellow window is what gets saved; the small picture is a preview of it. Drag sideways to place it yourself." : s === "exported" ? "Change the mode or position and save again" : s === "loaded" && placed && mode === "hold" ? "The window stays where you put it. Tap Make it vertical to keep it there, or Follow the speaker to let it move." : s === "loaded" && placed ? "Tap Make it vertical and the window follows the speaker from there. Hold still keeps it where you put it." : s === "tracking" && placed ? "Finding the speaker. Until it is done, the window stays where you put it." : s === "loaded" || s === "tracking" ? "The window is not placed yet. Tap Make it vertical and it finds the speaker, or drag it where you want." : ""; }
// Following whoever is talking in a two-person shot is OFF unless the address carries ?two=1 (or a test switches it on). Cold-user round 4,
// 2026-09-19: it caught 3 of 3 handovers on the clip it was tuned on and 1 of 2 on the host's own clips, with wrong jumps on a thumbs-up and
// a smile; a hand-held microphone hides the very mouth it measures. The page does not promise it until it holds on clips nobody tuned it on
// and a wrong moment can be corrected by hand. With it off, a two-person clip gets the calm one-person rule (the larger face).
let TWO = new URLSearchParams(location.search).get("two") === "1";
let lastScan: { found: number; two: boolean; both: number } | null = null;
/** What the search found, in one sentence; with two people and Hold still it says that one of them will be out of the picture. */
function doneLine(): string { if (!lastScan) return "Done."; const { found, two, both } = lastScan; if (!two && both >= 0.2 && found >= 0.1) return "Two people in this clip. The window follows one; drag to choose."; /* cold user 4b: "Speaker found in 100%" on a two-person clip claimed more than it did */ return found < 0.1 ? "No face found." : two ? (mode === "hold" ? "Two people found. The window is holding still, so it stays on one of them." : "Two people found. The window follows whoever is talking.") : `Speaker found in ${Math.round(found * 100)}% of the clip.`; }
// The small preview keeps to one side for the whole clip when one side is clear of the window all the way through (design review 7: at every
// cut the window crossed one way and the preview the other). null: no side is clear, so it moves out of the window's way frame by frame.
let insetSide: "left" | "right" | null = null;
function clearSide(): "left" | "right" | null { if (!track.length || !srcW || !srcH) return null; const w = Math.min(1, (srcH * 9 / 16) / srcW), inset = 0.62 * w + 0.02; let lo = 1, hi = 0; for (const p of track) { const l = Math.min(1 - w, Math.max(0, p.cx - w / 2)); lo = Math.min(lo, l); hi = Math.max(hi, l + w); } return hi < 1 - inset ? "right" : lo > inset ? "left" : null; }
function pickMode(m: Mode) { mode = m; for (const ch of chips) ch.setAttribute("aria-pressed", String(ch.dataset.mode === m)); dbg.mode = m; touched(); hint.textContent = hintFor(state); if (lastScan && steps.classList.contains("done")) $("s3t").textContent = doneLine(); }
for (const ch of chips) ch.addEventListener("click", () => { const m = ch.dataset.mode as Mode; if (m === "hold" && track.length) holdX = centreAt(track, video.currentTime).cx; dbg.holdX = holdX; pickMode(m); if (m === "follow" && !track.length && currentFile && state === "ready") run(); });
function touched() { if (state === "exported") { setState("ready"); if (video.paused) video.play().catch(() => {}); } }

// ---------- sample at rest ----------
(async () => {
  try { track = await (await fetch("sample-track.json" + ASSET_V)).json(); } catch { track = []; } insetSide = clearSide();
  dbg.track = track; video.src = "sample.mp4" + ASSET_V; video.muted = true; video.loop = true; video.play().catch(() => {}); loadLicense();
})();
// The stage shows the whole source with the 9:16 window drawn on it and the vertical result inset, so the person sees what is cut and why. While the recorder fallback runs, the stage becomes the output itself.
let view: "source" | "output" = "source";
function sized() { srcW = video.videoWidth || 16; srcH = video.videoHeight || 9; const o = outputSize(srcW, srcH); dbg.out = o; const w = view === "output" ? o.width : srcW, h = view === "output" ? o.height : srcH; canvas.width = w; canvas.height = h; const ar = w / h; stage.style.setProperty("--ar", String(ar)); stage.parentElement!.style.setProperty("--ar", String(ar)); }
video.addEventListener("loadedmetadata", () => { sized(); if (state === "sample") insetSide = clearSide(); dbg.insetSide = insetSide; });
video.addEventListener("playing", () => { stage.classList.add("playing"); poster.hidden = true; });
video.addEventListener("pause", () => stage.classList.remove("playing"));
video.addEventListener("ended", () => stage.classList.remove("playing"));
{ const tap = $("tap"); let x0 = 0, y0 = 0, down = false, moved = false, startHold = 0.5;
  tap.addEventListener("pointerdown", (e) => { down = true; moved = false; x0 = e.clientX; y0 = e.clientY; startHold = mode === "hold" ? holdX : centre(video.currentTime).cx; tap.setPointerCapture(e.pointerId); });
  tap.addEventListener("pointermove", (e) => { if (!down) return; if (!moved && Math.abs(e.clientX - x0) < 8 && Math.abs(e.clientY - y0) < 8) return; moved = true; const r = stage.getBoundingClientRect();
    // dragging the window across the whole stage width moves it across the whole source
    holdX = Math.min(1, Math.max(0, startHold + ((e.clientX - x0) / r.width) * 0.8)); placed = true; dbg.placed = true; if (mode !== "hold") pickMode("hold"); else hint.textContent = hintFor(state); dbg.holdX = holdX; touched(); });
  tap.addEventListener("pointerup", () => { if (!down) return; down = false; if (moved || state === "exporting") return; video.paused ? video.play().catch(() => {}) : video.pause(); });
  tap.addEventListener("pointercancel", () => { down = false; }); }
sound.addEventListener("click", () => { video.muted = !video.muted; sound.setAttribute("aria-pressed", String(!video.muted)); soundtxt.textContent = video.muted ? "Sound off" : "Sound on"; sound.setAttribute("aria-label", video.muted ? "Sound is off. Turn it on" : "Sound is on. Turn it off"); if (video.paused) video.play().catch(() => {}); });

// ---------- drawing ----------
const FONT = '"Bricolage Grotesque", ui-sans-serif, system-ui, sans-serif';
function centre(t: number) { return mode === "follow" && track.length ? centreAt(track, t) : { cx: holdX, cy: 0.5 }; }
function mark(c: CanvasRenderingContext2D, W: number, H: number) { c.font = `700 ${Math.round(Math.min(W, H) * 0.045)}px ${FONT}`; c.textAlign = "right"; c.textBaseline = "alphabetic"; c.lineWidth = 3; c.lineJoin = "round"; c.strokeStyle = "rgba(0,0,0,.5)"; c.fillStyle = "rgba(255,255,255,.85)"; c.strokeText("smaverk.com", W - 12, H - 16); c.fillText("smaverk.com", W - 12, H - 16); }
let fastSaving = false;
(function loop() { if (video.readyState >= 2 && !fastSaving) { const { cx, cy } = centre(video.currentTime); const r = cropRect(cx, cy, srcW, srcH); const W = canvas.width, H = canvas.height;
  if ((view as "source" | "output") === "output") { ctx.drawImage(video, r.sx, r.sy, r.sw, r.sh, 0, 0, W, H); if (sound.dataset.side !== "bottom") sound.dataset.side = "bottom"; if (!licensed) mark(ctx, W, H); }
  else {
    ctx.drawImage(video, 0, 0, W, H);
    // The sound button keeps out of the crop window: the top-right corner, else the top-left, else (a clip that is already
    // vertical, where the window is the whole picture) the bottom-left. Design review 5, S7.
    dbg.win = { x: r.sx / W, w: r.sw / W }; { const S = stage.clientWidth || 358, wl = (r.sx / W) * S, wr = ((r.sx + r.sw) / W) * S;
      const slot = wr < S - 56 ? "right" : wl > 56 ? "left" : "bottom"; if (sound.dataset.side !== slot) sound.dataset.side = slot; }
    ctx.fillStyle = "rgba(0,0,0,.32)"; ctx.fillRect(0, 0, r.sx, H); ctx.fillRect(r.sx + r.sw, 0, W - r.sx - r.sw, H); ctx.fillRect(r.sx, 0, r.sw, r.sy); ctx.fillRect(r.sx, r.sy + r.sh, r.sw, H - r.sy - r.sh);
    ctx.lineWidth = Math.max(3, W * 0.004); ctx.strokeStyle = "#FFD84D"; ctx.strokeRect(r.sx, r.sy, r.sw, r.sh);
    dbg.inset = r.sw < W - 4 && (track.length > 0 || mode === "hold"); // read by the phone UI gate
    if (r.sw < W - 4 && (track.length || mode === "hold")) { const ih = H * 0.62, iw = (ih * r.sw) / r.sh, side = mode === "follow" && insetSide ? insetSide : r.sx + r.sw / 2 > W / 2 ? "left" : "right", ix = side === "left" ? W * 0.02 : W - iw - W * 0.02, iy = H - ih - H * 0.03; ctx.drawImage(video, r.sx, r.sy, r.sw, r.sh, ix, iy, iw, ih); ctx.lineWidth = 2; ctx.strokeStyle = "#fff"; ctx.strokeRect(ix, iy, iw, ih); if (!licensed) { ctx.save(); ctx.translate(ix, iy); mark(ctx, iw, ih); ctx.restore(); } }
  } } requestAnimationFrame(loop); })();

// ---------- own clip ----------
const named = new Map<HTMLElement, string>();
function showName(el: HTMLElement, full: string) { named.set(el, full); el.title = full; el.textContent = full; const c = document.createElement("canvas").getContext("2d"); if (!c) return; c.font = getComputedStyle(el).font; const room = Math.max(40, el.clientWidth - 2); el.textContent = fitName(full, (t) => c.measureText(t).width <= room); }
addEventListener("resize", () => { for (const [el, full] of named) if (el.isConnected) showName(el, full); });
function load(f: File) {
  currentFile = f; track = []; samples = []; dbg.track = track; lastBlob = null; holdX = 0.5; placed = false; lastScan = null; insetSide = null; dbg.placed = false; pickMode("follow"); video.pause();
  video.src = URL.createObjectURL(f); video.loop = true; video.muted = true; sound.setAttribute("aria-pressed", "false"); soundtxt.textContent = "Sound off"; sound.setAttribute("aria-label", "Sound is off. Turn it on");
  video.play().catch(() => {});
  showName(clipname, f.name); poster.hidden = true; steps.classList.remove("on");
  video.onloadedmetadata = () => { sized(); const d = video.duration; const tall = srcW / srcH <= 9 / 16 + 0.01;
    const note = tall ? " This clip is already vertical, so there is nothing to cut; it is saved as it is." : "";
    if (isFinite(d) && d > limit() + 1) say(licensed ? `That clip is longer than five minutes, so this takes the first five.` + note : `That clip is longer than 60 seconds, so this takes the first minute. The paid version takes up to five minutes.` + note); else say((isFinite(d) ? `${Math.round(d)}-second clip loaded.` : "Clip loaded.") + note); };
  video.onerror = () => say("That file could not be opened. Try an mp4 or mov from your camera roll.", true);
  setState("loaded");
}
let warming = false;
function warm() { if (warming) return; warming = true; loadDetector().then(() => { dbg.detectorWarm = true; }).catch((e) => { dbg.detectorWarmError = String(e); }); }
file.addEventListener("click", warm); // opening the file picker is the intent; dragging the window on the SAMPLE is not (the same rule as Captions, 2026-09-19)
// No download before the visitor shows intent (2026-09-19, the same rule as Captions): the timed warm-up is gone; picking a file or touching the stage starts it.
file.addEventListener("click", () => { if (isPhone) say("Pick a clip. Your phone prepares the file before handing it over; that can take a moment. Nothing is sent anywhere."); });
file.addEventListener("change", () => { const f = file.files?.[0]; if (f) load(f); file.value = ""; });
reset.addEventListener("click", () => file.click());
action.addEventListener("click", () => { if (state === "sample" || state === "exported") return file.click(); if (state === "loaded") return run(); if (state === "ready") return exportVideo(); });

function step(n: 1 | 2 | 3, m: "active" | "done" | "off", note = "") { const el = $(`s${n}`); el.className = "step" + (m === "off" ? "" : " " + m); $(`s${n}n`).textContent = note; }
let stageNow: "tracker" | "scan" = "tracker";
async function run() {
  if (!currentFile) return;
  if (mode === "hold" && placed) { dbg.skippedScan = true; steps.classList.remove("on"); say(""); setState("ready"); video.loop = false; video.currentTime = 0; video.play().catch(() => {}); return; } // the person chose the place: nothing to look for
  dbg.skippedScan = false; setState("tracking"); say(""); steps.classList.remove("done"); steps.classList.add("on"); step(1, "active", "one time, about 12 MB"); step(2, "off"); step(3, "off"); $("s3t").textContent = "Done";
  try {
    stageNow = "tracker"; const tStart = performance.now(); await loadDetector(); dbg.detector = delegate; dbg.detectorMs = Math.round(performance.now() - tStart); step(1, "done", "ready");
    stageNow = "scan"; step(2, "active", "starting");
    const scan = await scanClip(currentFile, limit(), (d, tot) => { const pct = Math.round((d / tot) * 100); $("s2b").style.width = pct + "%"; step(2, "active", `${pct}%`); });
    // Two people and sound: the window follows whoever is talking, and steps across when the turn changes. One person, a
    // second face in too few samples, or a clip with no sound: the same calm pan over one face as before (2026-09-19).
    const picked = pickSpeaker(scan.speakers, TWO ? SPEAK : { ...SPEAK, bothMin: 2 }); dbg.two = TWO;
    samples = picked.samples; track = buildTrack(samples, picked.cutAt, undefined, windowFraction(scan.width, scan.height));
    dbg.track = track; dbg.samples = samples; dbg.scanMs = Math.round(scan.ms); dbg.looks = scan.looks;
    dbg.bothFound = +scan.bothFound.toFixed(2); dbg.switches = picked.switches; dbg.audio = scan.audio; dbg.audioError = scan.audioError; dbg.combined = scan.combined; dbg.crowd = scan.crowd; dbg.measured = scan.measured;
    dbg.speakerSamples = scan.speakers.map((s, i) => ({ t: s.t, faces: (s.p[0] ? 1 : 0) + (s.p[1] ? 1 : 0), talk: [s.p[0]?.talk ?? null, s.p[1]?.talk ?? null], voiced: s.voiced, pick: picked.picks[i] }));
    const found = samples.filter((s) => s.x !== null).length / Math.max(1, samples.length); dbg.found = +found.toFixed(2);
    step(2, "done", `${(scan.ms / 1000).toFixed(0)} s`);
    // Design review 7, 2026-09-19: the panel was switched off in the same line that wrote what was found, so nobody has seen this sentence. It stays on, alone (`.steps.done` hides the other steps).
    lastScan = { found, two: picked.two, both: scan.bothFound }; step(3, "done"); $("s3t").textContent = doneLine(); steps.classList.add("done"); insetSide = clearSide();
    if (mode === "hold" && !placed && found >= 0.1) { const xs = track.map((p) => p.cx).sort((a, b) => a - b); holdX = xs[xs.length >> 1]!; dbg.holdX = holdX; } // cold user, 2026-09-19: Hold still without a drag kept the window in the middle, through half his face
    if (found < 0.1) { pickMode("hold"); say("No face was found in this clip, so the window stays in the middle. Drag it sideways to place it."); }
    setState("ready"); video.loop = false; video.currentTime = 0; video.play().catch(() => {});
    if (matchMedia("(max-width: 899px)").matches) clipname.parentElement!.scrollIntoView({ block: "start", behavior: "smooth" });
  } catch (e: any) {
    dbg.error = String(e?.message ?? e); dbg.stage = stageNow; steps.classList.remove("on"); setState("loaded");
    const human = stageNow === "tracker" ? "Could not get the tool ready." : "Something went wrong while looking at the clip.";
    const detail = `${navigator.userAgent}\nstage: ${stageNow}\nmode: ${delegate}\nerror: ${dbg.error}\nfile: ${currentFile?.name} ${currentFile?.type} ${currentFile?.size}`;
    status.className = "status err"; status.replaceChildren(document.createTextNode(human + " Try again, or another file. "),
      Object.assign(document.createElement("a"), { href: "mailto:hello@smaverk.com?subject=" + encodeURIComponent("Vertical: it failed on my clip") + "&body=" + encodeURIComponent(detail), textContent: "Send me the details" }),
      document.createTextNode(" and I will fix it."), Object.assign(document.createElement("small"), { textContent: DEBUG ? ` (${stageNow}: ${String(dbg.error).slice(0, 160)})` : "", style: "display:block;opacity:.7;font-size:13px;margin-top:4px" }));
  }
}

// ---------- save ----------
let recCtx: AudioContext | null = null, recSrc: MediaElementAudioSourceNode | null = null;
async function recordSave(): Promise<{ blob: Blob; ext: string }> {
  const mime = ["video/mp4;codecs=avc1,mp4a.40.2", "video/webm;codecs=vp9,opus", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
  const ext = (mime || "video/webm").includes("mp4") ? "mp4" : "webm"; const stream = canvas.captureStream(30);
  if (!recCtx) { recCtx = new AudioContext(); recSrc = recCtx.createMediaElementSource(video); recSrc.connect(recCtx.destination); }
  await recCtx.resume().catch(() => {}); const dest = recCtx.createMediaStreamDestination(); recSrc!.connect(dest); for (const t of dest.stream.getAudioTracks()) stream.addTrack(t);
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 6_000_000 } : undefined); const chunks: Blob[] = []; rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const done = new Promise<void>((res) => (rec.onstop = () => res()));
  video.pause(); video.currentTime = 0; await new Promise((r) => (video.onseeked = r)); const total = Math.min(video.duration, limit()); const wasMuted = video.muted; video.muted = false;
  view = "output"; sized(); rec.start(250); await video.play(); const tick = setInterval(() => say(`Writing your video. About ${Math.max(0, Math.ceil(total - video.currentTime))} s left.`), 500);
  try { await new Promise<void>((res) => { const end = () => { if (video.ended || video.currentTime >= total) res(); else requestAnimationFrame(end); }; end(); }); }
  finally { clearInterval(tick); video.pause(); rec.stop(); await done; recSrc!.disconnect(dest); video.muted = wasMuted; view = "source"; sized(); }
  return { blob: new Blob(chunks, { type: mime || "video/webm" }), ext };
}
async function exportVideo() {
  if (!currentFile || state !== "ready") return; setState("exporting"); result.classList.remove("on");
  try {
    let saved: { blob: Blob; ext: string } | null = null; const t0 = performance.now(); dbg.fastSaveError = undefined; dbg.exportTrace = [];
    if (canFastSave()) {
      try {
        video.pause(); say("Writing your video."); fastSaving = true;
        const r = await fastSave({ file: currentFile, maxSeconds: limit(), output: (w, h) => outputSize(w, h),
          drawFrame: (s, c, W, H, t) => { const { cx, cy } = centre(t); const rc = cropRect(cx, cy, s.displayWidth, s.displayHeight);
            // Cropping straight from the decoded frame is one fast draw; Mediabunny's own region draw costs over 100 ms a frame. Rotated or flipped sources take the slow, correct path.
            if (s.rotation === 0 && !s.flip) { const vf = s.toVideoFrame(); c.drawImage(vf, rc.sx, rc.sy, rc.sw, rc.sh, 0, 0, W, H); if (vf !== (s as any)._data) vf.close(); } else s.draw(c, rc.sx, rc.sy, rc.sw, rc.sh, 0, 0, W, H); },
          paintOver: (c, W, H) => { if (!licensed) mark(c, W, H); },
          onProgress: (d, tot) => { say(`Writing your video. ${Math.round(d)} of ${Math.round(tot)} s.`); dbg.exportTrace.push([+d.toFixed(1), Math.round(performance.now() - t0)]); }, opts: { ...(typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported("video/mp4;codecs=avc1,mp4a.40.2") ? {} : { minSpeed: 0 }), ...(dbg.fastOpts ?? {}) } });
        saved = r; dbg.exportPath = "webcodecs"; dbg.exportCodec = r.codec; dbg.exportAudio = r.audio; dbg.exportFrames = r.frames; dbg.exportTiming = r.timing; dbg.exportSize = [r.width, r.height];
      } catch (e: any) { dbg.fastSaveError = String(e?.message ?? e); if (e?.timing) dbg.exportTiming = e.timing; } finally { fastSaving = false; }
    }
    let lostFrames = ""; if (!saved) { dbg.exportPath = "recorder"; saved = await recordSave(); const fps = await savedFps(saved.blob); dbg.exportFps = fps;
      // The recorder writes in real time; a slow device loses frames. Say so, with the number read from the file itself.
      if (fps && fps < 20) lostFrames = ` This device kept about ${Math.round(fps)} frames a second, so the clip may look jerky. A shorter clip or a newer device keeps them all.`; }
    dbg.exportMs = performance.now() - t0; lastBlob = saved.blob; lastName = `${outputBase(currentFile.name)}-vertical.${saved.ext}`; dbg.exportBytes = lastBlob.size; say("");
    if (DEBUG) { const secs = Math.min(video.duration || 0, limit()); const x = secs ? (secs / (dbg.exportMs / 1000)).toFixed(1) : "?"; const t = dbg.exportTiming ? ` draw ${dbg.exportTiming.draw} ms, encode ${dbg.exportTiming.encode} ms, decode ${dbg.exportTiming.decode} ms` : ""; $("rmark").insertAdjacentText("beforebegin", `Debug: ${dbg.exportPath === "webcodecs" ? "fast save" : "recorded"} ${x}× real time (${(dbg.exportMs / 1000).toFixed(1)} s for ${Math.round(secs)} s), ${dbg.exportCodec ?? ""} ${dbg.exportAudio ?? ""};${t}${dbg.fastSaveError ? "; fast save gave up: " + dbg.fastSaveError : ""}; tracker ${dbg.detector ?? "?"} ${dbg.scanMs ? Math.round(dbg.scanMs / 1000) + " s" : ""}. `); }
    const size = `${(lastBlob.size / 1e6).toFixed(1)} MB`;
    if (phoneShare(lastBlob, lastName)) { $("rtitle").textContent = "Your video is ready"; $("rline").textContent = `${size}. Save it to Photos or send it straight to the app you post from.` + lostFrames; share.hidden = false; share.textContent = "Save to Photos / share"; share.className = "btn hi"; again.textContent = "Download the file instead"; $("rios").hidden = true; }
    else { saveBlob(lastBlob, lastName); $("rtitle").textContent = "Saved"; $("rline").textContent = `${size}. Check your Downloads.` + lostFrames; share.hidden = true; again.textContent = "Save again"; $("rios").hidden = !isIOS; }
    $("rmark").hidden = licensed; steps.classList.remove("on"); result.classList.add("on"); setState("exported"); if (video.paused) video.play().catch(() => {}); /* the clip plays again after a save, so no play icon covers the result */ showName($("rname"), lastName);
    result.scrollIntoView({ block: "nearest", behavior: "smooth" });
  } catch (e: any) { dbg.exportError = String(e); say("The video did not save. Reload the page and try again.", true); setState("ready"); }
}
function phoneShare(b: Blob, name: string) { try { return isPhone && !!(navigator as any).canShare?.({ files: [new File([b], name, { type: b.type })] }); } catch { return false; } }
function saveBlob(b: Blob, name: string) { const a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 60_000); }
again.addEventListener("click", (e) => { e.preventDefault(); if (lastBlob) saveBlob(lastBlob, lastName); });
share.addEventListener("click", async () => { if (!lastBlob) return; try { await navigator.share({ files: [new File([lastBlob], lastName, { type: lastBlob.type })], title: "Vertical clip" }); } catch {} });

// ---------- paid version: one key, checked by the unlock worker (src/lib/unlock.ts, the same file in all three tools) ----------
const unlock = new Unlock({
  tool: "vertical",
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
  $("keylostline").hidden = s.on; // the paid panel shows the key itself, so this is for whoever is locked out
  // A key that opens more than this tool says so, and the link carries it across in one click.
  const others = unlock.elsewhere;
  $("keyalso").hidden = others.length === 0;
  if (others.length) $("keyalso").innerHTML = `This key also opens ${others.map((o) => `<a href="${o.href}">${o.name}</a>`).join(" and ")}.`;
  trust.textContent = s.on ? "Up to five minutes. Nothing leaves your device." : "Free up to 60 seconds. Nothing leaves your device.";
  // The checkout opens in its own tab, so a clip being worked on stays here (cold user, 2026-09-19). When the key
  // arrives from that tab and a marked copy has already been saved, say so rather than leave a stale file believed good.
  if (s.on && s.became === "another-tab" && state === "exported") { touched(); say("The paid version is on. Save the video again: the new copy has no mark.", "ok"); }
  if (s.on && s.became === "checkout") $("keystatus").scrollIntoView({ block: "center", behavior: "smooth" });
}
// Removing the key wipes the only copy on this screen, so it asks first (cold user, 2026-09-21).
$("removekey").addEventListener("click", (e) => { e.preventDefault(); if (confirm("Remove the key from this device? Copy it first if you have not: you will need it to unlock this device again.")) unlock.forget(); });
$("keycopy").addEventListener("click", async (e) => {
  e.preventDefault();
  try { await navigator.clipboard.writeText(unlock.state.key); $("keycopy").textContent = "Copied"; }
  catch { getSelection()?.selectAllChildren($("paidkey")); $("keycopy").textContent = "Select it and copy"; } // no clipboard permission: hand them the selection instead
  setTimeout(() => ($("keycopy").textContent = "Copy"), 2500);
});
$("keygo").addEventListener("click", async () => { if (await unlock.paste($<HTMLInputElement>("key").value)) $<HTMLInputElement>("key").value = ""; });
$("key").addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") $("keygo").click(); });
const loadLicense = () => unlock.start();
(async () => { try { if (RAIL.product.startsWith("__")) return; const r = await fetch(`${UNLOCK}/count?product=${encodeURIComponent(RAIL.product)}`); const j = r.ok ? await r.json() : null; if (typeof j?.paid !== "number") return; const left = Math.max(0, 100 - j.paid); $("founding").textContent = left >= 100 ? "Founding price for the first 100 buyers, then $29." : left > 0 ? `Founding price for the first 100 buyers, then $29. ${left} left.` : "The founding price has ended: $29 once."; dbg.foundingLeft = left; } catch {} })();

// ---------- for automations and agents ----------
// For rigs that need the paid state without a rail: paints it, exactly as a real key would. It does not store a key,
// so a reload goes back to whatever the device actually holds.
dbg.setLicensed = (on: boolean) => paintLicense({ on, key: on ? "TEST-KEY" : "", tools: on ? ["vertical"] : [], expires: null, text: on ? "Paid version on this device." : "Already paid? Paste your key here.", tone: on ? "ok" : "", became: "" });
dbg.outputBase = outputBase;
dbg.centreAt = (t: number) => centre(t); // where the window is at time t, the same answer the preview and the save use (the gate asks this)
let probeTs = 0;
(window as any).vertical = { two: (on: boolean) => { TWO = on; }, load: (f: File) => load(f), run, export: exportVideo, mode: pickMode, get track() { return track; }, get samples() { return samples; }, get state() { return state; },
  // for tests and diagnostics: where the detector sees faces in a still image (fractions of the image), with the delegate it runs on
  detectOn: async (blob: Blob) => { const d = await loadDetector(); const bmp = await createImageBitmap(blob); probeTs += 1000; const res = d.detectForVideo(bmp, probeTs); const W = bmp.width, H = bmp.height; const out = res.detections.map((x) => ({ x: (x.boundingBox!.originX + x.boundingBox!.width / 2) / W, y: (x.boundingBox!.originY + x.boundingBox!.height / 2) / H, w: x.boundingBox!.width / W, score: x.categories?.[0]?.score })); bmp.close(); return { delegate, w: W, h: H, faces: out }; } };
setState("sample");
