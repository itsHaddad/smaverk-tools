// worker.ts: the reading happens here so the page never freezes while it downloads, compiles or listens.
//
// The loop is: one thirty-second window of sound out of the file, straight into the recogniser, words
// onto the pile, silences onto a much smaller pile, and every three minutes of read sound the whole
// pile is ranked again and the new list is posted. Ranking the lot costs 0.0002 times real time, so
// there is no reason to make anyone wait for the end.
//
// Nothing in here reaches the network after the model is downloaded. The file is never uploaded, never
// copied whole into memory, and never leaves this worker.

import { pipeline, env } from "@huggingface/transformers";
import { open, SAMPLE_RATE } from "./src/lib/decode";
import { rank, type Moment } from "./src/lib/rank";
import { SilenceFinder } from "./src/lib/silence";
import { acceptWindowWords, shouldRerank, targetLengthS, MIN_RANKABLE_S, RERANK_EVERY_S } from "./src/lib/stream";
import { transcriptOf, type Word } from "./src/lib/words";

env.allowLocalModels = false;

/**
 * Moonshine first, Whisper tiny behind it.
 *
 * Measured on ten minutes of a real talk, both fed the same thirty-second windows: Moonshine disagreed
 * with the recording's own caption track on 8.4 per cent of words, Whisper tiny on 35.2 per cent, and
 * the reason is visible in the text — Whisper, given thirty seconds with no context either side, falls
 * into repeating itself and loses whole passages. Moonshine cost 0.40 times real time against 0.48 and
 * 64 MB against 42. The licence on the English models is MIT for both.
 *
 * What Moonshine does not give is word times, so words are placed across their window by length and
 * boundaries are then moved to a silence measured from the sound itself. Drift against the caption
 * track: 0.69 s at the middle, 1.68 s at the ninetieth — a topic boundary is resolved to about seven.
 */
const MODELS = [
  { repo: "onnx-community/moonshine-base-ONNX", timestamps: false },
  { repo: "onnx-community/whisper-tiny_timestamped", timestamps: true },
] as const;

/** The window the recogniser is fed. Whisper's encoder is fixed at thirty seconds; Moonshine matches it. */
const WINDOW_S = 30;
/** Carried into the next window so the recogniser never loses a word on a seam. */
const OVERLAP_S = 2;

let asr: any = null;
let spec: (typeof MODELS)[number] = MODELS[0];
let device = "wasm";

/**
 * Which run is the current one.
 *
 * A single `cancelled` flag was not enough and the bug was real: pressing "choose a different recording"
 * cancels, the old run is sitting inside `await asr(...)`, the new run clears the flag before the old one
 * wakes up, and from then on two runs read two files and post over each other. A run compares its own
 * number instead, so a cancelled run can never be un-cancelled by its replacement.
 */
let generation = 0;

const files = new Map<string, { loaded: number; total: number }>();
const progress = (p: any) => {
  if (p.status === "progress" && p.file) {
    files.set(p.file, { loaded: p.loaded ?? 0, total: p.total ?? 0 });
    let l = 0;
    let t = 0;
    for (const v of files.values()) {
      l += v.loaded;
      t += v.total;
    }
    if (t) postMessage({ type: "progress", pct: Math.min(99, Math.round((l / t) * 100)), loaded: l, total: t });
  } else if (p.status === "done" && p.file) {
    const f = files.get(p.file);
    if (f) f.loaded = f.total;
    let l = 0;
    let t = 0;
    for (const v of files.values()) {
      l += v.loaded;
      t += v.total;
    }
    if (t && l >= t) postMessage({ type: "phase", phase: "setup" }); // downloads finished: sessions compile now
  }
};

