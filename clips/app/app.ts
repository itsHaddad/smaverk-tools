// app.ts: Clips. A long recording in; clips ready to post out: 9:16, the speaker in frame, captions burned in.
//
// It is the three Småverk tools in a row, each running its own code: the clip finder's worker reads the recording
// and lists the moments (finder.ts), Vertical's scan and save frame each one, and Captions' worker hears it and
// Captions' drawing writes the words (listen.ts, src/make.ts). One moment at a time, so a phone holds one clip's
// work in memory, never the recording's. Nothing is uploaded. The only addresses this file knows are the checkout
// and the page's own files; the key check is src/lib/unlock.ts, the same file in every tool.

import { planMoments, keptCount, trimTo, trimBounds, clipName, mayFreeSave, madeLine, type Kept, type Moment } from "./src/lib/plan";
import { makeClip, saveAvailable, warmFraming, type Made, type Phase } from "./src/make";
import { clock, spoken, displayName } from "../../clipfinder/app/src/lib/naming";
import { tidyStored } from "../../clipfinder/app/src/lib/rank";
import type { Word } from "../../captions/app/src/lib/lines";
import { Unlock, SAMPLE_KEY, type UnlockState } from "./src/lib/unlock";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const SANDBOX = new URL(location.href).searchParams.get("rail") === "sandbox";
// The checkout does not exist yet: clips/LAUNCH.md holds the product to create and where each value goes.
const RAIL = SANDBOX ? { product: "__SANDBOX_PRODUCT__", link: "__SANDBOX_LINK__" } : { product: "__PRODUCT__", link: "__LINK__" };
const ready = (v: string) => !v.startsWith("__");

/** The price, in one place. The owner's number; tests/site.test.ts fails if the page states another. */
export const PRICE = "$49";
/** How much of a recording is read. The reading is the clip finder's, which holds one window of sound at a time. */
const READ_S = 4 * 3600;
/** The clip finder's default clip length: moments of about a minute, which the 90-second cap then bounds. */
const WANTED_S = 60;
const TRUST_FREE = "Free to find and watch. Save one clip with a small mark. English. Your recording stays on your device.";
const TRUST_PAID = "Every clip saved, no mark. English. Your recording stays on your device.";
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isPhone = isIOS || /Android/i.test(navigator.userAgent);
const ASSET_V = (() => { try { return new URL(import.meta.url).search; } catch { return ""; } })();

type State = "sample" | "reading" | "found" | "making" | "made";
type Card = Kept & { made?: Made & { url: string; name: string }; sampleClip?: string; error?: string };
let state: State = "sample";
let cards: Card[] = [];
let file: File | null = null;
let totalS = 0;
let current = -1;
let licensed = false;
let sample: { title: string; credit: string; url: string; durationS: number; poster: string; moments: (Moment & { clip: string; lengthS: number })[] } | null = null;

const reel = $<HTMLVideoElement>("reel");
const list = $<HTMLOListElement>("moments");
const action = $<HTMLButtonElement>("action");

/** What the gates read. Nothing on the page depends on it. */
const dbg: Record<string, any> = { state, moments: 0 };
(window as any).__clips = dbg;
const mark = () => {
  dbg.state = state;
  dbg.moments = cards.length;
  dbg.kept = keptCount(cards);
  dbg.licensed = licensed;
  dbg.totalS = totalS;
  dbg.list = cards.map((c) => ({ startS: c.startS, endS: c.endS, keep: c.keep, capped: c.capped, why: c.why }));
  dbg.made = cards.flatMap((c, i) => (c.made ? [{ i, name: c.made.name, seconds: c.made.seconds, width: c.made.width, height: c.made.height, audio: c.made.audio, words: c.made.words, captionFrames: c.made.captionFrames, frames: c.made.frames, bytes: c.made.blob.size, startS: c.startS, endS: c.made.endS, found: c.made.found, ms: c.made.ms }] : []));
};
const say = (msg: string, kind: "" | "err" | "ok" = "") => { $("status").textContent = msg; $("status").className = "status" + (kind ? ` ${kind}` : ""); };

// ---------------------------------------------------------------------------------------------
// The free save: one per device
// ---------------------------------------------------------------------------------------------

