// app.ts: everything the person sees and touches. The reading itself happens in worker.ts.
//
// The page has one job and shows it at rest: a real recording, already read, with the moments it found.
// Nothing here uploads anything. The only addresses this file knows are the checkout and the page's own
// files; the key check lives in src/lib/unlock.ts, which every Småverk tool shares.

import { FORMATS, type ExportMedia, type ExportMoment, type Format } from "./src/lib/exports";
import { clock, spoken, displayName, outputName, timelineName } from "./src/lib/naming";
import { Unlock, type UnlockState } from "./src/lib/unlock";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const SANDBOX = new URL(location.href).searchParams.get("rail") === "sandbox";
const RAIL = SANDBOX
  ? { product: "af85b197-a67c-42cf-9f69-daabad01debf", link: "https://sandbox-api.polar.sh/v1/checkout-links/polar_cl_dDfF99RbC2SQYgy850ft0RluXsfNUTSrLrFYx0lpn9e/redirect" }
  : { product: "__PRODUCT__", link: "__LINK__" };

/**
 * The price, in one place.
 *
 * It is the owner's number and nobody else's, so it is a single constant rather than a string scattered
 * through the page: changing it is one edit here, one in `dist/index.html`, and a redeploy, and
 * `tests/site.test.ts` fails if the two ever disagree or if a second number appears anywhere.
 * `$29` is a PLACEHOLDER chosen to sit inside the studio's $19–29 band, not a decision.
 */
export const PRICE = "$29";

/** Free reads half an hour. Paid reads four. One place decides, so the page and the worker cannot disagree. */
const FREE_S = 30 * 60;
const PAID_S = 4 * 3600;
let licensed = false;
const limit = () => (licensed ? PAID_S : FREE_S);

if (!RAIL.link.startsWith("__")) ($("buy") as HTMLAnchorElement).href = RAIL.link;

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
  sets: Record<string, { startS: number; endS: number; why: string[]; opening: string; clipStartS: number; clipEndS: number }[]>;
};

let sample: Sample | null = null;
let state: "sample" | "loading" | "reading" | "found" = "sample";
let targetS = 300;
let moments: Shown[] = [];
let current = -1;
let file: File | null = null;
let media: ExportMedia | null = null;
let mediaUrl = "";
let heardS = 0;
let totalS = 0;

const audio = $<HTMLAudioElement>("audio");
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
  dbg.licensed = licensed;
  dbg.list = moments.map((m) => ({ startS: m.startS, endS: m.endS, why: m.why }));
};

const say = (msg: string, kind: "" | "err" | "ok" = "") => {
  $("status").textContent = msg;
  $("status").className = "status" + (kind ? ` ${kind}` : "");
};

// ---------------------------------------------------------------------------------------------
// The recording, drawn
// ---------------------------------------------------------------------------------------------

