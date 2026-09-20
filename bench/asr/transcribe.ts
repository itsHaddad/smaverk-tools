#!/usr/bin/env bun
// Transcribe one recording, or one slice of one, with a browser-sized speech model.
//
//   bun bench/asr/transcribe.ts --ref <youtube-id> --model tiny --threads 2 --from 0 --to 3600
//
// Published word-error rates come from short read speech. A tool that transcribes an hour-long talk in
// a browser tab needs numbers from hour-long talks, so this measures real-time factor, peak memory and
// the transcript on whatever recording it is pointed at.
//
// Audio is read from disk in windows and never held whole: an hour is 230 MB as float32 and the model
// already holds several hundred more. Windows of ten minutes keep it to 38 MB. Consecutive windows
// overlap and the overlap is dropped from the trailing side, so no word is emitted twice and none
// falls in the seam.

import { pipeline, env } from "@huggingface/transformers";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export const MODELS: Record<string, string> = {
  tiny: "onnx-community/whisper-tiny_timestamped",
  "tiny.en": "onnx-community/whisper-tiny.en_timestamped",
  base: "onnx-community/whisper-base_timestamped",
  small: "onnx-community/whisper-small_timestamped",
  "moonshine-tiny": "onnx-community/moonshine-tiny-ONNX",
  "moonshine-base": "onnx-community/moonshine-base-ONNX",
};

/**
 * Moonshine has no attention decoder for word timing outside English, and segment timing is all the
 * downstream segmentation needs anyway. Asking for word timestamps where they do not exist fails at
 * the end of a long job rather than the start, so it is refused up front.
 */
export const WORD_TIMING = new Set(["tiny", "tiny.en", "base", "small"]);

export const AUDIO_DIR = process.env.BENCH_AUDIO ?? join(process.cwd(), "bench", "audio");
export const OUT_DIR = process.env.BENCH_OUT ?? join(process.cwd(), "bench", "transcripts");

export const SAMPLE_RATE = 16000;

/** A stored transcript, in the shape the rest of the pipeline already reads. */
export type StoredTranscript = {
  ref: string;
  model: string;
  timestamps: string;
  words: { t: number; text: string }[];
  audio_s: number;
  from_s?: number;
  to_s?: number;
  infer_ms: number;
  times_real_time: number;
  peak_rss_mb: number;
};

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1]! : fallback;
};

if (import.meta.main) {
  const ref = arg("ref");
  const modelKey = arg("model", "tiny")!;
  const threads = Number(arg("threads", "1"));
  const windowS = Number(arg("window", "600"));
  const overlapS = Number(arg("overlap", "20"));
  const timestamps = arg("timestamps", "word")! as "word" | "segment";
  if (!ref || !MODELS[modelKey]) {
    console.error(`usage: --ref <youtube-id> --model <${Object.keys(MODELS).join("|")}> [--threads 2] [--timestamps word|segment]`);
    process.exit(2);
  }
  if (timestamps === "word" && !WORD_TIMING.has(modelKey)) {
    console.error(`${modelKey} has no word-level timing; rerun with --timestamps segment`);
    process.exit(2);
  }

  const path = join(AUDIO_DIR, `${ref}.s16`);
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`no audio at ${path} — download it first`);
  const wholeS = file.size / 2 / SAMPLE_RATE;
  // A slice, so a three-hour recording can be split across runners that each have a time limit. The
  // slices are rejoined by `collect.ts`; each carries its own offset so the times stay absolute.
  const fromS = Math.max(0, Number(arg("from", "0")));
  const toS = Math.min(wholeS, Number(arg("to", String(wholeS))));
  if (!(toS > fromS)) throw new Error(`empty slice ${fromS}..${toS} of ${wholeS.toFixed(0)}s`);
  const audioS = toS - fromS;
  const slice = fromS > 0 || toS < wholeS ? `.${Math.round(fromS)}-${Math.round(toS)}` : "";

  env.allowLocalModels = false;
  const asr = await pipeline("automatic-speech-recognition", MODELS[modelKey]!, {
    dtype: "q8",
    session_options: threads ? { intraOpNumThreads: threads, interOpNumThreads: 1 } : {},
  } as any);

  const words: { t: number; text: string }[] = [];
  const stride = windowS - overlapS;
  const t0 = performance.now();
  let peak = 0;
  for (let startS = fromS; startS < toS; startS += stride) {
    const endS = Math.min(toS, startS + windowS);
    const byteStart = Math.floor(startS * SAMPLE_RATE) * 2;
    const byteEnd = Math.floor(endS * SAMPLE_RATE) * 2;
    const raw = new Int16Array(await file.slice(byteStart, byteEnd).arrayBuffer());
    const pcm = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i++) pcm[i] = raw[i]! / 32768;

    const out: any = await asr(pcm, {
      return_timestamps: timestamps === "word" ? "word" : true,
      chunk_length_s: 30,
      stride_length_s: 5,
    } as any);

    // Words are accepted from this window only up to where the next window takes over, so the overlap
    // is transcribed twice and emitted once.
    const isLast = endS >= toS;
    const acceptUntil = isLast ? Infinity : stride;
    for (const c of out.chunks ?? []) {
      const local = c.timestamp?.[0];
      if (typeof local !== "number") continue;
      if (local >= acceptUntil) continue;
      const text = String(c.text).trim();
      if (text) words.push({ t: +(startS + local).toFixed(2), text });
    }
    peak = Math.max(peak, process.memoryUsage().rss / 1048576);
    console.error(`${ref} ${modelKey} ${Math.round(endS)}/${Math.round(toS)}s  ${words.length} words  rss ${Math.round(peak)}MB`);
  }
  const inferMs = performance.now() - t0;

  words.sort((a, b) => a.t - b.t);
  const stored: StoredTranscript = {
    ref,
    model: modelKey,
    timestamps,
    words,
    audio_s: +audioS.toFixed(1),
    from_s: +fromS.toFixed(1),
    to_s: +toS.toFixed(1),
    infer_ms: Math.round(inferMs),
    times_real_time: +(inferMs / 1000 / audioS).toFixed(4),
    peak_rss_mb: Math.round(peak),
  };
  await mkdir(OUT_DIR, { recursive: true });
  await Bun.write(join(OUT_DIR, `${ref}.${modelKey}.${timestamps}${slice}.json`), JSON.stringify(stored));
  console.log(
    JSON.stringify({
      ref,
      model: modelKey,
      timestamps,
      words: words.length,
      wpm: +(words.length / (audioS / 60)).toFixed(1),
      audio_s: stored.audio_s,
      times_real_time: stored.times_real_time,
      peak_rss_mb: stored.peak_rss_mb,
    }),
  );
}