const FREE_KEY = "smaverk.clips.freesaved";
let freeSavedHere = 0; // when storage is blocked the count lives for this visit only
const freeSaved = () => { try { return Number(localStorage.getItem(FREE_KEY) ?? 0) || freeSavedHere; } catch { return freeSavedHere; } };
const countFreeSave = () => { freeSavedHere++; try { localStorage.setItem(FREE_KEY, String(freeSaved() + 1)); } catch { /* blocked: counted for this visit */ } };

// ---------------------------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------------------------

const PLAY_ICON =
  '<svg class="play" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l12-7.5z"/></svg>' +
  '<svg class="pause" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function render() {
  list.textContent = "";
  const own = state !== "sample";
  for (const [i, m] of cards.entries()) {
    const li = document.createElement("li");
    li.className = "moment";
    li.dataset.i = String(i);
    if (i === current) li.setAttribute("aria-current", "true");
    const len = (m.made ? m.made.endS : m.endS) - m.startS;
    li.innerHTML =
      `<button class="go" type="button" aria-label="Play ${m.made || m.sampleClip ? "the clip" : "the moment"} from ${clock(m.startS)}">${PLAY_ICON}</button>` +
      `<div class="at"><b>${clock(m.startS)}</b><span>${spoken(len)}${m.capped && !m.made ? " (cut to 90 s)" : ""}</span></div>` +
      `<p class="says">${esc(m.opening)}</p>` +
      (own ? `<label class="keep"><input type="checkbox"${m.keep ? " checked" : ""}${state === "making" ? " disabled" : ""}> Make this one</label>` : "");
    if (own && state === "found") {
      const b = trimBounds(m, totalS);
      const row = document.createElement("div");
      row.className = "trimrow";
      row.innerHTML =
        `<span class="lab">Start</span><input type="range" class="ts" min="${b.start.min}" max="${b.start.max}" step="1" value="${Math.round(m.startS)}" aria-label="Move the start">` +
        `<span class="lab">End</span><input type="range" class="te" min="${b.end.min}" max="${b.end.max}" step="1" value="${Math.round(m.endS)}" aria-label="Move the end">`;
      li.appendChild(row);
    }
    if (m.made) {
      const row = document.createElement("div");
      row.className = "made";
      row.innerHTML = `<button class="btn quiet small save" type="button">Save clip</button><span class="fine">${esc(madeLine(m.made.endS - m.startS, m.startS, m.capped))}</span>`;
      li.appendChild(row);
    } else if (m.error) {
      const p = document.createElement("p");
      p.className = "fine err made";
      p.textContent = m.error;
      li.appendChild(p);
    }
    list.appendChild(li);
  }
  const n = keptCount(cards);
  if (state === "found") action.textContent = n ? `Make ${n} clip${n === 1 ? "" : "s"}` : "Tick a moment to make";
  action.disabled = state === "reading" || state === "making" || (state === "found" && !n);
  mark();
}

list.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  const li = target.closest<HTMLElement>(".moment");
  if (!li) return;
  const i = Number(li.dataset.i);
  if (target.closest(".save")) return void saveOne(i);
  if (target.closest(".keep") || target.closest(".trimrow")) return;
  if (target.closest(".go") && current === i && !reel.paused) return reel.pause();
  play(i);
});
list.addEventListener("change", (e) => {
  const box = e.target as HTMLInputElement;
  if (!box.closest(".keep")) return;
  const c = cards[Number(box.closest<HTMLElement>(".moment")!.dataset.i)];
  if (c) c.keep = box.checked;
  render();
});
list.addEventListener("input", (e) => {
  const input = e.target as HTMLInputElement;
  const li = input.closest<HTMLElement>(".moment");
  if (!li || !(input.classList.contains("ts") || input.classList.contains("te"))) return;
  const c = cards[Number(li.dataset.i)];
  if (!c) return;
  const t = trimTo(Number(li.querySelector<HTMLInputElement>(".ts")!.value), Number(li.querySelector<HTMLInputElement>(".te")!.value), totalS);
  c.startS = t.startS;
  c.endS = t.endS;
  c.capped = false; // the person chose these edges
  li.querySelector(".at")!.innerHTML = `<b>${clock(c.startS)}</b><span>${spoken(c.endS - c.startS)}</span>`;
  mark();
});

