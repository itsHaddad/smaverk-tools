// worker.ts: the speech engine lives here so the page never freezes while it downloads, compiles or listens.
import { pipeline, env } from "@huggingface/transformers";
import { planWindows, keepWindowWords, earlier } from "./src/lib/windows";
import type { Word } from "./src/lib/lines";
env.allowLocalModels = false;

const MODELS = ["onnx-community/whisper-tiny_timestamped", "onnx-community/whisper-base_timestamped"];
let asr: any = null; let device = "wasm"; let model = "";
const files = new Map<string, { loaded: number; total: number }>();
const progress = (p: any) => {
  if (p.status === "progress" && p.file) { files.set(p.file, { loaded: p.loaded ?? 0, total: p.total ?? 0 }); let l = 0, t = 0; for (const v of files.values()) { l += v.loaded; t += v.total; } if (t) postMessage({ type: "progress", pct: Math.min(99, Math.round((l / t) * 100)), loaded: l, total: t }); }
  else if (p.status === "done" && p.file) { const f = files.get(p.file); if (f) f.loaded = f.total; let l = 0, t = 0; for (const v of files.values()) { l += v.loaded; t += v.total; } if (t && l >= t) postMessage({ type: "phase", phase: "setup" }); } // downloads finished: sessions compile now
};
// WebGPU: fp32 encoder (fp16 has precision problems for Whisper) with a q4 decoder keeps the download near the WASM size.
const opts = (d: string) => ({ device: d, dtype: d === "webgpu" ? { encoder_model: "fp32", decoder_model_merged: "q4" } : "q8", progress_callback: progress });
async function mk(d: string) { let last: any; for (const m of MODELS) { try { const p = await pipeline("automatic-speech-recognition", m, opts(d) as any); model = m; return p; } catch (e) { last = e; } } throw last; }

let loading: Promise<void> | null = null;
async function load(force?: string) {
  if (asr) { postMessage({ type: "ready", device, model, cached: true }); return; }
  if (loading) { await loading; if (asr) postMessage({ type: "ready", device, model, cached: true }); return; } // a warm-up is already running; join it
  loading = loadNow(force); try { await loading; } finally { loading = null; }
}
async function loadNow(force?: string) {
  if (force === "wasm") device = "wasm";
  else try { const ad = await (navigator as any).gpu?.requestAdapter?.(); if (ad) device = "webgpu"; } catch {}
  try { asr = await mk(device); }
  catch (e) { if (device === "webgpu") { device = "wasm"; files.clear(); try { asr = await mk("wasm"); } catch (e2) { postMessage({ type: "error", message: "engine (wasm after webgpu): " + String(e2) }); return; } } else { postMessage({ type: "error", message: "engine: " + String(e) }); return; } }
  let bytes = 0; for (const v of files.values()) bytes += v.total; postMessage({ type: "ready", device, model, cached: false, bytes });
}

// One window (at most 30 s) → words with timestamps relative to the window.
async function transcribe(audio: Float32Array): Promise<Word[]> {
  const out: any = await asr(audio, { return_timestamps: "word" });
  return (out.chunks ?? []).map((c: any) => ({ text: String(c.text).trim(), start: c.timestamp[0] ?? 0, end: c.timestamp[1] ?? (c.timestamp[0] ?? 0) + 0.4 })).filter((w: any) => w.text);
}
// The clip is heard in 30 s windows; each window's words go to the page as soon as they exist (`partial`), so
// captions show on the part already heard while the rest is still being listened to. `result` carries everything.
async function listen(audio: Float32Array) {
  const wins = planWindows(audio.length / 16000); const t0 = performance.now(); let all: Word[] = [];
  for (let i = 0; i < wins.length; i++) {
    const w = wins[i]; const heard = await transcribe(audio.subarray(Math.round(w.start * 16000), Math.round(w.end * 16000)));
    const kept = earlier(keepWindowWords(heard, w)); all = all.concat(kept); // the model marks words late: see LEAD
    if (i < wins.length - 1) postMessage({ type: "partial", words: kept, upTo: w.keepTo, done: i + 1, of: wins.length, ms: performance.now() - t0 });
  }
  postMessage({ type: "result", words: all, ms: performance.now() - t0, windows: wins.length });
}
async function run(audio: Float32Array) {
  if (!asr) { postMessage({ type: "error", message: "engine not loaded" }); return; }
  try { await listen(audio); }
  catch (e) {
    if (device !== "webgpu") { postMessage({ type: "error", message: "listen: " + String(e) }); return; }
    // WebGPU ran but failed at inference: rebuild on WASM once and start over (the page drops any partial words on `restart`).
    try { asr = null; device = "wasm"; files.clear(); asr = await mk("wasm"); postMessage({ type: "ready", device, model, cached: false }); postMessage({ type: "restart" }); await listen(audio); }
    catch (e2) { postMessage({ type: "error", message: "listen (wasm after webgpu): " + String(e2) }); }
  }
}

self.onmessage = (e: MessageEvent) => { const m = e.data; if (m.type === "load") load(m.force); else if (m.type === "run") run(m.audio); };
