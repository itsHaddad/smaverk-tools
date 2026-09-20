#!/usr/bin/env bun
// The sample on the page, made by the tool that is on the page.
//
//   bun tools/sample.ts --mp3 recording.mp3 --title "…" --credit "…" --url "…"
//
// The page shows a real recording with the moments this tool found in it, so a visitor sees the result
// before giving anything. That is only honest if the moments ARE this tool's output, so this runs the
// same three steps the page runs — the same thirty-second windows, the same recogniser, the same
// silences, the same ranking — on the command line, and writes what came out.
//
// It then cuts twelve seconds from the opening of each moment into one small file, because the thing
// worth hearing is whether a moment starts cleanly, and a visitor should be able to hear that without
// downloading an hour of sound.

import { $ } from "bun";
import { pipeline, env } from "@huggingface/transformers";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rank } from "../src/lib/rank";
import { SilenceFinder } from "../src/lib/silence";
import { acceptWindowWords, targetLengthS } from "../src/lib/stream";
import { transcriptOf, type Word } from "../src/lib/words";

const RATE = 16000;
const WINDOW_S = 30;
const OVERLAP_S = 2;
const TARGETS = [60, 180, 300];
const PER_SET = 4;   // four cards is what fits inside the page's 240 words at rest
const EXCERPT_S = 12;

const arg = (name: string, fallback = "") => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1]! : fallback;
};

const source = arg("mp3");
if (!source) {
  console.error('usage: bun tools/sample.ts --mp3 <file> --title "…" --credit "…" --url "…" [--out dist]');
  process.exit(2);
}
const outDir = arg("out", join(import.meta.dir, "..", "dist"));
const work = await mkdtemp(join(tmpdir(), "cf-sample-"));

// Beside the app, not inside dist/: it is a full transcript of somebody else's recording and has no
// business being served. Gitignored.
const readCache = join(import.meta.dir, "..", ".sample-read.json");

try {
  console.error("reading the sound…");
  const pcmPath = join(work, "audio.s16");
  await $`ffmpeg -v error -i ${source} -f s16le -acodec pcm_s16le -ar ${RATE} -ac 1 ${pcmPath}`.quiet();
  const pcm = Bun.file(pcmPath);
  const durationS = pcm.size / 2 / RATE;
  console.error(`${(durationS / 60).toFixed(1)} minutes`);

  // Reading a 65-minute recording costs 36 minutes. Everything after it costs seconds, so the reading is
  // kept on disk and a second run skips it. `--reread` forces it.
  const cached = !process.argv.includes("--reread") && (await Bun.file(readCache).exists())
    ? (JSON.parse(await Bun.file(readCache).text()) as { words: Word[]; silences: { at: number; lengthS: number }[]; readTimesRealTime: number })
    : null;

  const words: Word[] = cached?.words ?? [];
  const finder = new SilenceFinder(RATE);
  if (cached) for (const s of cached.silences) finder.silences.push(s);
  let readMs = (cached?.readTimesRealTime ?? 0) * 1000 * durationS;

  if (!cached) {
  env.allowLocalModels = false;
  const asr = await pipeline("automatic-speech-recognition", "onnx-community/moonshine-base-ONNX", {
    dtype: "q8",
    session_options: { intraOpNumThreads: 1, interOpNumThreads: 1 },
  } as any);

  const stride = WINDOW_S - OVERLAP_S;
  const t0 = performance.now();
  for (let startS = 0, first = true; startS < durationS; startS += stride, first = false) {
    const endS = Math.min(durationS, startS + WINDOW_S);
    const raw = new Int16Array(await pcm.slice(Math.floor(startS * RATE) * 2, Math.floor(endS * RATE) * 2).arrayBuffer());
    const samples = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i++) samples[i] = raw[i]! / 32768;
    const overlapS = first ? 0 : OVERLAP_S;
    finder.feed(samples, startS, startS + overlapS);
    const out: any = await asr(samples, {} as any);
    const tokens = String(out.text ?? "").split(/\s+/).filter(Boolean);
    const chars = tokens.reduce((n, x) => n + x.length + 1, 0);
    let seen = 0;
    const local = tokens.map((tok) => {
      const t = (seen / chars) * (endS - startS);
      seen += tok.length + 1;
      return { t, text: tok };
    });
    words.push(...acceptWindowWords(local, { startS, overlapS }));
    if (Math.round(startS) % 300 < stride) console.error(`  ${Math.round(endS)}/${Math.round(durationS)}s · ${words.length} words · ${finder.silences.length} silences`);
  }
  finder.end(durationS);
  readMs = performance.now() - t0;
  await Bun.write(readCache, JSON.stringify({ words, silences: finder.silences, readTimesRealTime: readMs / 1000 / durationS }));
  }
  console.error(`read in ${(readMs / 1000 / 60).toFixed(1)} min — ${(readMs / 1000 / durationS).toFixed(3)}x real time${cached ? " (from the cached read)" : ""}`);

  const t = transcriptOf(words);
  const sets: Record<string, any[]> = {};
  const excerpts: { startS: number; clipStartS: number; clipEndS: number }[] = [];
  let cursor = 0;
  for (const wanted of TARGETS) {
    const found = rank(t, durationS, { targetS: targetLengthS(durationS, wanted), n: PER_SET, snapToPauseS: 3, silences: finder.silences });
    sets[String(wanted)] = found.map((m) => {
      // One excerpt per distinct opening, so three sets of five do not become fifteen downloads.
      let cut = excerpts.find((e) => Math.abs(e.startS - m.startS) < 2);
      if (!cut) {
        cut = { startS: m.startS, clipStartS: cursor, clipEndS: cursor + EXCERPT_S };
        excerpts.push(cut);
        cursor += EXCERPT_S;
      }
      return { ...m, clipStartS: +cut.clipStartS.toFixed(2), clipEndS: +cut.clipEndS.toFixed(2) };
    });
    console.error(`${wanted}s → ${found.length} moments: ${found.map((m) => Math.round(m.startS)).join(", ")}`);
  }

  console.error(`cutting ${excerpts.length} excerpts…`);
  const parts: string[] = [];
  for (const [i, e] of excerpts.entries()) {
    const p = join(work, `part${i}.m4a`);
    await $`ffmpeg -v error -ss ${e.startS} -t ${EXCERPT_S} -i ${source} -vn -ac 1 -ar 32000 -c:a aac -b:a 48k -af afade=t=in:st=0:d=0.05,afade=t=out:st=${EXCERPT_S - 0.15}:d=0.15 ${p}`.quiet();
    parts.push(p);
  }
  const listFile = join(work, "parts.txt");
  await Bun.write(listFile, parts.map((p) => `file '${p}'`).join("\n"));
  const audioOut = join(outDir, "sample.m4a");
  await $`ffmpeg -v error -y -f concat -safe 0 -i ${listFile} -c copy ${audioOut}`.quiet();

  const sample = {
    title: arg("title", "a recording"),
    credit: arg("credit", ""),
    url: arg("url", ""),
    durationS: +durationS.toFixed(1),
    audio: "sample.m4a",
    readTimesRealTime: +(readMs / 1000 / durationS).toFixed(3),
    words: words.length,
    silences: finder.silences.length,
    sets,
  };
  await Bun.write(join(outDir, "sample.json"), `${JSON.stringify(sample, null, 1)}\n`);
  console.error(`wrote ${join(outDir, "sample.json")} and sample.m4a (${((await Bun.file(audioOut).size) / 1024).toFixed(0)} KB)`);
} finally {
  await rm(work, { recursive: true, force: true });
}
