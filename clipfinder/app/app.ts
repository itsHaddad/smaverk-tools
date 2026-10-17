// app.ts: everything the person sees and touches. The reading itself happens in worker.ts.
//
// The page has one job and shows it at rest: a real recording, already read, with the moments it found.
// Nothing here uploads anything. The only addresses this file knows are the page's own files.

import { FORMATS, type ExportMedia, type ExportMoment, type Format } from "./src/lib/exports";
import { clock, spoken, displayName, outputName, timelineName } from "./src/lib/naming";
import { tidyStored } from "./src/lib/rank";
import { pickScheme } from "./src/lib/theme";
import { nothingFoundLine } from "./src/lib/advice";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** Every recording is read up to four hours, for everyone (free since 2026-10-17). One place decides, so the page and the worker cannot disagree. */
const LIMIT_S = 4 * 3600;

// ---------------------------------------------------------------------------------------------
// What is on screen
// ---------------------------------------------------------------------------------------------

type Moment = { startS: number; endS: number; why: string[]; opening: string };
type Shown = Moment & { playFromS: number; playToS: number };

type Sample = {
  title: string;
  credit: string;
  url: string;
  durationS: number;
  audio: string;
  /** A video sample carries its picture; a sound-only one (the first sample) does not. */
  video?: boolean;
  poster?: string;
  sets: Record<string, { startS: number; endS: number; why: string[]; opening: string; clipStartS: number; clipEndS: number }[]>;
};

let sample: Sample | null = null;
let state: "sample" | "loading" | "reading" | "found" = "sample";
let targetS = 60;
/** What the buttons asked for, kept apart from what the recording allowed. See the note in finish(). */
let askedS = 60;
/** The lengths the page offers, read off the buttons themselves so a sentence about them cannot drift. */
const CLIP_LENGTHS = [...document.querySelectorAll<HTMLButtonElement>(".chip")].map((c) => Number(c.dataset.target)).filter((n) => n > 0);
let moments: Shown[] = [];
let current = -1;
let file: File | null = null;
let media: ExportMedia | null = null;
let mediaUrl = "";
let heardS = 0;
let totalS = 0;

// One element plays both kinds of recording: a video element plays sound-only files too, and shows the picture
// when there is one. The stage around it is shown only then.
const audio = $<HTMLVideoElement>("audio");
const stage = $("stage");
function showStage(on: boolean, poster = "") {
  stage.hidden = !on;
  if (poster) audio.poster = poster;
  else audio.removeAttribute("poster");
}
const map = $<HTMLCanvasElement>("map");
const list = $<HTMLOListElement>("moments");

/** What the gates read. Nothing on the page depends on it; it exists so a test can see what a person sees. */
const dbg: Record<string, unknown> = { state, moments: 0, ready: false };
(window as any).__cf = dbg;
const mark = () => {
  dbg.state = state;
  dbg.moments = moments.length;
  dbg.targetS = targetS;
  dbg.heardS = heardS;
  dbg.totalS = totalS;
  dbg.current = current;
  dbg.list = moments.map((m) => ({ startS: m.startS, endS: m.endS, why: m.why }));
};

const say = (msg: string, kind: "" | "err" | "ok" = "") => {
  $("status").textContent = msg;
  $("status").className = "status" + (kind ? ` ${kind}` : "");
};

// ---------------------------------------------------------------------------------------------
// The recording, drawn
// ---------------------------------------------------------------------------------------------

// A custom property comes back unresolved, and a canvas drops a colour it cannot parse without a word.
// See src/lib/theme.ts: this one line is why the map used to paint black on black.
// The scheme in force is the visitor's pick from the light/dark button (data-theme on <html>), else the device's.
const isDark = () => { const t = document.documentElement.getAttribute("data-theme"); return t ? t === "dark" : matchMedia("(prefers-color-scheme: dark)").matches; };
const css = (name: string) => pickScheme(getComputedStyle(document.body).getPropertyValue(name), isDark());

/**
 * One band, the whole recording, with the found moments lit inside it. This is the picture of what the
 * tool does: a long thing goes in, a few short things come out of it, and you can see where they sit.
 */