async function build(d: string) {
  let last: unknown;
  for (const m of MODELS) {
    try {
      const p = await pipeline("automatic-speech-recognition", m.repo, { device: d, dtype: "q8", progress_callback: progress } as any);
      spec = m;
      return p;
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

let loading: Promise<void> | null = null;
async function load() {
  if (asr) {
    postMessage({ type: "ready", model: spec.repo, device, cached: true });
    return;
  }
  if (loading) {
    await loading;
    if (asr) postMessage({ type: "ready", model: spec.repo, device, cached: true });
    return;
  }
  loading = loadNow();
  try {
    await loading;
  } finally {
    loading = null;
  }
}

async function loadNow() {
  try {
    const adapter = await (navigator as any).gpu?.requestAdapter?.();
    if (adapter) device = "webgpu";
  } catch {
    device = "wasm"; // no WebGPU on this device; the fallback is the path most people take anyway
  }
  try {
    asr = await build(device);
  } catch (e) {
    if (device !== "webgpu") {
      postMessage({ type: "error", message: `The tool could not start: ${String(e)}` });
      return;
    }
    device = "wasm";
    files.clear();
    try {
      asr = await build("wasm");
    } catch (e2) {
      postMessage({ type: "error", message: `The tool could not start: ${String(e2)}` });
      return;
    }
  }
  let bytes = 0;
  for (const v of files.values()) bytes += v.total;
  postMessage({ type: "ready", model: spec.repo, device, cached: false, bytes });
}

/** One window of mono 16 kHz sound to words, with their times on the recording's clock. */
async function hear(samples: Float32Array, startS: number, overlapS: number, spanS: number): Promise<Word[]> {
  // A copy, not a view: the decoder reuses one buffer for every window, and a runtime that reads the
  // whole of a view's underlying buffer would transcribe the same sound over and over. Seen happening.
  const audio = new Float32Array(samples);
  if (spec.timestamps) {
    const out: any = await asr(audio, { return_timestamps: "word" } as any);
    const local = (out.chunks ?? [])
      .filter((c: any) => typeof c.timestamp?.[0] === "number")
      .map((c: any) => ({ t: c.timestamp[0] as number, text: String(c.text ?? "") }));
    return acceptWindowWords(local, { startS, overlapS });
  }
  const out: any = await asr(audio, {} as any);
  // No times come out of this model, so the window's words are spread across the window by their
  // length. The window is thirty seconds, which is the whole resolution of a word's position here.
  const tokens = String(out.text ?? "").split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const chars = tokens.reduce((n, x) => n + x.length + 1, 0);
  const local: { t: number; text: string }[] = [];
  let seen = 0;
  for (const tok of tokens) {
    local.push({ t: (seen / chars) * spanS, text: tok });
    seen += tok.length + 1;
  }
  return acceptWindowWords(local, { startS, overlapS });
}

type RunMessage = { file: Blob; wantedS: number; maxSeconds: number; count: number };

async function run({ file, wantedS, maxSeconds, count }: RunMessage) {
  if (!asr) {
    postMessage({ type: "error", message: "The tool is not ready yet. Give it a moment and try again." });
    return;
  }
  const mine = ++generation;
  const stale = () => mine !== generation;
  let reading: Awaited<ReturnType<typeof open>> | null = null;
  try {
    reading = await open(file);
    if (stale()) return; // opening a two-hour file takes a moment; the person may already have picked another
    const whole = reading.durationS ?? 0;
    const limitS = Math.min(maxSeconds, whole || maxSeconds);
    postMessage({ type: "media", durationS: whole, hasVideo: reading.hasVideo, fps: reading.fps, limitS });

    // Clip length is fixed by the recording's length, once, so every list is about the same thing.
    const targetS = targetLengthS(whole || limitS, wantedS);
    // And nothing is ranked until there is enough read to hold a clip of that length with room around it.
    const minRankableS = Math.max(MIN_RANKABLE_S, targetS * 1.2);

    const words: Word[] = [];
    const finder = new SilenceFinder(SAMPLE_RATE);
    const t0 = performance.now();
    let lastRankedS = 0;
    let heardS = 0;
    let moments: Moment[] = [];

    const rankNow = (upToS: number, final: boolean) => {
      moments = rank(transcriptOf(words), upToS, { targetS, n: count, snapToPauseS: 3, silences: finder.silences });
      lastRankedS = upToS;
      postMessage({ type: "moments", moments, upToS, targetS, final });
    };

    for await (const w of reading.windows(WINDOW_S, OVERLAP_S)) {
      if (stale()) return;
      if (w.startS >= limitS) break;
      finder.feed(w.samples, w.startS, w.startS + w.overlapS);
      words.push(...(await hear(w.samples, w.startS, w.overlapS, w.endS - w.startS)));
      if (stale()) return; // the window took a few seconds; nothing from it belongs on a page that moved on
      heardS = Math.min(w.endS, limitS);
      const elapsed = (performance.now() - t0) / 1000;
      postMessage({ type: "reading", heardS, durationS: whole, limitS, timesRealTime: elapsed / Math.max(heardS, 1), words: words.length });
      if (shouldRerank(heardS, lastRankedS, RERANK_EVERY_S, minRankableS)) rankNow(heardS, false);
    }
    if (stale()) return;
    finder.end(heardS);
    // The last ranking always runs, even when the one before it was a moment ago: the final list is the
    // one the person keeps, and it is the only one that sees the whole recording.
    if (heardS >= minRankableS) rankNow(heardS, true);
    postMessage({
      type: "done",
      moments,
      heardS,
      durationS: whole,
      truncated: !!whole && limitS < whole - 1,
      words: words.length,
      ms: Math.round(performance.now() - t0),
      silences: finder.silences.length,
      short: heardS < minRankableS,
    });
  } catch (e) {
    // A run that has been replaced fails loudly into nothing: its errors are about a file nobody is
    // looking at any more, and showing them would overwrite the new run's own progress.
    if (!stale()) postMessage({ type: "error", message: String((e as Error)?.message ?? e) });
  } finally {
    reading?.dispose();
  }
}

self.onmessage = (e: MessageEvent) => {
  const m = e.data;
  if (m.type === "load") load();
  else if (m.type === "run") run(m as RunMessage);
  else if (m.type === "cancel") generation++;
};