const css = (name: string) => getComputedStyle(document.body).getPropertyValue(name).trim();

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
  for (const [i, m] of moments.entries()) {
    const li = document.createElement("li");
    li.className = "moment";
    li.dataset.i = String(i);
    if (i === current) li.setAttribute("aria-current", "true");
    li.innerHTML =
      `<button class="go" type="button" aria-label="Play from ${clock(m.startS)}">${PLAY_ICON}</button>` +
      `<div class="at"><b>${clock(m.startS)}</b><span>${spoken(m.endS - m.startS)}</span></div>` +
      `<p class="says">${escapeHtml(m.opening)}</p>` +
      `<p class="why">${escapeHtml(m.why.join(" · "))}</p>`;
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
  select(i);
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

function play(i: number) {
  const m = moments[i];
  if (!m) return;
  select(i);
  const src = state === "sample" ? sample?.audio : mediaUrl;
  if (!src) return;
  if (!audio.src.endsWith(src) && audio.src !== src) audio.src = src;
  const go = () => {
    audio.currentTime = m.playFromS;
    audio.play().catch(() => say("This browser would not play the sound. Tap the moment again."));
  };
  if (audio.readyState >= 1) go();
  else audio.addEventListener("loadedmetadata", go, { once: true });
}

audio.addEventListener("timeupdate", () => {
  const m = moments[current];
  if (m && audio.currentTime >= m.playToS) audio.pause();
});
for (const ev of ["play", "pause", "ended"]) {
  audio.addEventListener(ev, () => {
    for (const li of list.children) li.removeAttribute("data-playing");
    if (!audio.paused && current >= 0) (list.children[current] as HTMLElement)?.setAttribute("data-playing", "1");
  });
}

// ---------------------------------------------------------------------------------------------
// The sample: a real recording, already read
// ---------------------------------------------------------------------------------------------

function showSample() {
  if (!sample) return;
  const set = sample.sets[String(targetS)] ?? Object.values(sample.sets)[0] ?? [];
  totalS = sample.durationS;
  moments = set.map((m) => ({ startS: m.startS, endS: m.endS, why: m.why, opening: m.opening, playFromS: m.clipStartS, playToS: m.clipEndS }));
  current = -1;
  $("clipname").textContent = `Sample: ${sample.title}`;
  $("clipname").title = `${sample.title} — ${sample.credit}`;
  ($("samplesrc") as HTMLAnchorElement).href = sample.url;
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
    dbg.model = m.model;
    dbg.device = m.device;
    step(1, "done", m.bytes ? `${Math.round(m.bytes / 1048576)} MB` : "ready");
    if (file) step(2, "active", "0%");
  } else if (m.type === "media") {
    totalS = m.durationS || 0;
    if (media) {
      media.durationS = m.durationS || 0;
      media.hasVideo = !!m.hasVideo;
      media.fps = m.fps || 30;
    }
    if (m.limitS && totalS > m.limitS + 1)
      say(licensed ? `That recording is longer than four hours, so this reads the first four.` : `That recording is longer than 30 minutes, so this reads the first 30. The paid version reads four hours.`);
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
    say(m.short ? "A recording needs about four minutes before there is anything to pick out." : "Nothing in this one stayed on a single subject for long enough. Try a shorter clip length.");
  } else {
    step(3, "done", `${moments.length} found`);
    $("s3t").textContent = `${moments.length} moment${moments.length === 1 ? "" : "s"} found`;
    // The truncation notice was shown when the file was opened and then written over by this line, so a
    // free visitor reached the end believing the whole recording had been read.
    const cut = m.truncated ? ` Only the first ${spoken(m.heardS)} of ${spoken(m.durationS)} was read${licensed ? "" : "; the paid version reads four hours"}.` : "";
    say(`Read ${clock(m.heardS)} in ${clock(Math.round(m.ms / 1000))}. Tap one to hear it.${cut}`, "ok");
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
  const picked = (e.target as HTMLInputElement).files?.[0];
  if (!picked) return;
  file = picked;
  if (mediaUrl) URL.revokeObjectURL(mediaUrl);
  mediaUrl = URL.createObjectURL(picked);
  audio.src = mediaUrl;
  media = { name: picked.name, durationS: 0, fps: 30, hasVideo: false, hasAudio: true };
  moments = [];
  current = -1;
  heardS = 0;
  totalS = 0;
  state = "reading";
  $("clipname").textContent = displayName(picked.name);
  $("clipname").title = picked.name;
  $("hint").textContent = "Moments appear while it reads.";
  $("exportbox").hidden = true;
  $("result").classList.remove("on");
  // A way out from the moment the file is picked, not only when it finishes. Reading an hour takes
  // minutes, and someone who picked the wrong file should not have to wait it out or reload the page.
  $("reset").hidden = false;
  render();
  showSteps(true);
  step(1, warmed && !worker ? "" : "active");
  step(2, "");
  step(3, "");
  $("s3t").textContent = "Done";
  say("Nothing is uploaded. This all happens on your device.");
  warm();
  engine().postMessage({ type: "run", file: picked, wantedS: targetS, maxSeconds: limit(), count: 8 });
});