function drawMap() {
  const ratio = Math.min(devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(map.clientWidth * ratio));
  const h = Math.max(1, Math.round(map.clientHeight * ratio));
  if (map.width !== w || map.height !== h) {
    map.width = w;
    map.height = h;
  }
  const g = map.getContext("2d");
  if (!g) return;
  const dur = Math.max(totalS, 1);
  const pad = 18 * ratio;
  const top = 46 * ratio;
  const band = h - top - 34 * ratio;
  g.clearRect(0, 0, w, h);
  g.fillStyle = css("--surface");
  g.fillRect(0, 0, w, h);

  // The recording itself.
  const x0 = pad;
  const x1 = w - pad;
  const at = (s: number) => x0 + ((x1 - x0) * Math.min(Math.max(s, 0), dur)) / dur;
  g.fillStyle = css("--line");
  g.beginPath();
  g.roundRect(x0, top, x1 - x0, band, 8 * ratio);
  g.fill();

  // The part already read, when it is still reading.
  if (state === "reading" && heardS > 0) {
    g.save();
    g.beginPath();
    g.roundRect(x0, top, Math.max(2, at(heardS) - x0), band, 8 * ratio);
    g.clip();
    g.fillStyle = css("--muted");
    g.globalAlpha = 0.35;
    g.fillRect(x0, top, x1 - x0, band);
    g.globalAlpha = 1;
    g.restore();
  }

  // The moments.
  for (const [i, m] of moments.entries()) {
    const a = at(m.startS);
    const b = Math.max(a + 3 * ratio, at(m.endS));
    g.fillStyle = i === current ? css("--hi") : css("--ink");
    g.globalAlpha = i === current ? 1 : 0.75;
    g.beginPath();
    g.roundRect(a, top - 6 * ratio, b - a, band + 12 * ratio, 6 * ratio);
    g.fill();
    g.globalAlpha = 1;
    g.fillStyle = i === current ? css("--hi-ink") : css("--btn-ink");
    g.font = `700 ${13 * ratio}px ${css("--display") || "sans-serif"}`;
    g.textAlign = "center";
    if (b - a > 26 * ratio) g.fillText(String(i + 1), (a + b) / 2, top + band / 2 + 5 * ratio);
  }

  // The clock along the bottom, and what the band is.
  g.fillStyle = css("--muted");
  g.font = `${13 * ratio}px ${css("--body") || "sans-serif"}`;
  g.textAlign = "left";
  g.fillText("0:00", x0, h - 12 * ratio);
  g.textAlign = "right";
  g.fillText(clock(dur), x1, h - 12 * ratio);
  g.textAlign = "left";
  g.fillStyle = css("--ink");
  g.font = `700 ${14 * ratio}px ${css("--display") || "sans-serif"}`;
  const heading =
    state === "reading"
      ? `Read ${clock(heardS)} of ${clock(totalS)} · ${moments.length} moment${moments.length === 1 ? "" : "s"} so far`
      : `${moments.length} moment${moments.length === 1 ? "" : "s"} in ${clock(dur)}`;
  g.fillText(heading, x0, 26 * ratio);
}

/** A chip draws the length it stands for, against the same band, so the choice is seen and not read. */
function drawChips() {
  for (const chip of document.querySelectorAll<HTMLButtonElement>(".chip")) {
    const c = chip.querySelector("canvas")!;
    const ratio = Math.min(devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(c.clientWidth * ratio));
    const h = Math.max(1, Math.round(c.clientHeight * ratio));
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    const g = c.getContext("2d");
    if (!g) continue;
    const on = chip.getAttribute("aria-pressed") === "true";
    const share = Number(chip.dataset.target) / 900; // against a fifteen-minute stretch, so the three differ visibly
    g.clearRect(0, 0, w, h);
    g.fillStyle = css("--line");
    g.beginPath();
    g.roundRect(0, h * 0.3, w, h * 0.4, 3 * ratio);
    g.fill();
    g.fillStyle = on ? css("--hi-ink") : css("--ink");
    g.globalAlpha = on ? 1 : 0.6;
    g.beginPath();
    g.roundRect(w * 0.12, h * 0.18, Math.max(4 * ratio, w * share), h * 0.64, 3 * ratio);
    g.fill();
    g.globalAlpha = 1;
  }
}