/** Play a finished clip in the picture, or before it is made, the moment itself from the recording. */
function play(i: number) {
  const c = cards[i];
  if (!c) return;
  current = i;
  for (const li of list.children) li.toggleAttribute("aria-current", (li as HTMLElement).dataset.i === String(i));
  const src = c.made?.url ?? (c.sampleClip ? c.sampleClip + ASSET_V : file ? mediaUrl : "");
  if (!src) return;
  const from = c.made || c.sampleClip ? 0 : c.startS;
  stopAt = c.made || c.sampleClip ? Infinity : c.endS;
  if (reel.getAttribute("src") !== src) reel.src = src;
  reel.muted = false;
  const go = () => { reel.currentTime = from; reel.play().catch(() => say("This browser would not play it. Tap it again.")); };
  if (reel.readyState >= 1) go(); else reel.addEventListener("loadedmetadata", go, { once: true });
  $("reelwrap").scrollIntoView({ block: "nearest", behavior: "smooth" });
}
let stopAt = Infinity;
reel.addEventListener("timeupdate", () => { if (reel.currentTime >= stopAt) reel.pause(); });
for (const ev of ["play", "pause", "ended"]) reel.addEventListener(ev, () => {
  for (const li of list.children) li.removeAttribute("data-playing");
  if (!reel.paused && current >= 0) list.children[current]?.setAttribute("data-playing", "1");
});

// ---------------------------------------------------------------------------------------------
// The engines: the clip finder's worker to find, Captions' worker to listen
// ---------------------------------------------------------------------------------------------

function step(n: 1 | 2 | 3, cls: "" | "active" | "done", note = "") { $(`s${n}`).className = "step" + (cls ? ` ${cls}` : ""); $(`s${n}n`).textContent = note; }
const showSteps = (on: boolean) => $("steps").classList.toggle("on", on);

let finder: Worker | null = null;
function finderWorker(): Worker {
  if (finder) return finder;
  finder = new Worker(new URL("./finder.js", location.href), { type: "module" });
  finder.onmessage = (e: MessageEvent) => onFinder(e.data);
  finder.onerror = (e) => say(`The tool could not start: ${e.message}`, "err");
  return finder;
}
function warmFinder() { finderWorker().postMessage({ type: "load" }); }

function onFinder(m: any) {
  if (m.type === "progress") { step(1, "active", `${m.pct}%`); $("s1b").style.width = `${m.pct}%`; }
  else if (m.type === "phase") step(1, "active", "starting");
  else if (m.type === "ready") step(1, "done", "ready");
  else if (m.type === "media") {
    totalS = m.durationS || 0;
    if (!m.hasVideo) { stopFinding(); say("This recording has no picture, so there is nothing to put in a clip. Pick a video.", "err"); return; }
    if (m.limitS && totalS > m.limitS + 1) say("That recording is longer than four hours, so this reads the first four.");
  } else if (m.type === "reading") {
    const pct = Math.min(100, Math.round((m.heardS / Math.max(m.limitS || totalS || 1, 1)) * 100));
    step(2, "active", `${pct}%`);
    $("s2b").style.width = `${pct}%`;
    dbg.heardS = m.heardS;
  } else if (m.type === "done") {
    state = "found";
    cards = planMoments(m.moments as Moment[]);
    step(2, "done", clock(m.heardS));
    dbg.findMs = m.ms;
    if (!cards.length) {
      $("s3t").textContent = m.short ? "That recording is too short to cut up" : "Nothing stood on its own here";
      say(m.short ? "A recording needs about four minutes before there is anything to pick out." : "Nothing here stood on its own. Try a recording with more talk in it.");
    } else {
      $("hint").textContent = "Strongest first. Tick the ones to make.";
      say(`Read ${clock(m.heardS)} in ${clock(Math.round(m.ms / 1000))}. Each clip is up to 90 seconds.`, "ok");
      warmMaking(); // the person is choosing now; the framing and the listening get onto the device meanwhile
    }
    render();
  } else if (m.type === "error") {
    state = "found";
    showSteps(false);
    dbg.error = m.message;
    say(m.message, "err");
    render();
  }
}
function stopFinding() { finder?.terminate(); finder = null; }