$("reset").addEventListener("click", () => {
  engine().postMessage({ type: "cancel" });
  file = null;
  media = null;
  state = "sample";
  showSteps(false);
  $("exportbox").hidden = true;
  $("hint").textContent = "Tap one to hear it.";
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
    drawChips();
    if (state === "sample") showSample();
    else if (state === "found" && file) {
      // The recording is already read; only the ranking changes, which is the cheap half.
      state = "reading";
      showSteps(true);
      step(1, "done");
      step(2, "active");
      engine().postMessage({ type: "run", file, wantedS: targetS, maxSeconds: limit(), count: 8 });
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

function needsPaying(): boolean {
  if (licensed) return false;
  say(`Saving is the paid half. ${PRICE} once, and every export is open.`, "");
  // The price and the key box are both on the page, never behind a fold-out: a paying customer who is told the
  // price and then has to hunt for where the key goes is the finding that reached a real buyer (cold user, 2026-09-19).
  $("price").scrollIntoView({ block: "center", behavior: "smooth" });
  return true;
}

$("exportbox").addEventListener("click", async (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-save]");
  if (!btn || !media || !moments.length) return;
  if (needsPaying()) return;
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
// The paid version: one key, checked by the unlock worker.
//
// src/lib/unlock.ts is the same file in all three tools, so what a key does here is what it does in
// Captions and Vertical. A key opens whatever it is entitled to: one tool today, several the day a
// bundle is sold, and the page needs no change for that.
// ---------------------------------------------------------------------------------------------

const unlock = new Unlock({
  tool: "clipfinder",
  sandbox: SANDBOX,
  paidLine: "Recordings up to four hours, and every export.",
  render: (s: UnlockState) => paintLicense(s),
});

function paintLicense(s: UnlockState) {
  licensed = s.on;
  dbg.licensed = s.on;
  dbg.unlockTools = s.tools;
  $("keystatus").textContent = s.text;
  $("keystatus").className = "fine" + (s.tone ? " " + s.tone : "");
  $("keyrow").hidden = s.on;
  $("price").hidden = s.on;
  $("tag").hidden = s.on;
  $("pricefine").hidden = s.on;
  $("paidpanel").hidden = !s.on;
  $("trust").textContent = s.on ? "Up to four hours. English. Nothing leaves your device." : "Free up to 30 minutes. English. Nothing leaves your device.";
  // The key in full, so it can be carried to another device. Masking it protected nothing: it is the person's
  // own key and it is in their email, and a masked key cannot be typed into a second device.
  $("paidkey").textContent = s.key;
  $("keylost").setAttribute("href", unlock.portal);
  // A key that opens more than this tool says so, and the link carries it across in one click.
  const others = unlock.elsewhere;
  $("keyalso").hidden = others.length === 0;
  if (others.length) $("keyalso").innerHTML = `This key also opens ${others.map((o) => `<a href="${o.href}">${o.name}</a>`).join(" and ")}.`;
  mark();
  // The checkout opens in its own tab so the recording being read stays here. When the key arrives from that
  // tab, say so: the exports that were refused a moment ago are open now.
  if (s.on && s.became === "another-tab") say("The paid version is on. Every export is open.", "ok");
  if (s.on && s.became === "checkout") $("keystatus").scrollIntoView({ block: "center", behavior: "smooth" });
}

$("removekey").addEventListener("click", (e) => {
  e.preventDefault();
  unlock.forget();
});

$("keycopy").addEventListener("click", async (e) => {
  e.preventDefault();
  try {
    await navigator.clipboard.writeText(unlock.state.key);
    $("keycopy").textContent = "Copied";
  } catch {
    // No clipboard permission in this browser: select it instead, so it can still be copied by hand.
    getSelection()?.selectAllChildren($("paidkey"));
    $("keycopy").textContent = "Select it and copy";
  }
  setTimeout(() => ($("keycopy").textContent = "Copy"), 2500);
});

$("keygo").addEventListener("click", async () => {
  if (await unlock.paste($<HTMLInputElement>("key").value)) $<HTMLInputElement>("key").value = "";
});
$("key").addEventListener("keydown", (e) => {
  if ((e as KeyboardEvent).key === "Enter") $("keygo").click();
});

void unlock.start();
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

(async () => {
  drawChips();
  try {
    const r = await fetch("sample.json");
    if (!r.ok) throw new Error(String(r.status));
    sample = (await r.json()) as Sample;
    showSample();
  } catch {
    // The sample is decoration, not the product. Without it the page still does its one job.
    $("clipname").textContent = "Pick a recording to start";
    $("hint").textContent = "A podcast, a talk or an interview.";
    drawMap();
  }
})();