// ---------------------------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------------------------

const PLAY_ICON =
  '<svg class="play" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l12-7.5z"/></svg>' +
  '<svg class="pause" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';

function render() {
  list.textContent = "";
  // A sentence printed on every card is not a finding about any of them. The cold user got the same
  // reason five times out of five on her own recordings, and the design reviewer saw it on all four
  // sample cards: "a sentence on every card stops being information and becomes a standing instruction".
  // So when it IS the same for every moment, it is said once above the list, and the cards keep only what
  // tells them apart — which is what makes a per-card line mean something when it does appear.
  const first = moments[0]?.why[0] ?? "";
  const shared = moments.length > 1 && first && moments.every((m) => m.why[0] === first) ? first : "";
  $("allwhy").textContent = shared ? `All of these ${shared.replace(/^(\w+?)s\b/, (_, v: string) => v.toLowerCase())}.` : "";
  $("allwhy").hidden = !shared;
  for (const [i, m] of moments.entries()) {
    const li = document.createElement("li");
    li.className = "moment";
    li.dataset.i = String(i);
    if (i === current) li.setAttribute("aria-current", "true");
    li.innerHTML =
      `<button class="go" type="button" aria-label="Play from ${clock(m.startS)}">${PLAY_ICON}</button>` +
      `<div class="at"><b>${clock(m.startS)}</b><span>${spoken(m.endS - m.startS)}</span></div>` +
      `<p class="says">${escapeHtml(m.opening)}</p>` +
      `<p class="why">${escapeHtml((shared ? m.why.slice(1) : m.why).map((w) => `${w}.`).join(" "))}</p>`;
    if (state === "found" && file) {
      const row = document.createElement("div");
      row.className = "trimrow";
      row.innerHTML =
        `<span class="lab">Start</span><input type="range" class="ts" min="${Math.max(0, Math.round(m.startS) - 120)}" max="${Math.round(m.endS) - 20}" step="1" value="${Math.round(m.startS)}" aria-label="Move the start">` +
        `<span class="lab">End</span><input type="range" class="te" min="${Math.round(m.startS) + 20}" max="${Math.min(Math.round(totalS), Math.round(m.endS) + 120)}" step="1" value="${Math.round(m.endS)}" aria-label="Move the end">`;
      li.appendChild(row);
    }
    list.appendChild(li);
  }
  mark();
  drawMap();
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

list.addEventListener("click", (e) => {
  const li = (e.target as HTMLElement).closest<HTMLElement>(".moment");
  if (!li) return;
  const i = Number(li.dataset.i);
  if ((e.target as HTMLElement).closest(".go")) {
    if (current === i && !audio.paused) {
      audio.pause();
      return;
    }
    play(i);
    return;
  }
  if ((e.target as HTMLElement).closest(".trimrow")) return select(i);
  if (current === i && !audio.paused) return audio.pause();
  play(i);
});

list.addEventListener("input", (e) => {
  const input = e.target as HTMLInputElement;
  const li = input.closest<HTMLElement>(".moment");
  if (!li || !input.classList.contains("ts") && !input.classList.contains("te")) return;
  const i = Number(li.dataset.i);
  const m = moments[i];
  if (!m) return;
  const start = Number(li.querySelector<HTMLInputElement>(".ts")!.value);
  const end = Number(li.querySelector<HTMLInputElement>(".te")!.value);
  m.startS = Math.min(start, end - 20);
  m.endS = Math.max(end, start + 20);
  m.playFromS = m.startS;
  m.playToS = Math.min(m.endS, m.startS + 20);
  li.querySelector(".at")!.innerHTML = `<b>${clock(m.startS)}</b><span>${spoken(m.endS - m.startS)}</span>`;
  mark(); // the whole list is rebuilt for the debug view, which is how a gate sees a trim happen
  drawMap();
});

// The band is a shortcut, not the only way in: everything it does, the list below it also does with a
// real button. Clicking a lit block picks that moment and plays how it opens.
map.addEventListener("click", (e) => {
  if (!moments.length || !totalS) return;
  const r = map.getBoundingClientRect();
  const at = ((e.clientX - r.left) / Math.max(r.width, 1)) * totalS;
  const i = moments.findIndex((m) => at >= m.startS && at <= m.endS);
  if (i < 0) return;
  play(i);
  list.children[i]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
});

function select(i: number) {
  current = i;
  dbg.current = i;
  for (const li of list.children) li.removeAttribute("aria-current");
  list.children[i]?.setAttribute("aria-current", "true");
  drawMap();
}

// At rest the strongest moment of the sample plays muted, in a loop, its first words on the picture; a tap on the picture
// turns the sound on (Clip finder cold user 2, 2026-09-27: the sample stood still behind a play button). Not for anyone who
// asked for less motion, and it stops for good once the person plays something.
let preview = false;
function previewSample() {
  const m = moments[0];
  if (!m || !sample?.video || state !== "sample" || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  preview = true; audio.muted = true; current = 0;
  if (!audio.src.endsWith(sample.audio)) audio.src = sample.audio;
  const go = () => { if (!preview) return; audio.currentTime = m.playFromS; audio.play().catch(() => { preview = false; audio.muted = false; }); };
  if (audio.readyState >= 1) go(); else { audio.addEventListener("loadedmetadata", go, { once: true }); audio.load(); }
}

function play(i: number) {
  const m = moments[i];
  if (!m) return;
  preview = false; audio.muted = false;
  select(i);
  if (!stage.hidden) stage.scrollIntoView({ block: "nearest", behavior: "smooth" });
  const src = state === "sample" ? sample?.audio : mediaUrl;
  if (!src) return;
  if (!audio.src.endsWith(src) && audio.src !== src) audio.src = src;
  const go = () => {
    audio.currentTime = m.playFromS;
    audio.play().catch(() => say("This browser would not play the sound. Tap the moment again."));
  };
  if (audio.readyState >= 1) go();
  else {
    audio.addEventListener("loadedmetadata", go, { once: true });
    audio.load(); // preload="none": without this the metadata event it waits for is one its own inaction prevents
  }
}

// The big button on the picture: the moment already chosen, or the strongest one; again to pause.
$("stageplay").addEventListener("click", () => {
  if (preview) return play(current >= 0 ? current : 0); // the sound on, from the top of the moment
  if (!audio.paused) return audio.pause();
  if (moments.length) play(current >= 0 ? current : 0);
});

audio.addEventListener("timeupdate", () => {
  const m = moments[current];
  if (m && audio.currentTime >= m.playToS) { if (preview) audio.currentTime = m.playFromS; else audio.pause(); }
});
for (const ev of ["play", "pause", "ended", "seeked"]) {
  audio.addEventListener(ev, () => {
    for (const li of list.children) li.removeAttribute("data-playing");
    if (!audio.paused && current >= 0) (list.children[current] as HTMLElement)?.setAttribute("data-playing", "1");
    stage.dataset.playing = audio.paused ? "0" : "1";
    const m = moments[current];
    $("now").textContent = !audio.paused && m ? (preview ? `${clock(m.startS)} · “${m.opening.replace(/…$/, "")}…”` : `${clock(m.startS)} · ${m.why[0] ?? ""}`) : "";
    $("stageplay").setAttribute("aria-label", preview ? "Turn the sound on" : audio.paused ? "Play the moment" : "Pause");
  });
}

// ---------------------------------------------------------------------------------------------
// The sample: a real recording, already read
// ---------------------------------------------------------------------------------------------

function showSample() {
  if (!sample) return;
  const set = sample.sets[String(targetS)] ?? Object.values(sample.sets)[0] ?? [];
  totalS = sample.durationS;
  // The sample was written down by an earlier run, so its quotes go through the same tidy the live ones do.
  moments = set.map((m) => ({ startS: m.startS, endS: m.endS, why: m.why, opening: tidyStored(m.opening), playFromS: m.clipStartS, playToS: m.clipEndS }));
  current = -1;
  $("clipname").textContent = `Sample: ${sample.title}`;
  $("clipname").title = `${sample.title} — ${sample.credit}`;
  ($("samplesrc") as HTMLAnchorElement).href = sample.url;
  showStage(!!sample.video, sample.poster ?? "");
  render();
}

// ---------------------------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------------------------

function step(n: 1 | 2 | 3, cls: "" | "active" | "done", note = "") {
  const el = $(`s${n}`);
  el.className = "step" + (cls ? ` ${cls}` : "");
  $(`s${n}n`).textContent = note;
}
const showSteps = (on: boolean) => $("steps").classList.toggle("on", on);

// ---------------------------------------------------------------------------------------------
// The worker
// ---------------------------------------------------------------------------------------------

let worker: Worker | null = null;
let warmed = false;
/** Whether the tool is on the device. The first step is only "still to do" while that is false. */
let toolReady = false;

function engine(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./worker.js", location.href), { type: "module" });
  worker.onmessage = (e: MessageEvent) => onWorker(e.data);
  worker.onerror = (e) => say(`The tool could not start: ${e.message}`, "err");
  return worker;
}

/** The download starts on the first sign the person means to use it, not when the page opens. */
function warm() {
  if (warmed) return;
  warmed = true;
  engine().postMessage({ type: "load" });
}

function onWorker(m: any) {
  if (m.type === "progress") {
    step(1, "active", `${m.pct}%`);
    $("s1b").style.width = `${m.pct}%`;
  } else if (m.type === "phase" && m.phase === "setup") {
    step(1, "active", "starting");
  } else if (m.type === "ready") {
    dbg.ready = true;
    toolReady = true;
    dbg.model = m.model;
    dbg.device = m.device;
    step(1, "done", m.bytes ? `${Math.round(m.bytes / 1048576)} MB` : "ready");
    if (file) step(2, "active", "0%");
  } else if (m.type === "media") {
    totalS = m.durationS || 0;
    if (media) {
      media.durationS = m.durationS || 0;
      media.hasVideo = !!m.hasVideo;
      showStage(media.hasVideo);
      media.fps = m.fps || 30;
    }
    if (m.limitS && totalS > m.limitS + 1)
      say(`That recording is longer than four hours, so this reads the first four.`);
    drawMap();
  } else if (m.type === "reading") {
    heardS = m.heardS;
    dbg.timesRealTime = m.timesRealTime;
    dbg.words = m.words;
    mark(); // so anything watching can see progress, not just the absence of a result
    const pct = Math.min(100, Math.round((m.heardS / Math.max(m.limitS || totalS || 1, 1)) * 100));
    step(2, "active", `${pct}%`);
    $("s2b").style.width = `${pct}%`;
    drawMap();
  } else if (m.type === "moments") {
    targetS = m.targetS ?? targetS;
    moments = (m.moments as Moment[]).map(asShown);
    if (current >= moments.length) current = -1;
    render();
  } else if (m.type === "done") {
    finish(m);
  } else if (m.type === "error") {
    showSteps(false);
    state = "found";
    dbg.error = m.message;
    mark();
    say(m.message, "err");
  }
}

const asShown = (m: Moment): Shown => ({ ...m, playFromS: m.startS, playToS: Math.min(m.endS, m.startS + 20) });

function finish(m: any) {
  state = "found";
  moments = (m.moments as Moment[]).map(asShown);
  heardS = m.heardS;
  step(2, "done", clock(m.heardS));
  if (!moments.length) {
    step(3, "done", "");
    $("s3t").textContent = m.short ? "That recording is too short to cut up" : "Nothing stood on its own here";
    say(m.short ? "A recording needs about four minutes before there is anything to pick out." : nothingFoundLine(targetS, CLIP_LENGTHS));
    // Nothing was found, so there is nothing to save. The buttons used to stay live under the line
    // "Save the moment you picked", with no moment to pick.
    $("exportbox").hidden = true;
  } else {
    step(3, "done", `${moments.length} found`);
    $("hint").textContent = "Strongest first — pick one to hear it.";
    $("s3t").textContent = `${moments.length} moment${moments.length === 1 ? "" : "s"} found`;
    // The truncation notice was shown when the file was opened and then written over by this line, so a
    // free visitor reached the end believing the whole recording had been read.
    const cut = m.truncated ? ` Only the first ${spoken(m.heardS)} of ${spoken(m.durationS)} was read.` : "";
    // A short recording cannot hold a clip of the length asked for — the reading caps the target at a
    // quarter of the recording — and the line under the buttons says moments come back at that length or
    // longer. So when the recording is what decided, the page says so instead of quietly breaking its own
    // sentence (design review, 2026-09-21: a 5 min chip returning 124 s under exactly that line).
    const shorter = m.targetS && m.targetS < askedS - 1 ? ` This recording is ${spoken(m.durationS ?? totalS)} long, so the moments are about ${spoken(m.targetS)}.` : "";
    say(`Read ${clock(m.heardS)} in ${clock(Math.round(m.ms / 1000))}. Strongest first.${shorter}${cut}`, "ok");
    $("exportbox").hidden = false;
    if (current < 0) select(0);
  }
  dbg.ms = m.ms;
  dbg.words = m.words;
  dbg.silences = m.silences;
  render();
  $("reset").hidden = false;
}

// ---------------------------------------------------------------------------------------------
// Picking a recording
// ---------------------------------------------------------------------------------------------

$("action").addEventListener("click", () => {
  warm();
  $<HTMLInputElement>("file").click();
});
for (const ev of ["pointerdown", "focusin"] as const) map.addEventListener(ev, warm, { once: true });

$("file").addEventListener("change", async (e) => {
  if (preview) { preview = false; audio.pause(); audio.muted = false; } // the person's own recording takes the picture
  const picked = (e.target as HTMLInputElement).files?.[0];
  if (!picked) return;
  file = picked;
  if (mediaUrl) URL.revokeObjectURL(mediaUrl);
  mediaUrl = URL.createObjectURL(picked);
  audio.src = mediaUrl;
  showStage(false);
  $("now").textContent = "";
  media = { name: picked.name, durationS: 0, fps: 30, hasVideo: false, hasAudio: true };
  moments = [];
  current = -1;
  heardS = 0;
  totalS = 0;
  state = "reading";
  $("clipname").textContent = displayName(picked.name);
  $("clipname").title = picked.name;
  // What it says here has to be true while nothing is on screen. The cold user, 2026-09-21: "Moments
  // appear while it reads. They do not" — the column sat empty for two minutes under that sentence.
  // It says when the first one can arrive instead of promising them along the way.
  $("hint").textContent = "The first moments come once it has heard enough to hold one."; // not the chip length: a short recording is read to a shorter target and this line would name the wrong one
  $("exportbox").hidden = true;
  $("result").classList.remove("on");
  // A way out from the moment the file is picked, not only when it finishes. Reading an hour takes
  // minutes, and someone who picked the wrong file should not have to wait it out or reload the page.
  $("reset").hidden = false;
  render();
  showSteps(true);
  // With the tool already on the device the first step is done, not waiting. It used to sit as an empty
  // circle above two ticked steps, which reads as though it had never finished.
  step(1, toolReady ? "done" : "active");
  step(2, "");
  step(3, "");
  $("s3t").textContent = "Done";
  say("Nothing is uploaded. This all happens on your device.");
  warm();
  engine().postMessage({ type: "run", file: picked, wantedS: targetS, maxSeconds: LIMIT_S, count: 8 });
});

$("reset").addEventListener("click", () => {
  engine().postMessage({ type: "cancel" });
  file = null;
  media = null;
  state = "sample";
  showSteps(false);
  $("exportbox").hidden = true;
  $("hint").textContent = "Strongest first — pick one to hear it.";
  say("");
  $("reset").hidden = true;
  audio.pause();
  audio.src = "";
  showSample();
});

for (const chip of document.querySelectorAll<HTMLButtonElement>(".chip")) {
  chip.addEventListener("click", () => {
    for (const other of document.querySelectorAll(".chip")) other.setAttribute("aria-pressed", "false");
    chip.setAttribute("aria-pressed", "true");
    targetS = Number(chip.dataset.target);
    askedS = targetS;
    drawChips();
    if (state === "sample") showSample();
    else if ((state === "found" || state === "reading") && file) {
      // The old answer goes the moment a new length is asked for. The cold user, 2026-09-21, clicked
      // "3 min", saw the previous moment still on screen under a green tick, waited four seconds,
      // believed the button had done nothing — and saved the old answer. It took 130 s for the real one
      // to arrive. A page that is working must look like it is working, and must not let anything be
      // taken away from it in the meantime.
      state = "reading";
      moments = [];
      current = -1;
      audio.pause();
      $("exportbox").hidden = true;
      $("result").classList.remove("on");
      render();
      showSteps(true);
      step(1, toolReady ? "done" : "active");
      step(2, "active", "0%");
      $("s2b").style.width = "0%";
      step(3, "");
      $("s3t").textContent = "Done";
      say(`Reading it again for ${spoken(targetS)} clips. The moments you had are gone until it is done.`);
      engine().postMessage({ type: "run", file, wantedS: targetS, maxSeconds: LIMIT_S, count: 8 });
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Taking it away
// ---------------------------------------------------------------------------------------------

function download(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function showResult(title: string, name: string, line: string) {
  $("rtitle").textContent = title;
  $("rname").textContent = name;
  $("rline").textContent = line;
  $("result").classList.add("on");
}


$("exportbox").addEventListener("click", async (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-save]");
  if (!btn || !media || !moments.length) return;
  const kind = btn.dataset.save!;
  const all: ExportMoment[] = moments.map((m) => ({ startS: m.startS, endS: m.endS, why: m.why, opening: m.opening }));
  if (kind === "clip") {
    const i = current < 0 ? 0 : current;
    await saveClip(i);
    return;
  }
  const format = FORMATS[kind as Format];
  const name = timelineName(media.name, format.ext);
  download(name, new Blob([format.build(media.name.replace(/\.[^.]+$/, ""), media, all)], { type: format.type }));
  dbg.saved = { name, bytes: format.build(media.name.replace(/\.[^.]+$/, ""), media, all).length };
  showResult("Saved", name, format.says(media, moments.length));
});

/** The clip itself, cut out of the file on the device. Nothing is sent anywhere to do it. */
async function saveClip(i: number) {
  const m = moments[i];
  if (!m || !file || !media) return;
  const name = outputName(file.name, i + 1, m.startS, media.hasVideo ? "mp4" : "m4a");
  say(`Cutting ${clock(m.startS)} to ${clock(m.endS)}…`);
  try {
    const mb = await import("mediabunny");
    const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
    const output = new mb.Output({ format: new mb.Mp4OutputFormat(), target: new mb.BufferTarget() });
    const conversion = await mb.Conversion.init({ input, output, trim: { start: m.startS, end: m.endS }, showWarnings: false });
    await conversion.execute();
    const buffer = (output.target as any).buffer as ArrayBuffer | null;
    input.dispose?.();
    if (!buffer) throw new Error("the cut came back empty");
    dbg.savedClip = { name, bytes: buffer.byteLength, startS: m.startS, endS: m.endS };
    download(name, new Blob([buffer], { type: media.hasVideo ? "video/mp4" : "audio/mp4" }));
    showResult("Saved", name, `${spoken(m.endS - m.startS)} from ${clock(m.startS)}.`);
    say("", "ok");
  } catch (err) {
    say(`That clip could not be cut here (${String((err as Error)?.message ?? err)}). The timeline files still work.`, "err");
  }
}

// ---------------------------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------------------------

addEventListener("resize", () => {
  drawMap();
  drawChips();
});
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  drawMap();
  drawChips();
});
addEventListener("themechange", () => {
  drawMap();
  drawChips();
});

(async () => {
  drawChips();
  try {
    const r = await fetch("sample.json");
    if (!r.ok) throw new Error(String(r.status));
    sample = (await r.json()) as Sample;
    showSample();
    previewSample();
  } catch {
    // The sample is decoration, not the product. Without it the page still does its one job.
    $("clipname").textContent = "Pick a recording to start";
    $("hint").textContent = "A podcast, a talk or an interview.";
    drawMap();
  }
})();