let listener: Worker | null = null;
let listenerReady: Promise<void> | null = null;
function listenWorker(): Worker {
  if (listener) return listener;
  listener = new Worker(new URL("./listen.js", location.href), { type: "module" });
  return listener;
}
/** Ask the listening worker something and wait for the answer it ends with. */
function ask<T>(msg: any, transfer: Transferable[], onMsg: (m: any) => T | undefined): Promise<T> {
  return new Promise((res, rej) => {
    const w = listenWorker();
    const on = (e: MessageEvent) => { const m = e.data; if (m.type === "error") { w.removeEventListener("message", on); rej(new Error(m.message)); return; } const r = onMsg(m); if (r !== undefined) { w.removeEventListener("message", on); res(r); } };
    w.addEventListener("message", on);
    w.postMessage(msg, transfer);
  });
}
// iPhone and iPad: the same rule as Captions, which is where it was learned.
const ENGINE_FORCE = isIOS ? "wasm" : undefined;
function loadListener(): Promise<void> {
  listenerReady ??= ask({ type: "load", force: ENGINE_FORCE }, [], (m) => (m.type === "ready" ? true : undefined)).then(() => undefined);
  listenerReady.catch(() => { listenerReady = null; });
  return listenerReady;
}
function warmMaking() { loadListener().catch(() => {}); warmFraming().catch(() => {}); }
async function listen(audio: Float32Array): Promise<Word[]> {
  await loadListener();
  return ask<Word[]>({ type: "run", audio }, [audio.buffer], (m) => (m.type === "result" ? (m.words as Word[]) : undefined));
}

// ---------------------------------------------------------------------------------------------
// Picking, finding, making
// ---------------------------------------------------------------------------------------------

let mediaUrl = "";
const input = $<HTMLInputElement>("file");
action.addEventListener("click", () => {
  if (state === "found") return void makeAll();
  warmFinder();
  input.click();
});
input.addEventListener("change", () => {
  const picked = input.files?.[0];
  input.value = "";
  if (!picked) return;
  for (const c of cards) if (c.made) URL.revokeObjectURL(c.made.url);
  if (mediaUrl) URL.revokeObjectURL(mediaUrl);
  file = picked;
  mediaUrl = URL.createObjectURL(picked);
  reel.pause();
  reel.removeAttribute("src");
  reel.removeAttribute("poster");
  cards = [];
  current = -1;
  state = "reading";
  $("clipname").textContent = displayName(picked.name);
  $("clipname").title = picked.name;
  $("hint").textContent = "The moments come once it has read the whole recording.";
  $("result").classList.remove("on");
  $("reset").hidden = false;
  showSteps(true);
  $("steps").classList.remove("done");
  step(1, "active"); step(2, ""); step(3, "");
  $("s3t").textContent = "Making the clips";
  action.textContent = "Finding the moments…";
  say("Nothing is uploaded. This all happens on your device.");
  render();
  finderWorker().postMessage({ type: "run", file: picked, wantedS: WANTED_S, maxSeconds: READ_S, count: 8 });
});

$("reset").addEventListener("click", () => {
  stopFinding();
  file = null;
  state = "sample";
  showSteps(false);
  $("reset").hidden = true;
  $("result").classList.remove("on");
  say("");
  action.textContent = "Use my own recording";
  showSample();
});

async function makeAll() {
  if (!file) return;
  if (!saveAvailable()) { say("This browser cannot write video on this device. Try a current Chrome, Edge or Safari.", "err"); return; }
  const todo = cards.map((c, i) => [c, i] as const).filter(([c]) => c.keep);
  if (!todo.length) return;
  stopFinding(); // the finder's engine is not needed again for this recording, and its memory is the clips' now
  state = "making";
  action.textContent = "Making the clips…";
  for (const c of cards) { if (c.made) URL.revokeObjectURL(c.made.url); c.made = undefined; c.error = undefined; }
  render();
  showSteps(true);
  step(1, "done", "ready"); step(2, "done");
  const t0 = performance.now();
  for (const [k, [c, i]] of todo.entries()) {
    const label = (p: Phase, d: number, of: number) => {
      const words = { cut: "cutting", frame: "finding the speaker", listen: "writing the captions", save: "saving" }[p];
      step(3, "active", `clip ${k + 1} of ${todo.length}: ${words}${p === "frame" || p === "save" ? ` ${Math.round((d / Math.max(of, 1)) * 100)}%` : ""}`);
      $("s3b").style.width = `${Math.round(((k + (p === "save" ? 0.5 + 0.5 * (d / Math.max(of, 1)) : p === "listen" ? 0.4 : p === "frame" ? 0.1 + 0.3 * (d / Math.max(of, 1)) : 0)) / todo.length) * 100)}%`;
    };
    try {
      const made = await makeClip({ file, startS: c.startS, endS: c.endS, capped: c.capped, mark: !licensed, style: "karaoke", listen, onPhase: label });
      const name = clipName(file.name, i + 1, c.startS);
      c.made = { ...made, url: URL.createObjectURL(made.blob), name };
      render();
      play(i);
      reel.muted = true; // shown as it is made; the sound is one tap away
    } catch (err) {
      const e = err as Error & { phase?: Phase };
      dbg.error = String(e?.message ?? e);
      c.error = `This one could not be made (${String(e?.message ?? e).slice(0, 140)}). The others carry on.`;
      render();
    }
  }
  dbg.makeMs = Math.round(performance.now() - t0);
  state = "made";
  const made = cards.filter((c) => c.made).length;
  step(3, "done", `${made} made`);
  $("s3t").textContent = `${made} clip${made === 1 ? "" : "s"} made`;
  $("steps").classList.add("done");
  action.textContent = "Use another recording";
  showResult();
  render();
  action.disabled = false;
}

// ---------------------------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------------------------

function download(name: string, blob: Blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}
const sharable = (files: File[]) => { try { return isPhone && !!(navigator as any).canShare?.({ files }); } catch { return false; } };

function needsPaying(): boolean {
  if (licensed) return false;
  say(`The free version saves one clip. ${PRICE} once saves every clip, with no mark.`);
  $("price").scrollIntoView({ block: "center", behavior: "smooth" });
  return true;
}

async function saveOne(i: number) {
  const c = cards[i];
  if (!c?.made) return;
  if (!mayFreeSave(licensed, freeSaved())) return void needsPaying();
  const f = new File([c.made.blob], c.made.name, { type: "video/mp4" });
  if (sharable([f])) { try { await navigator.share({ files: [f], title: "Clip" }); } catch { return; } }
  else download(c.made.name, c.made.blob);
  if (!licensed) countFreeSave();
  dbg.saved = [...(dbg.saved ?? []), c.made.name];
  say(licensed ? `Saved ${c.made.name}.` : `Saved ${c.made.name}, with a small smaverk.com mark. That was the free clip.`, "ok");
}

$("saveall").addEventListener("click", async () => {
  if (needsPaying()) return;
  const made = cards.filter((c) => c.made).map((c) => new File([c.made!.blob], c.made!.name, { type: "video/mp4" }));
  if (sharable(made)) { try { await navigator.share({ files: made, title: "Clips" }); } catch { return; } }
  else for (const f of made) { download(f.name, f); await new Promise((r) => setTimeout(r, 400)); } // one at a time: browsers refuse a burst of downloads
  dbg.saved = [...(dbg.saved ?? []), ...made.map((f) => f.name)];
  say(`Saved ${made.length} clips.`, "ok");
});

function showResult() {
  const made = cards.filter((c) => c.made);
  if (!made.length) return;
  $("rtitle").textContent = `${made.length} clip${made.length === 1 ? "" : "s"} ready`;
  $("rline").textContent = licensed ? "Save each one, or all of them at once." : "The free version saves one, with a small smaverk.com mark.";
  $("saveall").hidden = made.length < 2;
  $("result").classList.add("on");
}

// ---------------------------------------------------------------------------------------------
// The sample: the tool's own output for a real recording, made on a runner by tools/sample.mjs
// ---------------------------------------------------------------------------------------------

function showSample() {
  if (!sample) return;
  totalS = sample.durationS;
  cards = sample.moments.map((m) => ({ ...m, opening: tidyStored(m.opening), keep: true, capped: false, foundEndS: m.endS, sampleClip: m.clip }));
  current = 0;
  $("clipname").textContent = `Sample: ${sample.title}`;
  $("clipname").title = `${sample.title} — ${sample.credit}`;
  $("hint").textContent = "Made from it here. Tap one to watch.";
  reel.src = cards[0]!.sampleClip + ASSET_V;
  reel.poster = sample.poster + ASSET_V;
  reel.muted = true;
  reel.play().catch(() => {});
  render();
}

// ---------------------------------------------------------------------------------------------
// The paid version
// ---------------------------------------------------------------------------------------------

if (ready(RAIL.link)) ($("buy") as HTMLAnchorElement).href = RAIL.link;
const unlock = new Unlock({ tool: "clips", sandbox: SANDBOX, paidLine: "Every clip saved, with no mark.", render: (s: UnlockState) => paintLicense(s) });
function paintLicense(s: UnlockState) {
  const was = licensed;
  licensed = s.on;
  $("keystatus").textContent = s.text;
  $("keystatus").className = "fine" + (s.tone ? " " + s.tone : "");
  $("keyrow").hidden = s.on;
  $("price").hidden = s.on;
  $("tag").hidden = s.on;
  $("pricefine").hidden = s.on;
  $("afterpay").hidden = s.on;
  $("paidpanel").hidden = !s.on;
  $("trust").textContent = s.on ? TRUST_PAID : TRUST_FREE;
  $("paidkey").textContent = s.key;
  $("keylost").setAttribute("href", unlock.portal);
  $("keylostline").hidden = s.on;
  const others = unlock.elsewhere;
  $("keyalso").hidden = others.length === 0;
  if (others.length) $("keyalso").innerHTML = `This key also opens ${others.map((o) => `<a href="${o.href}">${o.name}</a>`).join(", ")}.`;
  // Clips made before the key arrived carry the mark. Say so, rather than leave marked files believed clean.
  if (s.on && !was && cards.some((c) => c.made)) { state = "found"; action.textContent = `Make ${keptCount(cards)} clips`; say("The paid version is on. Make the clips again: the new ones have no mark.", "ok"); render(); }
  if (s.on && s.became === "checkout") $("keystatus").scrollIntoView({ block: "center", behavior: "smooth" });
  mark();
}
$("removekey").addEventListener("click", (e) => {
  e.preventDefault();
  if (confirm("Remove the key from this device? Copy it first if you have not: you will need it to unlock this device again.")) unlock.forget();
});
$("keycopy").addEventListener("click", async (e) => {
  e.preventDefault();
  try { await navigator.clipboard.writeText(unlock.state.key); $("keycopy").textContent = "Copied"; }
  catch { getSelection()?.selectAllChildren($("paidkey")); $("keycopy").textContent = "Select it and copy"; }
  setTimeout(() => ($("keycopy").textContent = "Copy"), 2500);
});
$("keygo").addEventListener("click", async () => { if (await unlock.paste($<HTMLInputElement>("key").value)) $<HTMLInputElement>("key").value = ""; });
$("key").addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") $("keygo").click(); });
// Until the checkout exists the buy button says so instead of opening nothing.
$("buy").addEventListener("click", (e) => { if (!ready(RAIL.link)) { e.preventDefault(); say("Buying opens soon. Write to hello@smaverk.com and you will hear first."); } });
// For rigs that need the paid state without a rail: paints it as a real key would, and stores nothing.
dbg.setLicensed = (on: boolean) => paintLicense({ on, key: on ? SAMPLE_KEY.clips : "", tools: on ? ["clips"] : [], expires: null, text: on ? "Paid version on this device." : "Already paid? Paste your key here.", tone: on ? "ok" : "", became: "" });
void unlock.start();

// For automations and agents (llms.txt): tick, make, and read what came out.
(window as any).clips = { keep: (i: number, on: boolean) => { const c = cards[i]; if (c) { c.keep = on; render(); } }, make: makeAll, url: (i: number) => cards[i]?.made?.url ?? "", get state() { return state; } };

(async () => {
  try {
    const r = await fetch("sample.json" + ASSET_V);
    if (!r.ok) throw new Error(String(r.status));
    sample = await r.json();
    showSample();
  } catch {
    // The sample shows the result before anyone gives anything; without it the page still does its one job.
    $("clipname").textContent = "Pick a recording to start";
    render();
  }
})();
say("");
$("trust").textContent = TRUST_FREE;
